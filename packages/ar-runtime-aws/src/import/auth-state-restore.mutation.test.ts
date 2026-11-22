/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- fakes and deliberately malformed inputs are intentionally untyped */
import { describe, expect, it } from 'vitest';
import {
  DescribeTableCommand,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import { createDynamoStateClient, DynamoStateTable } from '../storage/dynamodb-state';
import type { DynamoAuthStateConfig } from '../storage/auth-state-config';
import { canonicalRestoreJson, restoreEvidenceDigest } from './restore-evidence';
import {
  awsStateSupplementPayloadSha256,
  type AwsStateSourceExpectations,
  type VerifiedAwsStateSupplement,
} from './state-restore';
import {
  assertDynamoAuthStateLiveCompatible,
  assertDynamoAuthStateSealed,
  assertDynamoAuthStateTable,
  assertVerifiedDynamoAuthStateRestored,
  createDynamoAuthStateRestoreReceipt,
  readDynamoAuthStateCounters,
  restoreVerifiedDynamoAuthState,
  type DynamoAuthStateReadbackInput,
} from './auth-state-restore';

const INVALID = 'aws_dynamo_auth_state_invalid';
const TENANT = 'tenant-a';
const NOW = 1_700_000_000_000;
const SP = 'https://sp.example.test';
const NS = '11111111-1111-4111-8111-111111111111';
const ARN = 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/auth-state';
const target: DynamoAuthStateConfig = {
  backend: 'dynamodb',
  region: 'ap-northeast-1',
  tableArn: ARN,
  namespace: NS,
};
type Item = Record<string, AttributeValue>;

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
  datasets: [],
};
const pad = (i: number) => String(i).padStart(3, '0');
const nameIdKey = (i: number) =>
  `saml:persistent-nameid:tenant:${TENANT}:sp:${encodeURIComponent(SP)}:subject:user-${pad(i)}`;

function fixture(n = 2) {
  const ids = Array.from({ length: n }, (_v, i) => i + 1);
  const supplement: VerifiedAwsStateSupplement = {
    receipt: {
      tenantId: TENANT,
      issuer: manifest.source.issuer,
      productVersion: manifest.source.productVersion,
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
      supplementSha256: '',
    },
    accountAuthStates: ids.map((i) => ({
      tenantId: TENANT,
      userId: `user-${pad(i)}`,
      accountId: `account:user-${pad(i)}`,
      lifecycle: 'active' as const,
      lifecycleVersionMs: NOW - 2000 - i,
      lifecycleOperationId: i === 1 ? 'op-1' : null,
      revokedAfterMs: i === 1 ? NOW - 500 : null,
      lastLoginAtMs: i === 1 ? NOW - 1000 : null,
    })),
    passkeyCounters: ids.map((i) => ({
      tenantId: TENANT,
      passkeyId: `passkey-${pad(i)}`,
      userId: `user-${pad(i)}`,
      credentialId: `cred-${pad(i)}`,
      counter: String(5 + i),
      updatedAtMs: NOW - 1000 - i,
    })),
    persistentNameIdsComplete: true,
    persistentNameIds: ids.map((i) => ({
      tenantId: TENANT,
      registryKey: nameIdKey(i),
      valueJson: JSON.stringify({
        version: 1,
        tenantId: TENANT,
        spEntityId: SP,
        subjectId: `user-${pad(i)}`,
        nameId: `pairwise-${i}`,
        createdAt: NOW - 3000 - i,
      }),
      createdAtMs: NOW - 3000 - i,
    })),
  };
  supplement.receipt.supplementSha256 = awsStateSupplementPayloadSha256(supplement);
  const expected: AwsStateSourceExpectations = {
    users: ids.map((i) => ({ userId: `user-${pad(i)}` })),
    accounts: ids.map((i) => ({
      accountId: `account:user-${pad(i)}`,
      userId: `user-${pad(i)}`,
      lifecycle: 'active' as const,
    })),
    passkeys: ids.map((i) => ({
      passkeyId: `passkey-${pad(i)}`,
      userId: `user-${pad(i)}`,
      credentialId: `cred-${pad(i)}`,
      sourceCounter: String(5 + i),
    })),
  };
  return { supplement, expected };
}

const idOf = (item: Item) => JSON.stringify([item.pk?.S, item.sk?.S]);
const conditionalFailure = () =>
  Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

class FakeDynamo {
  items = new Map<string, Item>();
  log: Array<{ name: string; input: any }> = [];
  table: any = {
    TableArn: ARN,
    TableStatus: 'ACTIVE',
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
  };
  pageSize = Number.POSITIVE_INFINITY;
  /** Returns a response (or throws) to override the default behaviour of a command. */
  override: ((name: string, input: any, count: number) => unknown) | null = null;
  counts = new Map<string, number>();
  readonly client = createDynamoStateClient({
    region: 'ap-northeast-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  constructor() {
    (this.client as { send: unknown }).send = (command: {
      constructor: { name: string };
      input: any;
    }) => this.handle(command);
  }
  put(item: Item) {
    this.items.set(idOf(item), structuredClone(item));
  }
  names = () => this.log.map((entry) => entry.name);
  of = (name: string) => this.log.filter((entry) => entry.name === name);
  private async handle(command: any): Promise<any> {
    const name = command.constructor.name as string;
    const input = command.input;
    this.log.push({ name, input: structuredClone(input) });
    const count = (this.counts.get(name) ?? 0) + 1;
    this.counts.set(name, count);
    if (this.override) {
      const replaced = this.override(name, input, count);
      if (replaced !== undefined) return replaced;
    }
    if (command instanceof DescribeTableCommand) return { Table: this.table };
    if (command instanceof GetItemCommand) {
      const item = this.items.get(idOf(input.Key));
      return item ? { Item: structuredClone(item) } : {};
    }
    if (command instanceof PutItemCommand) {
      if (this.items.has(idOf(input.Item))) throw conditionalFailure();
      this.put(input.Item);
      return {};
    }
    if (command instanceof ScanCommand) {
      const prefix = input.ExpressionAttributeValues[':prefix'].S as string;
      const keys = [...this.items.keys()].sort();
      const start = input.ExclusiveStartKey ? keys.indexOf(idOf(input.ExclusiveStartKey)) + 1 : 0;
      const slice = keys.slice(start, start + Math.min(this.pageSize, input.Limit ?? 1e9));
      const more = start + slice.length < keys.length;
      return {
        Items: slice
          .map((k) => structuredClone(this.items.get(k)!))
          .filter((i) => i.pk.S!.startsWith(prefix)),
        ...(more
          ? {
              LastEvaluatedKey: JSON.parse(slice[slice.length - 1]).reduce(
                (acc: Item, v: string, i: number) => ({
                  ...acc,
                  [i === 0 ? 'pk' : 'sk']: { S: v },
                }),
                {}
              ),
            }
          : {}),
      };
    }
    if (command instanceof TransactWriteItemsCommand) {
      const staged = new Map(this.items);
      for (const entry of input.TransactItems) {
        if (entry.ConditionCheck) {
          const marker = this.items.get(idOf(entry.ConditionCheck.Key));
          const values = entry.ConditionCheck.ExpressionAttributeValues;
          if (marker?.status?.S !== values[':staging'].S || marker?.owner?.S !== values[':owner'].S)
            throw Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' });
        } else if (entry.Put) {
          if (staged.has(idOf(entry.Put.Item)))
            throw Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' });
          staged.set(idOf(entry.Put.Item), structuredClone(entry.Put.Item));
        }
      }
      this.items = staged;
      return {};
    }
    if (command instanceof UpdateItemCommand) {
      const marker = this.items.get(idOf(input.Key));
      const values = input.ExpressionAttributeValues;
      if (
        !marker ||
        marker.status?.S !== values[':staging'].S ||
        marker.owner?.S !== values[':owner'].S
      )
        throw conditionalFailure();
      marker.status = values[':sealed'] ?? values[':failed'];
      return {};
    }
    throw new Error(`unhandled ${name}`);
  }
}

function setup(n = 2) {
  const { supplement, expected } = fixture(n);
  const fake = new FakeDynamo();
  const t = new DynamoStateTable({ client: fake.client, tableName: 'auth-state', namespace: NS });
  const source = { manifest, supplement, expected, target };
  const restore = () =>
    restoreVerifiedDynamoAuthState({ ...source, client: fake.client, restoreId: NS });
  return { fake, t, source, supplement, expected, restore };
}
async function restored(n = 2) {
  const s = setup(n);
  const receipt = await s.restore();
  const readback = (): DynamoAuthStateReadbackInput => ({
    ...s.source,
    client: s.fake.client,
    receipt,
  });
  return { ...s, receipt, readback };
}
const marker = (t: DynamoStateTable) => t.key(TENANT, 'RESTORE', 'seal');
const prefixOf = `${NS}#T#`;

describe('createDynamoAuthStateRestoreReceipt', () => {
  it('builds an exact receipt without aliasing the manifest', () => {
    const { source, supplement } = setup(3);
    const receipt = createDynamoAuthStateRestoreReceipt(source);
    expect(receipt).toEqual({
      formatVersion: 1,
      authState: target,
      tenantId: TENANT,
      source: manifest.source,
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
      supplementSha256: supplement.receipt.supplementSha256,
      accountAuthStates: 3,
      passkeyCounters: 3,
      persistentNameIds: 3,
    });
    expect(receipt.source).not.toBe(manifest.source);
  });
  it('rejects a PostgreSQL target and an invalid source', () => {
    const { source } = setup();
    expect(() =>
      createDynamoAuthStateRestoreReceipt({ ...source, target: { backend: 'postgresql' } as never })
    ).toThrow(new Error(INVALID));
    const bad = fixture();
    bad.supplement.receipt.supplementSha256 = 'c'.repeat(64);
    expect(() =>
      createDynamoAuthStateRestoreReceipt({ ...source, supplement: bad.supplement })
    ).toThrow();
  });
});

describe('assertDynamoAuthStateTable', () => {
  const run = (fake: FakeDynamo, t: unknown = target) =>
    assertDynamoAuthStateTable(fake.client, t as never);
  it('accepts the expected schema regardless of listing order and requests the table by name', async () => {
    const fake = new FakeDynamo();
    fake.table.KeySchema.reverse();
    fake.table.AttributeDefinitions.reverse();
    await expect(run(fake)).resolves.toBeUndefined();
    expect(fake.log[0]).toEqual({
      name: 'DescribeTableCommand',
      input: { TableName: 'auth-state' },
    });
  });
  it.each<[string, (table: any) => void]>([
    ['wrong ARN', (t) => (t.TableArn = ARN.replace('123456789012', '000000000000'))],
    ['not active', (t) => (t.TableStatus = 'CREATING')],
    ['missing status', (t) => delete t.TableStatus],
    ['no range key', (t) => t.KeySchema.pop()],
    ['extra key', (t) => t.KeySchema.push({ AttributeName: 'x', KeyType: 'RANGE' })],
    ['wrong key type', (t) => (t.KeySchema[1].KeyType = 'HASH')],
    ['no key schema', (t) => delete t.KeySchema],
    ['wrong attribute type', (t) => (t.AttributeDefinitions[0].AttributeType = 'N')],
    [
      'extra attribute',
      (t) => t.AttributeDefinitions.push({ AttributeName: 'gsi', AttributeType: 'S' }),
    ],
    ['no attributes', (t) => delete t.AttributeDefinitions],
  ])('rejects %s', async (_n, mutate) => {
    const fake = new FakeDynamo();
    mutate(fake.table);
    await expect(run(fake)).rejects.toThrow(new Error(INVALID));
  });
  it('rejects a missing table, SDK errors and PostgreSQL configuration', async () => {
    const fake = new FakeDynamo();
    fake.table = undefined;
    await expect(run(fake)).rejects.toThrow(INVALID);
    const failing = new FakeDynamo();
    failing.override = () => {
      throw new Error('boom');
    };
    await expect(run(failing)).rejects.toThrow(INVALID);
    await expect(run(new FakeDynamo(), { backend: 'postgresql' })).rejects.toThrow(INVALID);
  });
});

describe('restoreVerifiedDynamoAuthState', () => {
  it('claims, writes, verifies and seals one generation', async () => {
    const { fake, t, receipt, supplement, source } = await restored(2);
    expect(receipt).toEqual(createDynamoAuthStateRestoreReceipt(source));
    expect(fake.names().slice(0, 3)).toEqual([
      'DescribeTableCommand',
      'PutItemCommand',
      'ScanCommand',
    ]);
    expect(fake.names()[fake.names().length - 1]).toBe('GetItemCommand');
    const claim = fake.of('PutItemCommand')[0].input;
    expect(claim.TableName).toBe('auth-state');
    expect(claim.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(claim.Item).toMatchObject({
      ...marker(t),
      status: { S: 'staging' },
      receiptJson: { S: canonicalRestoreJson(receipt) },
      receiptSha256: { S: restoreEvidenceDigest(receipt) },
    });
    const owner = claim.Item.owner.S as string;
    expect(owner).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
    const scan = fake.of('ScanCommand')[0].input;
    expect(scan).toMatchObject({
      TableName: 'auth-state',
      ConsistentRead: true,
      Limit: 200,
      FilterExpression: 'begins_with(pk, :prefix)',
    });
    expect(scan.ExpressionAttributeValues[':prefix'].S).toMatch(
      new RegExp(`^${NS}#T#[0-9a-f]{64}#$`, 'u')
    );
    expect(scan.ExclusiveStartKey).toBeUndefined();
    const tx = fake.of('TransactWriteItemsCommand');
    expect(tx).toHaveLength(1);
    expect(tx[0].input.TransactItems[0]).toEqual({
      ConditionCheck: {
        TableName: 'auth-state',
        Key: marker(t),
        ConditionExpression: '#status = :staging AND #owner = :owner',
        ExpressionAttributeNames: { '#status': 'status', '#owner': 'owner' },
        ExpressionAttributeValues: { ':staging': { S: 'staging' }, ':owner': { S: owner } },
      },
    });
    const puts = tx[0].input.TransactItems.slice(1);
    expect(puts).toHaveLength(6);
    for (const entry of puts) {
      expect(entry.Put.TableName).toBe('auth-state');
      expect(entry.Put.ConditionExpression).toBe('attribute_not_exists(pk)');
    }
    const update = fake.of('UpdateItemCommand')[0].input;
    expect(update).toEqual({
      TableName: 'auth-state',
      Key: marker(t),
      UpdateExpression: 'SET #status = :sealed',
      ConditionExpression: '#status = :staging AND #owner = :owner',
      ExpressionAttributeNames: { '#status': 'status', '#owner': 'owner' },
      ExpressionAttributeValues: {
        ':sealed': { S: 'sealed' },
        ':staging': { S: 'staging' },
        ':owner': { S: owner },
      },
    });
    const stored = fake.items.get(idOf(marker(t)))!;
    expect(stored.status).toEqual({ S: 'sealed' });
    expect(stored.owner).toEqual({ S: owner });

    const account = fake.items.get(idOf(t.accountKey(TENANT, 'user-001')))!;
    expect(Object.keys(account).sort()).toEqual([
      'lastLoginAtMs',
      'lifecycle',
      'lifecycleOperationId',
      'lifecycleVersionMs',
      'pk',
      'revision',
      'revokedAfterMs',
      'sk',
    ]);
    expect(account).toMatchObject({
      lifecycle: { S: 'active' },
      lifecycleVersionMs: { N: String(NOW - 2001) },
      lifecycleOperationId: { S: 'op-1' },
      revokedAfterMs: { N: String(NOW - 500) },
      lastLoginAtMs: { N: String(NOW - 1000) },
    });
    const bare = fake.items.get(idOf(t.accountKey(TENANT, 'user-002')))!;
    expect(Object.keys(bare).sort()).toEqual([
      'lifecycle',
      'lifecycleVersionMs',
      'pk',
      'revision',
      'sk',
    ]);
    expect(bare.revision.S).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
    expect(account.revision.S).not.toBe(bare.revision.S);
    const counter = [...fake.items.values()].filter((i) => i.sk?.S?.startsWith('COUNTER#'));
    expect(counter).toHaveLength(2);
    expect(Object.keys(counter[0]).sort()).toEqual(['counter', 'pk', 'sk', 'updatedAtMs']);
    expect(counter.map((c) => c.counter?.N).sort()).toEqual(['6', '7']);
    const nameIds = supplement.persistentNameIds.map(
      (r) => fake.items.get(idOf(t.key(TENANT, 'NAMEID', r.registryKey)))!
    );
    expect(nameIds.map((i) => i.valueJson?.S)).toEqual(
      supplement.persistentNameIds.map((r) => r.valueJson)
    );
    expect(Object.keys(nameIds[0]).sort()).toEqual(['pk', 'semanticHash', 'sk', 'valueJson']);
    expect(nameIds[0].semanticHash?.S).toMatch(/^[0-9a-f]{64}$/u);
    expect(fake.items.size).toBe(1 + 2 + 2 + 2);
  });

  it('writes records in transactions of 25 items', async () => {
    const { fake } = await restored(30);
    const tx = fake.of('TransactWriteItemsCommand');
    expect(tx.map((e) => e.input.TransactItems.length)).toEqual([26, 26, 26, 16]);
    expect(tx.every((e) => e.input.TransactItems[0].ConditionCheck)).toBe(true);
    expect(fake.items.size).toBe(1 + 90);
  });

  it('refuses an already claimed generation without modifying it', async () => {
    const s = setup();
    s.fake.put({ ...marker(s.t), status: { S: 'sealed' }, owner: { S: 'someone-else' } });
    await expect(s.restore()).rejects.toThrow(new Error(INVALID));
    expect(s.fake.names()).not.toContain('UpdateItemCommand');
    expect(s.fake.names()).not.toContain('TransactWriteItemsCommand');
    expect(s.fake.items.get(idOf(marker(s.t)))!.status).toEqual({ S: 'sealed' });
  });
  it('fails and marks the generation failed when other rows exist', async () => {
    const s = setup();
    const stray = s.t.key(TENANT, 'SESSION', 'stray');
    s.fake.put(stray);
    await expect(s.restore()).rejects.toThrow(INVALID);
    const failed = s.fake.of('UpdateItemCommand')[0].input;
    expect(failed.UpdateExpression).toBe('SET #status = :failed');
    expect(failed.ConditionExpression).toBe('#status = :staging AND #owner = :owner');
    expect(failed.ExpressionAttributeNames).toEqual({ '#status': 'status', '#owner': 'owner' });
    expect(Object.keys(failed.ExpressionAttributeValues).sort()).toEqual([
      ':failed',
      ':owner',
      ':staging',
    ]);
    expect(failed.ExpressionAttributeValues[':failed']).toEqual({ S: 'failed' });
    expect(failed.ExpressionAttributeValues[':staging']).toEqual({ S: 'staging' });
    expect(failed.Key).toEqual(marker(s.t));
    expect(failed.TableName).toBe('auth-state');
    expect(s.fake.items.get(idOf(marker(s.t)))!.status).toEqual({ S: 'failed' });
    expect(s.fake.names()).not.toContain('TransactWriteItemsCommand');
  });
  it('ignores rows of other tenants and namespaces when claiming', async () => {
    const s = setup();
    s.fake.put({ pk: { S: 'other-namespace#T#abc#SESSION#x' }, sk: { S: 'STATE' } });
    await expect(s.restore()).resolves.toBeDefined();
  });
  it('fails closed when a write transaction fails', async () => {
    const s = setup();
    s.fake.override = (name) => {
      if (name === 'TransactWriteItemsCommand') throw new Error('tx failed');
      return undefined;
    };
    await expect(s.restore()).rejects.toThrow(INVALID);
    expect(s.fake.items.get(idOf(marker(s.t)))!.status).toEqual({ S: 'failed' });
  });
  it('tolerates a failing failure-marker update', async () => {
    const s = setup();
    s.fake.override = (name) => {
      if (name === 'TransactWriteItemsCommand' || name === 'UpdateItemCommand')
        throw new Error('x');
      return undefined;
    };
    await expect(s.restore()).rejects.toThrow(new Error(INVALID));
  });
  it('does not claim anything when the table, target or source is wrong', async () => {
    const wrongTable = setup();
    wrongTable.fake.table.TableStatus = 'UPDATING';
    await expect(wrongTable.restore()).rejects.toThrow(INVALID);
    expect(wrongTable.fake.names()).toEqual(['DescribeTableCommand']);

    const s = setup();
    await expect(
      restoreVerifiedDynamoAuthState({
        ...s.source,
        client: s.fake.client,
        restoreId: '22222222-2222-4222-8222-222222222222',
      })
    ).rejects.toThrow(INVALID);
    await expect(
      restoreVerifiedDynamoAuthState({
        ...s.source,
        target: { backend: 'postgresql' } as never,
        client: s.fake.client,
        restoreId: NS,
      })
    ).rejects.toThrow(INVALID);
    const bad = fixture();
    bad.supplement.persistentNameIdsComplete = false as never;
    await expect(
      restoreVerifiedDynamoAuthState({
        ...s.source,
        supplement: bad.supplement,
        client: s.fake.client,
        restoreId: NS,
      })
    ).rejects.toThrow(INVALID);
    expect(s.fake.log).toEqual([]);
  });
  it('fails when verification of the written rows fails', async () => {
    const s = setup();
    s.fake.override = (name, _input, count) => {
      if (name === 'ScanCommand' && count === 2) return { Items: [] };
      return undefined;
    };
    await expect(s.restore()).rejects.toThrow(INVALID);
    expect(s.fake.items.get(idOf(marker(s.t)))!.status).toEqual({ S: 'failed' });
  });
  it('does not mutate the caller inputs', async () => {
    const s = setup();
    const before = JSON.stringify(s.source);
    await s.restore();
    expect(JSON.stringify(s.source)).toBe(before);
  });
});

describe('assertDynamoAuthStateSealed', () => {
  const sealed = async (mutate: (r: any, item: Item) => void) => {
    const s = await restored(2);
    const receipt = structuredClone(s.receipt) as any;
    const item = s.fake.items.get(idOf(marker(s.t)))!;
    mutate(receipt, item);
    return assertDynamoAuthStateSealed({ client: s.fake.client, target, receipt });
  };
  it('accepts the sealed generation', async () => {
    const s = await restored(2);
    s.fake.log.length = 0;
    await expect(
      assertDynamoAuthStateSealed({ client: s.fake.client, target, receipt: s.receipt })
    ).resolves.toBeUndefined();
    expect(s.fake.log).toEqual([
      {
        name: 'GetItemCommand',
        input: { TableName: 'auth-state', Key: marker(s.t), ConsistentRead: true },
      },
    ]);
  });
  it.each<[string, (r: any, item: Item) => void]>([
    ['format version', (r) => (r.formatVersion = 2)],
    [
      'receipt target',
      (r) => (r.authState = { ...r.authState, namespace: '22222222-2222-4222-8222-222222222222' }),
    ],
    ['marker status', (_r, item) => (item.status = { S: 'staging' })],
    ['marker status missing', (_r, item) => delete item.status],
    ['receipt json', (_r, item) => (item.receiptJson = { S: '{}' })],
    ['receipt json missing', (_r, item) => delete item.receiptJson],
    ['receipt digest', (_r, item) => (item.receiptSha256 = { S: 'c'.repeat(64) })],
    ['receipt digest missing', (_r, item) => delete item.receiptSha256],
    ['receipt content', (r) => (r.accountAuthStates += 1)],
  ])('rejects a different %s', async (_n, mutate) => {
    await expect(sealed(mutate)).rejects.toThrow(new Error(INVALID));
  });
  it('rejects a missing marker and a PostgreSQL target', async () => {
    const s = await restored(2);
    s.fake.items.delete(idOf(marker(s.t)));
    await expect(
      assertDynamoAuthStateSealed({ client: s.fake.client, target, receipt: s.receipt })
    ).rejects.toThrow(INVALID);
    await expect(
      assertDynamoAuthStateSealed({
        client: s.fake.client,
        target: { backend: 'postgresql' } as never,
        receipt: s.receipt,
      })
    ).rejects.toThrow(INVALID);
  });
});

describe('row verification', () => {
  const both = [
    ['staging', assertVerifiedDynamoAuthStateRestored],
    ['live', assertDynamoAuthStateLiveCompatible],
  ] as const;

  it('accepts a freshly restored generation in both modes', async () => {
    const s = await restored(2);
    for (const [, read] of both) await expect(read(s.readback())).resolves.toBeUndefined();
  });
  it('paginates the namespace scan', async () => {
    const s = await restored(3);
    s.fake.pageSize = 2;
    s.fake.log.length = 0;
    await expect(assertVerifiedDynamoAuthStateRestored(s.readback())).resolves.toBeUndefined();
    const scans = s.fake.of('ScanCommand');
    expect(scans.length).toBeGreaterThan(3);
    expect(scans[0].input.ExclusiveStartKey).toBeUndefined();
    expect(scans[1].input.ExclusiveStartKey).toBeDefined();
  });
  it('stops on an empty LastEvaluatedKey', async () => {
    const s = await restored(2);
    s.fake.override = (name) => {
      if (name !== 'ScanCommand') return undefined;
      return {
        Items: [...s.fake.items.values()].filter((i) => i.pk.S!.startsWith(prefixOf)),
        LastEvaluatedKey: {},
      };
    };
    s.fake.log.length = 0;
    await expect(assertVerifiedDynamoAuthStateRestored(s.readback())).resolves.toBeUndefined();
    expect(s.fake.of('ScanCommand')).toHaveLength(1);
  });
  it('rejects a scan that returns the same row twice', async () => {
    const s = await restored(2);
    s.fake.override = (name) => {
      if (name !== 'ScanCommand') return undefined;
      const items = [...s.fake.items.values()];
      return { Items: [...items, items[0]] };
    };
    await expect(assertVerifiedDynamoAuthStateRestored(s.readback())).rejects.toThrow(INVALID);
  });
  it.each<[string, (s: Awaited<ReturnType<typeof restored>>) => void]>([
    ['receipt tenant', (s) => ((s.receipt as any).tenantId = 'x')],
    ['receipt counts', (s) => ((s.receipt as any).accountAuthStates = 9)],
    [
      'receipt target',
      (s) =>
        ((s.receipt as any).authState = {
          ...target,
          namespace: '22222222-2222-4222-8222-222222222222',
        }),
    ],
  ])('rejects a mismatching %s before scanning', async (_n, mutate) => {
    const s = await restored(2);
    mutate(s);
    s.fake.log.length = 0;
    for (const [, read] of both) await expect(read(s.readback())).rejects.toThrow(INVALID);
    expect(s.fake.of('ScanCommand')).toHaveLength(0);
  });

  const accountKey = (s: Awaited<ReturnType<typeof restored>>, user = 'user-001') =>
    idOf(s.t.accountKey(TENANT, user));
  const counterKeyOf = (s: Awaited<ReturnType<typeof restored>>, i = 1) =>
    [...s.fake.items.entries()].filter(
      ([, v]) => v.sk?.S?.startsWith('COUNTER#') && v.counter?.N === String(5 + i)
    )[0][0];

  it.each<[string, (s: Awaited<ReturnType<typeof restored>>) => void]>([
    ['missing account', (s) => void s.fake.items.delete(accountKey(s))],
    ['account without revision', (s) => void delete s.fake.items.get(accountKey(s))!.revision],
    [
      'account revision not a uuid',
      (s) => void (s.fake.items.get(accountKey(s))!.revision = { S: 'nope' }),
    ],
    [
      'account revision uppercase',
      (s) =>
        void (s.fake.items.get(accountKey(s))!.revision = {
          S: 'A'.repeat(8) + '-AAAA-AAAA-AAAA-' + 'A'.repeat(12),
        }),
    ],
    [
      'account lifecycle',
      (s) => void (s.fake.items.get(accountKey(s))!.lifecycle = { S: 'locked' }),
    ],
    [
      'account version',
      (s) => void (s.fake.items.get(accountKey(s))!.lifecycleVersionMs = { N: '1' }),
    ],
    [
      'account operation id removed',
      (s) => void delete s.fake.items.get(accountKey(s))!.lifecycleOperationId,
    ],
    ['account extra attribute', (s) => void (s.fake.items.get(accountKey(s))!.extra = { S: 'x' })],
    ['account revoked removed', (s) => void delete s.fake.items.get(accountKey(s))!.revokedAfterMs],
    [
      'account last login removed',
      (s) => void delete s.fake.items.get(accountKey(s))!.lastLoginAtMs,
    ],
    [
      'account unexpected revoke',
      (s) => void (s.fake.items.get(accountKey(s, 'user-002'))!.revokedAfterMs = { N: '5' }),
    ],
    [
      'account unexpected login',
      (s) => void (s.fake.items.get(accountKey(s, 'user-002'))!.lastLoginAtMs = { N: '5' }),
    ],
    [
      'account unexpected operation',
      (s) => void (s.fake.items.get(accountKey(s, 'user-002'))!.lifecycleOperationId = { S: 'x' }),
    ],
    ['missing counter', (s) => void s.fake.items.delete(counterKeyOf(s))],
    [
      'counter extra attribute',
      (s) => void (s.fake.items.get(counterKeyOf(s))!.extra = { S: 'x' }),
    ],
    ['counter missing updated', (s) => void delete s.fake.items.get(counterKeyOf(s))!.updatedAtMs],
    ['counter missing value', (s) => void delete s.fake.items.get(counterKeyOf(s))!.counter],
    ['counter negative', (s) => void (s.fake.items.get(counterKeyOf(s))!.counter = { N: '-1' })],
    ['counter fractional', (s) => void (s.fake.items.get(counterKeyOf(s))!.counter = { N: '6.5' })],
    [
      'counter updated zero',
      (s) => void (s.fake.items.get(counterKeyOf(s))!.updatedAtMs = { N: '0' }),
    ],
    [
      'counter updated fractional',
      (s) => void (s.fake.items.get(counterKeyOf(s))!.updatedAtMs = { N: '1.5' }),
    ],
    [
      'missing nameid',
      (s) => void s.fake.items.delete(idOf(s.t.key(TENANT, 'NAMEID', nameIdKey(1)))),
    ],
    [
      'nameid value',
      (s) =>
        void (s.fake.items.get(idOf(s.t.key(TENANT, 'NAMEID', nameIdKey(1))))!.valueJson = {
          S: '{}',
        }),
    ],
    [
      'nameid semantic hash',
      (s) =>
        void (s.fake.items.get(idOf(s.t.key(TENANT, 'NAMEID', nameIdKey(1))))!.semanticHash = {
          S: 'x',
        }),
    ],
    [
      'nameid semantic hash removed',
      (s) =>
        void delete s.fake.items.get(idOf(s.t.key(TENANT, 'NAMEID', nameIdKey(1))))!.semanticHash,
    ],
    [
      'nameid extra attribute',
      (s) =>
        void (s.fake.items.get(idOf(s.t.key(TENANT, 'NAMEID', nameIdKey(1))))!.extra = { S: 'x' }),
    ],
    [
      'nameid value removed',
      (s) => void delete s.fake.items.get(idOf(s.t.key(TENANT, 'NAMEID', nameIdKey(1))))!.valueJson,
    ],
  ])('rejects %s in both modes', async (_n, mutate) => {
    for (const [, read] of both) {
      const s = await restored(2);
      mutate(s);
      s.fake.log.length = 0;
      await expect(read(s.readback())).rejects.toThrow(new Error(INVALID));
    }
  });

  it('checks the staged counter exactly but lets the live counter advance', async () => {
    const s = await restored(2);
    const key = counterKeyOf(s);
    s.fake.items.get(key)!.counter = { N: '9' };
    s.fake.items.get(key)!.updatedAtMs = { N: String(NOW + 10) };
    await expect(assertVerifiedDynamoAuthStateRestored(s.readback())).rejects.toThrow(INVALID);
    await expect(assertDynamoAuthStateLiveCompatible(s.readback())).resolves.toBeUndefined();
    s.fake.items.get(key)!.counter = { N: '5' };
    await expect(assertDynamoAuthStateLiveCompatible(s.readback())).rejects.toThrow(INVALID);
    s.fake.items.get(key)!.counter = { N: '6' };
    s.fake.items.get(key)!.updatedAtMs = { N: String(NOW - 5000) };
    await expect(assertDynamoAuthStateLiveCompatible(s.readback())).rejects.toThrow(INVALID);
    s.fake.items.get(key)!.updatedAtMs = { N: String(NOW - 1001) };
    await expect(assertDynamoAuthStateLiveCompatible(s.readback())).resolves.toBeUndefined();
  });
  it('requires staged update time equality', async () => {
    const s = await restored(2);
    s.fake.items.get(counterKeyOf(s))!.updatedAtMs = { N: String(NOW) };
    await expect(assertVerifiedDynamoAuthStateRestored(s.readback())).rejects.toThrow(INVALID);
  });

  describe('extra rows', () => {
    const extra = (s: Awaited<ReturnType<typeof restored>>, kind: string, id = 'x') =>
      s.fake.put(s.t.key(TENANT, kind, id));
    it('rejects any extra row while staging', async () => {
      const s = await restored(2);
      extra(s, 'SESSION');
      await expect(assertVerifiedDynamoAuthStateRestored(s.readback())).rejects.toThrow(INVALID);
    });
    it.each(['SESSION', 'CHALLENGE', 'SAML', 'KV', 'RATE', 'CODE', 'CODE_USER'])(
      'allows live %s rows',
      async (kind) => {
        const s = await restored(2);
        extra(s, kind);
        await expect(assertDynamoAuthStateLiveCompatible(s.readback())).resolves.toBeUndefined();
      }
    );
    it('rejects live rows of an unknown kind and unknown accounts', async () => {
      const unknown = await restored(2);
      extra(unknown, 'OTHER');
      await expect(assertDynamoAuthStateLiveCompatible(unknown.readback())).rejects.toThrow(
        INVALID
      );
      const account = await restored(2);
      account.fake.put(account.t.accountKey(TENANT, 'stranger'));
      await expect(assertDynamoAuthStateLiveCompatible(account.readback())).rejects.toThrow(
        INVALID
      );
      const prefixOnly = await restored(2);
      prefixOnly.fake.put({
        ...prefixOnly.t.key(TENANT, 'SESSION', 'x'),
        pk: {
          S: `${prefixOnly.t.key(TENANT, 'SESSION', 'x').pk.S!.replace('SESSION', 'SESSIONX')}`,
        },
      });
      await expect(assertDynamoAuthStateLiveCompatible(prefixOnly.readback())).rejects.toThrow(
        INVALID
      );
    });
    const newNameId = (subject: string) => {
      const sp = 'https://sp2.example.test';
      const key = `saml:persistent-nameid:tenant:${TENANT}:sp:${encodeURIComponent(sp)}:subject:${subject}`;
      const decoded = {
        version: 1,
        tenantId: TENANT,
        spEntityId: sp,
        subjectId: subject,
        nameId: 'n',
        createdAt: NOW + 1,
      };
      const { createdAt: _createdAt, ...hashed } = decoded;
      return { key, decoded, hashed };
    };
    it('accepts a newly created NameID for a known subject live, and rejects unknown subjects or forged hashes', async () => {
      const { canonicalDynamoStateJson } = await import('../storage/dynamodb-state');
      const { hash } = await import('node:crypto');
      const add = (
        s: Awaited<ReturnType<typeof restored>>,
        subject: string,
        tamper: (item: Item) => void = () => undefined
      ) => {
        const { key, decoded, hashed } = newNameId(subject);
        const item: Item = {
          ...s.t.key(TENANT, 'NAMEID', key),
          valueJson: { S: JSON.stringify(decoded) },
          semanticHash: { S: hash('sha256', canonicalDynamoStateJson(hashed), 'hex') },
        };
        tamper(item);
        s.fake.put(item);
      };
      const ok = await restored(2);
      add(ok, 'user-001');
      await expect(assertDynamoAuthStateLiveCompatible(ok.readback())).resolves.toBeUndefined();
      await expect(assertVerifiedDynamoAuthStateRestored(ok.readback())).rejects.toThrow(INVALID);
      for (const tamper of [
        (i: Item) => (i.semanticHash = { S: 'f'.repeat(64) }),
        (i: Item) => (i.extra = { S: 'x' }),
        (i: Item) => delete i.semanticHash,
        (i: Item) => delete i.valueJson,
        (i: Item) => (i.valueJson = { S: '{' }),
      ]) {
        const bad = await restored(2);
        add(bad, 'user-001', tamper);
        await expect(assertDynamoAuthStateLiveCompatible(bad.readback())).rejects.toThrow(INVALID);
      }
      const unknown = await restored(2);
      add(unknown, 'stranger');
      await expect(assertDynamoAuthStateLiveCompatible(unknown.readback())).rejects.toThrow(
        INVALID
      );
      const misplaced = await restored(2);
      add(misplaced, 'user-001', (i) => (i.sk = { S: 'OTHER' }));
      await expect(assertDynamoAuthStateLiveCompatible(misplaced.readback())).rejects.toThrow(
        INVALID
      );
    });
  });

  it('checks the seal before and after a live scan and after a staging scan', async () => {
    const live = await restored(2);
    // Flip the seal as soon as the scan has happened.
    live.fake.override = (name, input) => {
      if (
        name === 'GetItemCommand' &&
        idOf(input.Key) === idOf(marker(live.t)) &&
        live.fake.of('ScanCommand').length > 0
      ) {
        return { Item: { ...live.fake.items.get(idOf(marker(live.t)))!, status: { S: 'failed' } } };
      }
      return undefined;
    };
    await expect(assertDynamoAuthStateLiveCompatible(live.readback())).rejects.toThrow(INVALID);
    const staging = await restored(2);
    staging.fake.override = (name, input) => {
      if (
        name === 'GetItemCommand' &&
        idOf(input.Key) === idOf(marker(staging.t)) &&
        staging.fake.of('ScanCommand').length > 0
      ) {
        return {
          Item: { ...staging.fake.items.get(idOf(marker(staging.t)))!, status: { S: 'failed' } },
        };
      }
      return undefined;
    };
    await expect(assertVerifiedDynamoAuthStateRestored(staging.readback())).rejects.toThrow(
      INVALID
    );
    const unsealedLive = await restored(2);
    unsealedLive.fake.items.get(idOf(marker(unsealedLive.t)))!.status = { S: 'staging' };
    unsealedLive.fake.log.length = 0;
    await expect(assertDynamoAuthStateLiveCompatible(unsealedLive.readback())).rejects.toThrow(
      INVALID
    );
    expect(unsealedLive.fake.of('ScanCommand')).toHaveLength(0);
  });
});

describe('readDynamoAuthStateCounters', () => {
  it('returns the live counters after verifying the seal', async () => {
    const s = await restored(2);
    const rows = await readDynamoAuthStateCounters({
      client: s.fake.client,
      target,
      receipt: s.receipt,
      passkeys: s.expected.passkeys,
    });
    expect(rows).toEqual([
      { user_id: 'user-001', credential_id: 'passkey-001', counter: '6' },
      { user_id: 'user-002', credential_id: 'passkey-002', counter: '7' },
    ]);
    const reads = s.fake.of('GetItemCommand').slice(-2);
    expect(reads[0].input.ConsistentRead).toBe(true);
    expect(reads[0].input.TableName).toBe('auth-state');
    expect(reads[0].input.Key).toEqual({
      ...s.t.accountKey(TENANT, 'user-001'),
      sk: { S: expect.stringMatching(/^COUNTER#[0-9a-f]{64}$/u) },
    });
  });
  const failing = async (
    mutate: (s: Awaited<ReturnType<typeof restored>>, key: string) => void
  ) => {
    const s = await restored(2);
    const key = [...s.fake.items.entries()].find(([, v]) => v.sk?.S?.startsWith('COUNTER#'))![0];
    mutate(s, key);
    return readDynamoAuthStateCounters({
      client: s.fake.client,
      target,
      receipt: s.receipt,
      passkeys: s.expected.passkeys,
    });
  };
  it('rejects missing, regressed and non-integer counters and accepts advanced ones', async () => {
    await expect(failing((s, k) => void s.fake.items.delete(k))).rejects.toThrow(
      new Error(INVALID)
    );
    await expect(failing((s, k) => void delete s.fake.items.get(k)!.counter)).rejects.toThrow(
      INVALID
    );
    await expect(
      failing((s, k) => void (s.fake.items.get(k)!.counter = { N: '1' }))
    ).rejects.toThrow(INVALID);
    await expect(
      failing((s, k) => void (s.fake.items.get(k)!.counter = { N: '6.5' }))
    ).rejects.toThrow(INVALID);
    await expect(
      failing((s, k) => void (s.fake.items.get(k)!.counter = { N: 'x' }))
    ).rejects.toThrow(INVALID);
    await expect(
      failing((s, k) => void (s.fake.items.get(k)!.counter = { N: '99' }))
    ).resolves.toHaveLength(2);
    await expect(
      failing((s, k) => void (s.fake.items.get(k)!.counter = { N: '6' }))
    ).resolves.toHaveLength(2);
  });
  it('rejects an unsealed generation', async () => {
    const s = await restored(2);
    s.fake.items.get(idOf(marker(s.t)))!.status = { S: 'failed' };
    await expect(
      readDynamoAuthStateCounters({
        client: s.fake.client,
        target,
        receipt: s.receipt,
        passkeys: s.expected.passkeys,
      })
    ).rejects.toThrow(INVALID);
  });
});
