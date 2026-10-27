/** Read-only synthetic rehearsal observations for the selected auth authority. */
import { createHash } from 'node:crypto';
import { ScanCommand, type DynamoDBClient, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { createDynamoStateClient, DynamoStateTable } from '../storage/dynamodb-state';
import { dynamoAuthStateTableName, type DynamoAuthStateConfig } from '../storage/auth-state-config';
import {
  assertDynamoAuthStateSealed,
  assertDynamoAuthStateTable,
  type DynamoAuthStateRestoreReceipt,
} from '../import/auth-state-restore';

export interface SyntheticAuthStateSnapshot {
  counter: number;
  sessions: number;
  outstanding: number;
  consumed: number;
}
const TENANT = 'tenant-a';
const USER = 'user-tenant-a';
function fail(): never {
  throw new Error('aws_synthetic_auth_state_snapshot_invalid');
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Core is observed first by the caller; this routine never reads its SQL counter mirror. */
export async function readSyntheticDynamoAuthStateSnapshot(
  input: {
    target: DynamoAuthStateConfig;
    receipt: DynamoAuthStateRestoreReceipt;
    passkeyRowId: string;
  },
  dependencies: {
    createClient?(target: DynamoAuthStateConfig): DynamoDBClient;
    now?: () => number;
  } = {}
): Promise<SyntheticAuthStateSnapshot> {
  let client: DynamoDBClient | undefined;
  try {
    if (
      !/^[A-Za-z0-9._:-]{1,200}$/u.test(input.passkeyRowId) ||
      input.receipt.tenantId !== TENANT ||
      input.receipt.source.tenantId !== TENANT
    )
      fail();
    client =
      dependencies.createClient?.(input.target) ??
      createDynamoStateClient({ region: input.target.region });
    await assertDynamoAuthStateTable(client, input.target);
    await assertDynamoAuthStateSealed({ ...input, client });
    const table = new DynamoStateTable({
      client,
      tableName: dynamoAuthStateTableName(input.target),
      namespace: input.target.namespace,
    });
    const counter = await table.get({
      ...table.accountKey(TENANT, USER),
      sk: { S: `COUNTER#${hash(input.passkeyRowId)}` },
    });
    const value = counter?.counter?.N;
    if (
      value === undefined ||
      !/^(0|[1-9][0-9]*)$/u.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) > 0xffffffff
    )
      fail();
    let sessions = 0;
    let outstanding = 0;
    let consumed = 0;
    let cursor: Record<string, AttributeValue> | undefined;
    const now = (dependencies.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 1) fail();
    const prefix = `${input.target.namespace}#T#${hash(TENANT)}#`;
    do {
      const page = await client.send(
        new ScanCommand({
          TableName: table.tableName,
          ConsistentRead: true,
          Limit: 200,
          FilterExpression: 'begins_with(pk, :sessions) OR begins_with(pk, :challenges)',
          ExpressionAttributeValues: {
            ':sessions': { S: `${prefix}SESSION#` },
            ':challenges': { S: `${prefix}CHALLENGE#` },
          },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        })
      );
      for (const row of page.Items ?? []) {
        const payload = JSON.parse(row.payloadJson?.S ?? 'null') as Record<string, unknown> | null;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail();
        if (payload.userId !== USER) continue;
        if (row.pk?.S?.startsWith(`${prefix}SESSION#`)) sessions++;
        else if (
          payload.type === 'synthetic-browser-sp' &&
          row.itemId?.S?.startsWith('browser-sp:_browser_')
        ) {
          const boundKey = table.key(TENANT, 'CHALLENGE', row.itemId.S);
          if (row.pk?.S !== boundKey.pk.S || row.sk?.S !== boundKey.sk.S) fail();
          if (row.consumedAtMs !== undefined) consumed++;
          else {
            const expires = Number(row.expiresAtMs?.N);
            if (!Number.isSafeInteger(expires) || expires < 1) fail();
            if (expires > now) outstanding++;
          }
        }
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor && Object.keys(cursor).length);
    await assertDynamoAuthStateSealed({ ...input, client });
    return { counter: Number(value), sessions, outstanding, consumed };
  } catch {
    return fail();
  } finally {
    client?.destroy();
  }
}
