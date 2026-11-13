import { beforeEach, describe, expect, it, vi } from 'vitest';

const findById = vi.fn();
vi.mock('../../repositories/identity/canonical-runtime-user-store', () => ({
  CanonicalRuntimeUserStore: class {
    findById(...args: unknown[]) {
      return findById(...args) as unknown;
    }
  },
}));

import { customAttributeValueKey } from '../custom-claims/pii-field-storage';
import { loadFlowConditionUserAttributes } from '../flow-condition-user-attributes';

function adapter(type: 'd1' | 'postgres', rows: (sql: string) => unknown[]) {
  return {
    query: vi.fn(async (sql: string) => rows(sql)),
    queryOne: vi.fn(),
    execute: vi.fn(),
    batch: vi.fn(),
    transaction: vi.fn(),
    isHealthy: vi.fn(),
    getType: () => type,
    close: vi.fn(),
  };
}

describe('loadFlowConditionUserAttributes', () => {
  beforeEach(() => findById.mockReset());

  it('reads only the profile claims asked for', async () => {
    findById.mockResolvedValue({
      birthdate: '2010-01-01',
      address_json: JSON.stringify({ country: 'US', region: 'CA' }),
    });
    const schema = adapter('d1', () => []);
    const attributes = await loadFlowConditionUserAttributes(
      {
        schemaDb: schema,
        nonPiiDb: adapter('d1', () => []),
        piiDb: adapter('d1', () => []),
      } as never,
      'tenant_1',
      'user_1',
      ['birthdate', 'address.country']
    );
    expect(attributes).toEqual({ birthdate: '2010-01-01', 'address.country': 'US' });
    expect(findById).toHaveBeenCalledWith('user_1', { claimNames: ['birthdate', 'address'] });
    // No custom attribute asked for: the schemas are not read.
    expect(schema.query).not.toHaveBeenCalled();
  });

  it('reads custom attributes by key, PII as JSON text on PostgreSQL', async () => {
    const schema = adapter('postgres', () => [
      { field_key: 'Nationality', is_pii: 1 },
      { field_key: 'plan', is_pii: 0, cardinality: 'multi' },
    ]);
    const nonPii = adapter('postgres', () => [{ field_name: 'plan', field_value: '["a","b"]' }]);
    const pii = adapter('postgres', () => [
      { value_key: customAttributeValueKey('Nationality'), value_json: '"JP"' },
    ]);
    const attributes = await loadFlowConditionUserAttributes(
      { schemaDb: schema, nonPiiDb: nonPii, piiDb: pii } as never,
      'tenant_1',
      'user_1',
      ['nationality', 'plan', 'unknown']
    );
    expect(String(schema.query.mock.calls[0]?.[0])).toContain('is_active = TRUE');
    expect(String(pii.query.mock.calls[0]?.[0])).toContain('value_json::text AS value_json');
    expect(findById).not.toHaveBeenCalled();
    expect(attributes).toEqual({ nationality: 'JP', plan: ['a', 'b'] });
  });

  it('keeps a single value as stored, and is not fooled by an inherited key', async () => {
    const schema = adapter('d1', () => [
      { field_key: 'note', is_pii: 0, cardinality: 'single' },
      { field_key: 'constructor', is_pii: 0 },
    ]);
    const nonPii = adapter('d1', () => [{ field_name: 'note', field_value: '["a"]' }]);
    const attributes = await loadFlowConditionUserAttributes(
      { schemaDb: schema, nonPiiDb: nonPii, piiDb: adapter('d1', () => []) } as never,
      'tenant_1',
      'user_1',
      ['note', 'constructor']
    );
    expect(attributes.note).toBe('["a"]');
    expect(attributes.constructor).toBeUndefined();
  });

  it('refuses an attribute being renamed', async () => {
    const schema = adapter('d1', () => [
      { field_key: 'plan', is_pii: 0, operation_status: 'renaming' },
    ]);
    await expect(
      loadFlowConditionUserAttributes(
        {
          schemaDb: schema,
          nonPiiDb: adapter('d1', () => []),
          piiDb: adapter('d1', () => []),
        } as never,
        'tenant_1',
        'user_1',
        ['plan']
      )
    ).rejects.toThrow('custom_attribute_not_readable');
  });

  it('refuses what was read when a rename began meanwhile', async () => {
    let reads = 0;
    const schema = adapter('d1', () => [
      {
        id: 's1',
        field_key: 'plan',
        is_pii: 0,
        operation_status: reads++ === 0 ? 'active' : 'renaming',
      },
    ]);
    await expect(
      loadFlowConditionUserAttributes(
        {
          schemaDb: schema,
          nonPiiDb: adapter('d1', () => []),
          piiDb: adapter('d1', () => []),
        } as never,
        'tenant_1',
        'user_1',
        ['plan']
      )
    ).rejects.toThrow('custom_attribute_not_readable');
  });

  it('throws when a value cannot be read, rather than leaving it out', async () => {
    const schema = adapter('d1', () => [{ field_key: 'plan', is_pii: 0 }]);
    const nonPii = {
      ...adapter('d1', () => []),
      query: vi.fn(async () => {
        throw new Error('down');
      }),
    };
    await expect(
      loadFlowConditionUserAttributes(
        { schemaDb: schema, nonPiiDb: nonPii, piiDb: adapter('d1', () => []) } as never,
        'tenant_1',
        'user_1',
        ['plan']
      )
    ).rejects.toThrow('down');
  });
});
