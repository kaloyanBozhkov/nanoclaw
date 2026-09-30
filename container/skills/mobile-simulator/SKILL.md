---
name: mobile-simulator
description: Drive the iOS Simulator or Android Emulator on the user's Mac — launch apps, tap and type by element label, run Maestro flows, and take screenshots. Use whenever a task involves looking at or testing a mobile app, the same way agent-browser is used for web pages.
allowed-tools: mcp__nanoclaw__mobile_simulator
---

# iOS Simulator and Android Emulator with Maestro

The simulator runs on the host Mac, not in this container. The `mobile_simulator`
MCP tool bridges to it and handles both platforms: pass `platform: "ios"`
(default) or `platform: "android"`. It must be enabled per chat with
`/simulator on`; if a call is refused, tell the user and ask them to enable it.

## Android first steps

Android emulators are usually not running. Before anything else:

1. `mobile_simulator { action: "list_devices", platform: "android" }` — shows
   running emulators (`emulator-5554 device`) and bootable AVDs by name.
2. If nothing is running: `mobile_simulator { action: "boot", platform: "android",
   device: "<AVD name>", timeout_seconds: 180 }`. It returns once
   `sys.boot_completed` is 1.
3. Then use `hierarchy`, `run_flow`, `screenshot` with `platform: "android"`.
   The `appId` in a flow is the Android `applicationId`; `tapOn: { id: ... }`
   matches `resource-id`; `- back` presses hardware back.

## Quick start

1. `mobile_simulator { action: "hierarchy" }` — see what is on screen as JSON.
2. `mobile_simulator { action: "run_flow", flow_yaml: "..." }` — act.
3. `mobile_simulator { action: "screenshot", name: "after-login" }` — capture.
4. `Read /workspace/group/maestro/after-login.png` to look at it yourself, or
   `send_image` it to the chat.

## Where files go

Everything lands in `/workspace/group/maestro/`:

- `screenshot` action → `/workspace/group/maestro/<name>.png`
- flow screenshots (`takeScreenshot: <name>`) → `/workspace/group/maestro/runs/<id>/...`
  The result lists every PNG path, so you never need to search for them.
- the flow you ran → `/workspace/group/maestro/runs/<id>/flow.yaml`

Nothing needs copying. These paths work directly with `Read` and `send_image`.

## Flow YAML cheat sheet

```yaml
appId: com.example.app          # required header
---
- launchApp                      # or launchApp: { clearState: true }
- openLink: https://example.com  # deep link / universal link
- tapOn: "Sign in"               # visible text or accessibility label
- tapOn: { id: "email-field" }   # accessibility identifier
- tapOn: { point: "50%,80%" }    # coordinates, last resort
- inputText: "me@example.com"
- hideKeyboard
- scroll
- scrollUntilVisible: { element: "Settings" }
- swipe: { direction: LEFT }
- back                           # iOS: navigates back where supported
- assertVisible: "Welcome"
- assertNotVisible: "Error"
- extendedWaitUntil: { visible: "Loaded", timeout: 10000 }
- takeScreenshot: home           # relative name only — no slashes, no path
- stopApp
```

Batch as many steps as make sense into one flow: each `run_flow` is one host
round-trip. Split flows at points where you need to look at the hierarchy or a
screenshot before deciding the next step.

## Tips

- Prefer `hierarchy` over screenshots for finding elements. The tree gives you
  exact labels to use in `tapOn`, and it is much cheaper than vision.
- Screenshots are full-resolution device captures; they are large but fine to
  `Read`.
- The first flow on a freshly booted simulator is slow while Maestro installs
  its driver. Raise `timeout_seconds` if it times out on the first try.
- A failed step prints which assertion or tap failed in stdout. Look at the
  hierarchy to see what was actually on screen and adjust the label.
- `list_devices` only matters when more than one simulator is booted; the
  default target is the booted device. On Android it is how you find the AVD
  name for `boot`.
- Flows are identical across platforms except `appId`; a flow written for iOS
  usually runs on Android unchanged once the ids/labels match.
