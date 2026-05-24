/**
 * Standalone dump script — lists every Hubspace device on the account with
 * its full capability set. Useful for reverse-engineering new device types.
 *
 * Usage:
 *   npm run build && USERNAME=you@email.com PASSWORD=secret node dist/dump-devices.js
 */

import { HubspaceClient } from './hubspace-client';
import type { Logger } from 'homebridge';
import * as os from 'os';

const username = process.env.USERNAME;
const password = process.env.PASSWORD;

if (!username || !password) {
  console.error('Usage: USERNAME=<email> PASSWORD=<password> node dist/dump-devices.js');
  process.exit(1);
}

const log: Logger = {
  info:    (msg: string, ...a: unknown[]) => console.log('[info]', msg, ...a),
  warn:    (msg: string, ...a: unknown[]) => console.warn('[warn]', msg, ...a),
  error:   (msg: string, ...a: unknown[]) => console.error('[error]', msg, ...a),
  debug:   (msg: string, ...a: unknown[]) => {},
  success: (msg: string, ...a: unknown[]) => console.log('[ok]', msg, ...a),
  log:     (level: string, msg: string, ...a: unknown[]) => console.log(`[${level}]`, msg, ...a),
  prefix:  'dump',
};

(async () => {
  const client = new HubspaceClient(username, password, os.tmpdir(), log, { debug: false });
  const devices = await client.getDevices();

  console.log(`\nFound ${devices.length} device(s):\n`);

  for (const d of devices) {
    console.log(`━━━ ${d.friendlyName}`);
    console.log(`    deviceClass : ${d.deviceClass}`);
    console.log(`    typeId      : ${d.typeId}`);
    console.log(`    id          : ${d.id}`);
    if (d.manufacturerName || d.model) {
      console.log(`    hardware    : ${[d.manufacturerName, d.model].filter(Boolean).join(' / ')}`);
    }
    console.log(`    capabilities:`);
    for (const v of d.values) {
      const val = typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value);
      console.log(`      ${v.functionClass}[${v.functionInstance ?? 'default'}] = ${val}`);
    }
    console.log();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
