import type { SettingMeta } from '../types/settings/common';

/**
 * Whether a stored setting value is a whole number inside the range its definition allows.
 * Runtime readers use it to take a value only when the Settings API could have saved it.
 */
export function isWithinSettingRange(value: unknown, meta: SettingMeta): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= (meta.min ?? 0) &&
    value <= (meta.max ?? Number.MAX_SAFE_INTEGER)
  );
}
