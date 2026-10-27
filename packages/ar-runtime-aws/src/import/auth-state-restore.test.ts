import { readSyntheticDynamoAuthStateSnapshot } from '../maintenance/selected-auth-state-snapshot';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  PutItemCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import { createDynamoStateClient, DynamoStateTable } from '../storage/dynamodb-state';
import { createAwsStateStores } from '../storage/create-state-stores';
import {
  normalizeAwsAuthStateConfig,
  type DynamoAuthStateConfig,
} from '../storage/auth-state-config';
import {
  awsStateSupplementPayloadSha256,
  type VerifiedAwsStateSupplement,
  type AwsStateSourceExpectations,
} from './state-restore';
import {
  restoreVerifiedDynamoAuthState,
  createDynamoAuthStateRestoreReceipt,
  assertDynamoAuthStateSealed,
  assertDynamoAuthStateLiveCompatible,
  assertVerifiedDynamoAuthStateRestored,
  readDynamoAuthStateCounters,
} from './auth-state-restore';

const TENANT = 'tenant-a';
const NOW = 1_700_000_000_000;
const SP = 'https://sp.example.test';
const registryKey = `saml:persistent-nameid:tenant:${TENANT}:sp:${encodeURIComponent(SP)}:subject:user-1`;
const manifest: TenantBundleManifest = {
  formatVersion: 1,
  bundleId: 'a'.repeat(32),
  source: { tenantId: TENANT, issuer: 'https://tenant-a.example.test', productVersion: '0.4.2' },
  snapshotId: 'snapshot-a',
  boundaryUnixMs: NOW,
  inventoryDigestSha256: 'b'.repeat(64),
  selection: {
    settings: true,
    users: true,
    admin: false,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 7 },
  },
  datasets: [
    {
      id: 'core.identity_accounts',
      module: 'users',
      kind: 'users',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    },
  ],
};
const expected: AwsStateSourceExpectations = {
  users: [{ userId: 'user-1' }],
  accounts: [{ accountId: 'account:user-1', userId: 'user-1', lifecycle: 'active' }],
  passkeys: [
    { passkeyId: 'passkey-1', userId: 'user-1', credentialId: 'cred-1', sourceCounter: '5' },
  ],
};

function supplement(): VerifiedAwsStateSupplement {
  const valueJson = JSON.stringify({
    version: 1,
    tenantId: TENANT,
    spEntityId: SP,
    subjectId: 'user-1',
    nameId: 'pairwise-user-1',
    createdAt: NOW - 2000,
  });
  const value: VerifiedAwsStateSupplement = {
    receipt: {
      tenantId: TENANT,
      issuer: manifest.source.issuer,
      productVersion: manifest.source.productVersion,
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
      supplementSha256: '',
    },
    accountAuthStates: [
      {
        tenantId: TENANT,
        userId: 'user-1',
        accountId: 'account:user-1',
        lifecycle: 'active',
        lifecycleVersionMs: NOW - 2000,
        lifecycleOperationId: null,
        revokedAfterMs: null,
        lastLoginAtMs: NOW - 1000,
      },
    ],
    passkeyCounters: [
      {
        tenantId: TENANT,
        passkeyId: 'passkey-1',
        userId: 'user-1',
        credentialId: 'cred-1',
        counter: '5',
        updatedAtMs: NOW - 1000,
      },
    ],
    persistentNameIdsComplete: true,
    persistentNameIds: [{ tenantId: TENANT, registryKey, valueJson, createdAtMs: NOW - 2000 }],
  };
  value.receipt.supplementSha256 = awsStateSupplementPayloadSha256(value);
  return value;
}

function repin(value: VerifiedAwsStateSupplement): VerifiedAwsStateSupplement {
  value.receipt.supplementSha256 = awsStateSupplementPayloadSha256(value);
  return value;
}

describe('authentication state deployment descriptor', () => {
  const target = {
    backend: 'dynamodb',
    region: 'ap-northeast-1',
    tableArn: 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/auth-state',
    namespace: '00000000-0000-4000-8000-000000000000',
  } as const;
  it('defaults only absent legacy config to PostgreSQL', () => {
    expect(normalizeAwsAuthStateConfig(undefined)).toEqual({ backend: 'postgresql' });
    expect(normalizeAwsAuthStateConfig({ backend: 'postgresql' })).toEqual({
      backend: 'postgresql',
    });
    for (const input of [
      null,
      {},
      { backend: 'other' },
      { backend: 'postgresql', tableArn: target.tableArn },
      { ...target, namespace: '' },
      { ...target, region: 'us-east-1' },
      { ...target, endpoint: 'http://elsewhere' },
    ])
      expect(() => normalizeAwsAuthStateConfig(input)).toThrow();
  });
  it('pins account, region, and restore generation independently', () => {
    expect(
      normalizeAwsAuthStateConfig(target, {
        accountId: '123456789012',
        region: target.region,
        restoreId: target.namespace,
      })
    ).toEqual(target);
    for (const context of [
      { accountId: '000000000000' },
      { region: 'us-east-1' },
      { restoreId: randomUUID() },
    ])
      expect(() => normalizeAwsAuthStateConfig(target, context)).toThrow();
  });
});

const endpoint = process.env.AUTHRIM_AWS_TEST_DYNAMODB_ENDPOINT;
describe.skipIf(!endpoint)('verified DynamoDB generation restore (local engine)', () => {
  const tableName = `authrim_restore_${randomUUID().replaceAll('-', '')}`;
  const client = createDynamoStateClient({
    region: 'ap-northeast-1',
    endpoint,
    credentials: { accessKeyId: 'localtest', secretAccessKey: 'localtest' },
  });
  let tableArn: string;
  beforeAll(async () => {
    if (!endpoint || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname))
      throw new Error('local endpoint required');
    const response = await client.send(
      new CreateTableCommand({
        TableName: tableName,
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
    tableArn = response.TableDescription?.TableArn ?? '';
    if (!tableArn) throw new Error('local table ARN missing');
    // DynamoDB Local reports ddblocal in ARN. Replace only this metadata response;
    // every item, condition and transaction still runs against the real local engine.
    if (tableArn.includes(':ddblocal:')) {
      tableArn = tableArn.replace(':ddblocal:', ':ap-northeast-1:');
      const send = client.send.bind(client);
      vi.spyOn(client, 'send').mockImplementation((async (command: unknown) => {
        const result = await send(command as never);
        if (command instanceof DescribeTableCommand && 'Table' in result && result.Table)
          result.Table.TableArn = tableArn;
        return result;
      }) as never);
    }
  });
  afterAll(async () => {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
    client.destroy();
  });
  const input = () => {
    const namespace = randomUUID();
    const target: DynamoAuthStateConfig = {
      backend: 'dynamodb',
      region: 'ap-northeast-1',
      tableArn,
      namespace,
    };
    return { client, target, manifest, expected, supplement: supplement(), restoreId: namespace };
  };
  it('restores durable source state, seals its receipt and selects it as the live auth authority', async () => {
    const plan = input();
    const receipt = await restoreVerifiedDynamoAuthState(plan);
    expect(receipt).toEqual(createDynamoAuthStateRestoreReceipt(plan));
    await assertVerifiedDynamoAuthStateRestored({ ...plan, receipt });
    const stores = createAwsStateStores({
      backend: 'dynamodb',
      client,
      tableName,
      namespace: plan.target.namespace,
    });
    expect(
      (await stores.accountAuthentication.getAccountStateRpc(TENANT, 'user-1', 'account:user-1'))
        .lifecycle
    ).toBe('active');
    expect(
      (await stores.accountAuthentication.getAccountStateRpc(TENANT, 'absent', 'account:absent'))
        .lifecycle
    ).toBeNull();
    expect(
      await stores.accountAuthentication.advancePasskeyCounterRpc(
        TENANT,
        'user-1',
        'account:user-1',
        'passkey-1',
        5,
        6,
        Date.now()
      )
    ).toEqual({ counter: 6, advanced: true });
    expect(
      await readDynamoAuthStateCounters({ ...plan, receipt, passkeys: expected.passkeys })
    ).toEqual([{ user_id: 'user-1', credential_id: 'passkey-1', counter: '6' }]);
    await assertDynamoAuthStateLiveCompatible({ ...plan, receipt });
    await expect(assertVerifiedDynamoAuthStateRestored({ ...plan, receipt })).rejects.toThrow(
      'aws_dynamo_auth_state_invalid'
    );
    await expect(restoreVerifiedDynamoAuthState(plan)).rejects.toThrow(
      'aws_dynamo_auth_state_invalid'
    );
    await assertDynamoAuthStateSealed({ ...plan, receipt });
  });
  it('observes only synthetic sessions and matching one-use browser SP challenges from DynamoDB', async () => {
    const plan = input();
    plan.expected = JSON.parse(
      JSON.stringify(plan.expected).replaceAll('user-1', 'user-tenant-a')
    ) as AwsStateSourceExpectations;
    plan.supplement = repin(
      JSON.parse(
        JSON.stringify(plan.supplement).replaceAll('user-1', 'user-tenant-a')
      ) as VerifiedAwsStateSupplement
    );
    const receipt = await restoreVerifiedDynamoAuthState(plan);
    const stores = createAwsStateStores({
      backend: 'dynamodb',
      client,
      tableName,
      namespace: plan.target.namespace,
    });
    await stores.state.createSession({
      tenantId: TENANT,
      userId: 'user-tenant-a',
      sessionId: 'session',
      ttlMs: 60000,
    });
    const challenge = {
      tenantId: TENANT,
      userId: 'user-tenant-a',
      id: 'browser-sp:_browser_request',
      type: 'synthetic-browser-sp',
      challenge: 'secret',
      ttlMs: 60000,
    };
    await stores.state.storeChallenge(challenge);
    await stores.state.consumeChallenge(challenge);
    await stores.state.storeChallenge({ ...challenge, id: 'unrelated-synthetic-type' });
    const createClient = () => {
      const local = createDynamoStateClient({
        region: 'ap-northeast-1',
        endpoint,
        credentials: { accessKeyId: 'localtest', secretAccessKey: 'localtest' },
      });
      const send = local.send.bind(local);
      vi.spyOn(local, 'send').mockImplementation((async (command: unknown) => {
        const result = await send(command as never);
        if (command instanceof DescribeTableCommand && 'Table' in result && result.Table)
          result.Table.TableArn = tableArn;
        return result;
      }) as never);
      return local;
    };
    expect(
      await readSyntheticDynamoAuthStateSnapshot(
        { target: plan.target, receipt, passkeyRowId: 'passkey-1' },
        { createClient }
      )
    ).toEqual({ counter: 5, sessions: 1, outstanding: 0, consumed: 1 });
  });
  it('rejects a missing, partial, mismatched or forged generation receipt', async () => {
    const plan = input();
    const receipt = createDynamoAuthStateRestoreReceipt(plan);
    await expect(assertDynamoAuthStateSealed({ ...plan, receipt })).rejects.toThrow();
    const restored = await restoreVerifiedDynamoAuthState(plan);
    await expect(
      assertDynamoAuthStateSealed({
        ...plan,
        receipt: { ...restored, supplementSha256: '0'.repeat(64) },
      })
    ).rejects.toThrow();
    await expect(
      assertDynamoAuthStateSealed({
        ...plan,
        target: { ...plan.target, namespace: randomUUID() },
        receipt: restored,
      })
    ).rejects.toThrow();
    const t = new DynamoStateTable({ client, tableName, namespace: plan.target.namespace });
    await client.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: t.key(TENANT, 'RESTORE', 'seal'),
        UpdateExpression: 'SET #status = :partial',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':partial': { S: 'staging' } },
      })
    );
    await expect(assertDynamoAuthStateSealed({ ...plan, receipt: restored })).rejects.toThrow();
  });
  it('rejects an already populated namespace without touching another generation', async () => {
    const previous = input();
    const receipt = await restoreVerifiedDynamoAuthState(previous);
    const plan = input();
    const t = new DynamoStateTable({ client, tableName, namespace: plan.target.namespace });
    await client.send(
      new PutItemCommand({
        TableName: tableName,
        Item: { ...t.accountKey(TENANT, 'unexpected'), lifecycle: { S: 'active' } },
      })
    );
    await expect(restoreVerifiedDynamoAuthState(plan)).rejects.toThrow();
    await expect(
      assertDynamoAuthStateSealed({ ...plan, receipt: createDynamoAuthStateRestoreReceipt(plan) })
    ).rejects.toThrow();
    await assertVerifiedDynamoAuthStateRestored({ ...previous, receipt });
  });
  it('rejects corrupted live lifecycle and unknown durable accounts', async () => {
    const plan = input();
    const receipt = await restoreVerifiedDynamoAuthState(plan);
    const stores = createAwsStateStores({
      backend: 'dynamodb',
      client,
      tableName,
      namespace: plan.target.namespace,
    });
    await stores.accountAuthentication.initializeAccountStateRpc(
      TENANT,
      'unknown',
      'account:unknown',
      'active',
      Date.now()
    );
    await expect(assertDynamoAuthStateLiveCompatible({ ...plan, receipt })).rejects.toThrow();
  });
  it.each(['partial-failure', 'concurrent-mutation'] as const)(
    'does not seal a generation after %s',
    async (fault) => {
      const plan = input();
      const isolated = createDynamoStateClient({
        region: 'ap-northeast-1',
        endpoint,
        credentials: { accessKeyId: 'localtest', secretAccessKey: 'localtest' },
      });
      const original = isolated.send.bind(isolated);
      const t = new DynamoStateTable({
        client: isolated,
        tableName,
        namespace: plan.target.namespace,
      });
      let injected = false;
      vi.spyOn(isolated, 'send').mockImplementation((async (command: unknown) => {
        const result = await original(command as never);
        if (command instanceof DescribeTableCommand && 'Table' in result && result.Table)
          result.Table.TableArn = tableArn;
        if (command instanceof TransactWriteItemsCommand && !injected) {
          injected = true;
          if (fault === 'partial-failure') throw new Error('synthetic-staged-fault');
          await original(
            new UpdateItemCommand({
              TableName: tableName,
              Key: t.accountKey(TENANT, 'user-1'),
              UpdateExpression: 'SET lifecycle = :value',
              ExpressionAttributeValues: { ':value': { S: 'suspended' } },
            })
          );
        }
        return result;
      }) as never);
      try {
        await expect(restoreVerifiedDynamoAuthState({ ...plan, client: isolated })).rejects.toThrow(
          'aws_dynamo_auth_state_invalid'
        );
        expect(injected).toBe(true);
        await expect(
          assertDynamoAuthStateSealed({
            ...plan,
            receipt: createDynamoAuthStateRestoreReceipt(plan),
          })
        ).rejects.toThrow();
        expect((await t.get(t.key(TENANT, 'RESTORE', 'seal')))?.status?.S).toBe('failed');
      } finally {
        isolated.destroy();
      }
    }
  );
  it('rejects source omissions and target/restore mismatch before claiming a generation', async () => {
    const plan = input();
    const incomplete = supplement();
    incomplete.accountAuthStates = [];
    repin(incomplete);
    await expect(
      restoreVerifiedDynamoAuthState({ ...plan, supplement: incomplete })
    ).rejects.toThrow();
    await expect(
      restoreVerifiedDynamoAuthState({ ...plan, restoreId: randomUUID() })
    ).rejects.toThrow();
    const receipt = await restoreVerifiedDynamoAuthState(plan);
    await assertDynamoAuthStateSealed({ ...plan, receipt });
  });
});
