import {
  PlatformAccessory,
  Service,
  CharacteristicValue,
  Logger,
  HAPStatus,
} from 'homebridge';
import { isAxiosError } from 'axios';
import type { HubspacePlatform } from './platform';
import { HubspaceDevice, DeviceStateValue, FC, HubspaceAccessoryContext } from './types';
import {
  createLogger,
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
  protected offline = false;
  private pollFails = 0;
  private static readonly OFFLINE_THRESHOLD = 3;
  /**
   * When true, `available=false` in REST state sets No Response.
   * All device classes opt in — `available` is the cloud's authoritative
   * reachability signal.  The onGet handlers enforce offline state so HomeKit
   * polling cannot clear it.
   */
  protected readonly availableOffline: boolean = true;

  constructor(
    protected readonly platform: HubspacePlatform,
    protected readonly accessory: PlatformAccessory,
    public device: HubspaceDevice,
  ) {
    this.log = createLogger(platform.log, 'Device');
    this.rebuildStateMap(device.values);
    this.setupAccessoryInfo();
    this.setupServices();
  }

  // ── Info service ─────────────────────────────────────────────────────────────

  private setupAccessoryInfo(): void {
    const info = this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?? this.accessory.addService(this.platform.Service.AccessoryInformation);

    const safeName = (s: string | undefined, fallback: string): string =>
      (s?.trim().length ?? 0) > 1 ? s!.trim() : fallback;

    info
      .setCharacteristic(this.platform.Characteristic.Manufacturer,
        safeName(this.device.manufacturerName, 'Hubspace'))
      .setCharacteristic(this.platform.Characteristic.Model,
        safeName(this.device.model, this.device.typeId))
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
    const wasOffline = this.offline;
    this.pollFails = 0;
    this.rebuildStateMap(values);

    if (this.availableOffline) {
      const avail = this.findValue(FC.AVAILABLE);
      const isAvailable = avail === undefined
        || avail.value === true
        || avail.value === 'true'
        || avail.value === 1;
      this.offline = !isAvailable;
    } else {
      this.offline = false;
    }

    if (this.platform.verbose) {
      this.log.info(
        `State for "${this.device.friendlyName}": ` +
        values.map(v => `${v.functionClass}[${v.functionInstance}]=${typeof v.value === 'object' ? JSON.stringify(v.value) : v.value}`).join(', '),
      );
    }
    if (wasOffline && !this.offline) {
      this.log.info(`"${this.device.friendlyName}" is back online — clearing No Response.`);
    } else if (!wasOffline && this.offline) {
      this.log.warn(`"${this.device.friendlyName}" is offline (not available) — setting No Response.`);
    }
    this.pushCharacteristics();
  }

  /** Called by the platform when a poll attempt fails for this device. */
  markPollFailed(): void {
    this.pollFails++;
    if (this.pollFails >= BaseHubspaceAccessory.OFFLINE_THRESHOLD && !this.offline) {
      this.offline = true;
      this.log.warn(`"${this.device.friendlyName}" unreachable after ${this.pollFails} failed polls — setting No Response.`);
      this.pushCharacteristics();
    }
  }

  // ── Fault status ──────────────────────────────────────────────────────────────

  /** Returns a HapStatusError for use with updateCharacteristic when offline. */
  protected get noResponse(): Error {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (this.platform.api.hap as any).HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE) as Error;
  }

  protected getStatusFault(): CharacteristicValue {
    if (this.offline) return this.platform.Characteristic.StatusFault.GENERAL_FAULT;
    for (const [key, v] of this.stateMap) {
      if (key.startsWith('error-flag:') && v.value === true) {
        return this.platform.Characteristic.StatusFault.GENERAL_FAULT;
      }
      // Devices that report error[name]=normal|<fault-code> (e.g. portable AC)
      if (key.startsWith('error:') && v.value !== 'normal') {
        return this.platform.Characteristic.StatusFault.GENERAL_FAULT;
      }
    }
    return this.platform.Characteristic.StatusFault.NO_FAULT;
  }

  // ── Abstract interface ────────────────────────────────────────────────────────

  protected abstract setupServices(): void;

  /** Push the latest cached state into HomeKit characteristics. */
  protected abstract pushCharacteristics(): void;

  // ── Helpers ───────────────────────────────────────────────────────────────────

  // Coalescing write queue: patches enqueued within the same event-loop tick are
  // merged into a single PUT, preventing concurrent-request 400s from the API.
  private readonly pendingWrites = new Map<string, Partial<DeviceStateValue>>();
  private writeFlushTimer: ReturnType<typeof setTimeout> | null = null;

  protected setDeviceValues(values: Partial<DeviceStateValue>[]): void {
    this.applyOptimisticUpdate(values);
    for (const patch of values) {
      const key = `${patch.functionClass}:${patch.functionInstance ?? ''}`;
      this.pendingWrites.set(key, patch);
    }
    if (!this.writeFlushTimer) {
      this.writeFlushTimer = setTimeout(() => void this.flushWrites(), 0);
    }
  }

  private async flushWrites(): Promise<void> {
    this.writeFlushTimer = null;
    if (this.pendingWrites.size === 0) return;
    const patches = [...this.pendingWrites.values()];
    this.pendingWrites.clear();
    try {
      await this.platform.client.setDeviceState(this.device.id, patches);
      this.platform.scheduleQuickPoll(this.device.id, 3000);
    } catch (err) {
      const detail = isAxiosError(err)
        ? `HTTP ${err.response?.status} — ${err.response?.data?.error ?? err.message}` +
          (err.response?.data?.requestId ? ` (requestId: ${err.response.data.requestId})` : '')
        : String(err);
      this.log.error(`Failed to set state for "${this.device.friendlyName}": ${detail}`);
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
      .onGet(() => {
        if (this.offline) throw this.noResponse;
        return this.getPower();
      })
      .onSet((v) => { void this.setPower(v as boolean); });

    // Brightness.
    if (this.findValue(FC.BRIGHTNESS)) {
      this.svc.getCharacteristic(this.platform.Characteristic.Brightness)
        .onGet(() => {
          if (this.offline) throw this.noResponse;
          return this.getBrightness();
        })
        .onSet((v) => { void this.setBrightness(v as number); });
    }

    // Color temperature.
    if (this.findValue(FC.COLOR_TEMP)) {
      const minK = 2700, maxK = 6500;
      this.svc.getCharacteristic(this.platform.Characteristic.ColorTemperature)
        .setProps({ minValue: kelvinToMired(maxK), maxValue: kelvinToMired(minK) })
        .onGet(() => {
          if (this.offline) throw this.noResponse;
          return this.getColorTemp();
        })
        .onSet((v) => { void this.setColorTemp(v as number); });
    }

    // RGB color (Hue + Saturation).
    if (this.findValue(FC.COLOR_RGB)) {
      this.svc.getCharacteristic(this.platform.Characteristic.Hue)
        .onGet(() => {
          if (this.offline) throw this.noResponse;
          return this.getHue();
        })
        .onSet((v) => { void this.setPendingHue(v as number); });

      this.svc.getCharacteristic(this.platform.Characteristic.Saturation)
        .onGet(() => {
          if (this.offline) throw this.noResponse;
          return this.getSaturation();
        })
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
    if (!v) return 370; // 2702 K default
    const minMired = kelvinToMired(6500); // 154
    const maxMired = kelvinToMired(2700); // 370
    return Math.min(maxMired, Math.max(minMired, kelvinToMired(Number(v.value))));
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
    this.setDeviceValues([this.buildPatch(FC.POWER, on ? 'on' : 'off')]);
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
      this.setDeviceValues(patches);
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
      this.setDeviceValues(patches);
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
      this.setDeviceValues(patches);
      this.pendingHue = null;
      this.pendingSat = null;
    }, 150);
  }

  // ── Push ──────────────────────────────────────────────────────────────────────

  protected pushCharacteristics(): void {
    if (this.platform.exposeStatusFault) {
      this.svc.updateCharacteristic(
        this.platform.Characteristic.StatusFault, this.getStatusFault());
    }
    if (this.offline) {
      this.svc.updateCharacteristic(this.platform.Characteristic.On, this.noResponse);
      return;
    }
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
      .onGet(() => {
        if (this.offline) throw this.noResponse;
        return this.getFanActive();
      })
      .onSet((v) => { void this.setFanActive(v as number, fanPower?.functionInstance); });

    // Rotation speed — 0 = off, 25/50/75/100 = speed steps.
    if (this.findValue(FC.FAN_SPEED)) {
      this.fanSvc.getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .updateValue(this.getFanSpeed())
        .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
        .onGet(() => {
          if (this.offline) throw this.noResponse;
          return this.getFanSpeed();
        })
        .onSet((v) => { void this.setFanSpeed(v as number); });
    }

    // Rotation direction — auto-exposed when device reports fan-reverse.
    if (this.findValue(FC.FAN_REVERSE)) {
      this.fanSvc.getCharacteristic(this.platform.Characteristic.RotationDirection)
        .onGet(() => {
          if (this.offline) throw this.noResponse;
          return this.getFanDirection();
        })
        .onSet((v) => { void this.setFanDirection(v as number); });
    }

    // Non-standard: StatusFault for offline detection (opt-in; may not render in AppleHome).
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
        .onGet(() => {
          if (this.offline) throw this.noResponse;
          return this.getLightPower();
        })
        .onSet((v) => { void this.setLightPower(v as boolean); });

      if (hasBrightness) {
        this.lightSvc.getCharacteristic(this.platform.Characteristic.Brightness)
          .onGet(() => {
            if (this.offline) throw this.noResponse;
            return this.getLightBrightness();
          })
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
    this.setDeviceValues([
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
      this.setDeviceValues([this.buildPatch(FC.POWER, 'off', fanPower?.functionInstance)]);
      return;
    }
    const current = this.findValue(FC.FAN_SPEED);
    const raw = percentToHubspeed(percent, String(current?.value ?? 'low'));
    this.setDeviceValues([this.buildPatch(FC.FAN_SPEED, raw)]);
  }

  private getFanDirection(): CharacteristicValue {
    const v = this.findValue(FC.FAN_REVERSE);
    return v?.value === 'reverse'
      ? this.platform.Characteristic.RotationDirection.COUNTER_CLOCKWISE
      : this.platform.Characteristic.RotationDirection.CLOCKWISE;
  }

  private async setFanDirection(hkDirection: number): Promise<void> {
    const reverse = hkDirection === this.platform.Characteristic.RotationDirection.COUNTER_CLOCKWISE;
    this.setDeviceValues([
      this.buildPatch(FC.FAN_REVERSE, reverse ? 'reverse' : 'forward', 'fan-reverse'),
    ]);
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
    this.setDeviceValues([this.buildPatch(FC.POWER, on ? 'on' : 'off', 'primary')]);
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
    this.setDeviceValues([
      this.buildPatch(FC.TOGGLE, on ? 'enabled' : 'disabled', 'comfort-breeze'),
    ]);
  }

  // ── Light-kit getters / setters ───────────────────────────────────────────────

  private getLightPower(): CharacteristicValue {
    const v = this.findValue(FC.POWER, 'light-power');
    return v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
  }

  private async setLightPower(on: boolean): Promise<void> {
    this.setDeviceValues([
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
      this.setDeviceValues(patches);
    }, 300);
  }

  // ── Push ──────────────────────────────────────────────────────────────────────

  protected pushCharacteristics(): void {
    if (this.platform.exposeStatusFault) {
      this.fanSvc.updateCharacteristic(
        this.platform.Characteristic.StatusFault, this.getStatusFault());
    }
    if (this.offline) {
      this.fanSvc.updateCharacteristic(this.platform.Characteristic.Active, this.noResponse);
      this.lightSvc?.updateCharacteristic(this.platform.Characteristic.On, this.noResponse);
      return;
    }
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

    if (this.cbAcc) {
      this.cbAcc.getService(this.platform.Service.Switch)
        ?.updateCharacteristic(this.platform.Characteristic.On, this.getComfortBreeze());
    }

    if (this.mpAcc) {
      this.mpAcc.getService(this.platform.Service.Switch)
        ?.updateCharacteristic(this.platform.Characteristic.On, this.getMasterPower());
    }

  }
}

// ─── Outlet / switch / plug accessory ────────────────────────────────────────

export class OutletAccessory extends BaseHubspaceAccessory {
  declare private svc: Service;

  protected setupServices(): void {
    const useOutletService = ['outlet', 'plug', 'power-outlet'].includes(
      this.device.deviceClass.toLowerCase(),
    );

    const ServiceType = useOutletService
      ? this.platform.Service.Outlet
      : this.platform.Service.Switch;

    this.svc =
      this.accessory.getService(ServiceType) ??
      this.accessory.addService(ServiceType, this.device.friendlyName);

    this.svc.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => {
        if (this.offline) throw this.noResponse;
        return this.getPower();
      })
      .onSet((v) => { void this.setPower(v as boolean); });

    // OutletInUse is optional on the Outlet service (not Switch).
    if (useOutletService) {
      this.svc.getCharacteristic(this.platform.Characteristic.OutletInUse)
        .onGet(() => {
          if (this.offline) throw this.noResponse;
          return this.getPower();
        });
    }

    // StatusFault for offline detection (always present on outlets).
    this.svc.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);
    this.svc.getCharacteristic(this.platform.Characteristic.StatusFault)
      .onGet(() => this.getStatusFault());
  }

  private getPower(): CharacteristicValue {
    const v = this.findValue(FC.POWER) ?? this.findValue(FC.TOGGLE);
    const raw = v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
    return this.platform.invertOutletStatus ? !raw : raw;
  }

  private async setPower(on: boolean): Promise<void> {
    const fc = this.findValue(FC.POWER) ? FC.POWER : FC.TOGGLE;
    const send = this.platform.invertOutletStatus ? !on : on;
    this.setDeviceValues([this.buildPatch(fc, send ? 'on' : 'off')]);
  }

  protected pushCharacteristics(): void {
    this.svc.updateCharacteristic(
      this.platform.Characteristic.StatusFault, this.getStatusFault());
    if (this.offline) {
      this.svc.updateCharacteristic(this.platform.Characteristic.On, this.noResponse);
      return;
    }
    this.svc.updateCharacteristic(this.platform.Characteristic.On, this.getPower());
    if (this.svc.getCharacteristic(this.platform.Characteristic.OutletInUse)) {
      this.svc.updateCharacteristic(this.platform.Characteristic.OutletInUse, this.getPower());
    }
  }
}

// ─── Multi-outlet accessory (e.g. surge wall tap, power strip) ────────────────

export class MultiOutletAccessory extends BaseHubspaceAccessory {
  declare private outletServices: Map<string, Service>;

  private get outletInstances(): string[] {
    const instances: string[] = [];
    for (const [, v] of this.stateMap) {
      if (v.functionClass === FC.TOGGLE && /^outlet-\d+$/.test(v.functionInstance ?? '')) {
        instances.push(v.functionInstance!);
      }
    }
    return instances.sort();
  }

  protected setupServices(): void {
    this.outletServices = new Map();
    for (const instance of this.outletInstances) {
      const label = instance.replace(/^outlet-(\d+)$/, 'Outlet $1');
      const svc =
        this.accessory.services.find(s => s.subtype === instance) ??
        this.accessory.addService(this.platform.Service.Outlet, label, instance);

      svc.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => {
          if (this.offline) throw this.noResponse;
          return this.getPowerForOutlet(instance);
        })
        .onSet((v) => { void this.setPowerForOutlet(instance, v as boolean); });

      svc.getCharacteristic(this.platform.Characteristic.OutletInUse)
        .onGet(() => {
          if (this.offline) throw this.noResponse;
          return this.getPowerForOutlet(instance);
        });

      this.outletServices.set(instance, svc);
    }
  }

  private getPowerForOutlet(instance: string): CharacteristicValue {
    const v = this.findValue(FC.TOGGLE, instance);
    return v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
  }

  private async setPowerForOutlet(instance: string, on: boolean): Promise<void> {
    this.setDeviceValues([this.buildPatch(FC.TOGGLE, on ? 'on' : 'off', instance)]);
  }

  protected pushCharacteristics(): void {
    if (this.offline) {
      for (const [, svc] of this.outletServices) {
        svc.updateCharacteristic(this.platform.Characteristic.On, this.noResponse);
      }
      return;
    }
    for (const [instance, svc] of this.outletServices) {
      svc.updateCharacteristic(this.platform.Characteristic.On, this.getPowerForOutlet(instance));
      svc.updateCharacteristic(this.platform.Characteristic.OutletInUse, this.getPowerForOutlet(instance));
    }
  }
}

// ─── Portable AC accessory ────────────────────────────────────────────────────

export class PortableAcAccessory extends BaseHubspaceAccessory {
  declare private svc: Service;

  protected setupServices(): void {
    this.svc =
      this.accessory.getService(this.platform.Service.HeaterCooler) ??
      this.accessory.addService(this.platform.Service.HeaterCooler, this.device.friendlyName);

    this.svc.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() => {
        if (this.offline) throw this.noResponse;
        return this.getActive();
      })
      .onSet((v) => { void this.setActive(v as number); });

    this.svc.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => {
        if (this.offline) throw this.noResponse;
        return this.getCurrentHeaterCoolerState();
      });

    this.svc.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: [
        this.platform.Characteristic.TargetHeaterCoolerState.COOL,
      ] })
      .onGet(() => {
        if (this.offline) throw this.noResponse;
        return this.getTargetHeaterCoolerState();
      })
      .onSet((v) => { void this.setTargetHeaterCoolerState(v as number); });

    this.svc.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => {
        if (this.offline) throw this.noResponse;
        return this.getCurrentTemperature();
      });

    if (this.findValue(FC.TEMPERATURE, 'cooling-target')) {
      this.svc.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
        .onGet(() => {
          if (this.offline) throw this.noResponse;
          return this.getCoolingTarget();
        })
        .onSet((v) => { void this.setCoolingTarget(v as number); });
    }

    if (this.findValue(FC.FAN_SPEED)) {
      this.svc.getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 33 })
        .onGet(() => {
          if (this.offline) throw this.noResponse;
          return this.getAcFanSpeed();
        })
        .onSet((v) => { void this.setAcFanSpeed(v as number); });
    }

    this.svc.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);
    this.svc.getCharacteristic(this.platform.Characteristic.StatusFault)
      .onGet(() => this.getStatusFault());
  }

  // ── Getters ───────────────────────────────────────────────────────────────────

  private getActive(): CharacteristicValue {
    const v = this.findValue(FC.POWER);
    const on = v?.value === 'on' || v?.value === true || v?.value === 1;
    return on
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  private getCurrentHeaterCoolerState(): CharacteristicValue {
    const { CurrentHeaterCoolerState } = this.platform.Characteristic;
    if (this.getActive() === this.platform.Characteristic.Active.INACTIVE) {
      return CurrentHeaterCoolerState.INACTIVE;
    }
    return CurrentHeaterCoolerState.COOLING;
  }

  private getTargetHeaterCoolerState(): CharacteristicValue {
    return this.platform.Characteristic.TargetHeaterCoolerState.COOL;
  }

  private getCurrentTemperature(): CharacteristicValue {
    const v = this.findValue(FC.TEMPERATURE, 'current-temp');
    return v !== undefined ? Number(v.value) : 20;
  }

  private getCoolingTarget(): CharacteristicValue {
    const v = this.findValue(FC.TEMPERATURE, 'cooling-target');
    return v !== undefined ? Number(v.value) : 24;
  }

  private getAcFanSpeed(): CharacteristicValue {
    if (this.getActive() === this.platform.Characteristic.Active.INACTIVE) return 0;
    const v = this.findValue(FC.FAN_SPEED);
    switch (String(v?.value ?? '')) {
      case 'fan-speed-low':  return 66;
      case 'fan-speed-high': return 99;
      default:               return 33; // fan-speed-auto or unknown
    }
  }

  // ── Setters ───────────────────────────────────────────────────────────────────

  private async setActive(hkActive: number): Promise<void> {
    const on = hkActive === this.platform.Characteristic.Active.ACTIVE;
    this.setDeviceValues([this.buildPatch(FC.POWER, on ? 'on' : 'off')]);
  }

  private async setTargetHeaterCoolerState(_hkState: number): Promise<void> {
    this.setDeviceValues([this.buildPatch(FC.MODE, 'cool')]);
  }

  private coolingTargetTimer: ReturnType<typeof setTimeout> | null = null;

  private async setCoolingTarget(celsius: number): Promise<void> {
    if (this.coolingTargetTimer) clearTimeout(this.coolingTargetTimer);
    this.coolingTargetTimer = setTimeout(() => {
      this.setDeviceValues([
        this.buildPatch(FC.TEMPERATURE, Math.round(celsius), 'cooling-target'),
      ]);
    }, 300);
  }

  private async setAcFanSpeed(percent: number): Promise<void> {
    if (percent === 0) {
      this.setDeviceValues([this.buildPatch(FC.POWER, 'off')]);
      return;
    }
    let speed: string;
    if (percent <= 33) speed = 'fan-speed-auto';
    else if (percent <= 66) speed = 'fan-speed-low';
    else speed = 'fan-speed-high';
    this.setDeviceValues([this.buildPatch(FC.FAN_SPEED, speed)]);
  }

  // ── Push ──────────────────────────────────────────────────────────────────────

  protected pushCharacteristics(): void {
    this.svc.updateCharacteristic(
      this.platform.Characteristic.StatusFault, this.getStatusFault());
    if (this.offline) {
      this.svc.updateCharacteristic(this.platform.Characteristic.Active, this.noResponse);
      return;
    }
    this.svc.updateCharacteristic(this.platform.Characteristic.Active, this.getActive());
    this.svc.updateCharacteristic(
      this.platform.Characteristic.CurrentHeaterCoolerState, this.getCurrentHeaterCoolerState());
    this.svc.updateCharacteristic(
      this.platform.Characteristic.TargetHeaterCoolerState, this.getTargetHeaterCoolerState());
    this.svc.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature, this.getCurrentTemperature());
    if (this.findValue(FC.TEMPERATURE, 'cooling-target')) {
      this.svc.updateCharacteristic(
        this.platform.Characteristic.CoolingThresholdTemperature, this.getCoolingTarget());
    }
    if (this.findValue(FC.FAN_SPEED)) {
      this.svc.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.getAcFanSpeed());
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

  if (cls === 'outlet' || cls === 'switch' || cls === 'plug' || cls === 'power-outlet') {
    const multiOutlets = device.values.filter(
      v => v.functionClass === FC.TOGGLE && /^outlet-\d+$/.test(v.functionInstance ?? ''),
    );
    if (multiOutlets.length > 1) {
      return new MultiOutletAccessory(platform, pAccessory, device);
    }
    return new OutletAccessory(platform, pAccessory, device);
  }

  if (cls === 'portable-air-conditioner') {
    return new PortableAcAccessory(platform, pAccessory, device);
  }

  platform.log.warn(
    `Unsupported deviceClass "${device.deviceClass}" for "${device.friendlyName}" — skipping.`,
  );
  return null;
}

// Re-export context type for platform use.
export type { HubspaceAccessoryContext };
