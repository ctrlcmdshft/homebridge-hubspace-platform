# Changelog

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
