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
- Update `CHANGELOG.md` when the change will ship in the next release
- Keep changes focused — don't refactor unrelated code in the same PR

## Maintainer notes

### Device support reply template

Use this after publishing a test build for a user-reported device:

```text
I added test support for this device in homebridge-hubspace-platform@VERSION.

To test it, install the test version:

npm install -g homebridge-hubspace-platform@test

Then restart Homebridge. Please let me know:
- whether the accessory appears in HomeKit
- which controls work
- which controls are missing or affect the wrong device/endpoint
- any SET STATE errors from the Homebridge log
```

### Test build workflow

1. Start from `test` or a short-lived feature branch based on `main`.
2. Bump to a prerelease version, for example `2.1.5-test.0`.
3. Run `npm test -- --runInBand`, `npm run prepublishOnly`, and `npm pack --dry-run`.
4. Publish with `npm publish --tag test`.
5. Ask the reporter to install `homebridge-hubspace-platform@test` and confirm behavior.

### Stable release workflow

1. Promote the tested change to a stable version in `package.json` and `package-lock.json`.
2. Add top-of-file release notes in `CHANGELOG.md`.
3. Run `npm test -- --runInBand`, `npm run prepublishOnly`, and `npm pack --dry-run`.
4. Commit with `chore: release VERSION`.
5. Fast-forward `main`, tag `vVERSION`, push `main` and the tag.
6. Create a GitHub release using the same notes as `CHANGELOG.md`.
7. Publish npm with `npm publish --tag latest`.
8. Remove the temporary test dist-tag with `npm dist-tag rm homebridge-hubspace-platform test`.
