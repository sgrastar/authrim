import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listRegistrationFieldDefinitions,
  listRegistrationFieldSchemas,
  parseRegistrationFieldDefinitions,
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
        is_pii: 0,
        registration_required: 1,
        registration_order: 2,
        registration_placeholder: 'Engineering',
        validation_rules: '{"min_length":2}',
      },
    ];
    mockAdapter.query.mockResolvedValueOnce(rows);

    await expect(listRegistrationFieldSchemas(mockAdapter as any, 'tenant-1')).resolves.toEqual(rows);
    expect(mockAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('show_on_registration = 1'),
      ['tenant-1']
    );
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
        required: true,
        order: 2,
        placeholder: 'Engineering',
        validation_rules: { min_length: 2 },
      },
      {
        field_key: 'team',
        display_label: 'Team',
        field_type: 'string',
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

    await expect(listRegistrationFieldDefinitions(mockAdapter as any, 'tenant-1')).resolves.toEqual([
      {
        field_key: 'department',
        display_label: 'Department',
        field_type: 'string',
        required: true,
        order: 2,
        placeholder: 'Engineering',
        validation_rules: { min_length: 2 },
      },
    ]);
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
});
