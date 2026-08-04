export declare const PLUGIN_NAME = "homebridge-hubspace-platform";
export declare const PLATFORM_NAME = "HubspacePlatform";
export interface HubspaceConfig {
    platform: string;
    name: string;
    username: string;
    password: string;
    pollingInterval?: number;
    tokenCachePath?: string;
    debug?: boolean;
    verbose?: boolean;
    exposeComfortBreeze?: boolean;
    exposeMasterPowerSwitch?: boolean;
    exposeStatusFault?: boolean;
    disableConclave?: boolean;
    invertOutletStatus?: boolean;
    excludedDevices?: string;
}
export interface AuthTokens {
    username?: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    refreshExpiresAt: number;
    mobileDeviceId?: string;
}
export interface KeycloakTokenResponse {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_expires_in: number;
    token_type: string;
    error?: string;
    error_description?: string;
}
export interface DeviceStateValue {
    functionClass: string;
    functionInstance: string | undefined;
    value: string | number | boolean | Record<string, unknown>;
    lastUpdateTime?: number;
}
export interface SemanticValueDefinition {
    name?: string;
    range?: {
        min?: number | null;
        max?: number | null;
        step?: number | null;
    };
}
export interface SemanticFunctionDefinition {
    functionClass?: string;
    functionInstance?: string;
    type?: string;
    values?: SemanticValueDefinition[];
}
export interface HubspaceMetadeviceRaw {
    id: string;
    version?: number;
    typeId: string;
    friendlyName: string;
    deviceId?: string;
    semanticDescriptionKey?: string;
    description?: {
        device?: {
            deviceClass?: string;
            manufacturerName?: string;
            model?: string;
            defaultName?: string;
        };
        functions?: SemanticFunctionDefinition[];
    };
    state?: {
        metadeviceId: string;
        values: DeviceStateValue[];
    };
    children?: string[];
}
export interface HubspaceDevice {
    id: string;
    allIds: string[];
    typeId: string;
    friendlyName: string;
    deviceClass: string;
    manufacturerName?: string;
    model?: string;
    values: DeviceStateValue[];
    colorTempCategories?: Record<string, Array<string | number>>;
}
export interface HubspaceAccessoryContext {
    deviceId: string;
    deviceClass: string;
    typeId: string;
    friendlyName: string;
    manufacturerName?: string;
    model?: string;
    companionFor?: string;
}
export declare const SUPPORTED_DEVICE_CLASSES: Set<string>;
export declare const FC: {
    readonly POWER: "power";
    readonly TOGGLE: "toggle";
    readonly BRIGHTNESS: "brightness";
    readonly COLOR_TEMP: "color-temperature";
    readonly COLOR_RGB: "color-rgb";
    readonly COLOR_MODE: "color-mode";
    readonly FAN_SPEED: "fan-speed";
    readonly FAN_REVERSE: "fan-reverse";
    readonly AVAILABLE: "available";
    readonly MODE: "mode";
    readonly TEMPERATURE: "temperature";
    readonly OVERLOAD_STATE: "overload-state";
    readonly LOCK_CONTROL: "lock-control";
    readonly BATTERY_LEVEL: "battery-level";
};
export type FunctionClass = (typeof FC)[keyof typeof FC];
//# sourceMappingURL=types.d.ts.map