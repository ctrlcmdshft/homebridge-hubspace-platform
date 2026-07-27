"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FC = exports.SUPPORTED_DEVICE_CLASSES = exports.PLATFORM_NAME = exports.PLUGIN_NAME = void 0;
exports.PLUGIN_NAME = 'homebridge-hubspace-platform';
exports.PLATFORM_NAME = 'HubspacePlatform';
exports.SUPPORTED_DEVICE_CLASSES = new Set([
    'light',
    'fan',
    'ceiling-fan',
    'outlet',
    'switch',
    'plug',
    'power-outlet',
    'portable-air-conditioner',
    'landscape-transformer',
]);
exports.FC = {
    POWER: 'power',
    TOGGLE: 'toggle',
    BRIGHTNESS: 'brightness',
    COLOR_TEMP: 'color-temperature',
    COLOR_RGB: 'color-rgb',
    COLOR_MODE: 'color-mode',
    FAN_SPEED: 'fan-speed',
    FAN_REVERSE: 'fan-reverse',
    AVAILABLE: 'available',
    MODE: 'mode',
    TEMPERATURE: 'temperature',
    OVERLOAD_STATE: 'overload-state',
};
//# sourceMappingURL=types.js.map