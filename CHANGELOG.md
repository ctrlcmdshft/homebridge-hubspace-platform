# Changelog

## [Unreleased]

### Features

- **Portable AC support** — new `PortableAcAccessory` exposes Hubspace portable air conditioners as HomeKit **HeaterCooler** tiles; supports power on/off, cooling threshold temperature, current temperature (read-only), and fan speed (auto / low / high via RotationSpeed slider at 33 / 66 / 99%); overload and sensor faults surface as `StatusFault`; tested against Vissani VAP05R1AWT
- **Landscape lighting transformer support** — new `LandscapeTransformerAccessory` exposes Hampton Bay smart landscape transformers; provides a master power switch and one independent Switch tile per zone (`zone-1`, `zone-2`, `zone-3`); overload protection surfaces as `StatusFault`; zone count is detected automatically from device capabilities
- **`excludedDevices` config option** — comma-separated friendly names of devices to skip during discovery (e.g. `Bulb, Outdoor plug`); useful for sub-devices Hubspace exposes that you don't want in HomeKit; defaults to none

### Bug Fixes

- **Fan tile flashes 100% on power-on** — when the fan was off, `getFanSpeed()` returned 0, so HomeKit displayed a 0% slider; on power-on the Home app sent a synthetic `RotationSpeed=100` which was visible for ~1 second before settling on the correct speed; `getFanSpeed()` now returns the last-used speed even when inactive, keeping the slider position stable and preventing the synthetic 100% write
- **AC fan speed slider resets to 0% when off** — same root cause as the fan flash; `getAcFanSpeed()` now returns the stored device speed regardless of power state, keeping the HomeKit slider at the last-used position
- **Concurrent write 400 errors** — when HomeKit fired multiple `onSet` handlers simultaneously (e.g. power + fan speed on tile tap), each handler dispatched a separate HTTP PUT which the Hubspace API rejected with 400; `setDeviceValues()` now coalesces all patches queued within the same event-loop tick into a single PUT
- **Write failure log shows sent payload** — error log on a failed SET STATE now includes the exact patch that was sent (functionClass, functionInstance, value) alongside the full API response body, making 400 errors diagnosable without enabling verbose mode
- **Plugin UI login could hang indefinitely** — the login/2FA setup screen relied on a single request/response round-trip over Homebridge's IPC channel, so a dropped message left the UI spinning forever with no way to recover; the UI server now proactively pushes `auth-status`, `start-login`, and `submit-otp` results as IPC push events, and the browser races each one against a timeout (`waitForPush`/`withTimeout`) so a lost message surfaces an error or falls back instead of hanging
- **Plugin UI could report "Connected" after a failed login** — if the `/start-login` push timed out, the UI assumed success and saved credentials regardless of the actual outcome; a timeout now surfaces a clear retry error instead
- **Concurrent login/OTP requests could corrupt session state** — overlapping `/start-login` or `/submit-otp` IPC messages (e.g. a stale retry after a client-side timeout) could race and clobber the in-progress OTP session; these routes are now serialized so a second attempt is rejected with a clear "already in progress" error instead of corrupting state
- **`kelvinToMired` could return `NaN` or `Infinity`** — a zero or invalid Kelvin input passed straight through to the HomeKit color-temperature characteristic instead of being clamped; now falls back to 140 mireds
- **Plugin UI always showed "Checking…" for the full 5 seconds on open** — `/auth-status` was fetched via a one-time server push sent at UI-process construction, but homebridge-config-ui-x reuses the same long-lived UI process across page loads, so only the very first page load ever saw that push; every later visit waited out the full timeout for a push that would never arrive; `/auth-status` now uses plain request/response (dispatched fresh on every call, regardless of process age), which is what it should have used all along since it's a fast local read with no risk of hanging
- **`excludedDevices` matching was case-sensitive** — inconsistent with the case-insensitive `friendlyName` matching already used for fan/light dedup in `hubspace-client.ts`; a case mismatch in a hand-typed exclusion list would silently exclude nothing; matching is now case-insensitive, and any exclusion entry that doesn't match a discovered device now logs a warning to help catch typos

### Internal

- **Added `test/platform.test.ts`** — covers `discoverDevices()`'s `excludedDevices` filtering (string and legacy array formats, case-insensitivity, typo warnings) and the unsupported-deviceClass path, which previously had no test coverage at all
- **Removed `src/dump-devices.ts`** — the old TypeScript dump script compiled to `dist/dump-devices.js` and shipped unnecessarily in the npm tarball; it also lacked 2FA support; `npm run dump` now runs `scripts/dump-devices.js` directly (the 2FA-capable standalone version) without requiring a build step first
- **Removed unused `@homebridge/plugin-ui-utils` dependency** — never imported; `homebridge-ui/server.js` implements its own minimal IPC class instead

---

## [2.0.3] - 2026-05-24

### Features

- **Device capability dump script** — `scripts/dump-devices.js` is a standalone Node 18+ script that prints every device on your account with its full capability and value list; useful for opening device support requests without needing debug logs from a running Homebridge instance; run via curl one-liner (see README); supports accounts with 2FA enabled; sensitive fields (`geo-coordinates`, `wifi-ssid`, `wifi-mac-address`, `ble-mac-address`) are always redacted from output

### Bug Fixes

- **`error-flag` now triggers StatusFault** — fans reporting `acz-error` or `storage-error` hardware faults (via `error-flag:*` state values) now correctly surface `StatusFault.GENERAL_FAULT` in HomeKit when `exposeStatusFault: true` is set; previously only `available=false` (device offline) triggered StatusFault

### Privacy

- **Sensitive fields redacted from debug logs** — `geo-coordinates`, `wifi-ssid`, `wifi-mac-address`, and `ble-mac-address` are no longer included in the raw capability dump that appears in Homebridge logs when `debug: true` is set for an unsupported device

---

## [2.0.2] - 2026-05-24

### Improvements

- **Structured log categories** — log output is now tagged by subsystem so related messages are easy to scan at a glance: `[Auth]` for token load, login, and refresh activity; `[Conclave]` for push connection details and events; `[Device]` for per-accessory status messages; `[Poll]` for polling cycle results and failures
- **Conclave log noise reduced** — quick-poll triggers, full hub sweeps, and device ID resolution messages (`Resolved abc123 → "Device Name"`) are now hidden behind the `debug` flag; normal logs only show Conclave startup details and genuine warnings

### Bug Fixes

- **Silent debug gate** — two log gates in the polling cycle referenced `this.config.debug` (which doesn't exist) instead of `this.debug`; those messages were never emitted even with `debug: true` enabled; fixed
- **Unsupported device warning alignment** — `Hardware` and `Capabilities` labels in the unsupported-device skip warning now column-align correctly

### Config

- **`pollingInterval` description corrected** — removed the false claim that "values below 300 s are ignored when Conclave is active"; the field accepts 10–600 s regardless of Conclave state
- **`debug` description updated** — now accurately describes what is logged: API calls (GET/SET STATE, token refresh), Conclave push details (quick-polls, device ID resolution, hub sweeps), and raw capability dumps for unsupported devices

---

## [2.0.1] - 2026-05-23

This is the first release with two-factor authentication support. The custom login UI, Conclave real-time push overhaul, and fan rotation direction are the headline changes. All alpha versions (2.0.1-alpha.1 through alpha.7) have been unpublished.

### Features

- **Two-factor authentication (2FA)** — the plugin now ships a Homebridge custom UI for logging in; open plugin settings in Homebridge UI and click **Start Login** to launch a PKCE OAuth flow via the official Hubspace iOS client; accounts without 2FA log in immediately; accounts with 2FA are prompted for the one-time email code in the UI; no credentials are sent outside of the official Hubspace/Afero auth stack
- **Fan rotation direction** — fans that report the `fan-reverse` capability now expose a `RotationDirection` characteristic in HomeKit; maps `forward` → Clockwise and `reverse` → CounterClockwise; direction changes are pushed to the device via Conclave
- **"No Response" in HomeKit when a device is offline** — all accessories now monitor the `available` field returned by the Afero REST API; when a device loses cloud reachability (`available=false`) HomeKit immediately shows "No Response" on the tile. The indicator clears automatically on the next successful poll once the device comes back online
- **Conclave push connection overhauled** — real-time `attr_change` and `status_change` events now flow correctly; fixed login type (`client` instead of `socket`) and added handling for `private` envelopes (the format Afero uses for device events); state changes made in the Hubspace app are reflected in HomeKit within ~500 ms
- **BLE-MAC device ID resolution** — Conclave events carry a `{4-char-prefix}{ble-mac}` device ID that didn't previously match our handler map; the plugin now resolves these against each device's `ble-mac-address` state value and caches the result, so WiFi-direct devices (plugs, outlets) quick-poll immediately on push
- **Hub-event sweep** — when Conclave fires an event for an unresolved 16-hex-char device ID (a hub or gateway), the plugin triggers a full state poll of all devices; this accelerates offline/online detection for hub-connected lights and tape lights without requiring a separate timer
- **App-open sweep** — when the Hubspace mobile app opens and joins the Conclave channel, the plugin detects the `join` event and triggers a full sweep 1 s later; this replicates the refresh effect users noticed when opening the app manually
- **Polling floor removed for Conclave-active mode** — the 300 s minimum polling interval that was applied when Conclave was active has been removed; the default is 30 s regardless, giving faster offline detection for devices that don't emit push events
- **`onGet` handlers enforce offline state** — every characteristic `onGet` handler throws a HAP `SERVICE_COMMUNICATION_FAILURE` error when the device is offline, preventing HomeKit's own polling from silently clearing the "No Response" indicator between poll cycles
- **Poll-failure offline detection** — after 3 consecutive failed API polls for a device (network issues, API outages), the plugin proactively sets "No Response" without waiting for an `available=false` signal; clears on the next successful poll

### Improvements

- **StatusFault now tracks `this.offline`** — the `StatusFault` characteristic (opt-in `exposeStatusFault: true` for lights/fans; always-on for outlets) now derives its value from the same `offline` flag used for "No Response", so both signals are always in sync; previously `StatusFault` re-read the raw `available` field independently
- **StatusFault pushed before the offline early-return** — `StatusFault.GENERAL_FAULT` is now correctly pushed to third-party HomeKit apps (Eve, Controller for HomeKit) even when the device is offline, fixing a regression where the early-return path skipped the StatusFault push
- **Conclave diagnostic logging cleaned up** — raw byte-count logging removed; `tunnel` and `join` envelopes handled silently; device event log moved to `debug` level; double `[Conclave]` prefix in join-event messages fixed
- **Conclave settle window** — a 3-second settle period after the initial `welcome` prevents the burst of existing-session `join` events from triggering a redundant full sweep on startup

### Bug Fixes

- **N-speed fan support** — fans reporting speed as `fan-speed-N-VVV` (e.g. `fan-speed-6-016` for a 6-speed fan at 16%) are now correctly parsed and written; the plugin detects the N in the value format, maps percentage to the nearest valid step, and writes back the same `fan-speed-N-ZZZ` format; fixes HomeKit always showing 50% and set-speed commands returning HTTP 400 on affected models
- **Multi-outlet support** — surge wall taps and outdoor plugs exposing multiple independently-controlled outlets are now correctly represented as separate outlet tiles in HomeKit; each outlet reports its own on/off state and responds to commands independently
- **Login UI hang** — removing `savePluginConfig()` from the custom UI success path prevents Homebridge from restarting mid-login and destroying the IPC channel before the spinner could stop; the UI no longer shows an infinite spinner after a successful login
- **Color temperature clamp** — devices reporting color temperatures above 6500 K produced mired values below HAP's minimum of 154, causing a characteristic validation error; values are now clamped to the valid mired range before being sent to HomeKit
- **Outlet StatusFault HAP warning** — `addOptionalCharacteristic(StatusFault)` is now called before the first `pushCharacteristics()` fires, eliminating the "Adding anyway" HAP warning on outlet accessories at startup

---

## [1.2.2] - 2026-05-17

### Improvements

- **Unsupported device diagnostics** — when a device is skipped due to an unrecognised `deviceClass`, the warn log now includes the hardware model, full capability list, and a direct link to open a GitHub issue; with `"debug": true` the raw state values are also logged so exact API field formats are visible without running a separate script
- **`pollingInterval` clamped in code** — values outside 10–600 s are now clamped at runtime regardless of how config.json was edited; when Conclave is active the floor is raised to 300 s to prevent unnecessary polling
- **Model / Manufacturer characteristic guard** — empty or single-character model and manufacturer strings from the Hubspace API no longer trigger a HomeKit "characteristic must have a length of more than 1 character" warning; falls back to `typeId` / `"Hubspace"` respectively
- **`pollingInterval` default changed from 30 to 300** — the UI slider now starts at 300 s to match the effective default when Conclave is active; users who had it set to 30 will see it clamped to 300 s automatically

### Docs

- **Requesting support for a new device** — new README section with a step-by-step guide: enable `verbose`, capture the `Unsupported deviceClass` warning and `State for "..."` dump, open a GitHub issue with the right info
- **GitHub issue templates** — `device-support` and `bug-report` templates added under `.github/ISSUE_TEMPLATE/`; the device-support template pre-fills the exact fields needed to implement support
- **CONTRIBUTING.md** — new file pointing contributors to the requesting-support guide, bug template, local dev setup, and PR expectations
- **Development content moved to GitHub wiki** — local setup, API endpoints, authentication details, and `discover.mjs` are now at the [Development wiki page](https://github.com/ctrlcmdshft/homebridge-hubspace-platform/wiki/Development); README links there instead
- **README cleanup** — install section restructured into a single setup-by-environment table; `tokenCachePath` added to config options table; `exposeStatusFault` caveat added ("may not display in Apple Home"); `debug`/`verbose` descriptions rewritten with accurate detail; stale `10–600` range and "full API responses" wording corrected

### Maintenance

- **Homebridge 2.0** — `engines` and `devDependencies` updated from `^2.0.0-beta.0` to `^2.0.0` now that Homebridge 2.0 is generally available
- **`config.schema.json`** — `debug` field description synced with README ("GET STATE, SET STATE, token refresh, Conclave details")

### Hardware Verified

- **Hubspace Smart Light (non-color)** — on/off and brightness confirmed working on a Hubspace colour bulb in white mode
- **Hubspace Smart Light (color) / bulb** — `color-rgb` object format, `color-temperature`, and `color-mode` field names confirmed on a real colour bulb

---

## [1.2.1] - 2026-05-16

### Features

- **power-outlet device support** — Hubspace plugs reporting `deviceClass: "power-outlet"` are now recognised and exposed as HomeKit Outlet tiles; on/off confirmed working with real hardware

### Bug Fixes

- **color-rgb (LED strips)** — Hubspace returns `color-rgb` state as a nested object `{"color-rgb":{"r":N,"g":N,"b":N}}`, not a hex string; reads and writes both now use the object format, eliminating the repeated Saturation characteristic warning on every poll cycle; confirmed working on a real LED tape light
- **Immediate HomeKit response** — all `onSet` handlers are now fire-and-forget; HomeKit acknowledges commands instantly via optimistic update instead of waiting for the full API round-trip; a quick poll reverts state if the API call fails
- **Color temperature debounce** — `setColorTemp` had no debounce, causing up to 12 API writes in 3 seconds while dragging the slider; now debounced at 300 ms matching the brightness pattern
- **color-rgb debounce** — increased from 50 ms to 150 ms to prevent duplicate writes when hue and saturation updates arrive together from HomeKit
- **Unsupported device logging** — devices with an unrecognised `deviceClass` are now logged at `warn` level so they always appear in the Homebridge log; previously logged at `debug` which required Homebridge global debug mode to see

### Hardware Verified This Release

- **LED tape light** (`light` / `color-rgb`) — color, brightness, and on/off all confirmed working
- **Hubspace plug** (`power-outlet`) — on/off confirmed working

---

## [1.2.0] - 2026-05-14

### Features

- **Conclave real-time push** — the plugin now subscribes to the Afero Conclave TLS push service for real-time `attr_change` events; only the changed device is re-fetched from the API, eliminating unnecessary polling after every state change; a configurable slow-poll fallback remains active (floor of 300 s when Conclave is connected); can be disabled with `"disableConclave": true`
- **Comfort Breeze companion tile** — opt-in `exposeComfortBreeze: true` adds a separate "Comfort Breeze" Switch tile for fans that report the `toggle[comfort-breeze]` capability; off by default to keep tile count minimal
- **Master power switch tile** — opt-in `exposeMasterPowerSwitch: true` exposes the ceiling-fan master power relay as a standalone Switch tile on fans where the master relay is separate from the fan control itself
- **StatusFault on fans and lights** — opt-in `exposeStatusFault: true` extends offline detection to Fanv2 and Lightbulb accessories (outlets have had it since 1.1.22); uses `addOptionalCharacteristic` to prevent HAP validation warnings
- **Invert outlet status** — opt-in `invertOutletStatus: true` for smart plugs that report their on/off state inverted relative to what HomeKit expects
- **Verbose state logging** — opt-in `verbose: true` logs the full device state payload on every poll and every Conclave push; intended for API exploration and bug reports

### Bug Fixes

- **Fan speed range** — RotationSpeed now uses a 0–100 range with 25-step increments (was 25–100, showing as 0–75 in iOS); `setSpeed(0)` sends a power-off command; `getSpeed()` returns 0 when the fan is inactive
- **RotationSpeed HAP warning** — eliminated the "illegal value: number 0 exceeded minimum of 25" startup warning by applying the correct prop order on characteristic initialisation
- **pollingInterval honoured when Conclave is active** — previously Conclave replaced polling entirely regardless of config; the configured `pollingInterval` is now respected (with a 300 s floor when Conclave is connected)
- **Conclave heartbeat** — capped at 55 s to prevent NAT/firewall idle-timeout disconnects (server suggests 60 s, which is too close to many gateway idle limits)
- **Conclave teardown race** — nulling `this.socket` before calling `s.destroy()` prevents a duplicate reconnect when intentionally disconnecting

### Maintenance

- **displayName** — corrected plugin display name from "Hubspace Platform" to "Homebridge Hubspace Platform" so the Homebridge UI plugin search shows the full name
- **Plugin-gated debug messages** — messages controlled by the plugin's own `debug`/`verbose` flags now use `log.info()` instead of `log.debug()`; `log.debug()` is silenced by Homebridge unless its own global debug mode (`-D`) is enabled, making plugin-level debug flags invisible to users

---

## [1.1.22] - 2026-05-07

### Features

- **fans:** add Comfort Breeze switch — exposes the `toggle[comfort-breeze]` capability as a HomeKit Switch service on ceiling fans that support it; only appears if the device reports the capability
- **outlets:** offline detection via `available` field — when the Hubspace cloud reports an outlet as unavailable, HomeKit now shows a `StatusFault` indicator; clears automatically when the device comes back online (`StatusFault` is only valid on the Outlet service per the HAP spec)

## [1.1.21] - 2026-05-07

### Bug Fixes

- **fans:** fix HomeKit warning "illegal value: number 0 exceeded minimum of 25" on startup — the RotationSpeed characteristic is now initialised to the clamped fan speed (≥ 25) before props are applied, preventing HAP from validating a stale cached value of 0 against the 25–100 range

### Maintenance

- **token cache:** migrate file I/O from synchronous `fs` to `fs.promises` — eliminates the socket.dev `filesystemAccess` alert and removes blocking I/O from the async startup path
- **security:** add socket.dev `filesystemAccess` acknowledgment to `package.json` — the token cache write to Homebridge's storage path is intentional and expected plugin behaviour

---

## [1.1.20] - 2026-05-05

### Maintenance

- **ci:** drop Node.js 20 (EOL April 30, 2026) — CI now tests on Node 22 and 24 only, matching the official Homebridge plugin template
- **engines:** update `engines.node` to `^22 || ^24` to reflect active LTS support

---

## [1.1.19] - 2026-05-05

### Improvements

- **logging:** set-state errors now log a single concise line (HTTP status, error message, requestId) instead of dumping the full Axios error object — prevents JWT tokens from appearing in Homebridge logs
- **logging:** sustained API outages no longer spam the log — after 3 consecutive failed poll cycles the plugin emits one "API appears unreachable" warning and stays quiet until the API recovers, at which point it logs how many cycles were missed

---

## [1.1.17] - 2026-05-04

### Bug Fixes

- **fans:** set fan speed slider to 25/50/75/100 only — matches the Hubspace app's 4-step model; on/off is handled exclusively by the Active toggle, mirroring the app's independent speed and power controls

---

## [1.1.16] - 2026-05-04

### Bug Fixes

- **homekit:** optimistic state updates — HomeKit UI now reflects commands instantly instead of waiting for the next poll cycle; a targeted re-poll runs 3 s after each command to reconcile with cloud state, and reverts immediately if the API call fails

---

## [1.1.15] - 2026-05-04

### Bug Fixes

- **fans:** fix rotation speed slider capping at 75% — changed minValue from 25 to 0 so HomeKit renders all four steps (0/25/50/75/100); setting speed to 0 now turns the fan off via the Active characteristic

### Documentation

- **config:** add placeholder text to password field so the Homebridge UI shows example input

---

## [1.1.14] - 2026-05-04

### Bug Fixes

- **platform:** disable gracefully when credentials are not configured — if username or password are missing the plugin now logs a clear setup prompt, skips discovery and polling, and removes any previously cached accessories from HomeKit so they don't linger as "No Response"

---

## [1.1.13] - 2026-05-04

### Bug Fixes

- **outlets:** add `toggle` function class fallback — some Hubspace outlets report their power state under `toggle` instead of `power`; the plugin now checks both so these devices respond correctly
- **fans:** remove fan direction (reverse) control — direction is managed by a hardware pull chain or wall switch on most Hubspace fans and is not reliably controllable via the WiFi adapter; removed to avoid a misleading control in the Home app

### Documentation

- **readme:** split smart light color features into a separate row and mark color temperature and RGB as unverified API field names
- **readme:** remove fan direction from supported features list

---

## [1.1.12] - 2026-05-04

### Bug Fixes

- **packaging:** remove `homebridge` from `peerDependencies` — npm v7+ auto-installs peer dependencies which caused the Homebridge plugin verifier to flag homebridge and hap-nodejs as installed dependencies; homebridge is now declared only in `devDependencies` (for local TypeScript builds) and `engines` (for the version requirement), matching the standard verified plugin pattern

---

## [1.1.11] - 2026-05-04

### Bug Fixes

- **schema:** remove invalid `"required": true` from individual config fields — JSON Schema requires `required` to be an array at the object level, not a boolean on each property; the object-level `"required": ["username", "password"]` already handles this correctly
- **packaging:** remove `homebridge` from `devDependencies` — it is declared as a `peerDependency` which npm v7+ installs automatically, so listing it in `devDependencies` caused the Homebridge plugin verifier to flag it as an unnecessary installed dependency

---

## [1.1.10] - 2026-05-04

### Bug Fixes

- **lights:** debounce brightness slider to eliminate lag — HomeKit fires a brightness update on every drag tick; now waits 300 ms after the last movement before sending a single write with the final value

---

## [1.1.9] - 2026-05-04

### Bug Fixes

- **lights:** fix brightness slider not dimming — devices like the Ceiling Light report their brightness capability with no `functionInstance`; the previous code substituted `'primary'` which the API does not recognise, causing the write to be silently ignored and the light to turn on at its default level instead of the requested brightness

---

## [1.1.8] - 2026-05-04

### Bug Fixes

- **lights:** fix brightness slider turning light on instead of dimming — brightness was sent to the API as a string value instead of a number; also, when the light was off, HomeKit's separate power-on and brightness writes could arrive out of order causing the device to ignore the brightness; both are now sent together in a single request

---

## [1.1.7] - 2026-05-04

### Bug Fixes

- **ui:** rename icon to `homebridge.png` — the correct filename the Homebridge UI looks for

---

## [1.1.6] - 2026-05-04

### Bug Fixes

- **ui:** add `homebridge.icon` URL to package.json so the Hubspace icon renders correctly in the Homebridge plugin list

---

## [1.1.5] - 2026-05-04

### Changes

- **ui:** add Hubspace app icon shown in Homebridge plugin list
- **ui:** consolidate Behaviour and Advanced config sections into a single Advanced fieldset
- **docs:** Node.js requirement now states "all active LTS releases" to stay accurate as new LTS versions land
- **docs:** link MIT license text in README footer
- **packaging:** exclude test files and Jest config from npm tarball

---

## [1.1.4] - 2026-05-04

### Changes

- **tests:** add Jest unit test suite (58 tests) covering color conversions, fan speed mapping, and Kelvin/mired conversions
- **refactor:** extract pure utility functions to `src/utils.ts` for testability
- **ci:** run `npm test` on every build across Node 20/22/24

---

## [1.1.3] - 2026-05-04

### Changes

- **packaging:** exclude `.story/` directory from npm tarball
- **docs:** add hardware-tested status to supported devices table; correct Node.js requirement to 20/22/24
- **config:** add `strictValidation` and `additionalProperties: false` to config schema

---

## [1.1.2] - 2026-05-04

### Bug Fixes

- **debug:** expose `debug` flag correctly on platform so verbose state logging works when enabled in settings
- **ci:** update GitHub Actions to use Node.js 24 runner to fix deprecation warnings

---

## [1.1.1] - 2026-05-04

### Bug Fixes

- **fan:** use Afero semantic speed value names (`fan-speed-025`, `fan-speed-050`, `fan-speed-075`, `fan-speed-100`) for both reading and writing fan speed — the API rejected raw numeric values with a 400 error
- **fan:** poll all merged device IDs on each cycle so fan speed and direction state persist correctly between polls
- **fan:** constrain rotation speed slider to 4 discrete steps (25 / 50 / 75 / 100%)
- **auth:** auto-discard token cache when configured account username changes
- **state:** correctly read device state from `state.values` field in Afero API response
- **accessories:** fix `updateCharacteristic` crash caused by ES2022 class-field initializer ordering
- **discovery:** merge `fan` and `ceiling-fan` metadevice state so all capabilities are available

---

## [1.0.32] - 2026-05-04

### Bug Fixes

- **fan:** use Afero semantic speed value names (`fan-speed-025`, `fan-speed-050`, `fan-speed-075`, `fan-speed-100`) for both reading and writing fan speed — the API rejected raw numeric values with a 400 error

---

## [1.0.31] - 2026-05-03

### Changes

- **auth:** store username in token cache — if the configured account changes, the stale token file is automatically discarded and a fresh login performed rather than silently failing

---

## [1.0.30] - 2026-05-03

### Changes

- **debug:** verbose per-poll state logging is now gated behind the existing `debug` toggle in settings — logs are clean by default, enable debug to see full state on every cycle

---

## [1.0.29] - 2026-05-03

### Changes

- **logging:** remove diagnostic info logs now that state reading is stable — logs are clean again

---

## [1.0.28] - 2026-05-03

### Bug Fixes

- **fan:** poll all merged device IDs on each cycle — the ceiling-fan metadevice has power state while the fan metadevice has speed/direction; polling only the ceiling-fan ID caused speed to revert to 50% after every poll

---

## [1.0.27] - 2026-05-03

### Bug Fixes

- **fan:** fix speed conversion for 4-speed fans — the 6-speed range check was shadowing the 4-speed check, causing speed 1 (25%) to map to speed 2 (50%); ranges are now non-overlapping

---

## [1.0.26] - 2026-05-03

### Bug Fixes

- **fan:** constrain rotation speed slider to 4 discrete steps (25 / 50 / 75 / 100%) matching the physical fan's 4-speed capability

---

## [1.0.25] - 2026-05-03

### Bug Fixes

- **fan:** merge state values from both `fan` and `ceiling-fan` metadevices instead of discarding one — the `ceiling-fan` entry has the bridge/power state while the `fan` entry has `fan-speed` and `fan-reverse`; merging gives the full capability set needed for speed and direction controls

---

## [1.0.24] - 2026-05-03

### Bug Fixes

- **state:** `state` field is an object with a nested `values` array — extract `state.values` correctly; fixes all device state reading (power, brightness, fan speed)

---

## [1.0.23] - 2026-05-03

### Changes

- **diagnostics:** log raw `state` field shape to identify correct structure; guard against non-array state

---

## [1.0.22] - 2026-05-03

### Bug Fixes

- **state:** API returns device state under `state` field, not `values` — all state reads and writes now use the correct field, fixing empty state on every poll

---

## [1.0.21] - 2026-05-03

### Changes

- **diagnostics:** log raw API response keys and values field to identify state field name

---

## [1.0.20] - 2026-05-03

### Changes

- **diagnostics:** log device state and fan set calls at info level to surface fan power reading issue

---

## [1.0.19] - 2026-05-03

### Changes

- **debug:** log fan power set calls with instance info to diagnose fan state issues

---

## [1.0.18] - 2026-05-03

### Changes

- **logging:** log raw device state values on each poll cycle when debug mode is enabled — helps diagnose device state reading issues
- **logging:** demote internal metadevice count to debug level; show cleaner "device(s)" wording in info logs

---

## [1.0.17] - 2026-05-03

### Bug Fixes

- **security:** remove hardcoded credentials from `discover.mjs` — now reads `USERNAME`/`PASSWORD` from environment variables
- **types:** remove unused `AferoAccount` interface and unused `FC.PRESET` / `FC.AVAILABLE` constants
- **schema:** mark password field with `"format": "password"` so Homebridge UI masks it
- **packaging:** exclude `package-lock.json` and `.gitignore` from the npm tarball

---

## [1.0.16] - 2026-05-03

### Bug Fixes

- **accessories:** use `declare` on service fields (`svc`, `fanSvc`, `lightSvc`) to prevent TypeScript ES2022 class-field initializers from overwriting values set during `setupServices()`, which was causing `updateCharacteristic` to throw on every poll cycle
- **discovery:** deduplicate devices by friendly name — when the API returns both a `fan` and a `ceiling-fan` metadevice for the same physical device, keep only the `ceiling-fan` entry (fixes 2 fans appearing for 1 physical ceiling fan)

---

## [1.0.15] - 2026-05-03

### Bug Fixes

- **auth:** `refresh_expires_in: 0` from Hubspace Keycloak means the refresh token never expires — treat it as such instead of considering it immediately invalid, which was causing a password login on every token expiry
- **auth:** coalesce concurrent `authenticate()` calls with an in-flight guard so multiple simultaneous poll requests can't each trigger a separate password login
- **auth:** always attempt token refresh before falling back to password login, regardless of the computed refresh token expiry

---

## [1.0.14] - 2026-05-03

### Bug Fixes

- **state:** use semantic value names for all state writes — `"on"`/`"off"` for power (not `"true"`/`"false"`), `"forward"`/`"reverse"` for fan direction — matching what the semantics2 Afero API expects
- **state:** update all power readers to recognise `"on"` in addition to `"true"` and boolean `true`
- **state:** update fan direction reader to recognise `"reverse"` semantic value
- **polling:** log the device ID and error reason per failed poll cycle instead of just the count

---

## [1.0.13] - 2026-05-03

### Bug Fixes

- **release:** exclude `discover.mjs` from the npm package (development-only script)

---

## [1.0.12] - 2026-05-03

### Bug Fixes

- **auth:** never call password login from the 401 retry interceptor — only use token refresh, preventing repeated Hubspace login emails and push notifications on every poll cycle
- **auth:** `resolveAccountId` now uses a valid access token via `getValidAccessToken` instead of the raw stored token, preventing `/v1/users/me` failures with an expired token
- **auth:** do not reset cached account ID on re-authentication — the account ID is stable for the same user
- **auth:** reduce proactive refresh buffer from 60 s to 30 s so a 120 s access token is used for 90 s before refresh
- **auth:** log access token and refresh token lifetimes on authentication

---

## [1.0.11] - 2026-05-03

### Changes

- **homebridge 2.0:** update `engines` and `peerDependencies` to support both Homebridge v1.8+ and v2.0
- **config:** fix footer URL in plugin settings UI
- **config:** add `changelog` pointer so Homebridge UI shows release notes on update

---

## [1.0.10] - 2026-05-03

### Bug Fixes

- **discovery:** skip room and home container metadevices that have no `deviceClass`, preventing a startup crash
- **discovery:** extract `deviceClass` from the nested `description.device.deviceClass` field to match the actual Afero API response shape

---

## [1.0.9] - 2026-05-03

### Bug Fixes

- **auth:** resolve account ID from `GET /v1/users/me` instead of parsing the Keycloak JWT `sub` claim — the real account ID is not in the token
- **discovery:** switch device listing to `semantics2.afero.net` which returns full device metadata including capabilities and current state
- **auth:** set `User-Agent: Dart/2.18 (dart:io)` and `accept-encoding: gzip` headers required by the Afero API

---

## [1.0.8] - 2026-05-02

### Bug Fixes

- **discovery:** probe five different URL patterns to find the working device endpoint

---

## [1.0.7] - 2026-05-02

### Bug Fixes

- **auth:** log full JWT claims on startup to surface the correct account ID field

---

## [1.0.6] - 2026-05-02

### Bug Fixes

- **auth:** add multi-step account ID discovery: JWT claims → Keycloak userinfo → `/v1/accounts` listing → JWT `sub` fallback

---

## [1.0.5] - 2026-05-01

### Bug Fixes

- **discovery:** switch back to `api2.afero.net` for device listing; `semantics2.afero.net` rejects Keycloak tokens

---

## [1.0.4] - 2026-05-01

### Bug Fixes

- **auth:** parse account ID from Keycloak `sub` claim by stripping the `f:realm:` prefix

---

## [1.0.3] - 2026-05-01

### Bug Fixes

- **auth:** remove explicit `host` header that was causing 400 errors; add detailed error logging on device fetch failures

---

## [1.0.2] - 2026-05-01

### Bug Fixes

- **auth:** use JWT `sub` claim for account ID and add `Dart/3.3 (dart:io)` User-Agent header

---

## [1.0.1] - 2026-05-01

### Bug Fixes

- **discovery:** switch to `semantics2.afero.net` with JWT-derived account ID for device listing

---

## [1.0.0] - 2026-05-01

### Features

- Initial release
- Username/password authentication via Hubspace Keycloak with token caching and automatic refresh
- Device discovery for lights, ceiling fans, outlets, and switches
- HomeKit support: on/off, brightness, color temperature, RGB color, fan speed, fan direction
- Configurable polling interval (default 30 s)
- Child bridge support
