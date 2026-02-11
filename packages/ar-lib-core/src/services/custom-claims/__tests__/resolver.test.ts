import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomClaimSchemaResolver, loadFeatureConfig, type CustomClaimSchema } from '../resolver';
import { SchemaLoader } from '../schema-loader';
import { ClaimScopeEvaluator } from '../scope-evaluator';
import { UserCustomDataFetcher } from '../data-fetcher';
import { ClaimValueCaster } from '../value-caster';
import { ClaimNameResolver } from '../name-resolver';

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
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  all: vi.fn(),
  first: vi.fn(),
};

const mockPiiDb = {
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  all: vi.fn(),
  first: vi.fn(),
};

const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

function createResolver(maxClaimsPerTarget = 50): CustomClaimSchemaResolver {
  return new CustomClaimSchemaResolver({
    schemaLoader: new SchemaLoader(mockDb as any, mockKV as any),
    scopeEvaluator: new ClaimScopeEvaluator(),
    dataFetcher: new UserCustomDataFetcher(mockDb as any, mockPiiDb as any),
    valueCaster: new ClaimValueCaster(),
    nameResolver: new ClaimNameResolver(),
    maxClaimsPerTarget,
  });
}

describe('CustomClaimSchemaResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.all.mockResolvedValue({ results: [] });
    mockPiiDb.first.mockResolvedValue(null);
    mockKV.get.mockResolvedValue(null);
  });

  it('returns empty claims when no schemas', async () => {
    const resolver = createResolver();
    const result = await resolver.resolveClaimsForTarget(
      'default',
      'user-1',
      ['openid'],
      'id_token'
    );
    expect(result.claims).toEqual({});
    expect(result.schemas_evaluated).toBe(0);
  });

  it('filters by id_token target', async () => {
    const schemas = [
      makeSchema({ id: '1', field_key: 'dept', include_in_id_token: 1 }),
      makeSchema({ id: '2', field_key: 'ssn', include_in_id_token: 0 }),
    ];
    // SchemaLoader returns all active schemas
    mockKV.get.mockResolvedValue(
      JSON.stringify({ schemas, fetched_at: Date.now(), schema_version_max: 1 })
    );
    // DataFetcher: non-PII data
    mockDb.all.mockResolvedValue({
      results: [{ field_name: 'dept', field_value: 'engineering' }],
    });

    const resolver = createResolver();
    const result = await resolver.resolveClaimsForTarget('default', 'user-1', [], 'id_token');

    expect(result.claims).toEqual({ dept: 'engineering' });
    expect(result.schemas_evaluated).toBe(2);
    expect(result.schemas_matched).toBe(1);
  });

  it('filters by userinfo target', async () => {
    const schemas = [
      makeSchema({ id: '1', field_key: 'dept', include_in_userinfo: 1 }),
      makeSchema({ id: '2', field_key: 'level', include_in_userinfo: 0 }),
    ];
    mockKV.get.mockResolvedValue(
      JSON.stringify({ schemas, fetched_at: Date.now(), schema_version_max: 1 })
    );
    mockDb.all.mockResolvedValue({
      results: [{ field_name: 'dept', field_value: 'sales' }],
    });

    const resolver = createResolver();
    const result = await resolver.resolveClaimsForTarget('default', 'user-1', [], 'userinfo');

    expect(result.claims).toEqual({ dept: 'sales' });
  });

  it('filters by vc target', async () => {
    const schemas = [
      makeSchema({ id: '1', field_key: 'dept', is_vc_claim: 1 }),
      makeSchema({ id: '2', field_key: 'level', is_vc_claim: 0 }),
    ];
    mockKV.get.mockResolvedValue(
      JSON.stringify({ schemas, fetched_at: Date.now(), schema_version_max: 1 })
    );
    mockDb.all.mockResolvedValue({
      results: [{ field_name: 'dept', field_value: 'engineering' }],
    });

    const resolver = createResolver();
    const result = await resolver.resolveClaimsForTarget('default', 'user-1', [], 'vc');

    expect(result.claims).toEqual({ dept: 'engineering' });
  });

  it('applies scope filtering', async () => {
    const schemas = [
      makeSchema({
        id: '1',
        field_key: 'dept',
        include_in_id_token: 1,
        required_scopes: '["custom:hr"]',
        scope_mode: 'any',
      }),
    ];
    mockKV.get.mockResolvedValue(
      JSON.stringify({ schemas, fetched_at: Date.now(), schema_version_max: 1 })
    );

    const resolver = createResolver();

    // Without required scope
    let result = await resolver.resolveClaimsForTarget('default', 'user-1', ['openid'], 'id_token');
    expect(result.schemas_matched).toBe(0);

    // With required scope
    result = await resolver.resolveClaimsForTarget(
      'default',
      'user-1',
      ['openid', 'custom:hr'],
      'id_token'
    );
    expect(result.schemas_matched).toBe(1);
  });

  it('applies claim_namespace', async () => {
    const schemas = [
      makeSchema({
        id: '1',
        field_key: 'role',
        include_in_id_token: 1,
        claim_namespace: 'https://example.com/',
      }),
    ];
    mockKV.get.mockResolvedValue(
      JSON.stringify({ schemas, fetched_at: Date.now(), schema_version_max: 1 })
    );
    mockDb.all.mockResolvedValue({
      results: [{ field_name: 'role', field_value: 'admin' }],
    });

    const resolver = createResolver();
    const result = await resolver.resolveClaimsForTarget('default', 'user-1', [], 'id_token');

    expect(result.claims).toEqual({ 'https://example.com/role': 'admin' });
  });

  it('skips standard claim collisions', async () => {
    const schemas = [
      makeSchema({
        id: '1',
        field_key: 'email',
        include_in_id_token: 1,
        claim_namespace: null,
      }),
    ];
    mockKV.get.mockResolvedValue(
      JSON.stringify({ schemas, fetched_at: Date.now(), schema_version_max: 1 })
    );
    mockDb.all.mockResolvedValue({
      results: [{ field_name: 'email', field_value: 'test@example.com' }],
    });

    const resolver = createResolver();
    const result = await resolver.resolveClaimsForTarget('default', 'user-1', [], 'id_token');

    expect(result.claims).toEqual({});
  });

  it('casts number values', async () => {
    const schemas = [
      makeSchema({
        id: '1',
        field_key: 'employee_number',
        field_type: 'number',
        include_in_id_token: 1,
      }),
    ];
    mockKV.get.mockResolvedValue(
      JSON.stringify({ schemas, fetched_at: Date.now(), schema_version_max: 1 })
    );
    mockDb.all.mockResolvedValue({
      results: [{ field_name: 'employee_number', field_value: '42' }],
    });

    const resolver = createResolver();
    const result = await resolver.resolveClaimsForTarget('default', 'user-1', [], 'id_token');

    expect(result.claims).toEqual({ employee_number: 42 });
  });

  it('drops invalid number casts', async () => {
    const schemas = [
      makeSchema({
        id: '1',
        field_key: 'bad_number',
        field_type: 'number',
        include_in_id_token: 1,
      }),
    ];
    mockKV.get.mockResolvedValue(
      JSON.stringify({ schemas, fetched_at: Date.now(), schema_version_max: 1 })
    );
    mockDb.all.mockResolvedValue({
      results: [{ field_name: 'bad_number', field_value: 'not-a-number' }],
    });

    const resolver = createResolver();
    const result = await resolver.resolveClaimsForTarget('default', 'user-1', [], 'id_token');

    expect(result.claims).toEqual({});
  });

  it('truncates when exceeding maxClaimsPerTarget', async () => {
    const schemas = Array.from({ length: 5 }, (_, i) =>
      makeSchema({
        id: `${i}`,
        field_key: `field_${i}`,
        include_in_id_token: 1,
        display_order: i,
      })
    );
    mockKV.get.mockResolvedValue(
      JSON.stringify({ schemas, fetched_at: Date.now(), schema_version_max: 1 })
    );
    mockDb.all.mockResolvedValue({
      results: schemas.map((s) => ({ field_name: s.field_key, field_value: 'val' })),
    });

    const resolver = createResolver(3); // max 3
    const result = await resolver.resolveClaimsForTarget('default', 'user-1', [], 'id_token');

    expect(Object.keys(result.claims)).toHaveLength(3);
    expect(result.truncated).toBe(true);
    // Should keep first 3 (lowest display_order)
    expect(result.claims).toHaveProperty('field_0');
    expect(result.claims).toHaveProperty('field_1');
    expect(result.claims).toHaveProperty('field_2');
    expect(result.claims).not.toHaveProperty('field_3');
  });

  it('sets pii_accessed when PII schemas are matched', async () => {
    const schemas = [makeSchema({ id: '1', field_key: 'ssn', is_pii: 1, include_in_userinfo: 1 })];
    mockKV.get.mockResolvedValue(
      JSON.stringify({ schemas, fetched_at: Date.now(), schema_version_max: 1 })
    );
    mockPiiDb.first.mockResolvedValue({
      custom_attributes_json: JSON.stringify({ ssn: '123' }),
    });

    const resolver = createResolver();
    const result = await resolver.resolveClaimsForTarget('default', 'user-1', [], 'userinfo');

    expect(result.pii_accessed).toBe(true);
    expect(result.claims).toEqual({ ssn: '123' });
  });

  describe('integration scenario', () => {
    it('handles mixed non-PII + PII, scopes, namespace, collision, and invalid cast', async () => {
      const schemas = [
        // Non-PII, no scope, id_token: should include
        makeSchema({
          id: '1',
          field_key: 'department',
          include_in_id_token: 1,
          display_order: 0,
        }),
        // PII, id_token + userinfo: should include in id_token
        makeSchema({
          id: '2',
          field_key: 'tax_id',
          is_pii: 1,
          include_in_id_token: 1,
          include_in_userinfo: 1,
          display_order: 1,
        }),
        // Scope required (all mode), id_token
        makeSchema({
          id: '3',
          field_key: 'salary_grade',
          include_in_id_token: 1,
          required_scopes: '["hr","finance"]',
          scope_mode: 'all',
          display_order: 2,
        }),
        // Scope required (any mode), id_token
        makeSchema({
          id: '4',
          field_key: 'badge_level',
          include_in_id_token: 1,
          required_scopes: '["hr","security"]',
          scope_mode: 'any',
          display_order: 3,
        }),
        // Namespace collision with standard claim → should be skipped
        makeSchema({
          id: '5',
          field_key: 'email',
          include_in_id_token: 1,
          claim_namespace: null,
          display_order: 4,
        }),
        // Number field with invalid value → should be dropped
        makeSchema({
          id: '6',
          field_key: 'bad_metric',
          field_type: 'number',
          include_in_id_token: 1,
          display_order: 5,
        }),
        // Namespaced claim: no collision
        makeSchema({
          id: '7',
          field_key: 'email',
          include_in_id_token: 1,
          claim_namespace: 'ext:',
          display_order: 6,
        }),
        // userinfo only: not in id_token
        makeSchema({
          id: '8',
          field_key: 'only_userinfo',
          include_in_id_token: 0,
          include_in_userinfo: 1,
          display_order: 7,
        }),
      ];

      mockKV.get.mockResolvedValue(
        JSON.stringify({ schemas, fetched_at: Date.now(), schema_version_max: 1 })
      );

      // Non-PII data
      mockDb.all.mockResolvedValue({
        results: [
          { field_name: 'department', field_value: 'engineering' },
          { field_name: 'salary_grade', field_value: 'L5' },
          { field_name: 'badge_level', field_value: 'gold' },
          { field_name: 'email', field_value: 'custom@test.com' },
          { field_name: 'bad_metric', field_value: 'NaN' },
        ],
      });

      // PII data
      mockPiiDb.first.mockResolvedValue({
        custom_attributes_json: JSON.stringify({ tax_id: 'TX-123' }),
      });

      const resolver = createResolver();
      const result = await resolver.resolveClaimsForTarget(
        'default',
        'user-1',
        ['openid', 'hr', 'finance'],
        'id_token'
      );

      // Expected:
      // department → included (no scope restriction)
      // tax_id → included (PII, no scope restriction)
      // salary_grade → included (all scopes met: hr + finance)
      // badge_level → included (any scope met: hr)
      // email (no namespace) → SKIPPED (standard claim collision)
      // bad_metric → DROPPED (invalid number cast)
      // ext:email → included (namespace prevents collision)
      // only_userinfo → NOT in id_token target
      expect(result.claims).toEqual({
        department: 'engineering',
        tax_id: 'TX-123',
        salary_grade: 'L5',
        badge_level: 'gold',
        'ext:email': 'custom@test.com',
      });
      expect(result.schemas_evaluated).toBe(8);
      expect(result.pii_accessed).toBe(true);
      expect(result.truncated).toBe(false);
    });
  });
});

describe('loadFeatureConfig', () => {
  it('returns disabled when cache is null', async () => {
    const config = await loadFeatureConfig(null);
    expect(config.enabled).toBe(false);
    expect(config.introspectionEnabled).toBe(false);
    expect(config.maxClaimsPerTarget).toBe(50);
  });

  it('reads values from KV', async () => {
    const kv = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'custom_claims.enabled') return 'true';
        if (key === 'custom_claims.introspection_enabled') return 'true';
        if (key === 'custom_claims.max_claims_per_token') return '30';
        return null;
      }),
    };

    const config = await loadFeatureConfig(kv as any);
    expect(config.enabled).toBe(true);
    expect(config.introspectionEnabled).toBe(true);
    expect(config.maxClaimsPerTarget).toBe(30);
  });

  it('handles KV errors gracefully', async () => {
    const kv = {
      get: vi.fn().mockRejectedValue(new Error('KV error')),
    };

    const config = await loadFeatureConfig(kv as any);
    expect(config.enabled).toBe(false);
  });
});
