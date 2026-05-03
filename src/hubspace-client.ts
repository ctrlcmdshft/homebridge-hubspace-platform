import axios, { AxiosInstance, AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from 'homebridge';
import {
  AuthTokens,
  KeycloakTokenResponse,
  AferoAccount,
  HubspaceDevice,
  DeviceStateValue,
} from './types';

// ─── Constants ─────────────────────────────────────────────────────────────────
const AUTH_URL =
  'https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token';
/** Device operations — metadevices, state read/write. */
const API_BASE = 'https://semantics2.afero.net/v1';
/** Account listing fallback (only used if JWT has no account claim). */
const ACCOUNT_API = 'https://api2.afero.net/v1';
const CLIENT_ID = 'hubspace_android';

/** Buffer before token expiry within which we proactively refresh (ms). */
const EXPIRY_BUFFER_MS = 60_000;

// ─── HubspaceClient ─────────────────────────────────────────────────────────
export class HubspaceClient {
  private readonly http: AxiosInstance;
  private tokens: AuthTokens | null = null;
  private accountId: string | null = null;
  private readonly tokenCachePath: string;
  /** Prevents concurrent token refreshes. */
  private refreshInFlight: Promise<void> | null = null;
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
      baseURL: API_BASE,
      timeout: 30_000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Attach Bearer token to every request.
    this.http.interceptors.request.use(async (config) => {
      const token = await this.getValidAccessToken();
      config.headers = config.headers ?? {};
      config.headers['Authorization'] = `Bearer ${token}`;
      return config;
    });

    // On 401, try a single token refresh and retry.
    this.http.interceptors.response.use(
      (res) => res,
      async (err: AxiosError) => {
        const cfg = err.config as typeof err.config & { _retried?: boolean };
        if (err.response?.status === 401 && cfg && !cfg._retried) {
          cfg._retried = true;
          try {
            await this.doRefresh();
            cfg.headers!['Authorization'] = `Bearer ${this.tokens!.accessToken}`;
            return this.http(cfg);
          } catch {
            // Refresh failed; re-authenticate from scratch.
            await this.authenticate();
            cfg.headers!['Authorization'] = `Bearer ${this.tokens!.accessToken}`;
            return this.http(cfg);
          }
        }
        return Promise.reject(err);
      },
    );
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Ensures we have a valid session. Tries to load cached tokens first,
   * then falls back to username / password authentication.
   */
  async initialize(): Promise<void> {
    this.loadCachedTokens();

    if (this.tokens && this.isRefreshTokenValid()) {
      this.log.info('[Hubspace] Loaded cached tokens — skipping login.');
      // Proactively refresh if the access token is close to expiry.
      if (this.isAccessTokenExpired()) {
        this.log.debug('[Hubspace] Access token near expiry; refreshing…');
        await this.doRefresh();
      }
    } else {
      this.log.info('[Hubspace] No valid cached tokens — authenticating…');
      await this.authenticate();
    }
  }

  /** Fetches all metadevices (with expanded state) for the account. */
  async getDevices(): Promise<HubspaceDevice[]> {
    const accountId = await this.resolveAccountId();
    const url = `/accounts/${accountId}/metadevices?expansions=state`;
    this.dbg('GET', url);

    const res = await this.http.get<HubspaceDevice[]>(url);
    this.dbg('DEVICES', `got ${res.data.length} metadevice(s)`);
    return res.data;
  }

  /** Fetches the latest state for a single device. */
  async getDeviceState(deviceId: string): Promise<DeviceStateValue[]> {
    const accountId = await this.resolveAccountId();
    const url = `/accounts/${accountId}/metadevices/${deviceId}?expansions=state`;
    this.dbg('GET STATE', deviceId);

    const res = await this.http.get<HubspaceDevice>(url);
    return res.data.values ?? [];
  }

  /**
   * Sends a state update for one or more capabilities on a device.
   * Each entry in `values` must include `functionClass`, `functionInstance`,
   * and the new `value`.
   */
  async setDeviceState(
    deviceId: string,
    values: Partial<DeviceStateValue>[],
  ): Promise<void> {
    const accountId = await this.resolveAccountId();
    const url = `/accounts/${accountId}/metadevices/${deviceId}/state`;

    const payload = {
      metadeviceId: deviceId,
      values: values.map((v) => ({
        ...v,
        lastUpdateTime: 0, // server will set the real timestamp
      })),
    };

    this.dbg('PUT STATE', deviceId, JSON.stringify(values));
    await this.http.put(url, payload);
  }

  // ─── Authentication ──────────────────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    this.log.info('[Hubspace] Authenticating with username/password…');
    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: CLIENT_ID,
      username: this.username,
      password: this.password,
    });

    let data: KeycloakTokenResponse;
    try {
      const res = await axios.post<KeycloakTokenResponse>(AUTH_URL, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20_000,
      });
      data = res.data;
    } catch (err) {
      const msg = this.extractErrorMessage(err);
      throw new Error(`[Hubspace] Authentication failed: ${msg}`);
    }

    if (data.error) {
      throw new Error(
        `[Hubspace] Auth error: ${data.error} — ${data.error_description ?? ''}`,
      );
    }

    this.storeTokens(data);
    this.saveCachedTokens();
    this.log.info('[Hubspace] Authentication successful — tokens cached.');
  }

  private async doRefresh(): Promise<void> {
    // Coalesce concurrent refresh calls.
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

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
        const msg = this.extractErrorMessage(err);
        this.log.warn(`[Hubspace] Token refresh failed: ${msg} — will re-authenticate.`);
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
      if (this.isRefreshTokenValid()) {
        await this.doRefresh();
      } else {
        await this.authenticate();
      }
    }
    return this.tokens!.accessToken;
  }

  // ─── Account resolution ──────────────────────────────────────────────────────

  private async resolveAccountId(): Promise<string> {
    if (this.accountId) return this.accountId;

    // Primary: decode account ID directly from the JWT — no extra API call needed.
    const fromJwt = this.extractAccountIdFromJwt();
    if (fromJwt) {
      this.accountId = fromJwt;
      this.log.debug(`[Hubspace] Account ID from token: ${this.accountId}`);
      return this.accountId;
    }

    // Fallback: ask the accounts API.
    this.log.debug('[Hubspace] Account ID not in token — querying accounts API…');
    try {
      const res = await axios.get<AferoAccount[]>(`${ACCOUNT_API}/accounts`, {
        headers: { Authorization: `Bearer ${this.tokens!.accessToken}` },
        timeout: 15_000,
      });
      if (res.data && res.data.length > 0) {
        this.accountId = res.data[0].accountId;
        this.log.debug(`[Hubspace] Account ID from API: ${this.accountId}`);
        return this.accountId;
      }
    } catch (err) {
      this.log.warn('[Hubspace] Accounts API failed:', this.extractErrorMessage(err));
    }

    throw new Error(
      '[Hubspace] Could not determine Afero account ID. ' +
      'Enable debug logging to inspect the JWT claims.',
    );
  }

  /**
   * Decodes the JWT access token payload and tries to extract the Afero
   * account ID from known claim names.  Logs all claims in debug mode.
   */
  private extractAccountIdFromJwt(): string | null {
    if (!this.tokens?.accessToken) return null;
    try {
      const parts = this.tokens.accessToken.split('.');
      if (parts.length !== 3) return null;

      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf-8'),
      ) as Record<string, unknown>;

      if (this.debug) {
        this.log.debug('[Hubspace] JWT claims:', JSON.stringify(payload, null, 2));
      }

      // Try the claim names Hubspace/Afero are known to use.
      const candidate =
        (payload['account_id'] as string | undefined) ??
        (payload['accountId'] as string | undefined) ??
        (payload['afero_account_id'] as string | undefined) ??
        (payload['custom:account_id'] as string | undefined);

      return candidate ?? null;
    } catch {
      return null;
    }
  }

  // ─── Token persistence ───────────────────────────────────────────────────────

  private storeTokens(data: KeycloakTokenResponse): void {
    const now = Date.now();
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now + data.expires_in * 1000,
      refreshExpiresAt: now + data.refresh_expires_in * 1000,
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
    if (this.debug) {
      this.log.debug(`[Hubspace]`, ...args.map(String));
    }
  }

  private extractErrorMessage(err: unknown): string {
    if (axios.isAxiosError(err)) {
      const data = err.response?.data as Record<string, string> | undefined;
      return data?.error_description ?? data?.error ?? err.message;
    }
    return String(err);
  }
}
