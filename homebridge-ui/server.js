'use strict';

const crypto = require('crypto');
const https = require('https');
const fs = require('fs').promises;
const path = require('path');

const AUTH_ENDPOINT = 'https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/auth';
const TOKEN_ENDPOINT = 'https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token';
const IOS_CLIENT = 'hubspace_ios';
const REDIRECT_URI = 'hubspace-app://loginredirect';

class PluginUiServer {
  constructor() {
    this.homebridgeStoragePath = process.env.HOMEBRIDGE_STORAGE_PATH || '';
    this._handlers = new Map();

    process.on('message', async (request) => {
      if (request && request.action === 'request') {
        await this._dispatch(request);
      }
    });
  }

  onRequest(route, handler) {
    this._handlers.set(route, handler);
  }

  ready() {
    process.send({ action: 'ready', payload: { server: true } });
  }

  async _dispatch({ requestId, path: route, body }) {
    const handler = this._handlers.get(route);
    if (!handler) {
      process.send({ action: 'response', payload: { requestId, success: false, data: { message: `No handler for ${route}` } } });
      return;
    }
    try {
      const result = await handler(body || {});
      process.send({ action: 'response', payload: { requestId, success: true, data: result } });
    } catch (err) {
      process.send({ action: 'response', payload: { requestId, success: false, data: { message: err.message || String(err) } } });
    }
  }
}

class HubspaceUiServer extends PluginUiServer {
  constructor() {
    super();
    this._otpSession = null;

    this.onRequest('/auth-status', this.getAuthStatus.bind(this));
    this.onRequest('/start-login', this.startLogin.bind(this));
    this.onRequest('/submit-otp', this.submitOtp.bind(this));
    this.ready();
  }

  tokenCachePath() {
    return path.join(this.homebridgeStoragePath, 'hubspace-tokens.json');
  }

  // ─── auth-status ─────────────────────────────────────────────────────────────

  async getAuthStatus() {
    try {
      const raw = await fs.readFile(this.tokenCachePath(), 'utf-8');
      const t = JSON.parse(raw);
      const now = Date.now();
      const refreshValid = t.refreshExpiresAt === undefined
        || t.refreshExpiresAt === Number.MAX_SAFE_INTEGER
        || t.refreshExpiresAt > now + 30_000;
      return { cached: true, valid: refreshValid, username: t.username ?? null };
    } catch {
      return { cached: false, valid: false, username: null };
    }
  }

  // ─── start-login ─────────────────────────────────────────────────────────────

  async startLogin({ username, password }) {
    if (!username || !password) throw new Error('Username and password are required.');

    const verifier = crypto.randomBytes(96).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    const params = new URLSearchParams({
      client_id: IOS_CLIENT, response_type: 'code',
      redirect_uri: REDIRECT_URI, scope: 'openid offline_access',
      code_challenge: challenge, code_challenge_method: 'S256',
    });
    const r1 = await this._get(AUTH_ENDPOINT + '?' + params);
    const cookies = this._parseCookies(r1.headers['set-cookie']);
    const action = this._extractFormAction(r1.body);
    if (!action) throw new Error('Could not parse Hubspace login page. Please try again.');

    const credBody = new URLSearchParams({ username, password }).toString();
    const r2 = await this._post(action, credBody, cookies);

    if (r2.status === 302 && r2.headers['location']?.startsWith('hubspace-app://')) {
      const code = this._extractCode(r2.headers['location']);
      await this._exchangeAndSave(code, verifier, username);
      return { success: true, needed2fa: false };
    }

    if (r2.status === 200 && this._isOtpPage(r2.body)) {
      const otpAction = this._extractFormAction(r2.body);
      if (!otpAction) throw new Error('Could not parse 2FA page. Please try again.');
      const cookies2 = this._mergeCookies(cookies, this._parseCookies(r2.headers['set-cookie']));
      this._otpSession = { otpAction, cookies: cookies2, verifier, username };
      return { success: false, needed2fa: true };
    }

    if (r2.body && (r2.body.includes('Invalid username or password') || r2.body.includes('login-error'))) {
      throw new Error('Invalid username or password.');
    }

    throw new Error(`Unexpected response from Hubspace (HTTP ${r2.status}). Body preview: ${r2.body?.slice(0, 200)}`);
  }

  // ─── submit-otp ───────────────────────────────────────────────────────────────

  async submitOtp({ emailCode }) {
    if (!this._otpSession) throw new Error('No active login session. Please click "Start Login" again.');
    if (!emailCode || !/^\d{6}$/.test(emailCode.trim())) throw new Error('Enter the 6-digit code from your email.');

    const { otpAction, cookies, verifier, username } = this._otpSession;

    const otpBody = new URLSearchParams({
      action: 'submit',
      flowName: 'doLogIn',
      emailCode: emailCode.trim(),
    }).toString();

    const r3 = await this._post(otpAction, otpBody, cookies);

    if (r3.status === 302 && r3.headers['location']?.startsWith('hubspace-app://')) {
      const code = this._extractCode(r3.headers['location']);
      await this._exchangeAndSave(code, verifier, username);
      this._otpSession = null;
      return { success: true };
    }

    if (r3.status === 200 && this._isOtpPage(r3.body)) {
      throw new Error('Incorrect or expired code. Check your email and try again.');
    }

    throw new Error(`Unexpected response (HTTP ${r3.status}). Please start over.`);
  }

  // ─── PKCE token exchange + cache write ────────────────────────────────────────

  async _exchangeAndSave(code, verifier, username) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code', client_id: IOS_CLIENT,
      code, redirect_uri: REDIRECT_URI, code_verifier: verifier,
    }).toString();

    const r = await this._post(TOKEN_ENDPOINT, body, {});
    const data = JSON.parse(r.body);
    if (data.error) throw new Error(`Token exchange failed: ${data.error_description ?? data.error}`);

    const now = Date.now();
    const tokens = {
      username,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now + data.expires_in * 1000,
      refreshExpiresAt: data.refresh_expires_in === 0 ? Number.MAX_SAFE_INTEGER : now + data.refresh_expires_in * 1000,
    };

    const cachePath = this.tokenCachePath();
    const tmp = cachePath + '.tmp';
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), 'utf-8');
    await fs.rename(tmp, cachePath);
  }

  // ─── HTTP helpers ─────────────────────────────────────────────────────────────

  _get(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.get({
        hostname: u.hostname, port: 443, path: u.pathname + u.search,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000,
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out — check your network connection.')); });
      req.on('error', reject);
    });
  }

  _post(url, body, cookieMap) {
    const cookieHeader = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'Mozilla/5.0',
          ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
        },
        timeout: 15000,
      }, (res) => {
        let resBody = '';
        res.on('data', d => resBody += d);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: resBody }));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out — check your network connection.')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ─── Parsing helpers ──────────────────────────────────────────────────────────

  _parseCookies(setCookieHeaders) {
    const map = {};
    for (const h of setCookieHeaders ?? []) {
      const pair = h.split(';')[0].trim();
      const eq = pair.indexOf('=');
      if (eq > 0) map[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return map;
  }

  _mergeCookies(base, overlay) {
    return { ...base, ...overlay };
  }

  _extractFormAction(html) {
    const m = html?.match(/action="([^"]+)"/);
    return m ? m[1].replace(/&amp;/g, '&') : null;
  }

  _extractCode(location) {
    try {
      const url = new URL(location.replace('hubspace-app://', 'https://hubspace-app/'));
      const code = url.searchParams.get('code');
      if (!code) throw new Error('No code in redirect URL');
      return code;
    } catch {
      const m = location.match(/[?&]code=([^&]+)/);
      if (!m) throw new Error('Could not extract authorization code from redirect.');
      return m[1];
    }
  }

  _isOtpPage(html) {
    return !!(html?.includes('emailCode') || html?.includes('otp-input') || html?.includes('kc-otp-login-form'));
  }
}

(() => new HubspaceUiServer())();
