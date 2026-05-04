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
  // Legacy named-speed fallbacks for older device profiles.
  'low': 25,
  'medium-low': 40,
  'medium': 55,
  'medium-high': 75,
  'high': 100,
  'comfort-breeze': 55,
};

/** Convert a Hubspace fan-speed value to a HomeKit rotation-speed percentage. */
export function hubspeedToPercent(value: string): number {
  const lower = value.toLowerCase();
  if (SEMANTIC_SPEED_TO_PERCENT[lower] !== undefined) {
    return SEMANTIC_SPEED_TO_PERCENT[lower];
  }
  const n = parseInt(value, 10);
  if (!isNaN(n) && n >= 0 && n <= 100) return n;
  return 50;
}

/** Convert a HomeKit rotation-speed percentage to the Afero semantic value name. */
export function percentToHubspeed(percent: number, currentValue: string): string {
  const lower = currentValue.toLowerCase();

  // If device uses semantic speed names, map to the nearest named value.
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
