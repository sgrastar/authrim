export const LOG_TYPES = [
  'normal',
  'audit',
  'admin_audit',
  'security',
  'pii',
  'diagnostic',
  'job',
  'webhook',
  'operational',
] as const;

export type LogType = (typeof LOG_TYPES)[number];

export const LOG_PLANES = [
  'primary',
  'archive',
  'external_sink',
  'sensitive_detail',
  'diagnostic_detail',
  'delivery_event',
] as const;

export type LogPlane = (typeof LOG_PLANES)[number];

export const LOG_CHUNK_COMPRESSION = ['none', 'gzip_block'] as const;

export type LogChunkCompression = (typeof LOG_CHUNK_COMPRESSION)[number];

export function assertLogType(value: string): asserts value is LogType {
  if (!(LOG_TYPES as readonly string[]).includes(value)) {
    throw new Error(`unsupported_log_type:${value}`);
  }
}

export function assertLogPlane(value: string): asserts value is LogPlane {
  if (!(LOG_PLANES as readonly string[]).includes(value)) {
    throw new Error(`unsupported_log_plane:${value}`);
  }
}
