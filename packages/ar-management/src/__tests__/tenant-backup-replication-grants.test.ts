import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';

import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import {
  TenantBackupReplicationGrantStore,
  REPLICATION_GRANT_MAX_AGE_MS,
} from '../tenant-backup-replication-grants';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';

const opened: SQLiteDatabase[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
function fixture() {
  const db = new DatabaseSync(':memory:');
  opened.push(db);
  db.exec(
    readRenderedMigrationSql(
      new URL('../../../../migrations/admin/d1/', import.meta.url),
      '001_0_5_0_admin_baseline.sql'
    )
  );
  const adapter: Pick<DatabaseAdapter, 'queryOne' | 'execute'> = {
    async queryOne<T>(sql: string, params?: unknown[]) {
      return (db.prepare(sql).get(...((params ?? []) as SQLInputValue[])) ?? null) as T | null;
    },
    async execute(sql, params) {
      const result = db.prepare(sql).run(...((params ?? []) as SQLInputValue[]));
      return { success: true, rowsAffected: Number(result.changes) };
    },
  };
  const store = new TenantBackupReplicationGrantStore(adapter);
  const installed = {
    version: 1 as const,
    endpoint: 'https://authority.example.test/replication/v1/rpc',
    credentialId: 'source-writer',
    pairId: 'pair-a',
    tenantId: 'tenant-a',
    deploymentId: 'cf-main',
    epoch: 1,
    generationId: 'generation-a',
  };
  const scope = {
    version: 1 as const,
    kind: 'tenant_backup_export' as const,
    tenantId: 'tenant-a',
    pairId: 'pair-a',
    sourceDeploymentId: 'cf-main',
    destinationDeploymentId: 'aws-secondary',
    issuer: 'https://idp.example.test',
    selection: {
      settings: true,
      users: true,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
    },
  };
  const input = {
    tenantId: 'tenant-a',
    actorId: 'admin-a',
    scope,
    expiresAt: 1000,
    now: 100,
    auditId: 'audit-created',
    installed,
  };
  return { db, store, input, installed, scope };
}
describe('scoped replication export grants', () => {
  it('returns a random credential once, stores only its hash, binds source and allows idempotent audited revocation', async () => {
    const f = fixture();
    const first = await f.store.create(f.input);
    const second = await f.store.create(f.input);
    expect(first.credential).toMatch(/^[a-f0-9]{64}$/);
    expect(second.credential).not.toBe(first.credential);
    const rows = JSON.stringify(
      f.db.prepare('SELECT * FROM tenant_backup_replication_grants').all()
    );
    expect(rows).not.toContain(first.credential);
    expect(rows).not.toContain(second.credential);
    expect(rows).toContain('audit-created');
    const auth = {
      tenantId: 'tenant-a',
      id: first.grant.id,
      credential: first.credential,
      now: 101,
      installed: f.installed,
    };
    await expect(f.store.authenticate(auth)).resolves.toEqual(first.grant);
    const revoked = await f.store.revoke({
      tenantId: 'tenant-a',
      id: first.grant.id,
      actorId: 'admin-b',
      auditId: 'audit-revoked',
      now: 110,
    });
    expect(revoked?.revokedAt).toBe(110);
    await expect(f.store.authenticate({ ...auth, now: 111 })).rejects.toThrow();
    expect(
      await f.store.revoke({
        tenantId: 'tenant-a',
        id: first.grant.id,
        actorId: 'admin-c',
        auditId: 'audit-again',
        now: 112,
      })
    ).toEqual(revoked);
    expect(
      f.db
        .prepare(
          'SELECT revoked_by,revocation_audit_id FROM tenant_backup_replication_grants WHERE id=?'
        )
        .get(first.grant.id)
    ).toEqual({ revoked_by: 'admin-b', revocation_audit_id: 'audit-revoked' });
  });
  it.each(['expired', 'future', 'other-tenant', 'credential', 'pair', 'source', 'id'] as const)(
    'rejects %s credentials before exposing metadata',
    async (kind) => {
      const f = fixture();
      const created = await f.store.create(f.input);
      const auth = {
        tenantId: 'tenant-a',
        id: created.grant.id,
        credential: created.credential,
        now: 101,
        installed: { ...f.installed },
      };
      if (kind === 'expired') auth.now = 1000;
      if (kind === 'future') auth.now = 99;
      if (kind === 'other-tenant') auth.tenantId = 'tenant-b';
      if (kind === 'credential') auth.credential = 'b'.repeat(64);
      if (kind === 'pair') auth.installed.pairId = 'pair-b';
      if (kind === 'source') auth.installed.deploymentId = 'aws-secondary';
      if (kind === 'id') auth.id = 'other';
      await expect(f.store.authenticate(auth)).rejects.toThrow();
    }
  );
  it.each([
    'long',
    'expired',
    'same-target',
    'wrong-source',
    'wrong-tenant',
    'extra-scope',
  ] as const)('refuses invalid issuance: %s', async (kind) => {
    const f = fixture();
    const input = structuredClone(f.input);
    if (kind === 'long') input.expiresAt = input.now + REPLICATION_GRANT_MAX_AGE_MS + 1;
    if (kind === 'expired') input.expiresAt = input.now;
    if (kind === 'same-target')
      input.scope.destinationDeploymentId = input.scope.sourceDeploymentId;
    if (kind === 'wrong-source') input.scope.sourceDeploymentId = 'other';
    if (kind === 'wrong-tenant') input.scope.tenantId = 'tenant-b';
    if (kind === 'extra-scope') Object.assign(input.scope, { allowImport: true });
    await expect(f.store.create(input)).rejects.toThrow();
    expect(
      f.db.prepare('SELECT count(*) AS n FROM tenant_backup_replication_grants').get()
    ).toEqual({ n: 0 });
  });
  it('prevents scope/expiry/credential tampering and rejects corrupted stored scope after bypassed SQL trigger', async () => {
    const f = fixture();
    const created = await f.store.create(f.input);
    for (const statement of [
      'UPDATE tenant_backup_replication_grants SET expires_at=expires_at+1',
      "UPDATE tenant_backup_replication_grants SET scope_json='{}'",
      "UPDATE tenant_backup_replication_grants SET credential_sha256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
    ])
      expect(() => f.db.exec(statement)).toThrow('backup_replication_grant_immutable');
    f.db.exec(
      "DROP TRIGGER tenant_backup_replication_grant_immutable; UPDATE tenant_backup_replication_grants SET scope_json='{}'"
    );
    await expect(
      f.store.authenticate({
        tenantId: 'tenant-a',
        id: created.grant.id,
        credential: created.credential,
        now: 101,
        installed: f.installed,
      })
    ).rejects.toThrow();
  });
});
it('keeps export credentials tenant-specific under an environment writer installation', async () => {
  const f = fixture();
  const { tenantId: _tenant, ...source } = f.installed;
  const installed = { ...source, version: 2 as const, environmentId: 'test' };
  const issued = await f.store.create({ ...f.input, installed });
  await expect(
    f.store.authenticate({
      tenantId: 'tenant-a',
      id: issued.grant.id,
      credential: issued.credential,
      now: 200,
      installed,
    })
  ).resolves.toMatchObject({ scope: { tenantId: 'tenant-a', kind: 'tenant_backup_export' } });
  await expect(
    f.store.authenticate({
      tenantId: 'tenant-b',
      id: issued.grant.id,
      credential: issued.credential,
      now: 200,
      installed,
    })
  ).rejects.toThrow();
  await expect(
    f.store.authenticate({
      tenantId: 'tenant-a',
      id: issued.grant.id,
      credential: issued.credential,
      now: 200,
      installed: { ...installed, pairId: 'other' },
    })
  ).rejects.toThrow();
});
