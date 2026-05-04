import {
  hsvToRgb,
  rgbToHsv,
  hexToRgb,
  rgbToHex,
  kelvinToMired,
  miredToKelvin,
  hubspeedToPercent,
  percentToHubspeed,
} from '../src/utils';

// ─── Color: hsvToRgb ──────────────────────────────────────────────────────────

describe('hsvToRgb', () => {
  it('converts pure red', () => {
    expect(hsvToRgb(0, 100, 100)).toEqual([255, 0, 0]);
  });

  it('converts pure green', () => {
    expect(hsvToRgb(120, 100, 100)).toEqual([0, 255, 0]);
  });

  it('converts pure blue', () => {
    expect(hsvToRgb(240, 100, 100)).toEqual([0, 0, 255]);
  });

  it('converts white (s=0)', () => {
    expect(hsvToRgb(0, 0, 100)).toEqual([255, 255, 255]);
  });

  it('converts black (v=0)', () => {
    expect(hsvToRgb(0, 0, 0)).toEqual([0, 0, 0]);
  });

  it('converts yellow (h=60)', () => {
    expect(hsvToRgb(60, 100, 100)).toEqual([255, 255, 0]);
  });

  it('converts cyan (h=180)', () => {
    expect(hsvToRgb(180, 100, 100)).toEqual([0, 255, 255]);
  });

  it('converts magenta (h=300)', () => {
    expect(hsvToRgb(300, 100, 100)).toEqual([255, 0, 255]);
  });
});

// ─── Color: rgbToHsv ──────────────────────────────────────────────────────────

describe('rgbToHsv', () => {
  it('converts pure red', () => {
    expect(rgbToHsv(255, 0, 0)).toEqual([0, 100, 100]);
  });

  it('converts pure green', () => {
    expect(rgbToHsv(0, 255, 0)).toEqual([120, 100, 100]);
  });

  it('converts pure blue', () => {
    expect(rgbToHsv(0, 0, 255)).toEqual([240, 100, 100]);
  });

  it('converts white', () => {
    expect(rgbToHsv(255, 255, 255)).toEqual([0, 0, 100]);
  });

  it('converts black', () => {
    expect(rgbToHsv(0, 0, 0)).toEqual([0, 0, 0]);
  });
});

// ─── Color: round-trip HSV ↔ RGB ─────────────────────────────────────────────

describe('HSV ↔ RGB round-trip', () => {
  const cases: Array<[number, number, number]> = [
    [0, 100, 100],
    [120, 100, 100],
    [240, 100, 100],
    [45, 60, 80],
    [200, 30, 50],
  ];

  it.each(cases)('h=%i s=%i v=%i round-trips', (h, s, v) => {
    const [r, g, b] = hsvToRgb(h, s, v);
    const [h2, s2, v2] = rgbToHsv(r, g, b);
    expect(h2).toBeCloseTo(h, -1);
    expect(s2).toBeCloseTo(s, -1);
    expect(v2).toBeCloseTo(v, -1);
  });
});

// ─── Color: hexToRgb ─────────────────────────────────────────────────────────

describe('hexToRgb', () => {
  it('parses lowercase hex', () => {
    expect(hexToRgb('ff0000')).toEqual([255, 0, 0]);
  });

  it('parses uppercase hex', () => {
    expect(hexToRgb('00FF00')).toEqual([0, 255, 0]);
  });

  it('strips leading #', () => {
    expect(hexToRgb('#0000ff')).toEqual([0, 0, 255]);
  });

  it('pads short strings', () => {
    expect(hexToRgb('')).toEqual([0, 0, 0]);
  });

  it('parses white', () => {
    expect(hexToRgb('ffffff')).toEqual([255, 255, 255]);
  });
});

// ─── Color: rgbToHex ─────────────────────────────────────────────────────────

describe('rgbToHex', () => {
  it('converts red', () => {
    expect(rgbToHex(255, 0, 0)).toBe('ff0000');
  });

  it('converts black', () => {
    expect(rgbToHex(0, 0, 0)).toBe('000000');
  });

  it('converts white', () => {
    expect(rgbToHex(255, 255, 255)).toBe('ffffff');
  });

  it('clamps values above 255', () => {
    expect(rgbToHex(300, 0, 0)).toBe('ff0000');
  });

  it('clamps values below 0', () => {
    expect(rgbToHex(-1, 0, 0)).toBe('000000');
  });
});

// ─── Color: hex round-trip ────────────────────────────────────────────────────

describe('hex ↔ RGB round-trip', () => {
  const hexes = ['ff0000', '00ff00', '0000ff', 'ffffff', '000000', '1a2b3c'];

  it.each(hexes)('%s round-trips', (hex) => {
    const [r, g, b] = hexToRgb(hex);
    expect(rgbToHex(r, g, b)).toBe(hex);
  });
});

// ─── Color temperature ────────────────────────────────────────────────────────

describe('kelvinToMired', () => {
  it('converts 2700 K (warm white)', () => {
    expect(kelvinToMired(2700)).toBe(370);
  });

  it('converts 6500 K (cool white)', () => {
    expect(kelvinToMired(6500)).toBe(154);
  });

  it('clamps to minimum 140 for very high kelvin', () => {
    // 1_000_000 / 10000 = 100, which is below the 140 floor
    expect(kelvinToMired(10000)).toBe(140);
  });

  it('clamps high values to 500', () => {
    expect(kelvinToMired(1000)).toBe(500);
  });
});

describe('miredToKelvin', () => {
  it('converts 370 mireds → ~2703 K', () => {
    expect(miredToKelvin(370)).toBe(2703);
  });

  it('converts 154 mireds → ~6494 K', () => {
    expect(miredToKelvin(154)).toBe(6494);
  });

  it('is approximately the inverse of kelvinToMired', () => {
    const k = 3000;
    const mireds = kelvinToMired(k);
    expect(miredToKelvin(mireds)).toBeCloseTo(k, -2);
  });
});

// ─── Fan speed: hubspeedToPercent ─────────────────────────────────────────────

describe('hubspeedToPercent', () => {
  it('converts semantic speed names', () => {
    expect(hubspeedToPercent('fan-speed-000')).toBe(0);
    expect(hubspeedToPercent('fan-speed-025')).toBe(25);
    expect(hubspeedToPercent('fan-speed-050')).toBe(50);
    expect(hubspeedToPercent('fan-speed-075')).toBe(75);
    expect(hubspeedToPercent('fan-speed-100')).toBe(100);
  });

  it('is case-insensitive for semantic names', () => {
    expect(hubspeedToPercent('FAN-SPEED-050')).toBe(50);
  });

  it('converts legacy named speeds', () => {
    expect(hubspeedToPercent('low')).toBe(25);
    expect(hubspeedToPercent('medium-low')).toBe(40);
    expect(hubspeedToPercent('medium')).toBe(55);
    expect(hubspeedToPercent('medium-high')).toBe(75);
    expect(hubspeedToPercent('high')).toBe(100);
    expect(hubspeedToPercent('comfort-breeze')).toBe(55);
  });

  it('converts numeric strings', () => {
    expect(hubspeedToPercent('0')).toBe(0);
    expect(hubspeedToPercent('50')).toBe(50);
    expect(hubspeedToPercent('100')).toBe(100);
  });

  it('returns 50 for unknown values', () => {
    expect(hubspeedToPercent('turbo')).toBe(50);
    expect(hubspeedToPercent('')).toBe(50);
  });
});

// ─── Fan speed: percentToHubspeed ─────────────────────────────────────────────

describe('percentToHubspeed (semantic mode)', () => {
  const current = 'fan-speed-050';

  it('maps 0% → fan-speed-000', () => {
    expect(percentToHubspeed(0, current)).toBe('fan-speed-000');
  });

  it('maps 25% → fan-speed-025', () => {
    expect(percentToHubspeed(25, current)).toBe('fan-speed-025');
  });

  it('maps 50% → fan-speed-050', () => {
    expect(percentToHubspeed(50, current)).toBe('fan-speed-050');
  });

  it('maps 75% → fan-speed-075', () => {
    expect(percentToHubspeed(75, current)).toBe('fan-speed-075');
  });

  it('maps 100% → fan-speed-100', () => {
    expect(percentToHubspeed(100, current)).toBe('fan-speed-100');
  });

  it('rounds up to next step', () => {
    expect(percentToHubspeed(26, current)).toBe('fan-speed-050');
    expect(percentToHubspeed(76, current)).toBe('fan-speed-100');
  });
});

describe('percentToHubspeed (legacy mode)', () => {
  const current = 'low';

  it('maps 25% → low', () => {
    expect(percentToHubspeed(25, current)).toBe('low');
  });

  it('maps 40% → medium-low', () => {
    expect(percentToHubspeed(40, current)).toBe('medium-low');
  });

  it('maps 55% → medium', () => {
    expect(percentToHubspeed(55, current)).toBe('medium');
  });

  it('maps 75% → medium-high', () => {
    expect(percentToHubspeed(75, current)).toBe('medium-high');
  });

  it('maps 100% → high', () => {
    expect(percentToHubspeed(100, current)).toBe('high');
  });
});

describe('percentToHubspeed (numeric fallback)', () => {
  it('returns numeric string for unknown current value', () => {
    expect(percentToHubspeed(67, '42')).toBe('67');
  });
});
