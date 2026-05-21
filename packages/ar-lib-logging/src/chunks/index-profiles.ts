import { LOG_TYPES, type LogType } from '../registry';

export type LogChunkIndexFieldType = 'string' | 'number' | 'boolean';

export interface LogChunkIndexFieldDefinition {
  name: string;
  type: LogChunkIndexFieldType;
}

export interface LogChunkIndexProfile {
  name: string;
  logTypes: readonly LogType[];
  fields: readonly LogChunkIndexFieldDefinition[];
  maxStringLength: number;
}

const COMMON_EVENT_FIELDS: readonly LogChunkIndexFieldDefinition[] = [
  { name: 'eventType', type: 'string' },
  { name: 'eventCategory', type: 'string' },
  { name: 'result', type: 'string' },
  { name: 'severity', type: 'string' },
  { name: 'errorCode', type: 'string' },
  { name: 'clientId', type: 'string' },
  { name: 'requestId', type: 'string' },
  { name: 'durationMs', type: 'number' },
];

export const LOG_CHUNK_INDEX_PROFILES: Record<string, LogChunkIndexProfile> = {
  normal: {
    name: 'normal',
    logTypes: ['normal'],
    fields: COMMON_EVENT_FIELDS,
    maxStringLength: 256,
  },
  audit: {
    name: 'audit',
    logTypes: ['audit'],
    fields: COMMON_EVENT_FIELDS,
    maxStringLength: 256,
  },
  admin_audit: {
    name: 'admin_audit',
    logTypes: ['admin_audit'],
    fields: [
      { name: 'action', type: 'string' },
      { name: 'resourceType', type: 'string' },
      { name: 'resourceId', type: 'string' },
      { name: 'result', type: 'string' },
      { name: 'severity', type: 'string' },
      { name: 'adminId', type: 'string' },
      { name: 'requestId', type: 'string' },
    ],
    maxStringLength: 256,
  },
  security: {
    name: 'security',
    logTypes: ['security'],
    fields: COMMON_EVENT_FIELDS,
    maxStringLength: 256,
  },
  pii: {
    name: 'pii',
    logTypes: ['pii'],
    fields: [
      { name: 'changeType', type: 'string' },
      { name: 'actorType', type: 'string' },
      { name: 'legalBasis', type: 'string' },
      { name: 'requestId', type: 'string' },
      { name: 'affectedFieldCount', type: 'number' },
    ],
    maxStringLength: 256,
  },
  diagnostic: {
    name: 'diagnostic',
    logTypes: ['diagnostic'],
    fields: [
      { name: 'surface', type: 'string' },
      { name: 'category', type: 'string' },
      { name: 'severity', type: 'string' },
      { name: 'requestId', type: 'string' },
      { name: 'durationMs', type: 'number' },
    ],
    maxStringLength: 256,
  },
  job: {
    name: 'job',
    logTypes: ['job'],
    fields: [
      { name: 'jobType', type: 'string' },
      { name: 'jobId', type: 'string' },
      { name: 'status', type: 'string' },
      { name: 'attempt', type: 'number' },
      { name: 'durationMs', type: 'number' },
    ],
    maxStringLength: 256,
  },
  webhook: {
    name: 'webhook',
    logTypes: ['webhook'],
    fields: [
      { name: 'webhookId', type: 'string' },
      { name: 'eventType', type: 'string' },
      { name: 'status', type: 'string' },
      { name: 'httpStatus', type: 'number' },
      { name: 'attempt', type: 'number' },
    ],
    maxStringLength: 256,
  },
  operational: {
    name: 'operational',
    logTypes: ['operational'],
    fields: [
      { name: 'surface', type: 'string' },
      { name: 'eventType', type: 'string' },
      { name: 'severity', type: 'string' },
      { name: 'status', type: 'string' },
      { name: 'errorClass', type: 'string' },
    ],
    maxStringLength: 256,
  },
};

const PROFILE_BY_LOG_TYPE = new Map<LogType, LogChunkIndexProfile>(
  Object.values(LOG_CHUNK_INDEX_PROFILES).flatMap((profile) =>
    profile.logTypes.map((logType) => [logType, profile] as const)
  )
);

export function getLogChunkIndexProfile(nameOrLogType: string): LogChunkIndexProfile {
  const direct = LOG_CHUNK_INDEX_PROFILES[nameOrLogType];
  if (direct) {
    return direct;
  }
  if ((LOG_TYPES as readonly string[]).includes(nameOrLogType)) {
    const byLogType = PROFILE_BY_LOG_TYPE.get(nameOrLogType as LogType);
    if (byLogType) {
      return byLogType;
    }
  }
  throw new Error(`unsupported_log_chunk_index_profile:${nameOrLogType}`);
}

function valueMatchesType(value: unknown, type: LogChunkIndexFieldType): boolean {
  if (type === 'string') {
    return typeof value === 'string';
  }
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return typeof value === 'boolean';
}

export function filterLogChunkIndexedFields(
  profileName: string,
  fields: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!fields) {
    return undefined;
  }

  const profile = getLogChunkIndexProfile(profileName);
  const output: Record<string, unknown> = {};

  for (const definition of profile.fields) {
    const value = fields[definition.name];
    if (!valueMatchesType(value, definition.type)) {
      continue;
    }
    output[definition.name] =
      definition.type === 'string' && (value as string).length > profile.maxStringLength
        ? (value as string).slice(0, profile.maxStringLength)
        : value;
  }

  return Object.keys(output).length > 0 ? output : undefined;
}
