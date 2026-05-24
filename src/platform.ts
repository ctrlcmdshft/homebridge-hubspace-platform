import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { PLUGIN_NAME, PLATFORM_NAME, HubspaceConfig, SUPPORTED_DEVICE_CLASSES } from './types';
import { HubspaceClient } from './hubspace-client';
import { createLogger } from './utils';
import { BaseHubspaceAccessory, FanAccessory, createAccessory } from './accessory';
import type { HubspaceAccessoryContext } from './accessory';

export class HubspacePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  /** Map from device ID → live accessory handler. */
  private readonly handlers = new Map<string, BaseHubspaceAccessory>();
  /** Restored (cached) platform accessories, keyed by UUID. */
  private readonly cachedAccessories = new Map<string, PlatformAccessory>();

  public readonly client: HubspaceClient;
  public readonly debug: boolean;
  public readonly verbose: boolean;
  public readonly exposeStatusFault: boolean;
  public readonly invertOutletStatus: boolean;
  private readonly configured: boolean;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailCycles = 0;
  private conclaveActive = false;
  private readonly pendingQuickPolls = new Set<string>();
  /** Cache: Conclave BLE-MAC-based device ID → metadevice UUID. */
  private readonly conclaveIdMap = new Map<string, string>();
  private readonly cfg: HubspaceConfig;
  private readonly conclaveLog: Logger;
  private readonly pollLog: Logger;

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.cfg = config as HubspaceConfig;
    this.debug = this.cfg.debug ?? this.cfg.verbose ?? false;
    this.verbose = this.cfg.verbose ?? false;
    this.exposeStatusFault = this.cfg.exposeStatusFault ?? false;
    this.invertOutletStatus = this.cfg.invertOutletStatus ?? false;
    this.conclaveLog = createLogger(this.log, 'Conclave');
    this.pollLog = createLogger(this.log, 'Poll');

    if (!this.cfg.username || !this.cfg.password) {
      this.log.warn(
        'No credentials configured — open the plugin settings in the Homebridge UI ' +
        'and enter your Hubspace username and password, then restart Homebridge.',
      );
      this.configured = false;
      this.client = null as unknown as HubspaceClient;
      this.api.on('didFinishLaunching', () => this.removeAllCachedAccessories());
      return;
    }

    this.configured = true;
    this.client = new HubspaceClient(
      this.cfg.username,
      this.cfg.password,
      this.api.user.storagePath(),
      this.log,
      {
        tokenCachePath: this.cfg.tokenCachePath,
        debug: this.debug,
      },
    );

    this.api.on('didFinishLaunching', () => this.onReady());
    this.api.on('shutdown', () => this.onShutdown());

    this.log.info('Platform initialised — waiting for Homebridge launch.');
  }

  // ─── Homebridge lifecycle ────────────────────────────────────────────────────

  /**
   * Called by Homebridge for each accessory that was previously registered and
   * cached to disk.  We stash it here; discoverDevices() decides whether to
   * keep or remove it.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(
      `Restoring cached accessory: ${accessory.displayName}`,
    );
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  // ─── Start-up ─────────────────────────────────────────────────────────────────

  private removeAllCachedAccessories(): void {
    const stale = [...this.cachedAccessories.values()];
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`Removed ${stale.length} cached accessory(ies) — plugin is not configured.`);
    }
  }

  private async onReady(): Promise<void> {
    try {
      await this.client.initialize();
      await this.discoverDevices();
      if (!this.cfg.disableConclave) {
        this.conclaveActive = true;
        this.client.startConclave(
          (deviceId) => this.scheduleQuickPoll(deviceId, 500),
          () => this.scheduleFullSweep(1_000),
        );
        this.conclaveLog.info('Push connection started.');
      }
      this.startPolling();
    } catch (err) {
      this.log.error('Start-up failed:', String(err));
      this.log.warn(
        'Falling back to cached accessories. ' +
        'Polling will not start until the API is reachable.',
      );
      // Re-attach handlers for any previously cached accessories so HomeKit
      // can still reflect the last known state.
      this.restoreCachedHandlers();
      // Retry initialisation after 2 minutes.
      setTimeout(() => this.onReady(), 120_000);
    }
  }

  private onShutdown(): void {
    this.stopPolling();
    this.log.info('Shut down cleanly.');
  }

  // ─── Device discovery ─────────────────────────────────────────────────────────

  private async discoverDevices(): Promise<void> {
    this.log.info('Discovering devices…');
    const devices = await this.client.getDevices();
    this.log.info(`Cloud returned ${devices.length} device(s).`);

    const seenUUIDs = new Set<string>();

    for (const device of devices) {
      if (!SUPPORTED_DEVICE_CLASSES.has(device.deviceClass.toLowerCase())) {
        const caps = [...new Set(device.values.map(v => v.functionClass))].join(', ') || 'none';
        const mfr = [device.manufacturerName, device.model].filter(Boolean).join(' / ') || 'unknown';
        this.log.warn(
          `Unsupported deviceClass "${device.deviceClass}" — "${device.friendlyName}" will not appear in HomeKit.\n` +
          `  Hardware     : ${mfr}\n` +
          `  Capabilities : ${caps}\n` +
          `  To request support: https://github.com/ctrlcmdshft/homebridge-hubspace-platform/issues`,
        );
        if (this.debug) {
          for (const v of device.values) {
            this.log.info(
              `  [debug] ${v.functionClass}[${v.functionInstance ?? 'undefined'}] = ${JSON.stringify(v.value)}`,
            );
          }
        }
        continue;
      }

      const uuid = this.api.hap.uuid.generate(device.id);
      seenUUIDs.add(uuid);

      const existing = this.cachedAccessories.get(uuid);

      if (existing) {
        // Update the cached accessory with fresh device info.
        existing.context = this.buildContext(device);
        this.api.updatePlatformAccessories([existing]);
        const handler = createAccessory(this, existing, device);
        if (handler) {
          this.handlers.set(device.id, handler);
          this.log.info(`Restored: "${device.friendlyName}" (${device.deviceClass})`);
          this.setupComfortBreezeCompanion(handler, device.id, seenUUIDs);
          this.setupMasterPowerCompanion(handler, device.id, seenUUIDs);
        }
      } else {
        // Register a brand-new accessory.
        const pAccessory = new this.api.platformAccessory(
          device.friendlyName,
          uuid,
        );
        pAccessory.context = this.buildContext(device);

        const handler = createAccessory(this, pAccessory, device);
        if (handler) {
          this.handlers.set(device.id, handler);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [pAccessory]);
          this.log.info(`Registered: "${device.friendlyName}" (${device.deviceClass})`);
          this.setupComfortBreezeCompanion(handler, device.id, seenUUIDs);
          this.setupMasterPowerCompanion(handler, device.id, seenUUIDs);
        }
      }
    }

    // Remove stale accessories that are no longer in the cloud.
    for (const [uuid, pAccessory] of this.cachedAccessories) {
      if (!seenUUIDs.has(uuid)) {
        this.log.warn(
          `Removing stale accessory: "${pAccessory.displayName}"`,
        );
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [pAccessory]);
        this.cachedAccessories.delete(uuid);
      }
    }

    this.log.info(
      `Discovery complete — ${this.handlers.size} accessory(ies) active.`,
    );
  }

  /** Re-create handlers for cached accessories without a fresh device list. */
  private restoreCachedHandlers(): void {
    for (const [, pAccessory] of this.cachedAccessories) {
      const ctx = pAccessory.context as HubspaceAccessoryContext;
      if (!ctx?.deviceId || this.handlers.has(ctx.deviceId)) continue;
      if (ctx.companionFor) continue; // companion accessories have no standalone handler

      const stub = {
        id: ctx.deviceId,
        allIds: [ctx.deviceId],
        typeId: ctx.typeId,
        friendlyName: ctx.friendlyName,
        deviceClass: ctx.deviceClass,
        manufacturerName: ctx.manufacturerName,
        model: ctx.model,
        values: [],
      };
      const handler = createAccessory(this, pAccessory, stub);
      if (handler) this.handlers.set(ctx.deviceId, handler);
    }
  }

  // ─── Polling ──────────────────────────────────────────────────────────────────

  private startPolling(): void {
    const raw = this.cfg.pollingInterval ?? 30;
    const intervalSecs = Math.min(600, Math.max(10, raw));
    const intervalMs = intervalSecs * 1000;
    this.log.info(`Starting state polling every ${intervalSecs}s.`);
    this.pollTimer = setInterval(() => this.pollDevices(), intervalMs);
    // Run immediately on first start.
    this.pollDevices();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  scheduleQuickPoll(conclaveId: string, delayMs: number): void {
    // Conclave sends BLE-MAC-based IDs (e.g. "837024dcc33c87c6").
    // Resolve to our metadevice UUID before scheduling.
    const metadeviceId = this.resolveConclaveId(conclaveId);
    if (!metadeviceId) {
      // A 16-hex-char ID that doesn't match any known device is likely a hub or
      // gateway. Hub events mean hub-connected lights may have changed availability,
      // so trigger a full sweep so they pick up available=false quickly.
      if (/^[0-9a-f]{16}$/i.test(conclaveId)) {
        this.conclaveLog.debug(`Unresolved device ${conclaveId} — scheduling full sweep.`);
        this.scheduleFullSweep(delayMs);
      }
      return;
    }

    if (this.pendingQuickPolls.has(metadeviceId)) return;
    this.pendingQuickPolls.add(metadeviceId);
    setTimeout(() => {
      this.pendingQuickPolls.delete(metadeviceId);
      const handler = this.handlers.get(metadeviceId);
      if (!handler) return;
      if (this.debug) this.conclaveLog.info(`Quick-poll → "${handler.device.friendlyName}"`);
      const allIds = handler.device.allIds ?? [metadeviceId];
      this.client.getDeviceState(allIds)
        .then(values => handler.updateState(values))
        .catch(err => this.log.warn(`Quick-poll failed for ${metadeviceId}: ${err}`));
    }, delayMs);
  }

  private scheduleFullSweep(delayMs: number): void {
    if (this.pendingQuickPolls.has('__sweep__')) return;
    this.pendingQuickPolls.add('__sweep__');
    setTimeout(() => {
      this.pendingQuickPolls.delete('__sweep__');
      if (this.debug) this.conclaveLog.info('Full sweep triggered by hub event.');
      this.pollDevices();
    }, delayMs);
  }

  /**
   * Resolve a Conclave device ID to a metadevice UUID.
   *
   * Afero Conclave sends IDs of the form "<4-char-prefix><ble-mac>" (16 hex chars).
   * Each device's BLE MAC is available as the `ble-mac-address` function class in
   * its state values.  We match the last 12 chars of the Conclave ID against known
   * BLE MACs and cache the result.
   */
  private resolveConclaveId(conclaveId: string): string | undefined {
    if (this.handlers.has(conclaveId)) return conclaveId; // already a metadevice UUID
    if (this.conclaveIdMap.has(conclaveId)) return this.conclaveIdMap.get(conclaveId);

    const macSuffix = conclaveId.slice(-12).toLowerCase();
    for (const [metadeviceId, handler] of this.handlers) {
      const bleMac = handler.device.values
        .find(v => v.functionClass === 'ble-mac-address')
        ?.value;
      if (typeof bleMac === 'string' && bleMac.toLowerCase().replace(/:/g, '') === macSuffix) {
        this.conclaveIdMap.set(conclaveId, metadeviceId);
        if (this.debug) this.conclaveLog.info(`Resolved ${conclaveId} → "${handler.device.friendlyName}"`);
        return metadeviceId;
      }
    }

    if (this.debug && /^[0-9a-f]{16}$/i.test(conclaveId)) {
      this.conclaveLog.info(`No BLE-MAC match for ${conclaveId} — treating as hub/gateway.`);
    }
    return undefined;
  }

  private async pollDevices(): Promise<void> {
    if (this.handlers.size === 0) return;

    this.log.debug(`Polling ${this.handlers.size} device(s)…`);

    const entries = [...this.handlers.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([deviceId, handler]) => {
        const allIds = handler.device.allIds ?? [deviceId];
        const values = await this.client.getDeviceState(allIds);
        handler.updateState(values);
      }),
    );

    let failCount = 0;
    results.forEach((r, i) => {
      const [, handler] = entries[i];
      if (r.status === 'rejected') {
        failCount++;
        handler.markPollFailed();
        if (this.consecutiveFailCycles < 3) {
          const [deviceId] = entries[i];
          this.pollLog.warn(`Failed for ${deviceId}: ${r.reason}`);
        }
      }
    });
    if (failCount > 0) {
      this.consecutiveFailCycles++;
      if (this.consecutiveFailCycles === 3) {
        this.pollLog.warn('API appears unreachable — suppressing repeated errors. Will log again when recovered.');
      } else if (this.consecutiveFailCycles < 3) {
        this.pollLog.warn(`${failCount} device(s) failed this cycle.`);
      }
    } else {
      if (this.consecutiveFailCycles >= 3) {
        this.pollLog.info(`API reachable again after ${this.consecutiveFailCycles} failed cycles.`);
      }
      this.consecutiveFailCycles = 0;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private setupMasterPowerCompanion(
    handler: BaseHubspaceAccessory,
    deviceId: string,
    seenUUIDs: Set<string>,
  ): void {
    if (!this.cfg.exposeMasterPowerSwitch) return;
    if (!(handler instanceof FanAccessory) || !handler.hasMasterPower()) return;

    const mpUUID = this.api.hap.uuid.generate(deviceId + '-mp');
    seenUUIDs.add(mpUUID);

    const existing = this.cachedAccessories.get(mpUUID);
    if (existing) {
      handler.setupMasterPowerCompanion(existing);
      this.log.info(`Restored Master Power companion for "${handler.device.friendlyName}"`);
    } else {
      const mpAcc = new this.api.platformAccessory('Master Power', mpUUID);
      mpAcc.context = { deviceId, deviceClass: 'master-power', typeId: '', friendlyName: 'Master Power', companionFor: deviceId };
      handler.setupMasterPowerCompanion(mpAcc);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [mpAcc]);
      this.log.info(`Registered Master Power companion for "${handler.device.friendlyName}"`);
    }
  }

  private setupComfortBreezeCompanion(
    handler: BaseHubspaceAccessory,
    deviceId: string,
    seenUUIDs: Set<string>,
  ): void {
    if (!this.cfg.exposeComfortBreeze) return;
    if (!(handler instanceof FanAccessory) || !handler.hasComfortBreeze()) return;

    const cbUUID = this.api.hap.uuid.generate(deviceId + '-cb');
    seenUUIDs.add(cbUUID);

    const existing = this.cachedAccessories.get(cbUUID);
    if (existing) {
      handler.setupComfortBreezeCompanion(existing);
      this.log.info(`Restored Comfort Breeze companion for "${handler.device.friendlyName}"`);
    } else {
      const cbAcc = new this.api.platformAccessory('Comfort Breeze', cbUUID);
      cbAcc.context = { deviceId, deviceClass: 'comfort-breeze', typeId: '', friendlyName: 'Comfort Breeze', companionFor: deviceId };
      handler.setupComfortBreezeCompanion(cbAcc);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cbAcc]);
      this.log.info(`Registered Comfort Breeze companion for "${handler.device.friendlyName}"`);
    }
  }

  private buildContext(device: {
    id: string;
    deviceClass: string;
    typeId: string;
    friendlyName: string;
    manufacturerName?: string;
    model?: string;
  }): HubspaceAccessoryContext {
    return {
      deviceId: device.id,
      deviceClass: device.deviceClass,
      typeId: device.typeId,
      friendlyName: device.friendlyName,
      manufacturerName: device.manufacturerName,
      model: device.model,
    };
  }
}
