# Contributing

Thanks for helping improve this plugin.

## Requesting support for a new device

If your Hubspace device doesn't appear in HomeKit, see the [Requesting support for a new device](README.md#requesting-support-for-a-new-device) section in the README. It walks through enabling verbose logging and capturing everything needed to add support.

Use the **Request device support** issue template when opening the issue — it pre-fills the right fields.

## Reporting a bug

Use the **Bug report** issue template. Include the plugin version, Homebridge version, and relevant log lines (enable `"debug": true` to get more detail).

## Local development

```bash
git clone https://github.com/ctrlcmdshft/homebridge-hubspace-platform.git
cd homebridge-hubspace-platform
npm install
npm run build    # compile once
npm run watch    # recompile on save
npm test         # run tests
```

See the [Development wiki](https://github.com/ctrlcmdshft/homebridge-hubspace-platform/wiki/Development) for API endpoint details and the `discover.mjs` exploration script.

## Pull requests

- One concern per PR
- Run `npm run lint` and `npm test` before opening
- Update `CHANGELOG.md` under `[Unreleased]`
- Keep changes focused — don't refactor unrelated code in the same PR
