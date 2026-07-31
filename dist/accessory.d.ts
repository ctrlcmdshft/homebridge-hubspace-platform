import { PlatformAccessory, CharacteristicValue, Logger } from 'homebridge';
import type { HubspacePlatform } from './platform';
import { HubspaceDevice, DeviceStateValue, HubspaceAccessoryContext } from './types';
export declare abstract class BaseHubspaceAccessory {
    protected readonly platform: HubspacePlatform;
    protected readonly accessory: PlatformAccessory;
    device: HubspaceDevice;
    protected readonly log: Logger;
    protected stateMap: Map<string, DeviceStateValue>;
    private readonly colorTempCategories;
    protected offline: boolean;
    private pollFails;
    private static readonly OFFLINE_THRESHOLD;
    protected readonly availableOffline: boolean;
    constructor(platform: HubspacePlatform, accessory: PlatformAccessory, device: HubspaceDevice);
    private setupAccessoryInfo;
    protected rebuildStateMap(values: DeviceStateValue[]): void;
    protected findValue(functionClass: string, functionInstance?: string): DeviceStateValue | undefined;
    updateState(values: DeviceStateValue[]): void;
    markPollFailed(): void;
    protected get noResponse(): Error;
    protected getStatusFault(): CharacteristicValue;
    protected abstract setupServices(): void;
    protected abstract pushCharacteristics(): void;
    private readonly pendingWrites;
    private writeFlushTimer;
    private writeInFlight;
    protected setDeviceValues(values: Partial<DeviceStateValue>[]): void;
    private scheduleWriteFlush;
    private flushWrites;
    private applyOptimisticUpdate;
    protected buildPatch(functionClass: string, value: DeviceStateValue['value'], functionInstance?: string): Partial<DeviceStateValue>;
    protected colorTempPatchValue(kelvin: number, current: DeviceStateValue | undefined): string | number;
    private retryWithAllowedColorTemperature;
    private parseAllowedKelvinValues;
    private nearestColorTempCategory;
    private loadColorTempCategories;
    private stateKey;
}
export declare class LightAccessory extends BaseHubspaceAccessory {
    private svc;
    private pendingHue;
    private pendingSat;
    protected setupServices(): void;
    private getPower;
    private getBrightness;
    private getColorTemp;
    private getHue;
    private getSaturation;
    private setPower;
    private brightnessTimer;
    private setBrightness;
    private colorTempTimer;
    private setColorTemp;
    private setPendingHue;
    private setPendingSat;
    private flushColorTimer;
    private flushColor;
    protected pushCharacteristics(): void;
}
export declare class FanAccessory extends BaseHubspaceAccessory {
    private fanSvc;
    private lightSvc;
    private cbAcc;
    private mpAcc;
    private rememberedFanSpeedValue;
    private restoreFanSpeedValue;
    private restoreFanSpeedTimer;
    private suppressTurnOnSpeedPercent;
    private suppressTurnOnSpeedTimer;
    protected setupServices(): void;
    updateState(values: DeviceStateValue[]): void;
    private findFanPowerValue;
    private findFanPowerValueIn;
    private getFanActive;
    private setFanActive;
    private getStoredFanSpeed;
    private getFanSpeed;
    private setFanSpeed;
    private rememberCurrentFanSpeed;
    private rememberFanSpeed;
    private buildRememberedFanSpeedPatch;
    private scheduleFanSpeedRestore;
    private clearFanSpeedRestore;
    private isRestoringDifferentFanSpeed;
    private clearSuppressedTurnOnSpeed;
    private getFanDirection;
    private setFanDirection;
    hasMasterPower(): boolean;
    setupMasterPowerCompanion(pAcc: PlatformAccessory): void;
    private getMasterPower;
    private setMasterPower;
    hasComfortBreeze(): boolean;
    setupComfortBreezeCompanion(pAcc: PlatformAccessory): void;
    private getComfortBreeze;
    private setComfortBreeze;
    private getLightPower;
    private setLightPower;
    private getLightBrightness;
    private lightBrightnessTimer;
    private setLightBrightness;
    private getLightColorTemp;
    private lightColorTempTimer;
    private setLightColorTemp;
    protected pushCharacteristics(): void;
}
export declare class OutletAccessory extends BaseHubspaceAccessory {
    private svc;
    protected setupServices(): void;
    private getPower;
    private setPower;
    protected pushCharacteristics(): void;
}
export declare class MultiOutletAccessory extends BaseHubspaceAccessory {
    private outletServices;
    private get outletInstances();
    protected setupServices(): void;
    private getPowerForOutlet;
    private setPowerForOutlet;
    protected pushCharacteristics(): void;
}
export declare class PortableAcAccessory extends BaseHubspaceAccessory {
    private svc;
    private suppressTurnOnSpeedPercent;
    private suppressTurnOnSpeedTimer;
    protected setupServices(): void;
    private getActive;
    private getCurrentHeaterCoolerState;
    private getTargetHeaterCoolerState;
    private getCurrentTemperature;
    private getCoolingTarget;
    private getAcFanSpeed;
    private getStoredAcFanSpeed;
    private setActive;
    private setTargetHeaterCoolerState;
    private coolingTargetTimer;
    private setCoolingTarget;
    private setAcFanSpeed;
    private clearSuppressedTurnOnSpeed;
    protected pushCharacteristics(): void;
}
export declare class LandscapeTransformerAccessory extends BaseHubspaceAccessory {
    private masterSvc;
    private zoneSvcs;
    private get zoneInstances();
    protected setupServices(): void;
    protected getStatusFault(): CharacteristicValue;
    private getMasterPower;
    private setMasterPower;
    private getZonePower;
    private setZonePower;
    protected pushCharacteristics(): void;
}
export declare function createAccessory(platform: HubspacePlatform, pAccessory: PlatformAccessory, device: HubspaceDevice): BaseHubspaceAccessory | null;
export type { HubspaceAccessoryContext };
//# sourceMappingURL=accessory.d.ts.map