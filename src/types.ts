// ─── Plugin identity ─────────────────────────────────────────────────────────
export const PLUGIN_NAME = 'homebridge-hubspace-platform';
export const PLATFORM_NAME = 'HubspacePlatform';

// ─── Homebridge config ────────────────────────────────────────────────────────
export interface HubspaceConfig {
  platform: string;
  name: string;
  username: string;
  password: string;
  /** Polling interval in seconds (default 30). */
  pollingInterval?: number;
  /** Override path for the token cache JSON file. */
  tokenCachePath?: string;
  debug?: boolean;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix timestamp (ms) when the access token expires. */
  expiresAt: number;
  /** Unix timestamp (ms) when the refresh token expires. */
  refreshExpiresAt: number;
}

/** Raw Keycloak token response. */
export interface KeycloakTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;          // seconds
  refresh_expires_in: number;  // seconds
  token_type: string;
  error?: string;
  error_description?: string;
}

// ─── Afero / Hubspace API ─────────────────────────────────────────────────────
export interface DeviceStateValue {
  functionClass: string;
  functionInstance: string;
  value: string | number | boolean;
  lastUpdateTime?: number;
}

/** Raw shape returned by semantics2 metadevices API. */
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
  };
  state?: {
    metadeviceId: string;
    values: DeviceStateValue[];
  };
  children?: string[];
}

/** Normalised device used throughout the plugin. */
export interface HubspaceDevice {
  id: string;
  typeId: string;
  friendlyName: string;
  deviceClass: string;
  manufacturerName?: string;
  model?: string;
  /** Current state values for this device. */
  values: DeviceStateValue[];
}

// ─── Accessory context (persisted in PlatformAccessory.context) ───────────────
export interface HubspaceAccessoryContext {
  deviceId: string;
  deviceClass: string;
  typeId: string;
  friendlyName: string;
  manufacturerName?: string;
  model?: string;
}

// ─── Supported device classes ─────────────────────────────────────────────────
export const SUPPORTED_DEVICE_CLASSES = new Set([
  'light',
  'fan',
  'ceiling-fan',
  'outlet',
  'switch',
  'plug',
]);

// ─── Function class constants (Hubspace / Afero capability names) ─────────────
export const FC = {
  POWER: 'power',
  BRIGHTNESS: 'brightness',
  COLOR_TEMP: 'color-temperature',
  COLOR_RGB: 'color-rgb',
  COLOR_MODE: 'color-mode',
  FAN_SPEED: 'fan-speed',
  FAN_REVERSE: 'fan-reverse',
} as const;

export type FunctionClass = (typeof FC)[keyof typeof FC];
