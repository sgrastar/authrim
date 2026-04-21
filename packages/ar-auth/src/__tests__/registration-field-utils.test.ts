import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  persistRegistrationFieldValues,
  validateRegistrationFieldSubmission,
} from '../registration-field-utils';

const mockAdapterQuery = vi.fn();

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    D1Adapter: vi.fn().mockImplementation(function MockD1Adapter() {
      return {
        query: mockAdapterQuery,
      };
    }),
  };
});

function createMockDb() {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
  };

  return {
    prepare: vi.fn().mockReturnValue(statement),
    _statement: statement,
  } as unknown as D1Database & { _statement: typeof statement };
}

describe('registration-field-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects missing required registration fields', async () => {
    mockAdapterQuery.mockResolvedValueOnce([
      {
        field_key: 'department',
        display_label: 'Department',
        field_type: 'string',
        registration_required: 1,
        validation_rules: null,
      },
    ]);

    const result = await validateRegistrationFieldSubmission({} as D1Database, 'tenant-1', {});

    expect(result).toEqual({
      ok: false,
      error: 'Department is required',
    });
  });

  it('validates enum/date/number fields and returns sanitized values', async () => {
    mockAdapterQuery.mockResolvedValueOnce([
      {
        field_key: 'team',
        display_label: 'Team',
        field_type: 'enum',
        registration_required: 1,
        validation_rules: JSON.stringify({ enum_values: ['alpha', 'beta'] }),
      },
      {
        field_key: 'start_date',
        display_label: 'Start Date',
        field_type: 'date',
        registration_required: 0,
        validation_rules: JSON.stringify({ min_date: '2026-01-01', max_date: '2026-12-31' }),
      },
      {
        field_key: 'level',
        display_label: 'Level',
        field_type: 'number',
        registration_required: 0,
        validation_rules: JSON.stringify({ min: 1, max: 5 }),
      },
    ]);

    const result = await validateRegistrationFieldSubmission({} as D1Database, 'tenant-1', {
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
    const db = createMockDb();
    mockAdapterQuery.mockResolvedValueOnce([
      {
        field_key: 'department',
        display_label: 'Department',
        field_type: 'string',
        registration_required: 0,
        validation_rules: null,
      },
    ]);

    await persistRegistrationFieldValues(db, 'tenant-1', 'user-1', {
      department: 'Sales',
      ignored: 'value',
    });

    expect(db.prepare).toHaveBeenCalledTimes(1);
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_custom_fields')
    );
    expect(db._statement.bind).toHaveBeenCalledWith(
      expect.any(String),
      'user-1',
      'tenant-1',
      'department',
      'Sales',
      expect.any(Number),
      expect.any(Number)
    );
    expect(db._statement.run).toHaveBeenCalledTimes(1);
  });
});
