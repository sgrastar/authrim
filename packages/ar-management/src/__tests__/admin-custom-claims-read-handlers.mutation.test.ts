/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- admin API response bodies and hono/vi fakes are untyped in these route tests */
/**
 * Mutation-focused tests for the read-side custom claim handlers: list (with the usage bindings
 * attached to each schema), presets, stats with its cache, the required-violations scan, get
 * and the history endpoints.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/custom-claims-mutation-harness')).buildLibCoreOverride(
    importOriginal as never
  )
);

import {
  adminCustomClaimGetHandler,
  adminCustomClaimHistoryListHandler,
  adminCustomClaimHistoryVersionHandler,
  adminCustomClaimRequiredViolationsDetectHandler,
  adminCustomClaimsStatsHandler,
} from '../admin-custom-claims';
import {} from '../custom-claim-presets';
import {
  createClaimsContext,
  createClaimsDb,
  createKv,
  libCore,
  read,
  resetLibCore,
  schemaRow,
  type Row,
} from './helpers/custom-claims-mutation-harness';

type Db = ReturnType<typeof createClaimsDb>;

const authMethods = (settings: Row) => JSON.stringify(settings);

/** Settings with every derived usage binding off. */
const NO_DERIVED = authMethods({
  'authentication-methods.passkey.signup_enabled': false,
  'authentication-methods.email_otp.login_enabled': false,
  'authentication-methods.email_otp.signup_enabled': false,
});

function kvWith(settings: string | null) {
  const kv = createKv();
  if (settings !== null)
    kv.store.set('settings:tenant:test-tenant:authentication-methods', settings);
  return kv;
}

describe('custom claim stats', () => {
  beforeEach(() => resetLibCore());

  function statsDb() {
    const db = createClaimsDb();
    db.state.rowsFor = [
      { includes: 'is_pii = FALSE', rows: [{ count: 4 }] },
      { includes: 'is_pii = TRUE', rows: [{ count: 2 }] },
      { includes: "operation_status = 'error'", rows: [{ count: 1 }] },
      { includes: 'COUNT(*) as count FROM custom_claim_schemas', rows: [{ count: 7 }] },
    ];
    return db;
  }
  const stats = (db: Db, kv = createKv().kv, settingsKv?: KVNamespace | null) =>
    adminCustomClaimsStatsHandler(createClaimsContext({ db: db.adapter, kv, settingsKv }));

  it('sums users and field usage across every store and caches the result', async () => {
    libCore.nonPiiStores = ['n1', 'n2'];
    libCore.piiStores = ['p1'];
    libCore.countNonPiiUsers.mockResolvedValueOnce(3).mockResolvedValueOnce(4);
    libCore.countPiiUsers.mockResolvedValue(5);
    libCore.listNonPiiFieldUsage
      .mockResolvedValueOnce([
        { fieldName: 'a', count: 1 },
        { fieldName: 'b', count: 2 },
      ])
      .mockResolvedValueOnce([{ fieldName: 'a', count: 10 }]);
    const kv = createKv();
    const { status, body } = await read(await stats(statsDb(), kv.kv));
    expect(status).toBe(200);
    expect(body).toEqual({
      total: 7,
      active_non_pii: 4,
      active_pii: 2,
      non_pii_users_with_data: 7,
      pii_users_with_data: 5,
      pii_users_approximate: true,
      field_usage: [
        { field_name: 'a', count: 11 },
        { field_name: 'b', count: 2 },
      ],
      error_count: 1,
    });
    expect(kv.spies.put).toHaveBeenCalledWith(
      'custom_claim_stats:test-tenant',
      JSON.stringify(body),
      {
        expirationTtl: 300,
      }
    );
  });

  it('answers a cached result without reading the database', async () => {
    const kv = createKv();
    kv.store.set('custom_claim_stats:test-tenant', '{"total":99}');
    const db = statsDb();
    const { body } = await read(await stats(db, kv.kv));
    expect(body).toEqual({ total: 99 });
    expect(db.state.queries).toHaveLength(0);
  });

  it('drops a corrupted cache entry and recomputes', async () => {
    const kv = createKv();
    kv.store.set('custom_claim_stats:test-tenant', '{broken');
    const { body } = await read(await stats(statsDb(), kv.kv));
    expect(body.total).toBe(7);
    expect(kv.spies.delete).toHaveBeenCalledWith('custom_claim_stats:test-tenant');
  });

  it('reports -1 PII users when the PII store cannot be read', async () => {
    libCore.piiStores = ['p1'];
    libCore.countPiiUsers.mockRejectedValue(new Error('pii down'));
    const { status, body } = await read(await stats(statsDb()));
    expect(status).toBe(200);
    expect(body.pii_users_with_data).toBe(-1);
  });

  it('falls back to the config KV and counts zero for missing rows', async () => {
    const config = createKv();
    const { body } = await read(await stats(createClaimsDb(), config.kv, null));
    expect(body).toMatchObject({
      total: 0,
      active_non_pii: 0,
      active_pii: 0,
      error_count: 0,
      field_usage: [],
    });
    expect(config.spies.put).toHaveBeenCalled();
  });

  it('still answers when the cache cannot be written', async () => {
    const kv = createKv();
    kv.spies.put.mockRejectedValue(new Error('kv down'));
    expect((await read(await stats(statsDb(), kv.kv))).status).toBe(200);
  });

  it('answers 500 when counting fails', async () => {
    const db = statsDb();
    db.state.failOn = () => new Error('down');
    expect((await stats(db)).status).toBe(500);
  });
});

describe('custom claim get', () => {
  beforeEach(() => resetLibCore());

  const get = (db: Db) =>
    adminCustomClaimGetHandler(
      createClaimsContext({ db: db.adapter, params: { id: 'schema-1' }, kv: kvWith(NO_DERIVED).kv })
    );

  it('answers 404 for an unknown schema', async () => {
    const db = createClaimsDb();
    expect((await get(db)).status).toBe(404);
  });

  it('counts holders of a plain attribute across the stores', async () => {
    libCore.nonPiiStores = ['n1', 'n2'];
    libCore.countNonPiiField.mockResolvedValueOnce(2).mockResolvedValueOnce(5);
    const db = createClaimsDb();
    db.state.schema = schemaRow();
    const { status, body } = await read(await get(db));
    expect(status).toBe(200);
    expect(body.user_count).toBe(7);
    expect(body.user_count_approximate).toBe(false);
    expect(body.schema.id).toBe('schema-1');
    expect(libCore.countNonPiiField).toHaveBeenCalledWith('n1', 'test-tenant', 'employee_id');
  });

  it('counts an encrypted attribute approximately, and -1 when the PII store fails', async () => {
    libCore.piiStores = ['p1', 'p2'];
    libCore.countPiiUsers.mockResolvedValue(3);
    const db = createClaimsDb();
    db.state.schema = schemaRow({ is_pii: 1 });
    const ok = await read(await get(db));
    expect(ok.body.user_count).toBe(6);
    expect(ok.body.user_count_approximate).toBe(true);
    libCore.countPiiUsers.mockRejectedValue(new Error('pii down'));
    expect((await read(await get(db))).body.user_count).toBe(-1);
  });

  it('answers 500 when reading fails', async () => {
    const db = createClaimsDb();
    db.state.failOn = () => new Error('down');
    expect((await get(db)).status).toBe(500);
  });
});

describe('custom claim required-violations scan', () => {
  beforeEach(() => resetLibCore());

  const detect = (db: Db, query: Record<string, string> = {}) =>
    adminCustomClaimRequiredViolationsDetectHandler(createClaimsContext({ db: db.adapter, query }));

  function storeWith(ids: string[]): Db['adapter'] {
    const store = createClaimsDb();
    store.state.rowsFor = [{ includes: 'identity_accounts', rows: ids.map((id) => ({ id })) }];
    return store.adapter;
  }

  it('answers an empty summary without checking anything when there are no users', async () => {
    libCore.nonPiiStores = [storeWith([])];
    const { body } = await read(await detect(createClaimsDb()));
    expect(body).toEqual({
      summary: {
        scanned_users: 0,
        violating_users: 0,
        required_schema_count: 0,
        preview_limit: 20,
      },
      violations: [],
      truncated: false,
    });
    expect(libCore.violations).not.toHaveBeenCalled();
  });

  it('lists violating users with their missing fields and identity details', async () => {
    libCore.nonPiiStores = [storeWith(['u1', 'u2', 'u3'])];
    libCore.violations.mockImplementation(async (input: { userIds: string[] }) => ({
      requiredSchemaCount: 2,
      users:
        input.userIds[0] === 'u2'
          ? [{ userId: 'u2', lifecycleState: 'active', missingRequiredFields: [] }]
          : [
              {
                userId: input.userIds[0],
                lifecycleState: 'incomplete',
                missingRequiredFields: [{ fieldKey: 'dept', label: 'Dept', fieldType: 'string' }],
              },
            ],
    }));
    libCore.runtimeUser.mockImplementation(async (userId: string) =>
      userId === 'u1' ? { email: 'u1@example.test', name: 'User One' } : null
    );
    const { body } = await read(await detect(createClaimsDb()));
    expect(body.summary).toEqual({
      scanned_users: 3,
      violating_users: 2,
      required_schema_count: 2,
      preview_limit: 20,
    });
    expect(body.truncated).toBe(false);
    expect(body.violations).toEqual([
      {
        user_id: 'u1',
        email: 'u1@example.test',
        name: 'User One',
        lifecycle_state: 'incomplete',
        missing_required_fields: [{ field_key: 'dept', label: 'Dept', field_type: 'string' }],
      },
      {
        user_id: 'u3',
        email: null,
        name: null,
        lifecycle_state: 'incomplete',
        missing_required_fields: [{ field_key: 'dept', label: 'Dept', field_type: 'string' }],
      },
    ]);
    expect(libCore.violations.mock.calls[0][0]).toMatchObject({
      tenantId: 'test-tenant',
      userIds: ['u1'],
      syncLifecycleState: true,
    });
    expect(libCore.runtimeUser).toHaveBeenCalledWith('u1', { includeInactive: true });
  });

  it('limits the preview, flagging truncation, and clamps the limit to 1..100', async () => {
    libCore.nonPiiStores = [storeWith(['u1', 'u2', 'u3'])];
    libCore.violations.mockImplementation(async (input: { userIds: string[] }) => ({
      requiredSchemaCount: 1,
      users: [
        {
          userId: input.userIds[0],
          lifecycleState: 'incomplete',
          missingRequiredFields: [{ fieldKey: 'k', label: 'K', fieldType: 'string' }],
        },
      ],
    }));
    libCore.runtimeUser.mockResolvedValue(null);
    const two = await read(await detect(createClaimsDb(), { limit: '2' }));
    expect(two.body.violations).toHaveLength(2);
    expect(two.body.truncated).toBe(true);
    expect(two.body.summary.preview_limit).toBe(2);
    expect(
      (await read(await detect(createClaimsDb(), { limit: '0' }))).body.summary.preview_limit
    ).toBe(1);
    expect(
      (await read(await detect(createClaimsDb(), { limit: '-5' }))).body.summary.preview_limit
    ).toBe(1);
    expect(
      (await read(await detect(createClaimsDb(), { limit: '999' }))).body.summary.preview_limit
    ).toBe(100);
    const three = await read(await detect(createClaimsDb(), { limit: '3' }));
    expect(three.body.truncated).toBe(false);
  });

  it('answers 500 when the scan fails', async () => {
    libCore.nonPiiStores = [storeWith(['u1'])];
    libCore.violations.mockRejectedValue(new Error('scan failed'));
    expect((await detect(createClaimsDb())).status).toBe(500);
  });
});

describe('custom claim history', () => {
  beforeEach(() => resetLibCore());

  const history = (params: Record<string, string>, query: Record<string, string> = {}) =>
    createClaimsContext({ db: createClaimsDb().adapter, params, query });

  it('lists versions with the default and the clamped paging', async () => {
    libCore.history.listVersions.mockResolvedValue({ versions: [1, 2] });
    const first = await read(await adminCustomClaimHistoryListHandler(history({ schemaId: 's1' })));
    expect(first.body).toEqual({ versions: [1, 2] });
    expect(libCore.history.listVersions).toHaveBeenLastCalledWith('test-tenant', 's1', 50, 0);
    await adminCustomClaimHistoryListHandler(
      history({ schemaId: 's1' }, { limit: '500', offset: '30' })
    );
    expect(libCore.history.listVersions).toHaveBeenLastCalledWith('test-tenant', 's1', 100, 30);
    await adminCustomClaimHistoryListHandler(
      history({ schemaId: 's1' }, { limit: '7', offset: '0' })
    );
    expect(libCore.history.listVersions).toHaveBeenLastCalledWith('test-tenant', 's1', 7, 0);
  });

  it('answers 500 when history cannot be listed', async () => {
    libCore.history.listVersions.mockRejectedValue(new Error('down'));
    expect((await adminCustomClaimHistoryListHandler(history({ schemaId: 's1' }))).status).toBe(
      500
    );
  });

  it.each(['0', '-1', 'abc'])('refuses version %s', async (version) => {
    const result = await read(
      await adminCustomClaimHistoryVersionHandler(history({ schemaId: 's1', version }))
    );
    expect(result.status).toBe(400);
    expect(libCore.errors[0]).toEqual({
      code: 'AR130002',
      variables: { field: 'version', reason: 'Must be a positive integer' },
    });
    expect(libCore.history.getVersion).not.toHaveBeenCalled();
  });

  it('answers a stored version, 404 for a missing one and 500 on failure', async () => {
    libCore.history.getVersion.mockResolvedValueOnce({ version: 1 });
    const found = await read(
      await adminCustomClaimHistoryVersionHandler(history({ schemaId: 's1', version: '1' }))
    );
    expect(found.body).toEqual({ history: { version: 1 } });
    expect(libCore.history.getVersion).toHaveBeenCalledWith('test-tenant', 's1', 1);
    libCore.history.getVersion.mockResolvedValueOnce(null);
    expect(
      (await adminCustomClaimHistoryVersionHandler(history({ schemaId: 's1', version: '2' })))
        .status
    ).toBe(404);
    libCore.history.getVersion.mockRejectedValueOnce(new Error('down'));
    expect(
      (await adminCustomClaimHistoryVersionHandler(history({ schemaId: 's1', version: '3' })))
        .status
    ).toBe(500);
  });
});
