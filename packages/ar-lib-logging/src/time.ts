export const LOGGING_TIME_UNITS = 'epoch_ms';

export function nowEpochMs(): number {
  return Date.now();
}

export function floorTimeBucket(epochMs: number, intervalMs: number): number {
  if (!Number.isFinite(epochMs) || epochMs < 0) {
    throw new Error('invalid_epoch_ms');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('invalid_interval_ms');
  }
  return Math.floor(epochMs / intervalMs) * intervalMs;
}

export function formatUtcPartition(epochMs: number): {
  year: string;
  month: string;
  day: string;
  hour: string;
} {
  const date = new Date(epochMs);
  return {
    year: String(date.getUTCFullYear()).padStart(4, '0'),
    month: String(date.getUTCMonth() + 1).padStart(2, '0'),
    day: String(date.getUTCDate()).padStart(2, '0'),
    hour: String(date.getUTCHours()).padStart(2, '0'),
  };
}
