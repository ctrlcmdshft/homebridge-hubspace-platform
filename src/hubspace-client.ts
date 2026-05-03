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
const API_BASE = 'https://api2.afero.net/v1';
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
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Dart/3.3 (dart:io)',
      },
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
    this.log.info(`[Hubspace] Fetching devices for account ${accountId}…`);

    try {
      const res = await this.http.get<HubspaceDevice[]>(url);
      this.log.info(`[Hubspace] Cloud returned ${res.data.length} metadevice(s).`);
      return res.data;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        this.log.error(
          `[Hubspace] Devices request failed — status ${err.response?.status}, ` +
          `body: ${JSON.stringify(err.response?.data)}`,
        );
      }
      throw err;
    }
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

    const token = this.tokens!.accessToken;
    const authHeader = { Authorization: `Bearer ${token}`, 'User-Agent': 'Dart/3.3 (dart:io)' };

    // ── Step 1: explicit JWT claims ──────────────────────────────────────────
    const jwtPayload = this.decodeJwt(token);
    if (this.debug) {
      this.log.debug('[Hubspace] JWT payload:', JSON.stringify(jwtPayload, null, 2));
    }
    const explicit =
      (jwtPayload?.['account_id'] as string | undefined) ??
      (jwtPayload?.['accountId'] as string | undefined) ??
      (jwtPayload?.['afero_account_id'] as string | undefined) ??
      (jwtPayload?.['custom:account_id'] as string | undefined);
    if (explicit) {
      this.log.info(`[Hubspace] Account ID from JWT claim: ${explicit}`);
      this.accountId = explicit;
      return this.accountId;
    }

    // ── Step 2: Keycloak userinfo endpoint (contains additional user attributes) ──
    try {
      const uiRes = await axios.get<Record<string, unknown>>(
        'https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/userinfo',
        { headers: authHeader, timeout: 15_000 },
      );
      this.log.info('[Hubspace] Userinfo response:', JSON.stringify(uiRes.data));
      const ui = uiRes.data;
      const fromUi =
        (ui['account_id'] as string | undefined) ??
        (ui['accountId'] as string | undefined) ??
        (ui['afero_account_id'] as string | undefined);
      if (fromUi) {
        this.log.info(`[Hubspace] Account ID from userinfo: ${fromUi}`);
        this.accountId = fromUi;
        return this.accountId;
      }
    } catch (err) {
      this.log.warn('[Hubspace] Userinfo endpoint failed:', this.extractErrorMessage(err));
    }

    // ── Step 3: /v1/accounts listing ─────────────────────────────────────────
    try {
      const acRes = await axios.get<AferoAccount[]>(`${API_BASE}/accounts`, {
        headers: authHeader,
        timeout: 15_000,
      });
      this.log.info('[Hubspace] Accounts response:', JSON.stringify(acRes.data));
      if (acRes.data?.length > 0) {
        this.accountId = acRes.data[0].accountId;
        this.log.info(`[Hubspace] Account ID from /accounts: ${this.accountId}`);
        return this.accountId;
      }
    } catch (err) {
      this.log.warn(
        '[Hubspace] /accounts failed:',
        this.extractErrorMessage(err),
        axios.isAxiosError(err) ? JSON.stringify(err.response?.data) : '',
      );
    }

    // ── Step 4: derive from JWT sub (last UUID segment after splitting on ':') ──
    const sub = jwtPayload?.['sub'] as string | undefined;
    if (sub) {
      // sub format from Keycloak: "f:<realm-uuid>:<user-uuid>"
      // Try each colon-separated UUID segment, largest granularity last.
      const segments = sub.split(':').filter(s => s.length > 8);
      this.log.warn(
        `[Hubspace] Falling back to sub segments: ${segments.join(', ')}`,
      );
      // Use the first non-"f" segment (the realm/partner UUID) as the account.
      if (segments.length > 0) {
        this.accountId = segments[0];
        return this.accountId;
      }
    }

    throw new Error('[Hubspace] Could not determine Afero account ID — check logs above for clues.');
  }

  private decodeJwt(token: string): Record<string, unknown> | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
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
