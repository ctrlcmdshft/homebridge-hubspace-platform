import {
  PlatformAccessory,
  Service,
  CharacteristicValue,
  Logger,
} from 'homebridge';
import { isAxiosError } from 'axios';
import type { HubspacePlatform } from './platform';
import { HubspaceDevice, DeviceStateValue, FC, HubspaceAccessoryContext } from './types';
import {
  hsvToRgb,
  rgbToHsv,
  parseColorRgb,
  kelvinToMired,
  miredToKelvin,
  hubspeedToPercent,
  percentToHubspeed,
} from './utils';

// ─── Base accessory ───────────────────────────────────────────────────────────

export abstract class BaseHubspaceAccessory {
  protected readonly log: Logger;
  /** Map key: `functionClass:functionInstance` → latest value object. */
  protected stateMap: Map<string, DeviceStateValue> = new Map();

  constructor(
    protected readonly platform: HubspacePlatform,
    protected readonly accessory: PlatformAccessory,
    public device: HubspaceDevice,
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
    if (this.platform.verbose) {
      this.log.info(
        `State for "${this.device.friendlyName}": ` +
        values.map(v => `${v.functionClass}[${v.functionInstance}]=${typeof v.value === 'object' ? JSON.stringify(v.value) : v.value}`).join(', '),
      );
    }
    this.pushCharacteristics();
  }

  // ── Fault status ──────────────────────────────────────────────────────────────

  protected getStatusFault(): CharacteristicValue {
    const v = this.findValue(FC.AVAILABLE);
    if (v === undefined) return this.platform.Characteristic.StatusFault.NO_FAULT;
    return (v.value === true || v.value === 'true' || v.value === 1)
      ? this.platform.Characteristic.StatusFault.NO_FAULT
      : this.platform.Characteristic.StatusFault.GENERAL_FAULT;
  }

  // ── Abstract interface ────────────────────────────────────────────────────────

  protected abstract setupServices(): void;

  /** Push the latest cached state into HomeKit characteristics. */
  protected abstract pushCharacteristics(): void;

  // ── Helpers ───────────────────────────────────────────────────────────────────

  protected async setDeviceValues(
    values: Partial<DeviceStateValue>[],
  ): Promise<void> {
    this.applyOptimisticUpdate(values);
    try {
      await this.platform.client.setDeviceState(this.device.id, values);
      this.platform.scheduleQuickPoll(this.device.id, 3000);
    } catch (err) {
      const detail = isAxiosError(err)
        ? `HTTP ${err.response?.status} — ${err.response?.data?.error ?? err.message}` +
          (err.response?.data?.requestId ? ` (requestId: ${err.response.data.requestId})` : '')
        : String(err);
      this.log.error(`Failed to set state for "${this.device.friendlyName}": ${detail}`);
      // Revert optimistic state immediately on failure.
      this.platform.scheduleQuickPoll(this.device.id, 0);
    }
  }

  private applyOptimisticUpdate(patches: Partial<DeviceStateValue>[]): void {
    for (const patch of patches) {
      if (!patch.functionClass) continue;
      const key = `${patch.functionClass}:${patch.functionInstance}`;
      const existing = this.stateMap.get(key);
      if (existing) {
        this.stateMap.set(key, { ...existing, value: patch.value as DeviceStateValue['value'] });
      } else {
        this.stateMap.set(key, patch as DeviceStateValue);
      }
    }
    this.pushCharacteristics();
  }

  /** Build a minimal state patch using the existing functionInstance. */
  protected buildPatch(
    functionClass: string,
    value: DeviceStateValue['value'],
    functionInstance?: string,
  ): Partial<DeviceStateValue> {
    const existing = this.findValue(functionClass, functionInstance);
    return {
      functionClass,
      functionInstance: existing !== undefined ? existing.functionInstance : (functionInstance ?? 'primary'),
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
      .onSet((v) => { void this.setPower(v as boolean); });

    // Brightness.
    if (this.findValue(FC.BRIGHTNESS)) {
      this.svc.getCharacteristic(this.platform.Characteristic.Brightness)
        .onGet(() => this.getBrightness())
        .onSet((v) => { void this.setBrightness(v as number); });
    }

    // Color temperature.
    if (this.findValue(FC.COLOR_TEMP)) {
      const minK = 2700, maxK = 6500;
      this.svc.getCharacteristic(this.platform.Characteristic.ColorTemperature)
        .setProps({ minValue: kelvinToMired(maxK), maxValue: kelvinToMired(minK) })
        .onGet(() => this.getColorTemp())
        .onSet((v) => { void this.setColorTemp(v as number); });
    }

    // RGB color (Hue + Saturation).
    if (this.findValue(FC.COLOR_RGB)) {
      this.svc.getCharacteristic(this.platform.Characteristic.Hue)
        .onGet(() => this.getHue())
        .onSet((v) => { void this.setPendingHue(v as number); });

      this.svc.getCharacteristic(this.platform.Characteristic.Saturation)
        .onGet(() => this.getSaturation())
        .onSet((v) => { void this.setPendingSat(v as number); });
    }

    // Non-standard: StatusFault for offline detection (opt-in; may not render in Apple Home).
    if (this.platform.exposeStatusFault) {
      this.svc.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);
      this.svc.getCharacteristic(this.platform.Characteristic.StatusFault)
        .onGet(() => this.getStatusFault());
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
    return rgbToHsv(...parseColorRgb(v.value))[0];
  }

  private getSaturation(): CharacteristicValue {
    const v = this.findValue(FC.COLOR_RGB);
    if (!v) return 0;
    return rgbToHsv(...parseColorRgb(v.value))[1];
  }

  // ── Setters ───────────────────────────────────────────────────────────────────

  private async setPower(on: boolean): Promise<void> {
    await this.setDeviceValues([this.buildPatch(FC.POWER, on ? 'on' : 'off')]);
  }

  private brightnessTimer: ReturnType<typeof setTimeout> | null = null;

  private async setBrightness(value: number): Promise<void> {
    if (this.brightnessTimer) clearTimeout(this.brightnessTimer);
    this.brightnessTimer = setTimeout(async () => {
      const rounded = Math.round(value);
      const patches: Partial<DeviceStateValue>[] = [
        this.buildPatch(FC.BRIGHTNESS, rounded),
      ];
      if (rounded > 0 && !this.getPower()) {
        patches.push(this.buildPatch(FC.POWER, 'on'));
      }
      await this.setDeviceValues(patches);
    }, 300);
  }

  private colorTempTimer: ReturnType<typeof setTimeout> | null = null;

  private async setColorTemp(mireds: number): Promise<void> {
    if (this.colorTempTimer) clearTimeout(this.colorTempTimer);
    this.colorTempTimer = setTimeout(async () => {
      const k = miredToKelvin(mireds);
      const patches: Partial<DeviceStateValue>[] = [
        this.buildPatch(FC.COLOR_TEMP, k.toString()),
      ];
      if (this.findValue(FC.COLOR_MODE)) {
        patches.push(this.buildPatch(FC.COLOR_MODE, 'white'));
      }
      await this.setDeviceValues(patches);
    }, 300);
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

      const rgbPatch = this.buildPatch(FC.COLOR_RGB, '');
      rgbPatch.value = { 'color-rgb': { r, g, b } };
      const patches: Partial<DeviceStateValue>[] = [rgbPatch];
      if (this.findValue(FC.COLOR_MODE)) {
        patches.push(this.buildPatch(FC.COLOR_MODE, 'color'));
      }
      await this.setDeviceValues(patches);
      this.pendingHue = null;
      this.pendingSat = null;
    }, 150);
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
    if (this.platform.exposeStatusFault) {
      this.svc.updateCharacteristic(
        this.platform.Characteristic.StatusFault, this.getStatusFault());
    }
  }
}

// ─── Fan accessory (fan + optional light kit) ─────────────────────────────────

export class FanAccessory extends BaseHubspaceAccessory {
  declare private fanSvc: Service;
  declare private lightSvc: Service | null;
  private cbAcc: PlatformAccessory | null = null;
  private mpAcc: PlatformAccessory | null = null;

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
      .onSet((v) => { void this.setFanActive(v as number, fanPower?.functionInstance); });


    // Rotation speed — 0 = off, 25/50/75/100 = speed steps.
    if (this.findValue(FC.FAN_SPEED)) {
      this.fanSvc.getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .updateValue(this.getFanSpeed())
        .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
        .onGet(() => this.getFanSpeed())
        .onSet((v) => { void this.setFanSpeed(v as number); });
    }


    // Non-standard: StatusFault for offline detection (opt-in; may not render in Apple Home).
    if (this.platform.exposeStatusFault) {
      this.fanSvc.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);
      this.fanSvc.getCharacteristic(this.platform.Characteristic.StatusFault)
        .onGet(() => this.getStatusFault());
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
        .onSet((v) => { void this.setLightPower(v as boolean); });

      if (hasBrightness) {
        this.lightSvc.getCharacteristic(this.platform.Characteristic.Brightness)
          .onGet(() => this.getLightBrightness())
          .onSet((v) => { void this.setLightBrightness(v as number); });
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
    if (this.getFanActive() === this.platform.Characteristic.Active.INACTIVE) return 0;
    const v = this.findValue(FC.FAN_SPEED);
    return v ? hubspeedToPercent(String(v.value)) : 50;
  }

  private async setFanSpeed(percent: number): Promise<void> {
    if (percent === 0) {
      const fanPower = this.findFanPowerValue();
      await this.setDeviceValues([this.buildPatch(FC.POWER, 'off', fanPower?.functionInstance)]);
      return;
    }
    const current = this.findValue(FC.FAN_SPEED);
    const raw = percentToHubspeed(percent, String(current?.value ?? 'low'));
    await this.setDeviceValues([this.buildPatch(FC.FAN_SPEED, raw)]);
  }

  // ── Master power companion accessory ─────────────────────────────────────────

  /** True only when a separate fan-power instance exists, making power[primary] genuinely unused master power. */
  public hasMasterPower(): boolean {
    return (
      this.findValue(FC.POWER, 'primary') !== undefined &&
      this.findValue(FC.POWER, 'fan-power') !== undefined
    );
  }

  public setupMasterPowerCompanion(pAcc: PlatformAccessory): void {
    this.mpAcc = pAcc;
    const svc =
      pAcc.getService(this.platform.Service.Switch) ??
      pAcc.addService(this.platform.Service.Switch, 'Master Power');
    svc.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.getMasterPower())
      .onSet((v) => { void this.setMasterPower(v as boolean); });
  }

  private getMasterPower(): CharacteristicValue {
    const v = this.findValue(FC.POWER, 'primary');
    return v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
  }

  private async setMasterPower(on: boolean): Promise<void> {
    await this.setDeviceValues([this.buildPatch(FC.POWER, on ? 'on' : 'off', 'primary')]);
  }

  // ── Comfort Breeze companion accessory ───────────────────────────────────────

  public hasComfortBreeze(): boolean {
    return this.findValue(FC.TOGGLE, 'comfort-breeze') !== undefined;
  }

  public setupComfortBreezeCompanion(pAcc: PlatformAccessory): void {
    this.cbAcc = pAcc;
    const svc =
      pAcc.getService(this.platform.Service.Switch) ??
      pAcc.addService(this.platform.Service.Switch, 'Comfort Breeze');
    svc.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.getComfortBreeze())
      .onSet((v) => { void this.setComfortBreeze(v as boolean); });
  }

  // ── Comfort Breeze getters / setters ─────────────────────────────────────────

  private getComfortBreeze(): CharacteristicValue {
    const v = this.findValue(FC.TOGGLE, 'comfort-breeze');
    return v?.value === 'enabled' || v?.value === true || v?.value === 1;
  }

  private async setComfortBreeze(on: boolean): Promise<void> {
    await this.setDeviceValues([
      this.buildPatch(FC.TOGGLE, on ? 'enabled' : 'disabled', 'comfort-breeze'),
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

  private lightBrightnessTimer: ReturnType<typeof setTimeout> | null = null;

  private async setLightBrightness(value: number): Promise<void> {
    if (this.lightBrightnessTimer) clearTimeout(this.lightBrightnessTimer);
    this.lightBrightnessTimer = setTimeout(async () => {
      const rounded = Math.round(value);
      const current = this.findValue(FC.BRIGHTNESS, 'light-brightness') ?? this.findValue(FC.BRIGHTNESS);
      const patches: Partial<DeviceStateValue>[] = [
        this.buildPatch(FC.BRIGHTNESS, rounded, current?.functionInstance),
      ];
      if (rounded > 0 && !this.getLightPower()) {
        patches.push(this.buildPatch(FC.POWER, 'on', 'light-power'));
      }
      await this.setDeviceValues(patches);
    }, 300);
  }

  // ── Push ──────────────────────────────────────────────────────────────────────

  protected pushCharacteristics(): void {
    this.fanSvc.updateCharacteristic(
      this.platform.Characteristic.Active, this.getFanActive());

    if (this.findValue(FC.FAN_SPEED)) {
      this.fanSvc.updateCharacteristic(
        this.platform.Characteristic.RotationSpeed, this.getFanSpeed());
    }

    if (this.lightSvc) {
      this.lightSvc.updateCharacteristic(
        this.platform.Characteristic.On, this.getLightPower());
      if (this.findValue(FC.BRIGHTNESS)) {
        this.lightSvc.updateCharacteristic(
          this.platform.Characteristic.Brightness, this.getLightBrightness());
      }
    }

    if (this.cbAcc) {
      this.cbAcc.getService(this.platform.Service.Switch)
        ?.updateCharacteristic(this.platform.Characteristic.On, this.getComfortBreeze());
    }

    if (this.mpAcc) {
      this.mpAcc.getService(this.platform.Service.Switch)
        ?.updateCharacteristic(this.platform.Characteristic.On, this.getMasterPower());
    }

    if (this.platform.exposeStatusFault) {
      this.fanSvc.updateCharacteristic(
        this.platform.Characteristic.StatusFault, this.getStatusFault());
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
      .onSet((v) => { void this.setPower(v as boolean); });

    // OutletInUse and StatusFault are optional on the Outlet service (not Switch).
    if (useOutletService) {
      this.svc.getCharacteristic(this.platform.Characteristic.OutletInUse)
        .onGet(() => this.getPower());
      this.svc.getCharacteristic(this.platform.Characteristic.StatusFault)
        .onGet(() => this.getStatusFault());
    }
  }

  private getPower(): CharacteristicValue {
    const v = this.findValue(FC.POWER) ?? this.findValue(FC.TOGGLE);
    const raw = v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
    return this.platform.invertOutletStatus ? !raw : raw;
  }

  private async setPower(on: boolean): Promise<void> {
    const fc = this.findValue(FC.POWER) ? FC.POWER : FC.TOGGLE;
    const send = this.platform.invertOutletStatus ? !on : on;
    await this.setDeviceValues([this.buildPatch(fc, send ? 'on' : 'off')]);
  }

  protected pushCharacteristics(): void {
    this.svc.updateCharacteristic(this.platform.Characteristic.On, this.getPower());
    if (this.svc.getCharacteristic(this.platform.Characteristic.OutletInUse)) {
      this.svc.updateCharacteristic(
        this.platform.Characteristic.OutletInUse, this.getPower());
      this.svc.updateCharacteristic(
        this.platform.Characteristic.StatusFault, this.getStatusFault());
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
    `Unsupported deviceClass "${device.deviceClass}" for "${device.friendlyName}" — skipping.`,
  );
  return null;
}

// Re-export context type for platform use.
export type { HubspaceAccessoryContext };
