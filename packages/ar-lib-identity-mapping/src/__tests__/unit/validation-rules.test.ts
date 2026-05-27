import { describe, expect, it } from 'vitest';
import { validateMappingInput } from '../../core/validation';
import { mappingInput, sourceValue } from '../../test-support';

describe('validation rules', () => {
  it('validates type, enum, format, and cardinality rules', () => {
    const input = mappingInput([sourceValue('csv', 'email', ['bad-email'], 'pii')]);
    const result = validateMappingInput({
      ...input,
      validationRules: [
        {
          id: 'validation.email.type',
          kind: 'type',
          targetRef: { side: 'inbound', namespace: 'csv', path: 'email' },
          parameters: { valueType: 'string' },
        },
        {
          id: 'validation.email.enum',
          kind: 'enum',
          targetRef: { side: 'inbound', namespace: 'csv', path: 'email' },
          parameters: { allowedValues: ['user@example.test'] },
        },
        {
          id: 'validation.email.cardinality',
          kind: 'cardinality',
          targetRef: { side: 'inbound', namespace: 'csv', path: 'email' },
          parameters: { cardinality: 'single' },
        },
      ],
    });

    expect(result.reasons.map((item) => item.code)).toEqual([
      'validation.cardinality_mismatch',
      'validation.value_not_allowed',
      'validation.cardinality_mismatch',
    ]);
  });

  it('validates format rules', () => {
    const result = validateMappingInput({
      ...mappingInput([sourceValue('csv', 'email', 'not-an-email', 'pii')]),
      validationRules: [
        {
          id: 'validation.email.format',
          kind: 'format',
          targetRef: { side: 'inbound', namespace: 'csv', path: 'email' },
          parameters: { format: 'email' },
        },
      ],
    });

    expect(result.reasons.map((item) => item.code)).toContain('validation.format_mismatch');
  });
});
