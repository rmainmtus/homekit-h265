# Changelog

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
