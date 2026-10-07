import { Tier, tlv, uint } from '../protocol';
export const tier: Tier = {id: 1, quality: 2, width: 2304, height: 2592, fps: 12, averageKbps: 2466, peakKbps: 4111, rtspUrl: 'rtsp://127.0.0.1:41549/example'};
export function setupRequest(id = Buffer.alloc(16, 7), address = '127.0.0.1', suite = 0) {
  const key = tlv([1, uint(suite, 1)], [2, Buffer.alloc(16, 1)], [3, Buffer.alloc(14, 2)]);
  return tlv([1, id], [3, tlv([1, uint(0, 1)], [2, Buffer.from(address)], [3, uint(50100, 2)], [4, uint(50101, 2)])], [4, key], [5, key]);
}
