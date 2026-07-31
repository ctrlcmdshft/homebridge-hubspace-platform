"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HubspacePlatform = void 0;
const types_1 = require("./types");
const hubspace_client_1 = require("./hubspace-client");
const utils_1 = require("./utils");
const accessory_1 = require("./accessory");
class HubspacePlatform {
    log;
    api;
    Service;
    Characteristic;
    handlers = new Map();
    cachedAccessories = new Map();
    client;
    debug;
    verbose;
    exposeStatusFault;
    invertOutletStatus;
    configured;
    pollTimer = null;
    consecutiveFailCycles = 0;
    pollFailureCounts = new Map();
    conclaveActive = false;
    pendingQuickPolls = new Set();
    conclaveIdMap = new Map();
    cfg;
    conclaveLog;
    pollLog;
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;
        this.cfg = config;
        this.debug = this.cfg.debug ?? this.cfg.verbose ?? false;
        this.verbose = this.cfg.verbose ?? false;
        this.exposeStatusFault = this.cfg.exposeStatusFault ?? false;
        this.invertOutletStatus = this.cfg.invertOutletStatus ?? false;
        this.conclaveLog = (0, utils_1.createLogger)(this.log, 'Conclave');
        this.pollLog = (0, utils_1.createLogger)(this.log, 'Poll');
        if (!this.cfg.username || !this.cfg.password) {
            this.log.warn('No credentials configured — open the plugin settings in the Homebridge UI ' +
                'and enter your Hubspace username and password, then restart Homebridge.');
            this.configured = false;
            this.client = null;
            this.api.on('didFinishLaunching', () => this.removeAllCachedAccessories());
            return;
        }
        this.configured = true;
        this.client = new hubspace_client_1.HubspaceClient(this.cfg.username, this.cfg.password, this.api.user.storagePath(), this.log, {
            tokenCachePath: this.cfg.tokenCachePath,
            debug: this.debug,
        });
        this.api.on('didFinishLaunching', () => this.onReady());
        this.api.on('shutdown', () => this.onShutdown());
        this.log.info('Platform initialised — waiting for Homebridge launch.');
    }
    configureAccessory(accessory) {
        this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
        this.cachedAccessories.set(accessory.UUID, accessory);
    }
    removeAllCachedAccessories() {
        const stale = [...this.cachedAccessories.values()];
        if (stale.length > 0) {
            this.api.unregisterPlatformAccessories(types_1.PLUGIN_NAME, types_1.PLATFORM_NAME, stale);
            this.log.info(`Removed ${stale.length} cached accessory(ies) — plugin is not configured.`);
        }
    }
    async onReady() {
        try {
            await this.client.initialize();
            await this.discoverDevices();
            if (!this.cfg.disableConclave) {
                this.conclaveActive = true;
                this.client.startConclave((deviceId) => this.scheduleQuickPoll(deviceId, 500), () => this.scheduleFullSweep(1_000));
                this.conclaveLog.info('Push connection started.');
            }
            this.startPolling();
        }
        catch (err) {
            this.log.error('Start-up failed:', String(err));
            this.log.warn('Falling back to cached accessories. ' +
                'Polling will not start until the API is reachable.');
            this.restoreCachedHandlers();
            setTimeout(() => this.onReady(), 120_000);
        }
    }
    onShutdown() {
        this.stopPolling();
        this.log.info('Shut down cleanly.');
    }
    async discoverDevices() {
        this.log.info('Discovering devices…');
        const devices = await this.client.getDevices();
        this.log.info(`Cloud returned ${devices.length} device(s).`);
        const seenUUIDs = new Set();
        const rawExcluded = this.cfg.excludedDevices;
        const excludedDevices = (Array.isArray(rawExcluded) ? rawExcluded : (rawExcluded ?? '').split(','))
            .map(name => name.trim())
            .filter(Boolean);
        const excludedLower = new Set(excludedDevices.map(name => name.toLowerCase()));
        const matchedExclusions = new Set();
        for (const device of devices) {
            const friendlyLower = device.friendlyName.toLowerCase();
            if (excludedLower.has(friendlyLower)) {
                matchedExclusions.add(friendlyLower);
                this.log.info(`Skipping excluded device: "${device.friendlyName}"`);
                continue;
            }
            if (!types_1.SUPPORTED_DEVICE_CLASSES.has(device.deviceClass.toLowerCase())) {
                const caps = [...new Set(device.values.map(v => v.functionClass))].join(', ') || 'none';
                const mfr = [device.manufacturerName, device.model].filter(Boolean).join(' / ') || 'unknown';
                this.log.warn(`Unsupported deviceClass "${device.deviceClass}" — "${device.friendlyName}" will not appear in HomeKit.\n` +
                    `  Hardware     : ${mfr}\n` +
                    `  Capabilities : ${caps}\n` +
                    `  To request support: https://github.com/ctrlcmdshft/homebridge-hubspace-platform/issues`);
                if (this.debug) {
                    for (const v of device.values) {
                        this.log.info(`  [debug] ${(0, utils_1.formatStateValueForLog)(v)}`);
                    }
                }
                continue;
            }
            const uuid = this.api.hap.uuid.generate(device.id);
            seenUUIDs.add(uuid);
            const existing = this.cachedAccessories.get(uuid);
            if (existing) {
                existing.context = this.buildContext(device);
                this.api.updatePlatformAccessories([existing]);
                const handler = (0, accessory_1.createAccessory)(this, existing, device);
                if (handler) {
                    this.handlers.set(device.id, handler);
                    this.log.info(`Restored: "${device.friendlyName}" (${device.deviceClass})`);
                    this.setupComfortBreezeCompanion(handler, device.id, seenUUIDs);
                    this.setupMasterPowerCompanion(handler, device.id, seenUUIDs);
                }
            }
            else {
                const pAccessory = new this.api.platformAccessory(device.friendlyName, uuid);
                pAccessory.context = this.buildContext(device);
                const handler = (0, accessory_1.createAccessory)(this, pAccessory, device);
                if (handler) {
                    this.handlers.set(device.id, handler);
                    this.api.registerPlatformAccessories(types_1.PLUGIN_NAME, types_1.PLATFORM_NAME, [pAccessory]);
                    this.log.info(`Registered: "${device.friendlyName}" (${device.deviceClass})`);
                    this.setupComfortBreezeCompanion(handler, device.id, seenUUIDs);
                    this.setupMasterPowerCompanion(handler, device.id, seenUUIDs);
                }
            }
        }
        for (const [uuid, pAccessory] of this.cachedAccessories) {
            if (!seenUUIDs.has(uuid)) {
                this.log.warn(`Removing stale accessory: "${pAccessory.displayName}"`);
                this.api.unregisterPlatformAccessories(types_1.PLUGIN_NAME, types_1.PLATFORM_NAME, [pAccessory]);
                this.cachedAccessories.delete(uuid);
            }
        }
        for (const name of excludedDevices) {
            if (!matchedExclusions.has(name.toLowerCase())) {
                this.log.warn(`excludedDevices entry "${name}" did not match any discovered device — check for a typo.`);
            }
        }
        this.log.info(`Discovery complete — ${this.handlers.size} accessory(ies) active.`);
    }
    restoreCachedHandlers() {
        for (const [, pAccessory] of this.cachedAccessories) {
            const ctx = pAccessory.context;
            if (!ctx?.deviceId || this.handlers.has(ctx.deviceId))
                continue;
            if (ctx.companionFor)
                continue;
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
            const handler = (0, accessory_1.createAccessory)(this, pAccessory, stub);
            if (handler)
                this.handlers.set(ctx.deviceId, handler);
        }
    }
    startPolling() {
        const defaultInterval = this.cfg.disableConclave ? 30 : 300;
        const raw = this.cfg.pollingInterval ?? defaultInterval;
        const intervalSecs = Math.min(600, Math.max(10, raw));
        const intervalMs = intervalSecs * 1000;
        this.log.info(`Starting state polling every ${intervalSecs}s.`);
        this.pollTimer = setInterval(() => this.pollDevices(), intervalMs);
        this.pollDevices();
    }
    stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }
    scheduleQuickPoll(conclaveId, delayMs) {
        const metadeviceId = this.resolveConclaveId(conclaveId);
        if (!metadeviceId) {
            if (/^[0-9a-f]{16}$/i.test(conclaveId)) {
                this.conclaveLog.debug(`Unresolved device ${conclaveId} — scheduling full sweep.`);
                this.scheduleFullSweep(delayMs);
            }
            return;
        }
        if (this.pendingQuickPolls.has(metadeviceId))
            return;
        this.pendingQuickPolls.add(metadeviceId);
        setTimeout(() => {
            this.pendingQuickPolls.delete(metadeviceId);
            const handler = this.handlers.get(metadeviceId);
            if (!handler)
                return;
            if (this.debug)
                this.conclaveLog.info(`Quick-poll → "${handler.device.friendlyName}"`);
            const allIds = handler.device.allIds ?? [metadeviceId];
            this.client.getDeviceState(allIds)
                .then(values => handler.updateState(values))
                .catch(err => this.log.warn(`Quick-poll failed for ${this.deviceLabel(metadeviceId, handler)}: ${this.formatPollError(err)}`));
        }, delayMs);
    }
    scheduleFullSweep(delayMs) {
        if (this.pendingQuickPolls.has('__sweep__'))
            return;
        this.pendingQuickPolls.add('__sweep__');
        setTimeout(() => {
            this.pendingQuickPolls.delete('__sweep__');
            if (this.debug)
                this.conclaveLog.info('Full sweep triggered by hub event.');
            this.pollDevices();
        }, delayMs);
    }
    resolveConclaveId(conclaveId) {
        if (this.handlers.has(conclaveId))
            return conclaveId;
        if (this.conclaveIdMap.has(conclaveId))
            return this.conclaveIdMap.get(conclaveId);
        const macSuffix = conclaveId.slice(-12).toLowerCase();
        for (const [metadeviceId, handler] of this.handlers) {
            const bleMac = handler.device.values
                .find(v => v.functionClass === 'ble-mac-address')
                ?.value;
            if (typeof bleMac === 'string' && bleMac.toLowerCase().replace(/:/g, '') === macSuffix) {
                this.conclaveIdMap.set(conclaveId, metadeviceId);
                if (this.debug)
                    this.conclaveLog.info(`Resolved ${conclaveId} → "${handler.device.friendlyName}"`);
                return metadeviceId;
            }
        }
        if (this.debug && /^[0-9a-f]{16}$/i.test(conclaveId)) {
            this.conclaveLog.info(`No BLE-MAC match for ${conclaveId} — treating as hub/gateway.`);
        }
        return undefined;
    }
    async pollDevices() {
        if (this.handlers.size === 0)
            return;
        this.log.debug(`Polling ${this.handlers.size} device(s)…`);
        const entries = [...this.handlers.entries()];
        const results = await Promise.allSettled(entries.map(async ([deviceId, handler]) => {
            const allIds = handler.device.allIds ?? [deviceId];
            const values = await this.client.getDeviceState(allIds);
            handler.updateState(values);
        }));
        let failCount = 0;
        results.forEach((r, i) => {
            const [deviceId, handler] = entries[i];
            if (r.status === 'rejected') {
                failCount++;
                handler.markPollFailed();
                this.logPollFailure(deviceId, handler, r.reason);
            }
            else {
                this.logPollRecovery(deviceId, handler);
            }
        });
        if (failCount > 0) {
            this.consecutiveFailCycles++;
            if (this.consecutiveFailCycles === 3) {
                this.pollLog.warn('API appears unreachable — suppressing repeated errors. Will log again when recovered.');
            }
            else if (this.consecutiveFailCycles < 3) {
                this.pollLog.warn(`${failCount} device(s) failed this cycle.`);
            }
        }
        else {
            if (this.consecutiveFailCycles >= 3) {
                this.pollLog.info(`API reachable again after ${this.consecutiveFailCycles} failed cycles.`);
            }
            this.consecutiveFailCycles = 0;
        }
    }
    logPollFailure(deviceId, handler, reason) {
        const failureCount = (this.pollFailureCounts.get(deviceId) ?? 0) + 1;
        this.pollFailureCounts.set(deviceId, failureCount);
        if (this.consecutiveFailCycles >= 3 || failureCount > 3)
            return;
        const label = this.deviceLabel(deviceId, handler);
        const error = this.formatPollError(reason);
        if (failureCount === 3) {
            this.pollLog.warn(`Failed for ${label}: ${error} — suppressing repeated errors until it recovers.`);
        }
        else {
            this.pollLog.warn(`Failed for ${label}: ${error}`);
        }
    }
    logPollRecovery(deviceId, handler) {
        const failureCount = this.pollFailureCounts.get(deviceId) ?? 0;
        if (failureCount >= 3) {
            this.pollLog.info(`${this.deviceLabel(deviceId, handler)} poll recovered after ${failureCount} failed attempt(s).`);
        }
        this.pollFailureCounts.delete(deviceId);
    }
    deviceLabel(deviceId, handler) {
        return `"${handler.device.friendlyName}" (${deviceId})`;
    }
    formatPollError(reason) {
        if (reason instanceof Error) {
            return reason.message;
        }
        return String(reason);
    }
    setupMasterPowerCompanion(handler, deviceId, seenUUIDs) {
        if (!this.cfg.exposeMasterPowerSwitch)
            return;
        if (!(handler instanceof accessory_1.FanAccessory) || !handler.hasMasterPower())
            return;
        const mpUUID = this.api.hap.uuid.generate(deviceId + '-mp');
        seenUUIDs.add(mpUUID);
        const existing = this.cachedAccessories.get(mpUUID);
        if (existing) {
            handler.setupMasterPowerCompanion(existing);
            this.log.info(`Restored Master Power companion for "${handler.device.friendlyName}"`);
        }
        else {
            const mpAcc = new this.api.platformAccessory('Master Power', mpUUID);
            mpAcc.context = { deviceId, deviceClass: 'master-power', typeId: '', friendlyName: 'Master Power', companionFor: deviceId };
            handler.setupMasterPowerCompanion(mpAcc);
            this.api.registerPlatformAccessories(types_1.PLUGIN_NAME, types_1.PLATFORM_NAME, [mpAcc]);
            this.log.info(`Registered Master Power companion for "${handler.device.friendlyName}"`);
        }
    }
    setupComfortBreezeCompanion(handler, deviceId, seenUUIDs) {
        if (!this.cfg.exposeComfortBreeze)
            return;
        if (!(handler instanceof accessory_1.FanAccessory) || !handler.hasComfortBreeze())
            return;
        const cbUUID = this.api.hap.uuid.generate(deviceId + '-cb');
        seenUUIDs.add(cbUUID);
        const existing = this.cachedAccessories.get(cbUUID);
        if (existing) {
            handler.setupComfortBreezeCompanion(existing);
            this.log.info(`Restored Comfort Breeze companion for "${handler.device.friendlyName}"`);
        }
        else {
            const cbAcc = new this.api.platformAccessory('Comfort Breeze', cbUUID);
            cbAcc.context = { deviceId, deviceClass: 'comfort-breeze', typeId: '', friendlyName: 'Comfort Breeze', companionFor: deviceId };
            handler.setupComfortBreezeCompanion(cbAcc);
            this.api.registerPlatformAccessories(types_1.PLUGIN_NAME, types_1.PLATFORM_NAME, [cbAcc]);
            this.log.info(`Registered Comfort Breeze companion for "${handler.device.friendlyName}"`);
        }
    }
    buildContext(device) {
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
exports.HubspacePlatform = HubspacePlatform;
//# sourceMappingURL=platform.js.map