import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), execute: vi.fn() },
  audit: vi.fn(),
  check: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    generateId: vi.fn(() => 'generated-id'),
    createAuditLogFromContext: mocks.audit,
    ReBACService: vi.fn(function () {
      return { check: mocks.check };
    }),
    createErrorResponse: vi.fn((c, code, options) =>
      c.json(
        { error: code, ...options },
        code === actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND
          ? 404
          : code === actual.AR_ERROR_CODES.ADMIN_CONFLICT
            ? 409
            : code === actual.AR_ERROR_CODES.INTERNAL_ERROR
              ? 500
              : 400
      )
    ),
  };
});

import {
  adminObjectTypesListHandler,
  adminRelationDefinitionCreateHandler,
  adminRelationDefinitionDeleteHandler,
  adminRelationDefinitionGetHandler,
  adminRelationDefinitionUpdateHandler,
  adminRelationDefinitionsListHandler,
  adminRelationshipCheckHandler,
  adminRelationshipTupleCreateHandler,
  adminRelationshipTupleDeleteHandler,
  adminRelationshipTuplesListHandler,
} from '../admin-rebac';

function context(options: { query?: Record<string, string>; id?: string; body?: unknown } = {}) {
  return {
    req: {
      query: vi.fn((name: string) => options.query?.[name]),
      param: vi.fn(() => options.id ?? 'item-1'),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function definition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'definition-1',
    tenant_id: 'tenant-a',
    object_type: 'document',
    relation_name: 'viewer',
    definition_json: '{"union":["owner"]}',
    description: null,
    priority: 10,
    is_active: 1,
    created_at: 100,
    updated_at: 101,
    ...overrides,
  };
}

function tuple(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tuple-1',
    tenant_id: 'tenant-a',
    relationship_type: 'viewer',
    from_type: 'user',
    from_id: 'user-1',
    to_type: 'document',
    to_id: 'doc-1',
    permission_level: 'full',
    expires_at: null,
    is_bidirectional: 0,
    metadata_json: null,
    created_at: 100,
    updated_at: 101,
    ...overrides,
  };
}

describe('admin ReBAC APIs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.audit.mockResolvedValue(undefined);
    mocks.check.mockResolvedValue({ allowed: true, resolved_via: 'direct', path: ['tuple-1'] });
  });

  it.each([
    [{}, [50, 0]],
    [
      { page: '2', limit: '10', object_type: 'document', search: '100%_viewer', is_active: 'true' },
      [10, 10],
    ],
    [{ is_active: 'false' }, [50, 0]],
  ])('lists relation definitions with tenant-scoped filters %#', async (query, pageTail) => {
    mocks.adapter.query
      .mockResolvedValueOnce([{ count: 11 }])
      .mockResolvedValueOnce([definition()]);
    const body = (await (await adminRelationDefinitionsListHandler(context({ query }))).json()) as {
      definitions: Array<Record<string, unknown>>;
      pagination: unknown;
    };
    expect(body.definitions[0]).toMatchObject({
      definition: { union: ['owner'] },
      is_active: true,
      created_at: 100_000,
    });
    expect(mocks.adapter.query.mock.calls[1][1]).toEqual(expect.arrayContaining(pageTail));
    if ('search' in query && query.search) {
      expect(mocks.adapter.query.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['%100\\%\\_viewer%'])
      );
    }
  });

  it('defaults missing definition counts and rejects corrupt stored definitions', async () => {
    mocks.adapter.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(
      (await adminRelationDefinitionsListHandler(context())).json()
    ).resolves.toMatchObject({
      pagination: { total: 0 },
    });
    mocks.adapter.query
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([definition({ definition_json: '{' })]);
    expect((await adminRelationDefinitionsListHandler(context())).status).toBe(500);
  });

  it.each([[[]], [[definition()]]])('gets definition result %#', async (rows) => {
    mocks.adapter.query.mockResolvedValueOnce(rows);
    const response = await adminRelationDefinitionGetHandler(context());
    expect(response.status).toBe(rows.length ? 200 : 404);
  });

  it('handles definition get failures', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminRelationDefinitionGetHandler(context())).status).toBe(500);
  });

  it.each([
    [{}],
    [{ object_type: 'document', relation_name: '', definition: {} }],
    [{ object_type: 'document', relation_name: 'viewer' }],
  ])('requires create definition fields %#', async (body) => {
    expect((await adminRelationDefinitionCreateHandler(context({ body }))).status).toBe(400);
  });

  it('rejects duplicate relation definitions', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'existing' }]);
    expect(
      (
        await adminRelationDefinitionCreateHandler(
          context({ body: { object_type: 'document', relation_name: 'viewer', definition: {} } })
        )
      ).status
    ).toBe(409);
  });

  it.each([true, false])(
    'creates active=%s relation definition and audits it',
    async (is_active) => {
      const response = await adminRelationDefinitionCreateHandler(
        context({
          body: {
            object_type: 'document',
            relation_name: 'viewer',
            definition: { union: ['owner'] },
            description: 'Can view',
            priority: 0,
            is_active,
          },
        })
      );
      expect(response.status).toBe(201);
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO relation_definitions'),
        expect.arrayContaining([
          'generated-id',
          'tenant-a',
          'document',
          'viewer',
          is_active ? 1 : 0,
        ])
      );
      expect(mocks.audit).toHaveBeenCalled();
    }
  );

  it('uses create defaults and handles persistence failure', async () => {
    mocks.adapter.execute.mockRejectedValueOnce(new Error('failure'));
    expect(
      (
        await adminRelationDefinitionCreateHandler(
          context({ body: { object_type: 'document', relation_name: 'viewer', definition: {} } })
        )
      ).status
    ).toBe(500);
  });

  it('does not update a missing definition', async () => {
    expect((await adminRelationDefinitionUpdateHandler(context({ body: {} }))).status).toBe(404);
  });

  it('updates all mutable definition fields including false and zero', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ tenant_id: 'tenant-a' }]);
    const body = { definition: {}, description: '', priority: 0, is_active: false };
    expect((await adminRelationDefinitionUpdateHandler(context({ body }))).status).toBe(200);
    expect(mocks.adapter.execute.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['{}', '', 0, 0, 'item-1', 'tenant-a'])
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'update',
      'relation_definition',
      'item-1',
      { changes: Object.keys(body) }
    );
  });

  it('performs timestamp-only updates and handles failures', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ tenant_id: 'tenant-a' }]);
    expect((await adminRelationDefinitionUpdateHandler(context({ body: {} }))).status).toBe(200);
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminRelationDefinitionUpdateHandler(context({ body: {} }))).status).toBe(500);
  });

  it.each([[[]], [[{ tenant_id: 'tenant-a' }]]])('deletes definition result %#', async (rows) => {
    mocks.adapter.query.mockResolvedValueOnce(rows);
    const response = await adminRelationDefinitionDeleteHandler(context());
    expect(response.status).toBe(rows.length ? 200 : 404);
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(rows.length ? 1 : 0);
  });

  it('handles definition delete failures', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminRelationDefinitionDeleteHandler(context())).status).toBe(500);
  });

  it('lists fully filtered tuples and normalizes optional values', async () => {
    mocks.adapter.query
      .mockResolvedValueOnce([{ count: 2 }])
      .mockResolvedValueOnce([
        tuple({ expires_at: 200, is_bidirectional: 1, metadata_json: '{"source":"manual"}' }),
        tuple(),
      ]);
    const query = {
      page: '2',
      limit: '1',
      from_type: 'user',
      from_id: 'user-1',
      to_type: 'document',
      to_id: 'doc-1',
      relationship_type: 'viewer',
    };
    const body = (await (await adminRelationshipTuplesListHandler(context({ query }))).json()) as {
      tuples: Array<Record<string, unknown>>;
      pagination: unknown;
    };
    expect(body.tuples).toEqual([
      expect.objectContaining({
        expires_at: 200_000,
        is_bidirectional: true,
        metadata: { source: 'manual' },
      }),
      expect.objectContaining({ expires_at: null, is_bidirectional: false, metadata: null }),
    ]);
    expect(body.pagination).toMatchObject({ page: 2, total_pages: 2 });
  });

  it('defaults tuple counts and rejects malformed metadata', async () => {
    mocks.adapter.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(
      (await adminRelationshipTuplesListHandler(context())).json()
    ).resolves.toMatchObject({
      pagination: { total: 0 },
    });
    mocks.adapter.query
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([tuple({ metadata_json: '{' })]);
    expect((await adminRelationshipTuplesListHandler(context())).status).toBe(500);
  });

  it.each([
    [{}],
    [{ relationship_type: 'viewer', from_id: '', to_type: 'document', to_id: 'doc-1' }],
  ])('requires tuple fields %#', async (body) => {
    expect((await adminRelationshipTupleCreateHandler(context({ body }))).status).toBe(400);
  });

  it.each([false, true])('creates tuple with explicit optional data=%s', async (explicit) => {
    const body = explicit
      ? {
          relationship_type: 'editor',
          from_type: 'group',
          from_id: 'group-1',
          to_type: 'document',
          to_id: 'doc-1',
          permission_level: 'write',
          expires_at: 1_800_000_123_456,
          metadata: { source: 'manual' },
        }
      : { relationship_type: 'viewer', from_id: 'user-1', to_type: 'document', to_id: 'doc-1' };
    const response = await adminRelationshipTupleCreateHandler(context({ body }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      tuple: {
        from_type: explicit ? 'group' : 'subject',
        permission_level: explicit ? 'write' : 'full',
      },
    });
    expect(mocks.audit).toHaveBeenCalled();
  });

  it('handles tuple creation failures', async () => {
    mocks.adapter.execute.mockRejectedValueOnce(new Error('failure'));
    expect(
      (
        await adminRelationshipTupleCreateHandler(
          context({
            body: { relationship_type: 'viewer', from_id: 'u', to_type: 'doc', to_id: 'd' },
          })
        )
      ).status
    ).toBe(500);
  });

  it.each([[[]], [[{ tenant_id: 'tenant-a' }]]])('deletes tuple result %#', async (rows) => {
    mocks.adapter.query.mockResolvedValueOnce(rows);
    const response = await adminRelationshipTupleDeleteHandler(context());
    expect(response.status).toBe(rows.length ? 200 : 404);
  });

  it('handles tuple deletion failures', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminRelationshipTupleDeleteHandler(context())).status).toBe(500);
  });

  it('requires relationship check fields', async () => {
    expect((await adminRelationshipCheckHandler(context({ body: {} }))).status).toBe(400);
  });

  it.each([false, true])('checks permission with contextual tuples=%s', async (withContext) => {
    const contextual_tuples = withContext
      ? [{ user_id: 'user-1', relation: 'viewer', object: 'doc-1', object_type: 'document' }]
      : undefined;
    const response = await adminRelationshipCheckHandler(
      context({
        body: {
          user_id: 'user-1',
          relation: 'viewer',
          object: 'doc-1',
          object_type: 'document',
          contextual_tuples,
        },
      })
    );
    await expect(response.json()).resolves.toEqual({
      allowed: true,
      resolved_via: 'direct',
      path: ['tuple-1'],
    });
    expect(mocks.check).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        context: withContext ? { contextual_tuples } : undefined,
      })
    );
  });

  it('handles permission check failures', async () => {
    mocks.check.mockRejectedValueOnce(new Error('failure'));
    expect(
      (
        await adminRelationshipCheckHandler(
          context({ body: { user_id: 'u', relation: 'viewer', object: 'd' } })
        )
      ).status
    ).toBe(500);
  });

  it('lists object types and handles failures', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ object_type: 'document', count: 3 }]);
    await expect((await adminObjectTypesListHandler(context())).json()).resolves.toEqual({
      object_types: [{ name: 'document', definition_count: 3 }],
    });
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminObjectTypesListHandler(context())).status).toBe(500);
  });
});
