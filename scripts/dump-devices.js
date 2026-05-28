#!/usr/bin/env node
/**
 * Hubspace device capability dumper
 * Dumps every device on your account with its full functionClass/value list.
 * Useful for requesting support for new device types.
 *
 * Requirements: Node 18+ (ships with Homebridge)
 *
 * Usage:
 *   node dump-devices.js
 *
 * Or one-liner:
 *   curl -fsSL https://raw.githubusercontent.com/ctrlcmdshft/homebridge-hubspace-platform/main/scripts/dump-devices.js -o /tmp/hubspace-dump.js && node /tmp/hubspace-dump.js
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const readline = require('readline');

const AUTH_ENDPOINT = 'https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/auth';
const TOKEN_ENDPOINT = 'https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token';
const USERS_ME_URL = 'https://api2.afero.net/v1/users/me';
const SEMANTICS_BASE = 'https://semantics2.afero.net/v1';
const IOS_CLIENT = 'hubspace_ios';
const REDIRECT_URI = 'hubspace-app://loginredirect';

async function promptVisible(label) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(label, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptPassword(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    // Windows CMD / non-TTY: visible fallback
    return promptVisible(label);
  }
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise(resolve => {
    let input = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '\x03') {
        process.exit();
      } else if (ch === '\x7f' || ch === '\b') {
        input = input.slice(0, -1);
      } else {
        input += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

// ─── HTTP helpers (manual redirect control needed for auth flow) ──────────────

function httpGet(url) {
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
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out.')); });
    req.on('error', reject);
  });
}

function httpPost(url, body, cookieMap) {
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
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out.')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseCookies(setCookieHeaders) {
  const map = {};
  for (const h of setCookieHeaders ?? []) {
    const pair = h.split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq > 0) map[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return map;
}

function extractFormAction(html) {
  const m = html?.match(/action="([^"]+)"/);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

function extractCode(location) {
  try {
    const url = new URL(location.replace('hubspace-app://', 'https://hubspace-app/'));
    const code = url.searchParams.get('code');
    if (!code) throw new Error('No code in redirect');
    return code;
  } catch {
    const m = location.match(/[?&]code=([^&]+)/);
    if (!m) throw new Error('Could not extract authorization code from redirect.');
    return m[1];
  }
}

function isOtpPage(html) {
  return !!(html?.includes('emailCode') || html?.includes('otp-input') || html?.includes('kc-otp-login-form'));
}

// ─── PKCE auth flow — supports both non-2FA and 2FA accounts ─────────────────

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code', client_id: IOS_CLIENT,
    code, redirect_uri: REDIRECT_URI, code_verifier: verifier,
  }).toString();
  const r = await httpPost(TOKEN_ENDPOINT, body, {});
  const data = JSON.parse(r.body);
  if (data.error) throw new Error(`Token exchange failed: ${data.error_description ?? data.error}`);
  return data.access_token;
}

async function getToken(username, password) {
  const verifier = crypto.randomBytes(96).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const params = new URLSearchParams({
    client_id: IOS_CLIENT, response_type: 'code',
    redirect_uri: REDIRECT_URI, scope: 'openid offline_access',
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  const r1 = await httpGet(AUTH_ENDPOINT + '?' + params);
  const cookies = parseCookies(r1.headers['set-cookie']);
  const action = extractFormAction(r1.body);
  if (!action) throw new Error('Could not parse Hubspace login page. Please try again.');

  const credBody = new URLSearchParams({ username, password }).toString();
  const r2 = await httpPost(action, credBody, cookies);

  if (r2.status === 302 && r2.headers['location']?.startsWith('hubspace-app://')) {
    return exchangeCode(extractCode(r2.headers['location']), verifier);
  }

  if (r2.status === 200 && isOtpPage(r2.body)) {
    const otpAction = extractFormAction(r2.body);
    if (!otpAction) throw new Error('Could not parse 2FA page. Please try again.');
    const cookies2 = { ...cookies, ...parseCookies(r2.headers['set-cookie']) };

    process.stdout.write('\n');
    console.log('2FA required — check your email for a 6-digit code.');
    const code6 = await promptVisible('Enter 6-digit code: ');
    if (!/^\d{6}$/.test(code6.trim())) throw new Error('Invalid code — must be exactly 6 digits.');

    const otpBody = new URLSearchParams({
      action: 'submit', flowName: 'doLogIn', emailCode: code6.trim(),
    }).toString();
    const r3 = await httpPost(otpAction, otpBody, cookies2);

    if (r3.status === 302 && r3.headers['location']?.startsWith('hubspace-app://')) {
      return exchangeCode(extractCode(r3.headers['location']), verifier);
    }

    if (r3.status === 200 && isOtpPage(r3.body)) {
      throw new Error('Incorrect or expired code. Check your email and try again.');
    }

    throw new Error(`Unexpected response (HTTP ${r3.status}) after 2FA.`);
  }

  if (r2.body?.includes('Invalid username or password') || r2.body?.includes('login-error')) {
    throw new Error('Invalid username or password.');
  }

  throw new Error(`Unexpected response from Hubspace (HTTP ${r2.status}).`);
}

async function getAccountId(token) {
  const res = await fetch(USERS_ME_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Dart/2.18 (dart:io)',
    },
  });
  if (!res.ok) throw new Error(`users/me failed: ${res.status}`);
  const data = await res.json();
  return data.accountAccess[0].account.accountId;
}

async function getDevices(token, accountId) {
  const res = await fetch(`${SEMANTICS_BASE}/accounts/${accountId}/metadevices?expansions=state`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Dart/2.18 (dart:io)',
      'host': 'semantics2.afero.net',
      'accept-encoding': 'identity',
    },
  });
  if (!res.ok) throw new Error(`metadevices failed: ${res.status}`);
  return res.json();
}

const PRIVATE_FIELDS = new Set([
  'geo-coordinates', 'wifi-ssid', 'wifi-mac-address', 'ble-mac-address',
]);

(async () => {
  console.log('Hubspace Device Capability Dumper');
  console.log('----------------------------------\n');

  const username = process.env.HUBSPACE_EMAIL || await promptVisible('Hubspace email: ');
  const password = process.env.HUBSPACE_PASS || await promptPassword('Hubspace password (type then press Enter, nothing will show): ');

  process.stdout.write('\nAuthenticating...');
  const token = await getToken(username, password);
  process.stdout.write(' done\n');
  const accountId = await getAccountId(token);
  console.log();

  const raw = await getDevices(token, accountId);
  const devices = raw.filter(d => d.typeId === 'metadevice.device' && d.description?.device?.deviceClass);

  console.log('========= COPY FROM HERE =========\n');
  console.log(`Found ${devices.length} device(s):\n`);

  for (const d of devices) {
    const desc = d.description?.device ?? {};
    const values = d.state?.values ?? [];
    const caps = [...new Set(values.map(v => v.functionClass))].join(', ') || 'none';

    console.log(`--- ${d.friendlyName || desc.defaultName || d.id}`);
    console.log(`    deviceClass  : ${desc.deviceClass}`);
    console.log(`    hardware     : ${[desc.manufacturerName, desc.model].filter(Boolean).join(' / ') || 'unknown'}`);
    console.log(`    capabilities : ${caps}`);
    console.log(`    values:`);
    for (const v of values) {
      if (PRIVATE_FIELDS.has(v.functionClass)) {
        console.log(`      ${v.functionClass}[${v.functionInstance ?? 'default'}] = [redacted]`);
        continue;
      }
      const val = typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value ?? '');
      console.log(`      ${v.functionClass}[${v.functionInstance ?? 'default'}] = ${val}`);
    }
    console.log();
  }

  console.log('-- Paste the output above into your GitHub issue --');
})().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});

