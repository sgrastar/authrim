import type { LoggingDeliveryLane } from '../delivery/types';
import type { LoggingMessageJobCriticality, LoggingMessageJobSourceType } from './types';

export interface LoggingMessagePayloadBucket {
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
  ): Promise<unknown>;
}

export interface LoggingMessagePayloadWriteInput {
  bucket: LoggingMessagePayloadBucket;
  jobId: string;
  payloadType: string;
  schemaVersion: number;
  lane: LoggingDeliveryLane;
  criticality: LoggingMessageJobCriticality;
  sourceType: LoggingMessageJobSourceType;
  tenantKey?: string | null;
  payload: unknown;
  now?: number;
  storedPayloadEncoder?: (input: {
    plaintext: string;
    objectRef: string;
    sha256: string;
  }) => Promise<{
    body: string;
    contentType: string;
    customMetadata?: Record<string, string>;
  }>;
}

export interface LoggingMessagePayloadWriteResult {
  objectRef: string;
  sha256: string;
  byteLength: number;
  redactedSummary: Record<string, unknown>;
  validationSummary: Record<string, unknown>;
}

const SENSITIVE_KEY_PATTERN =
  /authorization|body|cookie|credential|key|password|secret|signature|token/i;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`)
    .join(',')}}`;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(digest);
}

function summarizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === 'string') {
    return { type: 'string', length: value.length };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }
  if (typeof value === 'object') {
    return { type: 'object', keys: Object.keys(value as Record<string, unknown>).sort() };
  }
  return { type: typeof value };
}

export function buildLoggingMessageRedactedSummary(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload: summarizeValue(payload) };
  }

  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    summary[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : summarizeValue(value);
  }
  return summary;
}

export function buildLoggingMessagePayloadKey(input: {
  jobId: string;
  payloadType: string;
  lane: LoggingDeliveryLane;
  criticality: LoggingMessageJobCriticality;
  sourceType: LoggingMessageJobSourceType;
  tenantKey?: string | null;
  now?: number;
}): string {
  const date = new Date(input.now ?? Date.now());
  return [
    'message-jobs',
    encodeSegment(input.payloadType),
    `criticality=${input.criticality}`,
    `lane=${input.lane}`,
    `source_type=${input.sourceType}`,
    `tenant_key=${encodeSegment(input.tenantKey ?? 'platform')}`,
    `yyyy=${date.getUTCFullYear()}`,
    `mm=${pad(date.getUTCMonth() + 1)}`,
    `dd=${pad(date.getUTCDate())}`,
    `hh=${pad(date.getUTCHours())}`,
    `${encodeSegment(input.jobId)}.json`,
  ].join('/');
}

export async function writeLoggingMessagePayloadToR2(
  input: LoggingMessagePayloadWriteInput
): Promise<LoggingMessagePayloadWriteResult> {
  const now = input.now ?? Date.now();
  const payloadJson = stableJsonStringify(input.payload);
  const sha256 = await sha256Hex(payloadJson);
  const objectRef = buildLoggingMessagePayloadKey({
    jobId: input.jobId,
    payloadType: input.payloadType,
    lane: input.lane,
    criticality: input.criticality,
    sourceType: input.sourceType,
    tenantKey: input.tenantKey,
    now,
  });
  const storedPayload = input.storedPayloadEncoder
    ? await input.storedPayloadEncoder({ plaintext: payloadJson, objectRef, sha256 })
    : { body: payloadJson, contentType: 'application/json' };
  await input.bucket.put(objectRef, storedPayload.body, {
    httpMetadata: { contentType: storedPayload.contentType },
    customMetadata: {
      payload_type: input.payloadType,
      schema_version: String(input.schemaVersion),
      sha256,
      message_job_id: input.jobId,
      ...storedPayload.customMetadata,
    },
  });

  return {
    objectRef,
    sha256,
    byteLength: new TextEncoder().encode(payloadJson).byteLength,
    redactedSummary: buildLoggingMessageRedactedSummary(input.payload),
    validationSummary: {
      payload_type: input.payloadType,
      schema_version: input.schemaVersion,
      sha256,
      byte_length: new TextEncoder().encode(payloadJson).byteLength,
    },
  };
}
