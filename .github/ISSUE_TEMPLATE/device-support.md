---
name: Request device support
about: Your Hubspace device isn't appearing in HomeKit
title: "Device support: <deviceClass> — <friendly name>"
labels: device-support
assignees: ''
---

## Device info

**Friendly name in Hubspace app:**

**Model / SKU (from the box or Hubspace app):**

## Unsupported deviceClass warning

Enable `"verbose": true` in your Homebridge config, restart, and paste the full warning block here:

```
[WARN] Unsupported deviceClass "..." — "..." will not appear in HomeKit.
  Hardware     : ...
  Capabilities : ...
```

## State dump

Paste the `State for "..."` line that appears in the log after the warning:

```
[Hubspace] State for "...": ...
```

## Additional context

Anything else that might help — Homebridge version, how the device behaves in the Hubspace app, etc.
