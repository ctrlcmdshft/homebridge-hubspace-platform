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
  /** Base URL prefix that worked for `getDevices` (e.g. `.../accounts/{id}`). */
  private workingBase: string | null = null;
  private workingUserId: string | null = null;
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
      if (this.isAccessTokenExpired()) {
        this.log.debug('[Hubspace] Access token near expiry; refreshing…');
        await this.doRefresh();
      }
      // Always decode and log the access token claims so we can identify fields.
      const claims = this.decodeJwt(this.tokens.accessToken);
      this.log.info('[Hubspace] Cached access token claims:', JSON.stringify(claims));
    } else {
      this.log.info('[Hubspace] No valid cached tokens — authenticating…');
      await this.authenticate();
    }
  }

  /** Fetches all metadevices (with expanded state) for the account. */
  async getDevices(): Promise<HubspaceDevice[]> {
    const userId = await this.resolveAccountId();
    const token = this.tokens!.accessToken;
    const authHeader = {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Dart/3.3 (dart:io)',
      'Accept': 'application/json',
    };

    // Try each candidate URL pattern and return the first that succeeds.
    const candidates: Array<{ label: string; url: string }> = [
      // Pattern 1 – accounts path, api2.afero.net (original Afero OEM structure)
      { label: 'api2/accounts', url: `${API_BASE}/accounts/${userId}/metadevices?expansions=state` },
      // Pattern 2 – users path, api2.afero.net
      { label: 'api2/users', url: `${API_BASE}/users/${userId}/metadevices?expansions=state` },
      // Pattern 3 – Hubspace-branded API host, accounts path
      { label: 'hubspace/accounts', url: `https://api.hubspaceconnect.com/v1/accounts/${userId}/metadevices?expansions=state` },
      // Pattern 4 – Hubspace-branded API host, users path
      { label: 'hubspace/users', url: `https://api.hubspaceconnect.com/v1/users/${userId}/metadevices?expansions=state` },
      // Pattern 5 – no account/user in path (token carries identity)
      { label: 'api2/flat', url: `${API_BASE}/metadevices?expansions=state` },
    ];

    for (const { label, url } of candidates) {
      this.log.info(`[Hubspace] Trying device URL [${label}]: ${url}`);
      try {
        const res = await axios.get<HubspaceDevice[]>(url, { headers: authHeader, timeout: 20_000 });
        this.log.info(`[Hubspace] ✓ [${label}] returned ${res.data.length} device(s).`);
        // Cache the winning pattern for state reads/writes.
        this.workingBase = url.replace(/\/metadevices.*$/, '');
        this.workingUserId = userId;
        return res.data;
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : '?';
        const body = axios.isAxiosError(err) ? JSON.stringify(err.response?.data) : String(err);
        this.log.warn(`[Hubspace] ✗ [${label}] status=${status} body=${body}`);
      }
    }

    throw new Error('[Hubspace] All device URL patterns failed — see log for details.');
  }

  /** Fetches the latest state for a single device. */
  async getDeviceState(deviceId: string): Promise<DeviceStateValue[]> {
    const base = await this.ensureWorkingBase();
    const url = `${base}/metadevices/${deviceId}?expansions=state`;
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
    const payload = {
      metadeviceId: deviceId,
      values: values.map((v) => ({
        ...v,
        lastUpdateTime: 0,
      })),
    };

    this.dbg('PUT STATE', deviceId, JSON.stringify(values));
    await this.http.put(`${await this.ensureWorkingBase()}/metadevices/${deviceId}/state`, payload);
  }

  // ─── Authentication ──────────────────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    this.log.info('[Hubspace] Authenticating with username/password…');
    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: CLIENT_ID,
      username: this.username,
      password: this.password,
      // Request openid scope so we also get an id_token with richer user claims.
      scope: 'openid profile email',
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

    // Always log all JWT claims so we can identify the correct account ID field.
    const accessClaims = this.decodeJwt(data.access_token);
    this.log.info('[Hubspace] Access token claims:', JSON.stringify(accessClaims));
    if ((data as KeycloakTokenResponse & { id_token?: string }).id_token) {
      const idClaims = this.decodeJwt(
        (data as KeycloakTokenResponse & { id_token?: string }).id_token!,
      );
      this.log.info('[Hubspace] ID token claims:', JSON.stringify(idClaims));
    }

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

  // ─── Working-base resolution ─────────────────────────────────────────────────

  /** Returns the base URL that succeeded during discovery, triggering discovery if needed. */
  private async ensureWorkingBase(): Promise<string> {
    if (this.workingBase) return this.workingBase;
    // Discovery hasn't run yet (e.g. state poll before first getDevices call).
    await this.getDevices();
    if (!this.workingBase) throw new Error('[Hubspace] No working API base URL found.');
    return this.workingBase;
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
