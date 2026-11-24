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

describe('custom claim update: enum choices users hold', () => {
  beforeEach(() => resetLibCore());

  const enumSchema = (extra: Row = {}) =>
    schemaRow({
      field_type: 'enum',
      validation_rules: '{"enum_values":["a","b","c"]}',
      ...extra,
    });

  it('refuses narrower choices while a user holds a removed value', async () => {
    libCore.nonPiiStores = ['core-1'];
    libCore.heldValues.mockResolvedValue({ complete: true, counts: new Map([['c', 2]]) });
    const result = await update(
      { validation_rules: { enum_values: ['a', 'b'] } },
      setup(enumSchema())
    );
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'enum_value_in_use',
      error_description: 'Users hold values that the new choices do not allow.',
      reason: 'held',
      values: [{ value: 'c', users: 2 }],
    });
    expect(libCore.heldValues).toHaveBeenCalledWith(
      'core-1',
      'test-tenant',
      'employee_id',
      ['a', 'b'],
      'single',
      {
        limit: 20,
      }
    );
    expect(result.db.state.executes).toHaveLength(0);
  });

  it('allows narrower choices when no held value is left out', async () => {
    libCore.nonPiiStores = ['core-1'];
    libCore.heldValues.mockResolvedValue({ complete: true, counts: new Map() });
    const result = await update(
      { validation_rules: { enum_values: ['a', 'b'] } },
      setup(enumSchema())
    );
    expect(result.status).toBe(200);
  });

  it('refuses when a store is too large to verify', async () => {
    libCore.nonPiiStores = ['core-1'];
    libCore.heldValues.mockResolvedValue({ complete: false, counts: new Map() });
    const result = await update({ validation_rules: { enum_values: ['a'] } }, setup(enumSchema()));
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'enum_value_in_use',
      error_description:
        'The attribute has too many users to check its values; the choices were not narrowed.',
      reason: 'unverifiable',
      values: [],
    });
  });

  it('counts the reported values again in every store when there are several', async () => {
    libCore.nonPiiStores = ['s1', 's2'];
    libCore.heldValues.mockImplementation(
      async (db: string, _t: string, _f: string, _a: string[], _c: string, options: Row) => {
        if (options.only) {
          return {
            complete: true,
            counts: new Map([[db === 's1' ? 'c' : 'c', db === 's1' ? 1 : 2]]),
          };
        }
        return { complete: true, counts: new Map([[db === 's1' ? 'c' : 'd', 1]]) };
      }
    );
    const result = await update(
      { validation_rules: { enum_values: ['a', 'b'] } },
      setup(enumSchema())
    );
    expect(result.status).toBe(409);
    expect(result.body.values).toEqual([{ value: 'c', users: 3 }]);
    const recounts = libCore.heldValues.mock.calls.filter(([, , , , , options]) => options.only);
    expect(recounts).toHaveLength(2);
    expect(recounts[0][5]).toEqual({ only: ['c', 'd'] });
  });

  it('refuses the recount when a store cannot be read in full', async () => {
    libCore.nonPiiStores = ['s1', 's2'];
    libCore.heldValues.mockImplementation(async (_db: string, ...rest: unknown[]) => {
      const options = rest[4] as Row;
      return options.only
        ? { complete: false, counts: new Map() }
        : { complete: true, counts: new Map([['c', 1]]) };
    });
    const result = await update({ validation_rules: { enum_values: ['a'] } }, setup(enumSchema()));
    expect(result.status).toBe(409);
    expect(result.body.reason).toBe('unverifiable');
  });

  it('allows the narrowing when the recount finds no holders', async () => {
    libCore.nonPiiStores = ['s1', 's2'];
    libCore.heldValues.mockImplementation(async (_db: string, ...rest: unknown[]) => {
      const options = rest[4] as Row;
      return options.only
        ? { complete: true, counts: new Map([['zzz', 4]]) }
        : { complete: true, counts: new Map([['c', 1]]) };
    });
    const result = await update({ validation_rules: { enum_values: ['a'] } }, setup(enumSchema()));
    expect(result.status).toBe(200);
  });

  it('refuses narrowing an encrypted attribute while any user holds it', async () => {
    libCore.piiStores = ['pii-1', 'pii-2'];
    libCore.countPiiField.mockResolvedValueOnce(0).mockResolvedValueOnce(3);
    const result = await update(
      { validation_rules: { enum_values: ['a'] } },
      setup(enumSchema({ is_pii: 1 }))
    );
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'enum_value_in_use',
      error_description:
        'The attribute is encrypted, so its users cannot be counted by value; narrow its choices only while no user holds the attribute.',
      reason: 'encrypted',
      values: [],
      holders: 3,
    });
    expect(libCore.heldValues).not.toHaveBeenCalled();
  });

  it('allows narrowing an encrypted attribute nobody holds', async () => {
    libCore.piiStores = ['pii-1'];
    libCore.countPiiField.mockResolvedValue(0);
    const result = await update(
      { validation_rules: { enum_values: ['a'] } },
      setup(enumSchema({ is_pii: true }))
    );
    expect(result.status).toBe(200);
  });

  it('does not look at users when the choices only grow or reorder', async () => {
    libCore.nonPiiStores = ['core-1'];
    const grow = await update(
      { validation_rules: { enum_values: ['a', 'b', 'c', 'd'] } },
      setup(enumSchema())
    );
    expect(grow.status).toBe(200);
    expect(libCore.heldValues).not.toHaveBeenCalled();
  });

  it('treats constraining a free enum, or turning a field into an enum, as narrowing', async () => {
    libCore.nonPiiStores = ['core-1'];
    libCore.heldValues.mockResolvedValue({ complete: true, counts: new Map([['x', 1]]) });
    const free = await update(
      { validation_rules: { enum_values: ['a'] } },
      setup(schemaRow({ field_type: 'enum', validation_rules: null }))
    );
    expect(free.status).toBe(409);
    const converted = await update(
      { field_type: 'enum', validation_rules: { enum_values: ['a'] } },
      setup(schemaRow({ field_type: 'string' }))
    );
    expect(converted.status).toBe(409);
  });

  it('uses multi cardinality when reading values of a multi attribute', async () => {
    libCore.nonPiiStores = ['core-1'];
    libCore.heldValues.mockResolvedValue({ complete: true, counts: new Map() });
    await update(
      { validation_rules: { enum_values: ['a'] } },
      setup(enumSchema({ cardinality: 'multi' }))
    );
    expect(libCore.heldValues.mock.calls[0][4]).toBe('multi');
  });
});

describe('custom claim update: cardinality fence', () => {
  beforeEach(() => resetLibCore());

  const fenceStatement = (db: Db) =>
    db.state.executes.find((entry) => entry.sql.includes("operation_status = 'reconfiguring'"));

  it('fences, counts stored values and changes cardinality when none exist', async () => {
    libCore.nonPiiStores = ['core-1'];
    libCore.countNonPiiField.mockResolvedValue(0);
    const db = setup();
    const result = await update({ cardinality: 'multi' }, db);
    expect(result.status).toBe(200);
    const fence = must(fenceStatement(db));
    expect(fence.params.slice(2)).toEqual(['schema-1', 'test-tenant', 'single']);
    expect(JSON.parse(String(fence.params[0]))).toMatchObject({
      operation: 'cardinality_change',
      from: 'single',
      to: 'multi',
    });
    const { set, where } = applied(db);
    expect(set).toMatchObject({
      cardinality: 'multi',
      operation_status: 'active',
      operation_detail: null,
    });
    expect(where).toEqual(['schema-1', 'test-tenant', 'reconfiguring']);
    expect(libCore.countNonPiiField).toHaveBeenCalledWith('core-1', 'test-tenant', 'employee_id');
  });

  it('counts an encrypted attribute in the PII stores', async () => {
    libCore.piiStores = ['pii-1'];
    libCore.countPiiField.mockResolvedValue(0);
    const result = await update({ cardinality: 'multi' }, setup(schemaRow({ is_pii: 1 })));
    expect(result.status).toBe(200);
    expect(libCore.countPiiField).toHaveBeenCalledWith('pii-1', 'test-tenant', 'employee_id');
    expect(libCore.countNonPiiField).not.toHaveBeenCalled();
  });

  it('does not fence when the cardinality is unchanged', async () => {
    const db = setup(schemaRow({ cardinality: 'multi' }));
    const result = await update({ cardinality: 'multi', display_label: 'x' }, db);
    expect(result.status).toBe(200);
    expect(fenceStatement(db)).toBeUndefined();
  });

  it('answers 409 when the schema changed concurrently, and writes nothing further', async () => {
    const db = setup();
    db.state.rowsAffected = (sql) => (sql.includes("'reconfiguring'") ? 0 : 1);
    const result = await update({ cardinality: 'multi' }, db);
    expect(result.status).toBe(409);
    expect(libCore.errors.at(-1)).toEqual({
      code: 'AR060005',
      variables: {
        field: 'operation_status',
        reason: 'Schema changed concurrently. Reload it and retry.',
      },
    });
    expect(db.state.executes).toHaveLength(1);
  });

  it('releases the fence and answers 409 while values are stored', async () => {
    libCore.nonPiiStores = ['core-1'];
    libCore.countNonPiiField.mockResolvedValue(4);
    const db = setup();
    const result = await update({ cardinality: 'multi' }, db);
    expect(result.status).toBe(409);
    expect(libCore.errors.at(-1)?.variables).toEqual({
      field: 'cardinality',
      reason:
        'Cardinality cannot be changed while stored values exist. Remove or migrate the field data first.',
    });
    const release = must(db.state.executes.at(-1));
    expect(release.sql).toContain('SET operation_status = ?, operation_detail = ?, updated_at = ?');
    expect(release.params.slice(0, 2)).toEqual(['active', null]);
    expect(release.params.slice(-3)).toEqual(['schema-1', 'test-tenant', 'reconfiguring']);
    expect(db.state.executes.filter((entry) => entry.sql.includes('SET cardinality'))).toHaveLength(
      0
    );
  });

  it('releases the fence when the final update fails, and answers 500', async () => {
    libCore.nonPiiStores = ['core-1'];
    libCore.countNonPiiField.mockResolvedValue(0);
    const db = setup();
    db.state.rowsAffected = (sql) => (sql.includes('SET cardinality') ? 0 : 1);
    const result = await update({ cardinality: 'multi' }, db);
    expect(result.status).toBe(500);
    const release = must(db.state.executes.at(-1));
    expect(release.sql.startsWith('UPDATE custom_claim_schemas SET operation_status = ?')).toBe(
      true
    );
    expect(release.params.slice(0, 2)).toEqual(['active', null]);
    expect(release.params.slice(-1)).toEqual(['reconfiguring']);
    expect(libCore.invalidate).toHaveBeenCalledTimes(2);
  });

  it('still answers 500 when releasing the fence also fails', async () => {
    libCore.nonPiiStores = ['core-1'];
    libCore.countNonPiiField.mockResolvedValue(0);
    const db = setup();
    db.state.rowsAffected = (sql) => (sql.includes('SET cardinality') ? 0 : 1);
    let updates = 0;
    db.state.failOn = (sql) => {
      if (sql.startsWith('UPDATE')) updates += 1;
      return updates >= 3 ? new Error('release failed') : null;
    };
    const result = await update({ cardinality: 'multi' }, db);
    expect(result.status).toBe(500);
  });
});
