/** Opt-in local engine contract tests. These endpoints must never point at AWS. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { StoreCodeRequest } from '@authrim/ar-lib-core/durable-objects/AuthorizationCodeStore';
import type { SAMLRequestData } from '@authrim/ar-lib-core';
import { createAwsStateStores } from '../create-state-stores';
import { createDynamoStateClient, DynamoStateTable } from '../dynamodb-state';
import type { AwsStateStores } from '../state-ports';
import type { PostgresQueryClient } from '../postgres-transient-state';

type PgClient = PostgresQueryClient & { connect(): Promise<void>; end(): Promise<void> };
const postgresUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
const dynamoEndpoint = process.env.AUTHRIM_AWS_TEST_DYNAMODB_ENDPOINT;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function loopback(value: string): void {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname))
    throw new Error('Local contract tests require loopback endpoints');
}
const countSuccess = (results: PromiseSettledResult<unknown>[]) =>
  results.filter((r) => r.status === 'fulfilled').length;

for (const backend of ['postgresql', 'dynamodb'] as const) {
  const enabled = backend === 'postgresql' ? !!postgresUrl : !!dynamoEndpoint;
  describe.skipIf(!enabled)(`${backend} state contract (local engine)`, () => {
    let stores: AwsStateStores;
    let pg: PgClient | undefined;
    let dynamo: DynamoDBClient | undefined;
    let table: DynamoStateTable | undefined;
    let created = false;
    const name = `authrim_state_test_${randomUUID().replaceAll('-', '')}`;
    const tenant = 'contract-tenant';
    const active = (user: string) =>
      stores.accountAuthentication.initializeAccountStateRpc(
        tenant,
        user,
        `account:${user}`,
        'active',
        Date.now()
      );
    const lifecycle = async (user: string, status: string, revoked?: number) => {
      if (pg) {
        await pg.query(
          'UPDATE authrim_aws_account_auth_state SET lifecycle=$3, revoked_after_ms=$4, lifecycle_version_ms=$5 WHERE tenant_id=$1 AND user_id=$2',
          [tenant, user, status, revoked ?? null, Date.now()]
        );
      } else {
        if (!dynamo || !table) throw new Error('local store missing');
        await dynamo.send(
          new UpdateItemCommand({
            TableName: name,
            Key: table.accountKey(tenant, user),
            UpdateExpression:
              'SET lifecycle = :status, revision = :revision, lifecycleVersionMs = :now' +
              (revoked === undefined ? '' : ', revokedAfterMs = :revoked'),
            ExpressionAttributeValues: {
              ':status': { S: status },
              ':revision': { S: randomUUID() },
              ':now': { N: String(Date.now()) },
              ...(revoked === undefined ? {} : { ':revoked': { N: String(revoked) } }),
            },
          })
        );
      }
    };
    beforeAll(async () => {
      if (backend === 'postgresql') {
        if (!postgresUrl) throw new Error('Local PostgreSQL URL required');
        loopback(postgresUrl);
        const moduleName = 'pg';
        const { Client } = (await import(moduleName)) as {
          Client: new (options: { connectionString: string }) => PgClient;
        };
        pg = new Client({ connectionString: postgresUrl });
        await pg.connect();
        await pg.query(`CREATE SCHEMA "${name}"`, []);
        created = true;
        await pg.query(`SET search_path TO "${name}"`, []);
        for (const file of [
          'account-auth-schema.sql',
          'schema.sql',
          'rate-limit-schema.sql',
          'authorization-code-schema.sql',
          'persistent-nameid-schema.sql',
        ]) {
          await pg.query(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), []);
        }
        const { Pool } = (await import(moduleName)) as {
          Pool: new (options: {
            connectionString: string;
            options: string;
            max: number;
          }) => Omit<PgClient, 'connect'>;
        };
        await pg.end();
        const pool = new Pool({
          connectionString: postgresUrl,
          options: `-c search_path=${name}`,
          max: 16,
        });
        pg = { query: pool.query.bind(pool), end: () => pool.end(), connect: async () => {} };
        stores = createAwsStateStores({ backend, db: pg });
      } else {
        if (!dynamoEndpoint) throw new Error('Local DynamoDB endpoint required');
        loopback(dynamoEndpoint);
        dynamo = createDynamoStateClient({
          endpoint: dynamoEndpoint,
          region: 'ap-northeast-1',
          credentials: { accessKeyId: 'localtest', secretAccessKey: 'localtest' },
        });
        await dynamo.send(
          new CreateTableCommand({
            TableName: name,
            AttributeDefinitions: [
              { AttributeName: 'pk', AttributeType: 'S' },
              { AttributeName: 'sk', AttributeType: 'S' },
            ],
            KeySchema: [
              { AttributeName: 'pk', KeyType: 'HASH' },
              { AttributeName: 'sk', KeyType: 'RANGE' },
            ],
            BillingMode: 'PAY_PER_REQUEST',
          })
        );
        created = true;
        const options = { client: dynamo, tableName: name, namespace: 'generation-one' };
        table = new DynamoStateTable(options);
        stores = createAwsStateStores({ backend, ...options });
      }
    }, 30000);
    afterAll(async () => {
      if (pg) {
        if (created) await pg.query(`DROP SCHEMA "${name}" CASCADE`, []);
        await pg.end();
      }
      if (dynamo) {
        if (created) await dynamo.send(new DeleteTableCommand({ TableName: name }));
        dynamo.destroy();
      }
    });
    it('never initializes a missing account by reading, and never reactivates one by initialize', async () => {
      expect(
        (
          await stores.accountAuthentication.getAccountStateRpc(
            tenant,
            'missing',
            'account:missing'
          )
        ).lifecycle
      ).toBeNull();
      await stores.accountAuthentication.initializeAccountStateRpc(
        tenant,
        'suspended',
        'account:suspended',
        'suspended',
        1000
      );
      expect((await active('suspended')).lifecycle).toBe('suspended');
      await expect(
        stores.accountAuthentication.getAccountStateRpc(tenant, 'missing', 'account:other')
      ).rejects.toThrow();
    });
    it('creates sessions only for active accounts, binds revocation and rejects cross-tenant reads', async () => {
      const input = {
        tenantId: tenant,
        sessionId: randomUUID(),
        userId: 'session-user',
        ttlMs: 60000,
      };
      await expect(stores.state.createSession(input)).rejects.toThrow();
      await active(input.userId);
      const session = await stores.state.createSession(input);
      expect((await stores.state.getSession(input))?.userId).toBe(input.userId);
      expect(await stores.state.getSession({ ...input, tenantId: 'another-tenant' })).toBeNull();
      await expect(stores.state.createSession(input)).rejects.toThrow();
      await lifecycle(input.userId, 'active', session.revocationBoundAtMs);
      expect(await stores.state.getSession(input)).toBeNull();
      const newInput = { ...input, sessionId: randomUUID() };
      expect((await stores.state.createSession(newInput)).revocationBoundAtMs).toBeGreaterThan(
        session.revocationBoundAtMs
      );
      await lifecycle(input.userId, 'suspended');
      expect(await stores.state.getSession(newInput)).toBeNull();
      expect(await stores.state.deleteSession(newInput)).toBe(true);
      expect(await stores.state.deleteSession(newInput)).toBe(false);
    });
    it('serializes challenge claim and consume, retaining records after wrong bindings', async () => {
      const input = {
        tenantId: tenant,
        id: randomUUID(),
        type: 'passkey',
        userId: 'challenge-user',
        challenge: 'secret-challenge',
        ttlMs: 60000,
      };
      const claims = await Promise.all(
        Array.from({ length: 12 }, () => stores.state.claimChallenge(input))
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      for (const wrong of [
        { ...input, tenantId: 'other-tenant' },
        { ...input, type: 'other' },
        { ...input, challenge: 'wrong-secret' },
      ])
        expect(await stores.state.consumeChallenge(wrong)).toBeNull();
      const consumed = await Promise.all(
        Array.from({ length: 12 }, () => stores.state.consumeChallenge(input))
      );
      expect(consumed.filter(Boolean)).toHaveLength(1);
      expect(await stores.state.getChallenge(input)).toBeNull();
      expect(await stores.state.storeChallenge({ ...input, challenge: 'next-owner' })).toBe(true);
      expect(await stores.state.consumeChallenge(input)).toBeNull();
      expect(
        await stores.state.isChallengeClaimHeld({
          ...input,
          challenge: 'next-owner',
          minRemainingMs: 1000,
        })
      ).toBe(true);
    });
    it('enforces expiry without cleanup and clips challenges to the parent deadline', async () => {
      const input = {
        tenantId: tenant,
        id: randomUUID(),
        type: 'passkey',
        userId: 'expiry-user',
        challenge: 'challenge',
        ttlMs: 60000,
        notAfterMs: Date.now() + 250,
      };
      expect(await stores.state.storeChallenge(input)).toBe(true);
      await delay(280);
      expect(await stores.state.getChallenge(input)).toBeNull();
      expect(await stores.state.consumeChallenge(input)).toBeNull();
      expect(await stores.state.storeChallenge({ ...input, notAfterMs: Date.now() - 1 })).toBe(
        false
      );
    });
    it('retains SAML immutable bindings and original deadline across trusted continuations', async () => {
      const request = {
        requestId: randomUUID(),
        issuer: 'https://sp.example.test',
        destination: 'https://idp.example.test/saml',
        acsUrl: 'https://sp.example.test/acs',
        binding: 'HTTP-Redirect',
        type: 'authn_request',
        createdAt: Date.now(),
        expiresAt: Date.now() + 30000,
        used: false,
        data: { a: 1, b: 2 },
      } as unknown as SAMLRequestData;
      const input = { tenantId: tenant, spEntityId: request.issuer, request };
      await stores.state.storeSamlRequest(input);
      const consume = {
        tenantId: tenant,
        spEntityId: input.spEntityId,
        requestId: request.requestId,
      };
      expect(
        await stores.state.consumeSamlRequest({
          ...consume,
          spEntityId: 'https://wrong-sp.example.test',
        })
      ).toBeNull();
      const once = await Promise.all(
        Array.from({ length: 8 }, () => stores.state.consumeSamlRequest(consume))
      );
      expect(once.filter(Boolean)).toHaveLength(1);
      await expect(
        stores.state.storeSamlRequest({
          ...input,
          request: { ...request, destination: 'https://attacker.example.test' },
        })
      ).rejects.toThrow();
      await stores.state.storeSamlRequest({
        ...input,
        request: {
          ...request,
          expiresAt: request.expiresAt + 1000,
          data: { b: 2, a: 1 },
        } as unknown as SAMLRequestData,
      });
      expect((await stores.state.consumeSamlRequest(consume))?.expiresAt).toBe(request.expiresAt);
    });
    it('keeps KV tenant scoped, supports overwrite and rejects expired keys', async () => {
      const input = { tenantId: tenant, key: randomUUID(), value: 'one', ttlMs: 60000 };
      await stores.state.putKey(input);
      expect(await stores.state.getKey({ ...input, tenantId: 'other' })).toBeNull();
      await stores.state.putKey({ ...input, value: 'two' });
      expect(await stores.state.getKey(input)).toBe('two');
      expect(await stores.state.deleteKey(input)).toBe(true);
      expect(await stores.state.getKey(input)).toBeNull();
      await stores.state.putKey({ ...input, ttlMs: 100 });
      await delay(120);
      expect(await stores.state.getKey(input)).toBeNull();
    });
    it('advances monotonic passkey counters once, with the explicit zero-counter exception', async () => {
      const user = 'counter-user';
      await active(user);
      const advance = (source: number, next: number) =>
        stores.accountAuthentication.advancePasskeyCounterRpc(
          tenant,
          user,
          `account:${user}`,
          'credential',
          source,
          next,
          Date.now()
        );
      expect(await advance(0, 0)).toEqual({ counter: 0, advanced: false });
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => advance(0, 1)));
      expect(countSuccess(results)).toBe(1);
      await expect(advance(0, 0)).rejects.toThrow('passkey_counter_replay');
      await expect(advance(5, 4)).rejects.toThrow('passkey_counter_replay');
      expect(await advance(5, 6)).toEqual({ counter: 6, advanced: true });
      await lifecycle(user, 'suspended');
      await expect(advance(6, 7)).rejects.toThrow('account_authentication_not_allowed');
    });
    it('enforces an atomic rate limit under concurrency and separates global and tenant scope', async () => {
      const input = { tenantId: tenant, key: randomUUID(), windowSeconds: 60, maxRequests: 3 };
      const results = await Promise.all(
        Array.from({ length: 12 }, () => stores.rateLimit.check(input))
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(3);
      expect(results.every((r) => r.remaining >= 0)).toBe(true);
      expect(new Set(results.map((r) => r.resetAt)).size).toBe(1);
      expect((await stores.rateLimit.check({ ...input, tenantId: undefined })).allowed).toBe(true);
      expect((await stores.rateLimit.check({ ...input, tenantId: 'other' })).allowed).toBe(true);
    });
    const code = (user: string): StoreCodeRequest => ({
      code: randomUUID(),
      tenantId: tenant,
      userId: user,
      clientId: 'direct-auth',
      redirectUri: 'https://authrim.local/direct-auth/callback',
      codeChallenge: 'test-challenge',
      codeChallengeMethod: 'S256',
      scope: 'openid',
      ttlSeconds: 60,
      maxCodesPerUser: 2,
    });
    it('serializes per-user authorization-code budget and tenant-wide code uniqueness', async () => {
      const input = code('budget-user');
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () =>
          stores.authorizationCodes.store({ ...input, code: randomUUID() })
        )
      );
      expect(countSuccess(results)).toBe(2);
      const unique = code('unique-user');
      await stores.authorizationCodes.store(unique);
      await expect(
        stores.authorizationCodes.store({ ...unique, userId: 'another-user' })
      ).rejects.toThrow();
      expect(
        (await stores.authorizationCodes.store({ ...unique, tenantId: 'other-tenant' })).success
      ).toBe(true);
    });
    it('releases authorization-code capacity after expiry without deleting its duplicate guard', async () => {
      const input = { ...code('expiry-code-user'), maxCodesPerUser: 1, ttlSeconds: 1 };
      await stores.authorizationCodes.store(input);
      await expect(
        stores.authorizationCodes.store({ ...input, code: randomUUID() })
      ).rejects.toThrow();
      await delay(1100);
      expect(
        (await stores.authorizationCodes.store({ ...input, code: randomUUID() })).success
      ).toBe(true);
      await expect(
        stores.authorizationCodes.store({ ...input, userId: 'other-user' })
      ).rejects.toThrow();
    });
    it('accepts concurrent identical NameIDs despite timestamp/order differences and preserves the winner', async () => {
      const key = `saml:persistent-nameid:tenant:${tenant}:sp:https%3A%2F%2Fsp.example.test:subject:nameid-user`;
      const record = (createdAt: number, nameId = 'stable-nameid') =>
        JSON.stringify({
          version: 1,
          tenantId: tenant,
          spEntityId: 'https://sp.example.test',
          subjectId: 'nameid-user',
          nameId,
          createdAt,
        });
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          stores.persistentNameIDs.put({ tenantId: tenant, key, value: record(i + 1000) })
        )
      );
      expect(countSuccess(results)).toBe(12);
      const saved = await stores.persistentNameIDs.get({ tenantId: tenant, key });
      expect(saved).not.toBeNull();
      await stores.persistentNameIDs.put({ tenantId: tenant, key, value: record(2000) });
      expect(await stores.persistentNameIDs.get({ tenantId: tenant, key })).toBe(saved);
      await expect(
        stores.persistentNameIDs.put({ tenantId: tenant, key, value: record(3000, 'changed') })
      ).rejects.toThrow('aws_persistent_nameid_conflict');
      await expect(stores.persistentNameIDs.get({ tenantId: 'other', key })).rejects.toThrow(
        'aws_persistent_nameid_invalid'
      );
    });
  });
}
