import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserCustomDataFetcher } from '../data-fetcher';
import type { CustomClaimSchema } from '../resolver';

function makeSchema(overrides: Partial<CustomClaimSchema> = {}): CustomClaimSchema {
  return {
    id: 'test-id',
    tenant_id: 'default',
    field_key: 'test_field',
    display_label: 'Test',
    field_type: 'string',
    is_pii: 0,
    is_required: 0,
    is_active: 1,
    validation_rules: null,
    include_in_id_token: 0,
    include_in_userinfo: 0,
    include_in_introspection: 0,
    required_scopes: null,
    scope_mode: 'any',
    is_searchable: 1,
    is_exportable: 1,
    is_vc_claim: 0,
    claim_namespace: null,
    description: null,
    display_order: 0,
    schema_version: 1,
    operation_status: 'active',
    operation_detail: null,
    created_by: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

const mockDb = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  batch: vi.fn(),
  isHealthy: vi.fn(),
  getType: vi.fn().mockReturnValue('mock'),
  close: vi.fn(),
};

const mockPiiDb = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  batch: vi.fn(),
  isHealthy: vi.fn(),
  getType: vi.fn().mockReturnValue('mock'),
  close: vi.fn(),
};

describe('UserCustomDataFetcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.mockResolvedValue([]);
    mockPiiDb.queryOne.mockResolvedValue(null);
  });

  it('fetches non-PII data from user_custom_fields', async () => {
    const schemas = [makeSchema({ field_key: 'department', is_pii: 0 })];
    mockDb.query.mockResolvedValue([{ field_name: 'department', field_value: 'engineering' }]);

    const fetcher = new UserCustomDataFetcher(mockDb as any, null);
    const result = await fetcher.fetch('default', 'user-1', schemas);

    expect(result.get('department')).toBe('engineering');
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('user_custom_fields'), [
      'default',
      'user-1',
      'department',
    ]);
  });

  it('fetches PII data from users_pii', async () => {
    const schemas = [makeSchema({ field_key: 'ssn', is_pii: 1 })];
    mockPiiDb.queryOne.mockResolvedValue({
      custom_attributes_json: JSON.stringify({ ssn: '123-45-6789' }),
    });

    const fetcher = new UserCustomDataFetcher(mockDb as any, mockPiiDb as any);
    const result = await fetcher.fetch('default', 'user-1', schemas);

    expect(result.get('ssn')).toBe('123-45-6789');
  });

  it('handles mixed PII and non-PII schemas', async () => {
    const schemas = [
      makeSchema({ field_key: 'department', is_pii: 0 }),
      makeSchema({ field_key: 'ssn', is_pii: 1 }),
    ];
    mockDb.query.mockResolvedValue([{ field_name: 'department', field_value: 'eng' }]);
    mockPiiDb.queryOne.mockResolvedValue({
      custom_attributes_json: JSON.stringify({ ssn: '999' }),
    });

    const fetcher = new UserCustomDataFetcher(mockDb as any, mockPiiDb as any);
    const result = await fetcher.fetch('default', 'user-1', schemas);

    expect(result.get('department')).toBe('eng');
    expect(result.get('ssn')).toBe('999');
  });

  it('skips PII fetch when no PII DB', async () => {
    const schemas = [makeSchema({ field_key: 'ssn', is_pii: 1 })];

    const fetcher = new UserCustomDataFetcher(mockDb as any, null);
    const result = await fetcher.fetch('default', 'user-1', schemas);

    expect(result.size).toBe(0);
  });

  it('handles PII JSON parse error gracefully', async () => {
    const schemas = [makeSchema({ field_key: 'ssn', is_pii: 1 })];
    mockPiiDb.queryOne.mockResolvedValue({
      custom_attributes_json: 'not-json',
    });

    const fetcher = new UserCustomDataFetcher(mockDb as any, mockPiiDb as any);
    const result = await fetcher.fetch('default', 'user-1', schemas);

    expect(result.size).toBe(0);
  });

  it('skips null field_value entries', async () => {
    const schemas = [makeSchema({ field_key: 'department', is_pii: 0 })];
    mockDb.query.mockResolvedValue([{ field_name: 'department', field_value: null }]);

    const fetcher = new UserCustomDataFetcher(mockDb as any, null);
    const result = await fetcher.fetch('default', 'user-1', schemas);

    expect(result.has('department')).toBe(false);
  });

  it('skips query when no non-PII schemas', async () => {
    const schemas = [makeSchema({ field_key: 'ssn', is_pii: 1 })];

    const fetcher = new UserCustomDataFetcher(mockDb as any, mockPiiDb as any);
    await fetcher.fetch('default', 'user-1', schemas);

    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('handles DB error gracefully for non-PII', async () => {
    const schemas = [makeSchema({ field_key: 'department', is_pii: 0 })];
    mockDb.query.mockRejectedValue(new Error('DB error'));

    const fetcher = new UserCustomDataFetcher(mockDb as any, null);
    const result = await fetcher.fetch('default', 'user-1', schemas);

    expect(result.size).toBe(0);
  });
});
