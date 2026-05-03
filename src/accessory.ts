import {
  PlatformAccessory,
  Service,
  CharacteristicValue,
  Logger,
} from 'homebridge';
import type { HubspacePlatform } from './platform';
import { HubspaceDevice, DeviceStateValue, FC, HubspaceAccessoryContext } from './types';

// ─── Color utilities ──────────────────────────────────────────────────────────

/** HSV → RGB. h: 0–360, s: 0–100, v: 0–100. Returns [r, g, b] each 0–255. */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
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
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
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

/** Kelvin → HomeKit mireds (clamped 140–500). */
function kelvinToMired(k: number): number {
  return Math.min(500, Math.max(140, Math.round(1_000_000 / k)));
}

/** HomeKit mireds → Kelvin. */
function miredToKelvin(m: number): number {
  return Math.round(1_000_000 / m);
}

// ─── Fan-speed utilities ──────────────────────────────────────────────────────

const NAMED_SPEED_TO_PERCENT: Record<string, number> = {
  'low': 25,
  'medium-low': 40,
  'medium': 55,
  'medium-high': 75,
  'high': 100,
  'comfort-breeze': 55,
};

/** Convert a Hubspace fan-speed value to a HomeKit rotation-speed percentage. */
function hubspeedToPercent(value: string): number {
  const lower = value.toLowerCase();
  if (NAMED_SPEED_TO_PERCENT[lower] !== undefined) {
    return NAMED_SPEED_TO_PERCENT[lower];
  }
  const n = parseInt(value, 10);
  if (!isNaN(n)) {
    if (n >= 0 && n <= 100) return n;        // already a percentage
    if (n >= 1 && n <= 6) return Math.round((n / 6) * 100);
    if (n >= 1 && n <= 4) return Math.round((n / 4) * 100);
  }
  return 50;
}

/**
 * Convert a HomeKit rotation-speed percentage back to the same format the
 * device originally reported (named strings or numeric).
 */
function percentToHubspeed(percent: number, currentValue: string): string {
  const lower = currentValue.toLowerCase();
  // If the device uses named speeds, quantize into named buckets.
  if (NAMED_SPEED_TO_PERCENT[lower] !== undefined) {
    if (percent <= 25) return 'low';
    if (percent <= 40) return 'medium-low';
    if (percent <= 55) return 'medium';
    if (percent <= 75) return 'medium-high';
    return 'high';
  }
  const n = parseInt(currentValue, 10);
  if (!isNaN(n)) {
    if (n >= 1 && n <= 6) return Math.round((percent / 100) * 6).toString();
    if (n >= 1 && n <= 4) return Math.round((percent / 100) * 4).toString();
  }
  return Math.round(percent).toString();
}

// ─── Base accessory ───────────────────────────────────────────────────────────

export abstract class BaseHubspaceAccessory {
  protected readonly log: Logger;
  /** Map key: `functionClass:functionInstance` → latest value object. */
  protected stateMap: Map<string, DeviceStateValue> = new Map();

  constructor(
    protected readonly platform: HubspacePlatform,
    protected readonly accessory: PlatformAccessory,
    protected device: HubspaceDevice,
  ) {
    this.log = platform.log;
    this.rebuildStateMap(device.values);
    this.setupAccessoryInfo();
    this.setupServices();
  }

  // ── Info service ─────────────────────────────────────────────────────────────

  private setupAccessoryInfo(): void {
    const info = this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?? this.accessory.addService(this.platform.Service.AccessoryInformation);

    info
      .setCharacteristic(this.platform.Characteristic.Manufacturer,
        this.device.manufacturerName ?? 'Hubspace')
      .setCharacteristic(this.platform.Characteristic.Model,
        this.device.model ?? this.device.typeId)
      .setCharacteristic(this.platform.Characteristic.SerialNumber,
        this.device.id)
      .setCharacteristic(this.platform.Characteristic.Name,
        this.device.friendlyName);
  }

  // ── State map ─────────────────────────────────────────────────────────────────

  protected rebuildStateMap(values: DeviceStateValue[]): void {
    this.stateMap.clear();
    for (const v of values) {
      this.stateMap.set(`${v.functionClass}:${v.functionInstance}`, v);
    }
  }

  /** Find the first DeviceStateValue whose functionClass matches. */
  protected findValue(
    functionClass: string,
    functionInstance?: string,
  ): DeviceStateValue | undefined {
    for (const [, v] of this.stateMap) {
      if (v.functionClass !== functionClass) continue;
      if (functionInstance !== undefined && v.functionInstance !== functionInstance) continue;
      return v;
    }
    return undefined;
  }

  // ── Polling update ────────────────────────────────────────────────────────────

  /** Called by the platform on each poll cycle with fresh state data. */
  updateState(values: DeviceStateValue[]): void {
    this.rebuildStateMap(values);
    this.log.debug(
      `[Hubspace] State for "${this.device.friendlyName}": ` +
      values.map(v => `${v.functionClass}[${v.functionInstance}]=${v.value}`).join(', '),
    );
    this.pushCharacteristics();
  }

  // ── Abstract interface ────────────────────────────────────────────────────────

  protected abstract setupServices(): void;

  /** Push the latest cached state into HomeKit characteristics. */
  protected abstract pushCharacteristics(): void;

  // ── Helpers ───────────────────────────────────────────────────────────────────

  protected async setDeviceValues(
    values: Partial<DeviceStateValue>[],
  ): Promise<void> {
    try {
      await this.platform.client.setDeviceState(this.device.id, values);
    } catch (err) {
      this.log.error(
        `[Hubspace] Failed to set state for "${this.device.friendlyName}":`, err,
      );
      // Don't throw — let polling reconcile the state.
    }
  }

  /** Build a minimal state patch using the existing functionInstance. */
  protected buildPatch(
    functionClass: string,
    value: string | number,
    functionInstance?: string,
  ): Partial<DeviceStateValue> {
    const existing = this.findValue(functionClass, functionInstance);
    return {
      functionClass,
      functionInstance: existing?.functionInstance ?? functionInstance ?? 'primary',
      value,
    };
  }
}

// ─── Light accessory ──────────────────────────────────────────────────────────

export class LightAccessory extends BaseHubspaceAccessory {
  declare private svc: Service;
  /** Tracks the last HomeKit hue value so we can combine with saturation. */
  private pendingHue: number | null = null;
  private pendingSat: number | null = null;

  protected setupServices(): void {
    this.svc =
      this.accessory.getService(this.platform.Service.Lightbulb) ??
      this.accessory.addService(this.platform.Service.Lightbulb, this.device.friendlyName);

    // Power (always present).
    this.svc.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.getPower())
      .onSet(async (v) => this.setPower(v as boolean));

    // Brightness.
    if (this.findValue(FC.BRIGHTNESS)) {
      this.svc.getCharacteristic(this.platform.Characteristic.Brightness)
        .onGet(() => this.getBrightness())
        .onSet(async (v) => this.setBrightness(v as number));
    }

    // Color temperature.
    if (this.findValue(FC.COLOR_TEMP)) {
      const minK = 2700, maxK = 6500;
      this.svc.getCharacteristic(this.platform.Characteristic.ColorTemperature)
        .setProps({ minValue: kelvinToMired(maxK), maxValue: kelvinToMired(minK) })
        .onGet(() => this.getColorTemp())
        .onSet(async (v) => this.setColorTemp(v as number));
    }

    // RGB color (Hue + Saturation).
    if (this.findValue(FC.COLOR_RGB)) {
      this.svc.getCharacteristic(this.platform.Characteristic.Hue)
        .onGet(() => this.getHue())
        .onSet(async (v) => this.setPendingHue(v as number));

      this.svc.getCharacteristic(this.platform.Characteristic.Saturation)
        .onGet(() => this.getSaturation())
        .onSet(async (v) => this.setPendingSat(v as number));
    }
  }

  // ── Getters ───────────────────────────────────────────────────────────────────

  private getPower(): CharacteristicValue {
    const v = this.findValue(FC.POWER);
    return v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
  }

  private getBrightness(): CharacteristicValue {
    const v = this.findValue(FC.BRIGHTNESS);
    return v ? Math.round(Number(v.value)) : 100;
  }

  private getColorTemp(): CharacteristicValue {
    const v = this.findValue(FC.COLOR_TEMP);
    return v ? kelvinToMired(Number(v.value)) : 370; // 2702 K default
  }

  private getHue(): CharacteristicValue {
    const v = this.findValue(FC.COLOR_RGB);
    if (!v) return 0;
    const [r, g, b] = hexToRgb(String(v.value));
    return rgbToHsv(r, g, b)[0];
  }

  private getSaturation(): CharacteristicValue {
    const v = this.findValue(FC.COLOR_RGB);
    if (!v) return 0;
    const [r, g, b] = hexToRgb(String(v.value));
    return rgbToHsv(r, g, b)[1];
  }

  // ── Setters ───────────────────────────────────────────────────────────────────

  private async setPower(on: boolean): Promise<void> {
    await this.setDeviceValues([this.buildPatch(FC.POWER, on ? 'on' : 'off')]);
  }

  private async setBrightness(value: number): Promise<void> {
    await this.setDeviceValues([this.buildPatch(FC.BRIGHTNESS, Math.round(value).toString())]);
  }

  private async setColorTemp(mireds: number): Promise<void> {
    const k = miredToKelvin(mireds);
    const patches: Partial<DeviceStateValue>[] = [
      this.buildPatch(FC.COLOR_TEMP, k.toString()),
    ];
    // Switch to white mode if device supports color-mode.
    if (this.findValue(FC.COLOR_MODE)) {
      patches.push(this.buildPatch(FC.COLOR_MODE, 'white'));
    }
    await this.setDeviceValues(patches);
  }

  private async setPendingHue(h: number): Promise<void> {
    this.pendingHue = h;
    await this.flushColor();
  }

  private async setPendingSat(s: number): Promise<void> {
    this.pendingSat = s;
    await this.flushColor();
  }

  /** Debounce hue + saturation into a single RGB set call. */
  private flushColorTimer: ReturnType<typeof setTimeout> | null = null;

  private async flushColor(): Promise<void> {
    if (this.flushColorTimer) clearTimeout(this.flushColorTimer);
    this.flushColorTimer = setTimeout(async () => {
      const h = this.pendingHue ?? this.getHue() as number;
      const s = this.pendingSat ?? this.getSaturation() as number;
      const brightness = this.getBrightness() as number;
      const [r, g, b] = hsvToRgb(h, s, brightness);
      const hex = rgbToHex(r, g, b);

      const patches: Partial<DeviceStateValue>[] = [
        this.buildPatch(FC.COLOR_RGB, hex),
      ];
      if (this.findValue(FC.COLOR_MODE)) {
        patches.push(this.buildPatch(FC.COLOR_MODE, 'color'));
      }
      await this.setDeviceValues(patches);
      this.pendingHue = null;
      this.pendingSat = null;
    }, 50);
  }

  // ── Push ──────────────────────────────────────────────────────────────────────

  protected pushCharacteristics(): void {
    this.svc.updateCharacteristic(this.platform.Characteristic.On, this.getPower());

    if (this.findValue(FC.BRIGHTNESS)) {
      this.svc.updateCharacteristic(
        this.platform.Characteristic.Brightness, this.getBrightness());
    }
    if (this.findValue(FC.COLOR_TEMP)) {
      this.svc.updateCharacteristic(
        this.platform.Characteristic.ColorTemperature, this.getColorTemp());
    }
    if (this.findValue(FC.COLOR_RGB)) {
      this.svc.updateCharacteristic(this.platform.Characteristic.Hue, this.getHue());
      this.svc.updateCharacteristic(
        this.platform.Characteristic.Saturation, this.getSaturation());
    }
  }
}

// ─── Fan accessory (fan + optional light kit) ─────────────────────────────────

export class FanAccessory extends BaseHubspaceAccessory {
  declare private fanSvc: Service;
  declare private lightSvc: Service | null;

  protected setupServices(): void {
    this.lightSvc = null;

    // ── Fan service ───────────────────────────────────────────────────────────
    this.fanSvc =
      this.accessory.getService(this.platform.Service.Fanv2) ??
      this.accessory.addService(this.platform.Service.Fanv2, this.device.friendlyName);

    // Active (fan power — use functionInstance that is NOT "light-power").
    const fanPower = this.findFanPowerValue();
    this.fanSvc.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() => this.getFanActive())
      .onSet(async (v) => this.setFanActive(v as number, fanPower?.functionInstance));

    // Rotation speed.
    if (this.findValue(FC.FAN_SPEED)) {
      this.fanSvc.getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .onGet(() => this.getFanSpeed())
        .onSet(async (v) => this.setFanSpeed(v as number));
    }

    // Rotation direction.
    if (this.findValue(FC.FAN_REVERSE)) {
      this.fanSvc.getCharacteristic(this.platform.Characteristic.RotationDirection)
        .onGet(() => this.getFanDirection())
        .onSet(async (v) => this.setFanDirection(v as number));
    }

    // ── Optional light kit service ────────────────────────────────────────────
    const lightPower = this.findValue(FC.POWER, 'light-power');
    const hasBrightness = this.findValue(FC.BRIGHTNESS) !== undefined;
    if (lightPower) {
      this.lightSvc =
        this.accessory.getService(this.platform.Service.Lightbulb) ??
        this.accessory.addService(
          this.platform.Service.Lightbulb,
          `${this.device.friendlyName} Light`,
        );

      this.lightSvc.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.getLightPower())
        .onSet(async (v) => this.setLightPower(v as boolean));

      if (hasBrightness) {
        this.lightSvc.getCharacteristic(this.platform.Characteristic.Brightness)
          .onGet(() => this.getLightBrightness())
          .onSet(async (v) => this.setLightBrightness(v as number));
      }
    }
  }

  // ── Fan getters / setters ─────────────────────────────────────────────────────

  private findFanPowerValue(): DeviceStateValue | undefined {
    // Prefer explicit fan-power instance; fall back to any power value.
    return (
      this.findValue(FC.POWER, 'fan-power') ??
      this.findValue(FC.POWER, 'primary') ??
      this.findValue(FC.POWER)
    );
  }

  private getFanActive(): CharacteristicValue {
    const v = this.findFanPowerValue();
    const on = v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
    return on
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  private async setFanActive(
    hkActive: number,
    instance: string | undefined,
  ): Promise<void> {
    const on = hkActive === this.platform.Characteristic.Active.ACTIVE;
    await this.setDeviceValues([
      this.buildPatch(FC.POWER, on ? 'on' : 'off', instance),
    ]);
  }

  private getFanSpeed(): CharacteristicValue {
    const v = this.findValue(FC.FAN_SPEED);
    return v ? hubspeedToPercent(String(v.value)) : 50;
  }

  private async setFanSpeed(percent: number): Promise<void> {
    const current = this.findValue(FC.FAN_SPEED);
    const raw = percentToHubspeed(percent, String(current?.value ?? 'low'));
    await this.setDeviceValues([this.buildPatch(FC.FAN_SPEED, raw)]);
  }

  private getFanDirection(): CharacteristicValue {
    const v = this.findValue(FC.FAN_REVERSE);
    // Hubspace "reverse" → winter mode (clockwise from below) → HomeKit CLOCKWISE.
    const reversed = v?.value === 'reverse' || v?.value === 'true' || v?.value === true;
    return reversed
      ? this.platform.Characteristic.RotationDirection.CLOCKWISE
      : this.platform.Characteristic.RotationDirection.COUNTER_CLOCKWISE;
  }

  private async setFanDirection(hkDir: number): Promise<void> {
    const reversed =
      hkDir === this.platform.Characteristic.RotationDirection.CLOCKWISE;
    await this.setDeviceValues([
      this.buildPatch(FC.FAN_REVERSE, reversed ? 'reverse' : 'forward'),
    ]);
  }

  // ── Light-kit getters / setters ───────────────────────────────────────────────

  private getLightPower(): CharacteristicValue {
    const v = this.findValue(FC.POWER, 'light-power');
    return v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
  }

  private async setLightPower(on: boolean): Promise<void> {
    await this.setDeviceValues([
      this.buildPatch(FC.POWER, on ? 'on' : 'off', 'light-power'),
    ]);
  }

  private getLightBrightness(): CharacteristicValue {
    const v = this.findValue(FC.BRIGHTNESS, 'light-brightness') ?? this.findValue(FC.BRIGHTNESS);
    return v ? Math.round(Number(v.value)) : 100;
  }

  private async setLightBrightness(value: number): Promise<void> {
    const current = this.findValue(FC.BRIGHTNESS, 'light-brightness') ?? this.findValue(FC.BRIGHTNESS);
    await this.setDeviceValues([
      this.buildPatch(FC.BRIGHTNESS, Math.round(value).toString(), current?.functionInstance),
    ]);
  }

  // ── Push ──────────────────────────────────────────────────────────────────────

  protected pushCharacteristics(): void {
    this.fanSvc.updateCharacteristic(
      this.platform.Characteristic.Active, this.getFanActive());

    if (this.findValue(FC.FAN_SPEED)) {
      this.fanSvc.updateCharacteristic(
        this.platform.Characteristic.RotationSpeed, this.getFanSpeed());
    }
    if (this.findValue(FC.FAN_REVERSE)) {
      this.fanSvc.updateCharacteristic(
        this.platform.Characteristic.RotationDirection, this.getFanDirection());
    }

    if (this.lightSvc) {
      this.lightSvc.updateCharacteristic(
        this.platform.Characteristic.On, this.getLightPower());
      if (this.findValue(FC.BRIGHTNESS)) {
        this.lightSvc.updateCharacteristic(
          this.platform.Characteristic.Brightness, this.getLightBrightness());
      }
    }
  }
}

// ─── Outlet / switch / plug accessory ────────────────────────────────────────

export class OutletAccessory extends BaseHubspaceAccessory {
  declare private svc: Service;

  protected setupServices(): void {
    const useOutletService = ['outlet', 'plug'].includes(
      this.device.deviceClass.toLowerCase(),
    );

    const ServiceType = useOutletService
      ? this.platform.Service.Outlet
      : this.platform.Service.Switch;

    this.svc =
      this.accessory.getService(ServiceType) ??
      this.accessory.addService(ServiceType, this.device.friendlyName);

    this.svc.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.getPower())
      .onSet(async (v) => this.setPower(v as boolean));

    // OutletInUse is required for the Outlet service (true whenever powered on).
    if (useOutletService) {
      this.svc.getCharacteristic(this.platform.Characteristic.OutletInUse)
        .onGet(() => this.getPower());
    }
  }

  private getPower(): CharacteristicValue {
    const v = this.findValue(FC.POWER);
    return v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
  }

  private async setPower(on: boolean): Promise<void> {
    await this.setDeviceValues([this.buildPatch(FC.POWER, on ? 'on' : 'off')]);
  }

  protected pushCharacteristics(): void {
    this.svc.updateCharacteristic(this.platform.Characteristic.On, this.getPower());
    if (this.svc.getCharacteristic(this.platform.Characteristic.OutletInUse)) {
      this.svc.updateCharacteristic(
        this.platform.Characteristic.OutletInUse, this.getPower());
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Returns the correct accessory class for a given Hubspace device, or null if
 * the device is not yet supported.
 */
export function createAccessory(
  platform: HubspacePlatform,
  pAccessory: PlatformAccessory,
  device: HubspaceDevice,
): BaseHubspaceAccessory | null {
  const cls = device.deviceClass.toLowerCase();

  if (cls === 'light') {
    return new LightAccessory(platform, pAccessory, device);
  }

  if (cls === 'fan' || cls === 'ceiling-fan') {
    return new FanAccessory(platform, pAccessory, device);
  }

  if (cls === 'outlet' || cls === 'switch' || cls === 'plug') {
    return new OutletAccessory(platform, pAccessory, device);
  }

  platform.log.warn(
    `[Hubspace] Unsupported deviceClass "${device.deviceClass}" for "${device.friendlyName}" — skipping.`,
  );
  return null;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').padStart(6, '0');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return [r, g, b]
    .map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0'))
    .join('');
}

// Re-export context type for platform use.
export type { HubspaceAccessoryContext };
