<p align="center">
  <img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-wordmark-logo-vertical.png" height="150"/>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/homebridge-hubspace-platform">
    <img src="https://img.shields.io/npm/v/homebridge-hubspace-platform?label=npm&logo=npm&color=limegreen" alt="npm version" />
  </a>
  <a href="https://github.com/ctrlcmdshft/homebridge-hubspace-platform/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/ctrlcmdshft/homebridge-hubspace-platform" alt="MIT License" />
  </a>
  <a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins">
    <img src="https://img.shields.io/badge/homebridge-2.0%20ready-blueviolet?logo=homebridge" alt="Homebridge 2.0 ready" />
  </a>
  <a href="https://github.com/ctrlcmdshft/homebridge-hubspace-platform/actions/workflows/build.yml">
    <img src="https://github.com/ctrlcmdshft/homebridge-hubspace-platform/actions/workflows/build.yml/badge.svg" alt="Build, Lint, and Test" />
  </a>
</p>

# Homebridge Hubspace Platform

Integrates [Hubspace](https://www.hubspace.com) smart home devices (sold at Home Depot, powered by the Afero cloud) with Apple HomeKit via [Homebridge](https://homebridge.io). Control ceiling fans, lights, outlets, and switches directly from the Home app or with Siri.

> **Disclaimer:** This project is not affiliated with or endorsed by Hubspace, Home Depot, or Afero. It is an independent community plugin built by reverse-engineering the Afero cloud API.

---

## Supported devices

| Device | Features | Status |
| --- | --- | --- |
| Hampton Bay Ceiling Fan (Hubspace) | Fan on/off · 4 speeds · direction · light on/off · brightness | Tested with hardware |
| Defiant Smart Plug | On/off | Implemented, untested |
| Hubspace Smart Switch | On/off | Implemented, untested |
| Hubspace Smart Light | On/off · brightness · color temperature · RGB color | Implemented, untested |

> **Note:** Only the Hampton Bay ceiling fan has been tested with real hardware. Other device types are implemented based on the Afero API but have not been verified. If you own one of these devices and can confirm it works (or find a bug), please open an issue.

---

## Requirements

- **Node.js** all active LTS releases (currently 20, 22, and 24)
- **Homebridge** ≥ 1.8.0 (v2.x supported)
- A Hubspace / Home Depot account with at least one paired device

---

## Installation

**Via Homebridge UI (recommended)**

1. Open the Homebridge UI → **Plugins** tab
2. Search for `homebridge-hubspace-platform`
3. Click **Install**
4. Click **Settings**, enter your Hubspace credentials, and save
5. Restart Homebridge

**Manual**

```bash
npm install -g homebridge-hubspace-platform
```

---

## Configuration

Minimal `config.json` entry under `"platforms"`:

```json
{
  "platform": "HubspacePlatform",
  "name": "Hubspace",
  "username": "you@example.com",
  "password": "your-hubspace-password"
}
```

### All options

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `platform` | string | **required** | Must be `"HubspacePlatform"` |
| `username` | string | **required** | Hubspace account email |
| `password` | string | **required** | Hubspace account password |
| `pollingInterval` | integer | `30` | Seconds between state polls (10–600) |
| `debug` | boolean | `false` | Log verbose API details |

---

## Troubleshooting

**Authentication failed**
- Check your username and password in the Homebridge config.
- Confirm you can log into the Hubspace app on your phone.

**Accessories show as `No Response`**
- Check Homebridge logs for `[Hubspace]` error lines.
- Enable `"debug": true` temporarily to see full API responses.
- Verify your Homebridge host can reach `semantics2.afero.net`.

**Device not appearing**
- Enable `"debug": true` — the discovery log will print every device the cloud returned and why it was skipped.

**Token cache corruption**
- Delete `<homebridge-storage>/hubspace-tokens.json` and restart. The plugin will re-authenticate once.

---

## Development

There is no official documentation for the Hubspace consumer API. All functionality here was gained by experimenting with real devices and observing API responses.

### Local setup

```bash
git clone https://github.com/ctrlcmdshft/homebridge-hubspace-platform.git
cd homebridge-hubspace-platform
npm install
npm run build    # compile once
npm run watch    # recompile on save
```

### Authentication

Hubspace uses [Keycloak](https://www.keycloak.org) for auth. To obtain a token manually, `POST` to:

```
https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token
```

with `Content-Type: application/x-www-form-urlencoded` and the body:

```
grant_type=password
client_id=hubspace_android
username=<your email>
password=<your password>
scope=openid offline_access
```

### API endpoints

**Authentication**
```
POST https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token
```

**Resolve account ID**
```
GET https://api2.afero.net/v1/users/me
```

**List all devices**
```
GET https://semantics2.afero.net/v1/accounts/{accountId}/metadevices?expansions=state
```

**Get device state**
```
GET https://semantics2.afero.net/v1/accounts/{accountId}/metadevices/{deviceId}?expansions=state
```

**Set device state**
```
PUT https://semantics2.afero.net/v1/accounts/{accountId}/metadevices/{deviceId}/state
```

### Exploring the API

Copy `.env.example` to `.env`, fill in your credentials, then run the discovery script:

```bash
USERNAME=you@example.com PASSWORD=yourpass node discover.mjs
```

---

## License

MIT © [ctrlcmdshft](https://github.com/ctrlcmdshft)
