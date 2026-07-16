import type { Logger } from 'homebridge';
import type { DeviceStateValue } from './types';

/** Wraps a Homebridge Logger and prepends [prefix] to info/warn/error messages. */
export function createLogger(base: Logger, prefix: string): Logger {
  const tag = `[${prefix}]`;
  const wrapped = Object.create(base) as Logger;
  wrapped.info  = (msg: string, ...a: unknown[]) => base.info(`${tag} ${msg}`, ...a);
  wrapped.warn  = (msg: string, ...a: unknown[]) => base.warn(`${tag} ${msg}`, ...a);
  wrapped.error = (msg: string, ...a: unknown[]) => base.error(`${tag} ${msg}`, ...a);
  return wrapped;
}

const PRIVATE_STATE_FIELDS = new Set([
  'geo-coordinates',
  'wifi-ssid',
  'wifi-mac-address',
  'ble-mac-address',
]);

export function formatStateValueForLog(v: DeviceStateValue): string {
  const instance = v.functionInstance ?? 'undefined';
  const isPrivate = PRIVATE_STATE_FIELDS.has(v.functionClass);
  const value = isPrivate
    ? '<redacted>'
    : typeof v.value === 'object'
      ? JSON.stringify(v.value)
      : String(v.value);
  return `${v.functionClass}[${instance}]=${value}`;
}

/** HSV → RGB. h: 0–360, s: 0–100, v: 0–100. Returns [r, g, b] each 0–255. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  s /= 100;
  v /= 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/** RGB → HSV. Each 0–255. Returns [h 0–360, s 0–100, v 0–100]. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(v * 100)];
}

/** Hex string → [r, g, b] each 0–255. */
export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').padStart(6, '0');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

/**
 * Parse a color-rgb API value into [r, g, b] each 0–255.
 * The Hubspace API returns objects of the form {"color-rgb":{"r":N,"g":N,"b":N}};
 * older devices may return a plain hex string.
 */
export function parseColorRgb(value: unknown): [number, number, number] {
  if (typeof value === 'string') return hexToRgb(value);
  if (value !== null && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)['color-rgb'];
    const obj = (inner !== undefined && typeof inner === 'object' ? inner : value) as Record<string, unknown>;
    const r = Number(obj['r'] ?? 0);
    const g = Number(obj['g'] ?? 0);
    const b = Number(obj['b'] ?? 0);
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r, g, b];
  }
  return [0, 0, 0];
}

/** [r, g, b] each 0–255 → lowercase hex string (no #). */
export function rgbToHex(r: number, g: number, b: number): string {
  return [r, g, b]
    .map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0'))
    .join('');
}

/** Kelvin → HomeKit mireds (clamped 140–500). */
export function kelvinToMired(k: number): number {
  return Math.min(500, Math.max(140, Math.round(1_000_000 / k)));
}

/** Parse Hubspace color-temperature values such as 4000, "4000", or "4000K". */
export function parseKelvin(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*k?$/i);
  if (!match) return null;
  const kelvin = Number(match[1]);
  return Number.isFinite(kelvin) ? kelvin : null;
}

/** Format a Kelvin write to match the device's current Hubspace value shape. */
export function formatKelvinForHubspace(kelvin: number, currentValue: unknown): string | number {
  if (typeof currentValue === 'number') return kelvin;
  if (typeof currentValue === 'string' && /k\s*$/i.test(currentValue.trim())) return `${kelvin}K`;
  return kelvin.toString();
}

/** HomeKit mireds → Kelvin. */
export function miredToKelvin(m: number): number {
  return Math.round(1_000_000 / m);
}

// ─── Fan-speed utilities ──────────────────────────────────────────────────────

/** Semantic fan-speed value names used by the Afero semantics2 API. */
const SEMANTIC_SPEED_TO_PERCENT: Record<string, number> = {
  'fan-speed-000': 0,
  'fan-speed-025': 25,
  'fan-speed-050': 50,
  'fan-speed-075': 75,
  'fan-speed-100': 100,
  // Portable AC 3-speed semantic values (matches percentToHubspeed's dedicated branch).
  'fan-speed-auto': 33,
  'fan-speed-low': 66,
  'fan-speed-high': 99,
  // Legacy named-speed fallbacks for older device profiles.
  'low': 25,
  'medium-low': 40,
  'medium': 55,
  'medium-high': 75,
  'high': 100,
  'comfort-breeze': 55,
};

/** Parse a `fan-speed-N-VVV` value. Returns { numSpeeds, speedValue } or null. */
function parseNSpeedValue(lower: string): { numSpeeds: number; speedValue: number } | null {
  const m = lower.match(/^fan-speed-(\d+)-(\d+)$/);
  if (!m) return null;
  return { numSpeeds: parseInt(m[1], 10), speedValue: parseInt(m[2], 10) };
}

/** Convert a Hubspace fan-speed value to a HomeKit rotation-speed percentage. */
export function hubspeedToPercent(value: string): number {
  const lower = value.toLowerCase();
  if (SEMANTIC_SPEED_TO_PERCENT[lower] !== undefined) {
    return SEMANTIC_SPEED_TO_PERCENT[lower];
  }
  // N-speed numeric format: fan-speed-6-016, fan-speed-4-025, etc.
  const nSpeed = parseNSpeedValue(lower);
  if (nSpeed) return nSpeed.speedValue;
  const n = parseInt(value, 10);
  if (!isNaN(n) && n >= 0 && n <= 100) return n;
  return 50;
}

/** Convert a HomeKit rotation-speed percentage to the Afero semantic value name. */
export function percentToHubspeed(percent: number, currentValue: string): string {
  const lower = currentValue.toLowerCase();

  // Portable AC 3-speed semantic format (checked before the generic
  // "starts with fan-speed-" numeric branch below, which would otherwise
  // wrongly rewrite these into the fixed 4-step numeric format).
  if (lower === 'fan-speed-auto' || lower === 'fan-speed-low' || lower === 'fan-speed-high') {
    if (percent <= 33) return 'fan-speed-auto';
    if (percent <= 66) return 'fan-speed-low';
    return 'fan-speed-high';
  }

  // N-speed numeric format: fan-speed-6-016, fan-speed-4-025, etc.
  // The device self-describes its speed count; we snap to the nearest valid step.
  const nSpeed = parseNSpeedValue(lower);
  if (nSpeed) {
    const { numSpeeds } = nSpeed;
    if (numSpeeds === 3) {
      const steps = [33, 66, 100];
      const v = steps.reduce((best, step) =>
        Math.abs(step - percent) < Math.abs(best - percent) ? step : best);
      return `fan-speed-3-${v.toString().padStart(3, '0')}`;
    }
    let bestI = 0, bestDist = Infinity;
    for (let i = 0; i <= numSpeeds; i++) {
      const dist = Math.abs(Math.floor(i * 100 / numSpeeds) - percent);
      if (dist < bestDist) { bestDist = dist; bestI = i; }
    }
    const v = Math.floor(bestI * 100 / numSpeeds);
    return `fan-speed-${numSpeeds}-${v.toString().padStart(3, '0')}`;
  }

  // Legacy fixed 4-step format: fan-speed-025, fan-speed-050, etc.
  if (lower.startsWith('fan-speed-')) {
    if (percent <= 0)  return 'fan-speed-000';
    if (percent <= 25) return 'fan-speed-025';
    if (percent <= 50) return 'fan-speed-050';
    if (percent <= 75) return 'fan-speed-075';
    return 'fan-speed-100';
  }

  // Legacy named speeds.
  if (SEMANTIC_SPEED_TO_PERCENT[lower] !== undefined) {
    if (percent <= 25) return 'low';
    if (percent <= 40) return 'medium-low';
    if (percent <= 55) return 'medium';
    if (percent <= 75) return 'medium-high';
    return 'high';
  }

  return Math.round(percent).toString();
}
