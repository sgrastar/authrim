import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../../db';
import {
  getMissingRequiredCustomClaims,
  persistCustomClaimWrite,
  validateCustomClaimWrite,
  type ValidatedCustomClaimWriteResult,
} from '../write-validator';
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
}) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM custom_claim_schemas')) {
        return state.schemas.filter(
          (schema) => schema.is_active === 1 && schema.operation_status === 'active'
        );
      }

      if (sql.includes('FROM user_custom_fields')) {
        const [_tenantId, userId, ...fieldNames] = params ?? [];
        const values = state.userCustomFields.get(String(userId)) || {};
        return Object.entries(values)
          .filter(([fieldName]) => fieldNames.length === 0 || fieldNames.includes(fieldName))
          .map(([field_name, field_value]) => ({ field_name, field_value }));
      }

      return [];
    }),
    queryOne: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM custom_claim_schemas')) {
        const fieldKeys = (params ?? []).slice(1).map(String);
        return (
          state.schemas.find(
            (schema) => fieldKeys.includes(schema.field_key) && schema.operation_status !== 'active'
          ) ?? null
        );
      }
      if (sql.includes('SELECT user_id FROM user_custom_fields')) {
        const [userId, fieldName] = params ?? [];
        const values = state.userCustomFields.get(String(userId)) || {};
        return Object.prototype.hasOwnProperty.call(values, String(fieldName))
          ? { user_id: userId as string }
          : null;
      }

      return null;
    }),
    execute: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO user_custom_fields')) {
        const [_tenantId, userId, fieldName, fieldValue] = params ?? [];
        const values = state.userCustomFields.get(String(userId)) || {};
        values[String(fieldName)] = String(fieldValue);
        state.userCustomFields.set(String(userId), values);
        return { success: true, rowsAffected: 1 };
      }

      if (sql.includes('UPDATE user_custom_fields SET')) {
        const [fieldValue, _fieldType, _tenantId, userId, fieldName] = params ?? [];
        const values = state.userCustomFields.get(String(userId)) || {};
        if (!Object.prototype.hasOwnProperty.call(values, String(fieldName))) {
          return { success: true, rowsAffected: 0 };
        }
        values[String(fieldName)] = String(fieldValue);
        state.userCustomFields.set(String(userId), values);
        return { success: true, rowsAffected: 1 };
      }

      if (sql.includes('DELETE FROM user_custom_fields')) {
        const [_tenantId, userId, fieldName] = params ?? [];
        const values = state.userCustomFields.get(String(userId)) || {};
        delete values[String(fieldName)];
        state.userCustomFields.set(String(userId), values);
        return { success: true, rowsAffected: 1 };
      }

      return { success: true, rowsAffected: 0 };
    }),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  } as DatabaseAdapter;
}

function createMockPiiDb(state: { userCustomAttributes: Map<string, Record<string, unknown>> }) {
  const execute = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('INSERT INTO identity_sensitive_values')) {
      const valueKey = sql.includes("'custom_attributes_json'")
        ? 'custom_attributes_json'
        : String(params?.[3]);
      const userId = String(params?.[2]);
      if (valueKey === 'custom_attributes_json') {
        state.userCustomAttributes.set(userId, JSON.parse(String(params?.[3])));
      }
      return { success: true, rowsAffected: 1 };
    }
    if (sql.includes('DELETE FROM identity_sensitive_values')) {
      const [_tenantId, userId, valueKey] = params ?? [];
      const fieldKey = String(valueKey).replace(/^custom_attribute:/, '');
      const values = state.userCustomAttributes.get(String(userId)) || {};
      delete values[fieldKey];
      state.userCustomAttributes.set(String(userId), values);
      return { success: true, rowsAffected: 1 };
    }
    return { success: true, rowsAffected: 0 };
  });
  return {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM identity_sensitive_values')) {
        const [_tenantId, userId] = params ?? [];
        const attrs = state.userCustomAttributes.get(String(userId));
        return {
          value_json: attrs ? JSON.stringify(attrs) : null,
        };
      }
      return null;
    }),
    execute,
    transaction: vi.fn(),
    batch: vi.fn(async (statements) =>
      Promise.all(statements.map((statement) => execute(statement.sql, statement.params)))
    ),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  } as DatabaseAdapter;
}

describe('write-validator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves existing required values during partial updates', async () => {
    const schemas = [
      makeSchema({ field_key: 'department', display_label: 'Department', is_required: 1 }),
      makeSchema({
        id: 'schema-2',
        field_key: 'title',
        display_label: 'Title',
        is_required: 0,
      }),
    ];
    const state = {
      schemas,
      userCustomFields: new Map([['user-1', { department: 'Engineering' }]]),
    };
    const db = createMockCoreDb(state);

    const result = await validateCustomClaimWrite({
      db,
      tenantId: 'default',
      userId: 'user-1',
      submitted: { title: 'Lead' },
      requireCompleteRecord: true,
      mergeExistingValues: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        nonPiiValues: { title: 'Lead' },
      })
    );
  });

  it('rejects full replace when a required field would be removed', async () => {
    const schemas = [makeSchema({ field_key: 'department', display_label: 'Department' })];
    const state = {
      schemas,
      userCustomFields: new Map([['user-1', { department: 'Engineering' }]]),
    };
    const db = createMockCoreDb(state);

    const result = await validateCustomClaimWrite({
      db,
      tenantId: 'default',
      userId: 'user-1',
      submitted: { title: 'Lead' },
      requireCompleteRecord: true,
      mergeExistingValues: false,
      deleteMissingFields: true,
    });

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

  it('loads schema metadata from schemaDb when storage and schema backends differ', async () => {
    const schemas = [makeSchema({ field_key: 'department', display_label: 'Department' })];
    const dataState = {
      schemas: [],
      userCustomFields: new Map<string, Record<string, string>>(),
    };
    const schemaState = {
      schemas,
      userCustomFields: new Map<string, Record<string, string>>(),
    };

    const result = await validateCustomClaimWrite({
      db: createMockCoreDb(dataState),
      schemaDb: createMockCoreDb(schemaState),
      tenantId: 'default',
      submitted: { department: 'Engineering' },
      requireCompleteRecord: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        nonPiiValues: { department: 'Engineering' },
      })
    );
  });

  it('persists non-PII and PII values', async () => {
    const schemas = [
      makeSchema({ field_key: 'department', is_pii: 0, is_required: 0 }),
      makeSchema({
        id: 'schema-2',
        field_key: 'employeeNumber',
        display_label: 'Employee Number',
        is_pii: 1,
        is_required: 0,
      }),
    ];
    const coreState = {
      schemas,
      userCustomFields: new Map<string, Record<string, string>>(),
    };
    const piiState = {
      userCustomAttributes: new Map<string, Record<string, unknown>>(),
    };

    const validation: ValidatedCustomClaimWriteResult = {
      ok: true,
      schemas,
      nonPiiValues: { department: 'Sales' },
      piiValues: { employeeNumber: '42' },
      nonPiiKeysToDelete: [],
      piiKeysToDelete: [],
    };

    await persistCustomClaimWrite({
      db: createMockCoreDb(coreState),
      dbPii: createMockPiiDb(piiState),
      tenantId: 'default',
      userId: 'user-1',
      validation,
    });

    expect(coreState.userCustomFields.get('user-1')).toEqual({ department: 'Sales' });
    expect(piiState.userCustomAttributes.get('user-1')).toEqual({ employeeNumber: '42' });
  });

  it('deletes cleared fields from both storage locations', async () => {
    const schemas = [
      makeSchema({ field_key: 'department', is_pii: 0, is_required: 0 }),
      makeSchema({
        id: 'schema-2',
        field_key: 'employeeNumber',
        display_label: 'Employee Number',
        is_pii: 1,
        is_required: 0,
      }),
    ];
    const coreState = {
      schemas,
      userCustomFields: new Map([['user-1', { department: 'Sales' }]]),
    };
    const piiState = {
      userCustomAttributes: new Map([['user-1', { employeeNumber: '42' }]]),
    };

    const validation: ValidatedCustomClaimWriteResult = {
      ok: true,
      schemas,
      nonPiiValues: {},
      piiValues: {},
      nonPiiKeysToDelete: ['department'],
      piiKeysToDelete: ['employeeNumber'],
    };

    await persistCustomClaimWrite({
      db: createMockCoreDb(coreState),
      dbPii: createMockPiiDb(piiState),
      tenantId: 'default',
      userId: 'user-1',
      validation,
    });

    expect(coreState.userCustomFields.get('user-1')).toEqual({});
    expect(piiState.userCustomAttributes.get('user-1')).toEqual({});
  });

  it('returns all missing required custom claims for an existing user', async () => {
    const schemas = [
      makeSchema({ field_key: 'department', display_label: 'Department', is_required: 1 }),
      makeSchema({
        id: 'schema-2',
        field_key: 'employeeNumber',
        display_label: 'Employee Number',
        is_pii: 1,
        is_required: 1,
      }),
      makeSchema({
        id: 'schema-3',
        field_key: 'title',
        display_label: 'Title',
        is_required: 0,
      }),
    ];
    const coreState = {
      schemas,
      userCustomFields: new Map([['user-1', { department: 'Engineering' }]]),
    };
    const piiState = {
      userCustomAttributes: new Map<string, Record<string, unknown>>(),
    };

    const missing = await getMissingRequiredCustomClaims({
      db: createMockCoreDb(coreState),
      dbPii: createMockPiiDb(piiState),
      tenantId: 'default',
      userId: 'user-1',
    });

    expect(missing).toEqual([
      {
        fieldKey: 'employeeNumber',
        label: 'Employee Number',
        fieldType: 'string',
      },
    ]);
  });

  it('validates and serializes multi-valued fields as JSON arrays', async () => {
    const schemas = [
      makeSchema({
        field_key: 'roles',
        display_label: 'Roles',
        cardinality: 'multi',
        is_required: 0,
      }),
    ];
    const state = {
      schemas,
      userCustomFields: new Map<string, Record<string, string>>(),
    };

    await expect(
      validateCustomClaimWrite({
        db: createMockCoreDb(state),
        tenantId: 'default',
        submitted: { roles: ['admin', 'auditor', 'admin'] },
      })
    ).resolves.toEqual(
      expect.objectContaining({ ok: true, nonPiiValues: { roles: '["admin","auditor"]' } })
    );
    await expect(
      validateCustomClaimWrite({
        db: createMockCoreDb(state),
        tenantId: 'default',
        submitted: { roles: 'admin' },
      })
    ).resolves.toEqual({ ok: false, error: 'Roles must be an array' });
  });

  it('rejects writes while a submitted schema is being reconfigured', async () => {
    const state = {
      schemas: [
        makeSchema({
          field_key: 'roles',
          display_label: 'Roles',
          cardinality: 'multi',
          operation_status: 'reconfiguring',
        }),
      ],
      userCustomFields: new Map<string, Record<string, string>>(),
    };

    await expect(
      validateCustomClaimWrite({
        db: createMockCoreDb(state),
        tenantId: 'default',
        submitted: { roles: ['admin'] },
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Roles is temporarily unavailable while its schema is being modified',
    });
  });

  it('rechecks schema state immediately before persistence', async () => {
    const expectedSchema = makeSchema({
      field_key: 'roles',
      display_label: 'Roles',
      cardinality: 'multi',
      is_required: 0,
    });
    const schemaDb = createMockCoreDb({
      schemas: [{ ...expectedSchema, operation_status: 'reconfiguring' }],
      userCustomFields: new Map<string, Record<string, string>>(),
    });
    const dataDb = createMockCoreDb({
      schemas: [],
      userCustomFields: new Map<string, Record<string, string>>(),
    });

    await expect(
      persistCustomClaimWrite({
        db: dataDb,
        schemaDb,
        tenantId: 'default',
        userId: 'user-1',
        validation: {
          ok: true,
          schemas: [expectedSchema],
          nonPiiValues: { roles: '["admin"]' },
          piiValues: {},
          nonPiiKeysToDelete: [],
          piiKeysToDelete: [],
        },
      })
    ).rejects.toThrow('custom_claim_schema_changed_during_write:roles');
    expect(dataDb.execute).not.toHaveBeenCalled();
  });
});
