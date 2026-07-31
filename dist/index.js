"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const types_1 = require("./types");
const platform_1 = require("./platform");
exports.default = (api) => {
    api.registerPlatform(types_1.PLUGIN_NAME, types_1.PLATFORM_NAME, platform_1.HubspacePlatform);
};
//# sourceMappingURL=index.js.map