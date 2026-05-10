import axios, { AxiosInstance, AxiosError } from 'axios';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { Logger } from 'homebridge';
import {
  AuthTokens,
  KeycloakTokenResponse,
  HubspaceDevice,
  HubspaceMetadeviceRaw,
  DeviceStateValue,
} from './types';

// ─── Constants ─────────────────────────────────────────────────────────────────
const AUTH_URL =
  'https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token';
const USERS_ME_URL = 'https://api2.afero.net/v1/users/me';
const SEMANTICS_BASE = 'https://semantics2.afero.net/v1';
const CLIENT_ID = 'hubspace_android';
const CONCLAVE_HOST = 'conclave-stream.afero.io';
const CONCLAVE_PORT = 443;
const CONCLAVE_LOGIN_VERSION = '1.3.0';
const CONCLAVE_PROTOCOL = 2;
const BACKOFF_MAX_MS = 20_000;

/** Proactively refresh the access token this many ms before it expires. */
const EXPIRY_BUFFER_MS = 30_000;

// ─── HubspaceClient ─────────────────────────────────────────────────────────
export class HubspaceClient {
  private readonly http: AxiosInstance;
  private tokens: AuthTokens | null = null;
  private accountId: string | null = null;
  private readonly tokenCachePath: string;
  /** Prevents concurrent token refreshes. */
  private refreshInFlight: Promise<void> | null = null;
  /** Prevents concurrent password logins. */
  private authInFlight: Promise<void> | null = null;
  private readonly debug: boolean;

  constructor(
    private readonly username: string,
    private readonly password: string,
    storagePath: string,
    private readonly log: Logger,
    options: { tokenCachePath?: string; debug?: boolean } = {},
  ) {
    this.debug = options.debug ?? false;
    this.tokenCachePath =
      options.tokenCachePath ?? path.join(storagePath, 'hubspace-tokens.json');

    this.http = axios.create({
      baseURL: SEMANTICS_BASE,
      timeout: 30_000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Dart/2.18 (dart:io)',
        'host': 'semantics2.afero.net',
        'accept-encoding': 'gzip',
      },
    });

    // Attach Bearer token to every request.
    this.http.interceptors.request.use(async (config) => {
      const token = await this.getValidAccessToken();
      config.headers = config.headers ?? {};
      config.headers['Authorization'] = `Bearer ${token}`;
      return config;
    });

    // On 401, refresh the token once and retry. Never call authenticate() here —
    // password logins trigger Hubspace emails and push notifications.
    this.http.interceptors.response.use(
      (res) => res,
      async (err: AxiosError) => {
        const cfg = err.config as typeof err.config & { _retried?: boolean };
        if (err.response?.status === 401 && cfg && !cfg._retried) {
          cfg._retried = true;
          await this.doRefresh();
          cfg.headers!['Authorization'] = `Bearer ${this.tokens!.accessToken}`;
          return this.http(cfg);
        }
        return Promise.reject(err);
      },
    );
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Connect to the Conclave push stream. Calls onDeviceChange(deviceId) whenever
   * Conclave reports an attr_change or status_change. The connection is maintained
   * internally with exponential-backoff reconnects.
   */
  startConclave(onDeviceChange: (deviceId: string) => void): void {
    const accountId = this.accountId;
    if (!accountId) {
      this.log.warn('[Conclave] accountId not yet resolved — Conclave will not start.');
      return;
    }
    const mobileDeviceId = this.getOrCreateMobileDeviceId();
    const client = new ConclaveClient(
      accountId,
      mobileDeviceId,
      () => this.fetchConclaveToken(),
      onDeviceChange,
      this.log,
      this.debug,
    );
    client.connect();
  }

  async fetchConclaveToken(): Promise<{ token: string; expiresIn: number }> {
    const accountId = await this.resolveAccountId();
    const accessToken = await this.getValidAccessToken();
    const res = await axios.post<{ token: string; expiresIn?: number; expires_in?: number }>(
      `https://api2.afero.net/v1/accounts/${accountId}/conclaveAccess`,
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Dart/2.18 (dart:io)',
          'host': 'api2.afero.net',
          'accept-encoding': 'gzip',
        },
        timeout: 15_000,
      },
    );
    const expiresIn = res.data.expiresIn ?? res.data.expires_in ?? 3600;
    return { token: res.data.token, expiresIn };
  }

  private getOrCreateMobileDeviceId(): string {
    if (this.tokens?.mobileDeviceId) return this.tokens.mobileDeviceId;
    const id = crypto.randomUUID();
    if (this.tokens) {
      this.tokens.mobileDeviceId = id;
      this.saveCachedTokens().catch(() => {});
    }
    return id;
  }

  async initialize(): Promise<void> {
    await this.loadCachedTokens();

    if (this.tokens && this.isRefreshTokenValid()) {
      this.log.info('[Hubspace] Loaded cached tokens — skipping login.');
      if (this.isAccessTokenExpired()) {
        this.log.debug('[Hubspace] Access token near expiry; refreshing…');
        await this.doRefresh();
      }
    } else {
      this.log.info('[Hubspace] No valid cached tokens — authenticating…');
      await this.authenticate();
    }

    // Eagerly resolve account ID so errors surface at startup.
    await this.resolveAccountId();
  }

  /** Fetches all metadevices (with expanded state) for the account. */
  async getDevices(): Promise<HubspaceDevice[]> {
    const accountId = await this.resolveAccountId();
    const res = await this.http.get<HubspaceMetadeviceRaw[]>(
      `/accounts/${accountId}/metadevices?expansions=state`,
    );
    this.log.debug(`[Hubspace] API returned ${res.data.length} metadevice(s).`);

    const devices: HubspaceDevice[] = [];
    for (const raw of res.data) {
      // Skip containers — rooms and homes have no deviceClass.
      if (raw.typeId !== 'metadevice.device') continue;
      const deviceClass = raw.description?.device?.deviceClass;
      if (!deviceClass) continue;

      devices.push({
        id: raw.id,
        allIds: [raw.id],
        typeId: raw.typeId,
        friendlyName: raw.friendlyName || raw.description?.device?.defaultName || raw.id,
        deviceClass,
        manufacturerName: raw.description?.device?.manufacturerName,
        model: raw.description?.device?.model,
        values: raw.state?.values ?? [],
      });
    }

    // Deduplicate: when the API returns both a "fan" and a "ceiling-fan" for
    // the same physical device, merge their state values so we get all
    // capabilities (power, fan-speed, fan-reverse, light-power, etc.).
    const deduped = new Map<string, HubspaceDevice>();
    for (const d of devices) {
      const key = d.friendlyName.toLowerCase();
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, d);
      } else {
        // Merge: prefer ceiling-fan deviceClass, combine all state values and IDs.
        const primary = d.deviceClass.toLowerCase() === 'ceiling-fan' ? d : existing;
        const secondary = d.deviceClass.toLowerCase() === 'ceiling-fan' ? existing : d;
        const merged: HubspaceDevice = {
          ...primary,
          allIds: [...new Set([...existing.allIds, ...d.allIds])],
          values: [
            ...primary.values,
            ...secondary.values.filter(
              (v) => !primary.values.some(
                (e) => e.functionClass === v.functionClass &&
                       e.functionInstance === v.functionInstance,
              ),
            ),
          ],
        };
        deduped.set(key, merged);
      }
    }
    const result = [...deduped.values()];

    this.log.info(`[Hubspace] ${result.length} controllable device(s) after filtering.`);
    return result;
  }

  /** Fetches and merges state for one or more device IDs. */
  async getDeviceState(deviceIds: string[]): Promise<DeviceStateValue[]> {
    const accountId = await this.resolveAccountId();
    const merged: DeviceStateValue[] = [];

    for (const deviceId of deviceIds) {
      this.dbg('GET STATE', deviceId);
      const res = await this.http.get<HubspaceMetadeviceRaw>(
        `/accounts/${accountId}/metadevices/${deviceId}?expansions=state`,
      );
      const values = res.data.state?.values ?? [];
      for (const v of values) {
        if (!merged.some(
          (e) => e.functionClass === v.functionClass &&
                 e.functionInstance === v.functionInstance,
        )) {
          merged.push(v);
        }
      }
    }

    return merged;
  }

  async setDeviceState(
    deviceId: string,
    values: Partial<DeviceStateValue>[],
  ): Promise<void> {
    const accountId = await this.resolveAccountId();
    const payload = {
      metadeviceId: deviceId,
      values: values.map((v) => ({ ...v, lastUpdateTime: 0 })),
    };
    this.dbg('PUT STATE', deviceId, JSON.stringify(values));
    await this.http.put(
      `/accounts/${accountId}/metadevices/${deviceId}/state`,
      payload,
    );
  }

  // ─── Account resolution ──────────────────────────────────────────────────────

  private async resolveAccountId(): Promise<string> {
    if (this.accountId) return this.accountId;

    const token = await this.getValidAccessToken();
    let data: Record<string, unknown>;
    try {
      const res = await axios.get<Record<string, unknown>>(USERS_ME_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Dart/2.18 (dart:io)',
          'host': 'api2.afero.net',
          'accept-encoding': 'gzip',
        },
        timeout: 15_000,
      });
      data = res.data;
    } catch (err) {
      throw new Error(
        `[Hubspace] /v1/users/me failed: ${this.extractErrorMessage(err)}`,
      );
    }

    const access = data['accountAccess'] as Array<{
      account: { accountId: string };
    }> | undefined;
    const accountId = access?.[0]?.account?.accountId;
    if (!accountId) {
      throw new Error(
        `[Hubspace] accountId missing from /v1/users/me — response: ${JSON.stringify(data).slice(0, 300)}`,
      );
    }

    this.log.info(`[Hubspace] Account ID resolved: ${accountId}`);
    this.accountId = accountId;
    return accountId;
  }

  // ─── Authentication ──────────────────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    if (this.authInFlight) return this.authInFlight;
    this.authInFlight = this._doAuthenticate().finally(() => { this.authInFlight = null; });
    return this.authInFlight;
  }

  private async _doAuthenticate(): Promise<void> {
    this.log.info('[Hubspace] Authenticating with username/password…');
    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: CLIENT_ID,
      username: this.username,
      password: this.password,
      scope: 'openid offline_access',
    });

    let data: KeycloakTokenResponse;
    try {
      const res = await axios.post<KeycloakTokenResponse>(
        AUTH_URL,
        params.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Dart/2.18 (dart:io)',
          },
          timeout: 20_000,
        },
      );
      data = res.data;
    } catch (err) {
      throw new Error(
        `[Hubspace] Authentication failed: ${this.extractErrorMessage(err)}`,
      );
    }

    if (data.error) {
      throw new Error(
        `[Hubspace] Auth error: ${data.error} — ${data.error_description ?? ''}`,
      );
    }

    this.storeTokens(data);
    await this.saveCachedTokens();
    this.log.info(
      `[Hubspace] Authentication successful — access token expires in ${data.expires_in}s, ` +
      `refresh token expires in ${Math.round(data.refresh_expires_in / 60)}m.`,
    );
  }

  private async doRefresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      if (!this.tokens?.refreshToken) throw new Error('No refresh token available');
      this.log.debug('[Hubspace] Refreshing access token…');
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: this.tokens.refreshToken,
      });
      try {
        const res = await axios.post<KeycloakTokenResponse>(
          AUTH_URL,
          params.toString(),
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 20_000,
          },
        );
        this.storeTokens(res.data);
        await this.saveCachedTokens();
        this.log.debug('[Hubspace] Token refresh successful.');
      } catch (err) {
        this.log.warn(
          `[Hubspace] Token refresh failed: ${this.extractErrorMessage(err)} — will re-authenticate.`,
        );
        throw err;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  private async getValidAccessToken(): Promise<string> {
    if (!this.tokens) {
      await this.authenticate();
    } else if (this.isAccessTokenExpired()) {
      // Always try refresh first; only fall back to password login if no refresh token exists.
      if (this.tokens.refreshToken) {
        try {
          await this.doRefresh();
        } catch {
          // Refresh failed — only authenticate if the refresh token is also expired.
          if (!this.isRefreshTokenValid()) {
            await this.authenticate();
          }
        }
      } else {
        await this.authenticate();
      }
    }
    return this.tokens!.accessToken;
  }

  // ─── Token persistence ───────────────────────────────────────────────────────

  private storeTokens(data: KeycloakTokenResponse): void {
    const now = Date.now();
    // refresh_expires_in === 0 means the refresh token never expires (Keycloak offline sessions).
    const refreshExpiresAt = data.refresh_expires_in === 0
      ? Number.MAX_SAFE_INTEGER
      : now + data.refresh_expires_in * 1000;
    this.tokens = {
      username: this.username,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now + data.expires_in * 1000,
      refreshExpiresAt,
    };
  }

  private async loadCachedTokens(): Promise<void> {
    try {
      const raw = await fs.readFile(this.tokenCachePath, 'utf-8');
      const cached = JSON.parse(raw) as AuthTokens;
      if (cached.username && cached.username !== this.username) {
        this.log.info('[Hubspace] Cached tokens belong to a different account — discarding.');
        await fs.unlink(this.tokenCachePath);
        return;
      }
      this.tokens = cached;
      this.log.debug('[Hubspace] Loaded token cache from disk.');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.debug('[Hubspace] Could not read token cache — ignoring.');
      }
      this.tokens = null;
    }
  }

  private async saveCachedTokens(): Promise<void> {
    try {
      const dir = path.dirname(this.tokenCachePath);
      await fs.mkdir(dir, { recursive: true });
      const tmp = this.tokenCachePath + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(this.tokens, null, 2), 'utf-8');
      await fs.rename(tmp, this.tokenCachePath);
    } catch (err) {
      this.log.warn(`[Hubspace] Could not save token cache: ${err}`);
    }
  }

  private isAccessTokenExpired(): boolean {
    if (!this.tokens) return true;
    return Date.now() >= this.tokens.expiresAt - EXPIRY_BUFFER_MS;
  }

  private isRefreshTokenValid(): boolean {
    if (!this.tokens) return false;
    return Date.now() < this.tokens.refreshExpiresAt - EXPIRY_BUFFER_MS;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private dbg(...args: unknown[]): void {
    if (this.debug) this.log.debug('[Hubspace]', ...args.map(String));
  }

  private extractErrorMessage(err: unknown): string {
    if (axios.isAxiosError(err)) {
      const data = err.response?.data as Record<string, string> | undefined;
      return data?.error_description ?? data?.error ?? err.message;
    }
    return String(err);
  }
}

// ─── Conclave push client ────────────────────────────────────────────────────

interface ConclaveHelloMessage {
  hello: { heartbeat: number; [key: string]: unknown };
}

interface ConclavePublicMessage {
  public: {
    event: string;
    data: {
      id?: string;
      attribute?: unknown;
      status?: unknown;
      [key: string]: unknown;
    };
  };
}

type ConclaveEnvelope =
  | ConclaveHelloMessage
  | { welcome: unknown }
  | ConclavePublicMessage
  | { error: unknown };

function isHello(e: ConclaveEnvelope): e is ConclaveHelloMessage {
  return 'hello' in e;
}

function isPublic(e: ConclaveEnvelope): e is ConclavePublicMessage {
  return 'public' in e;
}

class ConclaveClient extends EventEmitter {
  private socket: tls.TLSSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private destroyed = false;
  private lineBuffer = '';

  constructor(
    private readonly accountId: string,
    private readonly mobileDeviceId: string,
    private readonly fetchConclaveToken: () => Promise<{ token: string; expiresIn: number }>,
    private readonly onDeviceChange: (deviceId: string) => void,
    private readonly log: Logger,
    private readonly debug: boolean,
  ) {
    super();
  }

  connect(): void {
    if (this.destroyed) return;
    this.dbg('Connecting to Conclave…');
    this.fetchConclaveToken()
      .then(({ token }) => this.openSocket(token))
      .catch((err) => {
        this.log.warn(`[Conclave] Token fetch failed: ${err} — will retry.`);
        this.scheduleReconnect();
      });
  }

  private openSocket(conclaveToken: string): void {
    if (this.destroyed) return;

    const socket = tls.connect({
      host: CONCLAVE_HOST,
      port: CONCLAVE_PORT,
      servername: CONCLAVE_HOST,
    });

    this.socket = socket;
    this.lineBuffer = '';

    socket.once('secureConnect', () => {
      this.dbg('TLS connected — waiting for hello.');
    });

    socket.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString('utf-8');
      const lines = this.lineBuffer.split('\n');
      this.lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        this.handleLine(trimmed, conclaveToken);
      }
    });

    socket.once('error', (err) => {
      this.log.warn(`[Conclave] Socket error: ${err.message}`);
      this.teardown();
      this.scheduleReconnect();
    });

    socket.once('close', () => {
      if (!this.destroyed) {
        this.log.warn('[Conclave] Connection closed — reconnecting.');
        this.teardown();
        this.scheduleReconnect();
      }
    });
  }

  private handleLine(line: string, conclaveToken: string): void {
    let envelope: ConclaveEnvelope;
    try {
      envelope = JSON.parse(line) as ConclaveEnvelope;
    } catch {
      this.dbg('Non-JSON line from Conclave:', line.slice(0, 120));
      return;
    }

    if (isHello(envelope)) {
      const heartbeatSecs = envelope.hello.heartbeat ?? 270;
      this.dbg(`Received hello — heartbeat every ${heartbeatSecs}s.`);
      this.startHeartbeat(heartbeatSecs * 1000);
      this.sendLogin(conclaveToken);
      return;
    }

    if ('welcome' in envelope) {
      this.dbg('Received welcome — Conclave session active.');
      this.backoffMs = 1_000;
      return;
    }

    if (isPublic(envelope)) {
      const { event, data } = envelope.public;
      if (event === 'attr_change' || event === 'status_change') {
        const deviceId = data?.id;
        if (typeof deviceId === 'string' && deviceId.length > 0) {
          this.dbg(`${event} for device ${deviceId}`);
          this.onDeviceChange(deviceId);
        }
      }
    }
  }

  private sendLogin(conclaveToken: string): void {
    const msg = JSON.stringify({
      login: {
        channelId: this.accountId,
        accessToken: conclaveToken,
        type: 'socket',
        mobileDeviceId: this.mobileDeviceId,
        version: CONCLAVE_LOGIN_VERSION,
        protocol: CONCLAVE_PROTOCOL,
      },
    });
    this.write(msg + '\n');
    this.dbg('Login sent.');
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.write('\n');
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private write(data: string): void {
    try {
      this.socket?.write(data, 'utf-8');
    } catch {
      // Socket may have closed between the check and the write; reconnect will handle it.
    }
  }

  private teardown(): void {
    this.stopHeartbeat();
    try { this.socket?.destroy(); } catch { /* ignore */ }
    this.socket = null;
    this.lineBuffer = '';
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.dbg(`Reconnecting in ${delay}ms.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardown();
  }

  private dbg(...args: unknown[]): void {
    if (this.debug) this.log.debug('[Conclave]', ...args.map(String));
  }
}
