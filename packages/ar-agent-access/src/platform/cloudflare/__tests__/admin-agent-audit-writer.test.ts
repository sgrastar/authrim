import { describe, expect, it } from 'vitest';
import { logProducerFixture } from '../../../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import { createCloudflareAdminAgentAuditWriter } from '../admin-agent-audit-writer';
import type { AdminAgentAuditWrite } from '../../../core/audit';

const audit = (at: number): AdminAgentAuditWrite => ({
  id: 'grant-audit-1',
  tenantId: 'tenant-a',
  adminUserId: 'admin-a',
  action: 'agent_grant.update',
  resourceType: 'agent_grant',
  resourceId: 'grant-a',
  severity: 'critical',
  actorType: 'agent',
  actorSub: 'actor-a',
  grantId: 'grant-a',
  metadata: { private_email: 'private@example.invalid' },
  createdAt: at,
});

for (const mode of ['scheduled', 'pipeline'] as const)
  describe(`${mode} atomic Admin audit`, () => {
    it('commits business evidence and only the selected durable destination', async () => {
      const f = await logProducerFixture(mode);
      try {
        f.db.exec(
          "CREATE TABLE audit_business(id TEXT PRIMARY KEY, version INTEGER, mutation TEXT); INSERT INTO audit_business VALUES('one',1,NULL)"
        );
        const prepare = createCloudflareAdminAgentAuditWriter(f.env);
        const statements = await prepare(f.adapter, audit(f.now), {
          from: 'audit_business',
          where: "id='one' AND version=2 AND mutation='accepted'",
          params: [],
        });
        await f.adapter.batch([
          {
            sql: "UPDATE audit_business SET version=2,mutation='accepted' WHERE id='one' AND version=1",
          },
          ...statements,
        ]);
        expect(f.db.prepare('SELECT COUNT(*) n FROM admin_audit_receipts').get()).toMatchObject({
          n: 1,
        });
        const rows = await f.rows('admin.admin_audit_log');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          id: 'grant-audit-1',
          actor_sub: 'actor-a',
          grant_id: 'grant-a',
        });
        expect(rows[0].metadata_json).not.toContain('private@example.invalid');
        expect(f.db.prepare('SELECT COUNT(*) n FROM log_iceberg_records').get()).toMatchObject({
          n: mode === 'scheduled' ? 1 : 0,
        });
        expect(f.objects.size).toBe(mode === 'pipeline' ? 1 : 0);
        expect(f.queueMessages).toHaveLength(0); // The durable minute scanner dispatches this batch.
        await f.adapter.batch(await prepare(f.adapter, audit(f.now)));
        expect(await f.rows('admin.admin_audit_log')).toHaveLength(1);
        await expect(async () =>
          f.adapter.batch(
            await prepare(f.adapter, {
              ...audit(f.now),
              metadata: { private_email: 'different@example.invalid' },
            })
          )
        ).rejects.toThrow();
        expect(await f.rows('admin.admin_audit_log')).toHaveLength(1);
      } finally {
        f.db.close();
      }
    });

    it('publishes nothing when the CAS changes zero rows or a later statement rolls back', async () => {
      const f = await logProducerFixture(mode);
      try {
        f.db.exec(
          "CREATE TABLE audit_business(id TEXT PRIMARY KEY, version INTEGER, mutation TEXT); INSERT INTO audit_business VALUES('one',1,NULL)"
        );
        const prepare = createCloudflareAdminAgentAuditWriter(f.env);
        const guard = {
          from: 'audit_business',
          where: "id='one' AND version=2 AND mutation='accepted'",
          params: [],
        };
        await f.adapter.batch([
          { sql: "UPDATE audit_business SET version=2,mutation='accepted' WHERE version=9" },
          ...(await prepare(f.adapter, audit(f.now), guard)),
        ]);
        expect(await f.rows('admin.admin_audit_log')).toHaveLength(0);
        expect(f.db.prepare('SELECT COUNT(*) n FROM admin_audit_receipts').get()).toMatchObject({
          n: 0,
        });
        await expect(
          f.adapter.batch([
            { sql: "UPDATE audit_business SET version=2,mutation='accepted' WHERE version=1" },
            ...(await prepare(f.adapter, audit(f.now), guard)),
            { sql: 'INSERT INTO audit_business(id) VALUES(NULL)' },
            { sql: 'SELECT * FROM missing_audit_business_table' },
          ])
        ).rejects.toThrow();
        expect(
          f.db.prepare("SELECT version FROM audit_business WHERE id='one'").get()
        ).toMatchObject({ version: 1 });
        expect(await f.rows('admin.admin_audit_log')).toHaveLength(0);
        expect(f.db.prepare('SELECT COUNT(*) n FROM admin_audit_receipts').get()).toMatchObject({
          n: 0,
        });
        expect(f.queueMessages).toHaveLength(0);
        if (mode === 'pipeline')
          expect(f.db.prepare('SELECT state FROM log_iceberg_outbox').all()).toEqual([
            { state: 'preparing' },
          ]);
      } finally {
        f.db.close();
      }
    });
  });
