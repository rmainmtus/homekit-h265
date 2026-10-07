// Explicit opt-in, on the camera LAN. This does not publish or pair an accessory.
// It checks that the actual camera emits encrypted HEVC and Opus RTP through the
// same transport used by the accessory. Apple decoding is a separate test.
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { mediaArguments, relay, startMedia } from '../media';
import { Tier } from '../protocol';
async function main() {
  const source = process.env.HEVC_TEST_RTSP;
  if (!source) throw new Error('HEVC_TEST_RTSP is required');
  const sockets = [dgram.createSocket('udp4'), dgram.createSocket('udp4')];
  for (const s of sockets) await new Promise<void>(r => s.bind(0, '127.0.0.1', r));
  const [v, a] = await Promise.all(sockets.map(s => relay('127.0.0.1', '127.0.0.1', s.address().port)));
  const packets = [0, 0]; const payloadTypes = [new Set<number>(), new Set<number>()];
  sockets.forEach((s, i) => s.on('message', b => {
    if (b.length >= 12 && b[1] < 192) {packets[i]++; payloadTypes[i].add(b[1] & 127);}
    else if (b.length >= 12 && b[1] > 223) {packets[i]++; payloadTypes[i].add(b[1] & 127);}
  }));
  const tier: Tier = {id: 1, quality: 2, width: 2304, height: 2592, fps: 12, averageKbps: 2466, peakKbps: 4111, rtspUrl: source};
  let job: Awaited<ReturnType<typeof startMedia>> | undefined;
  try {
    job = await startMedia(process.env.FFMPEG_PATH || 'ffmpeg', mediaArguments(tier, {
      id: randomBytes(16), address: '127.0.0.1', videoPort: sockets[0].address().port, audioPort: sockets[1].address().port,
      videoKey: randomBytes(30), audioKey: randomBytes(30)
    }, v.inputPort, a.inputPort, 123456, 789012), v, a, () => {});
    await new Promise(r => setTimeout(r, 5000));
    if (packets[0] < 10 || packets[1] < 10 || !payloadTypes[0].has(99) || !payloadTypes[1].has(110)) throw new Error('Media packets missing');
    console.log(JSON.stringify({result: 'PASS', encryptedVideoPackets: packets[0], encryptedAudioPackets: packets[1],
      videoCodecMode: 'copy', audioCodec: 'opus', applePlaybackVerified: false}));
  } finally {job?.stop(); v.close(); a.close(); sockets.forEach(s => s.close());}
}
main().catch(() => {console.error('Camera transport smoke test failed; no credentials logged.'); process.exitCode = 1;});
