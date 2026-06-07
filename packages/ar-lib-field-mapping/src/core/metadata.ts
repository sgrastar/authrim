import type { SafeMetadataKey, SafeMetadataValue } from './types';

export const SAFE_METADATA_KEYS: SafeMetadataKey[] = [
  'sourceType',
  'sourceId',
  'fieldPath',
  'rowIndex',
  'columnName',
  'recordIndex',
  'catalogEntryId',
  'ruleId',
  'edgeId',
  'scimPath',
  'samlAttributeName',
  'samlNameFormat',
  'oidcClaimName',
  'csvHeaderName',
];

const safeMetadataKeySet = new Set<string>(SAFE_METADATA_KEYS);

export function isSafeMetadataKey(key: string): key is SafeMetadataKey {
  return safeMetadataKeySet.has(key);
}

export function isSafeMetadataValue(value: unknown): value is SafeMetadataValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function filterSafeMetadata(
  metadata?: Record<string, unknown>
): Partial<Record<SafeMetadataKey, SafeMetadataValue>> {
  if (!metadata) {
    return {};
  }

  const safe: Partial<Record<SafeMetadataKey, SafeMetadataValue>> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isSafeMetadataKey(key) && isSafeMetadataValue(value)) {
      safe[key] = value;
    }
  }
  return safe;
}

export function findUnsafeMetadata(metadata?: Record<string, unknown>): string[] {
  if (!metadata) {
    return [];
  }
  return Object.entries(metadata)
    .filter(([key, value]) => !isSafeMetadataKey(key) || !isSafeMetadataValue(value))
    .map(([key]) => key);
}
