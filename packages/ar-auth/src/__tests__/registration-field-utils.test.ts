import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  buildCanonicalProfileRuntimeUserFields,
  isFixedRegistrationFieldKey,
  persistRegistrationFieldValues,
  resolveSubmittedCanonicalProfileFields,
  validateRegistrationFieldSubmission,
} from '../registration-field-utils';

function createMockAdapter(): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  };
}

describe('registration-field-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts canonical profile fields from signup form submissions', () => {
    expect(
      buildCanonicalProfileRuntimeUserFields({
        given_name: ' Yuta ',
        family_name: ' Hoshina ',
      })
    ).toEqual({
      piiFields: {
        given_name: true,
        family_name: true,
      },
      sensitiveValues: {
        given_name: 'Yuta',
        family_name: 'Hoshina',
      },
    });
  });

  it('extracts first and last name aliases as canonical profile fields', () => {
    expect(
      buildCanonicalProfileRuntimeUserFields({
        first_name: 'Yuta',
        last_name: 'Hoshina',
      })
    ).toEqual({
      piiFields: {
        given_name: true,
        family_name: true,
      },
      sensitiveValues: {
        given_name: 'Yuta',
        family_name: 'Hoshina',
      },
    });
  });

  it('normalizes fixed schema keys and ignores unusable canonical profile input', () => {
    expect(isFixedRegistrationFieldKey(' FIELD.CANONICAL.EMAIL ')).toBe(true);
    expect(isFixedRegistrationFieldKey('department')).toBe(false);
    expect(resolveSubmittedCanonicalProfileFields(undefined)).toEqual({});
    expect(
      resolveSubmittedCanonicalProfileFields({ given_name: null, first_name: ' ', last_name: 42 })
    ).toEqual({ family_name: '42' });
    expect(
      buildCanonicalProfileRuntimeUserFields([] as unknown as Record<string, unknown>)
    ).toEqual({
      piiFields: {},
      sensitiveValues: {},
    });
  });

  it('rejects missing required registration fields', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.query).mockResolvedValueOnce([
      {
        field_key: 'department',
        display_label: 'Department',
        field_type: 'string',
        is_pii: 0,
        registration_required: 1,
        validation_rules: null,
      },
    ]);

    const result = await validateRegistrationFieldSubmission(adapter, 'tenant-1', {});

    expect(result).toEqual({
      ok: false,
      error: 'Department is required',
      missingRequiredFields: [
        {
          fieldKey: 'department',
          label: 'Department',
          fieldType: 'string',
        },
      ],
    });
  });

  it('validates required signup base fields from registration schema', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.query).mockResolvedValueOnce([
      {
        field_key: 'field.canonical.name',
        display_label: 'Full Name',
        field_type: 'string',
        is_pii: 1,
        registration_required: 1,
        validation_rules: null,
      },
      {
        field_key: 'field.canonical.email',
        display_label: 'Email',
        field_type: 'string',
        is_pii: 1,
        registration_required: 1,
        validation_rules: null,
      },
    ]);

    const result = await validateRegistrationFieldSubmission(adapter, 'tenant-1', {});

    expect(result).toEqual({
      ok: false,
      error: 'Full Name is required',
      missingRequiredFields: [
        {
          fieldKey: 'field.canonical.name',
          label: 'Full Name',
          fieldType: 'string',
        },
        {
          fieldKey: 'field.canonical.email',
          label: 'Email',
          fieldType: 'string',
        },
      ],
    });
  });

  it('keeps a required canonical email field mandatory for Passkey registration', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.query).mockResolvedValueOnce([
      {
        field_key: 'field.canonical.email',
        display_label: 'Email',
        field_type: 'string',
        is_pii: 1,
        registration_required: 1,
        validation_rules: null,
      },
      {
        field_key: 'department',
        display_label: 'Department',
        field_type: 'string',
        is_pii: 0,
        registration_required: 1,
        validation_rules: null,
      },
    ]);

    const result = await validateRegistrationFieldSubmission(adapter, 'tenant-1', {
      department: 'Platform',
    });

    expect(result).toMatchObject({
      ok: false,
      missingRequiredFields: [
        expect.objectContaining({ fieldKey: 'field.canonical.email' }),
      ],
    });
  });

  it('accepts submitted signup base fields without persisting them as custom fields', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.query).mockResolvedValueOnce([
      {
        field_key: 'field.canonical.name',
        display_label: 'Full Name',
        field_type: 'string',
        is_pii: 1,
        registration_required: 1,
        validation_rules: null,
      },
      {
        field_key: 'field.canonical.email',
        display_label: 'Email',
        field_type: 'string',
        is_pii: 1,
        registration_required: 1,
        validation_rules: null,
      },
    ]);

    const result = await validateRegistrationFieldSubmission(adapter, 'tenant-1', {
      'field.canonical.name': 'Yuta',
      'field.canonical.email': 'yuta@example.com',
    });

    expect(result).toEqual({
      ok: true,
      schemas: expect.any(Array),
      values: {
        'field.canonical.name': 'Yuta',
        'field.canonical.email': 'yuta@example.com',
      },
    });
  });

  it('validates enum/date/number fields and returns sanitized values', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.query).mockResolvedValueOnce([
      {
        field_key: 'team',
        display_label: 'Team',
        field_type: 'enum',
        is_pii: 0,
        registration_required: 1,
        validation_rules: JSON.stringify({ enum_values: ['alpha', 'beta'] }),
      },
      {
        field_key: 'start_date',
        display_label: 'Start Date',
        field_type: 'date',
        is_pii: 0,
        registration_required: 0,
        validation_rules: JSON.stringify({ min_date: '2026-01-01', max_date: '2026-12-31' }),
      },
      {
        field_key: 'level',
        display_label: 'Level',
        field_type: 'number',
        is_pii: 0,
        registration_required: 0,
        validation_rules: JSON.stringify({ min: 1, max: 5 }),
      },
    ]);

    const result = await validateRegistrationFieldSubmission(adapter, 'tenant-1', {
      team: 'beta',
      start_date: '2026-04-21',
      level: '3',
    });

    expect(result).toEqual({
      ok: true,
      schemas: expect.any(Array),
      values: {
        team: 'beta',
        start_date: '2026-04-21',
        level: '3',
      },
    });
  });

  describe('registration field validation boundaries', () => {
    const validate = async (
      fieldType: string,
      validationRules: Record<string, unknown> | string | null,
      value: unknown
    ) => {
      const adapter = createMockAdapter();
      vi.mocked(adapter.query).mockResolvedValueOnce([
        {
          field_key: 'employee_attribute',
          display_label: 'Employee attribute',
          field_type: fieldType,
          is_pii: 0,
          registration_required: 0,
          validation_rules:
            typeof validationRules === 'string'
              ? validationRules
              : validationRules === null
                ? null
                : JSON.stringify(validationRules),
        },
      ]);
      return validateRegistrationFieldSubmission(adapter, 'tenant-1', {
        employee_attribute: value,
      });
    };

    it.each([
      ['boolean', null, true, 'true'],
      ['boolean', null, false, 'false'],
      ['boolean', null, 'true', 'true'],
      ['boolean', null, 'false', 'false'],
      ['number', { min: 1, max: 5 }, ' 3 ', '3'],
      ['enum', { enum_values: ['engineering', 'sales', 42] }, 'sales', 'sales'],
      ['date', { min_date: '2026-01-01', max_date: '2026-12-31' }, '2026-07-13', '2026-07-13'],
      ['string', { min_length: 2, max_length: 8, pattern: '^[A-Z]+$' }, 'DEV', 'DEV'],
      ['unknown-type', null, ' preserved whitespace ', ' preserved whitespace '],
    ] as const)(
      'accepts a valid %s value %# and returns its canonical storage form',
      async (type, rules, input, expected) => {
        const result = await validate(type, rules, input);

        expect(result).toMatchObject({
          ok: true,
          values: { employee_attribute: expected },
        });
      }
    );

    it.each([
      ['boolean', null, 'yes', 'Employee attribute must be true or false'],
      ['number', null, 'not-a-number', 'Employee attribute must be a valid number'],
      ['number', { min: 1 }, '0', 'Employee attribute must be at least 1'],
      ['number', { max: 5 }, '6', 'Employee attribute must be at most 5'],
      [
        'enum',
        { enum_values: ['engineering', 'sales'] },
        'finance',
        'Employee attribute must be one of the configured options',
      ],
      ['date', null, 'not-a-date', 'Employee attribute must be a valid date'],
      [
        'date',
        { min_date: '2026-01-01' },
        '2025-12-31',
        'Employee attribute must be on or after 2026-01-01',
      ],
      [
        'date',
        { max_date: '2026-12-31' },
        '2027-01-01',
        'Employee attribute must be on or before 2026-12-31',
      ],
      ['string', { min_length: 3 }, 'ab', 'Employee attribute must be at least 3 characters'],
      ['string', { max_length: 3 }, 'abcd', 'Employee attribute must be at most 3 characters'],
      ['string', { pattern: '^[A-Z]+$' }, 'abc', 'Employee attribute is in an invalid format'],
    ] as const)('rejects an invalid %s boundary %#', async (type, rules, input, error) => {
      await expect(validate(type, rules, input)).resolves.toEqual({ ok: false, error });
    });

    it.each([
      ['malformed JSON', '{'],
      ['array rules', '["not", "an", "object"]'],
      ['invalid regex accepted by settings', JSON.stringify({ pattern: '[' })],
    ])('fails open only for unusable validation metadata: %s', async (_name, rules) => {
      const result = await validate('string', rules, 'value');

      expect(result).toMatchObject({
        ok: true,
        values: { employee_attribute: 'value' },
      });
    });

    it('ignores blank optional fields and non-object submissions', async () => {
      const adapter = createMockAdapter();
      vi.mocked(adapter.query).mockResolvedValue([
        {
          field_key: 'optional',
          display_label: null,
          field_type: 'string',
          is_pii: 0,
          registration_required: 0,
          validation_rules: null,
        },
      ]);

      await expect(
        validateRegistrationFieldSubmission(adapter, 'tenant-1', { optional: '  ' })
      ).resolves.toMatchObject({ ok: true, values: {} });
      await expect(
        validateRegistrationFieldSubmission(
          adapter,
          'tenant-1',
          [] as unknown as Record<string, unknown>
        )
      ).resolves.toMatchObject({ ok: true, values: {} });
    });

    it('uses the field key as the required-field label when no display label is configured', async () => {
      const adapter = createMockAdapter();
      vi.mocked(adapter.query).mockResolvedValueOnce([
        {
          field_key: 'department',
          display_label: null,
          field_type: 'string',
          is_pii: 0,
          registration_required: 1,
          validation_rules: null,
        },
      ]);

      await expect(validateRegistrationFieldSubmission(adapter, 'tenant-1', {})).resolves.toEqual({
        ok: false,
        error: 'department is required',
        missingRequiredFields: [
          { fieldKey: 'department', label: 'department', fieldType: 'string' },
        ],
      });
    });

    it.each([
      ['enum without options', 'enum', {}, 'anything'],
      ['date with invalid minimum metadata', 'date', { min_date: 'invalid' }, '2026-01-01'],
      ['date with invalid maximum metadata', 'date', { max_date: 'invalid' }, '2026-01-01'],
    ])('ignores non-enforceable validation metadata: %s', async (_name, type, rules, input) => {
      await expect(validate(type, rules, input)).resolves.toMatchObject({ ok: true });
    });
  });

  it('skips persistence for absent values or schemas containing only fixed fields', async () => {
    const adapter = createMockAdapter();

    await persistRegistrationFieldValues(adapter, null, 'tenant-1', 'user-1', undefined);
    expect(adapter.query).not.toHaveBeenCalled();

    vi.mocked(adapter.query).mockResolvedValueOnce([
      {
        field_key: 'field.canonical.email',
        display_label: 'Email',
        field_type: 'string',
        is_pii: 1,
        registration_required: 0,
        validation_rules: null,
      },
    ]);
    await persistRegistrationFieldValues(adapter, null, 'tenant-1', 'user-1', {
      'field.canonical.email': 'person@example.com',
    });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('persists only configured registration field values', async () => {
    const adapter = createMockAdapter();
    vi.mocked(adapter.query).mockResolvedValueOnce([
      {
        field_key: 'department',
        display_label: 'Department',
        field_type: 'string',
        is_pii: 0,
        registration_required: 0,
        validation_rules: null,
      },
    ]);

    await persistRegistrationFieldValues(adapter, null, 'tenant-1', 'user-1', {
      department: 'Sales',
      ignored: 'value',
    });

    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE user_custom_fields SET field_value = ?'),
      ['Sales', 'string', 'tenant-1', 'user-1', 'department']
    );
  });

  it('routes PII registration fields through shared custom-claim persistence', async () => {
    const coreAdapter = createMockAdapter();
    const piiAdapter = createMockAdapter();

    vi.mocked(coreAdapter.query).mockResolvedValueOnce([
      {
        field_key: 'department',
        display_label: 'Department',
        field_type: 'string',
        is_pii: 0,
        registration_required: 0,
        validation_rules: null,
      },
      {
        field_key: 'ssn',
        display_label: 'SSN',
        field_type: 'string',
        is_pii: 1,
        registration_required: 0,
        validation_rules: null,
      },
    ]);
    vi.mocked(piiAdapter.queryOne).mockResolvedValueOnce({
      custom_attributes_json: '{}',
    });

    await persistRegistrationFieldValues(coreAdapter, piiAdapter, 'tenant-1', 'user-1', {
      department: 'Sales',
      ssn: '123-45-6789',
    });

    expect(coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE user_custom_fields SET field_value = ?'),
      ['Sales', 'string', 'tenant-1', 'user-1', 'department']
    );
    expect(piiAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO identity_sensitive_values'),
      [
        'sensitive-value:user-1:custom_attributes_json',
        'tenant-1',
        'user-1',
        JSON.stringify({ ssn: '123-45-6789' }),
        expect.any(Number),
        expect.any(Number),
      ]
    );
  });
});
