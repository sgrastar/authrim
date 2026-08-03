import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { getRequiredCustomClaimViolationStatuses } from '../required-violations';
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
            const [_, ...rest] = args;
            const fieldCount = state.schemas.filter(
              (schema) => schema.is_required && !schema.is_pii
            ).length;
            const fieldNames = new Set(rest.slice(rest.length - fieldCount));
            const userIds = rest.slice(0, rest.length - fieldCount);
            const results = userIds.flatMap((userId: string) => {
              const values = state.userCustomFields.get(userId) || {};
              return Object.entries(values)
                .filter(([fieldName]) => fieldNames.has(fieldName))
                .map(([field_name, field_value]) => ({
                  user_id: userId,
                  field_name,
                  field_value,
                }));
            });
            return { results };
          }

          return { results: [] };
        }),
        first: vi.fn(async () => {
          if (sql.includes('FROM identity_accounts account')) {
            const [userId] = args;
            return {
              id: `account-${userId}`,
              lifecycle_state: state.lifecycleStates.get(userId) ?? null,
              subject_lifecycle_state: 'active',
              directory_publication_state: 'active',
            };
          }

          return null;
        }),
        run: vi.fn(async () => {
          if (sql.includes('UPDATE identity_accounts SET lifecycle_state = ?')) {
            const [lifecycleState, _updatedAt, accountId] = args;
            const userId = String(accountId).replace(/^account-/, '');
            state.lifecycleStates.set(userId, lifecycleState);
          }

          return { success: true };
        }),
      })),
    })),
  } as unknown as D1Database;
}

describe('required-violations', () => {
  it('returns missing required fields per user and can sync lifecycle_state', async () => {
    const state = {
      schemas: [makeSchema()],
      userCustomFields: new Map<string, Record<string, string>>([
        ['user-2', { department: 'Engineering' }],
      ]),
      lifecycleStates: new Map<string, string | null>([
        ['user-1', 'active'],
        ['user-2', 'incomplete'],
      ]),
    };

    const result = await getRequiredCustomClaimViolationStatuses({
      db: createMockCoreDb(state),
      tenantId: 'default',
      userIds: ['user-1', 'user-2'],
      syncLifecycleState: true,
    });

    expect(result.requiredSchemaCount).toBe(1);
    expect(result.users).toEqual([
      {
        userId: 'user-1',
        lifecycleState: 'incomplete',
        missingRequiredFields: [
          {
            fieldKey: 'department',
            label: 'Department',
            fieldType: 'string',
          },
        ],
      },
      {
        userId: 'user-2',
        lifecycleState: 'active',
        missingRequiredFields: [],
      },
    ]);
    expect(state.lifecycleStates.get('user-1')).toBe('incomplete');
    expect(state.lifecycleStates.get('user-2')).toBe('active');
  });
});
