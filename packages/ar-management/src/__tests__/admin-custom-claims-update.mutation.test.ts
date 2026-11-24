/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- admin API response bodies and hono/vi fakes are untyped in these route tests */
/**
 * Mutation-focused tests for the custom claim update handler (PUT): each refusal's field and
 * reason, the stored form of every updatable field, the enum narrowing refusals and the
 * cardinality fence with its recovery.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/custom-claims-mutation-harness')).buildLibCoreOverride(
    importOriginal as never
  )
);

import { adminCustomClaimUpdateHandler } from '../admin-custom-claims';
import {
  createClaimsContext,
  createClaimsDb,
  libCore,
  read,
  resetLibCore,
  schemaRow,
  type Row,
} from './helpers/custom-claims-mutation-harness';
import { must } from './helpers/must';

const FORMAT = 'AR130002';

type Db = ReturnType<typeof createClaimsDb>;

function setup(schema: Row = schemaRow()): Db {
  const db = createClaimsDb();
  db.state.schema = schema;
  return db;
}

async function update(body: unknown, db: Db = setup()) {
  const c = createClaimsContext({ db: db.adapter, params: { id: 'schema-1' }, body });
  return { ...(await read(await adminCustomClaimUpdateHandler(c))), db };
}

/** The SET map and the WHERE params of the schema UPDATE that is not the cardinality fence. */
function applied(db: Db) {
  const statement = db.state.executes.find(
    (entry) =>
      entry.sql.startsWith('UPDATE custom_claim_schemas') && !entry.sql.includes("'reconfiguring'")
  );
  expect(statement).toBeDefined();
  const columns = must(/SET (.*) WHERE/s.exec(must(statement).sql))[1]
    .split(', ')
    .map((part) => part.replace(' = ?', ''));
  const set = Object.fromEntries(
    columns.map((name, index) => [name, must(statement).params[index]])
  );
  return { set, where: must(statement).params.slice(columns.length), sql: must(statement).sql };
}

function expectRefused(result: Awaited<ReturnType<typeof update>>, field: string, reason: string) {
  expect(result.status).toBe(400);
  expect(result.body.error_code).toBe(FORMAT);
  expect(libCore.errors.at(-1)?.variables).toEqual({ field, reason });
  expect(result.db.state.executes).toHaveLength(0);
}

describe('custom claim update: refusals before anything is written', () => {
  beforeEach(() => resetLibCore());

  it('answers 404 for an unknown schema', async () => {
    const result = await update({ display_label: 'x' }, setup(null as never));
    expect(result.status).toBe(404);
    expect(result.db.state.executes).toHaveLength(0);
  });

  it('refuses while an operation is in progress', async () => {
    const result = await update(
      { display_label: 'x' },
      setup(schemaRow({ operation_status: 'renaming' }))
    );
    expectRefused(
      result,
      'operation_status',
      'Schema is currently being modified. Wait for the operation to complete.'
    );
  });

  it('refuses re-activating a deactivated assurance column attribute, but not a normal one', async () => {
    const refused = await update(
      { is_active: true },
      setup(schemaRow({ field_key: 'ial', is_active: 0 }))
    );
    expectRefused(refused, 'is_active', "'ial' is a reserved or built-in profile field name");
    const allowed = await update({ is_active: true }, setup(schemaRow({ is_active: 0 })));
    expect(allowed.status).toBe(200);
    expect(applied(allowed.db).set.is_active).toBe(1);
  });

  it('lets an already active assurance column attribute be updated', async () => {
    const result = await update(
      { is_active: true, display_label: 'IAL' },
      setup(schemaRow({ field_key: 'ial', is_active: 1 }))
    );
    expect(result.status).toBe(200);
  });

  it.each(['field_key', 'display_label', 'field_type', 'cardinality', 'is_pii'])(
    'refuses changing %s of a system claim',
    async (name) => {
      const system = schemaRow({ is_system: 1, field_type: 'string', is_pii: 0 });
      const changed: Row = {
        field_key: 'other_key',
        display_label: 'Renamed',
        field_type: 'number',
        cardinality: 'multi',
        is_pii: true,
      };
      const result = await update({ [name]: changed[name] }, setup(system));
      expect(result.status).toBe(403);
      expect(result.body).toEqual({
        error: 'forbidden',
        error_description: `Cannot modify ${name} on system claims`,
      });
      expect(result.db.state.executes).toHaveLength(0);
    }
  );

  it('lets a system claim keep its protected values while other fields change', async () => {
    const system = schemaRow({ is_system: true });
    const result = await update({ display_label: 'Employee ID', description: 'd' }, setup(system));
    expect(result.status).toBe(200);
  });

  it('never lets is_system change', async () => {
    const result = await update({ is_system: false });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: 'forbidden',
      error_description: 'is_system flag cannot be changed via admin API',
    });
  });

  it('refuses changing is_pii or field_key, but accepts the same values', async () => {
    expectRefused(
      await update({ is_pii: true }),
      'is_pii',
      'PII classification cannot be changed after creation. Delete and recreate the schema.'
    );
    expectRefused(
      await update({ field_key: 'renamed' }),
      'field_key',
      'Use PATCH /api/admin/custom-claims/:id/rename to change the field_key'
    );
    const same = await update({ is_pii: false, field_key: 'employee_id', display_label: 'Same' });
    expect(same.status).toBe(200);
  });

  it.each([
    ['empty', ''],
    ['a number', 5],
  ])('refuses a display_label that is %s', async (_name, label) => {
    expectRefused(
      await update({ display_label: label }),
      'display_label',
      'display_label must be a non-empty string'
    );
  });

  it('refuses a display_label over 255 characters and accepts 255', async () => {
    expectRefused(
      await update({ display_label: 'x'.repeat(256) }),
      'display_label',
      'display_label must be at most 255 characters'
    );
    libCore.errors = [];
    const ok = await update({ display_label: 'x'.repeat(255) });
    expect(applied(ok.db).set.display_label).toBe('x'.repeat(255));
  });

  it.each([
    ['not a string', 9],
    ['over 2000 characters', 'd'.repeat(2001)],
  ])('refuses a description that is %s', async (_name, description) => {
    expectRefused(
      await update({ description }),
      'description',
      'description must be a string of at most 2000 characters'
    );
  });

  it('stores an empty or null description as null and a 2000 character one as given', async () => {
    expect(applied((await update({ description: '' })).db).set.description).toBeNull();
    expect(applied((await update({ description: null })).db).set.description).toBeNull();
    expect(applied((await update({ description: 'd'.repeat(2000) })).db).set.description).toBe(
      'd'.repeat(2000)
    );
  });

  it('refuses an unknown field_type and an unknown cardinality', async () => {
    expectRefused(
      await update({ field_type: 'blob' }),
      'field_type',
      'Must be one of: string, number, boolean, date, enum'
    );
    expectRefused(
      await update({ cardinality: 'few' }),
      'cardinality',
      'Must be one of: single, multi'
    );
  });

  it.each([
    ['required_scopes', { required_scopes: 'x' }, 'Must be an array of strings'],
    [
      'required_scopes',
      { required_scopes: Array.from({ length: 51 }, (_, i) => `s${i}`) },
      'required_scopes must have at most 50 items',
    ],
    ['required_scopes', { required_scopes: ['a', ''] }, 'Each scope must be a non-empty string'],
    ['required_scopes', { required_scopes: [3] }, 'Each scope must be a non-empty string'],
    ['scope_mode', { scope_mode: 'some' }, "Must be 'all' or 'any'"],
    [
      'ui_group_key',
      { ui_group_key: 'Bad Key' },
      'ui_group_key must be lower-case and at most 64 characters',
    ],
    [
      'ui_group_key',
      { ui_group_key: 5 },
      'ui_group_key must be lower-case and at most 64 characters',
    ],
    [
      'ui_group_label',
      { ui_group_label: 'l'.repeat(101) },
      'ui_group_label must be a string of at most 100 characters',
    ],
    [
      'ui_group_label',
      { ui_group_label: 5 },
      'ui_group_label must be a string of at most 100 characters',
    ],
    ['examples_json', { examples_json: '{nope' }, 'examples_json must be valid JSON'],
    [
      'claim_namespace',
      { claim_namespace: 'example.com' },
      'claim_namespace must start with http:// or https://',
    ],
    [
      'claim_namespace',
      { claim_namespace: `https://${'a'.repeat(250)}.example` },
      'claim_namespace must be at most 255 characters',
    ],
  ])('refuses an invalid %s', async (field, body, reason) => {
    expectRefused(await update(body), field, reason);
  });

  it('refuses an update that changes nothing', async () => {
    expectRefused(await update({}), 'body', 'No valid fields to update');
  });

  it('accepts exactly 50 scopes and clears them with null', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `s${i}`);
    expect(
      JSON.parse(String(applied((await update({ required_scopes: fifty })).db).set.required_scopes))
    ).toHaveLength(50);
    expect(applied((await update({ required_scopes: null })).db).set.required_scopes).toBeNull();
  });
});

describe('custom claim update: validation_rules', () => {
  beforeEach(() => resetLibCore());

  it('refuses rules that do not suit the (new) type with the rule error', async () => {
    expectRefused(
      await update({ field_type: 'number', validation_rules: { min_length: 1 } }),
      'validation_rules',
      'Unknown number validation key: min_length'
    );
    expectRefused(
      await update({ validation_rules: { pattern: '(a+)+' } }),
      'validation_rules',
      'pattern is invalid or potentially unsafe (max 128 chars, no nested quantifiers)'
    );
  });

  it('stores accepted rules as JSON and clears them with null', async () => {
    const set = await update({ validation_rules: { min_length: 2, max_length: 8 } });
    expect(applied(set.db).set.validation_rules).toBe('{"min_length":2,"max_length":8}');
    expect(applied((await update({ validation_rules: null })).db).set.validation_rules).toBeNull();
  });

  it('measures the rules against 4KB (and not against 64KB)', async () => {
    const date = schemaRow({ field_type: 'date' });
    expectRefused(
      await update({ validation_rules: { min_date: 'x'.repeat(4096) } }, setup(date)),
      'validation_rules',
      'validation_rules JSON must be at most 4KB'
    );
    const ok = await update({ validation_rules: { min_date: 'x'.repeat(4000) } }, setup(date));
    expect(ok.status).toBe(200);
  });

  it('checks stored rules against a new type, and keeps them when they suit it', async () => {
    const stored = schemaRow({ validation_rules: '{"min_length":1}' });
    expectRefused(
      await update({ field_type: 'number' }, setup(stored)),
      'validation_rules',
      'Unknown number validation key: min_length'
    );
    const objectRules = schemaRow({ validation_rules: { min_length: 1 } });
    expectRefused(
      await update({ field_type: 'date' }, setup(objectRules)),
      'validation_rules',
      'Unknown date validation key: min_length'
    );
    const compatible = await update(
      { field_type: 'boolean' },
      setup(schemaRow({ validation_rules: null }))
    );
    expect(compatible.status).toBe(200);
    expect(applied(compatible.db).set.field_type).toBe('boolean');
    // Unreadable stored rules read as none.
    const garbage = await update(
      { field_type: 'number' },
      setup(schemaRow({ validation_rules: '{broken' }))
    );
    expect(garbage.status).toBe(200);
    const blank = await update(
      { field_type: 'number' },
      setup(schemaRow({ validation_rules: '   ' }))
    );
    expect(blank.status).toBe(200);
    const array = await update(
      { field_type: 'number' },
      setup(schemaRow({ validation_rules: [1] }))
    );
    expect(array.status).toBe(200);
  });
});

describe('custom claim update: stored form of each updatable field', () => {
  beforeEach(() => resetLibCore());

  it('stores booleans as 0/1 and passes values through', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const result = await update({
        is_required: true,
        is_active: false,
        is_searchable: 0,
        is_exportable: 'yes',
        is_vc_claim: 1,
        show_on_registration: true,
        registration_required: 0,
        display_order: 4,
        registration_order: 2,
        registration_placeholder: '',
        ui_group_key: null,
        ui_group_label: '',
        ui_group_order: 10,
        ui_field_order: 20,
        scope_mode: 'all',
        examples_json: null,
      });
      expect(result.status).toBe(200);
      const { set, where, sql } = applied(result.db);
      expect(set).toEqual({
        is_required: 1,
        is_active: 0,
        scope_mode: 'all',
        is_searchable: 0,
        is_exportable: 1,
        is_vc_claim: 1,
        display_order: 4,
        show_on_registration: 1,
        registration_required: 0,
        registration_order: 2,
        registration_placeholder: null,
        ui_group_key: null,
        ui_group_label: null,
        ui_group_order: 10,
        ui_field_order: 20,
        examples_json: null,
        active_field_key: null,
        updated_at: 1767225600,
      });
      expect(where).toEqual(['schema-1', 'test-tenant', 'active']);
      expect(sql).toContain('WHERE id = ? AND tenant_id = ? AND operation_status IN (?)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stores a normalized namespace, an explicit null namespace, and normalized examples', async () => {
    const set = applied(
      (
        await update({
          claim_namespace: 'https://example.com/ns//',
          examples_json: '["a" , "b"]',
          ui_group_key: 'contact',
          ui_group_label: 'Contact',
        })
      ).db
    ).set;
    expect(set.claim_namespace).toBe('https://example.com/ns/');
    expect(set.examples_json).toBe('["a","b"]');
    expect(set.ui_group_key).toBe('contact');
    expect(set.ui_group_label).toBe('Contact');
    expect(applied((await update({ claim_namespace: null })).db).set.claim_namespace).toBeNull();
    expect(applied((await update({ claim_namespace: '  ' })).db).set.claim_namespace).toBeNull();
  });

  it('answers the updated schema, audits the changed keys and records history', async () => {
    const result = await update({
      display_label: 'New',
      is_pii: false,
      field_key: 'employee_id',
    });
    expect(result.status).toBe(200);
    expect(result.body.schema.id).toBe('schema-1');
    expect(libCore.audit).toHaveBeenCalledWith(
      expect.anything(),
      'update',
      'custom_claim_schema',
      'schema-1',
      { changes: ['display_label'] }
    );
    expect(libCore.history.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaId: 'schema-1',
        operation: 'update',
        actorId: 'admin-1',
        actorType: 'admin',
        changeSource: 'admin_api',
      })
    );
    expect(libCore.invalidate).toHaveBeenCalledWith('test-tenant');
  });

  it('still answers 200 when history cannot be recorded', async () => {
    libCore.history.recordChange.mockRejectedValue(new Error('history down'));
    expect((await update({ display_label: 'New' })).status).toBe(200);
  });

  it('answers 500 when the guarded update matches no row', async () => {
    const db = setup();
    db.state.rowsAffected = () => 0;
    const result = await update({ display_label: 'New' }, db);
    expect(result.status).toBe(500);
    expect(libCore.audit).not.toHaveBeenCalled();
  });
});
