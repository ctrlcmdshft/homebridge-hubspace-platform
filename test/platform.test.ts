import { HubspacePlatform } from '../src/platform';
import { HubspaceDevice } from '../src/types';
import type { API, Logger, PlatformConfig } from 'homebridge';

// ── Mock helpers ──────────────────────────────────────────────────────────────
// Mirrors the mock shapes used in test/accessory.test.ts — HubspacePlatform's
// discoverDevices() constructs real accessory handlers (LightAccessory,
// OutletAccessory, ...) for any non-excluded, supported device, so the fake
// `api.hap` surface needs to satisfy whichever of those get exercised here.

function makeCharMock() {
  const c: Record<string, jest.Mock> = {};
  c['onGet'] = jest.fn(() => c);
  c['onSet'] = jest.fn(() => c);
  c['setProps'] = jest.fn(() => c);
  c['updateValue'] = jest.fn(() => c);
  return c;
}

function makeSvcMock() {
  const char = makeCharMock();
  return {
    getCharacteristic: jest.fn(() => char),
    addOptionalCharacteristic: jest.fn(),
    setCharacteristic: jest.fn().mockReturnThis(),
    updateCharacteristic: jest.fn(),
  };
}

function makeLog(): Logger {
  return { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
}

function makeApi() {
  const registerPlatformAccessories = jest.fn();
  const unregisterPlatformAccessories = jest.fn();
  const updatePlatformAccessories = jest.fn();

  class MockPlatformAccessory {
    context: Record<string, unknown> = {};
    services: unknown[] = [];
    displayName: string;
    UUID: string;
    private readonly svc = makeSvcMock();
    constructor(name: string, uuid: string) {
      this.displayName = name;
      this.UUID = uuid;
    }
    getService = jest.fn(() => this.svc);
    addService = jest.fn(() => this.svc);
  }

  const api = {
    hap: {
      Service: {
        AccessoryInformation: 'AccessoryInformation',
        Lightbulb: 'Lightbulb',
        Fanv2: 'Fanv2',
        Outlet: 'Outlet',
        Switch: 'Switch',
        HeaterCooler: 'HeaterCooler',
      },
      Characteristic: {
        Manufacturer: 'Manufacturer',
        Model: 'Model',
        SerialNumber: 'SerialNumber',
        Name: 'Name',
        On: 'On',
        OutletInUse: 'OutletInUse',
        StatusFault: { NO_FAULT: 0, GENERAL_FAULT: 1 },
        Active: { ACTIVE: 1, INACTIVE: 0 },
        RotationSpeed: 'RotationSpeed',
        Brightness: 'Brightness',
        ColorTemperature: 'ColorTemperature',
        Hue: 'Hue',
        Saturation: 'Saturation',
        CurrentHeaterCoolerState: { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 },
        TargetHeaterCoolerState: { AUTO: 0, HEAT: 1, COOL: 2 },
        CurrentTemperature: 'CurrentTemperature',
        CoolingThresholdTemperature: 'CoolingThresholdTemperature',
      },
      uuid: { generate: jest.fn((seed: string) => `uuid-${seed}`) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      HapStatusError: class HapStatusError extends Error { constructor(public hapStatus: number) { super(); } },
    },
    user: { storagePath: () => '/tmp/hubspace-platform-test' },
    platformAccessory: MockPlatformAccessory,
    registerPlatformAccessories,
    unregisterPlatformAccessories,
    updatePlatformAccessories,
    on: jest.fn(),
  };

  return { api: api as unknown as API, registerPlatformAccessories, unregisterPlatformAccessories, updatePlatformAccessories };
}

function makeDevice(overrides: Partial<HubspaceDevice>): HubspaceDevice {
  return {
    id: 'device-id', allIds: ['device-id'], typeId: 'metadevice.device',
    friendlyName: 'Device', deviceClass: 'light',
    manufacturerName: 'Hubspace', model: 'test-model', values: [],
    ...overrides,
  };
}

function makePlatform(config: Partial<PlatformConfig> = {}) {
  const log = makeLog();
  const { api, registerPlatformAccessories } = makeApi();
  const fullConfig = {
    platform: 'HubspacePlatform',
    name: 'Hubspace Platform',
    username: 'user@example.com',
    password: 'hunter2',
    ...config,
  } as PlatformConfig;

  const platform = new HubspacePlatform(log, fullConfig, api);
  return { platform, log, registerPlatformAccessories };
}

function makeHandler(id: string, friendlyName: string) {
  return {
    device: {
      id,
      allIds: [id],
      friendlyName,
      values: [],
    },
    updateState: jest.fn(),
    markPollFailed: jest.fn(),
  };
}

async function discover(platform: HubspacePlatform, devices: HubspaceDevice[]) {
  jest.spyOn(platform.client, 'getDevices').mockResolvedValue(devices);
  // discoverDevices() is private — call it directly rather than going through
  // the full didFinishLaunching lifecycle, which also starts polling/Conclave.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (platform as any).discoverDevices();
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('HubspacePlatform polling logs', () => {
  it('logs poll failures with the friendly device name and ID', async () => {
    const { platform, log } = makePlatform();
    const handler = makeHandler('device-1', 'Surge wall tap');
    (platform as any).handlers.set('device-1', handler);
    (platform as any).client = {
      getDeviceState: jest.fn().mockRejectedValue(new Error('timeout of 30000ms exceeded')),
    };

    await (platform as any).pollDevices();

    expect(log.warn).toHaveBeenCalledWith(
      '[Poll] Failed for "Surge wall tap" (device-1): timeout of 30000ms exceeded',
    );
    expect(log.warn).toHaveBeenCalledWith('[Poll] 1 device(s) failed this cycle.');
    expect(handler.markPollFailed).toHaveBeenCalledTimes(1);
  });

  it('suppresses repeated per-device failures until recovery', async () => {
    const { platform, log } = makePlatform();
    const handler = makeHandler('device-1', 'Surge wall tap');
    (platform as any).handlers.set('device-1', handler);
    (platform as any).client = {
      getDeviceState: jest.fn().mockRejectedValue(new Error('timeout of 30000ms exceeded')),
    };

    await (platform as any).pollDevices();
    await (platform as any).pollDevices();
    await (platform as any).pollDevices();
    await (platform as any).pollDevices();

    const failedLines = (log.warn as jest.Mock).mock.calls
      .map(([message]) => String(message))
      .filter(message => message.includes('Failed for "Surge wall tap"'));
    expect(failedLines).toEqual([
      '[Poll] Failed for "Surge wall tap" (device-1): timeout of 30000ms exceeded',
      '[Poll] Failed for "Surge wall tap" (device-1): timeout of 30000ms exceeded',
      '[Poll] Failed for "Surge wall tap" (device-1): timeout of 30000ms exceeded — suppressing repeated errors until it recovers.',
    ]);

    ((platform as any).client.getDeviceState as jest.Mock).mockResolvedValueOnce([]);
    await (platform as any).pollDevices();

    expect(log.info).toHaveBeenCalledWith(
      '[Poll] "Surge wall tap" (device-1) poll recovered after 4 failed attempt(s).',
    );
  });
});

describe('HubspacePlatform polling interval defaults', () => {
  let setIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(123 as unknown as ReturnType<typeof setInterval>);
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  it('defaults to 300 seconds when Conclave is enabled', () => {
    const { platform, log } = makePlatform();

    // startPolling() is private; call it directly to verify interval selection.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (platform as any).startPolling();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 300_000);
    expect(log.info).toHaveBeenCalledWith('Starting state polling every 300s.');
  });

  it('defaults to 30 seconds when Conclave is disabled', () => {
    const { platform, log } = makePlatform({ disableConclave: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (platform as any).startPolling();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(log.info).toHaveBeenCalledWith('Starting state polling every 30s.');
  });

  it('honors explicit pollingInterval regardless of Conclave mode', () => {
    const { platform } = makePlatform({ disableConclave: false, pollingInterval: 45 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (platform as any).startPolling();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 45_000);
  });
});

describe('HubspacePlatform discoverDevices — excludedDevices', () => {
  it('skips devices whose friendlyName matches excludedDevices (comma-separated string)', async () => {
    const { platform, log, registerPlatformAccessories } = makePlatform({
      excludedDevices: 'Bulb, Outdoor plug',
    });

    const devices = [
      makeDevice({ id: 'd1', friendlyName: 'Bulb', deviceClass: 'light' }),
      makeDevice({ id: 'd2', friendlyName: 'Outdoor plug', deviceClass: 'outlet' }),
      makeDevice({ id: 'd3', friendlyName: 'Ceiling Light', deviceClass: 'light' }),
    ];

    await discover(platform, devices);

    expect(log.info).toHaveBeenCalledWith('Skipping excluded device: "Bulb"');
    expect(log.info).toHaveBeenCalledWith('Skipping excluded device: "Outdoor plug"');
    expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
    expect(registerPlatformAccessories.mock.calls[0][2][0].displayName).toBe('Ceiling Light');
  });

  it('matches case-insensitively', async () => {
    const { platform, log, registerPlatformAccessories } = makePlatform({
      excludedDevices: 'bulb',
    });

    await discover(platform, [
      makeDevice({ id: 'd1', friendlyName: 'BULB', deviceClass: 'light' }),
    ]);

    expect(log.info).toHaveBeenCalledWith('Skipping excluded device: "BULB"');
    expect(registerPlatformAccessories).not.toHaveBeenCalled();
  });

  it('warns when an excludedDevices entry matches no discovered device', async () => {
    const { platform, log } = makePlatform({
      excludedDevices: 'Bulb, Nonexistent Device',
    });

    await discover(platform, [
      makeDevice({ id: 'd1', friendlyName: 'Bulb', deviceClass: 'light' }),
    ]);

    expect(log.warn).toHaveBeenCalledWith(
      'excludedDevices entry "Nonexistent Device" did not match any discovered device — check for a typo.',
    );
  });

  it('accepts the legacy array format for backward compatibility', async () => {
    const { platform, log, registerPlatformAccessories } = makePlatform({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      excludedDevices: ['Bulb', 'Outdoor plug'] as any,
    });

    await discover(platform, [
      makeDevice({ id: 'd1', friendlyName: 'Bulb', deviceClass: 'light' }),
      makeDevice({ id: 'd2', friendlyName: 'Ceiling Light', deviceClass: 'light' }),
    ]);

    expect(log.info).toHaveBeenCalledWith('Skipping excluded device: "Bulb"');
    expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
  });

  it('does not exclude anything when excludedDevices is unset', async () => {
    const { platform, registerPlatformAccessories } = makePlatform();

    await discover(platform, [
      makeDevice({ id: 'd1', friendlyName: 'Ceiling Light', deviceClass: 'light' }),
    ]);

    expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
  });

  it('logs a warning (not the exclusion path) for an unsupported deviceClass', async () => {
    const { platform, log, registerPlatformAccessories } = makePlatform({
      excludedDevices: 'Bulb',
    });

    await discover(platform, [
      makeDevice({ id: 'd1', friendlyName: 'Keypad', deviceClass: 'security-system-keypad' }),
    ]);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Unsupported deviceClass "security-system-keypad"'));
    expect(registerPlatformAccessories).not.toHaveBeenCalled();
  });
});
