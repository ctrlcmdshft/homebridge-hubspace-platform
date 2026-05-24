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
 * Or one-liner (no download):
 *   node -e "$(curl -fsSL https://raw.githubusercontent.com/ctrlcmdshft/homebridge-hubspace-platform/main/scripts/dump-devices.js)"
 */

'use strict';

const readline = require('readline');
const fs = require('fs');

const AUTH_URL = 'https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token';
const USERS_ME_URL = 'https://api2.afero.net/v1/users/me';
const SEMANTICS_BASE = 'https://semantics2.afero.net/v1';

// Open /dev/tty directly so prompts work even when run via `node -e "$(curl ...)"`
// where process.stdin may not be attached as a TTY. Falls back to stdin/stdout.
function openTty() {
  try {
    const fd = fs.openSync('/dev/tty', 'r+');
    return {
      input: fs.createReadStream(null, { fd, autoClose: false }),
      output: fs.createWriteStream(null, { fd, autoClose: false }),
      fd,
    };
  } catch {
    return { input: process.stdin, output: process.stdout, fd: null };
  }
}

async function promptVisible(label) {
  const tty = openTty();
  const rl = readline.createInterface({ input: tty.input, output: tty.output, terminal: true });
  return new Promise(resolve => {
    rl.question(label, answer => {
      rl.close();
      if (tty.fd !== null) fs.closeSync(tty.fd);
      resolve(answer.trim());
    });
  });
}

async function promptPassword(label) {
  const tty = openTty();
  const rl = readline.createInterface({ input: tty.input, output: tty.output, terminal: true });
  rl._writeToOutput = () => {};
  tty.output.write(label);
  return new Promise(resolve => {
    rl.question('', answer => {
      rl.close();
      tty.output.write('\n');
      if (tty.fd !== null) fs.closeSync(tty.fd);
      resolve(answer.trim());
    });
  });
}

async function getToken(username, password) {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'hubspace_android',
    username,
    password,
  });
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.access_token;
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

  const username = process.env.USERNAME || await promptVisible('Hubspace email: ');
  const password = process.env.PASSWORD || await promptPassword('Hubspace password (hidden): ');

  process.stdout.write('\nAuthenticating...');
  const token = await getToken(username, password);
  const accountId = await getAccountId(token);
  console.log(' done\n');

  const raw = await getDevices(token, accountId);
  const devices = raw.filter(d => d.typeId === 'metadevice.device' && d.description?.device?.deviceClass);

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
