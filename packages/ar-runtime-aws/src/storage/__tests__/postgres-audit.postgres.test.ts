import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createPostgresAuditRuntimePorts } from '../postgres-audit';
import {
  countLegacyAuditSessionIds,
  repairLegacyAuditSessionIds,
} from '../repair-audit-session-ids';

type TestPgClient = {
  connect(): Promise<void>;
  query<T extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  end(): Promise<void>;
};

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;

(databaseUrl ? it : it.skip)('persists only sanitized tenant-scoped audit events', async () => {
  if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL is required');
  const moduleName = 'pg';
  const { Client } = (await import(moduleName)) as unknown as {
    Client: new (options: { connectionString: string }) => TestPgClient;
  };
  const client = new Client({ connectionString: databaseUrl });
  const schema = `aws_audit_test_${randomUUID().replaceAll('-', '')}`;
  let connected = false;
  let schemaCreated = false;
  try {
    await client.connect();
    connected = true;
    await client.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(await readFile(new URL('../audit-schema.sql', import.meta.url), 'utf8'));
    const audit = createPostgresAuditRuntimePorts(client, ['tenant-a', 'tenant-b']);
    const entry = {
      id: 'event-1',
      tenantId: 'tenant-a',
      userId: 'user-a',
      action: 'user.login',
      resource: 'session',
      resourceId: `sid_${'a'.repeat(64)}`,
      ipAddress: '203.0.113.7',
      userAgent: 'test',
      metadata: JSON.stringify({ password: 'do-not-store', result: 'success' }),
      severity: 'info' as const,
      createdAt: 1_800_000_000_000,
    };
    await audit.append(entry);
    await audit.append(entry);
    await expect(audit.append({ ...entry, action: 'user.logout' })).rejects.toThrow(
      'aws_audit_event_conflict'
    );
    await audit.append({ ...entry, tenantId: 'tenant-b' });
    const rows = await client.query(
      'SELECT tenant_id, action, payload::text AS payload FROM authrim_aws_audit_events ORDER BY tenant_id'
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((value) => (value as { tenant_id: string }).tenant_id)).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
    for (const value of rows.rows) {
      const payload = String((value as { payload: string }).payload);
      expect(payload).not.toContain('do-not-store');
      expect(payload).toContain('success');
    }

    const legacyId = 'live-session-credential';
    const legacyPayload = {
      ...entry,
      id: 'legacy-session',
      resourceId: legacyId,
      createdAt: Date.now() - 1000,
    };
    const nonSessionPayload = {
      ...legacyPayload,
      id: 'unrelated-client',
      resource: 'client',
    };
    for (const payload of [legacyPayload, nonSessionPayload]) {
      await client.query(
        `INSERT INTO authrim_aws_audit_events
           (tenant_id, id, created_at_ms, action, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [payload.tenantId, payload.id, payload.createdAt, payload.action, JSON.stringify(payload)]
      );
    }
    expect(await countLegacyAuditSessionIds(client)).toBe(1);
    expect(await repairLegacyAuditSessionIds(client, 1)).toEqual({ updated: 1, remaining: 0 });
    const repaired = await client.query(
      `SELECT id, payload->>'resourceId' AS resource_id
         FROM authrim_aws_audit_events
        WHERE id IN ('legacy-session', 'unrelated-client') ORDER BY id`
    );
    const bytes = new TextEncoder();
    const digest = createHash('sha256')
      .update(
        new Uint8Array([...bytes.encode('authrim:event_log:session'), 0, ...bytes.encode(legacyId)])
      )
      .digest('hex');
    expect(repaired.rows).toEqual([
      { id: 'legacy-session', resource_id: `sid_${digest}` },
      { id: 'unrelated-client', resource_id: legacyId },
    ]);
    expect(await repairLegacyAuditSessionIds(client)).toEqual({ updated: 0, remaining: 0 });
  } finally {
    if (schemaCreated) {
      await client.query('SET search_path TO public');
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    if (connected) await client.end();
  }
});
