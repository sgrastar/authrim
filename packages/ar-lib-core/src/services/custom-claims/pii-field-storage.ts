export const CUSTOM_ATTRIBUTE_VALUE_KEY_PREFIX = 'custom_attribute:';

export function customAttributeValueKey(fieldKey: string): string {
  return `${CUSTOM_ATTRIBUTE_VALUE_KEY_PREFIX}${fieldKey}`;
}

export function customAttributeSensitiveValueId(userId: string, fieldKey: string): string {
  return `sensitive-value:${userId}:${customAttributeValueKey(fieldKey)}`;
}

export function customAttributeFieldKey(valueKey: string): string | null {
  if (!valueKey.startsWith(CUSTOM_ATTRIBUTE_VALUE_KEY_PREFIX)) return null;
  const fieldKey = valueKey.slice(CUSTOM_ATTRIBUTE_VALUE_KEY_PREFIX.length);
  return fieldKey || null;
}

export function serializeCustomAttributeValue(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

export function deserializeCustomAttributeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (parsed === null || parsed === undefined) return null;
  if (typeof parsed === 'string') return parsed;
  if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed);
  return JSON.stringify(parsed) ?? null;
}
