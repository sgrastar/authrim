import { describe, expect, it } from 'vitest';
import { validateMappingInput } from '../../core/validation';
import { edge, fieldRef, mappingInput, sourceValue } from '../../test-support';

describe('validation rules', () => {
  it('validates type, enum, format, and cardinality rules', () => {
    const input = mappingInput([sourceValue('csv', 'email', ['bad-email'], 'pii')]);
    const result = validateMappingInput({
      ...input,
      validationRules: [
        {
          id: 'validation.email.type',
          kind: 'type',
          targetRef: { side: 'source', namespace: 'csv', path: 'email' },
          parameters: { valueType: 'string' },
        },
        {
          id: 'validation.email.enum',
          kind: 'enum',
          targetRef: { side: 'source', namespace: 'csv', path: 'email' },
          parameters: { allowedValues: ['user@example.test'] },
        },
        {
          id: 'validation.email.cardinality',
          kind: 'cardinality',
          targetRef: { side: 'source', namespace: 'csv', path: 'email' },
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
          targetRef: { side: 'source', namespace: 'csv', path: 'email' },
          parameters: { format: 'email' },
        },
      ],
    });

    expect(result.reasons.map((item) => item.code)).toContain('validation.format_mismatch');
  });

  it('validates JSON value type without treating plain text as JSON', () => {
    const jsonInput = mappingInput([
      sourceValue('csv', 'email', { locale: 'ja', active: true }, 'internal'),
    ]);
    const textInput = mappingInput([sourceValue('csv', 'email', 'not json', 'internal')]);
    const jsonCatalog = {
      ...jsonInput.catalog,
      entries: jsonInput.catalog.entries.map((entry) =>
        entry.namespace === 'csv' && entry.path === 'email'
          ? { ...entry, valueType: 'json' }
          : entry
      ),
    };
    const valid = validateMappingInput({
      ...jsonInput,
      catalog: jsonCatalog,
      validationRules: [
        {
          id: 'validation.profile.json',
          kind: 'type',
          targetRef: { side: 'source', namespace: 'csv', path: 'email' },
          parameters: { valueType: 'json' },
        },
      ],
    });
    const invalid = validateMappingInput({
      ...textInput,
      catalog: jsonCatalog,
      validationRules: [
        {
          id: 'validation.profile.json',
          kind: 'type',
          targetRef: { side: 'source', namespace: 'csv', path: 'email' },
          parameters: { valueType: 'json' },
        },
      ],
    });

    expect(valid.reasons.map((item) => item.code)).not.toContain('validation.type_mismatch');
    expect(invalid.reasons.map((item) => item.code)).toContain('validation.type_mismatch');
  });

  it('validates email format without regex backtracking exposure', () => {
    const valid = validateMappingInput({
      ...mappingInput([sourceValue('csv', 'email', 'user@example.test', 'pii')]),
      validationRules: [
        {
          id: 'validation.email.format',
          kind: 'format',
          targetRef: { side: 'source', namespace: 'csv', path: 'email' },
          parameters: { format: 'email' },
        },
      ],
    });
    const pathological = validateMappingInput({
      ...mappingInput([sourceValue('csv', 'email', `!@!.${'!.'.repeat(20_000)}`, 'pii')]),
      validationRules: [
        {
          id: 'validation.email.format',
          kind: 'format',
          targetRef: { side: 'source', namespace: 'csv', path: 'email' },
          parameters: { format: 'email' },
        },
      ],
    });

    expect(valid.reasons.map((item) => item.code)).not.toContain('validation.format_mismatch');
    expect(pathological.reasons.map((item) => item.code)).toContain('validation.format_mismatch');
  });

  it('rejects unknown source values and edge source references', () => {
    const input = mappingInput([
      sourceValue('csv', 'email', 'user@example.test', 'pii'),
      sourceValue('csv', 'unknownColumn', 'ignored', 'internal'),
    ]);

    const result = validateMappingInput({
      ...input,
      edges: [
        ...input.edges,
        edge(fieldRef('csv', 'unknownColumn'), {
          side: 'canonical',
          namespace: 'authrim.profile',
          path: 'email',
          catalogEntryId: 'field.canonical.email',
        }),
      ],
    });

    expect(result.reasons.map((item) => item.code)).toEqual([
      'catalog.invalid_entry',
      'catalog.invalid_entry',
    ]);
  });
});
