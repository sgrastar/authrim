import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_PROFILE_CLAIM_KEYS,
  BUILTIN_PROFILE_CLAIM_SCHEMAS,
  listRegistrationFieldDefinitions,
  listRegistrationFieldSchemas,
  parseRegistrationFieldDefinitions,
  seedBuiltinProfileClaimSchemas,
  seedCustomClaimSchemas,
} from '../schema-catalog';

const mockAdapter = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  batch: vi.fn(),
  isHealthy: vi.fn(),
  getType: vi.fn().mockReturnValue('mock'),
  close: vi.fn(),
};

describe('schema-catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.query.mockResolvedValue([]);
    mockAdapter.queryOne.mockResolvedValue(null);
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
  });

  it('lists registration field schemas through the shared query', async () => {
    const rows = [
      {
        field_key: 'department',
        display_label: 'Department',
        field_type: 'string',
        cardinality: 'single',
        is_pii: 0,
        registration_required: 1,
        registration_order: 2,
        registration_placeholder: 'Engineering',
        validation_rules: '{"min_length":2}',
      },
    ];
    mockAdapter.query.mockResolvedValueOnce(rows);

    await expect(listRegistrationFieldSchemas(mockAdapter as any, 'tenant-1')).resolves.toEqual(
      rows
    );
    expect(mockAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('show_on_registration = TRUE'),
      ['tenant-1']
    );
  });

  it('can include hidden required registration field schemas for submission validation', async () => {
    await listRegistrationFieldSchemas(mockAdapter as any, 'tenant-1', {
      includeRequiredHidden: true,
    });

    expect(mockAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('(show_on_registration = TRUE OR registration_required = TRUE)'),
      ['tenant-1']
    );
  });

  it('normalizes PostgreSQL registration booleans to the shared numeric contract', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        field_key: 'department',
        display_label: 'Department',
        field_type: 'string',
        cardinality: 'single',
        is_pii: true,
        registration_required: false,
        registration_order: 1,
        registration_placeholder: null,
        validation_rules: null,
      },
    ]);

    await expect(listRegistrationFieldSchemas(mockAdapter as any, 'tenant-1')).resolves.toEqual([
      expect.objectContaining({ is_pii: 1, registration_required: 0 }),
    ]);
  });

  it('parses registration field definitions for API consumers', async () => {
    const rows = [
      {
        field_key: 'department',
        display_label: 'Department',
        field_type: 'string',
        is_pii: 0,
        registration_required: 1,
        registration_order: 2,
        registration_placeholder: 'Engineering',
        validation_rules: '{"min_length":2}',
      },
      {
        field_key: 'team',
        display_label: 'Team',
        field_type: 'string',
        cardinality: 'single',
        is_pii: 0,
        registration_required: 0,
        registration_order: 3,
        registration_placeholder: null,
        validation_rules: '{bad-json',
      },
    ];

    expect(parseRegistrationFieldDefinitions(rows)).toEqual([
      {
        field_key: 'department',
        display_label: 'Department',
        field_type: 'string',
        cardinality: 'single',
        required: true,
        order: 2,
        placeholder: 'Engineering',
        validation_rules: { min_length: 2 },
      },
      {
        field_key: 'team',
        display_label: 'Team',
        field_type: 'string',
        cardinality: 'single',
        required: false,
        order: 3,
        placeholder: null,
        validation_rules: null,
      },
    ]);
  });

  it('lists parsed registration field definitions from the shared query helper', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        field_key: 'department',
        display_label: 'Department',
        field_type: 'string',
        is_pii: 0,
        registration_required: 1,
        registration_order: 2,
        registration_placeholder: 'Engineering',
        validation_rules: '{"min_length":2}',
      },
    ]);

    await expect(listRegistrationFieldDefinitions(mockAdapter as any, 'tenant-1')).resolves.toEqual(
      [
        {
          field_key: 'department',
          display_label: 'Department',
          field_type: 'string',
          cardinality: 'single',
          required: true,
          order: 2,
          placeholder: 'Engineering',
          validation_rules: { min_length: 2 },
        },
      ]
    );
  });

  it('seeds only missing custom claim schemas', async () => {
    mockAdapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'existing-id' });

    const created = await seedCustomClaimSchemas({
      db: mockAdapter as any,
      tenantId: 'tenant-1',
      schemas: [
        {
          field_key: 'department',
          display_label: 'Department',
          field_type: 'string',
          is_pii: 0,
          is_searchable: 1,
          is_exportable: 1,
          display_order: 10,
        },
        {
          field_key: 'team',
          display_label: 'Team',
          field_type: 'string',
          is_pii: 0,
          is_searchable: 1,
          is_exportable: 1,
          display_order: 20,
        },
      ],
      now: 1700000000,
      idFactory: () => 'generated-id',
    });

    expect(created).toBe(1);
    expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO custom_claim_schemas'),
      expect.arrayContaining(['generated-id', 'tenant-1', 'department', 'Department'])
    );
  });

  it('defines exactly eight optional built-in profile fields', () => {
    expect(BUILTIN_PROFILE_CLAIM_SCHEMAS.map((schema) => schema.field_key).sort()).toEqual(
      [...BUILTIN_PROFILE_CLAIM_KEYS].sort()
    );
    expect(BUILTIN_PROFILE_CLAIM_SCHEMAS).toHaveLength(8);
    expect(BUILTIN_PROFILE_CLAIM_SCHEMAS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field_key: 'email', field_type: 'string' }),
        expect.objectContaining({ field_key: 'email_verified', field_type: 'boolean' }),
        expect.objectContaining({ field_key: 'picture_url', field_type: 'string' }),
      ])
    );
    for (const schema of BUILTIN_PROFILE_CLAIM_SCHEMAS) {
      expect(schema.is_required ?? 0).toBe(0);
    }
  });

  it('seeds deterministic system schemas for each tenant', async () => {
    const created = await seedBuiltinProfileClaimSchemas({
      db: mockAdapter as any,
      tenantId: 'tenant-1',
      now: 1700000000,
    });

    expect(created).toBe(8);
    expect(mockAdapter.execute).toHaveBeenCalledTimes(8);
    const params = mockAdapter.execute.mock.calls.map((call) => call[1] as unknown[]);
    expect(params.map((values) => values[2]).sort()).toEqual(
      [...BUILTIN_PROFILE_CLAIM_KEYS].sort()
    );
    for (const values of params) {
      expect(values[0]).toBe(`builtin:tenant-1:${String(values[2])}`);
      expect(values[1]).toBe('tenant-1');
      expect(values[3]).toBe(values[2]);
      expect(values[8]).toBe(0);
      expect(values[9]).toBe(1);
    }
  });

  it('uses native boolean parameters and portable boolean literals for PostgreSQL', async () => {
    mockAdapter.getType.mockReturnValueOnce('postgres');

    await seedCustomClaimSchemas({
      db: mockAdapter as any,
      tenantId: 'tenant-1',
      schemas: [BUILTIN_PROFILE_CLAIM_SCHEMAS[0]],
      idFactory: () => 'generated-id',
    });

    const [sql, values] = mockAdapter.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('TRUE');
    expect(sql).toContain('FALSE');
    expect(values[7]).toBe(true);
    expect(values[8]).toBe(false);
    expect(values[9]).toBe(true);
    expect(values[10]).toBe(true);
    expect(values[11]).toBe(true);
  });
});
