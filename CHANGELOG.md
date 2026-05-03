# Changelog

## [1.0.10] (2026-05-03)

### Bug Fixes

- **discovery:** skip room and home container metadevices that have no `deviceClass`, preventing a startup crash
- **discovery:** extract `deviceClass` from the nested `description.device.deviceClass` field to match the actual Afero API response shape

---

## [1.0.9] (2026-05-03)

### Bug Fixes

- **auth:** resolve account ID from `GET /v1/users/me` instead of parsing the Keycloak JWT `sub` claim — the real account ID is not in the token
- **discovery:** switch device listing to `semantics2.afero.net` which returns full device metadata including capabilities and current state
- **auth:** set `User-Agent: Dart/2.18 (dart:io)` and `accept-encoding: gzip` headers required by the Afero API

---

## [1.0.8] (2026-05-02)

### Bug Fixes

- **discovery:** probe five different URL patterns in sequence to find the working device endpoint; log each attempt for easier debugging

---

## [1.0.7] (2026-05-02)

### Bug Fixes

- **auth:** log full JWT claims on startup to surface the correct account ID field

---

## [1.0.6] (2026-05-02)

### Bug Fixes

- **auth:** add multi-step account ID discovery: JWT claims → Keycloak userinfo → `/v1/accounts` listing → JWT `sub` fallback

---

## [1.0.5] (2026-05-01)

### Bug Fixes

- **discovery:** switch back to `api2.afero.net` for device listing; `semantics2.afero.net` rejects Keycloak tokens

---

## [1.0.4] (2026-05-01)

### Bug Fixes

- **auth:** parse account ID from Keycloak `sub` claim by stripping the `f:realm:` prefix to get the user UUID

---

## [1.0.3] (2026-05-01)

### Bug Fixes

- **auth:** remove explicit `host` header that was causing 400 errors; add detailed error logging on device fetch failures

---

## [1.0.2] (2026-05-01)

### Bug Fixes

- **auth:** use JWT `sub` claim for account ID and add `Dart/3.3 (dart:io)` User-Agent header for the Afero API

---

## [1.0.1] (2026-05-01)

### Bug Fixes

- **discovery:** switch to `semantics2.afero.net` with JWT-derived account ID for device listing

---

## [1.0.0] (2026-05-01)

### Features

- Initial release
- Username/password authentication via Hubspace Keycloak with token caching and automatic refresh
- Device discovery for lights, ceiling fans, outlets, and switches
- HomeKit support: on/off, brightness, color temperature, RGB color, fan speed, fan direction
- Configurable polling interval (default 30 s)
- Child bridge support
