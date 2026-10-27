/** Verified, generation-isolated DynamoDB auth restore. Audit/activation SQL remains independent. */
import { hash as nodeHash, randomUUID } from 'node:crypto';
import {
  DescribeTableCommand,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import {
  DynamoStateTable,
  DynamoPersistentNameIDRegistry,
  canonicalDynamoStateJson,
} from '../storage/dynamodb-state';
import {
  normalizeAwsAuthStateConfig,
  dynamoAuthStateTableName,
  type DynamoAuthStateConfig,
} from '../storage/auth-state-config';
import { validateSAMLPersistentNameIDRecord } from '../storage/persistent-nameid-record';
import { canonicalRestoreJson, restoreEvidenceDigest } from './restore-evidence';
import {
  assertVerifiedAwsStateSource,
  type AwsStateRestoreReceipt,
  type AwsStateSourceExpectations,
  type VerifiedAwsStateSupplement,
} from './state-restore';

type Item = Record<string, AttributeValue>;
type Client = Pick<DynamoDBClient, 'send'>;
const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });
const hash = (value: string): string => nodeHash('sha256', value, 'hex');
function invalid(): never {
  throw new Error('aws_dynamo_auth_state_invalid');
}
const keyId = (item: Item): string => JSON.stringify([item.pk?.S, item.sk?.S]);
const prefix = (target: Pick<DynamoAuthStateConfig, 'namespace'>, tenantId: string): string =>
  `${target.namespace}#T#${hash(tenantId)}#`;
const equal = (a: unknown, b: unknown): boolean =>
  canonicalRestoreJson(a) === canonicalRestoreJson(b);

export interface DynamoAuthStateRestoreReceipt extends AwsStateRestoreReceipt {
  formatVersion: 1;
  authState: DynamoAuthStateConfig;
}
export interface DynamoAuthStateSource {
  manifest: TenantBundleManifest;
  supplement: VerifiedAwsStateSupplement;
  expected: AwsStateSourceExpectations;
  target: DynamoAuthStateConfig;
}
export interface DynamoAuthStateReadbackInput extends DynamoAuthStateSource {
  client: Client;
  receipt: DynamoAuthStateRestoreReceipt;
}

export function createDynamoAuthStateRestoreReceipt(
  input: DynamoAuthStateSource
): DynamoAuthStateRestoreReceipt {
  assertVerifiedAwsStateSource(input);
  const target = normalizeAwsAuthStateConfig(input.target);
  if (target.backend !== 'dynamodb') return invalid();
  const { manifest: m, supplement: s } = input;
  return {
    formatVersion: 1,
    authState: target,
    tenantId: m.source.tenantId,
    source: { ...m.source },
    bundleId: m.bundleId,
    snapshotId: m.snapshotId,
    inventoryDigestSha256: m.inventoryDigestSha256,
    supplementSha256: s.receipt.supplementSha256,
    accountAuthStates: s.accountAuthStates.length,
    passkeyCounters: s.passkeyCounters.length,
    persistentNameIds: s.persistentNameIds.length,
  };
}
function table(client: Client, target: DynamoAuthStateConfig): DynamoStateTable {
  return new DynamoStateTable({
    client,
    tableName: dynamoAuthStateTableName(target),
    namespace: target.namespace,
  });
}
function markerKey(t: DynamoStateTable, tenantId: string): Item {
  return t.key(tenantId, 'RESTORE', 'seal');
}
function counterKey(
  t: DynamoStateTable,
  tenantId: string,
  userId: string,
  passkeyId: string
): Item {
  return { ...t.accountKey(tenantId, userId), sk: S(`COUNTER#${hash(passkeyId)}`) };
}
function accountItem(
  t: DynamoStateTable,
  row: VerifiedAwsStateSupplement['accountAuthStates'][number]
): Item {
  return {
    ...t.accountKey(row.tenantId, row.userId),
    lifecycle: S(row.lifecycle),
    lifecycleVersionMs: N(row.lifecycleVersionMs),
    revision: S(randomUUID()),
    ...(row.lifecycleOperationId === null
      ? {}
      : { lifecycleOperationId: S(row.lifecycleOperationId) }),
    ...(row.revokedAfterMs === null ? {} : { revokedAfterMs: N(row.revokedAfterMs) }),
    ...(row.lastLoginAtMs === null ? {} : { lastLoginAtMs: N(row.lastLoginAtMs) }),
  };
}

/** Cold-start/schema check. No table creation, TTL change, or other AWS mutation occurs here. */
export async function assertDynamoAuthStateTable(
  client: Client,
  target: DynamoAuthStateConfig
): Promise<void> {
  try {
    const normalized = normalizeAwsAuthStateConfig(target);
    if (normalized.backend !== 'dynamodb') invalid();
    const result = await client.send(
      new DescribeTableCommand({ TableName: dynamoAuthStateTableName(target) })
    );
    const actual = result.Table;
    if (
      !actual ||
      actual.TableArn !== target.tableArn ||
      actual.TableStatus !== 'ACTIVE' ||
      !equal(
        [...(actual.KeySchema ?? [])].sort((a, b) =>
          String(a.AttributeName).localeCompare(String(b.AttributeName))
        ),
        [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ]
      ) ||
      !equal(
        [...(actual.AttributeDefinitions ?? [])].sort((a, b) =>
          String(a.AttributeName).localeCompare(String(b.AttributeName))
        ),
        [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ]
      )
    )
      invalid();
  } catch {
    invalid();
  }
}

/** Cheap warm readiness: only the independently pinned sealed receipt authorizes use. */
export async function assertDynamoAuthStateSealed(input: {
  client: Client;
  target: DynamoAuthStateConfig;
  receipt: DynamoAuthStateRestoreReceipt;
}): Promise<void> {
  try {
    const target = normalizeAwsAuthStateConfig(input.target);
    if (
      target.backend !== 'dynamodb' ||
      input.receipt.formatVersion !== 1 ||
      !equal(target, input.receipt.authState)
    )
      invalid();
    const t = table(input.client, input.target);
    const item = await t.get(markerKey(t, input.receipt.tenantId));
    if (
      !item ||
      item.status?.S !== 'sealed' ||
      item.receiptJson?.S !== canonicalRestoreJson(input.receipt) ||
      item.receiptSha256?.S !== restoreEvidenceDigest(input.receipt)
    )
      invalid();
  } catch {
    invalid();
  }
}

/**
 * Maintenance/cold-load inventory only, never an authentication hot-path Scan.
 * Strong Scan is not snapshot isolation; staged generations must have no runtime writer.
 * Live validation permits only the same monotonic counter/new-NameID changes as PostgreSQL.
 */
async function namespaceItems(t: DynamoStateTable, tenantId: string): Promise<Item[]> {
  const result: Item[] = [];
  let cursor: Item | undefined;
  do {
    const page = await t.client.send(
      new ScanCommand({
        TableName: t.tableName,
        ConsistentRead: true,
        Limit: 200,
        FilterExpression: 'begins_with(pk, :prefix)',
        ExpressionAttributeValues: {
          ':prefix': S(prefix({ namespace: t.namespace }, tenantId)),
        },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      })
    );
    result.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor && Object.keys(cursor).length);
  return result;
}

async function assertRows(
  input: DynamoAuthStateReadbackInput,
  mode: 'staging' | 'live'
): Promise<void> {
  const expectedReceipt = createDynamoAuthStateRestoreReceipt(input);
  if (!equal(expectedReceipt, input.receipt)) invalid();
  const t = table(input.client, input.target);
  const tenantId = input.manifest.source.tenantId;
  const items = await namespaceItems(t, tenantId);
  const rows = new Map(items.map((item) => [keyId(item), item]));
  if (rows.size !== items.length) invalid();
  rows.delete(keyId(markerKey(t, tenantId)));
  for (const row of input.supplement.accountAuthStates) {
    const key = t.accountKey(tenantId, row.userId);
    const actual = rows.get(keyId(key));
    if (!actual || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(actual.revision?.S ?? ''))
      invalid();
    const expected = accountItem(t, row);
    expected.revision = actual.revision;
    if (!equal(actual, expected)) invalid();
    rows.delete(keyId(key));
  }
  for (const row of input.supplement.passkeyCounters) {
    const key = counterKey(t, tenantId, row.userId, row.passkeyId);
    const actual = rows.get(keyId(key));
    if (!actual) invalid();
    const count = Number(actual.counter?.N);
    const updated = Number(actual.updatedAtMs?.N);
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Number.isSafeInteger(updated) ||
      updated < 1 ||
      (mode === 'staging'
        ? String(count) !== row.counter || updated !== row.updatedAtMs
        : count < Number(row.counter) || updated < row.updatedAtMs) ||
      !equal(Object.keys(actual).sort(), ['counter', 'pk', 'sk', 'updatedAtMs'])
    )
      invalid();
    rows.delete(keyId(key));
  }
  const registry = new DynamoPersistentNameIDRegistry(t);
  for (const row of input.supplement.persistentNameIds) {
    const key = t.key(tenantId, 'NAMEID', row.registryKey);
    const actual = rows.get(keyId(key));
    if (
      !actual ||
      actual.valueJson?.S !== row.valueJson ||
      (await registry.get({ tenantId, key: row.registryKey })) !== row.valueJson
    )
      invalid();
    validateNameIDItem(
      t,
      actual,
      new Set(input.supplement.accountAuthStates.map((r) => r.userId)),
      tenantId
    );
    rows.delete(keyId(key));
  }
  const users = new Set(input.supplement.accountAuthStates.map((r) => r.userId));
  for (const actual of rows.values()) {
    if (mode === 'staging') invalid();
    if (actual.pk?.S?.startsWith(`${prefix(input.target, tenantId)}NAMEID#`))
      validateNameIDItem(t, actual, users, tenantId);
    else if (actual.pk?.S?.startsWith(`${prefix(input.target, tenantId)}ACCOUNT#`)) invalid();
    else if (
      !['SESSION', 'CHALLENGE', 'SAML', 'KV', 'RATE', 'CODE', 'CODE_USER'].some((kind) =>
        actual.pk?.S?.startsWith(`${prefix(input.target, tenantId)}${kind}#`)
      )
    )
      invalid();
  }
}
function validateNameIDItem(
  t: DynamoStateTable,
  item: Item,
  users: Set<string>,
  tenantId: string
): void {
  const raw = item.valueJson?.S;
  if (raw === undefined) invalid();
  const decoded = JSON.parse(raw) as Record<string, unknown>;
  const key = `saml:persistent-nameid:tenant:${tenantId}:sp:${encodeURIComponent(String(decoded.spEntityId))}:subject:${encodeURIComponent(String(decoded.subjectId))}`;
  const identity = validateSAMLPersistentNameIDRecord(key, raw);
  if (
    !users.has(identity.subjectId) ||
    keyId(item) !== keyId(t.key(tenantId, 'NAMEID', key)) ||
    Object.keys(item).sort().join(',') !== 'pk,semanticHash,sk,valueJson'
  )
    invalid();
  // The source record validator checks identity; the runtime also relies on this immutable hash.
  delete decoded.createdAt;
  if (item.semanticHash?.S !== hash(canonicalDynamoStateJson(decoded))) invalid();
}

/** All row comparisons and inventory checks are read-only. */
export async function assertVerifiedDynamoAuthStateRestored(
  input: DynamoAuthStateReadbackInput
): Promise<void> {
  try {
    await assertRows(input, 'staging');
    await assertDynamoAuthStateSealed(input);
  } catch {
    invalid();
  }
}
export async function assertDynamoAuthStateLiveCompatible(
  input: DynamoAuthStateReadbackInput
): Promise<void> {
  try {
    await assertDynamoAuthStateSealed(input);
    await assertRows(input, 'live');
    await assertDynamoAuthStateSealed(input);
  } catch {
    invalid();
  }
}

export async function restoreVerifiedDynamoAuthState(
  input: DynamoAuthStateSource & { client: Client; restoreId: string }
): Promise<DynamoAuthStateRestoreReceipt> {
  let claimed = false;
  const owner = randomUUID();
  let t: DynamoStateTable | undefined;
  let key: Item | undefined;
  try {
    const target = normalizeAwsAuthStateConfig(input.target, { restoreId: input.restoreId });
    if (target.backend !== 'dynamodb') invalid();
    const source = structuredClone({
      manifest: input.manifest,
      supplement: input.supplement,
      expected: input.expected,
      target,
    });
    const receipt = createDynamoAuthStateRestoreReceipt(source);
    await assertDynamoAuthStateTable(input.client, target);
    const selectedTable = table(input.client, target);
    t = selectedTable;
    const selectedKey = markerKey(selectedTable, receipt.tenantId);
    key = selectedKey;
    await input.client.send(
      new PutItemCommand({
        TableName: t.tableName,
        Item: {
          ...key,
          status: S('staging'),
          owner: S(owner),
          receiptJson: S(canonicalRestoreJson(receipt)),
          receiptSha256: S(restoreEvidenceDigest(receipt)),
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      })
    );
    claimed = true;
    if (
      (await namespaceItems(t, receipt.tenantId)).some((item) => keyId(item) !== keyId(selectedKey))
    )
      invalid();
    const records: Item[] = source.supplement.accountAuthStates.map((r) =>
      accountItem(selectedTable, r)
    );
    for (const row of source.supplement.passkeyCounters)
      records.push({
        ...counterKey(t, receipt.tenantId, row.userId, row.passkeyId),
        counter: N(Number(row.counter)),
        updatedAtMs: N(row.updatedAtMs),
      });
    // Source records are already authenticated/validated; use the same canonical hash as runtime puts.
    for (const row of source.supplement.persistentNameIds) {
      const value = JSON.parse(row.valueJson) as Record<string, unknown>;
      delete value.createdAt;
      records.push({
        ...t.key(receipt.tenantId, 'NAMEID', row.registryKey),
        valueJson: S(row.valueJson),
        semanticHash: S(hash(canonicalDynamoStateJson(value))),
      });
    }
    for (let from = 0; from < records.length; from += 25) {
      await input.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: t.tableName,
                Key: key,
                ConditionExpression: '#status = :staging AND #owner = :owner',
                ExpressionAttributeNames: { '#status': 'status', '#owner': 'owner' },
                ExpressionAttributeValues: { ':staging': S('staging'), ':owner': S(owner) },
              },
            },
            ...records.slice(from, from + 25).map((Item) => ({
              Put: {
                TableName: selectedTable.tableName,
                Item,
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            })),
          ],
        })
      );
    }
    await assertRows({ ...source, client: input.client, receipt }, 'staging');
    await input.client.send(
      new UpdateItemCommand({
        TableName: t.tableName,
        Key: key,
        UpdateExpression: 'SET #status = :sealed',
        ConditionExpression: '#status = :staging AND #owner = :owner',
        ExpressionAttributeNames: { '#status': 'status', '#owner': 'owner' },
        ExpressionAttributeValues: {
          ':sealed': S('sealed'),
          ':staging': S('staging'),
          ':owner': S(owner),
        },
      })
    );
    await assertDynamoAuthStateSealed({ client: input.client, target, receipt });
    return receipt;
  } catch {
    if (claimed && t && key)
      await input.client
        .send(
          new UpdateItemCommand({
            TableName: t.tableName,
            Key: key,
            UpdateExpression: 'SET #status = :failed',
            ConditionExpression: '#status = :staging AND #owner = :owner',
            ExpressionAttributeNames: { '#status': 'status', '#owner': 'owner' },
            ExpressionAttributeValues: {
              ':failed': S('failed'),
              ':staging': S('staging'),
              ':owner': S(owner),
            },
          })
        )
        .catch(() => undefined);
    return invalid();
  }
}

/** Read these AFTER the Core snapshot. Counter authority must never be inferred from its SQL mirror. */
export async function readDynamoAuthStateCounters(input: {
  client: Client;
  target: DynamoAuthStateConfig;
  receipt: DynamoAuthStateRestoreReceipt;
  passkeys: AwsStateSourceExpectations['passkeys'];
}): Promise<Array<{ user_id: string; credential_id: string; counter: string }>> {
  try {
    await assertDynamoAuthStateSealed(input);
    const t = table(input.client, input.target);
    const rows: Array<{ user_id: string; credential_id: string; counter: string }> = [];
    for (const passkey of input.passkeys) {
      const result = await input.client.send(
        new GetItemCommand({
          TableName: t.tableName,
          Key: counterKey(t, input.receipt.tenantId, passkey.userId, passkey.passkeyId),
          ConsistentRead: true,
        })
      );
      const value = result.Item?.counter?.N;
      if (
        value === undefined ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < Number(passkey.sourceCounter)
      )
        invalid();
      rows.push({ user_id: passkey.userId, credential_id: passkey.passkeyId, counter: value });
    }
    return rows;
  } catch {
    return invalid();
  }
}
