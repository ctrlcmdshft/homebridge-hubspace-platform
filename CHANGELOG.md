# Changelog

## [Unreleased]

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
