import { Logger } from 'homebridge';
import { HubspaceDevice, DeviceStateValue } from './types';
export declare class HubspaceClient {
    private readonly username;
    private readonly password;
    private readonly log;
    private readonly http;
    private tokens;
    private accountId;
    private readonly tokenCachePath;
    private refreshInFlight;
    private authInFlight;
    private readonly debug;
    private readonly authLog;
    private readonly conclaveLog;
    constructor(username: string, password: string, storagePath: string, log: Logger, options?: {
        tokenCachePath?: string;
        debug?: boolean;
    });
    startConclave(onDeviceChange: (deviceId: string) => void, onClientJoin?: () => void): void;
    fetchConclaveToken(): Promise<{
        token: string;
        channelId: string | undefined;
        expiresIn: number;
        host: string;
        compression: boolean;
    }>;
    private getOrCreateMobileDeviceId;
    initialize(): Promise<void>;
    getDevices(): Promise<HubspaceDevice[]>;
    private extractColorTempCategories;
    getDeviceState(deviceIds: string[]): Promise<DeviceStateValue[]>;
    setDeviceState(deviceId: string, values: Partial<DeviceStateValue>[]): Promise<void>;
    private resolveAccountId;
    private authenticate;
    private _doAuthenticate;
    private tokenClientId;
    private doRefresh;
    private getValidAccessToken;
    private storeTokens;
    private loadCachedTokens;
    private saveCachedTokens;
    private isAccessTokenExpired;
    private isRefreshTokenValid;
    private dbg;
    private extractErrorMessage;
}
//# sourceMappingURL=hubspace-client.d.ts.map