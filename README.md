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
| Hampton Bay Universal Smart Fan Controller (76278) | Fan on/off · 4 speeds · light on/off · brightness · rotation direction ¹ · Comfort Breeze ¹ | Tested with hardware |
| Defiant Smart Indoor Plug (HPPA11AWB) | On/off | Tested with hardware |
| Commercial Electric Smart Surge Protector (LA-12A-C) | 4 smart outlets (of 6 total) independently controlled | Tested with hardware |
| Defiant Smart Wi-Fi Outdoor Plug (HPPA52CWB) | 2 independently controlled outlets | Tested with hardware |
| Hubspace Smart Switch | On/off | Implemented, untested |
| EcoSmart Smart RGBWIC LED Strip Light (AL-HSTL-RGBICTW) | On/off · brightness · color temperature · RGB color | Tested with hardware |
| EcoSmart Smart A19 Color Bulb (12A19060WRGBWH1) | On/off · brightness · color temperature · RGB color | Tested with hardware |

> ¹ **Device-dependent:** rotation direction requires the device to report the `fan-reverse` capability; Comfort Breeze requires `toggle[comfort-breeze]`. These tiles will not appear if the hardware doesn't support the capability — no config change needed.
>
> **Note:** Smart switches are implemented based on the Afero API but have not yet been verified with real hardware. If you own one and can confirm it works (or find a bug), please open an issue.
>
> **Hubspace light bulbs:** All EcoSmart/Hubspace A19 bulbs (color changing and tunable white variants) should work out of the box. Color bulbs expose on/off, brightness, color temperature, and RGB; tunable white bulbs expose on/off, brightness, and color temperature only. The plugin detects capabilities automatically.

---

## Requirements

- **Node.js** all active LTS releases (currently 22 and 24)
- **Homebridge** ≥ 1.8.0 or 2.x
- A Hubspace / Home Depot account with at least one paired device

---

## Two-factor authentication (2FA)

Accounts protected by email-code 2FA are fully supported. After installing the plugin, open **Plugin Settings** in the Homebridge UI and click **Start Login**. The plugin walks you through a secure PKCE OAuth flow using the official Hubspace iOS client — no credentials are sent anywhere except Hubspace's own servers.

- **No 2FA on your account?** Login completes automatically after you enter your username and password — no extra steps.
- **2FA enabled?** You'll be prompted to enter the one-time code from your email before the session is saved.

Authentication is cached so you only need to log in once. If the cache expires or is deleted, open Plugin Settings to log in again.

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
| `pollingInterval` | integer | `30` | How often (in seconds) to poll all device states. Minimum 10 s, maximum 600 s. Lower values give faster reflection of changes made in the Hubspace app. |
| `debug` | boolean | `false` | Log API/network activity: GET STATE, SET STATE, token refresh, Conclave details. Also dumps raw capabilities when an unsupported device is skipped. See also `verbose`. |
| `verbose` | boolean | `false` | Log full device state on every poll cycle (noisy). Implies `debug`. Use this when [requesting support for a new device](#requesting-support-for-a-new-device). |
| `disableConclave` | boolean | `false` | Disable the Afero Conclave real-time push connection and rely on polling only |
| `exposeComfortBreeze` | boolean | `false` | Add a separate "Comfort Breeze" Switch tile for ceiling fans that support it |
| `exposeMasterPowerSwitch` | boolean | `false` | Add a separate Switch tile for the ceiling-fan master power relay (only appears on fans where the master relay is distinct from the fan control) |
| `exposeStatusFault` | boolean | `false` | Show a StatusFault indicator on fan and light tiles when the device is reported offline by the Hubspace cloud. Non-standard — visible in Eve and Controller for HomeKit; may not display in Apple Home. |
| `invertOutletStatus` | boolean | `false` | Invert the reported on/off state for smart plugs that report their status backwards |
| `tokenCachePath` | string | — | Override the path for the cached auth token file. Leave blank to use the Homebridge storage directory (recommended). |

---

## Real-time push (Conclave)

The plugin maintains a persistent connection to the Afero Conclave push service. State changes — whether triggered from HomeKit or from the Hubspace app — are reflected in HomeKit within ~500 ms without waiting for a poll cycle. Regular polling (default every 30 s) runs in the background as a fallback for devices that don't emit push events.

No configuration is required — Conclave is on by default. Set `"disableConclave": true` to fall back to polling only.

---

## Troubleshooting

**Authentication failed / 2FA not working**
- Open **Plugin Settings** in Homebridge UI and use the **Start Login** button — this is the recommended way to authenticate, especially for 2FA accounts.
- Confirm your username and password work in the Hubspace app on your phone.
- If login previously worked but stopped, delete `<homebridge-storage>/hubspace-tokens.json` and log in again via Plugin Settings.

**Accessories show as `No Response`**
- Check Homebridge logs for `[Hubspace]` error lines.
- Enable `"debug": true` temporarily to see API call activity (GET STATE, SET STATE, token refresh).
- Verify your Homebridge host can reach `semantics2.afero.net`.

**Device not appearing**
- Enable `"verbose": true` and restart Homebridge. The log will show an `Unsupported deviceClass` warning for any skipped device, including its hardware model, full capability list, and a link to open a GitHub issue. See [Requesting support for a new device](#requesting-support-for-a-new-device).

**Device appears but a characteristic is wrong**
- Enable `"verbose": true` and restart Homebridge. Every poll cycle will print a `State for "..."` line with every capability and value the API returned. Paste that line in a GitHub issue along with a description of what HomeKit shows vs. what you expect.


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
