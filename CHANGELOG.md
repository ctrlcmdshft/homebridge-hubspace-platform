# Changelog

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
