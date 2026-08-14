/**
 * Claim Value Caster
 *
 * Casts raw string values from user_custom_fields / canonical sensitive values
 * to the appropriate type based on the schema's field_type.
 */

export interface CastResult {
  value: unknown;
  valid: boolean;
}

export class ClaimValueCaster {
  cast(
    rawValue: string | null | undefined,
    fieldType: string,
    cardinality: 'single' | 'multi' = 'single'
  ): CastResult {
    if (rawValue === null || rawValue === undefined) {
      return { value: undefined, valid: false };
    }

    if (cardinality === 'multi') {
      let values: unknown;
      try {
        values = JSON.parse(rawValue);
      } catch {
        return { value: undefined, valid: false };
      }
      if (!Array.isArray(values)) {
        return { value: undefined, valid: false };
      }
      const castValues: unknown[] = [];
      for (const value of values) {
        if (value === null || typeof value === 'object') {
          return { value: undefined, valid: false };
        }
        const cast = this.cast(String(value), fieldType, 'single');
        if (!cast.valid) return { value: undefined, valid: false };
        castValues.push(cast.value);
      }
      return { value: castValues, valid: true };
    }

    switch (fieldType) {
      case 'number': {
        const n = Number(rawValue);
        if (!Number.isFinite(n)) {
          return { value: undefined, valid: false };
        }
        return { value: n, valid: true };
      }
      case 'boolean':
        return { value: rawValue === 'true' || rawValue === '1', valid: true };
      case 'date':
        return { value: rawValue, valid: true };
      case 'string':
      case 'enum':
      default:
        return { value: rawValue, valid: true };
    }
  }
}
