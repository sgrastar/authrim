import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSource, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  listSchemas: vi.fn(),
  persist: vi.fn(),
  sources: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    listRegistrationFieldSchemas: mocks.listSchemas,
    persistCustomClaimWrite: mocks.persist,
    resolveCustomClaimRuntimeSourcesFromEnv: mocks.sources,
  };
});

import {
  persistRegistrationFieldValues,
  persistRegistrationFieldValuesFromEnv,
  validateRegistrationFieldSubmission,
  validateRegistrationFieldSubmissionFromEnv,
} from '../registration-field-utils';

const db = { name: 'core' } as unknown as DatabaseSource;
const piiDb = { name: 'pii' } as unknown as DatabaseSource;

function schema(fieldKey: string, fields: Record<string, unknown> = {}) {
  return {
    field_key: fieldKey,
    display_label: fieldKey.toUpperCase(),
    field_type: 'string',
    is_pii: 0,
    registration_required: 0,
    validation_rules: null,
    ...fields,
  };
}

async function validate(schemas: unknown[], submitted: unknown) {
  mocks.listSchemas.mockResolvedValue(schemas);
  return validateRegistrationFieldSubmission(
    db,
    'tenant-1',
    submitted as Record<string, unknown> | undefined
  );
}

const rules = (value: unknown) => JSON.stringify(value);

beforeEach(() => {
  mocks.listSchemas.mockReset().mockResolvedValue([]);
  mocks.persist.mockReset().mockResolvedValue(undefined);
  mocks.sources.mockReset();
});

describe('registration field validation', () => {
  it('lists the schemas including required hidden fields', async () => {
    await validate([], {});
    expect(mocks.listSchemas).toHaveBeenCalledWith(db, 'tenant-1', {
      includeRequiredHidden: true,
    });
  });

  it('does not read an array submission as field values', async () => {
    const result = await validate([schema('0', { registration_required: 1 })], ['value']);
    expect(result).toMatchObject({ ok: false, error: '0 is required' });
  });

  it.each([
    ['whitespace', '   '],
    ['an empty list', []],
    ['null', null],
  ])('treats %s as missing for a required field', async (_label, value) => {
    const result = await validate([schema('dept', { registration_required: 1 })], { dept: value });
    expect(result).toMatchObject({ ok: false, error: 'DEPT is required' });
  });

  it('keeps false and zero as present values', async () => {
    const result = await validate(
      [
        schema('agree', { registration_required: 1, field_type: 'boolean' }),
        schema('count', { registration_required: 1, field_type: 'number' }),
      ],
      { agree: false, count: 0 }
    );
    expect(result).toMatchObject({ ok: true, values: { agree: 'false', count: '0' } });
  });

  it('skips blank optional fields', async () => {
    const result = await validate([schema('dept'), schema('team')], { dept: ' ', team: 'core' });
    expect(result).toMatchObject({ ok: true, values: { team: 'core' } });
  });

  it.each([
    [true, 'true'],
    [false, 'false'],
    ['true', 'true'],
    ['false', 'false'],
  ])('accepts the boolean %j as %s', async (value, stored) => {
    const result = await validate([schema('agree', { field_type: 'boolean' })], { agree: value });
    expect(result).toMatchObject({ ok: true, values: { agree: stored } });
  });

  it('refuses a boolean that is not true or false', async () => {
    const result = await validate([schema('agree', { field_type: 'boolean' })], { agree: 'yes' });
    expect(result).toEqual({ ok: false, error: 'AGREE must be true or false' });
  });

  it.each([
    ['an object', { nested: 1 }],
    ['a list for a single value', ['a']],
  ])('refuses %s for a scalar field', async (_label, value) => {
    const result = await validate([schema('dept')], { dept: value });
    expect(result).toEqual({ ok: false, error: 'DEPT contains an invalid value' });
  });

  it.each([
    ['5', true, undefined],
    ['10', true, undefined],
    ['4', false, 'COUNT must be at least 5'],
    ['11', false, 'COUNT must be at most 10'],
    ['abc', false, 'COUNT must be a valid number'],
  ])('checks the number %s against min 5 / max 10', async (value, ok, error) => {
    const result = await validate(
      [schema('count', { field_type: 'number', validation_rules: rules({ min: 5, max: 10 }) })],
      { count: ` ${value} ` }
    );
    expect(result).toMatchObject(ok ? { ok, values: { count: value } } : { ok, error });
  });

  it('compares enum values only with the configured string options', async () => {
    const enumSchema = schema('tier', {
      field_type: 'enum',
      validation_rules: rules({ enum_values: ['gold', 1] }),
    });
    expect(await validate([enumSchema], { tier: ' gold ' })).toMatchObject({
      ok: true,
      values: { tier: 'gold' },
    });
    expect(await validate([enumSchema], { tier: '1' })).toEqual({
      ok: false,
      error: 'TIER must be one of the configured options',
    });
    const open = schema('tier', {
      field_type: 'enum',
      validation_rules: rules({ enum_values: 1 }),
    });
    expect(await validate([open], { tier: 'any' })).toMatchObject({ ok: true });
  });

  it.each([
    ['2026-01-01', true, undefined],
    ['2026-12-31', true, undefined],
    ['2025-12-31', false, 'BORN must be on or after 2026-01-01'],
    ['2027-01-01', false, 'BORN must be on or before 2026-12-31'],
    ['not a date', false, 'BORN must be a valid date'],
  ])('checks the date %s against its bounds', async (value, ok, error) => {
    const result = await validate(
      [
        schema('born', {
          field_type: 'date',
          validation_rules: rules({ min_date: '2026-01-01', max_date: '2026-12-31' }),
        }),
      ],
      { born: value }
    );
    expect(result).toMatchObject(ok ? { ok, values: { born: value } } : { ok, error });
  });

  it('ignores unparseable date bounds', async () => {
    const result = await validate(
      [
        schema('born', {
          field_type: 'date',
          validation_rules: rules({ min_date: 'x', max_date: 'y' }),
        }),
      ],
      { born: '2000-01-01' }
    );
    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    ['abc', true, undefined],
    ['abcde', true, undefined],
    ['ab', false, 'CODE must be at least 3 characters'],
    ['abcdef', false, 'CODE must be at most 5 characters'],
    ['ab1', false, 'CODE is in an invalid format'],
  ])('checks the string %s against length and pattern', async (value, ok, error) => {
    const result = await validate(
      [
        schema('code', {
          validation_rules: rules({ min_length: 3, max_length: 5, pattern: '^[a-z]+$' }),
        }),
      ],
      { code: value }
    );
    expect(result).toMatchObject(ok ? { ok, values: { code: value } } : { ok, error });
  });

  it('keeps the submitted string untrimmed and ignores an invalid pattern', async () => {
    const result = await validate([schema('code', { validation_rules: rules({ pattern: '(' }) })], {
      code: ' x ',
    });
    expect(result).toMatchObject({ ok: true, values: { code: ' x ' } });
  });

  it('ignores validation rules that are null or malformed', async () => {
    for (const validationRules of ['null', '{', '[1]']) {
      const result = await validate(
        [schema('count', { field_type: 'number', validation_rules: validationRules })],
        { count: '3' }
      );
      expect(result).toMatchObject({ ok: true, values: { count: '3' } });
    }
  });

  it('accepts up to 100 values for a multi-valued field and refuses more', async () => {
    const multi = schema('tags', { cardinality: 'multi' });
    const hundred = Array.from({ length: 100 }, (_, index) => `t${index}`);
    expect(await validate([multi], { tags: hundred })).toMatchObject({ ok: true });
    expect(await validate([multi], { tags: [...hundred, 'extra'] })).toEqual({
      ok: false,
      error: 'TAGS must have at most 100 values',
    });
    expect(await validate([multi], { tags: ['a', null] })).toEqual({
      ok: false,
      error: 'TAGS contains an invalid value',
    });
  });
});

describe('registration field persistence', () => {
  it('does nothing for absent or non-object values', async () => {
    await persistRegistrationFieldValues(db, piiDb, 'tenant-1', 'user-1', undefined);
    await persistRegistrationFieldValues(
      db,
      piiDb,
      'tenant-1',
      'user-1',
      'dept' as unknown as Record<string, unknown>
    );
    expect(mocks.listSchemas).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('does nothing when only fixed fields are configured', async () => {
    mocks.listSchemas.mockResolvedValue([schema('email'), schema('name')]);
    await persistRegistrationFieldValues(db, piiDb, 'tenant-1', 'user-1', { email: 'a@b.c' });
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('splits PII and non-PII values and describes every custom schema as active', async () => {
    const schemaDb = { name: 'schema' } as unknown as DatabaseSource;
    mocks.listSchemas.mockResolvedValue([
      schema('email'),
      schema('dept'),
      schema('ssn', { is_pii: 1 }),
      schema('nick', { is_pii: true }),
      schema('tags', { cardinality: 'multi' }),
      schema('codes', { cardinality: 'multi' }),
    ]);
    await persistRegistrationFieldValues(
      db,
      piiDb,
      'tenant-1',
      'user-1',
      { dept: 7, ssn: '123', nick: 'n', tags: ['a', 'b'], codes: '["x"]', unknown: 'skip' },
      schemaDb
    );
    expect(mocks.listSchemas).toHaveBeenCalledWith(schemaDb, 'tenant-1', {
      includeRequiredHidden: true,
    });
    const args = mocks.persist.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({
      db,
      dbPii: piiDb,
      schemaDb,
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
    const validation = args.validation as Record<string, unknown>;
    expect(validation).toMatchObject({
      ok: true,
      nonPiiValues: { dept: '7', tags: '["a","b"]', codes: '["x"]' },
      piiValues: { ssn: '123', nick: 'n' },
      nonPiiKeysToDelete: [],
      piiKeysToDelete: [],
    });
    const schemas = validation.schemas as Array<Record<string, unknown>>;
    expect(schemas.map((row) => [row.id, row.is_pii])).toEqual([
      ['tenant-1:dept', 0],
      ['tenant-1:ssn', 1],
      ['tenant-1:nick', 1],
      ['tenant-1:tags', 0],
      ['tenant-1:codes', 0],
    ]);
    expect(schemas[0]).toMatchObject({
      tenant_id: 'tenant-1',
      is_required: 0,
      is_active: 1,
      scope_mode: 'any',
      operation_status: 'active',
      schema_version: 1,
    });
  });

  it.each([
    ['a non-list JSON string', '{"a":1}'],
    ['an invalid JSON string', '['],
    ['a number', 3],
  ])('refuses %s for a multi-valued field', async (_label, value) => {
    mocks.listSchemas.mockResolvedValue([schema('tags', { cardinality: 'multi' })]);
    await expect(
      persistRegistrationFieldValues(db, piiDb, 'tenant-1', 'user-1', { tags: value })
    ).rejects.toThrow('registration_multi_value_not_serialized:tags');
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});

describe('registration fields from the environment', () => {
  const env = {} as Env;

  it('validates against the schema source of the tenant', async () => {
    const schemaDb = { name: 'schema' } as unknown as DatabaseSource;
    mocks.sources.mockResolvedValue({ schemaDb });
    await validateRegistrationFieldSubmissionFromEnv(env, 'tenant-1', {});
    expect(mocks.sources).toHaveBeenCalledWith(env, 'tenant-1');
    expect(mocks.listSchemas).toHaveBeenCalledWith(schemaDb, 'tenant-1', expect.anything());
  });

  it('persists through the account route of the user', async () => {
    const schemaDb = { name: 'schema' } as unknown as DatabaseSource;
    mocks.sources.mockResolvedValue({ schemaDb, nonPiiDb: db, piiDb });
    mocks.listSchemas.mockResolvedValue([schema('dept')]);
    await persistRegistrationFieldValuesFromEnv(env, 'tenant-1', 'user-1', { dept: 'x' });
    expect(mocks.sources).toHaveBeenCalledWith(env, 'tenant-1', { accountId: 'user-1' });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ db, dbPii: piiDb, schemaDb })
    );
  });

  it.each([
    ['core', { piiDb }],
    ['PII', { nonPiiDb: db }],
  ])('refuses an account route without its %s database', async (_label, sources) => {
    mocks.sources.mockResolvedValue({ schemaDb: db, ...sources });
    await expect(
      persistRegistrationFieldValuesFromEnv(env, 'tenant-1', 'user-1', { dept: 'x' })
    ).rejects.toThrow('registration_field_account_route_incomplete');
  });
});
