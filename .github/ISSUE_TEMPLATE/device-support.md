---
name: Request device support
about: Your Hubspace device isn't appearing in HomeKit
title: "Device support: <device name / model>"
labels: device-support
assignees: ''
---

## Device info

**Friendly name in Hubspace app:**

**Model / SKU (from the box or Hubspace app):**

**Where to buy (Home Depot link if available):**

## Capability dump

Choose **one** of the following methods and paste the output below.

**Option A — Standalone script** (easiest, no Homebridge restart needed):

```bash
node -e "$(curl -fsSL https://raw.githubusercontent.com/ctrlcmdshft/homebridge-hubspace-platform/main/scripts/dump-devices.js)"
```

Prompts for your Hubspace email and password, then prints all your devices and their capabilities.

**Option B — Homebridge debug log:**

Add `"debug": true` to the plugin config in Homebridge, restart, and paste the warning block that appears for your device:

```
[WARN] Unsupported deviceClass "..." — "..." will not appear in HomeKit.
  Hardware     : ...
  Capabilities : ...
  [debug] functionClass[instance] = value
  ...
```

---

```
paste output here
```

## Additional context

Anything else that might help — how the device behaves in the Hubspace app, firmware version, etc.
