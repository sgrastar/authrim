import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createPostgresAuditRuntimePorts } from '../postgres-audit';
import type { PostgresQueryClient } from '../postgres-transient-state';

type TestPgClient = {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
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
    const audit = createPostgresAuditRuntimePorts(client as unknown as PostgresQueryClient, [
      'tenant-a',
      'tenant-b',
    ]);
    const entry = {
      id: 'event-1',
      tenantId: 'tenant-a',
      userId: 'user-a',
      action: 'user.login',
      resource: 'session',
      resourceId: 'opaque',
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
  } finally {
    if (schemaCreated) {
      await client.query('SET search_path TO public');
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    if (connected) await client.end();
  }
});
