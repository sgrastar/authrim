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
  cast(rawValue: string | null | undefined, fieldType: string): CastResult {
    if (rawValue === null || rawValue === undefined) {
      return { value: undefined, valid: false };
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
