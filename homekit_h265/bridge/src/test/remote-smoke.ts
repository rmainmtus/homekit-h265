import { signalChild } from '../childProcess';
// Explicit real-camera test; not part of the unit suite. No pairing is performed.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';
import { RemoteViewing } from '../webrtc';
import { parse, one, tlv, uint } from '../protocol';
import { SFrameReceiver, SFrameCipherSuite } from '../sframe';
import { SFrameRtpDepacketizer } from '../sframeRtp';
import { tuneIceBuffers } from '../webrtcSdp';
async function main() {
  const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const remote = new RemoteViewing(cfg.address, cfg.ffmpeg, cfg.tiers[0], Buffer.alloc(16), () => true, console.log);
  const pc = new RTCPeerConnection({iceServers: [], iceUseIpv6: false, iceInterfaceAddresses: {udp4: cfg.address}, codecs: {
    video: [new RTCRtpCodecParameters({mimeType: 'video/H265', clockRate: 90000, payloadType: 99})],
    audio: [new RTCRtpCodecParameters({mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 110})]}});
  let videoFrames = 0, audioFrames = 0, decodeFrames = 0, authFailures = 0;
  const decoder = spawn(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-f', 'hevc', '-i', 'pipe:0', '-frames:v', '12', '-threads', '1', '-f', 'framehash', '-'], {stdio: ['pipe', 'pipe', 'pipe']});
  let decodeErrors = ''; decoder.stderr.on('data', b => {decodeErrors = (decodeErrors + b.toString()).slice(-1500);}); decoder.stdin.on('error', () => {});
  let hashes = ''; decoder.stdout.on('data', b => {hashes += b.toString(); decodeFrames = hashes.split('\n').filter(l => /^0,/.test(l)).length;});
  try {
    const offer = parse(await remote.solicit(tlv([1, tlv([1, uint(1, 1)])])));
    if (one(offer, 4)[0]) throw new Error('Offer failed');
    const k = parse(one(offer, 5)), keys = new Map([[one(k, 2).readBigUInt64LE(), one(k, 1)]]);
    pc.onTrack.subscribe(track => {
      const depacketizer = new SFrameRtpDepacketizer();
      let cryptor: SFrameReceiver | undefined;
      track.onReceiveRtp.subscribe(packet => {
        try {
          cryptor ??= new SFrameReceiver(keys, packet.header.ssrc, track.kind === 'video' ? SFrameCipherSuite.AES_256_CTR_HMAC_SHA512_80 : SFrameCipherSuite.AES_256_CTR_HMAC_SHA512_32);
          const encrypted = depacketizer.push(packet); if (!encrypted) return;
          const plain = cryptor.unprotectFrame(encrypted);
          if (track.kind === 'video') {
            videoFrames++;
            for (let i = 0; i + 4 <= plain.length;) {
              const n = plain.readUInt32BE(i); i += 4;
              if (!n || i + n > plain.length) throw new Error('Invalid HEVC frame');
              if (!decoder.stdin.destroyed) decoder.stdin.write(Buffer.concat([Buffer.from([0, 0, 0, 1]), plain.subarray(i, i + n)]));
              i += n;
            }
          } else audioFrames++;
        } catch {authFailures++;}
      });
    });
    // Apple's relay requires RID signaling but forwards the single stream by SSRC.
    // This local werift receiver otherwise expects a RID extension on every packet.
    const localReceiverSdp = one(offer, 2).toString().replace(/^a=(rid|simulcast):.*\r?\n/gm, '');
    await pc.setRemoteDescription({type: 'offer', sdp: localReceiverSdp});
    await pc.setLocalDescription(await pc.createAnswer());
    tuneIceBuffers(pc);
    const accepted = parse(await remote.control('answer', tlv([1, one(offer, 1)], [2, Buffer.from(pc.localDescription!.sdp)])));
    if (one(accepted, 2)[0]) throw new Error('Answer failed');
    await new Promise<void>((resolve, reject) => {
      const start = Date.now(); const timer = setInterval(() => {
        if (decodeFrames >= 12 && audioFrames >= 20 && authFailures === 0) {clearInterval(timer); resolve();}
        else if (Date.now() - start > 25000) {clearInterval(timer); reject(new Error('Media test timed out'));}
      }, 250);
    });
    console.log(JSON.stringify({videoFrames, audioFrames, decodeFrames, authFailures, nativeHevc: true}));
  } finally {console.log(JSON.stringify({videoFrames, audioFrames, decodeFrames, authFailures, decodeErrors})); decoder.stdin.destroy(); signalChild(decoder, 'SIGKILL'); await remote.stopAll(); await pc.close();}
}
main().catch(e => {console.error(e.message); process.exitCode = 1;});
