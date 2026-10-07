import { isIP } from 'node:net';
import { LabConfig } from './accessory';
import { validateTiers } from './protocol';
export function validateConfig(config: LabConfig): LabConfig {
  if (!config || typeof config !== 'object') throw new Error('Configuration is required');
  if (!config.name || !config.identity || config.identity.length > 100) throw new Error('Accessory name and stable identity are required');
  if (isIP(config.address) !== 4 || config.address === '0.0.0.0') throw new Error('Set the server LAN IPv4 address');
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(config.username)) throw new Error('Invalid accessory MAC-style identity');
  if (!/^\d{3}-\d{2}-\d{3}$/.test(config.pincode) || ['111-11-111', '123-45-678', '876-54-321', '000-00-000'].includes(config.pincode)) throw new Error('Invalid pairing code');
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Invalid HAP port');
  if (!config.ffmpeg || typeof config.ffmpeg !== 'string') throw new Error('FFmpeg path is required');
  if (!Number.isInteger(config.capabilitiesVersion) || config.capabilitiesVersion < 1 || config.capabilitiesVersion > 255) throw new Error('Invalid experimental capability version');
  if (config.recording !== undefined && typeof config.recording !== 'boolean') throw new Error('Recording must be boolean');
  if (config.nativeRecording !== undefined && (typeof config.nativeRecording !== 'boolean' || !config.recording)) throw new Error('Native recording requires recording enabled');
  if (config.directUpload !== undefined && (typeof config.directUpload !== 'boolean' || !config.nativeRecording)) throw new Error('Direct upload requires native recording enabled');
  if (config.motionRtspUrl && new URL(config.motionRtspUrl).protocol !== 'rtsp:') throw new Error('Motion source must be RTSP');
  validateTiers(config.tiers); return config;
}
