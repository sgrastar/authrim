/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- admin API response bodies and hono/vi fakes are untyped in these route tests */
/**
 * Mutation-focused tests for the custom claim delete, rename and retry handlers: every refusal,
 * the order of the writes (mark, move data, finish), the arguments given to the storage layer,
 * and the error states left behind for a retry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/custom-claims-mutation-harness')).buildLibCoreOverride(
    importOriginal as never
  )
);

import {
  adminCustomClaimDeleteHandler,
  adminCustomClaimRenameHandler,
  adminCustomClaimRetryHandler,
} from '../admin-custom-claims';
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

const NO_DERIVED = JSON.stringify({
  'authentication-methods.passkey.signup_enabled': false,
});

function setup(schema: Row | null = schemaRow()): Db {
  const db = createClaimsDb();
  db.state.schema = schema;
  libCore.schemaDb = db.adapter;
  libCore.nonPiiStores = ['n1', 'n2'];
  libCore.piiStores = ['p1'];
  libCore.deleteStored.mockResolvedValue({ affectedUsers: 1, processedUsers: 1, failedUsers: 0 });
  libCore.renameStored.mockResolvedValue({ affectedUsers: 2, processedUsers: 2, failedUsers: 0 });
  return db;
}

function context(db: Db, body: unknown = {}) {
  const kv = createKv();
  kv.store.set('settings:tenant:test-tenant:authentication-methods', NO_DERIVED);
  return createClaimsContext({ db: db.adapter, params: { id: 'schema-1' }, body, kv: kv.kv });
}

/** Each schema UPDATE as its SET map, the way the handler issued them. */
function updates(db: Db) {
  return db.state.executes
    .filter((entry) => entry.sql.startsWith('UPDATE custom_claim_schemas'))
    .map((entry) => {
      const columns = must(/SET (.*) WHERE/s.exec(entry.sql))[1].split(', ');
      const set: Row = {};
      let index = 0;
      for (const column of columns) {
        if (column.endsWith(' = ?')) set[column.replace(' = ?', '')] = entry.params[index++];
        else set[column] = true;
      }
      return { set, where: entry.params.slice(index), sql: entry.sql };
    });
}

describe('custom claim delete', () => {
  beforeEach(() => resetLibCore());

  const remove = async (db: Db) => ({
    ...(await read(await adminCustomClaimDeleteHandler(context(db)))),
    db,
  });

  it('answers 404 for an unknown schema', async () => {
    expect((await remove(setup(null))).status).toBe(404);
  });

  it('refuses system claims with 403', async () => {
    const result = await remove(setup(schemaRow({ is_system: 1 })));
    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: 'forbidden',
      error_description: 'System claims cannot be deleted',
    });
    expect(result.db.state.executes).toHaveLength(0);
  });

  it.each(['deleting', 'renaming', 'reconfiguring'])(
    'refuses while the schema is %s',
    async (status) => {
      const result = await remove(setup(schemaRow({ operation_status: status })));
      expect(result.status).toBe(400);
      expect(libCore.errors[0]).toEqual({
        code: 'AR130002',
        variables: { field: 'operation_status', reason: 'Schema is currently being modified' },
      });
      expect(result.db.state.executes).toHaveLength(0);
    }
  );

  it('refuses a field an authentication method needs, listing the bindings', async () => {
    const db = setup(schemaRow({ field_key: 'email' }));
    const kv = createKv();
    kv.store.set(
      'settings:tenant:test-tenant:authentication-methods',
      JSON.stringify({ 'authentication-methods.email_otp.login_enabled': true })
    );
    const c = createClaimsContext({ db: db.adapter, params: { id: 'schema-1' }, kv: kv.kv });
    const result = await read(await adminCustomClaimDeleteHandler(c));
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('field_in_use');
    expect(result.body.error_description).toBe(
      'This schema field is currently used by Authrim features and cannot be deleted.'
    );
    expect(result.body.usage_bindings.map((binding: Row) => binding.binding_id)).toEqual([
      'passkey.signup',
      'email_otp.login',
    ]);
    expect(db.state.executes).toHaveLength(0);
  });

  it('refuses when the schema changed state concurrently', async () => {
    const db = setup();
    db.state.rowsAffected = () => 0;
    const result = await remove(db);
    expect(result.status).toBe(400);
    expect(libCore.errors[0].variables).toEqual({
      field: 'operation_status',
      reason: 'Schema state changed concurrently. Please retry.',
    });
    expect(libCore.deleteStored).not.toHaveBeenCalled();
  });

  it('marks deleting, removes non-PII data from each store, then the schema', async () => {
    const db = setup();
    const result = await remove(db);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true, deleted_id: 'schema-1' });
    const [mark] = updates(db);
    expect(mark.set.operation_status).toBe('deleting');
    expect(mark.where).toEqual(['schema-1', 'test-tenant', 'active', 'error']);
    expect(libCore.deleteStored).toHaveBeenCalledTimes(2);
    expect(libCore.deleteStored).toHaveBeenCalledWith({
      db: 'n1',
      dbPii: undefined,
      tenantId: 'test-tenant',
      fieldKey: 'employee_id',
      isPii: false,
    });
    expect(libCore.deleteStored).toHaveBeenCalledWith(expect.objectContaining({ db: 'n2' }));
    const last = must(db.state.executes.at(-1));
    expect(last.sql).toBe('DELETE FROM custom_claim_schemas WHERE id = ? AND tenant_id = ?');
    expect(last.params).toEqual(['schema-1', 'test-tenant']);
    expect(libCore.audit).toHaveBeenCalledWith(
      expect.anything(),
      'delete',
      'custom_claim_schema',
      'schema-1',
      { field_key: 'employee_id', is_pii: 0 }
    );
    expect(libCore.history.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'delete',
        newSnapshot: { deleted: true, field_key: 'employee_id' },
        actorId: 'admin-1',
      })
    );
  });

  it('allows deleting a schema in the error state', async () => {
    expect((await remove(setup(schemaRow({ operation_status: 'error' })))).status).toBe(200);
  });

  it('removes PII data through the PII stores, in batches of 500', async () => {
    const db = setup(schemaRow({ is_pii: 1 }));
    const result = await remove(db);
    expect(result.status).toBe(200);
    expect(libCore.deleteStored).toHaveBeenCalledTimes(1);
    expect(libCore.deleteStored).toHaveBeenCalledWith({
      db: db.adapter,
      dbPii: 'p1',
      tenantId: 'test-tenant',
      fieldKey: 'employee_id',
      isPii: true,
      piiBatchSize: 500,
    });
  });

  it('keeps the schema in the error state when some PII users could not be cleared', async () => {
    libCore.history.recordChange.mockClear();
    const db = setup(schemaRow({ is_pii: 1 }));
    libCore.deleteStored.mockResolvedValue({ affectedUsers: 3, processedUsers: 5, failedUsers: 2 });
    const result = await remove(db);
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      success: false,
      error: 'Partial deletion: 2 user(s) failed. Schema marked as error state for retry.',
    });
    const [, failed] = updates(db);
    expect(failed.set.operation_status).toBe('error');
    expect(JSON.parse(String(failed.set.operation_detail))).toEqual({
      operation: 'delete',
      field_key: 'employee_id',
      error: 'Partial deletion: 2 user(s) failed out of 5',
      failed_users: 2,
      total_processed: 5,
    });
    expect(db.state.executes.some((entry) => entry.sql.startsWith('DELETE'))).toBe(false);
    expect(libCore.history.recordChange).not.toHaveBeenCalled();
  });

  it('marks the error and answers 500 when removing data throws', async () => {
    const db = setup();
    libCore.deleteStored.mockRejectedValue(new Error('storage exploded'));
    const result = await remove(db);
    expect(result.status).toBe(500);
    const [, failed] = updates(db);
    expect(failed.set.operation_status).toBe('error');
    expect(JSON.parse(String(failed.set.operation_detail))).toEqual({
      operation: 'delete',
      field_key: 'employee_id',
      error: 'storage exploded',
    });
    expect(db.state.executes.some((entry) => entry.sql.startsWith('DELETE'))).toBe(false);
  });

  it('records an unknown error when a non-Error was thrown', async () => {
    const db = setup();
    libCore.deleteStored.mockRejectedValue('plain string');
    await remove(db);
    expect(JSON.parse(String(updates(db)[1].set.operation_detail)).error).toBe('Unknown error');
  });

  it('answers 500 when the schema cannot be read', async () => {
    const db = setup();
    db.state.failOn = () => new Error('down');
    expect((await remove(db)).status).toBe(500);
  });
});

describe('custom claim rename', () => {
  beforeEach(() => resetLibCore());

  const rename = async (db: Db, body: unknown) => ({
    ...(await read(await adminCustomClaimRenameHandler(context(db, body)))),
    db,
  });

  it.each([
    [{}, 'new_field_key is required'],
    [{ new_field_key: 5 }, 'new_field_key is required'],
    [
      { new_field_key: 'Bad-Key' },
      'Must be snake_case, start with a letter, and be at most 64 characters',
    ],
    [{ new_field_key: 'email' }, "'email' is a reserved or built-in profile field name"],
  ])('refuses the new key in %j', async (body, reason) => {
    const result = await rename(setup(), body);
    expect(result.status).toBe(400);
    expect(libCore.errors[0].variables).toEqual({ field: 'new_field_key', reason });
    expect(result.db.state.executes).toHaveLength(0);
  });

  it('answers 404 for an unknown schema and 403 for a system claim', async () => {
    expect((await rename(setup(null), { new_field_key: 'emp_id' })).status).toBe(404);
    const system = await rename(setup(schemaRow({ is_system: true })), { new_field_key: 'emp_id' });
    expect(system.status).toBe(403);
    expect(system.body).toEqual({
      error: 'forbidden',
      error_description: 'System claims cannot be renamed',
    });
  });

  it('refuses while another operation runs, for the same key and for a conflicting key', async () => {
    const busy = await rename(setup(schemaRow({ operation_status: 'error' })), {
      new_field_key: 'emp_id',
    });
    expect(busy.status).toBe(400);
    expect(libCore.errors[0].variables).toEqual({
      field: 'operation_status',
      reason: 'Schema is currently being modified',
    });
    libCore.errors = [];
    await rename(setup(), { new_field_key: 'employee_id' });
    expect(libCore.errors[0].variables).toEqual({
      field: 'new_field_key',
      reason: 'New field_key is the same as current',
    });
    libCore.errors = [];
    const db = setup();
    db.state.conflict = schemaRow({ id: 'other' });
    const conflict = await rename(db, { new_field_key: 'emp_id' });
    expect(conflict.status).toBe(400);
    expect(libCore.errors[0].variables).toEqual({
      field: 'new_field_key',
      reason: "An active schema with field_key 'emp_id' already exists",
    });
    expect(must(db.state.queries.at(-1)).sql).toContain('id != ?');
    expect(must(db.state.queries.at(-1)).params).toEqual(['test-tenant', 'emp_id', 'schema-1']);
  });

  it('refuses when the schema changed state concurrently', async () => {
    const db = setup();
    db.state.rowsAffected = () => 0;
    const result = await rename(db, { new_field_key: 'emp_id' });
    expect(result.status).toBe(400);
    expect(libCore.errors[0].variables).toEqual({
      field: 'operation_status',
      reason: 'Schema state changed concurrently. Please retry.',
    });
    expect(libCore.renameStored).not.toHaveBeenCalled();
  });

  it('marks renaming, moves non-PII data in every store, then switches the key', async () => {
    const db = setup();
    const result = await rename(db, { new_field_key: 'emp_id' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      affected_users: 4,
      old_key: 'employee_id',
      new_key: 'emp_id',
    });
    const [mark, finish] = updates(db);
    expect(mark.set.operation_status).toBe('renaming');
    expect(JSON.parse(String(mark.set.operation_detail))).toEqual({
      old_key: 'employee_id',
      new_key: 'emp_id',
    });
    expect(mark.where).toEqual(['schema-1', 'test-tenant', 'active']);
    expect(finish.set).toMatchObject({
      field_key: 'emp_id',
      operation_status: 'active',
      operation_detail: null,
      active_field_key: 'emp_id',
    });
    expect(finish.sql).toContain('schema_version = schema_version + 1');
    expect(finish.where).toEqual(['schema-1', 'test-tenant', 'renaming']);
    expect(libCore.renameStored).toHaveBeenCalledWith({
      db: 'n1',
      dbPii: undefined,
      tenantId: 'test-tenant',
      oldKey: 'employee_id',
      newKey: 'emp_id',
      isPii: false,
    });
    expect(libCore.audit).toHaveBeenCalledWith(
      expect.anything(),
      'update',
      'custom_claim_schema',
      'schema-1',
      { action: 'rename', old_key: 'employee_id', new_key: 'emp_id', affected_users: 4 }
    );
    expect(libCore.history.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'rename',
        previousSnapshot: expect.objectContaining({ field_key: 'employee_id' }),
      })
    );
  });

  it('moves PII data through the PII stores with the update time and batch size', async () => {
    const db = setup(schemaRow({ is_pii: 1 }));
    const result = await rename(db, { new_field_key: 'emp_id' });
    expect(result.status).toBe(200);
    const call = libCore.renameStored.mock.calls[0][0];
    expect(call).toMatchObject({
      db: db.adapter,
      dbPii: 'p1',
      isPii: true,
      piiBatchSize: 500,
      oldKey: 'employee_id',
      newKey: 'emp_id',
    });
    expect(typeof call.updatedAt).toBe('number');
  });

  it('keeps the old key and the error state when some PII users failed', async () => {
    const db = setup(schemaRow({ is_pii: 1 }));
    libCore.renameStored.mockResolvedValue({ affectedUsers: 1, processedUsers: 4, failedUsers: 3 });
    const result = await rename(db, { new_field_key: 'emp_id' });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      success: false,
      error: 'Partial rename: 3 user(s) failed. Schema marked as error state for retry.',
    });
    const [, failed] = updates(db);
    expect(failed.set.operation_status).toBe('error');
    expect(JSON.parse(String(failed.set.operation_detail))).toEqual({
      operation: 'rename',
      old_key: 'employee_id',
      new_key: 'emp_id',
      error: 'Partial rename: 3 user(s) failed',
    });
    expect(updates(db)).toHaveLength(2);
  });

  it('marks the error with the thrown message when moving data throws', async () => {
    const db = setup();
    libCore.renameStored.mockRejectedValue(new Error('rename exploded'));
    const result = await rename(db, { new_field_key: 'emp_id' });
    expect(result.status).toBe(500);
    expect(JSON.parse(String(updates(db)[1].set.operation_detail))).toEqual({
      operation: 'rename',
      old_key: 'employee_id',
      new_key: 'emp_id',
      error: 'rename exploded',
    });
  });

  it('records an unknown error for a non-Error failure, and still answers when history fails', async () => {
    const db = setup();
    libCore.renameStored.mockRejectedValue(42);
    await rename(db, { new_field_key: 'emp_id' });
    expect(JSON.parse(String(updates(db)[1].set.operation_detail)).error).toBe('Unknown error');
    libCore.history.recordChange.mockRejectedValue(new Error('history down'));
    expect((await rename(setup(), { new_field_key: 'emp_id' })).status).toBe(200);
  });

  it('answers 500 when the body cannot be read', async () => {
    const db = setup();
    const c = createClaimsContext({
      db: db.adapter,
      params: { id: 'schema-1' },
      jsonRejects: true,
    });
    expect((await adminCustomClaimRenameHandler(c)).status).toBe(500);
  });
});

describe('custom claim retry', () => {
  beforeEach(() => resetLibCore());

  const retry = async (db: Db) => ({
    ...(await read(await adminCustomClaimRetryHandler(context(db)))),
    db,
  });
  const errored = (detail: unknown, extra: Row = {}) =>
    schemaRow({
      operation_status: 'error',
      operation_detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
      ...extra,
    });
  const renameDetail = { operation: 'rename', old_key: 'employee_id', new_key: 'emp_id' };

  it('answers 404 for an unknown schema and refuses schemas not in the error state', async () => {
    expect((await retry(setup(null))).status).toBe(404);
    libCore.errors = [];
    const result = await retry(setup(schemaRow()));
    expect(result.status).toBe(400);
    expect(libCore.errors[0].variables).toEqual({
      field: 'operation_status',
      reason: 'Only schemas in error state can be retried',
    });
    expect(result.db.state.executes).toHaveLength(0);
  });

  it.each([
    ['unreadable detail', '{broken'],
    ['an unknown operation', { operation: 'merge' }],
    ['a rename without keys', { operation: 'rename' }],
    ['a rename without a new key', { operation: 'rename', old_key: 'a' }],
  ])('resets to active for %s', async (_name, detail) => {
    const db = setup(errored(detail));
    const result = await retry(db);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true, action: 'reset_to_active' });
    const [reset] = updates(db);
    expect(reset.set).toMatchObject({ operation_status: 'active', operation_detail: null });
    expect(reset.where).toEqual(['schema-1', 'test-tenant']);
    expect(libCore.renameStored).not.toHaveBeenCalled();
    expect(libCore.invalidate).toHaveBeenCalledWith('test-tenant');
  });

  it('resets a failed delete to active and tells the operator to delete again', async () => {
    const db = setup(errored({ operation: 'delete' }));
    const result = await retry(db);
    expect(result.body).toEqual({
      success: true,
      action: 'reset_to_active',
      message: 'Schema reset to active state. You can now retry the delete operation.',
    });
    expect(libCore.audit).toHaveBeenCalledWith(
      expect.anything(),
      'update',
      'custom_claim_schema',
      'schema-1',
      { action: 'retry_reset', original_operation: 'delete' }
    );
  });

  it('refuses the rename retry when the schema left the error state meanwhile', async () => {
    const db = setup(errored(renameDetail));
    db.state.rowsAffected = () => 0;
    const result = await retry(db);
    expect(result.status).toBe(400);
    expect(libCore.errors[0].variables).toEqual({
      field: 'operation_status',
      reason: 'Schema state changed concurrently. Please retry.',
    });
  });

  it('renames the remaining non-PII data and completes the rename', async () => {
    const db = setup(errored(renameDetail));
    libCore.countNonPiiField.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const result = await retry(db);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      success: true,
      action: 'rename_completed',
      affected_users: 4,
    });
    const [mark, finish] = updates(db);
    expect(mark.set.operation_status).toBe('renaming');
    expect(mark.where).toEqual(['schema-1', 'test-tenant', 'error']);
    expect(finish.set).toMatchObject({
      field_key: 'emp_id',
      operation_status: 'active',
      operation_detail: null,
    });
    expect(finish.where).toEqual(['schema-1', 'test-tenant', 'renaming']);
    expect(finish.sql).toContain('schema_version = schema_version + 1');
    expect(libCore.countNonPiiField).toHaveBeenCalledWith('n1', 'test-tenant', 'employee_id');
    expect(libCore.renameStored).toHaveBeenCalledWith(
      expect.objectContaining({ db: 'n1', oldKey: 'employee_id', newKey: 'emp_id', isPii: false })
    );
    expect(libCore.audit).toHaveBeenCalledWith(
      expect.anything(),
      'update',
      'custom_claim_schema',
      'schema-1',
      {
        action: 'retry_rename_success',
        old_key: 'employee_id',
        new_key: 'emp_id',
        affected_users: 4,
      }
    );
    expect(libCore.history.recordChange).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'rename' })
    );
  });

  it('treats nothing left to move as an already finished migration', async () => {
    const db = setup(errored(renameDetail));
    libCore.countNonPiiField.mockResolvedValue(0);
    const result = await retry(db);
    expect(result.body).toMatchObject({ action: 'rename_completed', affected_users: 0 });
    expect(libCore.renameStored).not.toHaveBeenCalled();
    expect(updates(db)[1].set.field_key).toBe('emp_id');
  });

  it('retries PII renames through the PII stores', async () => {
    const db = setup(errored(renameDetail, { is_pii: 1 }));
    const result = await retry(db);
    expect(result.body).toMatchObject({ action: 'rename_completed', affected_users: 2 });
    expect(libCore.renameStored).toHaveBeenCalledWith(
      expect.objectContaining({
        dbPii: 'p1',
        isPii: true,
        piiBatchSize: 500,
        oldKey: 'employee_id',
      })
    );
    expect(libCore.countNonPiiField).not.toHaveBeenCalled();
  });

  it('stays in the error state, flagged as a failed retry, when PII users still fail', async () => {
    const db = setup(errored(renameDetail, { is_pii: 1 }));
    libCore.renameStored.mockResolvedValue({ affectedUsers: 0, processedUsers: 2, failedUsers: 2 });
    const result = await retry(db);
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      success: false,
      error: 'Retry partial failure: 2 user(s) failed. Schema remains in error state.',
    });
    expect(JSON.parse(String(updates(db)[1].set.operation_detail))).toEqual({
      operation: 'rename',
      old_key: 'employee_id',
      new_key: 'emp_id',
      error: 'Retry partial failure: 2 user(s) failed',
      retry_failed: true,
    });
    expect(updates(db)[1].set.operation_status).toBe('error');
  });

  it('records the thrown message, flagged as a failed retry, when the move throws', async () => {
    const db = setup(errored(renameDetail));
    libCore.countNonPiiField.mockResolvedValue(1);
    libCore.renameStored.mockRejectedValue(new Error('rename exploded'));
    const result = await retry(db);
    expect(result.status).toBe(500);
    expect(JSON.parse(String(updates(db)[1].set.operation_detail))).toEqual({
      operation: 'rename',
      old_key: 'employee_id',
      new_key: 'emp_id',
      error: 'rename exploded',
      retry_failed: true,
    });
    const other = setup(errored(renameDetail));
    libCore.renameStored.mockRejectedValue('text');
    await retry(other);
    expect(JSON.parse(String(updates(other)[1].set.operation_detail)).error).toBe('Unknown error');
  });

  it('still answers when history cannot be recorded', async () => {
    libCore.history.recordChange.mockRejectedValue(new Error('down'));
    libCore.countNonPiiField.mockResolvedValue(0);
    expect((await retry(setup(errored(renameDetail)))).status).toBe(200);
  });

  it('answers 500 when the schema cannot be read', async () => {
    const db = setup();
    db.state.failOn = () => new Error('down');
    expect((await retry(db)).status).toBe(500);
  });
});
