import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { syncUserLifecycleState } from '../user-lifecycle';
import type { CustomClaimSchema } from '../resolver';

function makeSchema(overrides: Partial<CustomClaimSchema> = {}): CustomClaimSchema {
  return {
    id: 'schema-1',
    tenant_id: 'default',
    field_key: 'department',
    display_label: 'Department',
    field_type: 'string',
    is_pii: 0,
    is_required: 1,
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

function createMockCoreDb(state: {
  schemas: CustomClaimSchema[];
  userCustomFields: Map<string, Record<string, string>>;
  lifecycleStates: Map<string, string | null>;
}) {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...args: any[]) => ({
        all: vi.fn(async () => {
          if (sql.includes('FROM custom_claim_schemas')) {
            return { results: state.schemas };
          }

          if (sql.includes('FROM user_custom_fields')) {
            const [userId, _tenantId, ...fieldNames] = args;
            const values = state.userCustomFields.get(userId) || {};
            const results = Object.entries(values)
              .filter(([fieldName]) => fieldNames.length === 0 || fieldNames.includes(fieldName))
              .map(([field_name, field_value]) => ({ field_name, field_value }));
            return { results };
          }

          return { results: [] };
        }),
        first: vi.fn(async () => {
          if (sql.includes('SELECT lifecycle_state FROM users_core')) {
            const [userId] = args;
            return { lifecycle_state: state.lifecycleStates.get(userId) ?? null };
          }

          return null;
        }),
        run: vi.fn(async () => {
          if (sql.includes('UPDATE users_core SET lifecycle_state = ?')) {
            const [lifecycleState, _updatedAt, userId] = args;
            state.lifecycleStates.set(userId, lifecycleState);
          }

          return { success: true };
        }),
      })),
    })),
  } as unknown as D1Database;
}

describe('user-lifecycle', () => {
  it('materializes incomplete when required custom claims are missing', async () => {
    const state = {
      schemas: [makeSchema()],
      userCustomFields: new Map<string, Record<string, string>>(),
      lifecycleStates: new Map<string, string | null>([['user-1', 'active']]),
    };

    const result = await syncUserLifecycleState({
      db: createMockCoreDb(state),
      tenantId: 'default',
      userId: 'user-1',
    });

    expect(result.lifecycleState).toBe('incomplete');
    expect(result.missingRequiredFields).toEqual([
      {
        fieldKey: 'department',
        label: 'Department',
        fieldType: 'string',
      },
    ]);
    expect(state.lifecycleStates.get('user-1')).toBe('incomplete');
  });

  it('materializes active when all required custom claims are present', async () => {
    const state = {
      schemas: [makeSchema()],
      userCustomFields: new Map<string, Record<string, string>>([
        ['user-1', { department: 'Engineering' }],
      ]),
      lifecycleStates: new Map<string, string | null>([['user-1', 'incomplete']]),
    };

    const result = await syncUserLifecycleState({
      db: createMockCoreDb(state),
      tenantId: 'default',
      userId: 'user-1',
    });

    expect(result.lifecycleState).toBe('active');
    expect(result.missingRequiredFields).toEqual([]);
    expect(state.lifecycleStates.get('user-1')).toBe('active');
  });
});
