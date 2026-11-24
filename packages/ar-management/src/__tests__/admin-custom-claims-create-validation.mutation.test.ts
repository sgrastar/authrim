/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- admin API response bodies and hono/vi fakes are untyped in these route tests */
/**
 * Mutation-focused tests for the create handler's input validation: every refusal names the field
 * and the reason it gives, nothing is written for a refused request, and the accepted forms are
 * stored normalized.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/custom-claims-mutation-harness')).buildLibCoreOverride(
    importOriginal as never
  )
);

import { adminCustomClaimCreateHandler } from '../admin-custom-claims';
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

function setup() {
  const db = createClaimsDb();
  db.state.schema = schemaRow({ id: 'new-id', field_key: 'dept_code' });
  return db;
}

async function create(body: unknown, db = setup()) {
  const c = createClaimsContext({ db: db.adapter, body });
  const result = await read(await adminCustomClaimCreateHandler(c));
  return { ...result, db };
}

const valid = (extra: Row = {}) => ({ field_key: 'dept_code', display_label: 'Dept', ...extra });

/** The column -> value map of the INSERT the handler made. */
function inserted(db: ReturnType<typeof setup>): Record<string, unknown> {
  const insert = db.state.executes.find((entry) =>
    entry.sql.startsWith('INSERT INTO custom_claim')
  );
  expect(insert).toBeDefined();
  const columns = must(/\(([^)]*)\) VALUES/.exec(must(insert).sql))[1]
    .split(',')
    .map((name) => name.trim());
  return Object.fromEntries(columns.map((name, index) => [name, must(insert).params[index]]));
}

function expectRefused(
  result: Awaited<ReturnType<typeof create>>,
  field: string,
  reason: string | RegExp
) {
  expect(result.status).toBe(400);
  expect(result.body.error_code).toBe(FORMAT);
  expect(libCore.errors).toHaveLength(1);
  expect(libCore.errors[0].code).toBe(FORMAT);
  expect(libCore.errors[0].variables?.field).toBe(field);
  if (typeof reason === 'string') expect(libCore.errors[0].variables?.reason).toBe(reason);
  else expect(String(libCore.errors[0].variables?.reason)).toMatch(reason);
  expect(result.db.state.executes).toHaveLength(0);
}

describe('custom claim create: request validation', () => {
  beforeEach(() => resetLibCore());

  it('refuses a system claim with 403 and writes nothing', async () => {
    const result = await create(valid({ is_system: true }));
    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: 'forbidden',
      error_description: 'System claims can only be created via migration',
    });
    expect(result.db.state.executes).toHaveLength(0);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', 42],
  ])('requires a display_label (%s)', async (_name, label) => {
    const result = await create({ field_key: 'dept_code', display_label: label });
    expectRefused(result, 'display_label', 'display_label is required');
  });

  it('refuses a display_label of 256 characters but accepts 255', async () => {
    expectRefused(
      await create(valid({ display_label: 'x'.repeat(256) })),
      'display_label',
      'display_label must be at most 255 characters'
    );
    libCore.errors = [];
    const ok = await create(valid({ display_label: 'x'.repeat(255) }));
    expect(ok.status).toBe(201);
    expect(inserted(ok.db).display_label).toBe('x'.repeat(255));
  });

  it.each([
    ['a number', 5],
    ['a string over 2000 characters', 'd'.repeat(2001)],
  ])('refuses a description that is %s', async (_name, description) => {
    expectRefused(
      await create(valid({ description })),
      'description',
      'description must be a string of at most 2000 characters'
    );
  });

  it('accepts a description of exactly 2000 characters and stores null for none', async () => {
    const long = await create(valid({ description: 'd'.repeat(2000) }));
    expect(inserted(long.db).description).toBe('d'.repeat(2000));
    const none = await create(valid({ description: null }));
    expect(inserted(none.db).description).toBeNull();
  });

  it('refuses an unknown field_type and lists the valid ones', async () => {
    expectRefused(
      await create(valid({ field_type: 'uuid' })),
      'field_type',
      'Must be one of: string, number, boolean, date, enum'
    );
  });

  it('refuses an unknown cardinality and lists the valid ones', async () => {
    expectRefused(
      await create(valid({ cardinality: 'many' })),
      'cardinality',
      'Must be one of: single, multi'
    );
  });

  it('stores single cardinality and string type by default, multi when asked', async () => {
    const defaults = inserted((await create(valid())).db);
    expect(defaults.cardinality).toBe('single');
    expect(defaults.field_type).toBe('string');
    expect(inserted((await create(valid({ cardinality: 'multi' }))).db).cardinality).toBe('multi');
  });
});

describe('custom claim create: validation_rules per field type', () => {
  beforeEach(() => resetLibCore());

  const refusals: Array<[string, string, unknown, string]> = [
    ['string', 'an array', ['a'], 'validation_rules must be an object'],
    ['string', 'a string', 'x', 'validation_rules must be an object'],
    ['string', 'an unknown key', { foo: 1 }, 'Unknown string validation key: foo'],
    [
      'string',
      'a negative min_length',
      { min_length: -1 },
      'min_length must be a non-negative number',
    ],
    [
      'string',
      'a non-numeric min_length',
      { min_length: '1' },
      'min_length must be a non-negative number',
    ],
    ['string', 'a zero max_length', { max_length: 0 }, 'max_length must be a positive number'],
    [
      'string',
      'a non-numeric max_length',
      { max_length: 'x' },
      'max_length must be a positive number',
    ],
    [
      'string',
      'min_length above max_length',
      { min_length: 5, max_length: 4 },
      'min_length cannot exceed max_length',
    ],
    ['string', 'a non-string pattern', { pattern: 5 }, 'pattern must be a string'],
    ['number', 'an unknown key', { max_length: 1 }, 'Unknown number validation key: max_length'],
    ['number', 'a non-numeric min', { min: '1' }, 'min must be a number'],
    ['number', 'a non-numeric max', { max: '9' }, 'max must be a number'],
    ['number', 'min above max', { min: 10, max: 1 }, 'min cannot exceed max'],
    ['date', 'an unknown key', { min: 1 }, 'Unknown date validation key: min'],
    [
      'date',
      'a non-string min_date',
      { min_date: 20200101 },
      'min_date must be a string (ISO 8601)',
    ],
    [
      'date',
      'a non-string max_date',
      { max_date: 20200101 },
      'max_date must be a string (ISO 8601)',
    ],
    ['boolean', 'any rule', { min: 1 }, 'boolean type does not support validation rules'],
    ['enum', 'an unknown key', { foo: 1 }, 'Unknown enum validation key: foo'],
    ['enum', 'no values', { enum_values: [] }, 'enum_values must be a non-empty array'],
  ];

  it.each(refusals)('refuses %s rules with %s', async (fieldType, _what, rules, reason) => {
    expectRefused(
      await create(valid({ field_type: fieldType, validation_rules: rules })),
      'validation_rules',
      reason
    );
  });

  it.each([
    ['a nested quantifier (a+)+', '(a+)+'],
    ['a nested quantifier in a non-capturing group', '(?:a+)*'],
    ['an overlapping alternation', '(a|a)+'],
    ['adjacent quantifiers', 'a**'],
    ['a pattern over 128 characters', 'a'.repeat(129)],
    ['a pattern that does not compile', '(unclosed'],
  ])('refuses a string pattern with %s', async (_name, pattern) => {
    expectRefused(
      await create(valid({ validation_rules: { pattern } })),
      'validation_rules',
      'pattern is invalid or potentially unsafe (max 128 chars, no nested quantifiers)'
    );
  });

  it.each([
    ['string', { min_length: 0, max_length: 10, pattern: '^[a-z]+$' }],
    ['string', { min_length: 3, max_length: 3 }],
    ['number', { min: 1, max: 1 }],
    ['number', { min: -5 }],
    ['date', { min_date: '2020-01-01', max_date: '2030-01-01' }],
    ['boolean', {}],
    ['enum', { enum_values: [' red ', 'blue'] }],
  ])('accepts valid %s rules and stores them as JSON', async (fieldType, rules) => {
    const result = await create(valid({ field_type: fieldType, validation_rules: rules }));
    expect(result.status).toBe(201);
    const stored = JSON.parse(String(inserted(result.db).validation_rules));
    expect(stored).toEqual(fieldType === 'enum' ? { enum_values: ['red', 'blue'] } : rules);
  });

  it('accepts a pattern of exactly 128 characters', async () => {
    const result = await create(valid({ validation_rules: { pattern: 'a'.repeat(128) } }));
    expect(result.status).toBe(201);
  });

  it('measures the stored rules against a 4KB limit for non-enum types', async () => {
    const refused = await create(
      valid({ field_type: 'date', validation_rules: { min_date: 'x'.repeat(4096) } })
    );
    expectRefused(refused, 'validation_rules', 'validation_rules JSON must be at most 4KB');
    libCore.errors = [];
    const accepted = await create(
      valid({ field_type: 'date', validation_rules: { min_date: 'x'.repeat(4000) } })
    );
    expect(accepted.status).toBe(201);
  });

  it('measures multi-byte rules in UTF-8 bytes, not characters', async () => {
    // 1500 characters of 3 bytes each is 4500 bytes: over the limit though under 4096 characters.
    const refused = await create(
      valid({ field_type: 'date', validation_rules: { min_date: '日'.repeat(1500) } })
    );
    expectRefused(refused, 'validation_rules', 'validation_rules JSON must be at most 4KB');
  });

  it('stores no rules when none are given', async () => {
    const result = await create(valid({ validation_rules: null }));
    expect(inserted(result.db).validation_rules).toBeNull();
  });
});

describe('custom claim create: scopes, namespace and presentation', () => {
  beforeEach(() => resetLibCore());

  it('refuses required_scopes that is not an array', async () => {
    expectRefused(
      await create(valid({ required_scopes: 'openid' })),
      'required_scopes',
      'Must be an array of strings'
    );
  });

  it('refuses more than 50 required scopes but accepts exactly 50', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `scope${i}`);
    expectRefused(
      await create(valid({ required_scopes: many })),
      'required_scopes',
      'required_scopes must have at most 50 items'
    );
    libCore.errors = [];
    const ok = await create(valid({ required_scopes: many.slice(0, 50) }));
    expect(ok.status).toBe(201);
    expect(JSON.parse(String(inserted(ok.db).required_scopes))).toHaveLength(50);
  });

  it.each([
    ['an empty string', ['openid', '']],
    ['a number', ['openid', 5]],
    ['null', [null]],
  ])('refuses a scope list holding %s', async (_name, scopes) => {
    expectRefused(
      await create(valid({ required_scopes: scopes })),
      'required_scopes',
      'Each scope must be a non-empty string'
    );
  });

  it('stores scopes and the scope mode; any is the default and all is accepted', async () => {
    const all = await create(valid({ required_scopes: ['a', 'b'], scope_mode: 'all' }));
    expect(inserted(all.db)).toMatchObject({ required_scopes: '["a","b"]', scope_mode: 'all' });
    const none = await create(valid());
    expect(inserted(none.db)).toMatchObject({ required_scopes: null, scope_mode: 'any' });
  });

  it('refuses a scope_mode other than all or any', async () => {
    expectRefused(
      await create(valid({ scope_mode: 'none' })),
      'scope_mode',
      "Must be 'all' or 'any'"
    );
  });

  it.each([
    [
      'too long',
      `https://${'a'.repeat(250)}.example`,
      'claim_namespace must be at most 255 characters',
    ],
    ['without a scheme', 'example.com/ns', 'claim_namespace must start with http:// or https://'],
    [
      'with another scheme',
      'ftp://example.com/',
      'claim_namespace must start with http:// or https://',
    ],
  ])('refuses a claim_namespace that is %s', async (_name, namespace, reason) => {
    expectRefused(await create(valid({ claim_namespace: namespace })), 'claim_namespace', reason);
  });

  it.each([
    ['https://example.com/claims', 'https://example.com/claims/'],
    ['https://example.com/claims///', 'https://example.com/claims/'],
    ['  http://example.com  ', 'http://example.com/'],
    ['   ', null],
    ['', null],
  ])('normalizes the namespace %j to %j', async (namespace, expected) => {
    const result = await create(valid({ claim_namespace: namespace }));
    expect(result.status).toBe(201);
    expect(inserted(result.db).claim_namespace).toBe(expected);
  });

  it('accepts a namespace of exactly 255 characters', async () => {
    const namespace = `https://${'a'.repeat(247)}`;
    expect(namespace).toHaveLength(255);
    const result = await create(valid({ claim_namespace: namespace }));
    expect(inserted(result.db).claim_namespace).toBe(`${namespace}/`);
  });

  it.each([
    ['upper case', 'Group'],
    ['starting with a digit', '1group'],
    ['over 64 characters', `a${'b'.repeat(64)}`],
    ['not a string', 12],
  ])('refuses a ui_group_key that is %s', async (_name, key) => {
    expectRefused(
      await create(valid({ ui_group_key: key })),
      'ui_group_key',
      'ui_group_key must be lower-case and at most 64 characters'
    );
  });

  it.each([
    ['over 100 characters', 'l'.repeat(101)],
    ['not a string', 7],
  ])('refuses a ui_group_label that is %s', async (_name, label) => {
    expectRefused(
      await create(valid({ ui_group_label: label })),
      'ui_group_label',
      'ui_group_label must be a string of at most 100 characters'
    );
  });

  it('stores group metadata, truncating orders and falling back to display_order', async () => {
    const result = await create(
      valid({
        ui_group_key: 'work-info',
        ui_group_label: 'l'.repeat(100),
        ui_group_order: 7.9,
        display_order: 12.7,
      })
    );
    expect(inserted(result.db)).toMatchObject({
      ui_group_key: 'work-info',
      ui_group_label: 'l'.repeat(100),
      ui_group_order: 7,
      ui_field_order: 12,
      display_order: 12.7,
    });
    const explicit = await create(valid({ ui_field_order: 3.2, display_order: 50 }));
    expect(inserted(explicit.db)).toMatchObject({ ui_field_order: 3, ui_group_order: 90 });
  });

  it('defaults orders when none are numbers', async () => {
    const result = await create(
      valid({ ui_group_order: 'x', ui_field_order: NaN, display_order: Infinity })
    );
    expect(inserted(result.db)).toMatchObject({ ui_group_order: 90, ui_field_order: 100 });
  });

  it('stores registration settings and the flags as 0/1', async () => {
    const result = await create(
      valid({
        show_on_registration: 1,
        registration_required: true,
        registration_order: 4,
        registration_placeholder: 'e.g. 42',
        is_pii: true,
        is_required: true,
        is_searchable: false,
        is_exportable: false,
        is_vc_claim: true,
      })
    );
    expect(inserted(result.db)).toMatchObject({
      show_on_registration: 1,
      registration_required: 1,
      registration_order: 4,
      registration_placeholder: 'e.g. 42',
      is_pii: 1,
      is_required: 1,
      is_searchable: 0,
      is_exportable: 0,
      is_vc_claim: 1,
      is_active: 1,
    });
    const defaults = inserted((await create(valid())).db);
    expect(defaults).toMatchObject({
      show_on_registration: 0,
      registration_required: 0,
      registration_order: 0,
      registration_placeholder: null,
      is_pii: 0,
      is_searchable: 1,
      is_exportable: 1,
      is_vc_claim: 0,
      display_order: 100,
      schema_version: 1,
      operation_status: 'active',
      include_in_id_token: 0,
      include_in_userinfo: 0,
      include_in_introspection: 0,
    });
  });
});

describe('custom claim create: examples_json', () => {
  beforeEach(() => resetLibCore());

  const deep = (levels: number): unknown => {
    let value: unknown = 'leaf';
    for (let i = 0; i < levels; i += 1) value = [value];
    return value;
  };
  const circular = (() => {
    const loop: unknown[] = [];
    loop.push(loop);
    return loop;
  })();

  it.each([
    ['invalid JSON text', '{not json', 'examples_json must be valid JSON'],
    [
      'more than 500 nodes',
      Array.from({ length: 6 }, () => Array.from({ length: 99 }, () => 1)),
      'examples_json must contain at most 500 JSON nodes',
    ],
    ['nesting deeper than 8 levels', deep(10), 'examples_json must be at most 8 levels deep'],
    [
      'a string over 512 characters',
      ['x'.repeat(513)],
      'examples_json string values must be at most 512 characters',
    ],
    [
      'more than 100 array items',
      Array.from({ length: 101 }, () => 1),
      'examples_json arrays must contain at most 100 items',
    ],
    [
      'more than 100 object keys',
      Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, 1])),
      'examples_json objects must contain at most 100 keys',
    ],
    ['a circular reference', { a: circular }, 'examples_json must not contain circular references'],
    [
      'more than 8192 bytes',
      Array.from({ length: 20 }, () => 'y'.repeat(500)),
      'examples_json must be at most 8192 bytes',
    ],
    ['a value JSON cannot serialize', { n: 10n }, 'examples_json must be serializable JSON'],
  ])('refuses examples with %s', async (_name, examples, reason) => {
    expectRefused(await create(valid({ examples_json: examples })), 'examples_json', reason);
  });

  it('accepts a string of exactly 512 characters, 100 items, 100 keys and 8 levels', async () => {
    const boundary = {
      text: 'x'.repeat(512),
      list: Array.from({ length: 100 }, () => 0),
      nest: deep(7),
    };
    const result = await create(valid({ examples_json: boundary }));
    expect(result.status).toBe(201);
    expect(JSON.parse(String(inserted(result.db).examples_json))).toEqual(boundary);
    const keys = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 1]));
    expect((await create(valid({ examples_json: keys }))).status).toBe(201);
  });

  it('parses examples given as JSON text and stores them compactly', async () => {
    const result = await create(valid({ examples_json: '[ "a", "b" ]' }));
    expect(inserted(result.db).examples_json).toBe('["a","b"]');
  });

  it('stores null when no examples are given', async () => {
    expect(inserted((await create(valid({ examples_json: null }))).db).examples_json).toBeNull();
  });
});

describe('custom claim create: outcome', () => {
  beforeEach(() => resetLibCore());

  it('refuses a field_key that an active schema already uses', async () => {
    const db = setup();
    db.state.conflict = schemaRow({ id: 'other' });
    const result = await create(valid(), db);
    expectRefused(
      result,
      'field_key',
      "An active schema with field_key 'dept_code' already exists"
    );
  });

  it.each([
    [{ field_key: '', display_label: 'x' }, 'field_key is required'],
    [{ field_key: 7, display_label: 'x' }, 'field_key is required'],
    [
      { field_key: 'Dept', display_label: 'x' },
      'Must be snake_case, start with a letter, and be at most 64 characters',
    ],
    [
      { field_key: 'email', display_label: 'x' },
      "'email' is a reserved or built-in profile field name",
    ],
  ])('refuses the field_key in %j', async (body, reason) => {
    expectRefused(await create(body), 'field_key', reason);
  });

  it('records the schema, who made it, the audit entry and the history, and answers 201', async () => {
    libCore.generatedIds = ['new-id'];
    const result = await create(valid({ field_type: 'number', is_pii: true }));
    expect(result.status).toBe(201);
    expect(result.body.schema.id).toBe('new-id');
    expect(inserted(result.db)).toMatchObject({
      id: 'new-id',
      tenant_id: 'test-tenant',
      field_key: 'dept_code',
      created_by: 'admin-1',
    });
    expect(libCore.audit).toHaveBeenCalledWith(
      expect.anything(),
      'create',
      'custom_claim_schema',
      'new-id',
      { field_key: 'dept_code', field_type: 'number', is_pii: 1 }
    );
    expect(libCore.history.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaId: 'new-id',
        tenantId: 'test-tenant',
        operation: 'create',
        previousSnapshot: null,
        actorId: 'admin-1',
        actorType: 'admin',
        changeSource: 'admin_api',
      })
    );
    expect(libCore.invalidate).toHaveBeenCalledWith('test-tenant');
  });

  it('still answers 201 when the history cannot be recorded', async () => {
    libCore.history.recordChange.mockRejectedValue(new Error('history down'));
    const result = await create(valid());
    expect(result.status).toBe(201);
  });

  it('answers 500 and records nothing further when the insert fails', async () => {
    const db = setup();
    db.state.failOn = (sql) => (sql.startsWith('INSERT') ? new Error('db down') : null);
    const result = await create(valid(), db);
    expect(result.status).toBe(500);
    expect(libCore.audit).not.toHaveBeenCalled();
  });
});
