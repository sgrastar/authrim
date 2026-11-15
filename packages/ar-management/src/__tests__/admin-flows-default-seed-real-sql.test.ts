/** The default sign-in and sign-up of a new tenant, on actual migrated SQLite; no SQL is mocked. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultLoginFlowSpec,
  readLoginFlowEditor,
  type DatabaseAdapter,
  type FlowEditorState,
  type FlowRuntimeContract,
} from '@authrim/ar-lib-core';
import { seedDefaultLoginFlow, seedDefaultRegistrationFlow } from '../admin-flows';
import { openCoreStore } from './helpers/core-schema-sqlite';
import type { SQLiteDatabase } from './test-sqlite';

const TENANT = 'new-tenant';
const opened: SQLiteDatabase[] = [];

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

function open() {
  const { db, adapter } = openCoreStore(TENANT);
  opened.push(db);
  return adapter;
}

/** The query the sign-in runtime resolves a tenant's Flow with (login-runtime-flow.ts). */
function resolveTenantAssignment(db: DatabaseAdapter, flowKind: string) {
  return db.queryOne<{ flow_id: string; published_version_id: string | null }>(
    `SELECT a.flow_id, a.target_type, a.target_id, a.flow_kind, f.published_version_id
     FROM flow_assignments a
     JOIN flows f ON f.id = a.flow_id AND f.tenant_id = a.tenant_id
     WHERE a.tenant_id = ?
       AND a.target_type = 'tenant'
       AND a.target_id IS NULL
       AND a.flow_kind = ?
       AND a.enabled = TRUE
       AND f.status = 'published'
       AND f.deleted_at IS NULL`,
    [TENANT, flowKind]
  );
}

describe('seedDefaultLoginFlow', () => {
  it('leaves nothing behind when its writes are cut short, so a retry makes one Flow', async () => {
    const db = open();
    // Its writes go in one batch, as D1 applies them: all or nothing. The last statement is
    // broken here, so the whole batch fails.
    const cut = {
      ...db,
      batch: (statements: Parameters<DatabaseAdapter['batch']>[0]) =>
        db.batch(
          statements.map((s, i) => (i === statements.length - 1 ? { ...s, sql: 'BAD' } : s))
        ),
    };
    await expect(seedDefaultLoginFlow(cut, TENANT, 1000)).rejects.toThrow();
    expect(await db.query('SELECT id FROM flows WHERE tenant_id = ?', [TENANT])).toHaveLength(0);

    await seedDefaultLoginFlow(db, TENANT, 1001);
    expect(await db.query('SELECT id FROM flows WHERE tenant_id = ?', [TENANT])).toHaveLength(1);
    expect(
      await db.query('SELECT id FROM flow_assignments WHERE tenant_id = ?', [TENANT])
    ).toHaveLength(1);
  });

  it('publishes the default sign-in and assigns it to the tenant, as the runtime finds it', async () => {
    const db = open();
    expect(await resolveTenantAssignment(db, 'login')).toBeNull();

    const seeded = await seedDefaultLoginFlow(db, TENANT, 1000);
    expect(seeded).not.toBeNull();

    const assignment = await resolveTenantAssignment(db, 'login');
    expect(assignment?.flow_id).toBe(seeded?.flowId);
    expect(assignment?.published_version_id).toBeTruthy();

    const flow = await db.queryOne<Record<string, unknown>>(
      'SELECT * FROM flows WHERE tenant_id = ? AND id = ?',
      [TENANT, seeded?.flowId]
    );
    expect(flow).toMatchObject({ kind: 'login', status: 'published', slug: 'standard-sign-in' });
    const version = await db.queryOne<{
      runtime_snapshot_json: string;
      editor_snapshot_json: string;
      validation_result_json: string;
    }>('SELECT * FROM flow_versions WHERE tenant_id = ? AND id = ?', [
      TENANT,
      assignment?.published_version_id,
    ]);
    expect(JSON.parse(version?.validation_result_json ?? '{}')).toMatchObject({ valid: true });
    const runtime = JSON.parse(version?.runtime_snapshot_json ?? '{}') as FlowRuntimeContract;
    expect(runtime.flow_kind).toBe('login');
    const authentication = runtime.ui.steps.find(
      (step) => step.component === 'authentication_method_selector'
    );
    expect(authentication?.config).toMatchObject({
      authentication_profile_ref: 'default',
      session_profile_ref: 'default',
      screen_ref: 'login',
    });
    // The console reads it back as the default sign-in, so it can open and edit it.
    const editor = JSON.parse(version?.editor_snapshot_json ?? '{}') as FlowEditorState;
    expect(readLoginFlowEditor(editor)).toEqual(defaultLoginFlowSpec());
  });

  it('does nothing a second time, or when the tenant already has a sign-in assigned', async () => {
    const db = open();
    await seedDefaultLoginFlow(db, TENANT, 1000);
    expect(await seedDefaultLoginFlow(db, TENANT, 1001)).toBeNull();
    const count = (sql: string) => db.queryOne<{ n: number }>(sql, [TENANT]);
    expect((await count('SELECT COUNT(*) AS n FROM flows WHERE tenant_id = ?'))?.n).toBe(1);
    expect((await count('SELECT COUNT(*) AS n FROM flow_assignments WHERE tenant_id = ?'))?.n).toBe(
      1
    );

    // An assignment made some other way is kept as it is.
    const other = open();
    await other.execute(
      `INSERT INTO flows (id, tenant_id, profile_id, name, version, kind, status, slug, display_name,
         created_at, updated_at, graph_definition, compiled_plan)
       VALUES ('own', ?, 'human-basic', 'Own', '1.0.0', 'login', 'published', 'own', 'Own', 1, 1, '{}', '{}')`,
      [TENANT]
    );
    await other.execute(
      `INSERT INTO flow_assignments (id, tenant_id, target_type, target_id, flow_kind, flow_id,
         enabled, created_at, updated_at)
       VALUES ('a1', ?, 'tenant', NULL, 'login', 'own', 1, 1, 1)`,
      [TENANT]
    );
    expect(await seedDefaultLoginFlow(other, TENANT, 1000)).toBeNull();
    expect((await resolveTenantAssignment(other, 'login'))?.flow_id).toBe('own');
  });

  it('keeps the sign-in and the sign-up apart', async () => {
    const db = open();
    const login = await seedDefaultLoginFlow(db, TENANT, 1000);
    expect(await resolveTenantAssignment(db, 'registration')).toBeNull();
    const registration = await seedDefaultRegistrationFlow(db, TENANT, 1000);
    expect((await resolveTenantAssignment(db, 'registration'))?.flow_id).toBe(registration?.flowId);
    expect((await resolveTenantAssignment(db, 'login'))?.flow_id).toBe(login?.flowId);
  });
});
