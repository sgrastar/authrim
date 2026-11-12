import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { SAMLRequestData } from '@authrim/ar-lib-core';
import { PostgresAccountAuthStateStore } from '../postgres-account-auth-state';
import { PostgresTransientStateStore, type PostgresQueryClient } from '../postgres-transient-state';

type TestPgClient = {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
};

const databaseUrl = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.AUTHRIM_AWS_TEST_DATABASE_URL;

/** Runs against a disposable schema in an explicitly supplied PostgreSQL database. */
(databaseUrl ? it : it.skip)(
  'enforces tenant, replay, expiry and concurrent consume in PostgreSQL (AUTHRIM_AWS_TEST_DATABASE_URL)',
  async () => {
    if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL is required');
    const moduleName = 'pg';
    const { Client } = (await import(moduleName)) as unknown as {
      Client: new (options: { connectionString: string }) => TestPgClient;
    };
    const first = new Client({ connectionString: databaseUrl });
    const second = new Client({ connectionString: databaseUrl });
    const schema = `aws_transient_test_${randomUUID().replaceAll('-', '')}`;
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
      await first.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
      await first.query(
        await readFile(new URL('../account-auth-schema.sql', import.meta.url), 'utf8')
      );

      const storeA = new PostgresTransientStateStore(first as unknown as PostgresQueryClient);
      const storeB = new PostgresTransientStateStore(second as unknown as PostgresQueryClient);
      const tenantId = 'tenant-a';
      const spEntityId = 'https://sp.example.test/metadata';
      const now = Date.now();
      const request: SAMLRequestData = {
        requestId: '_real-pg-request',
        issuer: spEntityId,
        destination: 'https://idp.example.test/sso',
        acsUrl: 'https://sp.example.test/acs',
        binding: 'post',
        type: 'authn_request',
        used: false,
        createdAt: now,
        expiresAt: now + 300_000,
        retainUntil: now + 600_000,
      };
      expect(await storeA.createSamlRequest({ tenantId, spEntityId, request })).toBe(true);
      expect(await storeB.createSamlRequest({ tenantId, spEntityId, request })).toBe(false);
      const key = { tenantId, spEntityId, requestId: request.requestId };
      expect(await storeB.readSamlRequest({ ...key, tenantId: 'tenant-b' })).toBeNull();
      expect(
        await storeB.readSamlRequest({ ...key, spEntityId: 'https://other.example.test' })
      ).toBeNull();
      expect(await storeB.readSamlRequest(key)).toMatchObject({ revision: 1, used: false });
      const updated = await storeA.updateSamlRequest({
        ...key,
        expectedRevision: 1,
        context: { reauthentication: { issuedAt: Date.now() } },
      });
      expect(updated?.revision).toBe(2);
      expect(
        await storeB.updateSamlRequest({ ...key, expectedRevision: 1, context: {} })
      ).toBeNull();
      const race = await Promise.all([
        storeA.completeSamlRequest({ ...key, expectedRevision: 2 }),
        storeB.completeSamlRequest({ ...key, expectedRevision: 2 }),
      ]);
      expect(race.filter(Boolean)).toHaveLength(1);
      expect(race.find(Boolean)?.expiresAt).toBe(request.expiresAt);
      expect(await storeA.completeSamlRequest(key)).toBeNull();
      // A completed request keeps blocking the id until its retention.
      expect(await storeA.createSamlRequest({ tenantId, spEntityId, request })).toBe(false);

      const challenge = {
        tenantId,
        id: 'login-challenge',
        type: 'login',
        userId: 'user-a',
        challenge: 'secret-value',
        ttlMs: 60_000,
      };
      expect(await storeA.storeChallenge(challenge)).toBe(true);
      expect(
        await storeB.consumeChallenge({
          tenantId: 'tenant-b',
          id: challenge.id,
          type: challenge.type,
          challenge: challenge.challenge,
        })
      ).toBeNull();
      expect(
        await storeB.consumeChallenge({
          tenantId,
          id: challenge.id,
          type: challenge.type,
          challenge: 'wrong',
        })
      ).toBeNull();
      const consumeChallenge = {
        tenantId,
        id: challenge.id,
        type: challenge.type,
        challenge: challenge.challenge,
      };
      const secondRace = await Promise.all([
        storeA.consumeChallenge(consumeChallenge),
        storeB.consumeChallenge(consumeChallenge),
      ]);
      expect(secondRace.filter(Boolean)).toHaveLength(1);

      const accountA = new PostgresAccountAuthStateStore(first as unknown as PostgresQueryClient);
      const accountB = new PostgresAccountAuthStateStore(second as unknown as PostgresQueryClient);
      expect(
        (await accountA.getAccountStateRpc(tenantId, 'user-a', 'account:user-a')).lifecycle
      ).toBeNull();
      await expect(
        accountA.advancePasskeyCounterRpc(
          tenantId,
          'user-a',
          'account:user-a',
          'passkey-1',
          0,
          1,
          Date.now()
        )
      ).rejects.toThrow('account_auth_state_uninitialized');
      await expect(
        storeA.createSession({
          tenantId,
          sessionId: 'unseeded-session',
          userId: 'user-a',
          ttlMs: 60_000,
        })
      ).rejects.toThrow('Session unavailable');
      await accountA.initializeAccountStateRpc(
        tenantId,
        'user-a',
        'account:user-a',
        'active',
        Date.now()
      );

      const newSession = await storeA.createSession({
        tenantId,
        sessionId: 'new-aws-session',
        userId: 'user-a',
        ttlMs: 60_000,
        data: { amr: ['pwd'], proven_at: Date.now() },
      });
      expect(
        await storeB.getSession({
          tenantId: 'tenant-b',
          sessionId: 'new-aws-session',
        })
      ).toBeNull();
      expect((await storeB.getSession({ tenantId, sessionId: 'new-aws-session' }))?.userId).toBe(
        'user-a'
      );
      await first.query(
        'UPDATE authrim_aws_account_auth_state SET revoked_after_ms = $3 WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, 'user-a', newSession.revocationBoundAtMs]
      );
      expect(await storeB.getSession({ tenantId, sessionId: 'new-aws-session' })).toBeNull();
      expect(await storeB.deleteSession({ tenantId, sessionId: 'new-aws-session' })).toBe(true);
      expect(await storeA.getSession({ tenantId, sessionId: 'new-aws-session' })).toBeNull();

      await storeA.putKey({ tenantId, key: 'short-lived', value: 'v', ttlMs: 5 });
      await setTimeout(30);
      expect(await storeB.getKey({ tenantId, key: 'short-lived' })).toBeNull();
      expect(await storeA.pruneExpired()).toBeGreaterThan(0);

      const counterRace = await Promise.allSettled([
        accountA.advancePasskeyCounterRpc(
          tenantId,
          'user-a',
          'account:user-a',
          'passkey-1',
          0,
          7,
          Date.now()
        ),
        accountB.advancePasskeyCounterRpc(
          tenantId,
          'user-a',
          'account:user-a',
          'passkey-1',
          0,
          7,
          Date.now()
        ),
      ]);
      expect(counterRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(counterRace.filter((result) => result.status === 'rejected')).toHaveLength(1);
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
