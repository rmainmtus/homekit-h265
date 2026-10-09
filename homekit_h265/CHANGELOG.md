# Changelog

## 0.1.3

- Fix grey Apple Home camera previews by waiting for a complete HEVC keyframe
  before creating the snapshot image.
- Check decoded preview contrast in the real-media smoke test while the relay
  is already streaming, catching grey images that still pass JPEG validation.

## 0.1.2

- Add an authenticated Home Assistant setup page with a HomeKit QR code,
  copyable pairing code, and live pairing status.
- Explain direct Apple Home pairing and detect when a controller has already
  claimed the camera.
- Add an explicit pairing reset that archives this app's HomeKit state before
  restarting, preserving the camera configuration and numeric pairing code.
- Restrict setup-page access to Home Assistant Ingress without Supervisor API access.

## 0.1.1

- Guard every media shutdown against failed spawns before sending process signals.
  On Linux, cleanup must never signal a missing or zero process ID.
- Add failed-start and cancellation regressions, and bound CI test execution.

## 0.1.0

- Initial experimental Home Assistant app for a single HEVC camera with audio.
- Native video passthrough with encrypted local and remote Apple Home viewing.
- Hub-managed HomeKit Secure Video and low-resolution software motion detection.
- Bundled loopback-only RTSP relay; no separate Scrypted service required.
- Persistent random accessory identities, recording-graph protection and automatic
  status logging.
- ARM64/AMD64 container builds, protocol regression tests and startup tests.
