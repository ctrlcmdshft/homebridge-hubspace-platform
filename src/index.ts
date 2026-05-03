import { API } from 'homebridge';
import { PLUGIN_NAME, PLATFORM_NAME } from './types';
import { HubspacePlatform } from './platform';

/**
 * This is the entry point Homebridge loads from `dist/index.js`.
 * It registers the platform with Homebridge's plugin registry.
 */
export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, HubspacePlatform);
};
