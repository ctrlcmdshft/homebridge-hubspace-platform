"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LandscapeTransformerAccessory = exports.PortableAcAccessory = exports.MultiOutletAccessory = exports.OutletAccessory = exports.FanAccessory = exports.LightAccessory = exports.BaseHubspaceAccessory = void 0;
exports.createAccessory = createAccessory;
const axios_1 = require("axios");
const types_1 = require("./types");
const utils_1 = require("./utils");
class BaseHubspaceAccessory {
    platform;
    accessory;
    device;
    log;
    stateMap = new Map();
    colorTempCategories = new Map();
    offline = false;
    pollFails = 0;
    static OFFLINE_THRESHOLD = 3;
    availableOffline = true;
    constructor(platform, accessory, device) {
        this.platform = platform;
        this.accessory = accessory;
        this.device = device;
        this.log = (0, utils_1.createLogger)(platform.log, 'Device');
        this.rebuildStateMap(device.values);
        this.loadColorTempCategories(device.colorTempCategories);
        this.setupAccessoryInfo();
        this.setupServices();
    }
    setupAccessoryInfo() {
        const info = this.accessory.getService(this.platform.Service.AccessoryInformation)
            ?? this.accessory.addService(this.platform.Service.AccessoryInformation);
        const safeName = (s, fallback) => (s?.trim().length ?? 0) > 1 ? s.trim() : fallback;
        info
            .setCharacteristic(this.platform.Characteristic.Manufacturer, safeName(this.device.manufacturerName, 'Hubspace'))
            .setCharacteristic(this.platform.Characteristic.Model, safeName(this.device.model, this.device.typeId))
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
            .setCharacteristic(this.platform.Characteristic.Name, this.device.friendlyName);
    }
    rebuildStateMap(values) {
        this.stateMap.clear();
        for (const v of values) {
            this.stateMap.set(`${v.functionClass}:${v.functionInstance}`, v);
        }
    }
    findValue(functionClass, functionInstance) {
        for (const [, v] of this.stateMap) {
            if (v.functionClass !== functionClass)
                continue;
            if (functionInstance !== undefined && v.functionInstance !== functionInstance)
                continue;
            return v;
        }
        return undefined;
    }
    updateState(values) {
        const wasOffline = this.offline;
        this.pollFails = 0;
        this.rebuildStateMap(values);
        if (this.availableOffline) {
            const avail = this.findValue(types_1.FC.AVAILABLE);
            const isAvailable = avail === undefined
                || avail.value === true
                || avail.value === 'true'
                || avail.value === 1;
            this.offline = !isAvailable;
        }
        else {
            this.offline = false;
        }
        if (this.platform.verbose) {
            this.log.info(`State for "${this.device.friendlyName}": ` +
                values.map(utils_1.formatStateValueForLog).join(', '));
        }
        if (wasOffline && !this.offline) {
            this.log.info(`"${this.device.friendlyName}" is back online — clearing No Response.`);
        }
        else if (!wasOffline && this.offline) {
            this.log.warn(`"${this.device.friendlyName}" is offline (not available) — setting No Response.`);
        }
        this.pushCharacteristics();
    }
    markPollFailed() {
        this.pollFails++;
        if (this.pollFails >= BaseHubspaceAccessory.OFFLINE_THRESHOLD && !this.offline) {
            this.offline = true;
            this.log.warn(`"${this.device.friendlyName}" unreachable after ${this.pollFails} failed polls — setting No Response.`);
            this.pushCharacteristics();
        }
    }
    get noResponse() {
        return new this.platform.api.hap.HapStatusError(-70402);
    }
    getStatusFault() {
        if (this.offline)
            return this.platform.Characteristic.StatusFault.GENERAL_FAULT;
        for (const [key, v] of this.stateMap) {
            if (key.startsWith('error-flag:') && v.value === true) {
                return this.platform.Characteristic.StatusFault.GENERAL_FAULT;
            }
            if (key.startsWith('error:') && v.value !== 'normal') {
                return this.platform.Characteristic.StatusFault.GENERAL_FAULT;
            }
        }
        return this.platform.Characteristic.StatusFault.NO_FAULT;
    }
    pendingWrites = new Map();
    writeFlushTimer = null;
    writeInFlight = false;
    setDeviceValues(values) {
        this.applyOptimisticUpdate(values);
        for (const patch of values) {
            const key = `${patch.functionClass}:${patch.functionInstance ?? ''}`;
            this.pendingWrites.set(key, patch);
        }
        this.scheduleWriteFlush();
    }
    scheduleWriteFlush() {
        if (!this.writeFlushTimer) {
            this.writeFlushTimer = setTimeout(() => void this.flushWrites(), 0);
        }
    }
    async flushWrites() {
        this.writeFlushTimer = null;
        if (this.writeInFlight)
            return;
        if (this.pendingWrites.size === 0)
            return;
        const patches = [...this.pendingWrites.values()];
        this.pendingWrites.clear();
        this.writeInFlight = true;
        try {
            await this.platform.client.setDeviceState(this.device.id, patches);
            this.platform.scheduleQuickPoll(this.device.id, 3000);
        }
        catch (err) {
            if (await this.retryWithAllowedColorTemperature(err, patches)) {
                this.platform.scheduleQuickPoll(this.device.id, 3000);
                return;
            }
            const detail = (0, axios_1.isAxiosError)(err)
                ? `HTTP ${err.response?.status} — ${err.response?.data?.error ?? JSON.stringify(err.response?.data) ?? err.message}` +
                    (err.response?.data?.requestId ? ` (requestId: ${err.response.data.requestId})` : '')
                : String(err);
            const patchSummary = patches.map(p => `${p.functionClass}[${p.functionInstance}]=${JSON.stringify(p.value)}`).join(', ');
            this.log.error(`Failed to set state for "${this.device.friendlyName}": ${detail} | sent: ${patchSummary}`);
            this.platform.scheduleQuickPoll(this.device.id, 0);
        }
        finally {
            this.writeInFlight = false;
            if (this.pendingWrites.size > 0) {
                this.scheduleWriteFlush();
            }
        }
    }
    applyOptimisticUpdate(patches) {
        for (const patch of patches) {
            if (!patch.functionClass)
                continue;
            const key = `${patch.functionClass}:${patch.functionInstance}`;
            const existing = this.stateMap.get(key);
            if (existing) {
                this.stateMap.set(key, { ...existing, value: patch.value });
            }
            else {
                this.stateMap.set(key, patch);
            }
        }
        this.pushCharacteristics();
    }
    buildPatch(functionClass, value, functionInstance) {
        const existing = this.findValue(functionClass, functionInstance);
        return {
            functionClass,
            functionInstance: existing !== undefined ? existing.functionInstance : (functionInstance ?? 'primary'),
            value,
        };
    }
    colorTempPatchValue(kelvin, current) {
        const allowed = this.colorTempCategories.get(this.stateKey(types_1.FC.COLOR_TEMP, current?.functionInstance));
        if (allowed) {
            return this.nearestColorTempCategory(kelvin, allowed).value;
        }
        return (0, utils_1.formatKelvinForHubspace)(kelvin, current?.value);
    }
    async retryWithAllowedColorTemperature(err, patches) {
        if (!(0, axios_1.isAxiosError)(err) || err.response?.status !== 400)
            return false;
        const allowed = this.parseAllowedKelvinValues(err.response?.data?.error);
        if (allowed.length === 0)
            return false;
        let changed = false;
        const retryPatches = patches.map((patch) => {
            if (patch.functionClass !== types_1.FC.COLOR_TEMP)
                return patch;
            const requestedKelvin = (0, utils_1.parseKelvin)(patch.value);
            if (requestedKelvin === null)
                return patch;
            const snapped = this.nearestColorTempCategory(requestedKelvin, allowed);
            const retryPatch = {
                ...patch,
                value: snapped.value,
            };
            this.colorTempCategories.set(this.stateKey(types_1.FC.COLOR_TEMP, patch.functionInstance), allowed);
            changed = changed || retryPatch.value !== patch.value;
            return retryPatch;
        });
        if (!changed)
            return false;
        await this.platform.client.setDeviceState(this.device.id, retryPatches);
        this.applyOptimisticUpdate(retryPatches);
        if (this.platform.debug) {
            this.log.info(`Retried color-temperature for "${this.device.friendlyName}" with nearest supported value: ` +
                retryPatches
                    .filter(p => p.functionClass === types_1.FC.COLOR_TEMP)
                    .map(p => `${p.functionClass}[${p.functionInstance}]=${JSON.stringify(p.value)}`)
                    .join(', '));
        }
        return true;
    }
    parseAllowedKelvinValues(error) {
        if (typeof error !== 'string' || !error.includes('color-temperature'))
            return [];
        const values = new Map();
        const re = /\bname=([0-9]+(?:\.[0-9]+)?)\s*K\b/gi;
        let match;
        while ((match = re.exec(error)) !== null) {
            const kelvin = Number(match[1]);
            if (Number.isFinite(kelvin))
                values.set(kelvin, `${match[1]}K`);
        }
        return [...values.entries()]
            .map(([kelvin, value]) => ({ kelvin, value }))
            .sort((a, b) => a.kelvin - b.kelvin);
    }
    nearestColorTempCategory(kelvin, allowed) {
        return allowed.reduce((nearest, candidate) => Math.abs(candidate.kelvin - kelvin) < Math.abs(nearest.kelvin - kelvin) ? candidate : nearest, allowed[0]);
    }
    loadColorTempCategories(categories) {
        for (const [instance, values] of Object.entries(categories ?? {})) {
            const parsed = values
                .map(value => ({ kelvin: (0, utils_1.parseKelvin)(value), value }))
                .filter((item) => item.kelvin !== null);
            if (parsed.length > 0) {
                this.colorTempCategories.set(this.stateKey(types_1.FC.COLOR_TEMP, instance === 'undefined' ? undefined : instance), parsed);
            }
        }
    }
    stateKey(functionClass, functionInstance) {
        return `${functionClass}:${functionInstance}`;
    }
}
exports.BaseHubspaceAccessory = BaseHubspaceAccessory;
class LightAccessory extends BaseHubspaceAccessory {
    pendingHue = null;
    pendingSat = null;
    setupServices() {
        this.svc =
            this.accessory.getService(this.platform.Service.Lightbulb) ??
                this.accessory.addService(this.platform.Service.Lightbulb, this.device.friendlyName);
        this.svc.getCharacteristic(this.platform.Characteristic.On)
            .onGet(() => {
            if (this.offline)
                throw this.noResponse;
            return this.getPower();
        })
            .onSet((v) => { void this.setPower(v); });
        if (this.findValue(types_1.FC.BRIGHTNESS)) {
            this.svc.getCharacteristic(this.platform.Characteristic.Brightness)
                .onGet(() => {
                if (this.offline)
                    throw this.noResponse;
                return this.getBrightness();
            })
                .onSet((v) => { void this.setBrightness(v); });
        }
        if (this.findValue(types_1.FC.COLOR_TEMP)) {
            const minK = 2700, maxK = 6500;
            this.svc.getCharacteristic(this.platform.Characteristic.ColorTemperature)
                .setProps({ minValue: (0, utils_1.kelvinToMired)(maxK), maxValue: (0, utils_1.kelvinToMired)(minK) })
                .onGet(() => {
                if (this.offline)
                    throw this.noResponse;
                return this.getColorTemp();
            })
                .onSet((v) => { void this.setColorTemp(v); });
        }
        if (this.findValue(types_1.FC.COLOR_RGB)) {
            this.svc.getCharacteristic(this.platform.Characteristic.Hue)
                .onGet(() => {
                if (this.offline)
                    throw this.noResponse;
                return this.getHue();
            })
                .onSet((v) => { void this.setPendingHue(v); });
            this.svc.getCharacteristic(this.platform.Characteristic.Saturation)
                .onGet(() => {
                if (this.offline)
                    throw this.noResponse;
                return this.getSaturation();
            })
                .onSet((v) => { void this.setPendingSat(v); });
        }
        if (this.platform.exposeStatusFault) {
            this.svc.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);
            this.svc.getCharacteristic(this.platform.Characteristic.StatusFault)
                .onGet(() => this.getStatusFault());
        }
    }
    getPower() {
        const v = this.findValue(types_1.FC.POWER);
        return v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
    }
    getBrightness() {
        const v = this.findValue(types_1.FC.BRIGHTNESS);
        return v ? Math.round(Number(v.value)) : 100;
    }
    getColorTemp() {
        const v = this.findValue(types_1.FC.COLOR_TEMP);
        if (!v)
            return 370;
        const kelvin = (0, utils_1.parseKelvin)(v.value);
        if (kelvin === null)
            return 370;
        const minMired = (0, utils_1.kelvinToMired)(6500);
        const maxMired = (0, utils_1.kelvinToMired)(2700);
        return Math.min(maxMired, Math.max(minMired, (0, utils_1.kelvinToMired)(kelvin)));
    }
    getHue() {
        const v = this.findValue(types_1.FC.COLOR_RGB);
        if (!v)
            return 0;
        return (0, utils_1.rgbToHsv)(...(0, utils_1.parseColorRgb)(v.value))[0];
    }
    getSaturation() {
        const v = this.findValue(types_1.FC.COLOR_RGB);
        if (!v)
            return 0;
        return (0, utils_1.rgbToHsv)(...(0, utils_1.parseColorRgb)(v.value))[1];
    }
    async setPower(on) {
        this.setDeviceValues([this.buildPatch(types_1.FC.POWER, on ? 'on' : 'off')]);
    }
    brightnessTimer = null;
    async setBrightness(value) {
        if (this.brightnessTimer)
            clearTimeout(this.brightnessTimer);
        this.brightnessTimer = setTimeout(async () => {
            const rounded = Math.round(value);
            const patches = [
                this.buildPatch(types_1.FC.BRIGHTNESS, rounded),
            ];
            if (rounded > 0 && !this.getPower()) {
                patches.push(this.buildPatch(types_1.FC.POWER, 'on'));
            }
            this.setDeviceValues(patches);
        }, 300);
    }
    colorTempTimer = null;
    async setColorTemp(mireds) {
        if (this.colorTempTimer)
            clearTimeout(this.colorTempTimer);
        this.colorTempTimer = setTimeout(async () => {
            const k = (0, utils_1.miredToKelvin)(mireds);
            const current = this.findValue(types_1.FC.COLOR_TEMP);
            const patches = [
                this.buildPatch(types_1.FC.COLOR_TEMP, this.colorTempPatchValue(k, current)),
            ];
            if (this.findValue(types_1.FC.COLOR_MODE)) {
                patches.push(this.buildPatch(types_1.FC.COLOR_MODE, 'white'));
            }
            this.setDeviceValues(patches);
        }, 300);
    }
    async setPendingHue(h) {
        this.pendingHue = h;
        await this.flushColor();
    }
    async setPendingSat(s) {
        this.pendingSat = s;
        await this.flushColor();
    }
    flushColorTimer = null;
    async flushColor() {
        if (this.flushColorTimer)
            clearTimeout(this.flushColorTimer);
        this.flushColorTimer = setTimeout(async () => {
            const h = this.pendingHue ?? this.getHue();
            const s = this.pendingSat ?? this.getSaturation();
            const brightness = this.getBrightness();
            const [r, g, b] = (0, utils_1.hsvToRgb)(h, s, brightness);
            const rgbPatch = this.buildPatch(types_1.FC.COLOR_RGB, '');
            rgbPatch.value = { 'color-rgb': { r, g, b } };
            const patches = [rgbPatch];
            if (this.findValue(types_1.FC.COLOR_MODE)) {
                patches.push(this.buildPatch(types_1.FC.COLOR_MODE, 'color'));
            }
            this.setDeviceValues(patches);
            this.pendingHue = null;
            this.pendingSat = null;
        }, 150);
    }
    pushCharacteristics() {
        if (this.platform.exposeStatusFault) {
            this.svc.updateCharacteristic(this.platform.Characteristic.StatusFault, this.getStatusFault());
        }
        if (this.offline) {
            this.svc.updateCharacteristic(this.platform.Characteristic.On, this.noResponse);
            return;
        }
        this.svc.updateCharacteristic(this.platform.Characteristic.On, this.getPower());
        if (this.findValue(types_1.FC.BRIGHTNESS)) {
            this.svc.updateCharacteristic(this.platform.Characteristic.Brightness, this.getBrightness());
        }
        if (this.findValue(types_1.FC.COLOR_TEMP)) {
            this.svc.updateCharacteristic(this.platform.Characteristic.ColorTemperature, this.getColorTemp());
        }
        if (this.findValue(types_1.FC.COLOR_RGB)) {
            this.svc.updateCharacteristic(this.platform.Characteristic.Hue, this.getHue());
            this.svc.updateCharacteristic(this.platform.Characteristic.Saturation, this.getSaturation());
        }
    }
}
exports.LightAccessory = LightAccessory;
class FanAccessory extends BaseHubspaceAccessory {
    cbAcc = null;
    mpAcc = null;
    rememberedFanSpeedValue = null;
    restoreFanSpeedValue = null;
    restoreFanSpeedTimer = null;
    suppressTurnOnSpeedPercent = null;
    suppressTurnOnSpeedTimer = null;
    setupServices() {
        this.lightSvc = null;
        this.fanSvc =
            this.accessory.getService(this.platform.Service.Fanv2) ??
                this.accessory.addService(this.platform.Service.Fanv2, this.device.friendlyName);
        const fanPower = this.findFanPowerValue();
        this.fanSvc.getCharacteristic(this.platform.Characteristic.Active)
            .onGet(() => {
            if (this.offline)
                throw this.noResponse;
            return this.getFanActive();
        })
            .onSet((v) => { void this.setFanActive(v, fanPower?.functionInstance); });
        if (this.findValue(types_1.FC.FAN_SPEED)) {
            this.rememberCurrentFanSpeed();
            this.fanSvc.getCharacteristic(this.platform.Characteristic.RotationSpeed)
                .updateValue(this.getFanSpeed())
                .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
                .onGet(() => {
                if (this.offline)
                    throw this.noResponse;
                return this.getFanSpeed();
            })
                .onSet((v) => { void this.setFanSpeed(v); });
        }
        if (this.findValue(types_1.FC.FAN_REVERSE)) {
            this.fanSvc.getCharacteristic(this.platform.Characteristic.RotationDirection)
                .onGet(() => {
                if (this.offline)
                    throw this.noResponse;
                return this.getFanDirection();
            })
                .onSet((v) => { void this.setFanDirection(v); });
        }
        if (this.platform.exposeStatusFault) {
            this.fanSvc.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);
            this.fanSvc.getCharacteristic(this.platform.Characteristic.StatusFault)
                .onGet(() => this.getStatusFault());
        }
        const lightPower = this.findValue(types_1.FC.POWER, 'light-power');
        const hasBrightness = this.findValue(types_1.FC.BRIGHTNESS) !== undefined;
        const hasColorTemp = this.findValue(types_1.FC.COLOR_TEMP) !== undefined;
        if (lightPower) {
            this.lightSvc =
                this.accessory.getService(this.platform.Service.Lightbulb) ??
                    this.accessory.addService(this.platform.Service.Lightbulb, `${this.device.friendlyName} Light`);
            this.lightSvc.getCharacteristic(this.platform.Characteristic.On)
                .onGet(() => {
                if (this.offline)
                    throw this.noResponse;
                return this.getLightPower();
            })
                .onSet((v) => { void this.setLightPower(v); });
            if (hasBrightness) {
                this.lightSvc.getCharacteristic(this.platform.Characteristic.Brightness)
                    .onGet(() => {
                    if (this.offline)
                        throw this.noResponse;
                    return this.getLightBrightness();
                })
                    .onSet((v) => { void this.setLightBrightness(v); });
            }
            if (hasColorTemp) {
                const minK = 2700, maxK = 6500;
                this.lightSvc.getCharacteristic(this.platform.Characteristic.ColorTemperature)
                    .setProps({ minValue: (0, utils_1.kelvinToMired)(maxK), maxValue: (0, utils_1.kelvinToMired)(minK) })
                    .onGet(() => {
                    if (this.offline)
                        throw this.noResponse;
                    return this.getLightColorTemp();
                })
                    .onSet((v) => { void this.setLightColorTemp(v); });
            }
        }
    }
    updateState(values) {
        const incomingPower = this.findFanPowerValueIn(values);
        const incomingActive = incomingPower?.value === 'on'
            || incomingPower?.value === 'true'
            || incomingPower?.value === true
            || incomingPower?.value === 1;
        const incomingSpeed = values.find(v => v.functionClass === types_1.FC.FAN_SPEED);
        if (incomingSpeed && incomingActive && !this.isRestoringDifferentFanSpeed(incomingSpeed.value)) {
            this.rememberFanSpeed(incomingSpeed.value);
        }
        super.updateState(values);
    }
    findFanPowerValue() {
        return (this.findValue(types_1.FC.POWER, 'fan-power') ??
            this.findValue(types_1.FC.POWER, 'primary') ??
            this.findValue(types_1.FC.POWER));
    }
    findFanPowerValueIn(values) {
        return (values.find(v => v.functionClass === types_1.FC.POWER && v.functionInstance === 'fan-power') ??
            values.find(v => v.functionClass === types_1.FC.POWER && v.functionInstance === 'primary') ??
            values.find(v => v.functionClass === types_1.FC.POWER));
    }
    getFanActive() {
        const v = this.findFanPowerValue();
        const on = v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
        return on
            ? this.platform.Characteristic.Active.ACTIVE
            : this.platform.Characteristic.Active.INACTIVE;
    }
    async setFanActive(hkActive, instance) {
        const on = hkActive === this.platform.Characteristic.Active.ACTIVE;
        const wasInactive = this.getFanActive() === this.platform.Characteristic.Active.INACTIVE;
        const patches = [
            this.buildPatch(types_1.FC.POWER, on ? 'on' : 'off', instance),
        ];
        if (on && wasInactive) {
            const storedSpeedPatch = this.buildRememberedFanSpeedPatch();
            const storedSpeed = storedSpeedPatch
                ? (0, utils_1.hubspeedToPercent)(String(storedSpeedPatch.value))
                : 0;
            if (storedSpeedPatch) {
                patches.push(storedSpeedPatch);
                this.scheduleFanSpeedRestore(storedSpeedPatch.value);
            }
            if (storedSpeed > 0 && storedSpeed < 100) {
                this.suppressTurnOnSpeedPercent = 100;
                if (this.suppressTurnOnSpeedTimer)
                    clearTimeout(this.suppressTurnOnSpeedTimer);
                this.suppressTurnOnSpeedTimer = setTimeout(() => {
                    this.suppressTurnOnSpeedPercent = null;
                    this.suppressTurnOnSpeedTimer = null;
                }, 1000);
            }
        }
        else {
            this.clearSuppressedTurnOnSpeed();
            this.clearFanSpeedRestore();
        }
        this.setDeviceValues(patches);
    }
    getStoredFanSpeed() {
        if (this.restoreFanSpeedValue !== null) {
            return (0, utils_1.hubspeedToPercent)(String(this.restoreFanSpeedValue));
        }
        const v = this.findValue(types_1.FC.FAN_SPEED);
        return v ? (0, utils_1.hubspeedToPercent)(String(v.value)) : 50;
    }
    getFanSpeed() {
        if (this.getFanActive() === this.platform.Characteristic.Active.INACTIVE) {
            return this.rememberedFanSpeedValue !== null
                ? (0, utils_1.hubspeedToPercent)(String(this.rememberedFanSpeedValue))
                : 0;
        }
        return this.getStoredFanSpeed();
    }
    async setFanSpeed(percent) {
        if (percent === 0) {
            this.clearSuppressedTurnOnSpeed();
            const fanPower = this.findFanPowerValue();
            this.setDeviceValues([this.buildPatch(types_1.FC.POWER, 'off', fanPower?.functionInstance)]);
            return;
        }
        const rememberedSpeed = this.rememberedFanSpeedValue === null
            ? 0
            : (0, utils_1.hubspeedToPercent)(String(this.rememberedFanSpeedValue));
        if (this.getFanActive() === this.platform.Characteristic.Active.INACTIVE
            && percent === 100
            && rememberedSpeed > 0
            && rememberedSpeed < 100) {
            this.fanSvc.updateCharacteristic(this.platform.Characteristic.RotationSpeed, rememberedSpeed);
            return;
        }
        if (this.suppressTurnOnSpeedPercent === percent) {
            this.clearSuppressedTurnOnSpeed();
            this.fanSvc.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.getStoredFanSpeed());
            return;
        }
        this.clearSuppressedTurnOnSpeed();
        const current = this.findValue(types_1.FC.FAN_SPEED);
        const raw = (0, utils_1.percentToHubspeed)(percent, String(current?.value ?? 'low'));
        if (this.restoreFanSpeedValue !== null
            && (0, utils_1.hubspeedToPercent)(String(raw)) === (0, utils_1.hubspeedToPercent)(String(this.restoreFanSpeedValue))) {
            this.rememberFanSpeed(raw);
            return;
        }
        this.clearFanSpeedRestore();
        this.rememberFanSpeed(raw);
        this.setDeviceValues([this.buildPatch(types_1.FC.FAN_SPEED, raw)]);
    }
    rememberCurrentFanSpeed() {
        const current = this.findValue(types_1.FC.FAN_SPEED);
        if (current) {
            this.rememberFanSpeed(current.value);
        }
    }
    rememberFanSpeed(value) {
        if ((0, utils_1.hubspeedToPercent)(String(value)) > 0) {
            this.rememberedFanSpeedValue = value;
        }
    }
    buildRememberedFanSpeedPatch() {
        const current = this.findValue(types_1.FC.FAN_SPEED);
        const value = this.rememberedFanSpeedValue ?? current?.value;
        if (value === undefined || value === null || (0, utils_1.hubspeedToPercent)(String(value)) <= 0) {
            return null;
        }
        return this.buildPatch(types_1.FC.FAN_SPEED, value, current?.functionInstance);
    }
    scheduleFanSpeedRestore(value) {
        this.restoreFanSpeedValue = value;
        if (this.restoreFanSpeedTimer)
            clearTimeout(this.restoreFanSpeedTimer);
        this.restoreFanSpeedTimer = setTimeout(() => {
            const patch = this.buildRememberedFanSpeedPatch();
            if (patch) {
                this.setDeviceValues([patch]);
            }
            this.clearFanSpeedRestore();
        }, 1200);
    }
    clearFanSpeedRestore() {
        this.restoreFanSpeedValue = null;
        if (this.restoreFanSpeedTimer) {
            clearTimeout(this.restoreFanSpeedTimer);
            this.restoreFanSpeedTimer = null;
        }
    }
    isRestoringDifferentFanSpeed(value) {
        return this.restoreFanSpeedValue !== null
            && (0, utils_1.hubspeedToPercent)(String(value)) !== (0, utils_1.hubspeedToPercent)(String(this.restoreFanSpeedValue));
    }
    clearSuppressedTurnOnSpeed() {
        this.suppressTurnOnSpeedPercent = null;
        if (this.suppressTurnOnSpeedTimer) {
            clearTimeout(this.suppressTurnOnSpeedTimer);
            this.suppressTurnOnSpeedTimer = null;
        }
    }
    getFanDirection() {
        const v = this.findValue(types_1.FC.FAN_REVERSE);
        return v?.value === 'reverse'
            ? this.platform.Characteristic.RotationDirection.COUNTER_CLOCKWISE
            : this.platform.Characteristic.RotationDirection.CLOCKWISE;
    }
    async setFanDirection(hkDirection) {
        const reverse = hkDirection === this.platform.Characteristic.RotationDirection.COUNTER_CLOCKWISE;
        this.setDeviceValues([
            this.buildPatch(types_1.FC.FAN_REVERSE, reverse ? 'reverse' : 'forward', 'fan-reverse'),
        ]);
    }
    hasMasterPower() {
        return (this.findValue(types_1.FC.POWER, 'primary') !== undefined &&
            this.findValue(types_1.FC.POWER, 'fan-power') !== undefined);
    }
    setupMasterPowerCompanion(pAcc) {
        this.mpAcc = pAcc;
        const svc = pAcc.getService(this.platform.Service.Switch) ??
            pAcc.addService(this.platform.Service.Switch, 'Master Power');
        svc.getCharacteristic(this.platform.Characteristic.On)
            .onGet(() => this.getMasterPower())
            .onSet((v) => { void this.setMasterPower(v); });
    }
    getMasterPower() {
        const v = this.findValue(types_1.FC.POWER, 'primary');
        return v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
    }
    async setMasterPower(on) {
        this.setDeviceValues([this.buildPatch(types_1.FC.POWER, on ? 'on' : 'off', 'primary')]);
    }
    hasComfortBreeze() {
        return this.findValue(types_1.FC.TOGGLE, 'comfort-breeze') !== undefined;
    }
    setupComfortBreezeCompanion(pAcc) {
        this.cbAcc = pAcc;
        const svc = pAcc.getService(this.platform.Service.Switch) ??
            pAcc.addService(this.platform.Service.Switch, 'Comfort Breeze');
        svc.getCharacteristic(this.platform.Characteristic.On)
            .onGet(() => this.getComfortBreeze())
            .onSet((v) => { void this.setComfortBreeze(v); });
    }
    getComfortBreeze() {
        const v = this.findValue(types_1.FC.TOGGLE, 'comfort-breeze');
        return v?.value === 'enabled' || v?.value === true || v?.value === 1;
    }
    async setComfortBreeze(on) {
        this.setDeviceValues([
            this.buildPatch(types_1.FC.TOGGLE, on ? 'enabled' : 'disabled', 'comfort-breeze'),
        ]);
    }
    getLightPower() {
        const v = this.findValue(types_1.FC.POWER, 'light-power');
        return v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
    }
    async setLightPower(on) {
        this.setDeviceValues([
            this.buildPatch(types_1.FC.POWER, on ? 'on' : 'off', 'light-power'),
        ]);
    }
    getLightBrightness() {
        const v = this.findValue(types_1.FC.BRIGHTNESS, 'light-brightness') ?? this.findValue(types_1.FC.BRIGHTNESS);
        return v ? Math.round(Number(v.value)) : 100;
    }
    lightBrightnessTimer = null;
    async setLightBrightness(value) {
        if (this.lightBrightnessTimer)
            clearTimeout(this.lightBrightnessTimer);
        this.lightBrightnessTimer = setTimeout(async () => {
            const rounded = Math.round(value);
            const current = this.findValue(types_1.FC.BRIGHTNESS, 'light-brightness') ?? this.findValue(types_1.FC.BRIGHTNESS);
            const patches = [
                this.buildPatch(types_1.FC.BRIGHTNESS, rounded, current?.functionInstance),
            ];
            if (rounded > 0 && !this.getLightPower()) {
                patches.push(this.buildPatch(types_1.FC.POWER, 'on', 'light-power'));
            }
            this.setDeviceValues(patches);
        }, 300);
    }
    getLightColorTemp() {
        const v = this.findValue(types_1.FC.COLOR_TEMP);
        if (!v)
            return 370;
        const kelvin = (0, utils_1.parseKelvin)(v.value);
        if (kelvin === null)
            return 370;
        const minMired = (0, utils_1.kelvinToMired)(6500);
        const maxMired = (0, utils_1.kelvinToMired)(2700);
        return Math.min(maxMired, Math.max(minMired, (0, utils_1.kelvinToMired)(kelvin)));
    }
    lightColorTempTimer = null;
    async setLightColorTemp(mireds) {
        if (this.lightColorTempTimer)
            clearTimeout(this.lightColorTempTimer);
        this.lightColorTempTimer = setTimeout(async () => {
            const k = (0, utils_1.miredToKelvin)(mireds);
            const current = this.findValue(types_1.FC.COLOR_TEMP);
            const patches = [
                this.buildPatch(types_1.FC.COLOR_TEMP, this.colorTempPatchValue(k, current), current?.functionInstance),
            ];
            if (!this.getLightPower()) {
                patches.push(this.buildPatch(types_1.FC.POWER, 'on', 'light-power'));
            }
            this.setDeviceValues(patches);
        }, 300);
    }
    pushCharacteristics() {
        if (this.platform.exposeStatusFault) {
            this.fanSvc.updateCharacteristic(this.platform.Characteristic.StatusFault, this.getStatusFault());
        }
        if (this.offline) {
            this.fanSvc.updateCharacteristic(this.platform.Characteristic.Active, this.noResponse);
            this.lightSvc?.updateCharacteristic(this.platform.Characteristic.On, this.noResponse);
            return;
        }
        this.fanSvc.updateCharacteristic(this.platform.Characteristic.Active, this.getFanActive());
        if (this.findValue(types_1.FC.FAN_SPEED)) {
            this.fanSvc.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.getFanSpeed());
        }
        if (this.findValue(types_1.FC.FAN_REVERSE)) {
            this.fanSvc.updateCharacteristic(this.platform.Characteristic.RotationDirection, this.getFanDirection());
        }
        if (this.lightSvc) {
            this.lightSvc.updateCharacteristic(this.platform.Characteristic.On, this.getLightPower());
            if (this.findValue(types_1.FC.BRIGHTNESS)) {
                this.lightSvc.updateCharacteristic(this.platform.Characteristic.Brightness, this.getLightBrightness());
            }
            if (this.findValue(types_1.FC.COLOR_TEMP)) {
                this.lightSvc.updateCharacteristic(this.platform.Characteristic.ColorTemperature, this.getLightColorTemp());
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
exports.FanAccessory = FanAccessory;
class OutletAccessory extends BaseHubspaceAccessory {
    setupServices() {
        const useOutletService = ['outlet', 'plug', 'power-outlet'].includes(this.device.deviceClass.toLowerCase());
        const ServiceType = useOutletService
            ? this.platform.Service.Outlet
            : this.platform.Service.Switch;
        this.svc =
            this.accessory.getService(ServiceType) ??
                this.accessory.addService(ServiceType, this.device.friendlyName);
        this.svc.getCharacteristic(this.platform.Characteristic.On)
            .onGet(() => {
            if (this.offline)
                throw this.noResponse;
            return this.getPower();
        })
            .onSet((v) => { void this.setPower(v); });
        if (useOutletService) {
            this.svc.getCharacteristic(this.platform.Characteristic.OutletInUse)
                .onGet(() => {
                if (this.offline)
                    throw this.noResponse;
                return this.getPower();
            });
        }
        this.svc.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);
        this.svc.getCharacteristic(this.platform.Characteristic.StatusFault)
            .onGet(() => this.getStatusFault());
    }
    getPower() {
        const v = this.findValue(types_1.FC.POWER) ?? this.findValue(types_1.FC.TOGGLE);
        const raw = v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
        return this.platform.invertOutletStatus ? !raw : raw;
    }
    async setPower(on) {
        const fc = this.findValue(types_1.FC.POWER) ? types_1.FC.POWER : types_1.FC.TOGGLE;
        const send = this.platform.invertOutletStatus ? !on : on;
        this.setDeviceValues([this.buildPatch(fc, send ? 'on' : 'off')]);
    }
    pushCharacteristics() {
        this.svc.updateCharacteristic(this.platform.Characteristic.StatusFault, this.getStatusFault());
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
exports.OutletAccessory = OutletAccessory;
class MultiOutletAccessory extends BaseHubspaceAccessory {
    get outletInstances() {
        const instances = [];
        for (const [, v] of this.stateMap) {
            if (v.functionClass === types_1.FC.TOGGLE && /^outlet-\d+$/.test(v.functionInstance ?? '')) {
                instances.push(v.functionInstance);
            }
        }
        return instances.sort();
    }
    setupServices() {
        this.outletServices = new Map();
        for (const instance of this.outletInstances) {
            const label = instance.replace(/^outlet-(\d+)$/, 'Outlet $1');
            const svc = this.accessory.services.find(s => s.subtype === instance) ??
                this.accessory.addService(this.platform.Service.Outlet, label, instance);
            svc.getCharacteristic(this.platform.Characteristic.On)
                .onGet(() => {
                if (this.offline)
                    throw this.noResponse;
                return this.getPowerForOutlet(instance);
            })
                .onSet((v) => { void this.setPowerForOutlet(instance, v); });
            svc.getCharacteristic(this.platform.Characteristic.OutletInUse)
                .onGet(() => {
                if (this.offline)
                    throw this.noResponse;
                return this.getPowerForOutlet(instance);
            });
            this.outletServices.set(instance, svc);
        }
    }
    getPowerForOutlet(instance) {
        const v = this.findValue(types_1.FC.TOGGLE, instance);
        return v?.value === 'on' || v?.value === 'true' || v?.value === true || v?.value === 1;
    }
    async setPowerForOutlet(instance, on) {
        this.setDeviceValues([this.buildPatch(types_1.FC.TOGGLE, on ? 'on' : 'off', instance)]);
    }
    pushCharacteristics() {
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
exports.MultiOutletAccessory = MultiOutletAccessory;
class PortableAcAccessory extends BaseHubspaceAccessory {
    suppressTurnOnSpeedPercent = null;
    suppressTurnOnSpeedTimer = null;
    setupServices() {
        this.svc =
            this.accessory.getService(this.platform.Service.HeaterCooler) ??
                this.accessory.addService(this.platform.Service.HeaterCooler, this.device.friendlyName);
        this.svc.getCharacteristic(this.platform.Characteristic.Active)
            .onGet(() => {
            if (this.offline)
                throw this.noResponse;
            return this.getActive();
        })
            .onSet((v) => { void this.setActive(v); });
        this.svc.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
            .onGet(() => {
            if (this.offline)
                throw this.noResponse;
            return this.getCurrentHeaterCoolerState();
        });
        this.svc.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
            .setProps({ validValues: [
                this.platform.Characteristic.TargetHeaterCoolerState.COOL,
            ] })
            .onGet(() => {
            if (this.offline)
                throw this.noResponse;
            return this.getTargetHeaterCoolerState();
        })
            .onSet((v) => { void this.setTargetHeaterCoolerState(v); });
        this.svc.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .onGet(() => {
            if (this.offline)
                throw this.noResponse;
            return this.getCurrentTemperature();
        });
        if (this.findValue(types_1.FC.TEMPERATURE, 'cooling-target')) {
            this.svc.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
                .onGet(() => {
                if (this.offline)
                    throw this.noResponse;
                return this.getCoolingTarget();
            })
                .onSet((v) => { void this.setCoolingTarget(v); });
        }
        if (this.findValue(types_1.FC.FAN_SPEED)) {
            this.svc.getCharacteristic(this.platform.Characteristic.RotationSpeed)
                .setProps({ minValue: 33, maxValue: 100, minStep: 33 })
                .onGet(() => {
                if (this.offline)
                    throw this.noResponse;
                return this.getAcFanSpeed();
            })
                .onSet((v) => { void this.setAcFanSpeed(v); });
        }
        this.svc.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);
        this.svc.getCharacteristic(this.platform.Characteristic.StatusFault)
            .onGet(() => this.getStatusFault());
    }
    getActive() {
        const v = this.findValue(types_1.FC.POWER);
        const on = v?.value === 'on' || v?.value === true || v?.value === 1;
        return on
            ? this.platform.Characteristic.Active.ACTIVE
            : this.platform.Characteristic.Active.INACTIVE;
    }
    getCurrentHeaterCoolerState() {
        const { CurrentHeaterCoolerState } = this.platform.Characteristic;
        if (this.getActive() === this.platform.Characteristic.Active.INACTIVE) {
            return CurrentHeaterCoolerState.INACTIVE;
        }
        return CurrentHeaterCoolerState.COOLING;
    }
    getTargetHeaterCoolerState() {
        return this.platform.Characteristic.TargetHeaterCoolerState.COOL;
    }
    getCurrentTemperature() {
        const v = this.findValue(types_1.FC.TEMPERATURE, 'current-temp');
        return v !== undefined ? Number(v.value) : 20;
    }
    getCoolingTarget() {
        const v = this.findValue(types_1.FC.TEMPERATURE, 'cooling-target');
        return v !== undefined ? Number(v.value) : 24;
    }
    getAcFanSpeed() {
        return this.getStoredAcFanSpeed();
    }
    getStoredAcFanSpeed() {
        const v = this.findValue(types_1.FC.FAN_SPEED);
        return v ? (0, utils_1.hubspeedToPercent)(String(v.value)) : 33;
    }
    async setActive(hkActive) {
        const on = hkActive === this.platform.Characteristic.Active.ACTIVE;
        const currentlyActive = this.getActive() === this.platform.Characteristic.Active.ACTIVE;
        const wasInactive = !currentlyActive;
        if (on === currentlyActive) {
            this.clearSuppressedTurnOnSpeed();
            return;
        }
        if (on && wasInactive) {
            const storedSpeed = this.getStoredAcFanSpeed();
            if (storedSpeed > 0 && storedSpeed < 99) {
                this.suppressTurnOnSpeedPercent = 99;
                if (this.suppressTurnOnSpeedTimer)
                    clearTimeout(this.suppressTurnOnSpeedTimer);
                this.suppressTurnOnSpeedTimer = setTimeout(() => {
                    this.suppressTurnOnSpeedPercent = null;
                    this.suppressTurnOnSpeedTimer = null;
                }, 1000);
            }
        }
        else {
            this.clearSuppressedTurnOnSpeed();
        }
        this.setDeviceValues([this.buildPatch(types_1.FC.POWER, on ? 'on' : 'off')]);
    }
    async setTargetHeaterCoolerState(_hkState) {
        this.setDeviceValues([this.buildPatch(types_1.FC.MODE, 'cool')]);
    }
    coolingTargetTimer = null;
    async setCoolingTarget(celsius) {
        if (this.coolingTargetTimer)
            clearTimeout(this.coolingTargetTimer);
        this.coolingTargetTimer = setTimeout(() => {
            this.setDeviceValues([
                this.buildPatch(types_1.FC.TEMPERATURE, Math.round(celsius), 'cooling-target'),
            ]);
        }, 300);
    }
    async setAcFanSpeed(percent) {
        const requestedPercent = percent <= 0 ? 33 : percent;
        if (this.suppressTurnOnSpeedPercent === percent) {
            this.clearSuppressedTurnOnSpeed();
            this.svc.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.getAcFanSpeed());
            return;
        }
        this.clearSuppressedTurnOnSpeed();
        const current = this.findValue(types_1.FC.FAN_SPEED);
        const speed = (0, utils_1.percentToHubspeed)(requestedPercent, String(current?.value ?? 'fan-speed-auto'));
        if (current?.value === speed) {
            this.svc.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.getAcFanSpeed());
            return;
        }
        this.setDeviceValues([this.buildPatch(types_1.FC.FAN_SPEED, speed)]);
    }
    clearSuppressedTurnOnSpeed() {
        this.suppressTurnOnSpeedPercent = null;
        if (this.suppressTurnOnSpeedTimer) {
            clearTimeout(this.suppressTurnOnSpeedTimer);
            this.suppressTurnOnSpeedTimer = null;
        }
    }
    pushCharacteristics() {
        this.svc.updateCharacteristic(this.platform.Characteristic.StatusFault, this.getStatusFault());
        if (this.offline) {
            this.svc.updateCharacteristic(this.platform.Characteristic.Active, this.noResponse);
            return;
        }
        this.svc.updateCharacteristic(this.platform.Characteristic.Active, this.getActive());
        this.svc.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.getCurrentHeaterCoolerState());
        this.svc.updateCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState, this.getTargetHeaterCoolerState());
        this.svc.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.getCurrentTemperature());
        if (this.findValue(types_1.FC.TEMPERATURE, 'cooling-target')) {
            this.svc.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, this.getCoolingTarget());
        }
        if (this.findValue(types_1.FC.FAN_SPEED)) {
            this.svc.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.getAcFanSpeed());
        }
    }
}
exports.PortableAcAccessory = PortableAcAccessory;
class LandscapeTransformerAccessory extends BaseHubspaceAccessory {
    get zoneInstances() {
        const instances = [];
        for (const [, v] of this.stateMap) {
            if (v.functionClass === types_1.FC.TOGGLE && /^zone-\d+$/.test(v.functionInstance ?? '')) {
                instances.push(v.functionInstance);
            }
        }
        return instances.sort();
    }
    setupServices() {
        this.masterSvc =
            this.accessory.getService(this.platform.Service.Switch) ??
                this.accessory.addService(this.platform.Service.Switch, this.device.friendlyName);
        this.masterSvc.getCharacteristic(this.platform.Characteristic.On)
            .onGet(() => {
            if (this.offline)
                throw this.noResponse;
            return this.getMasterPower();
        })
            .onSet((v) => { void this.setMasterPower(v); });
        this.masterSvc.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);
        this.masterSvc.getCharacteristic(this.platform.Characteristic.StatusFault)
            .onGet(() => this.getStatusFault());
        this.zoneSvcs = new Map();
        for (const instance of this.zoneInstances) {
            const label = instance.replace(/^zone-(\d+)$/, 'Zone $1');
            const svc = this.accessory.services.find((s) => s.subtype === instance) ??
                this.accessory.addService(this.platform.Service.Switch, label, instance);
            svc.getCharacteristic(this.platform.Characteristic.On)
                .onGet(() => {
                if (this.offline)
                    throw this.noResponse;
                return this.getZonePower(instance);
            })
                .onSet((v) => { void this.setZonePower(instance, v); });
            this.zoneSvcs.set(instance, svc);
        }
    }
    getStatusFault() {
        const base = super.getStatusFault();
        if (base !== this.platform.Characteristic.StatusFault.NO_FAULT)
            return base;
        const overload = this.findValue(types_1.FC.OVERLOAD_STATE);
        if (overload !== undefined && overload.value !== 'normal') {
            return this.platform.Characteristic.StatusFault.GENERAL_FAULT;
        }
        return this.platform.Characteristic.StatusFault.NO_FAULT;
    }
    getMasterPower() {
        const v = this.findValue(types_1.FC.POWER);
        return v?.value === 'on' || v?.value === true || v?.value === 1;
    }
    async setMasterPower(on) {
        this.setDeviceValues([this.buildPatch(types_1.FC.POWER, on ? 'on' : 'off')]);
    }
    getZonePower(instance) {
        const v = this.findValue(types_1.FC.TOGGLE, instance);
        return v?.value === 'on' || v?.value === true || v?.value === 1;
    }
    async setZonePower(instance, on) {
        this.setDeviceValues([this.buildPatch(types_1.FC.TOGGLE, on ? 'on' : 'off', instance)]);
    }
    pushCharacteristics() {
        this.masterSvc.updateCharacteristic(this.platform.Characteristic.StatusFault, this.getStatusFault());
        if (this.offline) {
            this.masterSvc.updateCharacteristic(this.platform.Characteristic.On, this.noResponse);
            for (const [, svc] of this.zoneSvcs) {
                svc.updateCharacteristic(this.platform.Characteristic.On, this.noResponse);
            }
            return;
        }
        this.masterSvc.updateCharacteristic(this.platform.Characteristic.On, this.getMasterPower());
        for (const [instance, svc] of this.zoneSvcs) {
            svc.updateCharacteristic(this.platform.Characteristic.On, this.getZonePower(instance));
        }
    }
}
exports.LandscapeTransformerAccessory = LandscapeTransformerAccessory;
function createAccessory(platform, pAccessory, device) {
    const cls = device.deviceClass.toLowerCase();
    if (cls === 'light') {
        return new LightAccessory(platform, pAccessory, device);
    }
    if (cls === 'fan' || cls === 'ceiling-fan') {
        return new FanAccessory(platform, pAccessory, device);
    }
    if (cls === 'outlet' || cls === 'switch' || cls === 'plug' || cls === 'power-outlet') {
        const multiOutlets = device.values.filter(v => v.functionClass === types_1.FC.TOGGLE && /^outlet-\d+$/.test(v.functionInstance ?? ''));
        if (multiOutlets.length > 1) {
            return new MultiOutletAccessory(platform, pAccessory, device);
        }
        return new OutletAccessory(platform, pAccessory, device);
    }
    if (cls === 'portable-air-conditioner') {
        return new PortableAcAccessory(platform, pAccessory, device);
    }
    if (cls === 'landscape-transformer') {
        return new LandscapeTransformerAccessory(platform, pAccessory, device);
    }
    platform.log.warn(`Unsupported deviceClass "${device.deviceClass}" for "${device.friendlyName}" — skipping.`);
    return null;
}
//# sourceMappingURL=accessory.js.map