import { LightAccessory, FanAccessory, OutletAccessory } from '../src/accessory';
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
    setCharacteristic: jest.fn().mockReturnThis(),
    updateCharacteristic: jest.fn(),
  };
}

// These objects are the same references stored in platform.Characteristic —
// use them in assertions so they match what the code passes to updateCharacteristic.
const Active = { ACTIVE: 1, INACTIVE: 0 };
const StatusFault = { NO_FAULT: 0, GENERAL_FAULT: 1 };

function makePlatform() {
  const svc = makeSvcMock();
  return {
    log: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    debug: false,
    client: { setDeviceState: jest.fn().mockResolvedValue(undefined) },
    scheduleQuickPoll: jest.fn(),
    Service: {
      Fanv2: 'Fanv2',
      Lightbulb: 'Lightbulb',
      Outlet: 'Outlet',
      Switch: 'Switch',
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

  describe('comfort breeze', () => {
    it('pushes true when enabled', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.TOGGLE, 'enabled', 'comfort-breeze')]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);

      fanAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith('On', true);
    });

    it('pushes false when disabled', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.TOGGLE, 'disabled', 'comfort-breeze')]);
      const fanAcc = new FanAccessory(platform as any, acc as any, device as any);

      fanAcc.updateState(device.values);

      expect(platform._svc.updateCharacteristic).toHaveBeenCalledWith('On', false);
    });

    it('does not add comfort breeze service when capability absent', () => {
      const platform = makePlatform();
      const acc = makeAccessoryMock(platform);
      const device = makeFanDevice([sv(FC.POWER, 'on', 'fan-power')]);
      new FanAccessory(platform as any, acc as any, device as any);

      const addedServiceNames = (acc.addService.mock.calls as any[]).map((c) => c[1]);
      expect(addedServiceNames).not.toContain('Comfort Breeze');
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
