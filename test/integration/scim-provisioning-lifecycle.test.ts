import { readMigrationSource } from '../helpers/migration-source.mjs';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { describeScimTestHarness } from '../../packages/ar-management/src/__tests__/scim-test-harness';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
type SqlValue = string | number | null | Uint8Array;
interface BoundaryDatabase {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    run(...params: SqlValue[]): { changes: number | bigint };
    get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
    all(...params: SqlValue[]): Array<Record<string, SqlValue>>;
  };
}
const sqliteModule = 'node:sqlite';
const { DatabaseSync } = (await import(sqliteModule)) as {
  DatabaseSync: new (filename: string) => BoundaryDatabase;
};
const groupMigration = readMigrationSource(
  new URL('../../migrations/core/d1/', import.meta.url),
  '007_service_dynamic_groups.sql'
);

/** Keep the real boundary rows and revision triggers; other SCIM fixtures remain delegated. */
function installGroupBoundaryFixture(binding: D1Database): BoundaryDatabase {
  const database = new DatabaseSync(':memory:');
  const inputs = groupMigration.match(
    /CREATE TABLE IF NOT EXISTS service_group_inputs \([\s\S]*?\n\);/u
  )?.[0];
  const boundaryStart = groupMigration.indexOf('CREATE TABLE service_group_write_boundaries (');
  if (!inputs || boundaryStart < 0) throw new Error('group_boundary_fixture_schema_missing');
  database.exec(inputs);
  database.exec(groupMigration.slice(boundaryStart));
  const prepare = vi.spyOn(binding, 'prepare');
  const prepareOriginal = prepare.getMockImplementation();
  if (!prepareOriginal) throw new Error('scim_core_prepare_fixture_missing');
  prepare.mockImplementation((sql) => {
    if (!/\bservice_group_(?:write_boundaries|inputs)\b/u.test(sql))
      return prepareOriginal.call(binding, sql);
    const statement = (params: unknown[] = []): D1PreparedStatement => {
      const values = params.map((value): SqlValue => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        )
          return value;
        throw new Error('group_boundary_fixture_parameter_invalid');
      });
      return {
        bind: (...next: unknown[]) => statement(next),
        first: async () => database.prepare(sql).get(...values) ?? null,
        all: async () => ({ success: true, results: database.prepare(sql).all(...values) }),
        run: async () => {
          const totalChanges = () => {
            const count = database.prepare('SELECT total_changes() AS n').get()?.n;
            if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
              throw new Error('group_boundary_fixture_changes_invalid');
            return count;
          };
          const before = totalChanges();
          database.prepare(sql).run(...values);
          return { success: true, results: [], meta: { changes: totalChanges() - before } };
        },
      } as unknown as D1PreparedStatement;
    };
    return statement();
  });
  return database;
}

describeScimTestHarness('SCIM provisioning lifecycle integration', (harness) => {
  let boundaries: BoundaryDatabase;
  beforeEach(() => {
    if (!harness.env.DB) throw new Error('scim_core_fixture_missing');
    boundaries = installGroupBoundaryFixture(harness.env.DB);
  });
  afterEach(() => boundaries?.close());
  const boundaryRows = () =>
    boundaries.prepare('SELECT tenant_id,user_id,status FROM service_group_write_boundaries').all();
  const inputRevisions = () =>
    boundaries.prepare('SELECT tenant_id,user_id,revision FROM service_group_inputs').all();
  const fetchScim = (path: string, options?: RequestInit) =>
    harness.app.fetch(harness.createRequest(path, options), harness.env as Env);

  it('creates asynchronously, completes the operation, and reads active:false', async () => {
    harness.accountCreation.deliveryStatus = 202;
    const create = await fetchScim('/scim/v2/Users', {
      method: 'POST',
      body: JSON.stringify({
        schemas: [USER_SCHEMA],
        userName: 'integration-inactive',
        emails: [{ value: 'integration.inactive@example.com', primary: true }],
        active: false,
      }),
    });
    expect(create.status).toBe(202);
    const pending = await create.json<{ operationId: string }>();
    const call = harness.accountCreation.calls[0] as { candidateUserId: string };

    harness.accountOperation.operation = {
      operationId: pending.operationId,
      tenantId: 'default',
      actorId: `scim-token:${'a'.repeat(64)}`,
      userId: call.candidateUserId,
      status: 'succeeded',
    };
    const operation = await fetchScim(`/scim/v2/Operations/${pending.operationId}`);
    expect(operation.status).toBe(200);
    await expect(operation.json()).resolves.toMatchObject({ status: 'succeeded' });

    const read = await fetchScim(`/scim/v2/Users/${call.candidateUserId}`);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      id: call.candidateUserId,
      active: false,
    });
  });

  it('deactivates and reactivates by PUT without creating a duplicate account', async () => {
    const deactivate = await fetchScim('/scim/v2/Users/user-001', {
      method: 'PATCH',
      body: JSON.stringify({
        schemas: [PATCH_SCHEMA],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    });
    expect(deactivate.status).toBe(200);
    await expect(deactivate.json()).resolves.toMatchObject({ active: false });
    expect(boundaryRows()).toEqual([]);
    expect(inputRevisions()).toEqual([{ tenant_id: 'default', user_id: 'user-001', revision: 2 }]);

    const replace = await fetchScim('/scim/v2/Users/user-001', {
      method: 'PUT',
      body: JSON.stringify({
        schemas: [USER_SCHEMA],
        userName: 'johndoe',
        emails: [{ value: 'john.doe@example.com', primary: true }],
        active: true,
      }),
    });
    expect(replace.status).toBe(200);
    await expect(replace.json()).resolves.toMatchObject({ id: 'user-001', active: true });
    expect(harness.users.size).toBe(2);
    expect(harness.accountCreation.calls).toHaveLength(0);
    expect(boundaryRows()).toEqual([]);
    expect(inputRevisions()).toEqual([{ tenant_id: 'default', user_id: 'user-001', revision: 4 }]);
  });

  it('refuses a user mutation when the boundary INSERT reports no changes', async () => {
    boundaries.exec(`CREATE TRIGGER reject_boundary BEFORE INSERT ON service_group_write_boundaries
      BEGIN SELECT RAISE(IGNORE); END;`);
    const before = { ...(harness.users.get('user-001') as Record<string, unknown>) };
    const response = await fetchScim('/scim/v2/Users/user-001', {
      method: 'PATCH',
      body: JSON.stringify({
        schemas: [PATCH_SCHEMA],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    });
    expect(response.status).toBe(500);
    expect(harness.users.get('user-001')).toEqual(before);
    expect(harness.identifierReplacement.calls).toEqual([]);
    expect(boundaryRows()).toEqual([]);
    expect(inputRevisions()).toEqual([]);
  });

  it('enforces userName uniqueness and mapping/email validation at the HTTP boundary', async () => {
    const duplicate = await fetchScim('/scim/v2/Users', {
      method: 'POST',
      body: JSON.stringify({
        schemas: [USER_SCHEMA],
        userName: 'JOHNDOE',
        emails: [{ value: 'unique@example.com' }],
      }),
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      status: '409',
      scimType: 'uniqueness',
    });

    const missingMappedEmail = await fetchScim('/scim/v2/Users', {
      method: 'POST',
      body: JSON.stringify({ schemas: [USER_SCHEMA], userName: 'missing-email' }),
    });
    expect(missingMappedEmail.status).toBe(400);
    await expect(missingMappedEmail.json()).resolves.toMatchObject({
      status: '400',
      scimType: 'invalidValue',
    });

    const invalidEmail = await fetchScim('/scim/v2/Users', {
      method: 'POST',
      body: JSON.stringify({
        schemas: [USER_SCHEMA],
        userName: 'invalid-email',
        emails: [{ value: 'lookup_email_invalid' }],
      }),
    });
    expect(invalidEmail.status).toBe(400);
    const invalidBody = await invalidEmail.json<Record<string, unknown>>();
    expect(invalidBody).toMatchObject({ status: '400', scimType: 'invalidValue' });
    expect(JSON.stringify(invalidBody)).not.toContain('lookup_email_invalid');
  });

  it('rejects stale ETags and preserves the resource', async () => {
    const before = { ...(harness.users.get('user-001') as Record<string, unknown>) };
    const response = await fetchScim('/scim/v2/Users/user-001', {
      method: 'PATCH',
      headers: { 'If-Match': 'W/"stale"' },
      body: JSON.stringify({
        schemas: [PATCH_SCHEMA],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    });

    expect(response.status).toBe(412);
    await expect(response.json()).resolves.toMatchObject({
      status: '412',
      scimType: 'invalidVers',
    });
    expect(harness.users.get('user-001')).toMatchObject(before);
  });

  it('does not list or resolve a resource owned by another tenant', async () => {
    harness.users.set('foreign-user', {
      id: 'foreign-user',
      tenant_id: 'tenant-b',
      email: 'foreign@example.com',
      preferred_username: 'foreign-user',
      active: 1,
      lifecycle_state: 'active',
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    });

    const list = await fetchScim('/scim/v2/Users');
    const body = await list.json<{ Resources: Array<{ id: string }> }>();
    expect(body.Resources.map((resource) => resource.id)).not.toContain('foreign-user');
    expect((await fetchScim('/scim/v2/Users/foreign-user')).status).toBe(404);
  });
});
