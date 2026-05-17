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
    <img src="https://img.shields.io/badge/homebridge-2.0%20compatible-blueviolet?logo=homebridge" alt="Homebridge 2.0 compatible" />
  </a>
  <a href="https://github.com/ctrlcmdshft/homebridge-hubspace-platform/actions/workflows/build.yml">
    <img src="https://github.com/ctrlcmdshft/homebridge-hubspace-platform/actions/workflows/build.yml/badge.svg" alt="Build, Lint, and Test" />
  </a>
</p>

# Homebridge Hubspace Platform

Integrates [Hubspace](https://www.hubspace.com) smart home devices (sold at Home Depot, powered by the Afero cloud) with Apple HomeKit via [Homebridge](https://homebridge.io). Control ceiling fans, lights, outlets, and switches directly from the Home app or with Siri.

> **Disclaimer:** This is an unofficial, community-driven plugin. [See disclaimer below.](#disclaimer)

---

## Supported devices

| Device | Features | Status |
| --- | --- | --- |
| Hampton Bay Ceiling Fan (Hubspace) | Fan on/off · 4 speeds · light on/off · brightness | Tested with hardware |
| Defiant Smart Plug / Hubspace power-outlet | On/off | Tested with hardware |
| Hubspace Smart Switch | On/off | Implemented, untested |
| Hubspace Smart Light | On/off · brightness | Tested with hardware |
| Hubspace Smart Light (color) / LED strip | On/off · brightness · color temperature · RGB color | Tested with hardware |

> **Note:** Smart switches are implemented based on the Afero API but have not yet been verified with real hardware. If you own one and can confirm it works (or find a bug), please open an issue.

---

## Requirements

- **Node.js** all active LTS releases (currently 22 and 24)
- **Homebridge** ≥ 1.8.0 or 2.x
- A Hubspace / Home Depot account with at least one paired device
- **2FA must be disabled** — the Hubspace API client used by this plugin does not support interactive two-factor authentication. If your account has 2FA enabled via email code, authentication will fail. Native 2FA support is being investigated; follow the repo for updates.

---

## Installation

The right method depends on your setup:

| Setup | How to install |
|---|---|
| Homebridge UI (recommended) | Plugins tab → search `homebridge-hubspace-platform` → Install → Settings → enter credentials → Restart |
| `hb-service` (Linux / Raspberry Pi) | Use the Homebridge UI, or `sudo npm install -g homebridge-hubspace-platform` then restart |
| Docker | Use the Homebridge UI inside the container, or add to your startup config |
| Manual Node install | `npm install -g homebridge-hubspace-platform` — only if Homebridge itself was installed globally via npm |

> **Note:** `npm install -g` installs into the system Node prefix, not the Homebridge plugin directory. On most setups (Docker, hb-service, HOOBS) the plugin won't be found. Prefer the Homebridge UI where possible.

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
| `pollingInterval` | integer | `30` | Seconds between state polls. When Conclave is active (the default) this becomes a slow-poll fallback and is floored at 300 s, so the effective default is 300 s in most setups. |
| `debug` | boolean | `false` | Log API/network activity: GET STATE, SET STATE, token refresh, Conclave details. Also dumps raw capabilities when an unsupported device is skipped. See also `verbose`. |
| `verbose` | boolean | `false` | Log full device state on every poll cycle (noisy). Implies `debug`. Use this when [requesting support for a new device](#requesting-support-for-a-new-device). |
| `disableConclave` | boolean | `false` | Disable the Afero Conclave real-time push connection and rely on polling only |
| `exposeComfortBreeze` | boolean | `false` | Add a separate "Comfort Breeze" Switch tile for ceiling fans that support it |
| `exposeMasterPowerSwitch` | boolean | `false` | Add a separate Switch tile for the ceiling-fan master power relay (only appears on fans where the master relay is distinct from the fan control) |
| `exposeStatusFault` | boolean | `false` | Show a StatusFault indicator on fan and light tiles when the device is reported offline by the Hubspace cloud (outlets always show StatusFault). Non-standard — visible in Eve and Controller for HomeKit; may not display in Apple Home. |
| `invertOutletStatus` | boolean | `false` | Invert the reported on/off state for smart plugs that report their status backwards |
| `tokenCachePath` | string | — | Override the path for the cached auth token file. Leave blank to use the Homebridge storage directory (recommended). |

---

## Real-time push (Conclave)

Starting in 1.2.0 the plugin connects to the Afero Conclave push service alongside regular polling. When another app (or the Hubspace app itself) changes a device, the plugin receives an `attr_change` event within a second and fetches only that device's state — without waiting for the next poll cycle. The slow-poll fallback still runs at your configured `pollingInterval` (minimum 300 s when Conclave is active) as a safety net.

No configuration is required — Conclave is on by default. Set `"disableConclave": true` to fall back to polling-only mode.

---

## Troubleshooting

**Authentication failed**
- Check your username and password in the Homebridge config.
- Confirm you can log into the Hubspace app on your phone.

**Accessories show as `No Response`**
- Check Homebridge logs for `[Hubspace]` error lines.
- Enable `"debug": true` temporarily to see API call activity (GET STATE, SET STATE, token refresh).
- Verify your Homebridge host can reach `semantics2.afero.net`.

**Device not appearing**
- Enable `"verbose": true` and restart Homebridge. The log will show an `Unsupported deviceClass` warning for any skipped device, including its hardware model, full capability list, and a link to open a GitHub issue. See [Requesting support for a new device](#requesting-support-for-a-new-device).

**Device appears but a characteristic is wrong**
- Enable `"verbose": true` and restart Homebridge. Every poll cycle will print a `State for "..."` line with every capability and value the API returned. Paste that line in a GitHub issue along with a description of what HomeKit shows vs. what you expect.

**Token cache corruption**
- Delete `<homebridge-storage>/hubspace-tokens.json` and restart. The plugin will re-authenticate once.

---

## Requesting support for a new device

If your Hubspace device doesn't appear in HomeKit, the plugin has skipped it because its `deviceClass` isn't implemented yet. Here's how to gather everything needed to add support:

1. Add `"verbose": true` to your Homebridge config for this plugin and restart Homebridge.
2. Watch the log. For each unsupported device you'll see a warning like:

   ```
   [WARN] Unsupported deviceClass "smart-dimmer" — "Hallway Switch" will not appear in HomeKit.
     Hardware     : Hubspace / HB-200-WH
     Capabilities : power, brightness, color-temperature
     To request support: https://github.com/ctrlcmdshft/homebridge-hubspace-platform/issues
   ```

3. Immediately below that, a `State for "..."` line shows every capability and its current value:

   ```
   [Hubspace] State for "Hallway Switch": power[undefined]=off, brightness[undefined]=75, color-temperature[undefined]=3500, ...
   ```

4. Open a GitHub issue and include:
   - The full `Unsupported deviceClass` warning block (hardware model + capabilities line)
   - The `State for "..."` line
   - Your device's name and model as shown in the Hubspace app

5. Remove `"verbose": true` once you've captured the logs — it logs every device every 30 seconds and is not intended for permanent use.

> **Power users:** if you're comfortable running a script, `discover.mjs` (see the [Development wiki](https://github.com/ctrlcmdshft/homebridge-hubspace-platform/wiki/Development)) dumps the complete raw API response for all your devices, which gives even more detail than the verbose log.

---

## Development

Local setup, API endpoint reference, authentication details, and the `discover.mjs` exploration script are documented in the [**Development wiki**](https://github.com/ctrlcmdshft/homebridge-hubspace-platform/wiki/Development).

---

## Disclaimer

This project is an independent, community-driven Homebridge plugin. It is **not affiliated with, endorsed by, or supported by** Hubspace, The Home Depot, or Afero. All product names and trademarks are the property of their respective owners. Use of this plugin is at your own risk.

---

## License

[MIT](./LICENSE) © [ctrlcmdshft](https://github.com/ctrlcmdshft)
