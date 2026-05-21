export type HttpSinkStatusClass = 'success' | 'redirect' | 'retry' | 'permanent_failure';

export type HttpSinkBatchProfileName = 'single' | 'small_batch' | 'large_batch' | 'chunk_reference';

export interface HttpSinkBatchProfile {
  name: HttpSinkBatchProfileName;
  maxRecords: number;
  maxBytes: number;
  flushIntervalMs: number;
  sendsChunkReference: boolean;
}

export interface HttpSinkRetryDelayInput {
  attempt: number;
  retryAfter?: string | null;
  now?: Date;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

export const HTTP_SINK_BATCH_PROFILES: Record<HttpSinkBatchProfileName, HttpSinkBatchProfile> = {
  single: {
    name: 'single',
    maxRecords: 1,
    maxBytes: 512 * 1024,
    flushIntervalMs: 5_000,
    sendsChunkReference: false,
  },
  small_batch: {
    name: 'small_batch',
    maxRecords: 100,
    maxBytes: 512 * 1024,
    flushIntervalMs: 10_000,
    sendsChunkReference: false,
  },
  large_batch: {
    name: 'large_batch',
    maxRecords: 1_000,
    maxBytes: 4 * 1024 * 1024,
    flushIntervalMs: 30_000,
    sendsChunkReference: false,
  },
  chunk_reference: {
    name: 'chunk_reference',
    maxRecords: 1_000,
    maxBytes: 256 * 1024,
    flushIntervalMs: 30_000,
    sendsChunkReference: true,
  },
};

export function classifyHttpSinkStatus(status: number): HttpSinkStatusClass {
  if (status >= 200 && status < 300) {
    return 'success';
  }
  if (status >= 300 && status < 400) {
    return 'redirect';
  }
  if (status === 429 || status >= 500) {
    return 'retry';
  }
  return 'permanent_failure';
}

export function getHttpSinkBatchProfile(
  name: HttpSinkBatchProfileName = 'small_batch'
): HttpSinkBatchProfile {
  return HTTP_SINK_BATCH_PROFILES[name] ?? HTTP_SINK_BATCH_PROFILES.small_batch;
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  now = new Date()
): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds.toString() === value.trim()) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.max(0, timestamp - now.getTime());
}

export function computeHttpSinkRetryDelayMs(input: HttpSinkRetryDelayInput): number {
  const maxDelayMs = input.maxDelayMs ?? 5 * 60 * 1000;
  const retryAfterMs = parseRetryAfterMs(input.retryAfter, input.now);
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, maxDelayMs);
  }

  const attempt = Math.max(1, Math.floor(input.attempt));
  const baseDelayMs = input.baseDelayMs ?? 1000;
  const jitterRatio = Math.max(0, Math.min(input.jitterRatio ?? 0.2, 1));
  const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  const jitter = exponential * jitterRatio * ((input.random ?? Math.random)() * 2 - 1);
  return Math.max(0, Math.min(Math.round(exponential + jitter), maxDelayMs));
}
