# What the tests establish

The bridge regression suite covers protocol TLVs, encryption, media arguments,
session cancellation, stale callback isolation, privacy behavior, recording
fragments, snapshots, pacing and motion zones. The runtime suite checks onboarding,
persistent identity, configuration validation and subprocess supervision.

CI builds the full app image for AMD64 and ARM64 and checks the packaged executables.
An isolated synthetic media test also checks HEVC video and AAC audio through the
bundled relay, copies the output without re-encoding, and verifies it can be decoded.
Passing CI proves neither Raspberry Pi performance nor successful Apple Home
recording for a particular camera. The bridge was previously exercised on an
x86 Linux host with a real HEVC camera and Apple Home. The new bundled relay and
Home Assistant packaging need their own field testing.

For a real-device acceptance test:

1. Record camera model, main/substream codecs and resolution, frame rate and
   keyframe interval; record host, hub and client versions.
2. Confirm a fresh pairing and that restarting/updating the app retains it.
3. Confirm timely preview, local live video and audio, and remote cellular viewing.
4. Trigger genuine motion, verify the Apple Home clip appears, and play it.
5. Test recording/privacy controls in Home, then restore the intended settings.
6. Observe CPU, memory and health logs during simultaneous live viewing and
   recording; run an extended stability trial with other Home Assistant apps.

Share only redacted results. Unit test success and packets sent to a hub are not
claims that iCloud retained footage or that every Apple Home client can play it.
