# HomeKit H.265 setup

## Before starting

Use a camera with an RTSP main stream carrying HEVC video **and audio**. Enable
camera audio even if you later choose not to record audio in Apple Home: live
streaming currently requires an audio track. Supply a low-resolution RTSP stream
for motion detection if you want recordings.

Apple Home clients and the Apple home hub must support native HEVC HomeKit cameras.
The underlying bridge has been used with iOS/tvOS 27. A compatible home hub and the
usual iCloud+ requirements still apply. This app is experimental and is not an
Apple-certified accessory.

## Configuration

| Option | Meaning |
| --- | --- |
| `name` | Camera name used when first added to Apple Home. |
| `address` | Home Assistant host's LAN IPv4 address, for example `192.168.1.10`. Do not use a container address or `127.0.0.1`. Reserve the address in your router. |
| `stream_url` | Main camera RTSP URL with HEVC video and audio. Credentials are stored in private app options. Percent-encode reserved characters in URL credentials. |
| `motion_url` | Low-resolution RTSP substream used to detect motion; required when `recording` is true. It may be H.264 or HEVC. |
| `port` | HomeKit TCP port, default `36460`. It must be unused on the host. |
| `recording` | Advertise recording support at first setup, default true. The value is fixed once the accessory identity is created. Use Apple Home's controls to enable/disable recording afterward. |
| `average_kbps` | Approximate average main-stream bitrate advertised to Apple Home, default 4000. Match the camera configuration. This does not alter the video. |
| `peak_kbps` | Peak advertised bitrate, default 8000; at least `average_kbps`. This does not alter the video. |
| `relay_port` | Private loopback RTSP relay port, default `18554`. Must differ from the HomeKit port and be unused. |

The app probes the main camera to determine its real resolution and frame rate.
It fails with a useful message if the input is unsupported. It never silently
converts H.264 or rescales your video. Normal app logs avoid source URLs and camera
passwords; the Home pairing code is deliberately shown so you can add the camera.
Redact it before sharing logs.

## Pair and test

After saving options, enable **Start on boot** and **Watchdog** on the app's Info
tab, then start the app. Watchdog is needed for automatic restart after a failed
camera probe or a service crash; it is not enabled by default.

Click **Open Web UI** on the app's Info tab. The setup page shows its live pairing
status, QR code, and a copyable pairing code. Scan the QR with Apple Home on an
iPhone connected to the same home network. If viewing the page on that iPhone,
copy the code and enter it in Apple Home manually.

Pair directly with **Apple Home**. Do not configure this camera through Home
Assistant's **HomeKit Device** integration: that claims the pairing and makes
the camera unavailable to Apple Home. Home Assistant runs the app; your Apple
home hub handles Secure Video.

In the camera's Recording Options, select Stream and
Record for the locations you want. Walk through view, then verify the clip actually
appears and plays. Choose specific-motion categories in Apple Home if desired;
the home hub performs that classification.

Test Wi-Fi and cellular live viewing. A successful server startup alone does not
prove Apple Home playback or iCloud recording. Keep the app running for an extended
trial before relying on it for an important camera.

### If the camera says it is already paired

If you accidentally paired it through Home Assistant's HomeKit Device integration,
remove that camera's integration entry first. If the setup page still says it is
paired, use **Reset pairing** and confirm the warning. This stops this app's camera,
archives its HomeKit state privately under `/data/pairing-backups`, then starts it
with no paired controllers. The app keeps its camera configuration, accessory
identity, and numeric pairing code. Its QR code may change; use the newly displayed
one. Other camera apps are unaffected.

Only reset when you intend to pair this camera again. Existing Apple Home recording
history may become inaccessible, and recording/privacy settings must be set again.
If this camera is already listed in Apple Home, remove its old entry before pairing
it again with the new setup code.
Keep the private backup; it contains HomeKit keys and must not be shared publicly.

The setup page is accessible through Home Assistant's authenticated Ingress only.
Its server uses port `18664`, reserved for this app, and refuses direct LAN access.
It does not require Supervisor API access or any internet port forwarding.

## Storage, updates and privacy

Pairing identity and HomeKit state live under `/data`, Home Assistant's persistent
app storage. App updates retain them. App backups include secrets such as RTSP
credentials and Home pairing keys; keep backups private. Use a cold backup when
migrating so the identity and HomeKit files are consistent.

Deleting app data, removing/re-pairing an accessory, or changing identities can
disrupt Apple Home history. These are not routine troubleshooting steps. Recording
capability is locked after first setup to avoid changing the service graph of an
existing accessory.

The bundled relay listens only on loopback. Its web API and WebRTC services are
disabled. Apple Home uses this app's own encrypted live and recording paths.
No internet port forwarding is needed. The host network setting is required for
HomeKit discovery, the advertised LAN address and dynamically allocated media ports.

The relay shares the camera connection; it does not replay cached keyframes to new
viewers. Set a camera keyframe interval of about 1–2 seconds for timely previews
and stream startup. The bridge maintains its own buffer while recording is active.

## Troubleshooting

- **Invalid address:** use the Home Assistant machine's actual IPv4 LAN address.
- **Probe failed:** check RTSP credentials, camera connectivity and that its main
  stream provides HEVC and audio. The app deliberately avoids dumping FFmpeg errors
  that may include your camera password.
- **Relay cannot start:** change `relay_port` if another service already uses it.
- **No Response:** check the app log, LAN address, multicast reachability and whether
  the Apple TV can reach Home Assistant. Avoid guest Wi-Fi isolation.
- **No recordings:** check the motion stream, Home's Stream and Record settings,
  the active home hub and iCloud+ setup. Health lines should show fresh motion frames
  and a ready recording buffer. They cannot prove that a clip reached iCloud.
- **Slow snapshots on Pi:** use a low-resolution motion stream, reasonable main
  resolution/bitrate and frequent keyframes. Preview decoding still uses CPU.
- **Migration required:** existing state was found without this app's identity
  manifest. Restore the matching files or follow the repository migration notes;
  do not delete hidden HomeKit state to bypass the check.

When reporting a problem, provide app version, CPU architecture, camera codec and
dimensions, hub/client OS versions, and a short redacted log around the event.
Never attach private app backups or complete Apple diagnostics to a public issue.

## Say thanks

If this project has helped you, you can [buy me a coffee](https://buymeacoffee.com/rmnt)
to say thanks. Support is completely optional and always appreciated!
