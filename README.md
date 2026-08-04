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
    <img src="https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat" alt="Verified by Homebridge" />
  </a>
  <a href="https://github.com/ctrlcmdshft/homebridge-hubspace-platform/actions/workflows/build.yml">
    <img src="https://github.com/ctrlcmdshft/homebridge-hubspace-platform/actions/workflows/build.yml/badge.svg" alt="Build, Lint, and Test" />
  </a>
</p>

# Homebridge Hubspace Platform

Integrates [Hubspace](https://www.hubspace.com) smart home devices (sold at Home Depot, powered by the Afero cloud) with Apple HomeKit via [Homebridge](https://homebridge.io). Control ceiling fans, lights, outlets, switches, portable/window air conditioners, landscape transformers, and door locks from the Home app or with Siri.

> **Disclaimer:** This is an unofficial, community-driven plugin. [See disclaimer below.](#disclaimer)

---

<p align="center">
<a href="#supported-devices"><b>Supported devices</b></a> · <a href="#requirements"><b>Requirements</b></a> · <a href="#two-factor-authentication-2fa"><b>2FA</b></a> · <a href="#installation"><b>Installation</b></a> · <a href="#configuration"><b>Configuration</b></a>
<br>
<a href="#real-time-push-conclave"><b>Conclave</b></a> · <a href="#troubleshooting"><b>Troubleshooting</b></a> · <a href="#requesting-support-for-a-new-device"><b>New device support</b></a> · <a href="#development"><b>Development</b></a>
</p>

---

## Supported devices

Support is capability-based, so nearby Hubspace models often work even if they are not listed by name. The models below are the ones this plugin has been tested against or implemented from community logs.

| Category | Examples / classes | HomeKit exposure | Status |
| --- | --- | --- | --- |
| Ceiling fans | Hampton Bay Universal Smart Fan Controller (76278); `fan`, `ceiling-fan` | Fan on/off, speed, light kit on/off, brightness, rotation direction when reported, optional Comfort Breeze and master-power switches | Tested with hardware |
| Lights and bulbs | EcoSmart RGBWIC LED Strip Light (AL-HSTL-RGBICTW); EcoSmart A19 Color Bulb (12A19060WRGBWH1); `light` | On/off, brightness, color temperature, RGB color when reported | Tested with hardware |
| Plugs and outlets | Defiant Smart Indoor Plug (HPPA11AWB); Defiant Outdoor Plug (HPPA52CWB); Commercial Electric Surge Protector (LA-12A-C); `outlet`, `plug`, `power-outlet` | Outlet on/off, OutletInUse, StatusFault; multi-outlet devices expose each controllable outlet separately | Tested with hardware |
| Switches | Hubspace Smart Switch; `switch` | Switch on/off | Implemented, untested |
| Portable/window ACs | Vissani VAP05R1AWT, VAW06R1AWTS-style models; `portable-air-conditioner` | HeaterCooler service with power, cool-only target mode, cooling setpoint, current temperature, fan speed, StatusFault | Tested with hardware and community logs |
| Landscape transformers | Hampton Bay Smart 200W Landscape Transformer (HB-200-1215WIFI); `landscape-transformer` | Master switch, one switch per detected zone, overload StatusFault | Community tested |
| Door locks | Defiant Hubspace door locks; `door-lock` | Lock/unlock, current lock state, battery level, StatusFault | Implemented from community logs, untested |

Device-dependent controls only appear when the Hubspace API reports the matching capability:

| Control | Required Hubspace capability |
| --- | --- |
| Fan rotation direction | `fan-reverse` |
| Comfort Breeze switch | `toggle[comfort-breeze]` and `exposeComfortBreeze: true` |
| Master-power switch | Separate `power[primary]` and `power[fan-power]`, plus `exposeMasterPowerSwitch: true` |
| RGB color | `color-rgb` |
| Color temperature | `color-temperature` |

All EcoSmart/Hubspace A19 bulbs should work out of the box. Color bulbs expose on/off, brightness, color temperature, and RGB; tunable white bulbs expose on/off, brightness, and color temperature only.

Smart switches are implemented based on the Afero API but have not yet been verified with real hardware. If you own one and can confirm it works, or find a bug, please open an issue.

## Requirements

- **Node.js** 22 or 24
- **Homebridge** 1.8.0 or newer, including Homebridge 2.x
- A Hubspace / Home Depot account with at least one paired device

## Two-factor authentication (2FA)

Accounts protected by email-code 2FA are supported. After installing the plugin, open **Plugin Settings** in the Homebridge UI and click **Start Login**. The plugin walks you through a PKCE OAuth flow using the official Hubspace iOS client. Credentials are sent only to Hubspace's own servers.

- **No 2FA on your account?** Login completes automatically after you enter your username and password — no extra steps.
- **2FA enabled?** You'll be prompted to enter the one-time code from your email before the session is saved.

Authentication tokens are cached locally so you only need to log in again when the cache expires, is deleted, or you change accounts.

## Installation

| Setup | How to install |
|---|---|
| Homebridge UI (recommended) | Plugins tab → search `homebridge-hubspace-platform` → Install → Settings → sign in → Restart |
| `hb-service` on Linux / Raspberry Pi | Use the Homebridge UI, or install globally with `sudo npm install -g homebridge-hubspace-platform` and restart Homebridge |
| Docker | Use the Homebridge UI inside the container, or add the plugin to your container startup config |
| Manual global Homebridge install | `npm install -g homebridge-hubspace-platform`, only when Homebridge itself is installed globally with npm |

> **Note:** `npm install -g` installs into the system Node prefix, not the Homebridge plugin directory. On most setups (Docker, hb-service, HOOBS) the plugin won't be found. Prefer the Homebridge UI where possible.

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
| `pollingInterval` | integer | `300` with Conclave, `30` without | Polling fallback interval in seconds. Valid range: 10-600. Lower values can help devices that do not reliably emit push events. |
| `debug` | boolean | `false` | Log API/network activity, token refreshes, Conclave details, and raw capabilities for unsupported devices. |
| `verbose` | boolean | `false` | Log full device state on every poll cycle. Very noisy; use this when [requesting support for a new device](#requesting-support-for-a-new-device). Implies `debug`. |
| `disableConclave` | boolean | `false` | Disable the Afero Conclave real-time push connection and rely on polling only |
| `exposeComfortBreeze` | boolean | `false` | Add a separate "Comfort Breeze" Switch tile for ceiling fans that support it |
| `exposeMasterPowerSwitch` | boolean | `false` | Add a separate Switch tile for the ceiling-fan master power relay (only appears on fans where the master relay is distinct from the fan control) |
| `exposeStatusFault` | boolean | `false` | Show a StatusFault indicator on fan and light tiles when the device is reported offline by the Hubspace cloud. Non-standard — visible in Eve and Controller for HomeKit; may not display in Apple Home. |
| `invertOutletStatus` | boolean | `false` | Invert the reported on/off state for smart plugs that report their status backwards |
| `excludedDevices` | string | — | Comma-separated Hubspace friendly names to skip during discovery. Matching is case-insensitive; unmatched entries are logged as warnings to catch typos. |
| `tokenCachePath` | string | — | Override the path for the cached auth token file. Leave blank to use the Homebridge storage directory (recommended). |

> Outlets, portable/window air conditioners, and landscape transformers expose fault status automatically where HomeKit supports it. The `exposeStatusFault` option only adds the non-standard fault characteristic to fan and light services.

## Real-time push (Conclave)

The plugin maintains a persistent connection to the Afero Conclave push service. State changes, whether triggered from HomeKit or from the Hubspace app, are reflected in HomeKit without waiting for the next poll cycle. Regular polling still runs in the background as a fallback for devices that do not emit push events.

Default polling interval:

| Mode | Default |
| --- | --- |
| Conclave enabled | 300 s |
| Conclave disabled | 30 s |

No configuration is required — Conclave is on by default. Set `"disableConclave": true` to fall back to polling only.

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
- Check whether the device name is listed in `excludedDevices`.
- The log will show an `Unsupported deviceClass` warning for unsupported devices. Enable `"debug": true` for a capability dump, or run the [standalone dump script](#requesting-support-for-a-new-device) — no restart needed.

**Device appears but a characteristic is wrong**
- Enable `"verbose": true` and restart Homebridge. Every poll cycle will print a `State for "..."` line with every capability and value the API returned. Paste that line in a GitHub issue along with a description of what HomeKit shows vs. what you expect.

## Requesting support for a new device

If your Hubspace device does not appear in HomeKit and it is not intentionally excluded, the plugin may not support its `deviceClass` yet. Choose either method below to gather the capability data needed to add support.

### Option A — Standalone script (easiest)

**Requirements:**
- Node.js 18+ (already installed if you're running Homebridge)
- macOS / Linux: `curl` (pre-installed on macOS and most Linux distros)
- Windows: Windows 10 1803+ or Windows 11 (includes `curl.exe`), and Node.js in your PATH

Run this command on any machine — the same machine running Homebridge works fine:

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/ctrlcmdshft/homebridge-hubspace-platform/main/scripts/dump-devices.js -o /tmp/hubspace-dump.js && node /tmp/hubspace-dump.js
```

**Windows (PowerShell — Windows 10 1803+ / Windows 11):**
```powershell
curl.exe -o $env:TEMP\hubspace-dump.js https://raw.githubusercontent.com/ctrlcmdshft/homebridge-hubspace-platform/main/scripts/dump-devices.js; node $env:TEMP\hubspace-dump.js
```

**Windows (PowerShell fallback — any version):**
```powershell
Invoke-WebRequest -Uri https://raw.githubusercontent.com/ctrlcmdshft/homebridge-hubspace-platform/main/scripts/dump-devices.js -OutFile $env:TEMP\hubspace-dump.js; node $env:TEMP\hubspace-dump.js
```

You can also provide credentials with environment variables, which is useful for non-interactive runs:

```bash
HUBSPACE_EMAIL="you@example.com" HUBSPACE_PASS="your-hubspace-password" node /tmp/hubspace-dump.js
```

The script prompts for your Hubspace email and password if the environment variables are not set. Password entry is hidden on macOS/Linux and visible on Windows. When it finishes, copy the output starting at this marker:

```
========= COPY FROM HERE =========

Found N device(s):

--- Device Name
    deviceClass  : light
    hardware     : Manufacturer / Model
    capabilities : power, brightness, color-rgb, ...
    values:
      power[default] = off
      brightness[default] = 75
      ...

-- Paste the output above into your GitHub issue --
```

Copy everything from `COPY FROM HERE` to the end and paste it into your issue. Your email and password stay above the marker. No Homebridge restart needed.

### Option B — Homebridge debug log

1. Add `"debug": true` to your Homebridge config for this plugin and restart Homebridge.
2. Watch the log. For each unsupported device you'll see a warning like:

   ```
   [WARN] Unsupported deviceClass "smart-dimmer" — "Hallway Switch" will not appear in HomeKit.
     Hardware     : Hubspace / HB-200-WH
     Capabilities : power, brightness, color-temperature
     [debug] power[default] = "off"
     [debug] brightness[default] = 75
     [debug] color-temperature[default] = 3500
   ```

3. Remove `"debug": true` once you've captured the logs.

### Opening an issue

[Open a GitHub issue](https://github.com/ctrlcmdshft/homebridge-hubspace-platform/issues/new/choose) and paste the output from either method above, along with your device's name and model as shown in the Hubspace app.

## Development

Local setup, API endpoint reference, authentication details, and the `discover.mjs` exploration script are documented in the [**Development wiki**](https://github.com/ctrlcmdshft/homebridge-hubspace-platform/wiki/Development).

## Disclaimer

This project is an independent, community-driven Homebridge plugin. It is **not affiliated with, endorsed by, or supported by** Hubspace, The Home Depot, or Afero. All product names and trademarks are the property of their respective owners. Use of this plugin is at your own risk.

---

## License

[MIT](./LICENSE) © [ctrlcmdshft](https://github.com/ctrlcmdshft)
