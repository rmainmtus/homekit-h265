# HomeKit H.265

A Home Assistant community app that connects an **H.265 / HEVC RTSP camera to
Apple Home**, with native video passthrough, encrypted local and remote viewing,
and experimental HomeKit Secure Video recording.

Built from a camera bridge that has been working in a real home. Shared so others
can try it, inspect it, and improve it. The new Home Assistant packaging and its
bundled relay are a **first experimental release**, not a claim of compatibility
with every camera or Raspberry Pi installation.

[![Add repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Frmainmtus%2Fhomekit-h265)

## Install

1. In Home Assistant OS, open **Settings → Apps → App store → ⋮ → Repositories**.
   Older Home Assistant versions call this the **Add-on Store**.
2. Add `https://github.com/rmainmtus/homekit-h265`.
3. Install **HomeKit H.265**, then enter your Home Assistant host's LAN IPv4 address,
   your camera's main HEVC RTSP URL, and its low-resolution motion RTSP URL.
4. Enable **Start on boot** and **Watchdog** on the app's Info tab, then start it.
   Watchdog restarts the app after a failed startup or a service crash.
   The app checks the video format and creates a persistent accessory
   identity. Use the pairing code shown in its log to add the camera in Apple Home.
5. Choose streaming/recording and motion categories in Apple Home. Verify an actual
   recording and test viewing both at home and over cellular.

This installs through Home Assistant's app/add-on repository mechanism.
**HACS does not install apps/add-ons.** [HACS explanation](https://www.hacs.xyz/docs/faq/addons/)

See **[full setup and troubleshooting](homekit_h265/DOCS.md)** for the options and
requirements. The first installation builds an image on your device and can take
several minutes; published prebuilt images are not required.

## What it does

- Copies the original HEVC video into live streams and recording fragments.
- Converts audio to the formats Apple Home needs; decodes frames for previews
  and low-resolution motion detection.
- Uses a bundled, local-only go2rtc relay to share the main camera connection.
  Scrypted is optional; a direct compatible RTSP camera can be used.
- Sends recordings to the Apple home hub over HDS. The hub handles analysis and
  iCloud recording. Experimental direct camera-to-cloud upload is disabled.
- Saves pairing and settings in persistent app storage and writes health logs
  without camera URLs or media encryption keys.

## Requirements and current limits

- One camera per app installation, with **HEVC video and an audio track** over RTSP.
- An RTSP motion source when recording is enabled. A low-resolution substream is
  strongly recommended on Raspberry Pi.
- Apple Home clients and a home hub supporting the new native HEVC camera path.
  The original working setup uses iOS/tvOS 27. Legacy H.264-only HomeKit clients
  are not supported by this app.
- HomeKit Secure Video also needs Apple's usual hub, account and iCloud+ setup.
- 64-bit Home Assistant OS on `aarch64` or `amd64`, with working LAN multicast and
  an IPv4 address. A Pi 4 with 4 GB is a reasonable single-camera test target;
  performance on that board still needs real-world validation. Use Ethernet.
- It does not create a Home Assistant camera entity, provide two-way talk, or
  maintain a local recording library. HA dashboard cameras can be added separately.

Keep video keyframes reasonably frequent (about 1–2 seconds is a useful starting
point). The camera keeps its native resolution and frame rate; no H.264 conversion
is performed. See [supported test scope](docs/TESTING.md) before relying on a new
camera/hub combination.

## Existing installations

Back up pairing state before moving hosts. This app creates its own identity on a
fresh install and refuses to overwrite orphaned HomeKit state. Importing an older
standalone deployment needs a deliberate migration; installing this app does not
automatically migrate the old accessory or recover its iCloud timeline. Never run
two copies of the same HomeKit identity simultaneously. See [migration notes](docs/MIGRATION.md).

## Development and contributions

```sh
cd homekit_h265/bridge
npm ci
npm test
cd ../..
node --test homekit_h265/runtime/*.test.cjs
```

The CI workflow tests the bridge and launcher, then builds `linux/amd64` and
`linux/arm64` images. Contributions, camera compatibility reports and focused bug
fixes are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md), especially before
sharing logs. Report security issues using [SECURITY.md](SECURITY.md).

## Say thanks

If this project has helped you, you can [buy me a coffee](https://buymeacoffee.com/rmnt)
to say thanks. Support is completely optional and always appreciated!

## Acknowledgements and license

This project builds on [HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS),
[camera.ui](https://github.com/cameraui/plugins),
[werift](https://github.com/shinyoshiaki/werift-webrtc), and
[go2rtc](https://github.com/AlexxIT/go2rtc). The native camera work would not be
possible without those projects.

New contributions: [Apache-2.0](LICENSE). MIT and Apache-2.0 upstream notices are
retained in [third-party notices](homekit_h265/bridge/THIRD-PARTY-LICENSE.txt) and
[NOTICE](NOTICE).
