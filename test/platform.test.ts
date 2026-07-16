import { HubspacePlatform } from '../src/platform';

function makeLog() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function makeApi() {
  return {
    hap: {
      Service: {},
      Characteristic: {},
      uuid: { generate: jest.fn((value: string) => `uuid-${value}`) },
    },
    user: { storagePath: jest.fn(() => '/tmp') },
    on: jest.fn(),
  };
}

function makePlatform() {
  const log = makeLog();
  const api = makeApi();
  const platform = new HubspacePlatform(log as any, {
    platform: 'HubspacePlatform',
    name: 'Hubspace Platform',
    username: 'user@example.com',
    password: 'password',
  } as any, api as any);

  return { platform: platform as any, log };
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

describe('HubspacePlatform polling logs', () => {
  it('logs poll failures with the friendly device name and ID', async () => {
    const { platform, log } = makePlatform();
    const handler = makeHandler('device-1', 'Surge wall tap');
    platform.handlers.set('device-1', handler);
    platform.client = {
      getDeviceState: jest.fn().mockRejectedValue(new Error('timeout of 30000ms exceeded')),
    };

    await platform.pollDevices();

    expect(log.warn).toHaveBeenCalledWith(
      '[Poll] Failed for "Surge wall tap" (device-1): timeout of 30000ms exceeded',
    );
    expect(log.warn).toHaveBeenCalledWith('[Poll] 1 device(s) failed this cycle.');
    expect(handler.markPollFailed).toHaveBeenCalledTimes(1);
  });

  it('suppresses repeated per-device failures until recovery', async () => {
    const { platform, log } = makePlatform();
    const handler = makeHandler('device-1', 'Surge wall tap');
    platform.handlers.set('device-1', handler);
    platform.client = {
      getDeviceState: jest.fn().mockRejectedValue(new Error('timeout of 30000ms exceeded')),
    };

    await platform.pollDevices();
    await platform.pollDevices();
    await platform.pollDevices();
    await platform.pollDevices();

    const failedLines = log.warn.mock.calls
      .map(([message]) => String(message))
      .filter(message => message.includes('Failed for "Surge wall tap"'));
    expect(failedLines).toEqual([
      '[Poll] Failed for "Surge wall tap" (device-1): timeout of 30000ms exceeded',
      '[Poll] Failed for "Surge wall tap" (device-1): timeout of 30000ms exceeded',
      '[Poll] Failed for "Surge wall tap" (device-1): timeout of 30000ms exceeded — suppressing repeated errors until it recovers.',
    ]);

    platform.client.getDeviceState.mockResolvedValueOnce([]);
    await platform.pollDevices();

    expect(log.info).toHaveBeenCalledWith(
      '[Poll] "Surge wall tap" (device-1) poll recovered after 4 failed attempt(s).',
    );
  });
});
