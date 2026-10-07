// camera.ui SFrame RTP helpers, MIT, Copyright (c) 2023-2026 seydx.
// Source: cameraui/plugins commit 082c2b9c66ad831bf03aa0128d123fe553d24d54.
// Full notice and file mapping: ../THIRD-PARTY-LICENSE.txt.
import { RtpHeader, RtpPacket } from 'werift';

export type SecureVideoCodec = 'h264' | 'hevc';

const HEVC_NAL_AP = 48;
const HEVC_NAL_FU = 49;
const H264_NAL_STAP_A = 24;
const H264_NAL_FU_A = 28;

const DESCRIPTOR_START = 0x80;
const DESCRIPTOR_END = 0x40;

export interface AccessUnit {
  data: Buffer;
  timestamp: number;
  marker: boolean;
}

export interface AccessUnitAssembler {
  push(packet: RtpPacket): AccessUnit | undefined;
}

export function createAccessUnitAssembler(codec: SecureVideoCodec): AccessUnitAssembler {
  return codec === 'h264' ? new H264AccessUnitAssembler() : new HevcAccessUnitAssembler();
}

// depacketizers collect the NAL units of one access unit and hand them out when the marker bit
// closes the frame. The viewer's VideoPacketBuffer parses the decrypted frame the way VideoToolbox
// emits it: a 4-byte big-endian length in front of every NAL unit, no start codes
abstract class NalAccessUnitAssembler implements AccessUnitAssembler {
  protected nalUnits: Buffer[] = [];
  protected fragment?: Buffer[];
  private timestamp?: number;

  public push(packet: RtpPacket): AccessUnit | undefined {
    if (this.timestamp !== undefined && packet.header.timestamp !== this.timestamp) {
      this.reset();
    }
    this.timestamp = packet.header.timestamp;

    this.depacketize(packet.payload);

    if (!packet.header.marker) {
      return undefined;
    }
    const unit: AccessUnit = {
      data: Buffer.concat(this.nalUnits.flatMap((nal) => [nalLength(nal), nal])),
      timestamp: packet.header.timestamp,
      marker: true,
    };
    this.reset();
    return unit.data.length > 0 ? unit : undefined;
  }

  protected abstract depacketize(payload: Buffer): void;

  protected aggregate(payload: Buffer, headerLength: number): void {
    let offset = headerLength;
    while (offset + 2 <= payload.length) {
      const length = payload.readUInt16BE(offset);
      offset += 2;
      this.nalUnits.push(payload.subarray(offset, offset + length));
      offset += length;
    }
  }

  protected fragmentUnit(fuHeader: number, nalHeader: Buffer, data: Buffer): void {
    if (fuHeader & 0x80) {
      this.fragment = [nalHeader, data];
    } else if (this.fragment) {
      this.fragment.push(data);
    }
    if (fuHeader & 0x40 && this.fragment) {
      this.nalUnits.push(Buffer.concat(this.fragment));
      this.fragment = undefined;
    }
  }

  private reset(): void {
    this.nalUnits = [];
    this.fragment = undefined;
    this.timestamp = undefined;
  }
}

// RFC 7798: single NAL, aggregation packet (48), fragmentation unit (49)
export class HevcAccessUnitAssembler extends NalAccessUnitAssembler {
  protected depacketize(payload: Buffer): void {
    if (payload.length < 2) {
      return;
    }
    const type = (payload[0] >> 1) & 0x3f;
    if (type === HEVC_NAL_AP) {
      this.aggregate(payload, 2);
    } else if (type === HEVC_NAL_FU) {
      if (payload.length < 3) {
        return;
      }
      const fuHeader = payload[2];
      this.fragmentUnit(fuHeader, Buffer.from([(payload[0] & 0x81) | ((fuHeader & 0x3f) << 1), payload[1]]), payload.subarray(3));
    } else {
      this.nalUnits.push(payload);
    }
  }
}

// RFC 6184: single NAL, STAP-A (24), FU-A (28)
export class H264AccessUnitAssembler extends NalAccessUnitAssembler {
  protected depacketize(payload: Buffer): void {
    if (payload.length < 2) {
      return;
    }
    const type = payload[0] & 0x1f;
    if (type === H264_NAL_STAP_A) {
      this.aggregate(payload, 1);
    } else if (type === H264_NAL_FU_A) {
      const fuHeader = payload[1];
      this.fragmentUnit(fuHeader, Buffer.from([(payload[0] & 0xe0) | (fuHeader & 0x1f)]), payload.subarray(2));
    } else if (type >= 1 && type <= 23) {
      this.nalUnits.push(payload);
    }
  }
}

function nalLength(nal: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(nal.length);
  return length;
}

export interface SFramePacketizerOptions {
  ssrc: number;
  payloadType: number;
  maxPayload: number;
}

// draft-ietf-avtcore-rtp-sframe: one descriptor byte (S first fragment, E last fragment) in
// front of each slice of the SFrame ciphertext, RTP timestamp and marker as the media frame had
export class SFrameRtpPacketizer {
  private sequenceNumber = Math.floor(Math.random() * 0x10000);

  constructor(private options: SFramePacketizerOptions) {}

  public packetize(ciphertext: Buffer, timestamp: number, marker: boolean): RtpPacket[] {
    const chunk = Math.max(1, this.options.maxPayload - 1);
    const packets: RtpPacket[] = [];
    for (let offset = 0; offset < ciphertext.length; offset += chunk) {
      const last = offset + chunk >= ciphertext.length;
      const descriptor = (offset === 0 ? DESCRIPTOR_START : 0) | (last ? DESCRIPTOR_END : 0);
      const header = new RtpHeader({
        version: 2,
        marker: marker && last,
        payloadType: this.options.payloadType,
        sequenceNumber: this.sequenceNumber,
        timestamp,
        ssrc: this.options.ssrc,
      });
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
      packets.push(new RtpPacket(header, Buffer.concat([Buffer.from([descriptor]), ciphertext.subarray(offset, offset + chunk)])));
    }
    return packets;
  }
}

export class SFrameRtpDepacketizer {
  private chunks: Buffer[] = [];

  // returns the ciphertext once the packet carrying the end bit arrives, fragments without a start are dropped
  public push(packet: RtpPacket): Buffer | undefined {
    const descriptor = packet.payload[0];
    if (descriptor & DESCRIPTOR_START) {
      this.chunks = [];
    } else if (this.chunks.length === 0) {
      return undefined;
    }
    this.chunks.push(packet.payload.subarray(1));
    if (!(descriptor & DESCRIPTOR_END)) {
      return undefined;
    }
    const ciphertext = Buffer.concat(this.chunks);
    this.chunks = [];
    return ciphertext;
  }
}
