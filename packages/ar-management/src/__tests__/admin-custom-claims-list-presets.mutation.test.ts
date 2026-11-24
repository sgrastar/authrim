/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- admin API response bodies and hono/vi fakes are untyped in these route tests */
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
  adminCustomClaimPresetApplyHandler,
  adminCustomClaimPresetsListHandler,
  adminCustomClaimsListHandler,
  adminCustomClaimsReservedNamesHandler,
} from '../admin-custom-claims';
import { CUSTOM_CLAIM_PRESETS } from '../custom-claim-presets';
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
import { must } from './helpers/must';

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

describe('custom claim list', () => {
  beforeEach(() => resetLibCore());

  const listWith = (db: Db, query: Record<string, string> = {}, settings = NO_DERIVED) =>
    adminCustomClaimsListHandler(
      createClaimsContext({ db: db.adapter, query, kv: kvWith(settings).kv })
    );

  it('paginates with page and limit, capping the limit at 100', async () => {
    const db = createClaimsDb();
    db.state.rowsFor = [
      { includes: 'COUNT(*)', rows: [{ count: 250 }] },
      { includes: 'SELECT * FROM custom_claim_schemas', rows: [schemaRow()] },
    ];
    const { status, body } = await read(await listWith(db, { page: '3', limit: '500' }));
    expect(status).toBe(200);
    expect(body.pagination).toEqual({ page: 3, limit: 100, total: 250, total_pages: 3 });
    const select = must(db.state.queries.find((q) => q.sql.includes('LIMIT ? OFFSET ?')));
    expect(select.params.slice(-2)).toEqual([100, 200]);
  });

  it('defaults to page 1 and 50 per page', async () => {
    const db = createClaimsDb();
    db.state.rowsFor = [{ includes: 'COUNT(*)', rows: [{ count: 51 }] }];
    const { body } = await read(await listWith(db));
    expect(body.pagination).toEqual({ page: 1, limit: 50, total: 51, total_pages: 2 });
    expect(
      must(db.state.queries.find((q) => q.sql.includes('LIMIT ? OFFSET ?'))).params.slice(-2)
    ).toEqual([50, 0]);
  });

  it('passes valid filters to the query and ignores invalid ones', async () => {
    const valid = createClaimsDb();
    await listWith(valid, {
      search: 'emp',
      field_type: 'number',
      is_pii: '1',
      is_active: '0',
      is_system: '1',
      operation_status: 'error',
    });
    const where = valid.state.queries[0];
    expect(where.sql).toContain('field_key LIKE ?');
    expect(where.sql).toContain('field_type = ?');
    expect(where.sql).toContain('is_pii = ?');
    expect(where.sql).toContain('is_active = ?');
    expect(where.sql).toContain('is_system = ?');
    expect(where.sql).toContain('operation_status = ?');
    expect(where.params).toEqual([
      'test-tenant',
      '%emp%',
      '%emp%',
      '%emp%',
      'number',
      1,
      0,
      1,
      'error',
    ]);

    const invalid = createClaimsDb();
    await listWith(invalid, {
      field_type: 'uuid',
      is_pii: 'maybe',
      is_active: '2',
      is_system: 'x',
      operation_status: 'weird',
    });
    expect(invalid.state.queries[0].sql).not.toContain('field_type = ?');
    expect(invalid.state.queries[0].sql).not.toContain('is_pii = ?');
    expect(invalid.state.queries[0].sql).not.toContain('operation_status = ?');
    expect(invalid.state.queries[0].params).toEqual(['test-tenant']);
  });

  it('attaches stored and derived usage bindings and flags delete-blocked fields', async () => {
    const db = createClaimsDb();
    db.state.rowsFor = [
      { includes: 'COUNT(*)', rows: [{ count: 2 }] },
      {
        includes: 'FROM custom_claim_schemas',
        rows: [
          schemaRow({ id: 's1', field_key: 'dept' }),
          schemaRow({ id: 's2', field_key: 'email' }),
        ],
      },
      {
        includes: 'FROM field_usage_bindings',
        rows: [
          {
            id: 'b1',
            field_key: 'dept',
            binding_type: 'flow',
            binding_id: 'flow-1',
            protection: 'warn',
            reason: 'used in a flow',
            source: 'flow',
            metadata_json: '{"a":1}',
            is_active: 1,
            created_at: 5,
            updated_at: 6,
          },
          {
            id: 'b2',
            field_key: 'unrelated',
            binding_type: 'flow',
            binding_id: 'flow-2',
            protection: 'delete_blocked',
            reason: null,
            source: 'flow',
            metadata_json: '[1]',
            is_active: 1,
            created_at: 5,
            updated_at: 6,
          },
        ],
      },
    ];
    const settings = authMethods({
      'authentication-methods.passkey.signup_enabled': false,
      'authentication-methods.email_otp.login_enabled': true,
    });
    const { body } = await read(await listWith(db, {}, settings));
    const [dept, email] = body.schemas;
    expect(dept.usage_bindings).toEqual([
      {
        id: 'b1',
        field_key: 'dept',
        binding_type: 'flow',
        binding_id: 'flow-1',
        protection: 'warn',
        reason: 'used in a flow',
        source: 'flow',
        metadata: { a: 1 },
        is_active: 1,
        created_at: 5,
        updated_at: 6,
      },
    ]);
    expect(dept.is_system_used).toBe(false);
    expect(email.is_system_used).toBe(true);
    expect(email.usage_bindings).toEqual([
      {
        id: 'derived:email_otp.login:email',
        field_key: 'email',
        binding_type: 'authentication_method',
        binding_id: 'email_otp.login',
        protection: 'delete_blocked',
        reason: 'Email OTP login resolves users by email address.',
        source: 'derived',
        metadata: { method: 'email_otp', flow: 'login' },
        is_active: 1,
        created_at: 0,
        updated_at: 0,
      },
    ]);
  });

  it('merges chunked binding reads in binding type then id order', async () => {
    const db = createClaimsDb();
    const schemas = Array.from({ length: 100 }, (_, i) =>
      schemaRow({ id: `s${i}`, field_key: `f${i}` })
    );
    let usageReads = 0;
    const binding = (id: string, type: string, field: string) => ({
      id,
      field_key: field,
      binding_type: type,
      binding_id: id,
      protection: 'none',
      reason: null,
      source: 'x',
      metadata_json: null,
      is_active: 1,
      created_at: 1,
      updated_at: 1,
    });
    db.state.rowsFor = [
      { includes: 'COUNT(*)', rows: [{ count: 100 }] },
      { includes: 'FROM custom_claim_schemas', rows: schemas },
      {
        includes: 'FROM field_usage_bindings',
        rows: () => {
          usageReads += 1;
          return usageReads === 1
            ? [binding('z', 'b-type', 'f0'), binding('m', 'a-type', 'f1')]
            : [binding('a', 'a-type', 'f0'), binding('y', 'b-type', 'f0')];
        },
      },
    ];
    const { body } = await read(await listWith(db, { limit: '100' }));
    expect(usageReads).toBe(2);
    expect(body.schemas[0].usage_bindings.map((entry: Row) => entry.id)).toEqual(['a', 'y', 'z']);
    expect(body.schemas[1].usage_bindings.map((entry: Row) => entry.id)).toEqual(['m']);
    expect(body.schemas[0].usage_bindings[0].metadata).toBeNull();
  });

  it('survives unreadable stored bindings and unreadable settings', async () => {
    const db = createClaimsDb();
    db.state.rowsFor = [
      { includes: 'COUNT(*)', rows: [{ count: 1 }] },
      { includes: 'FROM custom_claim_schemas', rows: [schemaRow({ field_key: 'name' })] },
    ];
    db.state.failOn = (sql) =>
      sql.includes('field_usage_bindings') ? new Error('no table') : null;
    const { status, body } = await read(await listWith(db, {}, '{not json'));
    expect(status).toBe(200);
    // Defaults: passkey signup collects name and email.
    expect(body.schemas[0].usage_bindings.map((entry: Row) => entry.binding_id)).toEqual([
      'passkey.signup',
    ]);
    expect(body.schemas[0].is_system_used).toBe(true);
  });

  it('derives email OTP signup bindings, the legacy toggles and string booleans', async () => {
    const db = createClaimsDb();
    db.state.rowsFor = [
      { includes: 'COUNT(*)', rows: [{ count: 3 }] },
      {
        includes: 'FROM custom_claim_schemas',
        rows: [
          schemaRow({ id: 'a', field_key: 'name' }),
          schemaRow({ id: 'b', field_key: 'email' }),
          schemaRow({ id: 'c', field_key: 'email_verified' }),
        ],
      },
    ];
    const settings = authMethods({
      'authentication-methods.passkey.enabled': ' FALSE ',
      'authentication-methods.email_otp.enabled': 'true',
    });
    const { body } = await read(await listWith(db, {}, settings));
    const ids = (schema: Row) => (schema.usage_bindings as Row[]).map((entry) => entry.id);
    expect(ids(body.schemas[0])).toEqual(['derived:email_otp.signup:name']);
    expect(ids(body.schemas[1])).toEqual([
      'derived:email_otp.login:email',
      'derived:email_otp.signup:email',
    ]);
    expect(ids(body.schemas[2])).toEqual([
      'derived:email_otp.login:email_verified',
      'derived:email_otp.signup:email_verified',
    ]);
    expect(body.schemas[1].usage_bindings[1]).toMatchObject({
      reason: 'Email OTP signup collects and verifies the user email address.',
      metadata: { method: 'email_otp', flow: 'signup' },
    });
    expect(body.schemas[2].usage_bindings[0].reason).toBe(
      'Email OTP login depends on verified email state.'
    );
    expect(body.schemas[2].usage_bindings[1].reason).toBe(
      'Email OTP signup writes verified email state.'
    );
    expect(body.schemas[0].usage_bindings[0].reason).toBe(
      'Email OTP signup collects the user display name.'
    );
  });

  it('uses the defaults when the stored settings are not an object', async () => {
    for (const stored of ['[1]', 'null', '"text"']) {
      const db = createClaimsDb();
      db.state.rowsFor = [
        { includes: 'COUNT(*)', rows: [{ count: 1 }] },
        { includes: 'FROM custom_claim_schemas', rows: [schemaRow({ field_key: 'email' })] },
      ];
      const { body } = await read(await listWith(db, {}, stored));
      expect(body.schemas[0].usage_bindings.map((entry: Row) => entry.binding_id)).toEqual([
        'passkey.signup',
      ]);
    }
  });

  it('answers 500 when the schemas cannot be read', async () => {
    const db = createClaimsDb();
    db.state.failOn = () => new Error('db down');
    const { status } = await read(await listWith(db));
    expect(status).toBe(500);
  });
});

describe('custom claim reserved names and presets', () => {
  beforeEach(() => resetLibCore());

  it('lists the reserved names sorted, including the token and profile claims', async () => {
    const db = createClaimsDb();
    const { body } = await read(
      await adminCustomClaimsReservedNamesHandler(createClaimsContext({ db: db.adapter }))
    );
    expect(body.reserved_names).toEqual([...body.reserved_names].sort());
    expect(body.reserved_names).toEqual(
      expect.arrayContaining([
        'account_id',
        'sub',
        'verified_claims',
        'eduperson_assurance',
        'nonce',
        'email',
      ])
    );
  });

  it('lists presets with the keys that already exist', async () => {
    const db = createClaimsDb();
    db.state.rowsFor = [
      { includes: 'SELECT field_key', rows: [{ field_key: 'a' }, { field_key: 'b' }] },
    ];
    const { body } = await read(
      await adminCustomClaimPresetsListHandler(createClaimsContext({ db: db.adapter }))
    );
    expect(body.existing_field_keys).toEqual(['a', 'b']);
    expect(body.presets.map((preset: Row) => preset.id)).toEqual(
      CUSTOM_CLAIM_PRESETS.map((p) => p.id)
    );
    expect(db.state.queries[0].params).toEqual(['test-tenant']);
  });

  it('answers 500 when presets cannot be listed', async () => {
    const db = createClaimsDb();
    db.state.failOn = () => new Error('down');
    expect(
      (await adminCustomClaimPresetsListHandler(createClaimsContext({ db: db.adapter }))).status
    ).toBe(500);
  });

  const apply = (db: Db, body: unknown, jsonRejects = false) =>
    adminCustomClaimPresetApplyHandler(createClaimsContext({ db: db.adapter, body, jsonRejects }));
  const preset = CUSTOM_CLAIM_PRESETS[0];
  const keys = preset.fields.map((field) => field.field_key);

  it('refuses an unknown preset, a missing body and a non-string preset id', async () => {
    for (const body of [{ preset_id: 'nope' }, {}, { preset_id: 4 }]) {
      libCore.errors = [];
      const db = createClaimsDb();
      const result = await read(await apply(db, body));
      expect(result.status).toBe(400);
      expect(libCore.errors[0]).toEqual({
        code: 'AR130003',
        variables: { field: 'preset_id', reason: 'Unknown custom claim preset' },
      });
      expect(db.state.executes).toHaveLength(0);
    }
    libCore.errors = [];
    expect((await read(await apply(createClaimsDb(), null, true))).status).toBe(400);
  });

  it('refuses unknown field keys, naming them, and an empty selection', async () => {
    const unknown = await read(
      await apply(createClaimsDb(), { preset_id: preset.id, field_keys: [keys[0], 'zzz', 'yyy'] })
    );
    expect(unknown.status).toBe(400);
    expect(libCore.errors[0].variables).toEqual({
      field: 'field_keys',
      reason: 'Unknown preset field keys: zzz, yyy',
    });
    libCore.errors = [];
    const empty = await read(
      await apply(createClaimsDb(), { preset_id: preset.id, field_keys: [] })
    );
    expect(empty.status).toBe(400);
    expect(libCore.errors[0].variables).toEqual({
      field: 'field_keys',
      reason: 'At least one preset field must be selected',
    });
  });

  it('creates the selected fields that do not exist yet and skips the others', async () => {
    const db = createClaimsDb();
    db.state.rowsFor = [
      { includes: 'SELECT field_key FROM custom_claim_schemas', rows: [{ field_key: keys[0] }] },
    ];
    libCore.generatedIds = ['id-1', 'id-2', 'id-3'];
    const { status, body } = await read(
      await apply(db, { preset_id: preset.id, field_keys: [keys[0], keys[1], keys[2]] })
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      preset_id: preset.id,
      created_count: 2,
      skipped_count: 1,
      created_field_keys: [keys[1], keys[2]],
      skipped_field_keys: [keys[0]],
    });
    const inserts = db.state.executes.filter((entry) =>
      entry.sql.includes('INSERT INTO custom_claim_schemas')
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params.slice(0, 4)).toEqual(['id-1', 'test-tenant', keys[1], keys[1]]);
    expect(libCore.audit).toHaveBeenCalledWith(
      expect.anything(),
      'custom_claim.preset_applied',
      'custom_claim_schema',
      preset.id,
      {
        preset_id: preset.id,
        requested_field_keys: [keys[0], keys[1], keys[2]],
        created_field_keys: [keys[1], keys[2]],
        skipped_field_keys: [keys[0]],
      }
    );
  });

  it('applies the whole preset when no keys are given, skipping rows another request just made', async () => {
    const db = createClaimsDb();
    db.state.rowsFor = [
      { includes: 'SELECT id FROM custom_claim_schemas', rows: [{ id: 'taken' }] },
    ];
    const { body } = await read(await apply(db, { preset_id: preset.id }));
    // The per-row check finds every field taken, so nothing is inserted though none was listed.
    expect(body.created_field_keys).toEqual(keys);
    expect(body.created_count).toBe(0);
    expect(db.state.executes).toHaveLength(0);
  });

  it('writes native booleans for PostgreSQL and 0/1 otherwise', async () => {
    const run = async (type: string) => {
      const db = createClaimsDb();
      db.adapter.getType.mockReturnValue(type);
      await apply(db, { preset_id: preset.id, field_keys: [keys[0]] });
      return db.state.executes[0].params;
    };
    const mock = await run('d1');
    const postgres = await run('postgres');
    const field = preset.fields[0];
    expect(mock.slice(7, 9)).toEqual([field.is_pii, field.is_searchable]);
    expect(postgres.slice(7, 9)).toEqual([field.is_pii === 1, field.is_searchable === 1]);
  });

  it('answers 500 when applying fails', async () => {
    const db = createClaimsDb();
    db.state.failOn = () => new Error('down');
    expect((await apply(db, { preset_id: preset.id })).status).toBe(500);
  });
});
