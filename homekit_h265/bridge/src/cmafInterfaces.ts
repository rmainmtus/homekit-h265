// Modified/condensed from HAP-NodeJS SecureVideoController.ts, Apache-2.0.
// Source: seydx/HAP-NodeJS commit d81fba565ee26e82170d5f4f8cd358c2fd773f6c.
// Full notice: ../THIRD-PARTY-LICENSE.txt.
import type { BufferUploadCommandRequest, CameraRecordingPublishingPointValue } from './SecureVideoTypes';
import type { CMAFMediaDescription } from './CMAFIngest';
export interface SecureVideoIngestCredentials {
  publishingPoint?: CameraRecordingPublishingPointValue;
  privateKey?: string; clientCertificate?: Buffer; ca?: Buffer;
  keys: {keyNumber: bigint; key: Buffer}[]; currentKeyNumber?: bigint;
}
export interface CMAFClipRequest {cmafSessionId: bigint; command: BufferUploadCommandRequest; signal: AbortSignal;}
export interface CMAFSegment {type: 'init' | 'media'; data: Buffer; media?: CMAFMediaDescription; startedAt?: Date; duration?: number; last?: boolean;}
export interface CMAFRecordingDelegate {streamClip(request: CMAFClipRequest): AsyncGenerator<CMAFSegment>;}
