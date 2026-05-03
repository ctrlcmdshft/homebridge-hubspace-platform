import axios, { AxiosInstance, AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
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

  async initialize(): Promise<void> {
    this.loadCachedTokens();

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
        typeId: raw.typeId,
        friendlyName: raw.friendlyName || raw.description?.device?.defaultName || raw.id,
        deviceClass,
        manufacturerName: raw.description?.device?.manufacturerName,
        model: raw.description?.device?.model,
        values: raw.values ?? [],
      });
    }

    // Deduplicate: when the API returns both a "fan" and a "ceiling-fan" with
    // the same friendly name (same physical device), keep only "ceiling-fan".
    const deduped = new Map<string, HubspaceDevice>();
    for (const d of devices) {
      const key = d.friendlyName.toLowerCase();
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, d);
      } else if (d.deviceClass.toLowerCase() === 'ceiling-fan') {
        // Prefer ceiling-fan over generic fan.
        deduped.set(key, d);
      }
    }
    const result = [...deduped.values()];

    this.log.info(`[Hubspace] ${result.length} controllable device(s) after filtering.`);
    return result;
  }

  /** Fetches the latest state for a single device. */
  async getDeviceState(deviceId: string): Promise<DeviceStateValue[]> {
    const accountId = await this.resolveAccountId();
    this.dbg('GET STATE', deviceId);
    const res = await this.http.get<HubspaceMetadeviceRaw>(
      `/accounts/${accountId}/metadevices/${deviceId}?expansions=state`,
    );
    return res.data.values ?? [];
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
    this.saveCachedTokens();
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
        this.saveCachedTokens();
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
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now + data.expires_in * 1000,
      refreshExpiresAt,
    };
  }

  private loadCachedTokens(): void {
    try {
      if (!fs.existsSync(this.tokenCachePath)) return;
      const raw = fs.readFileSync(this.tokenCachePath, 'utf-8');
      this.tokens = JSON.parse(raw) as AuthTokens;
      this.log.debug('[Hubspace] Loaded token cache from disk.');
    } catch {
      this.log.debug('[Hubspace] Could not read token cache — ignoring.');
      this.tokens = null;
    }
  }

  private saveCachedTokens(): void {
    try {
      const dir = path.dirname(this.tokenCachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.tokenCachePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.tokens, null, 2), 'utf-8');
      fs.renameSync(tmp, this.tokenCachePath);
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
