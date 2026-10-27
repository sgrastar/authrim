import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { PostgresAuthorizationCodeStore } from '../postgres-authorization-code';
import type { PostgresQueryClient } from '../postgres-transient-state';

type TestPgClient = {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
};

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;

(databaseUrl ? it : it.skip)(
  'bounds Direct Auth code writes atomically per tenant/user',
  async () => {
    if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL is required');
    const moduleName = 'pg';
    const { Client } = (await import(moduleName)) as unknown as {
      Client: new (options: { connectionString: string }) => TestPgClient;
    };
    const first = new Client({ connectionString: databaseUrl });
    const second = new Client({ connectionString: databaseUrl });
    const schema = `aws_auth_code_test_${randomUUID().replaceAll('-', '')}`;
    let firstConnected = false;
    let secondConnected = false;
    let schemaCreated = false;
    try {
      await first.connect();
      firstConnected = true;
      await second.connect();
      secondConnected = true;
      await first.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      await first.query(`SET search_path TO "${schema}"`);
      await second.query(`SET search_path TO "${schema}"`);
      await first.query(
        await readFile(new URL('../authorization-code-schema.sql', import.meta.url), 'utf8')
      );
      const one = new PostgresAuthorizationCodeStore(first as unknown as PostgresQueryClient);
      const two = new PostgresAuthorizationCodeStore(second as unknown as PostgresQueryClient);
      const request = {
        tenantId: 'tenant-a',
        userId: 'user-a',
        clientId: 'saml-profile-client',
        redirectUri: 'https://authrim.local/direct-auth/callback',
        scope: 'openid profile email',
        codeChallenge: 'x'.repeat(43),
        codeChallengeMethod: 'S256' as const,
        ttlSeconds: 60,
        maxCodesPerUser: 1,
      };
      const codeA = randomUUID();
      const codeB = randomUUID();
      const concurrent = await Promise.allSettled([
        one.store({ ...request, code: codeA }),
        two.store({ ...request, code: codeB }),
      ]);
      expect(concurrent.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
      expect(concurrent.filter((value) => value.status === 'rejected')).toHaveLength(1);
      const saved = await first.query(
        'SELECT tenant_id, code_sha256, payload::text AS payload FROM authrim_aws_authorization_codes'
      );
      expect(saved.rows).toHaveLength(1);
      const payload = String((saved.rows[0] as { payload: string }).payload);
      expect(payload).not.toContain(codeA);
      expect(payload).not.toContain(codeB);
      expect((saved.rows[0] as { tenant_id: string }).tenant_id).toBe('tenant-a');
      await expect(one.store({ ...request, code: codeA })).rejects.toThrow(
        'aws_authorization_code_unavailable'
      );
      await one.store({ ...request, tenantId: 'tenant-b', code: randomUUID() });
      expect(
        (await first.query('SELECT * FROM authrim_aws_authorization_codes')).rows
      ).toHaveLength(2);
      await expect(
        one.store({ ...request, code: randomUUID(), codeChallengeMethod: 'plain' })
      ).rejects.toThrow('aws_authorization_code_profile_unsupported');
    } finally {
      if (schemaCreated) {
        await first.query('SET search_path TO public');
        await first.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
      if (secondConnected) await second.end();
      if (firstConnected) await first.end();
    }
  }
);
