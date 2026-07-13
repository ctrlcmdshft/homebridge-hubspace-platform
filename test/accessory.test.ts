import { LightAccessory, FanAccessory, OutletAccessory, PortableAcAccessory, LandscapeTransformerAccessory } from '../src/accessory';
import { DeviceStateValue, FC } from '../src/types';

// ── Mock helpers ──────────────────────────────────────────────────────────────

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
    _char: char,
  };
}

// These objects are the same references stored in platform.Characteristic —
// use them in assertions so they match what the code passes to updateCharacteristic.
const Active = { ACTIVE: 1, INACTIVE: 0 };
const StatusFault = { NO_FAULT: 0, GENERAL_FAULT: 1 };
const CurrentHeaterCoolerState = { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 };
const TargetHeaterCoolerState = { AUTO: 0, HEAT: 1, COOL: 2 };

function makePlatform(opts: { exposeStatusFault?: boolean } = {}) {
  const svc = makeSvcMock();
  return {
    log: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    debug: false,
    verbose: false,
    exposeStatusFault: opts.exposeStatusFault ?? false,
    invertOutletStatus: false,
    api: {
      hap: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        HapStatusError: class HapStatusError extends Error { constructor(public hapStatus: number) { super(); } },
      },
    },
    client: { setDeviceState: jest.fn().mockResolvedValue(undefined) },
    scheduleQuickPoll: jest.fn(),
    Service: {
      Fanv2: 'Fanv2',
      Lightbulb: 'Lightbulb',
      Outlet: 'Outlet',
      Switch: 'Switch',
      HeaterCooler: 'HeaterCooler',
      AccessoryInformation: 'AccessoryInformation',
    },
    Characteristic: {
      Active,
      On: 'On',
      RotationSpeed: 'RotationSpeed',
      Brightness: 'Brightness',
      ColorTemperature: 'ColorTemperature',
      Hue: 'Hue',
      Saturation: 'Saturation',
      StatusFault,
      OutletInUse: 'OutletInUse',
      CurrentHeaterCoolerState,
      TargetHeaterCoolerState,
      CurrentTemperature: 'CurrentTemperature',
      CoolingThresholdTemperature: 'CoolingThresholdTemperature',
      Manufacturer: 'Manufacturer',
      Model: 'Model',
      SerialNumber: 'SerialNumber',
      Name: 'Name',
    },
    _svc: svc,
  };
}

function makeAccessoryMock(platform: ReturnType<typeof makePlatform>) {
  return {
    context: {},
    services: [] as { subtype?: string }[],
    getService: jest.fn(() => platform._svc),
    addService: jest.fn(() => platform._svc),
  };
}

function sv(
  functionClass: string,
  value: DeviceStateValue['value'],
  functionInstance?: string,
): DeviceStateValue {
  return { functionClass, functionInstance, value } as DeviceStateValue;
}

function makeFanDevice(values: DeviceStateValue[]) {
  return {
    id: 'fan-1', allIds: ['fan-1'], typeId: 'metadevice.device',
    friendlyName: 'Ceiling Fan', deviceClass: 'ceiling-fan',
    manufacturerName: 'Hampton Bay', model: 'test-model', values,
  };
}

function makeLightDevice(values: DeviceStateValue[]) {
  return {
    id: 'light-1', allIds: ['light-1'], typeId: 'metadevice.device',
    friendlyName: 'Ceiling Light', deviceClass: 'light',
    manufacturerName: 'Hubspace', model: 'test-model', values,
  };
}

function makeOutletDevice(values: DeviceStateValue[]) {
  return {
    id: 'outlet-1', allIds: ['outlet-1'], typeId: 'metadevice.device',
    friendlyName: 'Smart Outlet', deviceClass: 'outlet',
    manufacturerName: 'Defiant', model: 'test-model', values,
  };
}

// ── FanAccessory ──────────────────────────────────────────────────────────────

describe('FanAccessory', () => {
  describe('fan power (Active)', () => {
    it.each([
      ['on', Active.ACTIVE],
      ['off', Active.INACTIVE],
    ])('power "%s" → Active %i', (value, expected) => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.POWER, value, 'fan-power')]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);

      fanAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(Active, expected);
    });

    it('treats boolean true as ACTIVE', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.POWER, true, 'fan-power')]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);

      fanAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(Active, Active.ACTIVE);
    });

    it('treats numeric 1 as ACTIVE', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.POWER, 1, 'fan-power')]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);

      fanAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(Active, Active.ACTIVE);
    });
  });

  describe('fan speed (RotationSpeed)', () => {
    it.each([
      ['fan-speed-025', 25],
      ['fan-speed-050', 50],
      ['fan-speed-075', 75],
      ['fan-speed-100', 100],
    ])('%s → %i%%', (raw, expected) => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.POWER, 'on', 'fan-power'), sv(FC.FAN_SPEED, raw, 'fan-speed')]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);

      fanAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith('RotationSpeed', expected);
    });

    it('returns 0 when fan is inactive', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.POWER, 'off', 'fan-power'), sv(FC.FAN_SPEED, 'fan-speed-050', 'fan-speed')]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);

      fanAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith('RotationSpeed', 0);
    });

    it('updates correctly when state changes', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.POWER, 'on', 'fan-power'), sv(FC.FAN_SPEED, 'fan-speed-025', 'fan-speed')]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);

      fanAcc.updateState([sv(FC.POWER, 'on', 'fan-power'), sv(FC.FAN_SPEED, 'fan-speed-100', 'fan-speed')]);

      expect(platform._svc.updateCharacteristic).toHaveBeenLastCalledWith('RotationSpeed', 100);
    });
  });

  describe('write-queue coalescing', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    function setup(values: DeviceStateValue[]) {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice(values);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);
      const onSetActive: (v: number) => void =
        (platform._svc._char.onSet as jest.Mock).mock.calls[0][0];
      const onSetFanSpeed: (v: number) => void =
        (platform._svc._char.onSet as jest.Mock).mock.calls[1][0];
      return { platform, fanAcc, onSetActive, onSetFanSpeed };
    }

    it('turns on without replacing the stored speed with HomeKit synthetic 100%', async () => {
      const { platform, onSetActive, onSetFanSpeed } = setup([
        sv(FC.POWER, 'off', 'fan-power'),
        sv(FC.FAN_SPEED, 'fan-speed-050', 'fan-speed'),
      ]);

      onSetActive(Active.ACTIVE);
      onSetFanSpeed(100);
      jest.runOnlyPendingTimers();
      await Promise.resolve();

      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[0];
      expect(patches).toEqual([
        expect.objectContaining({ functionClass: FC.POWER, value: 'on' }),
        expect.objectContaining({ functionClass: FC.FAN_SPEED, value: 'fan-speed-050' }),
      ]);
      // Suppression branch must immediately snap tile to stored speed (not 0 or 100)
      const updateCalls = (platform._svc.updateCharacteristic as jest.Mock).mock.calls;
      const firstSpeedUpdate = updateCalls.find(([c]) => c === 'RotationSpeed');
      expect(firstSpeedUpdate).toEqual(['RotationSpeed', 50]);
    });

    it('restores the stored fan speed when powering back on', async () => {
      const { platform, onSetActive } = setup([
        sv(FC.POWER, 'off', 'fan-power'),
        sv(FC.FAN_SPEED, 'fan-speed-050', 'fan-speed'),
      ]);

      onSetActive(Active.ACTIVE);
      jest.runOnlyPendingTimers();
      await Promise.resolve();

      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[0];
      expect(patches).toEqual([
        expect.objectContaining({ functionClass: FC.POWER, value: 'on' }),
        expect.objectContaining({ functionClass: FC.FAN_SPEED, value: 'fan-speed-050' }),
      ]);
    });

    it('uses the remembered user speed when Hubspace reports 100% while off', async () => {
      const { platform, fanAcc, onSetActive, onSetFanSpeed } = setup([
        sv(FC.POWER, 'on', 'fan-power'),
        sv(FC.FAN_SPEED, 'fan-speed-050', 'fan-speed'),
      ]);

      onSetFanSpeed(50);
      jest.runOnlyPendingTimers();
      await Promise.resolve();
      (platform.client.setDeviceState as jest.Mock).mockClear();

      fanAcc.updateState([
        sv(FC.POWER, 'off', 'fan-power'),
        sv(FC.FAN_SPEED, 'fan-speed-100', 'fan-speed'),
      ]);

      onSetActive(Active.ACTIVE);
      jest.runOnlyPendingTimers();
      await Promise.resolve();

      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[0];
      expect(patches).toEqual([
        expect.objectContaining({ functionClass: FC.POWER, value: 'on' }),
        expect.objectContaining({ functionClass: FC.FAN_SPEED, value: 'fan-speed-050' }),
      ]);
      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith('RotationSpeed', 50);
    });

    it('does not let an inactive synthetic 100% write replace the remembered speed', async () => {
      const { platform, fanAcc, onSetActive, onSetFanSpeed } = setup([
        sv(FC.POWER, 'on', 'fan-power'),
        sv(FC.FAN_SPEED, 'fan-speed-050', 'fan-speed'),
      ]);

      onSetFanSpeed(50);
      jest.runOnlyPendingTimers();
      await Promise.resolve();
      (platform.client.setDeviceState as jest.Mock).mockClear();

      fanAcc.updateState([
        sv(FC.POWER, 'off', 'fan-power'),
        sv(FC.FAN_SPEED, 'fan-speed-050', 'fan-speed'),
      ]);

      onSetFanSpeed(100);
      jest.runOnlyPendingTimers();
      await Promise.resolve();
      expect(platform.client.setDeviceState).not.toHaveBeenCalled();

      onSetActive(Active.ACTIVE);
      jest.runOnlyPendingTimers();
      await Promise.resolve();

      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[0];
      expect(patches).toEqual([
        expect.objectContaining({ functionClass: FC.POWER, value: 'on' }),
        expect.objectContaining({ functionClass: FC.FAN_SPEED, value: 'fan-speed-050' }),
      ]);
    });

    it('sends a delayed speed restore after powering on', async () => {
      const { platform, onSetActive } = setup([
        sv(FC.POWER, 'off', 'fan-power'),
        sv(FC.FAN_SPEED, 'fan-speed-050', 'fan-speed'),
      ]);

      onSetActive(Active.ACTIVE);
      jest.runOnlyPendingTimers();
      await Promise.resolve();
      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);

      jest.runOnlyPendingTimers();
      await Promise.resolve();
      jest.runOnlyPendingTimers();
      await Promise.resolve();

      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(2);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[1];
      expect(patches).toEqual([
        expect.objectContaining({ functionClass: FC.FAN_SPEED, value: 'fan-speed-050' }),
      ]);
    });

    it('still allows an explicit speed change to 100% while already on', async () => {
      const { platform, onSetFanSpeed } = setup([
        sv(FC.POWER, 'on', 'fan-power'),
        sv(FC.FAN_SPEED, 'fan-speed-050', 'fan-speed'),
      ]);

      onSetFanSpeed(100);
      jest.runOnlyPendingTimers();
      await Promise.resolve();

      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[0];
      expect(patches).toEqual([
        expect.objectContaining({ functionClass: FC.FAN_SPEED, value: 'fan-speed-100' }),
      ]);
    });

    it('serializes writes that arrive while a PUT is in flight', async () => {
      const { platform, onSetActive, onSetFanSpeed } = setup([
        sv(FC.POWER, 'off', 'fan-power'),
        sv(FC.FAN_SPEED, 'fan-speed-050', 'fan-speed'),
      ]);
      let resolveFirst: () => void;
      const firstPut = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      (platform.client.setDeviceState as jest.Mock)
        .mockReturnValueOnce(firstPut)
        .mockResolvedValue(undefined);

      onSetActive(Active.ACTIVE);
      jest.runOnlyPendingTimers();
      await Promise.resolve();
      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);

      onSetFanSpeed(75);
      jest.runOnlyPendingTimers();
      await Promise.resolve();
      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);

      resolveFirst!();
      await Promise.resolve();
      jest.runOnlyPendingTimers();
      await Promise.resolve();

      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(2);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[1];
      expect(patches).toEqual([
        expect.objectContaining({ functionClass: FC.FAN_SPEED, value: 'fan-speed-075' }),
      ]);
    });
  });

  describe('comfort breeze', () => {
    function makeCompanionMock(platform: ReturnType<typeof makePlatform>) {
      const svc = makeSvcMock();
      return {
        getService: jest.fn(() => svc),
        addService: jest.fn(() => svc),
        _svc: svc,
      };
    }

    it('pushes true to companion when enabled', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const cbAcc = makeCompanionMock(platform);
      const device = makeFanDevice([sv(FC.TOGGLE, 'enabled', 'comfort-breeze')]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);
      fanAcc.setupComfortBreezeCompanion(cbAcc as any);

      fanAcc.updateState(device.values);

      expect(cbAcc._svc.updateCharacteristic).toHaveBeenCalledWith('On', true);
    });

    it('pushes false to companion when disabled', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const cbAcc = makeCompanionMock(platform);
      const device = makeFanDevice([sv(FC.TOGGLE, 'disabled', 'comfort-breeze')]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);
      fanAcc.setupComfortBreezeCompanion(cbAcc as any);

      fanAcc.updateState(device.values);

      expect(cbAcc._svc.updateCharacteristic).toHaveBeenCalledWith('On', false);
    });

    it('does not add comfort breeze service to main accessory', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.TOGGLE, 'enabled', 'comfort-breeze')]);
      new FanAccessory(platform as any, acc as any, device as any);

      const addedServiceNames = (acc.addService.mock.calls as any[]).map((c) => c[1]);
      expect(addedServiceNames).not.toContain('Comfort Breeze');
    });

    it('hasComfortBreeze returns true when capability present', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.TOGGLE, 'enabled', 'comfort-breeze')]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);
      expect(fanAcc.hasComfortBreeze()).toBe(true);
    });

    it('hasComfortBreeze returns false when capability absent', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.POWER, 'on', 'fan-power')]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);
      expect(fanAcc.hasComfortBreeze()).toBe(false);
    });
  });

  describe('StatusFault (exposeStatusFault)', () => {
    it('pushes NO_FAULT when available is true and exposeStatusFault is enabled', () => {
      const platform = makePlatform({ exposeStatusFault: true });
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.POWER, 'on', 'fan-power'), sv(FC.AVAILABLE, true)]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);

      fanAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        StatusFault, StatusFault.NO_FAULT,
      );
    });

    it('pushes GENERAL_FAULT when available is false and exposeStatusFault is enabled', () => {
      const platform = makePlatform({ exposeStatusFault: true });
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.POWER, 'on', 'fan-power'), sv(FC.AVAILABLE, false)]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);

      fanAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        StatusFault, StatusFault.GENERAL_FAULT,
      );
    });

    it('does not push StatusFault when exposeStatusFault is disabled', () => {
      const platform = makePlatform({ exposeStatusFault: false });
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.POWER, 'on', 'fan-power'), sv(FC.AVAILABLE, false)]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);

      fanAcc.updateState(device.values);

      const calls = (platform._svc.updateCharacteristic.mock.calls as any[]);
      expect(calls.some(c => c[0] === StatusFault)).toBe(false);
    });
  });
});

// ── LightAccessory ────────────────────────────────────────────────────────────

describe('LightAccessory', () => {
  describe('power', () => {
    it.each([
      ['on', true],
      ['off', false],
      ['true', true],
      [true, true],
      [1, true],
      [false, false],
      [0, false],
    ])('power %j → %s', (value, expected) => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeLightDevice([sv(FC.POWER, value as any)]);
      const lightAcc = new LightAccessory(platform as any, acc as any, device as any);

      lightAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith('On', expected);
    });
  });

  describe('brightness', () => {
    it('pushes brightness value', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeLightDevice([sv(FC.POWER, 'on'), sv(FC.BRIGHTNESS, 75)]);
      const lightAcc = new LightAccessory(platform as any, acc as any, device as any);

      lightAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith('Brightness', 75);
    });

    it('rounds fractional brightness', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeLightDevice([sv(FC.BRIGHTNESS, 74.6)]);
      const lightAcc = new LightAccessory(platform as any, acc as any, device as any);

      lightAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith('Brightness', 75);
    });
  });

  describe('color temperature', () => {
    it('parses K-suffixed Hubspace color-temperature values', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeLightDevice([sv(FC.COLOR_TEMP, '4000K')]);
      const lightAcc = new LightAccessory(platform as any, acc as any, device as any);

      lightAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith('ColorTemperature', 250);
    });

    it('preserves K-suffixed color-temperature format when writing', async () => {
      jest.useFakeTimers();
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeLightDevice([sv(FC.COLOR_TEMP, '4000K')]);
      new LightAccessory(platform as any, acc as any, device as any);
      const onSetColorTemperature: (v: number) => void =
        (platform._svc._char.onSet as jest.Mock).mock.calls[1][0];

      onSetColorTemperature(222);
      jest.runOnlyPendingTimers();
      await Promise.resolve();
      jest.runOnlyPendingTimers();
      await Promise.resolve();
      jest.useRealTimers();

      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[0];
      expect(patches).toEqual([
        expect.objectContaining({ functionClass: FC.COLOR_TEMP, value: '4505K' }),
      ]);
    });
  });

  describe('state updates', () => {
    it('reflects new power value on updateState', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeLightDevice([sv(FC.POWER, 'off')]);
      const lightAcc = new LightAccessory(platform as any, acc as any, device as any);

      lightAcc.updateState([sv(FC.POWER, 'on')]);

      expect(platform._svc.updateCharacteristic).toHaveBeenLastCalledWith('On', true);
    });
  });

  describe('StatusFault (exposeStatusFault)', () => {
    it('pushes GENERAL_FAULT when available is false and exposeStatusFault is enabled', () => {
      const platform = makePlatform({ exposeStatusFault: true });
      const acc = makeAccessoryMock(platform);
      const device = makeLightDevice([sv(FC.POWER, 'on'), sv(FC.AVAILABLE, false)]);
      const lightAcc = new LightAccessory(platform as any, acc as any, device as any);

      lightAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        StatusFault, StatusFault.GENERAL_FAULT,
      );
    });

    it('does not push StatusFault when exposeStatusFault is disabled', () => {
      const platform = makePlatform({ exposeStatusFault: false });
      const acc = makeAccessoryMock(platform);
      const device = makeLightDevice([sv(FC.POWER, 'on'), sv(FC.AVAILABLE, false)]);
      const lightAcc = new LightAccessory(platform as any, acc as any, device as any);

      lightAcc.updateState(device.values);

      const calls = (platform._svc.updateCharacteristic.mock.calls as any[]);
      expect(calls.some(c => c[0] === StatusFault)).toBe(false);
    });
  });
});

// ── OutletAccessory ───────────────────────────────────────────────────────────

describe('OutletAccessory', () => {
  describe('power', () => {
    it.each([
      ['on', true],
      ['off', false],
      [true, true],
      [1, true],
    ])('power %j → %s', (value, expected) => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeOutletDevice([sv(FC.POWER, value as any)]);
      const outletAcc = new OutletAccessory(platform as any, acc as any, device as any);

      outletAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith('On', expected);
    });

    it('falls back to toggle function class', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeOutletDevice([sv(FC.TOGGLE, 'on')]);
      const outletAcc = new OutletAccessory(platform as any, acc as any, device as any);

      outletAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith('On', true);
    });
  });

  describe('StatusFault (outlet service only)', () => {
    it('pushes NO_FAULT when available is true', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeOutletDevice([sv(FC.POWER, 'on'), sv(FC.AVAILABLE, true)]);
      const outletAcc = new OutletAccessory(platform as any, acc as any, device as any);

      outletAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        StatusFault, StatusFault.NO_FAULT,
      );
    });

    it('pushes GENERAL_FAULT when available is false', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeOutletDevice([sv(FC.POWER, 'on'), sv(FC.AVAILABLE, false)]);
      const outletAcc = new OutletAccessory(platform as any, acc as any, device as any);

      outletAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        StatusFault, StatusFault.GENERAL_FAULT,
      );
    });

    it('assumes NO_FAULT when available field is absent', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeOutletDevice([sv(FC.POWER, 'on')]);
      const outletAcc = new OutletAccessory(platform as any, acc as any, device as any);

      outletAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        StatusFault, StatusFault.NO_FAULT,
      );
    });
  });
});

// ── PortableAcAccessory ───────────────────────────────────────────────────────

function makeAcDevice(values: DeviceStateValue[]) {
  return {
    id: 'ac-1', allIds: ['ac-1'], typeId: 'metadevice.device',
    friendlyName: 'Bedroom AC', deviceClass: 'portable-air-conditioner',
    manufacturerName: 'Vissani', model: 'VAP05R1AWT', values,
  };
}

function makeAcValues(overrides: Partial<Record<string, DeviceStateValue['value']>> = {}): DeviceStateValue[] {
  return [
    sv(FC.POWER, overrides['power'] ?? 'on'),
    sv(FC.MODE, overrides['mode'] ?? 'cool'),
    sv(FC.TEMPERATURE, overrides['current-temp'] ?? 22, 'current-temp'),
    sv(FC.TEMPERATURE, overrides['cooling-target'] ?? 22, 'cooling-target'),
    sv(FC.FAN_SPEED, overrides['fan-speed'] ?? 'fan-speed-auto', 'ac-fan-speed'),
  ];
}

describe('PortableAcAccessory', () => {
  describe('Active (power)', () => {
    it.each([
      ['on', Active.ACTIVE],
      ['off', Active.INACTIVE],
    ])('power "%s" → Active %i', (value, expected) => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeAcDevice(makeAcValues({ power: value }));
      const ac = new PortableAcAccessory(platform as any, acc as any, device as any);

      ac.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(Active, expected);
    });
  });

  describe('CurrentHeaterCoolerState', () => {
    it('returns INACTIVE when power is off', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeAcDevice(makeAcValues({ power: 'off' }));
      const ac = new PortableAcAccessory(platform as any, acc as any, device as any);

      ac.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        CurrentHeaterCoolerState, CurrentHeaterCoolerState.INACTIVE);
    });

    it('returns COOLING when power is on', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeAcDevice(makeAcValues({ power: 'on' }));
      const ac = new PortableAcAccessory(platform as any, acc as any, device as any);

      ac.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        CurrentHeaterCoolerState, CurrentHeaterCoolerState.COOLING);
    });
  });

  describe('TargetHeaterCoolerState', () => {
    it('always returns COOL', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeAcDevice(makeAcValues());
      const ac = new PortableAcAccessory(platform as any, acc as any, device as any);

      ac.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        TargetHeaterCoolerState, TargetHeaterCoolerState.COOL);
    });
  });

  describe('CurrentTemperature', () => {
    it('reads current-temp value', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeAcDevice(makeAcValues({ 'current-temp': 23 }));
      const ac = new PortableAcAccessory(platform as any, acc as any, device as any);

      ac.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        'CurrentTemperature', 23);
    });
  });

  describe('CoolingThresholdTemperature', () => {
    it('reads cooling-target value', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeAcDevice(makeAcValues({ 'cooling-target': 20 }));
      const ac = new PortableAcAccessory(platform as any, acc as any, device as any);

      ac.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        'CoolingThresholdTemperature', 20);
    });
  });

  describe('fan speed (RotationSpeed)', () => {
    it.each([
      ['fan-speed-auto', 33],
      ['fan-speed-low',  66],
      ['fan-speed-high', 99],
    ])('%s → %i%% when on', (raw, expected) => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeAcDevice(makeAcValues({ power: 'on', 'fan-speed': raw }));
      const ac = new PortableAcAccessory(platform as any, acc as any, device as any);

      ac.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        'RotationSpeed', expected);
    });

    it('shows stored speed when AC is off so HomeKit slider stays at last-used speed', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeAcDevice(makeAcValues({ power: 'off', 'fan-speed': 'fan-speed-high' }));
      const ac = new PortableAcAccessory(platform as any, acc as any, device as any);

      ac.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith('RotationSpeed', 99);
    });
  });

  describe('StatusFault (error states)', () => {
    it('reports NO_FAULT when all errors are normal', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeAcDevice([
        ...makeAcValues(),
        sv('error', 'normal', 'water-tray-full'),
        sv('error', 'normal', 'indoor-temperature-sensor-failed'),
      ]);
      const ac = new PortableAcAccessory(platform as any, acc as any, device as any);

      ac.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        StatusFault, StatusFault.NO_FAULT);
    });

    it('reports GENERAL_FAULT when water-tray-full is not normal', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeAcDevice([
        ...makeAcValues(),
        sv('error', 'water-tray-full', 'water-tray-full'),
      ]);
      const ac = new PortableAcAccessory(platform as any, acc as any, device as any);

      ac.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        StatusFault, StatusFault.GENERAL_FAULT);
    });
  });

  describe('offline', () => {
    it('sets noResponse on Active when offline', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeAcDevice([
        sv(FC.POWER, 'on'),
        sv(FC.MODE, 'cool'),
        sv(FC.TEMPERATURE, 22, 'current-temp'),
        sv(FC.AVAILABLE, false),
      ]);
      const ac = new PortableAcAccessory(platform as any, acc as any, device as any);

      ac.updateState(device.values);

      const calls = (platform._svc.updateCharacteristic as jest.Mock).mock.calls;
      const activeCall = calls.find((c: unknown[]) => c[0] === Active);
      expect(activeCall?.[1]).toBeInstanceOf(Error);
    });
  });

  // ── Setter behaviour (write-queue coalescing) ─────────────────────────────────
  // With full makeAcValues (cooling-target + fan-speed present), the onSet
  // handlers are registered in this order:
  //   [0] Active (setActive)
  //   [1] TargetHeaterCoolerState
  //   [2] CoolingThresholdTemperature (setCoolingTarget)
  //   [3] RotationSpeed (setAcFanSpeed)
  //
  // setDeviceValues enqueues patches and flushes on the next event-loop tick
  // via setTimeout(0), so tests use fake timers and jest.runAllTimers().

  describe('write-queue coalescing', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    function setup() {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeAcDevice(makeAcValues());
      new PortableAcAccessory(platform as any, acc as any, device as any);
      const onSetActive: (v: number) => void =
        (platform._svc._char.onSet as jest.Mock).mock.calls[0][0];
      const onSetFanSpeed: (v: number) => void =
        (platform._svc._char.onSet as jest.Mock).mock.calls[3][0];
      return { platform, onSetActive, onSetFanSpeed };
    }

    it('coalesces simultaneous power=on and fan-speed into one PUT', async () => {
      const { platform, onSetActive, onSetFanSpeed } = setup();
      onSetActive(Active.ACTIVE);
      onSetFanSpeed(99);
      expect(platform.client.setDeviceState).not.toHaveBeenCalled();
      jest.runAllTimers();
      await Promise.resolve();
      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[0];
      expect(patches).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionClass: FC.POWER, value: 'on' }),
        expect.objectContaining({ functionClass: FC.FAN_SPEED, value: 'fan-speed-high' }),
      ]));
    });

    it('last write wins when the same key is enqueued twice', async () => {
      const { platform, onSetFanSpeed } = setup();
      onSetFanSpeed(33);
      onSetFanSpeed(99);
      jest.runAllTimers();
      await Promise.resolve();
      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[0];
      const fanPatch = patches.find((p: { functionClass: string }) =>
        p.functionClass === FC.FAN_SPEED);
      expect(fanPatch).toEqual(expect.objectContaining({ value: 'fan-speed-high' }));
    });

    it.each([
      [33, 'fan-speed-auto'],
      [66, 'fan-speed-low'],
      [99, 'fan-speed-high'],
    ])('fan %i%% → %s in the flushed batch', async (pct, expected) => {
      const { platform, onSetFanSpeed } = setup();
      onSetFanSpeed(pct);
      jest.runAllTimers();
      await Promise.resolve();
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[0];
      expect(patches).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionClass: FC.FAN_SPEED, value: expected }),
      ]));
    });

    it('fan speed 0 enqueues power=off', async () => {
      const { platform, onSetFanSpeed } = setup();
      onSetFanSpeed(0);
      jest.runAllTimers();
      await Promise.resolve();
      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[0];
      expect(patches).toEqual([
        expect.objectContaining({ functionClass: FC.POWER, value: 'off' }),
      ]);
    });

    it('turns on without replacing the stored fan mode with HomeKit synthetic high', async () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeAcDevice(makeAcValues({ power: 'off', 'fan-speed': 'fan-speed-low' }));
      new PortableAcAccessory(platform as any, acc as any, device as any);
      const onSetActive: (v: number) => void =
        (platform._svc._char.onSet as jest.Mock).mock.calls[0][0];
      const onSetFanSpeed: (v: number) => void =
        (platform._svc._char.onSet as jest.Mock).mock.calls[3][0];

      onSetActive(Active.ACTIVE);
      onSetFanSpeed(99);
      jest.runAllTimers();
      await Promise.resolve();

      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[0];
      expect(patches).toEqual([
        expect.objectContaining({ functionClass: FC.POWER, value: 'on' }),
      ]);
      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith('RotationSpeed', 66);
    });

    it('still allows an explicit high fan mode while already on', async () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeAcDevice(makeAcValues({ power: 'on', 'fan-speed': 'fan-speed-low' }));
      new PortableAcAccessory(platform as any, acc as any, device as any);
      const onSetFanSpeed: (v: number) => void =
        (platform._svc._char.onSet as jest.Mock).mock.calls[3][0];

      onSetFanSpeed(99);
      jest.runAllTimers();
      await Promise.resolve();

      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[0];
      expect(patches).toEqual([
        expect.objectContaining({ functionClass: FC.FAN_SPEED, value: 'fan-speed-high' }),
      ]);
    });
  });
});

// ── LandscapeTransformerAccessory ─────────────────────────────────────────────

function makeLandscapeDevice(values: DeviceStateValue[]) {
  return {
    id: 'landscape-1', allIds: ['landscape-1'], typeId: 'metadevice.device',
    friendlyName: 'Front Landscape Lights', deviceClass: 'landscape-transformer',
    manufacturerName: 'Hampton Bay', model: 'HB-200-1215WIFI', values,
  };
}

describe('LandscapeTransformerAccessory', () => {
  describe('master power', () => {
    it.each([
      ['on', true],
      ['off', false],
    ])('power[default]=%j → On=%s', (value, expected) => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeLandscapeDevice([sv(FC.POWER, value as any)]);
      const xfmr = new LandscapeTransformerAccessory(platform as any, acc as any, device as any);

      xfmr.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith('On', expected);
    });

    it('sends power patch on setMasterPower', async () => {
      jest.useFakeTimers();
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeLandscapeDevice([sv(FC.POWER, 'off')]);
      new LandscapeTransformerAccessory(platform as any, acc as any, device as any);

      const onSet: (v: boolean) => void =
        (platform._svc._char.onSet as jest.Mock).mock.calls[0][0];
      onSet(true);
      jest.runAllTimers();
      await Promise.resolve();

      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[0];
      expect(patches).toEqual([
        expect.objectContaining({ functionClass: FC.POWER, value: 'on' }),
      ]);
      jest.useRealTimers();
    });
  });

  describe('zones', () => {
    it('updates On for each zone on pushCharacteristics', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeLandscapeDevice([
        sv(FC.POWER, 'on'),
        sv(FC.TOGGLE, 'on', 'zone-1'),
        sv(FC.TOGGLE, 'off', 'zone-2'),
        sv(FC.TOGGLE, 'on', 'zone-3'),
      ]);
      const xfmr = new LandscapeTransformerAccessory(platform as any, acc as any, device as any);

      xfmr.updateState(device.values);

      const calls = (platform._svc.updateCharacteristic as jest.Mock).mock.calls
        .filter(([c]) => c === 'On');
      // master + 3 zones = 4 On updates
      expect(calls.length).toBe(4);
    });

    it('sends toggle patch for a zone', async () => {
      jest.useFakeTimers();
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeLandscapeDevice([
        sv(FC.POWER, 'on'),
        sv(FC.TOGGLE, 'off', 'zone-1'),
        sv(FC.TOGGLE, 'off', 'zone-2'),
        sv(FC.TOGGLE, 'off', 'zone-3'),
      ]);
      new LandscapeTransformerAccessory(platform as any, acc as any, device as any);

      const onSet: (v: boolean) => void =
        (platform._svc._char.onSet as jest.Mock).mock.calls[1][0];
      onSet(true);
      jest.runAllTimers();
      await Promise.resolve();

      expect(platform.client.setDeviceState).toHaveBeenCalledTimes(1);
      const [, patches] = (platform.client.setDeviceState as jest.Mock).mock.calls[0];
      expect(patches).toEqual([
        expect.objectContaining({ functionClass: FC.TOGGLE, value: 'on' }),
      ]);
      jest.useRealTimers();
    });
  });

  describe('StatusFault', () => {
    it('reports NO_FAULT when overload-state is normal', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeLandscapeDevice([
        sv(FC.POWER, 'on'),
        sv('overload-state', 'normal', 'default'),
      ]);
      const xfmr = new LandscapeTransformerAccessory(platform as any, acc as any, device as any);

      xfmr.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        StatusFault, StatusFault.NO_FAULT,
      );
    });

    it('reports GENERAL_FAULT when overload-state is not normal', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeLandscapeDevice([
        sv(FC.POWER, 'on'),
        sv('overload-state', 'overload', 'default'),
      ]);
      const xfmr = new LandscapeTransformerAccessory(platform as any, acc as any, device as any);

      xfmr.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith(
        StatusFault, StatusFault.GENERAL_FAULT,
      );
    });
  });

  describe('offline', () => {
    it('sets No Response for master and zones when offline', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeLandscapeDevice([
        sv(FC.POWER, 'on'),
        sv(FC.TOGGLE, 'on', 'zone-1'),
        sv(FC.TOGGLE, 'on', 'zone-2'),
        sv(FC.AVAILABLE, false),
      ]);
      const xfmr = new LandscapeTransformerAccessory(platform as any, acc as any, device as any);
      (platform._svc.updateCharacteristic as jest.Mock).mockClear();

      xfmr.updateState(device.values);

      const onCalls = (platform._svc.updateCharacteristic as jest.Mock).mock.calls
        .filter(([c]) => c === 'On');
      // master + 2 zones = 3 On updates, all with noResponse (Error)
      expect(onCalls.length).toBe(3);
      onCalls.forEach(([, v]) => expect(v).toBeInstanceOf(Error));
    });
  });
});
