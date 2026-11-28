import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), execute: vi.fn() },
  audit: vi.fn(),
  check: vi.fn(),
  guard: vi.fn(),
  kv: { get: vi.fn(), put: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    generateId: vi.fn(() => 'generated-id'),
    guardGroupUsersetWrite: mocks.guard,
    createAuditLogFromContext: mocks.audit,
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

vi.mock('@authrim/ar-lib-core/rebac/rebac-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core/rebac/rebac-service')>()),
  ReBACService: vi.fn(function () {
    return { check: mocks.check, checkResolved: mocks.check };
  }),
}));

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

// Admin operations are recorded through the forwarding shim (see the helper).
vi.mock('../admin-operation-audit', () => import('./helpers/legacy-admin-audit-shim'));

function context(options: { query?: Record<string, string>; id?: string; body?: unknown } = {}) {
  return {
    env: { REBAC_CACHE: mocks.kv },
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
    definition_json: '{"type":"direct","relation":"owner"}',
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

const VALID = { type: 'direct', relation: 'owner' };

describe('admin ReBAC APIs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.audit.mockResolvedValue(undefined);
    mocks.check.mockResolvedValue({ allowed: true, resolved_via: 'direct', path: ['tuple-1'] });
    // The guarded write: no refusal, the write runs with a fence that holds.
    mocks.guard.mockImplementation(
      async (
        _db: unknown,
        _tenant: string,
        _group: string,
        prepare: (
          reader: unknown,
          fence: { sql: string; params: unknown[] }
        ) => Promise<{ statements: Array<{ sql: string; params: unknown[] }>; result: unknown }>
      ) => {
        const prepared = await prepare(mocks.adapter, { sql: 'FENCE', params: ['fence-param'] });
        let rows: number | undefined;
        for (const statement of prepared.statements) {
          const executed = (await mocks.adapter.execute(statement.sql, statement.params)) as {
            rowsAffected?: number;
          };
          rows ??= executed.rowsAffected;
        }
        return prepared.statements.length && rows === 0
          ? { kind: 'group_version_conflict' }
          : { kind: 'written', result: prepared.result };
      }
    );
    mocks.kv.put.mockResolvedValue(undefined);
  });

  const groupTuple = {
    relationship_type: 'viewer',
    from_type: 'group',
    from_id: 'group-1',
    to_type: 'document',
    to_id: 'doc-1',
  };

  it('refuses a group userset on a group a self-writable service group decides', async () => {
    mocks.guard.mockResolvedValueOnce({ kind: 'group_self_writable_attribute' });
    const response = await adminRelationshipTupleCreateHandler(context({ body: groupTuple }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'group_self_writable_attribute',
    });
    expect(mocks.guard).toHaveBeenCalledWith(
      mocks.adapter,
      'tenant-a',
      'group-1',
      expect.any(Function)
    );
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
    // A direct subject tuple is not a userset: no such check.
    mocks.guard.mockClear();
    await adminRelationshipTupleCreateHandler(
      context({
        body: { relationship_type: 'viewer', from_id: 'user-1', to_type: 'document', to_id: 'd' },
      })
    );
    expect(mocks.guard).not.toHaveBeenCalled();
  });

  it('writes a group userset under the catalog fence, 409 when it does not hold', async () => {
    const created = await adminRelationshipTupleCreateHandler(context({ body: groupTuple }));
    expect(created.status).toBe(201);
    const [sql, params] = mocks.adapter.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO relationships');
    expect(sql).toContain('WHERE FENCE');
    expect(params.at(-1)).toBe('fence-param');
    expect(params.slice(3, 6)).toEqual(['group', 'group-1', 'member']);

    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const conflict = await adminRelationshipTupleCreateHandler(context({ body: groupTuple }));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: 'group_version_conflict' });
  });

  it('refuses an expires_at that is not an integer (milliseconds)', async () => {
    const response = await adminRelationshipTupleCreateHandler(
      context({
        body: {
          relationship_type: 'viewer',
          from_id: 'user-1',
          to_type: 'document',
          to_id: 'd',
          expires_at: 1.5,
        },
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it('deletes a group userset through the guarded write', async () => {
    mocks.adapter.query.mockResolvedValueOnce([
      { tenant_id: 'tenant-a', from_type: 'group', from_id: 'group-1', from_relation: 'member' },
    ]);
    const removed = await adminRelationshipTupleDeleteHandler(context());
    expect(removed.status).toBe(200);
    expect(mocks.guard).toHaveBeenCalledWith(
      mocks.adapter,
      'tenant-a',
      'group-1',
      expect.any(Function),
      { refuseSelfWritable: false }
    );
    expect(String(mocks.adapter.execute.mock.calls[0]?.[0])).toContain('AND FENCE');
    mocks.adapter.query.mockResolvedValueOnce([
      { tenant_id: 'tenant-a', from_type: 'group', from_id: 'group-1', from_relation: 'member' },
    ]);
    mocks.guard.mockResolvedValueOnce({ kind: 'group_version_conflict' });
    expect((await adminRelationshipTupleDeleteHandler(context())).status).toBe(409);
    // A legacy (inert) group row is deleted directly.
    mocks.guard.mockClear();
    mocks.adapter.query.mockResolvedValueOnce([
      { tenant_id: 'tenant-a', from_type: 'group', from_id: 'group-1', from_relation: null },
    ]);
    expect((await adminRelationshipTupleDeleteHandler(context())).status).toBe(200);
    expect(mocks.guard).not.toHaveBeenCalled();
  });

  it('stores an expires_at of 0 as an expiry (already expired), absent or null as none', async () => {
    for (const [expires_at, stored] of [
      [0, 0],
      [1_800_000_000_999, 1_800_000_000],
      [null, null],
      [undefined, null],
    ] as const) {
      mocks.adapter.execute.mockClear();
      const response = await adminRelationshipTupleCreateHandler(
        context({
          body: {
            relationship_type: 'viewer',
            from_id: 'user-1',
            to_type: 'document',
            to_id: 'd',
            ...(expires_at !== undefined && { expires_at }),
          },
        })
      );
      expect(response.status).toBe(201);
      const params = mocks.adapter.execute.mock.calls[0]?.[1] as unknown[];
      expect(params[9]).toBe(stored);
    }
    mocks.adapter.query
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([tuple({ expires_at: 0 })]);
    const listed = await (
      await adminRelationshipTuplesListHandler(context())
    ).json<{
      tuples: Array<Record<string, unknown>>;
    }>();
    expect(listed.tuples[0]?.expires_at).toBe(0);
  });

  it('deletes a legacy group row only while it is still inert', async () => {
    const legacy = { tenant_id: 'tenant-a', from_type: 'group', from_id: 'g', from_relation: null };
    const member = { ...legacy, from_relation: 'member' };
    // Still inert: deleted directly, with the inert condition in the statement.
    mocks.adapter.query.mockResolvedValueOnce([legacy]);
    expect((await adminRelationshipTupleDeleteHandler(context())).status).toBe(200);
    expect(String(mocks.adapter.execute.mock.calls[0]?.[0])).toContain('from_relation IS NULL');
    expect(mocks.guard).not.toHaveBeenCalled();
    // Became `member` meanwhile: the direct delete changes nothing, the row is read again and
    // deleted through the guarded write.
    mocks.adapter.execute.mockClear();
    mocks.adapter.query.mockResolvedValueOnce([legacy]).mockResolvedValueOnce([member]);
    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    expect((await adminRelationshipTupleDeleteHandler(context())).status).toBe(200);
    expect(mocks.guard).toHaveBeenCalledTimes(1);
    expect(String(mocks.adapter.execute.mock.calls[1]?.[0])).toContain('AND FENCE');
    // Gone meanwhile: 404.
    mocks.adapter.query.mockResolvedValueOnce([legacy]).mockResolvedValueOnce([]);
    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    expect((await adminRelationshipTupleDeleteHandler(context())).status).toBe(404);
  });

  it('marks legacy group rows (no member relation) inactive in the list', async () => {
    mocks.adapter.query
      .mockResolvedValueOnce([{ count: 2 }])
      .mockResolvedValueOnce([
        tuple({ from_type: 'group', from_id: 'g', from_relation: null }),
        tuple({ from_type: 'group', from_id: 'g2', from_relation: 'member' }),
      ]);
    const body = await (
      await adminRelationshipTuplesListHandler(context())
    ).json<{
      tuples: Array<Record<string, unknown>>;
    }>();
    expect(body.tuples.map((t) => t.inactive_legacy)).toEqual([true, false]);
  });

  it('bumps the tenant ReBAC version on every definition and tuple write', async () => {
    await adminRelationshipTupleCreateHandler(
      context({
        body: { relationship_type: 'viewer', from_id: 'user-1', to_type: 'document', to_id: 'd' },
      })
    );
    mocks.adapter.query.mockResolvedValueOnce([{ tenant_id: 'tenant-a' }]);
    await adminRelationshipTupleDeleteHandler(context());
    await adminRelationDefinitionCreateHandler(
      context({ body: { object_type: 'document', relation_name: 'viewer', definition: VALID } })
    );
    mocks.adapter.query.mockResolvedValueOnce([{ tenant_id: 'tenant-a' }]);
    await adminRelationDefinitionUpdateHandler(context({ body: { definition: VALID } }));
    mocks.adapter.query.mockResolvedValueOnce([{ tenant_id: 'tenant-a' }]);
    await adminRelationDefinitionDeleteHandler(context());
    expect(mocks.kv.put).toHaveBeenCalledTimes(5);
    for (const [key] of mocks.kv.put.mock.calls)
      expect(key).toBe('rebac:v2:tenant-version:tenant-a');
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
      definition: { type: 'direct', relation: 'owner' },
      unusable: false,
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

  it('defaults missing definition counts and reports unusable stored definitions', async () => {
    mocks.adapter.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(
      (await adminRelationDefinitionsListHandler(context())).json()
    ).resolves.toMatchObject({
      pagination: { total: 0 },
    });
    mocks.adapter.query
      .mockResolvedValueOnce([{ count: 3 }])
      .mockResolvedValueOnce([
        definition({ definition_json: '{' }),
        definition({ definition_json: '{"union":["owner"]}' }),
        definition({ definition_json: '{"type":"union","children":[]}' }),
      ]);
    const response = await adminRelationDefinitionsListHandler(context());
    expect(response.status).toBe(200);
    const body = await response.json<{ definitions: Array<Record<string, unknown>> }>();
    expect(body.definitions.map(({ definition, unusable }) => ({ definition, unusable }))).toEqual([
      { definition: null, unusable: true },
      { definition: { union: ['owner'] }, unusable: true },
      { definition: { type: 'union', children: [] }, unusable: true },
    ]);
  });

  it('reports an unusable stored definition on get', async () => {
    mocks.adapter.query.mockResolvedValueOnce([definition({ definition_json: '{"type":"x"}' })]);
    const response = await adminRelationDefinitionGetHandler(context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      definition: { definition: { type: 'x' }, unusable: true },
    });
  });

  it.each([
    [{ union: ['owner'] }],
    [{ type: 'wildcard' }],
    [{ type: 'direct' }],
    [{ type: 'union', children: [] }],
    [{ type: 'exclusion', base: { type: 'direct', relation: 'viewer' } }],
    ['{"type":"direct","relation":"viewer"}'],
    [[{ type: 'direct', relation: 'viewer' }]],
  ])('refuses an invalid definition on create and update with 400 %#', async (invalid) => {
    const create = await adminRelationDefinitionCreateHandler(
      context({ body: { object_type: 'document', relation_name: 'viewer', definition: invalid } })
    );
    expect(create.status).toBe(400);
    await expect(create.json()).resolves.toMatchObject({
      error: 'AR050011',
    });
    const update = await adminRelationDefinitionUpdateHandler(
      context({ body: { definition: invalid } })
    );
    expect(update.status).toBe(400);
    await expect(update.json()).resolves.toMatchObject({
      error: 'AR050011',
    });
    expect(mocks.adapter.query).not.toHaveBeenCalled();
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
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
          context({ body: { object_type: 'document', relation_name: 'viewer', definition: VALID } })
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
            definition: VALID,
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
          context({ body: { object_type: 'document', relation_name: 'viewer', definition: VALID } })
        )
      ).status
    ).toBe(500);
  });

  it('does not update a missing definition', async () => {
    expect((await adminRelationDefinitionUpdateHandler(context({ body: {} }))).status).toBe(404);
  });

  it('updates all mutable definition fields including false and zero', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ tenant_id: 'tenant-a' }]);
    const body = { definition: VALID, description: '', priority: 0, is_active: false };
    expect((await adminRelationDefinitionUpdateHandler(context({ body }))).status).toBe(200);
    expect(mocks.adapter.execute.mock.calls[0][1]).toEqual(
      expect.arrayContaining([JSON.stringify(VALID), '', 0, 0, 'item-1', 'tenant-a'])
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
      expect.objectContaining({
        expires_at: null,
        is_bidirectional: false,
        metadata: null,
        from_relation: null,
      }),
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
        from_relation: explicit ? 'member' : null,
        permission_level: explicit ? 'write' : 'full',
      },
    });
    // A group userset is stored with from_relation = 'member'; any other source with NULL.
    const insert = mocks.adapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO relationships')
    );
    expect(insert?.[0]).toContain('from_relation');
    expect((insert?.[1] as unknown[]).slice(3, 6)).toEqual(
      explicit ? ['group', 'group-1', 'member'] : ['subject', 'user-1', null]
    );
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

  describe('tuple type rules', () => {
    const edge = {
      relationship_type: 'parent',
      from_type: 'document',
      from_id: 'doc-1',
      to_type: 'folder',
      to_id: 'folder-1',
    };
    const parentDefinition = JSON.stringify({
      type: 'tuple_to_userset',
      tupleset: { relation: 'parent' },
      computed_userset: { relation: 'viewer' },
    });

    it('stores a direct subject sent as user as subject', async () => {
      mocks.adapter.query.mockResolvedValue([]);
      const response = await adminRelationshipTupleCreateHandler(
        context({
          body: {
            relationship_type: 'viewer',
            from_type: 'user',
            from_id: 'user-1',
            to_type: 'document',
            to_id: 'doc-1',
          },
        })
      );
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({ tuple: { from_type: 'subject' } });
      expect(mocks.adapter.execute.mock.calls[0]?.[1]).toEqual(
        expect.arrayContaining(['viewer', 'subject', 'user-1'])
      );
    });

    it('accepts an object edge a definition declares as a tuple_to_userset source', async () => {
      // The type's active definitions in one query, then the duplicate lookup.
      mocks.adapter.query
        .mockResolvedValueOnce([{ relation_name: 'viewer', definition_json: parentDefinition }])
        .mockResolvedValueOnce([]);
      const response = await adminRelationshipTupleCreateHandler(context({ body: edge }));
      expect(response.status).toBe(201);
      expect(mocks.adapter.query.mock.calls[0]?.[1]).toEqual(['tenant-a', 'document']);
    });

    it.each([
      ['an undeclared object edge', { ...edge, relationship_type: 'owner' }],
      ['an organization source', { ...edge, from_type: 'org' }],
    ])('refuses %s with 400 and writes nothing', async (_label, body) => {
      mocks.adapter.query.mockImplementation(async (_sql: string, params: unknown[]) =>
        params[1] === 'document' ? [{ definition_json: parentDefinition }] : []
      );
      const response = await adminRelationshipTupleCreateHandler(context({ body }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'AR050010',
      });
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
    });

    it('refuses a tuple that already exists with 409', async () => {
      mocks.adapter.query.mockResolvedValueOnce([{ id: 'existing' }]);
      const response = await adminRelationshipTupleCreateHandler(
        context({
          body: { relationship_type: 'viewer', from_id: 'u', to_type: 'doc', to_id: 'd' },
        })
      );
      expect(response.status).toBe(409);
      // A direct subject also matches a row an older write stored as `user`.
      expect(mocks.adapter.query.mock.calls[0]?.[1]).toEqual([
        'tenant-a',
        'viewer',
        'subject',
        'user',
        'u',
        'doc',
        'd',
      ]);
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
    });

    it('answers 409 when a concurrent create wins the unique index', async () => {
      mocks.adapter.query.mockResolvedValueOnce([]);
      mocks.adapter.execute.mockRejectedValueOnce(
        new Error('D1_ERROR: UNIQUE constraint failed: relationships.tenant_id')
      );
      const response = await adminRelationshipTupleCreateHandler(
        context({
          body: { relationship_type: 'viewer', from_id: 'u', to_type: 'doc', to_id: 'd' },
        })
      );
      expect(response.status).toBe(409);
      expect(mocks.audit).not.toHaveBeenCalled();
    });

    it('lists subject and legacy user rows for either filter spelling', async () => {
      for (const from_type of ['user', 'subject']) {
        mocks.adapter.query.mockReset();
        mocks.adapter.query.mockResolvedValueOnce([{ count: 0 }]).mockResolvedValueOnce([]);
        const response = await adminRelationshipTuplesListHandler(
          context({ query: { from_type } })
        );
        expect(response.status).toBe(200);
        const [sql, params] = mocks.adapter.query.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('from_type IN (?, ?)');
        expect(params.slice(1, 3)).toEqual(['subject', 'user']);
      }
    });
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
    expect(mocks.check).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      subjectId: 'user-1',
      relation: 'viewer',
      objectType: 'document',
      objectId: 'doc-1',
      ...(withContext && {
        contextualTuples: [{ relation: 'viewer', objectType: 'document', objectId: 'doc-1' }],
      }),
    });
    // Group usersets: the service reads the subject's groups from its account.
    const { ReBACService } = await import('@authrim/ar-lib-core/rebac/rebac-service');
    const config = vi.mocked(ReBACService).mock.lastCall?.[1];
    expect(typeof config?.subject_groups).toBe('function');
  });

  it('keeps user_id as before: one leading user: is taken away', async () => {
    for (const [given, stored] of [
      ['user:alice', 'alice'],
      ['user:user:alice', 'user:alice'],
      ['alice', 'alice'],
    ]) {
      mocks.check.mockClear();
      await adminRelationshipCheckHandler(
        context({ body: { user_id: given, relation: 'viewer', object: 'document:d' } })
      );
      expect(mocks.check.mock.calls[0]?.[0]).toMatchObject({ subjectId: stored });
    }
  });

  it('takes subject_id verbatim (a stored id may start with user:)', async () => {
    for (const subject of ['user:alice', 'alice']) {
      mocks.check.mockClear();
      await adminRelationshipCheckHandler(
        context({ body: { subject_id: subject, relation: 'viewer', object: 'document:d' } })
      );
      expect(mocks.check).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        subjectId: subject,
        relation: 'viewer',
        objectType: 'document',
        objectId: 'd',
      });
    }
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
