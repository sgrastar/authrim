import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  persistRegistrationFieldValues,
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
      expect.stringContaining('UPDATE users_pii SET custom_attributes_json = ?'),
      [JSON.stringify({ ssn: '123-45-6789' }), expect.any(Number), 'user-1', 'tenant-1']
    );
  });
});
