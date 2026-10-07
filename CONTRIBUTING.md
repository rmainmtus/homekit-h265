# Contributing

Please open a focused issue or pull request. Include the problem, expected
behavior, relevant versions and how you tested the change.

The camera service is TypeScript under `homekit_h265/bridge/src`. The app launcher
is under `homekit_h265/runtime`. Keep media changes separate from packaging changes
where practical. Preserve native video passthrough, stable accessory identities,
recording/privacy behavior, bounded resources and credential-free diagnostics.

Run the bridge tests (`npm ci && npm test` from `homekit_h265/bridge`) and launcher
tests (`node --test homekit_h265/runtime/*.test.cjs` from repository root). Add
regression tests for bugs with a meaningful reproduction. CI builds both supported
container architectures; hardware performance and actual Apple Home recordings
still require real-device testing.

Never commit camera credentials, live RTSP URLs, Home pairing keys, `.hap`, app
backups, or Apple diagnostic archives. Replace private data in fixtures with
obviously synthetic examples. Redact pairing codes as well as passwords in issues.

By submitting a contribution, you agree to license your original contribution
under Apache-2.0. Preserve the licenses and notices of any upstream code you adapt.
