import { promises as fs } from 'fs';
import axios from 'axios';
import { HubspaceClient } from '../src/hubspace-client';
import { AuthTokens, KeycloakTokenResponse } from '../src/types';

// ── Module mocks (hoisted by ts-jest before imports) ──────────────────────────

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
    rename: jest.fn().mockResolvedValue(undefined),
    unlink: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('axios', () => {
  const instance = {
    get: jest.fn(),
    put: jest.fn(),
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
  };
  const ax: any = jest.fn();
  ax.create = jest.fn(() => instance);
  ax.post = jest.fn();
  ax.get = jest.fn();
  ax.isAxiosError = jest.fn(() => false);
  return { __esModule: true, default: ax };
});

// ── Typed mock references ─────────────────────────────────────────────────────

const fsMock = fs as jest.Mocked<typeof fs>;
const axiosMock = axios as jest.Mocked<typeof axios>;

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockLog = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

function makeClient(username = 'user@test.com', password = 'pass') {
  return new HubspaceClient(username, password, '/storage', mockLog, {
    tokenCachePath: '/storage/hubspace-tokens.json',
  });
}

function futureMs(seconds: number) {
  return Date.now() + seconds * 1000;
}

function validTokens(overrides: Partial<AuthTokens> = {}): AuthTokens {
  return {
    username: 'user@test.com',
    accessToken: 'access-tok',
    refreshToken: 'refresh-tok',
    expiresAt: futureMs(90),        // 90 s from now — not expired
    refreshExpiresAt: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

function tokenResponse(overrides: Partial<KeycloakTokenResponse> = {}): KeycloakTokenResponse {
  return {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    expires_in: 120,
    refresh_expires_in: 0,          // 0 = offline session, never expires
    token_type: 'Bearer',
    ...overrides,
  };
}

const usersMe = {
  accountAccess: [{ account: { accountId: 'acct-123' } }],
};

beforeEach(() => {
  jest.clearAllMocks();
  // Default: writeFile / mkdir / rename succeed silently (already mocked above)
  fsMock.writeFile.mockResolvedValue(undefined);
  fsMock.mkdir.mockResolvedValue(undefined);
  fsMock.rename.mockResolvedValue(undefined);
  fsMock.unlink.mockResolvedValue(undefined);
});

// ── Token cache loading ───────────────────────────────────────────────────────

describe('initialize — token cache', () => {
  it('skips login when valid cached tokens exist', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify(validTokens()) as any);
    axiosMock.get.mockResolvedValue({ data: usersMe });

    const client = makeClient();
    await client.initialize();

    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it('authenticates when no cache file exists (ENOENT)', async () => {
    const err = Object.assign(new Error('no file'), { code: 'ENOENT' });
    fsMock.readFile.mockRejectedValue(err);
    axiosMock.post.mockResolvedValue({ data: tokenResponse() });
    axiosMock.get.mockResolvedValue({ data: usersMe });

    const client = makeClient();
    await client.initialize();

    expect(axiosMock.post).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(axiosMock.post.mock.calls[0][1] as string);
    expect(body.get('grant_type')).toBe('password');
  });

  it('discards cache and re-authenticates when username does not match', async () => {
    const staleTokens = validTokens({ username: 'other@test.com' });
    fsMock.readFile.mockResolvedValue(JSON.stringify(staleTokens) as any);
    axiosMock.post.mockResolvedValue({ data: tokenResponse() });
    axiosMock.get.mockResolvedValue({ data: usersMe });

    const client = makeClient('user@test.com');
    await client.initialize();

    expect(fsMock.unlink).toHaveBeenCalledWith('/storage/hubspace-tokens.json');
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
  });

  it('authenticates when cached tokens have no refresh token', async () => {
    const expired = validTokens({
      expiresAt: Date.now() - 1000,       // expired
      refreshToken: '',
      refreshExpiresAt: Date.now() - 1,   // also expired
    });
    fsMock.readFile.mockResolvedValue(JSON.stringify(expired) as any);
    axiosMock.post.mockResolvedValue({ data: tokenResponse() });
    axiosMock.get.mockResolvedValue({ data: usersMe });

    const client = makeClient();
    await client.initialize();

    const body = new URLSearchParams(axiosMock.post.mock.calls[0][1] as string);
    expect(body.get('grant_type')).toBe('password');
  });
});

// ── Token refresh ─────────────────────────────────────────────────────────────

describe('initialize — token refresh', () => {
  it('refreshes when access token is expired but refresh token is valid', async () => {
    const expiredAccess = validTokens({
      expiresAt: Date.now() - 1000,       // access expired
      refreshExpiresAt: Number.MAX_SAFE_INTEGER,
    });
    fsMock.readFile.mockResolvedValue(JSON.stringify(expiredAccess) as any);
    axiosMock.post.mockResolvedValue({ data: tokenResponse() });
    axiosMock.get.mockResolvedValue({ data: usersMe });

    const client = makeClient();
    await client.initialize();

    expect(axiosMock.post).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(axiosMock.post.mock.calls[0][1] as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-tok');
  });

  it('does not refresh when access token is still valid', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify(validTokens()) as any);
    axiosMock.get.mockResolvedValue({ data: usersMe });

    const client = makeClient();
    await client.initialize();

    expect(axiosMock.post).not.toHaveBeenCalled();
  });
});

// ── Token storage ─────────────────────────────────────────────────────────────

describe('token persistence', () => {
  it('writes tokens atomically (tmp file then rename)', async () => {
    fsMock.readFile.mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }));
    axiosMock.post.mockResolvedValue({ data: tokenResponse() });
    axiosMock.get.mockResolvedValue({ data: usersMe });

    const client = makeClient();
    await client.initialize();

    expect(fsMock.writeFile).toHaveBeenCalledWith(
      '/storage/hubspace-tokens.json.tmp',
      expect.any(String),
      'utf-8',
    );
    expect(fsMock.rename).toHaveBeenCalledWith(
      '/storage/hubspace-tokens.json.tmp',
      '/storage/hubspace-tokens.json',
    );
  });

  it('treats refresh_expires_in=0 as never-expiring refresh token', async () => {
    fsMock.readFile.mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }));
    axiosMock.post.mockResolvedValue({ data: tokenResponse({ refresh_expires_in: 0 }) });
    axiosMock.get.mockResolvedValue({ data: usersMe });

    const client = makeClient();
    await client.initialize();

    const written = JSON.parse((fsMock.writeFile.mock.calls[0][1] as string));
    expect(written.refreshExpiresAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('stores username in cached tokens', async () => {
    fsMock.readFile.mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }));
    axiosMock.post.mockResolvedValue({ data: tokenResponse() });
    axiosMock.get.mockResolvedValue({ data: usersMe });

    const client = makeClient('user@test.com');
    await client.initialize();

    const written = JSON.parse((fsMock.writeFile.mock.calls[0][1] as string));
    expect(written.username).toBe('user@test.com');
  });
});

// ── Authentication ────────────────────────────────────────────────────────────

describe('authentication', () => {
  it('sends correct credentials to Keycloak token endpoint', async () => {
    fsMock.readFile.mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }));
    axiosMock.post.mockResolvedValue({ data: tokenResponse() });
    axiosMock.get.mockResolvedValue({ data: usersMe });

    const client = makeClient('me@example.com', 'secret');
    await client.initialize();

    const [url, body] = axiosMock.post.mock.calls[0];
    expect(url).toBe(
      'https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token',
    );
    const params = new URLSearchParams(body as string);
    expect(params.get('grant_type')).toBe('password');
    expect(params.get('client_id')).toBe('hubspace_android');
    expect(params.get('username')).toBe('me@example.com');
    expect(params.get('password')).toBe('secret');
    expect(params.get('scope')).toBe('openid offline_access');
  });

  it('throws a clear error when credentials are wrong', async () => {
    fsMock.readFile.mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }));
    axiosMock.post.mockRejectedValue(new Error('401 Unauthorized'));

    const client = makeClient();
    await expect(client.initialize()).rejects.toThrow();
  });
});

// ── Account ID resolution ─────────────────────────────────────────────────────

describe('account ID resolution', () => {
  it('resolves account ID from /v1/users/me', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify(validTokens()) as any);
    axiosMock.get.mockResolvedValue({ data: usersMe });

    const client = makeClient();
    await client.initialize();

    expect(axiosMock.get).toHaveBeenCalledWith(
      'https://api2.afero.net/v1/users/me',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringContaining('Bearer') }) }),
    );
  });

  it('throws when /v1/users/me returns no accountId', async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify(validTokens()) as any);
    axiosMock.get.mockResolvedValue({ data: { accountAccess: [] } });

    const client = makeClient();
    await expect(client.initialize()).rejects.toThrow(/accountId missing/);
  });
});
