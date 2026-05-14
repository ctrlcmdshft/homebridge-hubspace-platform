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
  private readonly cfg: HubspaceConfig;

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
        this.client.startConclave((deviceId) => this.scheduleQuickPoll(deviceId, 0));
        this.log.info('Conclave push connection started — slow-poll fallback every 300s.');
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
        this.log.debug(
          `Skipping unsupported deviceClass "${device.deviceClass}" ` +
          `(${device.friendlyName})`,
        );
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
    const defaultInterval = this.conclaveActive ? 300 : 30;
    const intervalSecs = this.cfg.pollingInterval ?? defaultInterval;
    const intervalMs = intervalSecs * 1000;
    this.log.info(
      `Starting state polling every ${intervalSecs}s${this.conclaveActive ? ' (Conclave fallback)' : ''}.`,
    );
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

  scheduleQuickPoll(deviceId: string, delayMs: number): void {
    if (this.pendingQuickPolls.has(deviceId)) return;
    this.pendingQuickPolls.add(deviceId);
    setTimeout(() => {
      this.pendingQuickPolls.delete(deviceId);
      const handler = this.handlers.get(deviceId);
      if (!handler) return;
      const allIds = handler.device.allIds ?? [deviceId];
      this.client.getDeviceState(allIds)
        .then(values => handler.updateState(values))
        .catch(err => this.log.warn(`Quick-poll failed for ${deviceId}: ${err}`));
    }, delayMs);
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
      if (r.status === 'rejected') {
        failCount++;
        if (this.consecutiveFailCycles < 3) {
          const [deviceId] = entries[i];
          this.log.warn(`Poll failed for ${deviceId}: ${r.reason}`);
        }
      }
    });
    if (failCount > 0) {
      this.consecutiveFailCycles++;
      if (this.consecutiveFailCycles === 3) {
        this.log.warn(`API appears unreachable — suppressing repeated poll errors. Will log again when recovered.`);
      } else if (this.consecutiveFailCycles < 3) {
        this.log.warn(`${failCount} device(s) failed to poll this cycle.`);
      }
    } else {
      if (this.consecutiveFailCycles >= 3) {
        this.log.info(`API reachable again after ${this.consecutiveFailCycles} failed cycles.`);
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
