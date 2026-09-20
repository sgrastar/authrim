import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { TenantBackupAdminMappingStore } from '../admin-mapping-store';

let db: DatabaseSync;
let store: TenantBackupAdminMappingStore;
let throwAfterApprovalCommit: boolean;

function migration(name: string): string {
  return readFileSync(
    new URL(`../../../../../../migrations/admin/d1/${name}`, import.meta.url),
    'utf8'
  );
}

function source(id: string): void {
  db.prepare(
    `INSERT INTO tenant_backup_validation_records
      (session_id,tenant_id,module,collection,record_id,bundle_id,source_id)
     VALUES ('session-a','tenant-a','admin-auth','admin.admin_users',?,'bundle-a',?)`
  ).run(JSON.stringify([['text', id]]), `source-${id}`);
}

beforeEach(() => {
  throwAfterApprovalCommit = false;
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(`CREATE TABLE admin_users (
    id TEXT NOT NULL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    is_active INTEGER NOT NULL,
    status TEXT NOT NULL
  )`);
  for (const name of [
    '003_tenant_backup_operations.sql',
    '006_tenant_backup_request_intent.sql',
    '008_tenant_backup_retry_state.sql',
    '004_tenant_backup_validation_index.sql',
    '017_tenant_backup_validation_record_sources.sql',
    '019_tenant_backup_input_validations.sql',
    '029_tenant_backup_admin_mappings.sql',
    '035_tenant_backup_admin_mapping_operation_scope.sql',
  ])
    db.exec(migration(name));
  db.prepare(
    `INSERT INTO tenant_backup_operations
      (id,tenant_id,kind,idempotency_key,request_digest,state,phase,created_by,created_at,updated_at,revision,request_json)
     VALUES ('operation-a','tenant-a','import','request-a',?,'waiting','await_restore_approval',
       'approver-a',100,200,7,?)`
  ).run('ab'.repeat(32), JSON.stringify({ selection: { admin: true } }));
  db.exec(
    `INSERT INTO tenant_backup_validation_sessions
      (id,tenant_id,operation_id,fencing_token,state,created_at)
     VALUES ('session-a','tenant-a','operation-a',1,'sealed',101);
     INSERT INTO tenant_backup_input_validations
      (operation_id,tenant_id,session_id,input_inventory_digest,examined_references,unresolved_provenance)
     VALUES ('operation-a','tenant-a','session-a','inventory-a',0,0);`
  );
  db.prepare(
    `INSERT INTO admin_users(id,tenant_id,email,name,is_active,status) VALUES
      ('target-a','tenant-a','a@example.test','Target A',1,'active'),
      ('target-b','tenant-a','b@example.test','Target B',1,'active'),
      ('target-disabled','tenant-a','disabled@example.test',NULL,0,'suspended'),
      ('target-other','tenant-b','other@example.test',NULL,1,'active')`
  ).run();
  const adapter: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'> = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      const result = db.prepare(sql).run(...(params as SQLInputValue[]));
      if (
        throwAfterApprovalCommit &&
        sql.includes('UPDATE tenant_backup_admin_mapping_heads SET')
      ) {
        throwAfterApprovalCommit = false;
        throw new Error('ambiguous_d1_response');
      }
      return { success: true, rowsAffected: Number(result.changes) };
    },
  };
  store = new TenantBackupAdminMappingStore(adapter);
});

afterEach(() => db.close());

describe('tenant backup Admin mappings', () => {
  it('lists validated sources and active same-tenant targets in bounded pages', async () => {
    source('source-a');
    source('source-b');
    expect(await store.listSources('tenant-a', 'operation-a')).toEqual({
      entries: [
        {
          sourceAdminId: 'source-a',
          targetAdminId: null,
          targetEmail: null,
          targetName: null,
        },
        {
          sourceAdminId: 'source-b',
          targetAdminId: null,
          targetEmail: null,
          targetName: null,
        },
      ],
      nextCursor: 'source-b',
      done: true,
    });
    expect(await store.listTargets('tenant-a')).toEqual({
      entries: [
        { id: 'target-a', email: 'a@example.test', name: 'Target A' },
        { id: 'target-b', email: 'b@example.test', name: 'Target B' },
      ],
      nextCursor: 'target-b',
      done: true,
    });
  });

  it('freezes a complete one-to-one mapping and resumes the operation atomically', async () => {
    source('source-a');
    source('source-b');
    expect(
      await store.map({
        tenantId: 'tenant-a',
        operationId: 'operation-a',
        sourceAdminId: 'source-a',
        targetAdminId: 'target-a',
        actorId: 'approver-a',
        now: 201,
      })
    ).toMatchObject({ revision: 1, sourceCount: 2, mappedCount: 1, complete: false });
    const status = await store.map({
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      sourceAdminId: 'source-b',
      targetAdminId: 'target-b',
      actorId: 'approver-a',
      now: 202,
    });
    expect(status).toMatchObject({ revision: 2, sourceCount: 2, mappedCount: 2, complete: true });
    const approved = await store.approve({
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      actorId: 'approver-a',
      operationRevision: 7,
      mappingRevision: 2,
      now: 203,
    });
    expect(approved.mappingDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(approved.operation).toMatchObject({ state: 'queued', revision: 8 });
    expect(await store.status('tenant-a', 'operation-a')).toMatchObject({
      state: 'frozen',
      revision: 2,
      digest: approved.mappingDigest,
      complete: true,
    });
    await expect(store.assertApproved('tenant-a', 'operation-a')).resolves.toBeUndefined();
    await expect(store.resolveFrozen('tenant-a', 'operation-a', 'source-a')).resolves.toBe(
      'target-a'
    );
    await expect(store.resolveFrozen('tenant-a', 'operation-a', 'unknown-source')).rejects.toThrow(
      'backup_admin_mapping_unresolved'
    );
    await expect(
      store.map({
        tenantId: 'tenant-a',
        operationId: 'operation-a',
        sourceAdminId: 'source-a',
        targetAdminId: 'target-b',
        actorId: 'approver-a',
        now: 204,
      })
    ).rejects.toThrow();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('ignores matching Admin validation history from an older import operation', async () => {
    source('source-a');
    db.prepare(
      `INSERT INTO tenant_backup_operations
        (id,tenant_id,kind,idempotency_key,request_digest,state,phase,created_by,created_at,
         updated_at,revision,request_json)
       VALUES ('operation-old','tenant-a','import','request-old',?,'completed','complete',
         'approver-a',50,90,3,?)`
    ).run('cd'.repeat(32), JSON.stringify({ selection: { admin: true } }));
    db.exec(
      `INSERT INTO tenant_backup_validation_sessions
        (id,tenant_id,operation_id,fencing_token,state,created_at)
       VALUES ('session-old','tenant-a','operation-old',1,'sealed',51);
       INSERT INTO tenant_backup_input_validations
        (operation_id,tenant_id,session_id,input_inventory_digest,examined_references,
         unresolved_provenance)
       VALUES ('operation-old','tenant-a','session-old','inventory-old',0,0);`
    );
    db.prepare(
      `INSERT INTO tenant_backup_validation_records
        (session_id,tenant_id,module,collection,record_id,bundle_id,source_id)
       VALUES ('session-old','tenant-a','admin-auth','admin.admin_users',?,'bundle-old',
         'source-old')`
    ).run(JSON.stringify([['text', 'source-a']]));

    await store.map({
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      sourceAdminId: 'source-a',
      targetAdminId: 'target-a',
      actorId: 'approver-a',
      now: 201,
    });
    await expect(
      store.approve({
        tenantId: 'tenant-a',
        operationId: 'operation-a',
        actorId: 'approver-a',
        operationRevision: 7,
        mappingRevision: 1,
        now: 202,
      })
    ).resolves.toMatchObject({ operation: { state: 'queued', revision: 8 } });
  });

  it('fails closed for missing mappings, stale revisions and invalid targets', async () => {
    source('source-a');
    source('source-b');
    for (const targetAdminId of ['target-disabled', 'target-other'])
      await expect(
        store.map({
          tenantId: 'tenant-a',
          operationId: 'operation-a',
          sourceAdminId: 'source-a',
          targetAdminId,
          actorId: 'approver-a',
          now: 201,
        })
      ).rejects.toThrow();
    await expect(
      store.map({
        tenantId: 'tenant-a',
        operationId: 'operation-a',
        sourceAdminId: 'unknown-source',
        targetAdminId: 'target-a',
        actorId: 'approver-a',
        now: 201,
      })
    ).rejects.toThrow();
    await store.map({
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      sourceAdminId: 'source-a',
      targetAdminId: 'target-a',
      actorId: 'approver-a',
      now: 202,
    });
    await expect(
      store.map({
        tenantId: 'tenant-a',
        operationId: 'operation-a',
        sourceAdminId: 'source-b',
        targetAdminId: 'target-a',
        actorId: 'approver-a',
        now: 203,
      })
    ).rejects.toThrow();
    await expect(
      store.approve({
        tenantId: 'tenant-a',
        operationId: 'operation-a',
        actorId: 'approver-a',
        operationRevision: 7,
        mappingRevision: 1,
        now: 204,
      })
    ).rejects.toThrow('backup_admin_mapping_incomplete');
    expect(
      db.prepare("SELECT state FROM tenant_backup_operations WHERE id='operation-a'").get()
    ).toEqual({ state: 'waiting' });
  });

  it('supports an empty validated Admin set without inventing accounts', async () => {
    const approved = await store.approve({
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      actorId: 'approver-a',
      operationRevision: 7,
      mappingRevision: 0,
      now: 201,
    });
    expect(approved.operation.state).toBe('queued');
    expect(approved.mappingDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_admin_mappings').get()).toEqual({
      n: 0,
    });
    await expect(store.assertApproved('tenant-a', 'operation-a')).resolves.toBeUndefined();
  });

  it('recovers an exact approval when D1 loses the response after committing', async () => {
    source('source-a');
    await store.map({
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      sourceAdminId: 'source-a',
      targetAdminId: 'target-a',
      actorId: 'approver-a',
      now: 201,
    });
    throwAfterApprovalCommit = true;
    await expect(
      store.approve({
        tenantId: 'tenant-a',
        operationId: 'operation-a',
        actorId: 'approver-a',
        operationRevision: 7,
        mappingRevision: 1,
        now: 202,
      })
    ).resolves.toMatchObject({ operation: { state: 'queued', revision: 8 } });
  });

  it('stops restore when a mapped target is disabled after approval', async () => {
    source('source-a');
    await store.map({
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      sourceAdminId: 'source-a',
      targetAdminId: 'target-a',
      actorId: 'approver-a',
      now: 201,
    });
    await store.approve({
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      actorId: 'approver-a',
      operationRevision: 7,
      mappingRevision: 1,
      now: 202,
    });
    db.exec("UPDATE admin_users SET is_active=0,status='suspended' WHERE id='target-a'");
    await expect(store.assertApproved('tenant-a', 'operation-a')).rejects.toThrow(
      'backup_admin_mapping_not_approved'
    );
    await expect(store.resolveFrozen('tenant-a', 'operation-a', 'source-a')).rejects.toThrow(
      'backup_admin_mapping_unresolved'
    );
  });
});
