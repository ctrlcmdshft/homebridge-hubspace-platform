# homebridge-hubspace-new

A modern, production-ready **Homebridge platform plugin** for [Hubspace](https://www.hubspace.com/) smart home devices (sold at Home Depot, powered by the Afero cloud).

Built from scratch in TypeScript — no forks, clean architecture, reliable token caching so you are never spammed with login emails.

---

## Features

- **Token caching** — access + refresh tokens are persisted to disk; the plugin survives restarts without re-authenticating
- **Automatic token refresh** — proactively refreshes before expiry; falls back to full re-auth only when the refresh token itself expires
- **Device discovery** — polls the Afero cloud on startup and registers all supported devices automatically
- **Configurable polling** — state syncs on a configurable interval (default 30 s)
- **Immediate HomeKit feedback** — `set` handlers return instantly; the API call happens asynchronously
- **Child bridge support** — works in Homebridge child bridge mode out of the box
- **Graceful error handling** — network failures don't crash the plugin; polling resumes on the next cycle

### Supported devices

| Device class | HomeKit service | Capabilities |
|---|---|---|
| `light` | Lightbulb | On/Off, Brightness, Color Temperature, RGB Color |
| `fan` / `ceiling-fan` | Fanv2 (+ optional Lightbulb) | On/Off, Speed, Rotation Direction, Light kit |
| `outlet` | Outlet | On/Off |
| `switch` | Switch | On/Off |
| `plug` | Outlet | On/Off |

---

## Requirements

- **Node.js** ≥ 18.15
- **Homebridge** ≥ 1.8.0 (including v2.x)
- A Hubspace / Home Depot account with at least one device

---

## Installation

### Via Homebridge UI (recommended)

1. Open the Homebridge UI → **Plugins** tab
2. Search for `homebridge-hubspace-new`
3. Click **Install**
4. Click **Settings** and fill in your credentials
5. Restart Homebridge

### Manual

```bash
npm install -g homebridge-hubspace-new
```

Then add the platform block to your Homebridge `config.json` (see below).

---

## Configuration

Add to `~/.homebridge/config.json` under the `"platforms"` array:

```json
{
  "platforms": [
    {
      "platform": "HubspaceNew",
      "name": "Hubspace",
      "username": "you@example.com",
      "password": "your-hubspace-password",
      "pollingInterval": 30,
      "debug": false
    }
  ]
}
```

### All options

| Key | Type | Default | Description |
|---|---|---|---|
| `platform` | string | **required** | Must be `"HubspaceNew"` |
| `username` | string | **required** | Hubspace account email |
| `password` | string | **required** | Hubspace account password |
| `pollingInterval` | integer | `30` | Seconds between state polls (min 10, max 600) |
| `tokenCachePath` | string | *(storage dir)* | Override path for the token cache JSON file |
| `debug` | boolean | `false` | Log verbose API details |

---

## How authentication works

1. On first run (or when the cached tokens have expired), the plugin logs in with your username + password via the Hubspace / Keycloak endpoint.
2. The resulting access token **and** refresh token are written to `<homebridge-storage>/hubspace-tokens.json`.
3. On subsequent restarts, the plugin loads the cached tokens. If the access token is near expiry it refreshes silently using the refresh token.
4. The refresh token typically lasts several days. Only when it expires (or is revoked) will the plugin perform a fresh password login.

> **Tip:** You will usually see a login email from Hubspace only on the very first run, or after a long period of inactivity.

---

## Child bridge support

This plugin is fully compatible with Homebridge child bridges. In the Homebridge UI:

1. Go to **Plugins** → find **Hubspace New** → three-dot menu → **Bridge Settings**
2. Enable **Create isolated child bridge**
3. Restart Homebridge

The plugin runs in a separate process, improving stability and reducing impact on other plugins.

---

## Supported Hubspace capabilities

The plugin reads the `values` array from each metadevice to auto-detect what a device supports. If a capability is not present in the device's state, the corresponding HomeKit characteristic is not added.

| Hubspace `functionClass` | HomeKit characteristic |
|---|---|
| `power` | On / Active |
| `brightness` | Brightness (0–100 %) |
| `color-temperature` | ColorTemperature (mireds, converted from K) |
| `color-rgb` | Hue + Saturation |
| `fan-speed` | RotationSpeed |
| `fan-reverse` | RotationDirection |

Fan speed values can be named (`low`, `medium-low`, `medium`, `medium-high`, `high`) or numeric — the plugin detects the format automatically.

---

## Troubleshooting

### Plugin logs `Authentication failed`
- Double-check your username and password in the Homebridge config.
- Make sure you can log into the Hubspace app on your phone.
- If your account uses 2FA / OTP: the plugin uses the `hubspace_android` client which typically bypasses 2FA. If you still see issues, try logging out of all Hubspace sessions and then restarting Homebridge.

### Accessories show as `No Response`
- Check Homebridge logs for `[Hubspace]` error lines.
- Enable `"debug": true` temporarily to see full API responses.
- Verify that `https://api2.afero.net` is reachable from your Homebridge host.

### Device not appearing
- Check that the `deviceClass` of the device is in the supported list.
- Enable `"debug": true` — the discovery log will print every device returned by the cloud API and why it was (or was not) registered.

### Stale state
- Reduce `pollingInterval` (e.g. to `15`).
- Check for API rate-limiting in the debug logs (`429` responses).

### Token cache corruption
- Delete `<homebridge-storage>/hubspace-tokens.json` and restart Homebridge. The plugin will re-authenticate.

---

## Development

### Local setup

```bash
git clone https://github.com/ctrlcmdshft/homebridge-hubspace-new.git
cd homebridge-hubspace-new

# macOS
npm install

# Build once
npm run build

# Watch mode (rebuilds on save)
npm run watch
```

### Test in Homebridge (development link)

```bash
# From the plugin directory
npm link

# From your Homebridge directory (e.g. ~/.homebridge)
npm link homebridge-hubspace-new

# Start Homebridge in debug mode
homebridge -D
```

### Linting

```bash
npm run lint          # check
npm run lint:fix      # auto-fix
```

---

## API endpoints used

| Purpose | Method | URL |
|---|---|---|
| Authentication | POST | `https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token` |
| Token refresh | POST | *(same as above, with `grant_type=refresh_token`)* |
| List accounts | GET | `https://api2.afero.net/v1/accounts` |
| List devices | GET | `https://api2.afero.net/v1/accounts/{id}/metadevices?expansions=state` |
| Get device state | GET | `https://api2.afero.net/v1/accounts/{id}/metadevices/{deviceId}?expansions=state` |
| Set device state | PUT | `https://api2.afero.net/v1/accounts/{id}/metadevices/{deviceId}/state` |

---

## License

MIT © ctrlcmdshft
