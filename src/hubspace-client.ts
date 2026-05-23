import axios, { AxiosInstance, AxiosError } from 'axios';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import * as zlib from 'zlib';
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
   * Connect to the Conclave push stream.  Calls onDeviceChange(deviceId) whenever
   * Conclave reports an attr_change or status_change, and onClientJoin() whenever
   * another Hubspace client (e.g. the mobile app) connects to the channel. The
   * connection is maintained internally with exponential-backoff reconnects.
   */
  startConclave(onDeviceChange: (deviceId: string) => void, onClientJoin?: () => void): void {
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
      onClientJoin,
    );
    client.connect();
  }

  async fetchConclaveToken(): Promise<{ token: string; channelId: string | undefined; expiresIn: number; host: string; compression: boolean }> {
    const accountId = await this.resolveAccountId();
    const accessToken = await this.getValidAccessToken();
    const res = await axios.post<Record<string, unknown>>(
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
    const raw = res.data;

    // Response shape: { tokens: [{token, expiresTimestamp, createdTimestamp, ...}], conclave: {host, port, ssl, compression}, ... }
    type TokenEntry = { token: string; expiresTimestamp?: number; channelId?: string };
    const tokensArr = raw['tokens'] as TokenEntry[] | undefined;
    const tokenEntry = tokensArr?.[0];
    const token = tokenEntry?.token ?? (raw['token'] as string | undefined);
    if (!token) throw new Error('No token in Conclave access response');
    const channelId = tokenEntry?.channelId;

    // Expiry from timestamp (ms epoch) or fall back to scalar fields
    let expiresIn = 90;
    if (tokenEntry?.expiresTimestamp) {
      expiresIn = Math.max(60, Math.floor((tokenEntry.expiresTimestamp - Date.now()) / 1000));
    }

    // Dynamic host and compression flag from response
    type ConclaveInfo = { host?: string; compression?: boolean };
    const conclaveInfo = raw['conclave'] as ConclaveInfo | undefined;
    const host = conclaveInfo?.host ?? CONCLAVE_HOST;
    const compression = conclaveInfo?.compression ?? false;

    this.log.info(`[Conclave] Server: ${host}, compression: ${compression}, channelId: ${channelId ?? '(none — using accountId)'}, token expires in ${expiresIn}s`);

    return { token, channelId, expiresIn, host, compression };
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
      this.log.info('Loaded cached tokens — skipping login.');
      if (this.isAccessTokenExpired()) {
        this.log.debug('Access token near expiry; refreshing…');
        await this.doRefresh();
      }
    } else {
      this.log.info('No valid cached tokens — authenticating…');
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
    this.log.debug(`API returned ${res.data.length} metadevice(s).`);

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

    this.log.info(`${result.length} controllable device(s) after filtering.`);
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
        `/v1/users/me failed: ${this.extractErrorMessage(err)}`,
      );
    }

    const access = data['accountAccess'] as Array<{
      account: { accountId: string };
    }> | undefined;
    const accountId = access?.[0]?.account?.accountId;
    if (!accountId) {
      throw new Error(
        `accountId missing from /v1/users/me — response: ${JSON.stringify(data).slice(0, 300)}`,
      );
    }

    this.log.info(`Account ID resolved: ${accountId}`);
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
    this.log.info('Authenticating with username/password…');
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
      const msg = this.extractErrorMessage(err);
      if (/mfa|otp|two.factor|multi.factor|email.*code|authenticat/i.test(msg)) {
        this.log.warn(
          `Authentication failed: ${msg}\n` +
          'Your account has 2FA enabled. Open the plugin settings in the Homebridge UI to complete the login flow.',
        );
      } else {
        this.log.warn(`Authentication failed: ${msg}`);
      }
      throw new Error(`Authentication failed: ${msg}`);
    }

    if (data.error) {
      const msg = `${data.error} — ${data.error_description ?? ''}`;
      if (/mfa|otp|two.factor|multi.factor|email.*code|authenticat/i.test(msg)) {
        this.log.warn(
          `Auth error: ${msg}\n` +
          'Your account has 2FA enabled. Open the plugin settings in the Homebridge UI to complete the login flow.',
        );
      }
      throw new Error(`Auth error: ${msg}`);
    }

    this.storeTokens(data);
    await this.saveCachedTokens();
    this.log.info(
      `Authentication successful — access token expires in ${data.expires_in}s, ` +
      `refresh token expires in ${Math.round(data.refresh_expires_in / 60)}m.`,
    );
  }

  private tokenClientId(): string {
    try {
      const payload = JSON.parse(
        Buffer.from(this.tokens!.accessToken.split('.')[1], 'base64url').toString('utf8'),
      );
      if (typeof payload.azp === 'string' && payload.azp) return payload.azp;
    } catch { /* fall through */ }
    return CLIENT_ID;
  }

  private async doRefresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      if (!this.tokens?.refreshToken) throw new Error('No refresh token available');
      this.log.debug('Refreshing access token…');
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.tokenClientId(),
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
        this.log.debug('Token refresh successful.');
      } catch (err) {
        this.log.warn(
          `Token refresh failed: ${this.extractErrorMessage(err)} — will re-authenticate.`,
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
        this.log.info('Cached tokens belong to a different account — discarding.');
        await fs.unlink(this.tokenCachePath);
        return;
      }
      this.tokens = cached;
      this.log.debug('Loaded token cache from disk.');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.debug('Could not read token cache — ignoring.');
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
      this.log.warn(`Could not save token cache: ${err}`);
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
    if (this.debug) this.log.info('[Hubspace]', ...args.map(String));
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

interface ConclaveEventMessage {
  public?: {
    event: string;
    data: {
      id?: string;
      attribute?: unknown;
      status?: unknown;
      [key: string]: unknown;
    };
  };
  private?: {
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
  | ConclaveEventMessage
  | { error: unknown };

function isHello(e: ConclaveEnvelope): e is ConclaveHelloMessage {
  return 'hello' in e;
}

function isDeviceEvent(e: ConclaveEnvelope): e is ConclaveEventMessage {
  return 'public' in e || 'private' in e;
}

class ConclaveClient extends EventEmitter {
  private socket: tls.TLSSocket | null = null;
  private inflateStream: zlib.Inflate | null = null;
  private deflateStream: zlib.Deflate | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private destroyed = false;
  private rawBuffer: Buffer = Buffer.alloc(0);
  private welcomed = false;
  private conclaveSettled = false;

  constructor(
    private readonly accountId: string,
    private readonly mobileDeviceId: string,
    private readonly fetchConclaveToken: () => Promise<{ token: string; channelId: string | undefined; expiresIn: number; host: string; compression: boolean }>,
    private readonly onDeviceChange: (deviceId: string) => void,
    private readonly log: Logger,
    private readonly debug: boolean,
    private readonly onClientJoin?: () => void,
  ) {
    super();
  }

  connect(): void {
    if (this.destroyed) return;
    this.dbg('Connecting to Conclave…');
    this.fetchConclaveToken()
      .then(({ token, channelId, expiresIn, host, compression }) => {
        this.dbg(`Token acquired — expires in ${expiresIn}s, host: ${host}, compression: ${compression}`);
        this.openSocket(token, channelId, expiresIn, host, compression);
      })
      .catch((err) => {
        this.log.warn(`[Conclave] Token fetch failed: ${err} — will retry.`);
        this.scheduleReconnect();
      });
  }

  private openSocket(conclaveToken: string, channelId: string | undefined, expiresIn: number, host: string, compression: boolean): void {
    // Proactively reconnect at 80% of token lifetime so we never hit server expiry.
    const refreshMs = Math.floor(expiresIn * 0.8) * 1000;
    this.tokenRefreshTimer = setTimeout(() => {
      this.tokenRefreshTimer = null;
      this.dbg('Token expiry approaching — reconnecting proactively.');
      this.teardown();
      this.connect();
    }, refreshMs);
    if (this.destroyed) return;

    const socket = tls.connect({
      host,
      port: CONCLAVE_PORT,
      servername: host,
    });

    this.socket = socket;
    this.rawBuffer = Buffer.alloc(0);

    socket.once('secureConnect', () => {
      this.dbg('TLS connected — waiting for hello.');
    });

    // Shared data handler: accumulates decompressed (or raw) bytes and splits on \n.
    const onData = (chunk: Buffer) => {
      this.rawBuffer = Buffer.concat([this.rawBuffer, chunk]);
      let nlPos: number;
      while ((nlPos = this.rawBuffer.indexOf(0x0a)) !== -1) {
        const line = this.rawBuffer.subarray(0, nlPos);
        this.rawBuffer = this.rawBuffer.subarray(nlPos + 1);
        if (line.length === 0) continue;
        const text = line.toString('utf-8').trim();
        if (text.length === 0) continue;
        this.handleLine(text, conclaveToken, channelId);
      }
    };

    if (compression) {
      // Incoming: socket → inflate → onData (split decompressed lines)
      const inflate = zlib.createInflate();
      this.inflateStream = inflate;
      inflate.on('data', onData);
      inflate.once('error', (err) => {
        // Guard: if this socket is already torn down, the error is just EOF cleanup noise.
        if (this.socket !== socket) return;
        this.log.warn(`[Conclave] Inflate error: ${err.message}`);
        this.teardown();
        this.scheduleReconnect();
      });
      socket.pipe(inflate);

      // Outgoing: write() → deflate → socket (server expects compressed input too)
      const deflate = zlib.createDeflate({ flush: zlib.constants.Z_SYNC_FLUSH });
      this.deflateStream = deflate;
      deflate.pipe(socket, { end: false });
    } else {
      this.inflateStream = null;
      this.deflateStream = null;
      socket.on('data', onData);
    }

    socket.once('error', (err) => {
      this.log.warn(`[Conclave] Socket error: ${err.message}`);
      this.teardown();
      this.scheduleReconnect();
    });

    socket.once('close', () => {
      // Only reconnect for unexpected closes. Intentional teardown nulls this.socket
      // before calling destroy(), so this.socket !== socket in that case.
      if (!this.destroyed && this.socket === socket) {
        this.log.warn('[Conclave] Connection closed — reconnecting.');
        this.teardown();
        this.scheduleReconnect();
      }
    });
  }

  private handleLine(line: string, conclaveToken: string, channelId: string | undefined): void {
    let envelope: ConclaveEnvelope;
    try {
      envelope = JSON.parse(line) as ConclaveEnvelope;
    } catch {
      this.dbg('Non-JSON line from Conclave:', line.slice(0, 120));
      return;
    }

    if (isHello(envelope)) {
      const heartbeatSecs = envelope.hello.heartbeat ?? 270;
      // Cap at 55s to keep NAT/firewall tables alive regardless of server-specified interval.
      const effectiveHeartbeatMs = Math.min(Math.floor(heartbeatSecs * 0.8), 55) * 1000;
      this.dbg(`Received hello — heartbeat every ${effectiveHeartbeatMs / 1000}s (server: ${heartbeatSecs}s).`);
      this.startHeartbeat(effectiveHeartbeatMs);
      this.sendLogin(conclaveToken, channelId);
      return;
    }

    if ('welcome' in envelope) {
      this.dbg('Received welcome — Conclave session active.');
      this.welcomed = true;
      this.backoffMs = 1_000;
      // Ignore join events from sessions already in the channel at connect time.
      setTimeout(() => { this.conclaveSettled = true; }, 3_000);
      return;
    }

    if (isDeviceEvent(envelope)) {
      const msg = envelope.public ?? envelope.private!;
      const { event, data } = msg;
      this.dbg(`[Conclave] event: ${event}, id: ${data?.id ?? 'none'}`);
      if (event === 'attr_change' || event === 'status_change') {
        const deviceId = data?.id;
        if (typeof deviceId === 'string' && deviceId.length > 0) {
          this.onDeviceChange(deviceId);
        }
      }
      return;
    }

    if ('join' in envelope) {
      // Another client connected to the channel (e.g. the Hubspace app opening).
      // Only act after Conclave has settled — the initial burst of join events after
      // welcome represents sessions already in the channel, not new app opens.
      if (this.conclaveSettled) {
        this.dbg('Client join detected — triggering state refresh.');
        this.onClientJoin?.();
      }
      return;
    }

    if ('tunnel' in envelope) {
      return; // server capability announcement — already processed via hello/welcome
    }

    this.dbg(`[Conclave] unrecognised envelope: ${line.slice(0, 200)}`);
  }

  private sendLogin(conclaveToken: string, channelId: string | undefined): void {
    const msg = JSON.stringify({
      login: {
        channelId: channelId ?? this.accountId,
        accessToken: conclaveToken,
        type: 'client',
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
      if (this.deflateStream) {
        this.deflateStream.write(Buffer.from(data, 'utf-8'));
        // Flush after every write so data reaches the server immediately.
        this.deflateStream.flush(zlib.constants.Z_SYNC_FLUSH);
      } else {
        this.socket?.write(data, 'utf-8');
      }
    } catch {
      // Socket may have closed; reconnect will handle it.
    }
  }

  private teardown(): void {
    this.stopHeartbeat();
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    // Destroy compression streams before the socket so they don't fire error events
    // against a dead socket.
    const inflate = this.inflateStream;
    const deflate = this.deflateStream;
    this.inflateStream = null;
    this.deflateStream = null;
    try { inflate?.destroy(); } catch { /* ignore */ }
    try { deflate?.destroy(); } catch { /* ignore */ }

    const s = this.socket;
    this.socket = null;
    this.rawBuffer = Buffer.alloc(0);
    try { s?.destroy(); } catch { /* ignore */ }
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
    if (this.debug) this.log.info('[Conclave]', ...args.map(String));
  }
}
