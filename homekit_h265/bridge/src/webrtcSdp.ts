// Adapted from cameraui/plugins (MIT); see THIRD-PARTY-LICENSE.txt.
import { RTCPeerConnection } from 'werift';
import { Tier } from './protocol';
// Pinned werift 0.24.4 keeps bound STUN UDP sockets on the ICE connection.
// Large camera keyframes must not overflow the OS defaults during encryption.
export function tuneIceBuffers(pc: RTCPeerConnection): void {
  for (const ice of pc.iceTransports) {
    for (const protocol of (ice.connection as any).protocols ?? []) {
      const socket = protocol.transport?.socket;
      if (!socket?.setRecvBufferSize) continue;
      try {socket.setRecvBufferSize(4 * 1024 * 1024); socket.setSendBufferSize(1024 * 1024);} catch {}
    }
  }
}
// werift creates its DTLS server only once ICE reports connected, but Apple's ice-lite relay
// (setup:active) sends the ClientHello as soon as our nominating check arrives, so the first
// flight is dropped and the handshake waits for the relay's 1s retransmit; keep the early
// records and feed them to the server the moment it exists
export function replayEarlyDtls(pc: RTCPeerConnection, onReplay: (count: number) => void): void {
  for (const dtlsTransport of pc.dtlsTransports) {
    const early: Buffer[] = [];
    const dataSubscription = dtlsTransport.iceTransport.connection.onData.subscribe((data) => {
      if (dtlsTransport.state === 'new' && isDtlsRecord(data)) {
        if (early.length < 32) early.push(data);
      }
    });
    const stateSubscription = dtlsTransport.onStateChange.subscribe((state) => {
      if (state === 'new') {
        return;
      }
      dataSubscription.unSubscribe();
      stateSubscription.unSubscribe();
      if (state !== 'connecting' || early.length === 0) {
        return;
      }
      setImmediate(() => {
        const socket = dtlsTransport.dtls?.transport.socket;
        if (!socket) {
          return;
        }
        const receive = socket.onData as (data: Buffer) => void;
        for (const data of early) {
          receive(data);
        }
        onReplay(early.length);
      });
    });
  }
}

function isDtlsRecord(data: Buffer): boolean {
  return data.length > 0 && data[0] > 19 && data[0] < 64;
}

const RTP_STREAM_ID_URI = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';
const RTP_STREAM_ID = '1';

// iOS 27's willow group session rejects a video offer without an rtpStreamId
// ("at least one rtpStreamId is required in mid:0"), werift does not emit rid/simulcast for a
// send transceiver so the lines are injected into the video media section here. The relay
// translates the offer into Apple's media blob, a video stream without a bitrate ends up as
// "no valid streams" on the viewer, so the tier's bitrate goes in as b= and rid constraints
export function addVideoRtpStreamId(sdp: string, tier: Tier): string {
  const lines = sdp.split(/\r?\n/);
  const videoStart = lines.findIndex((line) => line.startsWith('m=video'));
  if (videoStart < 0) {
    return sdp;
  }
  let videoEnd = lines.findIndex((line, index) => index > videoStart && line.startsWith('m='));
  if (videoEnd < 0) {
    videoEnd = lines.length;
  }

  const bitrate = tier.peakKbps * 1000;
  const connection = lines.findIndex((line, index) => index > videoStart && index < videoEnd && line.startsWith('c='));
  lines.splice(connection < 0 ? videoStart + 1 : connection + 1, 0, `b=AS:${tier.peakKbps}`, `b=TIAS:${bitrate}`);
  videoEnd += 2;

  const usedIds = new Set<number>();
  for (const line of lines) {
    const match = /^a=extmap:(\d+)/.exec(line);
    if (match) {
      usedIds.add(Number(match[1]));
    }
  }
  let extId = 1;
  while (usedIds.has(extId) && extId < 15) {
    extId++;
  }

  const insert = [
    `a=extmap:${extId} ${RTP_STREAM_ID_URI}`,
    `a=rid:${RTP_STREAM_ID} send max-width=${tier.width};max-height=${tier.height};max-fps=${tier.fps};max-br=${bitrate}`,
    `a=simulcast:send ${RTP_STREAM_ID}`,
  ];
  lines.splice(videoEnd, 0, ...insert);
  return lines.join('\r\n');
}
