"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HubspaceClient = void 0;
const axios_1 = __importDefault(require("axios"));
const fs_1 = require("fs");
const path = __importStar(require("path"));
const tls = __importStar(require("tls"));
const zlib = __importStar(require("zlib"));
const crypto = __importStar(require("crypto"));
const events_1 = require("events");
const utils_1 = require("./utils");
const types_1 = require("./types");
const AUTH_URL = 'https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token';
const USERS_ME_URL = 'https://api2.afero.net/v1/users/me';
const SEMANTICS_BASE = 'https://semantics2.afero.net/v1';
const CLIENT_ID = 'hubspace_android';
const CONCLAVE_HOST = 'conclave-stream.afero.io';
const CONCLAVE_PORT = 443;
const CONCLAVE_LOGIN_VERSION = '1.3.0';
const CONCLAVE_PROTOCOL = 2;
const BACKOFF_MAX_MS = 20_000;
const EXPIRY_BUFFER_MS = 30_000;
class HubspaceClient {
    username;
    password;
    log;
    http;
    tokens = null;
    accountId = null;
    tokenCachePath;
    refreshInFlight = null;
    authInFlight = null;
    debug;
    authLog;
    conclaveLog;
    constructor(username, password, storagePath, log, options = {}) {
        this.username = username;
        this.password = password;
        this.log = log;
        this.debug = options.debug ?? false;
        this.authLog = (0, utils_1.createLogger)(log, 'Auth');
        this.conclaveLog = (0, utils_1.createLogger)(log, 'Conclave');
        this.tokenCachePath =
            options.tokenCachePath ?? path.join(storagePath, 'hubspace-tokens.json');
        this.http = axios_1.default.create({
            baseURL: SEMANTICS_BASE,
            timeout: 30_000,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Dart/2.18 (dart:io)',
                'host': 'semantics2.afero.net',
                'accept-encoding': 'gzip',
            },
        });
        this.http.interceptors.request.use(async (config) => {
            const token = await this.getValidAccessToken();
            config.headers = config.headers ?? {};
            config.headers['Authorization'] = `Bearer ${token}`;
            return config;
        });
        this.http.interceptors.response.use((res) => res, async (err) => {
            const cfg = err.config;
            if (err.response?.status === 401 && cfg && !cfg._retried) {
                cfg._retried = true;
                await this.doRefresh();
                cfg.headers['Authorization'] = `Bearer ${this.tokens.accessToken}`;
                return this.http(cfg);
            }
            return Promise.reject(err);
        });
    }
    startConclave(onDeviceChange, onClientJoin) {
        const accountId = this.accountId;
        if (!accountId) {
            this.conclaveLog.warn('accountId not yet resolved — Conclave will not start.');
            return;
        }
        const mobileDeviceId = this.getOrCreateMobileDeviceId();
        const client = new ConclaveClient(accountId, mobileDeviceId, () => this.fetchConclaveToken(), onDeviceChange, this.conclaveLog, this.debug, onClientJoin);
        client.connect();
    }
    async fetchConclaveToken() {
        const accountId = await this.resolveAccountId();
        const accessToken = await this.getValidAccessToken();
        const res = await axios_1.default.post(`https://api2.afero.net/v1/accounts/${accountId}/conclaveAccess`, {}, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Dart/2.18 (dart:io)',
                'host': 'api2.afero.net',
                'accept-encoding': 'gzip',
            },
            timeout: 15_000,
        });
        const raw = res.data;
        const tokensArr = raw['tokens'];
        const tokenEntry = tokensArr?.[0];
        const token = tokenEntry?.token ?? raw['token'];
        if (!token)
            throw new Error('No token in Conclave access response');
        const channelId = tokenEntry?.channelId;
        let expiresIn = 90;
        if (tokenEntry?.expiresTimestamp) {
            expiresIn = Math.max(60, Math.floor((tokenEntry.expiresTimestamp - Date.now()) / 1000));
        }
        const conclaveInfo = raw['conclave'];
        const host = conclaveInfo?.host ?? CONCLAVE_HOST;
        const compression = conclaveInfo?.compression ?? false;
        this.conclaveLog.info(`Server: ${host}, compression: ${compression}, channelId: ${channelId ?? '(none — using accountId)'}, token expires in ${expiresIn}s`);
        return { token, channelId, expiresIn, host, compression };
    }
    getOrCreateMobileDeviceId() {
        if (this.tokens?.mobileDeviceId)
            return this.tokens.mobileDeviceId;
        const id = crypto.randomUUID();
        if (this.tokens) {
            this.tokens.mobileDeviceId = id;
            this.saveCachedTokens().catch(() => { });
        }
        return id;
    }
    async initialize() {
        await this.loadCachedTokens();
        if (this.tokens && this.isRefreshTokenValid()) {
            this.authLog.info('Loaded cached tokens — skipping login.');
            if (this.isAccessTokenExpired()) {
                this.log.debug('Access token near expiry; refreshing…');
                await this.doRefresh();
            }
        }
        else {
            this.authLog.info('No valid cached tokens — authenticating…');
            await this.authenticate();
        }
        await this.resolveAccountId();
    }
    async getDevices() {
        const accountId = await this.resolveAccountId();
        const res = await this.http.get(`/accounts/${accountId}/metadevices?expansions=state`);
        this.log.debug(`API returned ${res.data.length} metadevice(s).`);
        const devices = [];
        for (const raw of res.data) {
            if (raw.typeId !== 'metadevice.device')
                continue;
            const deviceClass = raw.description?.device?.deviceClass;
            if (!deviceClass)
                continue;
            devices.push({
                id: raw.id,
                allIds: [raw.id],
                typeId: raw.typeId,
                friendlyName: raw.friendlyName || raw.description?.device?.defaultName || raw.id,
                deviceClass,
                manufacturerName: raw.description?.device?.manufacturerName,
                model: raw.description?.device?.model,
                values: raw.state?.values ?? [],
                colorTempCategories: this.extractColorTempCategories(raw),
            });
        }
        const deduped = new Map();
        for (const d of devices) {
            const key = d.friendlyName.toLowerCase();
            const existing = deduped.get(key);
            if (!existing) {
                deduped.set(key, d);
            }
            else {
                const primary = d.deviceClass.toLowerCase() === 'ceiling-fan' ? d : existing;
                const secondary = d.deviceClass.toLowerCase() === 'ceiling-fan' ? existing : d;
                const merged = {
                    ...primary,
                    allIds: [...new Set([...existing.allIds, ...d.allIds])],
                    values: [
                        ...primary.values,
                        ...secondary.values.filter((v) => !primary.values.some((e) => e.functionClass === v.functionClass &&
                            e.functionInstance === v.functionInstance)),
                    ],
                    colorTempCategories: {
                        ...(secondary.colorTempCategories ?? {}),
                        ...(primary.colorTempCategories ?? {}),
                    },
                };
                deduped.set(key, merged);
            }
        }
        const result = [...deduped.values()];
        this.log.info(`${result.length} controllable device(s) after filtering.`);
        return result;
    }
    extractColorTempCategories(raw) {
        const categories = {};
        for (const fn of raw.description?.functions ?? []) {
            if (fn.functionClass !== types_1.FC.COLOR_TEMP || fn.type !== 'category')
                continue;
            const values = (fn.values ?? [])
                .map(value => value.name)
                .filter((value) => value !== undefined && (0, utils_1.parseKelvin)(value) !== null);
            if (values.length === 0)
                continue;
            categories[fn.functionInstance ?? 'undefined'] = values;
        }
        return Object.keys(categories).length > 0 ? categories : undefined;
    }
    async getDeviceState(deviceIds) {
        const accountId = await this.resolveAccountId();
        const merged = [];
        for (const deviceId of deviceIds) {
            this.dbg('GET STATE', deviceId);
            const res = await this.http.get(`/accounts/${accountId}/metadevices/${deviceId}?expansions=state`);
            const values = res.data.state?.values ?? [];
            for (const v of values) {
                if (!merged.some((e) => e.functionClass === v.functionClass &&
                    e.functionInstance === v.functionInstance)) {
                    merged.push(v);
                }
            }
        }
        return merged;
    }
    async setDeviceState(deviceId, values) {
        const accountId = await this.resolveAccountId();
        const payload = {
            metadeviceId: deviceId,
            values: values.map((v) => ({ ...v, lastUpdateTime: 0 })),
        };
        this.dbg('PUT STATE', deviceId, JSON.stringify(values));
        await this.http.put(`/accounts/${accountId}/metadevices/${deviceId}/state`, payload);
    }
    async resolveAccountId() {
        if (this.accountId)
            return this.accountId;
        const token = await this.getValidAccessToken();
        let data;
        try {
            const res = await axios_1.default.get(USERS_ME_URL, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'User-Agent': 'Dart/2.18 (dart:io)',
                    'host': 'api2.afero.net',
                    'accept-encoding': 'gzip',
                },
                timeout: 15_000,
            });
            data = res.data;
        }
        catch (err) {
            throw new Error(`/v1/users/me failed: ${this.extractErrorMessage(err)}`);
        }
        const access = data['accountAccess'];
        const accountId = access?.[0]?.account?.accountId;
        if (!accountId) {
            throw new Error(`accountId missing from /v1/users/me — response: ${JSON.stringify(data).slice(0, 300)}`);
        }
        this.authLog.info(`Account ID resolved: ${accountId}`);
        this.accountId = accountId;
        return accountId;
    }
    async authenticate() {
        if (this.authInFlight)
            return this.authInFlight;
        this.authInFlight = this._doAuthenticate().finally(() => { this.authInFlight = null; });
        return this.authInFlight;
    }
    async _doAuthenticate() {
        this.authLog.info('Authenticating with username/password…');
        const params = new URLSearchParams({
            grant_type: 'password',
            client_id: CLIENT_ID,
            username: this.username,
            password: this.password,
            scope: 'openid offline_access',
        });
        let data;
        try {
            const res = await axios_1.default.post(AUTH_URL, params.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Dart/2.18 (dart:io)',
                },
                timeout: 20_000,
            });
            data = res.data;
        }
        catch (err) {
            const msg = this.extractErrorMessage(err);
            if (/mfa|otp|two.factor|multi.factor|email.*code|authenticat/i.test(msg)) {
                this.authLog.warn(`Authentication failed: ${msg}\n` +
                    'Your account has 2FA enabled. Open the plugin settings in the Homebridge UI to complete the login flow.');
            }
            else {
                this.authLog.warn(`Authentication failed: ${msg}`);
            }
            throw new Error(`Authentication failed: ${msg}`);
        }
        if (data.error) {
            const msg = `${data.error} — ${data.error_description ?? ''}`;
            if (/mfa|otp|two.factor|multi.factor|email.*code|authenticat/i.test(msg)) {
                this.authLog.warn(`Auth error: ${msg}\n` +
                    'Your account has 2FA enabled. Open the plugin settings in the Homebridge UI to complete the login flow.');
            }
            throw new Error(`Auth error: ${msg}`);
        }
        this.storeTokens(data);
        await this.saveCachedTokens();
        this.authLog.info(`Authentication successful — access token expires in ${data.expires_in}s, ` +
            `refresh token expires in ${Math.round(data.refresh_expires_in / 60)}m.`);
    }
    tokenClientId() {
        try {
            const payload = JSON.parse(Buffer.from(this.tokens.accessToken.split('.')[1], 'base64url').toString('utf8'));
            if (typeof payload.azp === 'string' && payload.azp)
                return payload.azp;
        }
        catch { }
        return CLIENT_ID;
    }
    async doRefresh() {
        if (this.refreshInFlight)
            return this.refreshInFlight;
        this.refreshInFlight = (async () => {
            if (!this.tokens?.refreshToken)
                throw new Error('No refresh token available');
            this.log.debug('Refreshing access token…');
            const params = new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: this.tokenClientId(),
                refresh_token: this.tokens.refreshToken,
            });
            try {
                const res = await axios_1.default.post(AUTH_URL, params.toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    timeout: 20_000,
                });
                this.storeTokens(res.data);
                await this.saveCachedTokens();
                this.log.debug('Token refresh successful.');
            }
            catch (err) {
                this.authLog.warn(`Token refresh failed: ${this.extractErrorMessage(err)} — will re-authenticate.`);
                throw err;
            }
            finally {
                this.refreshInFlight = null;
            }
        })();
        return this.refreshInFlight;
    }
    async getValidAccessToken() {
        if (!this.tokens) {
            await this.authenticate();
        }
        else if (this.isAccessTokenExpired()) {
            if (this.tokens.refreshToken) {
                try {
                    await this.doRefresh();
                }
                catch {
                    if (!this.isRefreshTokenValid()) {
                        await this.authenticate();
                    }
                }
            }
            else {
                await this.authenticate();
            }
        }
        return this.tokens.accessToken;
    }
    storeTokens(data) {
        const now = Date.now();
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
    async loadCachedTokens() {
        try {
            const raw = await fs_1.promises.readFile(this.tokenCachePath, 'utf-8');
            const cached = JSON.parse(raw);
            if (cached.username && cached.username !== this.username) {
                this.authLog.info('Cached tokens belong to a different account — discarding.');
                await fs_1.promises.unlink(this.tokenCachePath);
                return;
            }
            this.tokens = cached;
            this.log.debug('Loaded token cache from disk.');
        }
        catch (err) {
            if (err.code !== 'ENOENT') {
                this.log.debug('Could not read token cache — ignoring.');
            }
            this.tokens = null;
        }
    }
    async saveCachedTokens() {
        try {
            const dir = path.dirname(this.tokenCachePath);
            await fs_1.promises.mkdir(dir, { recursive: true });
            const tmp = this.tokenCachePath + '.tmp';
            await fs_1.promises.writeFile(tmp, JSON.stringify(this.tokens, null, 2), 'utf-8');
            await fs_1.promises.rename(tmp, this.tokenCachePath);
        }
        catch (err) {
            this.authLog.warn(`Could not save token cache: ${err}`);
        }
    }
    isAccessTokenExpired() {
        if (!this.tokens)
            return true;
        return Date.now() >= this.tokens.expiresAt - EXPIRY_BUFFER_MS;
    }
    isRefreshTokenValid() {
        if (!this.tokens)
            return false;
        return Date.now() < this.tokens.refreshExpiresAt - EXPIRY_BUFFER_MS;
    }
    dbg(...args) {
        if (this.debug)
            this.log.info('[Hubspace]', ...args.map(String));
    }
    extractErrorMessage(err) {
        if (axios_1.default.isAxiosError(err)) {
            const data = err.response?.data;
            return data?.error_description ?? data?.error ?? err.message;
        }
        return String(err);
    }
}
exports.HubspaceClient = HubspaceClient;
function isHello(e) {
    return 'hello' in e;
}
function isDeviceEvent(e) {
    return 'public' in e || 'private' in e;
}
class ConclaveClient extends events_1.EventEmitter {
    accountId;
    mobileDeviceId;
    fetchConclaveToken;
    onDeviceChange;
    log;
    debug;
    onClientJoin;
    socket = null;
    inflateStream = null;
    deflateStream = null;
    heartbeatTimer = null;
    reconnectTimer = null;
    tokenRefreshTimer = null;
    backoffMs = 1_000;
    destroyed = false;
    rawBuffer = Buffer.alloc(0);
    welcomed = false;
    conclaveSettled = false;
    constructor(accountId, mobileDeviceId, fetchConclaveToken, onDeviceChange, log, debug, onClientJoin) {
        super();
        this.accountId = accountId;
        this.mobileDeviceId = mobileDeviceId;
        this.fetchConclaveToken = fetchConclaveToken;
        this.onDeviceChange = onDeviceChange;
        this.log = log;
        this.debug = debug;
        this.onClientJoin = onClientJoin;
    }
    connect() {
        if (this.destroyed)
            return;
        this.dbg('Connecting to Conclave…');
        this.fetchConclaveToken()
            .then(({ token, channelId, expiresIn, host, compression }) => {
            this.dbg(`Token acquired — expires in ${expiresIn}s, host: ${host}, compression: ${compression}`);
            this.openSocket(token, channelId, expiresIn, host, compression);
        })
            .catch((err) => {
            this.log.warn(`Token fetch failed: ${err} — will retry.`);
            this.scheduleReconnect();
        });
    }
    openSocket(conclaveToken, channelId, expiresIn, host, compression) {
        const refreshMs = Math.floor(expiresIn * 0.8) * 1000;
        this.tokenRefreshTimer = setTimeout(() => {
            this.tokenRefreshTimer = null;
            this.dbg('Token expiry approaching — reconnecting proactively.');
            this.teardown();
            this.connect();
        }, refreshMs);
        if (this.destroyed)
            return;
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
        const onData = (chunk) => {
            this.rawBuffer = Buffer.concat([this.rawBuffer, chunk]);
            let nlPos;
            while ((nlPos = this.rawBuffer.indexOf(0x0a)) !== -1) {
                const line = this.rawBuffer.subarray(0, nlPos);
                this.rawBuffer = this.rawBuffer.subarray(nlPos + 1);
                if (line.length === 0)
                    continue;
                const text = line.toString('utf-8').trim();
                if (text.length === 0)
                    continue;
                this.handleLine(text, conclaveToken, channelId);
            }
        };
        if (compression) {
            const inflate = zlib.createInflate();
            this.inflateStream = inflate;
            inflate.on('data', onData);
            inflate.once('error', (err) => {
                if (this.socket !== socket)
                    return;
                this.log.warn(`Inflate error: ${err.message}`);
                this.teardown();
                this.scheduleReconnect();
            });
            socket.pipe(inflate);
            const deflate = zlib.createDeflate({ flush: zlib.constants.Z_SYNC_FLUSH });
            this.deflateStream = deflate;
            deflate.pipe(socket, { end: false });
        }
        else {
            this.inflateStream = null;
            this.deflateStream = null;
            socket.on('data', onData);
        }
        socket.once('error', (err) => {
            this.log.warn(`Socket error: ${err.message}`);
            this.teardown();
            this.scheduleReconnect();
        });
        socket.once('close', () => {
            if (!this.destroyed && this.socket === socket) {
                this.log.warn('Connection closed — reconnecting.');
                this.teardown();
                this.scheduleReconnect();
            }
        });
    }
    handleLine(line, conclaveToken, channelId) {
        let envelope;
        try {
            envelope = JSON.parse(line);
        }
        catch {
            this.dbg('Non-JSON line from Conclave:', line.slice(0, 120));
            return;
        }
        if (isHello(envelope)) {
            const heartbeatSecs = envelope.hello.heartbeat ?? 270;
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
            setTimeout(() => { this.conclaveSettled = true; }, 3_000);
            return;
        }
        if (isDeviceEvent(envelope)) {
            const msg = envelope.public ?? envelope.private;
            const { event, data } = msg;
            this.dbg(`event: ${event}, id: ${data?.id ?? 'none'}`);
            if (event === 'attr_change' || event === 'status_change') {
                const deviceId = data?.id;
                if (typeof deviceId === 'string' && deviceId.length > 0) {
                    this.onDeviceChange(deviceId);
                }
            }
            return;
        }
        if ('join' in envelope) {
            if (this.conclaveSettled) {
                this.dbg('Client join detected — triggering state refresh.');
                this.onClientJoin?.();
            }
            return;
        }
        if ('tunnel' in envelope) {
            return;
        }
        this.dbg(`unrecognised envelope: ${line.slice(0, 200)}`);
    }
    sendLogin(conclaveToken, channelId) {
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
    startHeartbeat(intervalMs) {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.write('\n');
        }, intervalMs);
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    write(data) {
        try {
            if (this.deflateStream) {
                this.deflateStream.write(Buffer.from(data, 'utf-8'));
                this.deflateStream.flush(zlib.constants.Z_SYNC_FLUSH);
            }
            else {
                this.socket?.write(data, 'utf-8');
            }
        }
        catch {
        }
    }
    teardown() {
        this.stopHeartbeat();
        if (this.tokenRefreshTimer) {
            clearTimeout(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }
        const inflate = this.inflateStream;
        const deflate = this.deflateStream;
        this.inflateStream = null;
        this.deflateStream = null;
        try {
            inflate?.destroy();
        }
        catch { }
        try {
            deflate?.destroy();
        }
        catch { }
        const s = this.socket;
        this.socket = null;
        this.rawBuffer = Buffer.alloc(0);
        try {
            s?.destroy();
        }
        catch { }
    }
    scheduleReconnect() {
        if (this.destroyed)
            return;
        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
        this.dbg(`Reconnecting in ${delay}ms.`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }
    destroy() {
        this.destroyed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.teardown();
    }
    dbg(...args) {
        if (this.debug)
            this.log.info(args.map(String).join(' '));
    }
}
//# sourceMappingURL=hubspace-client.js.map