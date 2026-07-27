import type { Logger } from 'homebridge';
import type { DeviceStateValue } from './types';
export declare function createLogger(base: Logger, prefix: string): Logger;
export declare function formatStateValueForLog(v: DeviceStateValue): string;
export declare function hsvToRgb(h: number, s: number, v: number): [number, number, number];
export declare function rgbToHsv(r: number, g: number, b: number): [number, number, number];
export declare function hexToRgb(hex: string): [number, number, number];
export declare function parseColorRgb(value: unknown): [number, number, number];
export declare function rgbToHex(r: number, g: number, b: number): string;
export declare function kelvinToMired(k: number): number;
export declare function parseKelvin(value: unknown): number | null;
export declare function formatKelvinForHubspace(kelvin: number, currentValue: unknown): string | number;
export declare function miredToKelvin(m: number): number;
export declare function hubspeedToPercent(value: string): number;
export declare function percentToHubspeed(percent: number, currentValue: string): string;
//# sourceMappingURL=utils.d.ts.map