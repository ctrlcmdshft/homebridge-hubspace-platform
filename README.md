<p align="center">
  <img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-wordmark-logo-vertical.png" height="150"/>
</p>

<span align="center">

# Homebridge Hubspace New

<a href="https://www.npmjs.com/package/homebridge-hubspace-new">
  <img src="https://img.shields.io/npm/v/homebridge-hubspace-new.svg?logo=npm&logoColor=fff&label=NPM+package&color=limegreen" alt="homebridge-hubspace-new on npm" />
</a>

</span>

# About

Homebridge Hubspace New is a plugin that integrates Hubspace devices (sold at Home Depot, powered by the Afero cloud) with Apple HomeKit. Control your smart ceiling fans, outlets, lights, and switches directly from the Home app.

Built from scratch in TypeScript with reliable token caching — the plugin survives Homebridge restarts without triggering login emails.

# Disclaimer

I do not own any rights to Hubspace or Afero. Any work published here is solely for my own convenience. I am not making any guarantees about the code or products referenced here.

# Tested products

| Product | Functions supported |
| --- | --- |
| [Hampton Bay Universal Smart Wi-Fi 4-Speed Ceiling Fan](https://www.homedepot.com/p/Hampton-Bay-Universal-Smart-Wi-Fi-4-Speed-Ceiling-Fan-White-Remote-Control-For-Use-Only-With-AC-Motor-Fans-Powered-by-Hubspace-76278/315169181) | <ul><li>Fan on/off</li><li>Fan speed (4 speeds)</li><li>Fan direction</li><li>Light on/off</li><li>Light brightness</li></ul> |
| Defiant Smart Plug | <ul><li>Power on/off</li></ul> |
| Hubspace Smart Switch | <ul><li>Power on/off</li></ul> |
| Hubspace Smart Light | <ul><li>On/off</li><li>Brightness</li><li>Color temperature</li><li>RGB color</li></ul> |

# Requirements

- **Node.js** ≥ 18.15
- **Homebridge** ≥ 1.8.0 (including v2.x)
- A Hubspace / Home Depot account with at least one device

# Installation

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

# Configuration

Add to your Homebridge `config.json` under the `"platforms"` array:

```json
{
  "platform": "HubspaceNew",
  "name": "Hubspace",
  "username": "you@example.com",
  "password": "your-hubspace-password",
  "pollingInterval": 30,
  "debug": false
}
```

### All options

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `platform` | string | **required** | Must be `"HubspaceNew"` |
| `username` | string | **required** | Hubspace account email |
| `password` | string | **required** | Hubspace account password |
| `pollingInterval` | integer | `30` | Seconds between state polls |
| `debug` | boolean | `false` | Log verbose API details |

# Troubleshooting

**Plugin logs `Authentication failed`**
- Double-check your username and password in the Homebridge config.
- Make sure you can log into the Hubspace app on your phone.

**Accessories show as `No Response`**
- Check Homebridge logs for `[Hubspace]` error lines.
- Enable `"debug": true` temporarily to see full API responses.
- Verify that `https://semantics2.afero.net` is reachable from your Homebridge host.

**Device not appearing**
- Enable `"debug": true` — the discovery log will print every device returned by the cloud and why it was skipped.

**Token cache corruption**
- Delete `<homebridge-storage>/hubspace-tokens.json` and restart. The plugin will re-authenticate.

# Development

There is no official documentation for Hubspace products. Under the hood they use the Afero cloud. Any functionality here is gained by experimenting with the devices and observing API responses.

Hubspace uses [Keycloak](https://www.keycloak.org) for authentication. To get a token for testing, send a `POST` with `x-www-form-urlencoded` body to:

```
https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token
```

| Key | Value |
| --- | --- |
| `grant_type` | `password` |
| `client_id` | `hubspace_android` |
| `username` | your email |
| `password` | your password |

### API endpoints used

| Purpose | Method | URL |
| --- | --- | --- |
| Authentication | POST | `https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token` |
| Resolve account ID | GET | `https://api2.afero.net/v1/users/me` |
| List devices | GET | `https://semantics2.afero.net/v1/accounts/{id}/metadevices?expansions=state` |
| Get device state | GET | `https://semantics2.afero.net/v1/accounts/{id}/metadevices/{deviceId}?expansions=state` |
| Set device state | PUT | `https://semantics2.afero.net/v1/accounts/{id}/metadevices/{deviceId}/state` |

### Local setup

```bash
git clone https://github.com/ctrlcmdshft/homebridge-hubspace-new.git
cd homebridge-hubspace-new
npm install
npm run build    # build once
npm run watch    # rebuild on save
```

# License

MIT © ctrlcmdshft
