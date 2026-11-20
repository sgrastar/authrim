import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BatchWriteItemCommand,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { runWithReplicationWriteEffects } from '@authrim/ar-lib-core/services/deployment-replication/write-effects';
import {
  canonicalDynamoStateJson,
  createDynamoStateClient,
  DynamoStateTable,
} from './dynamodb-state';

// A mutant that drops the injected requestHandler/credentials must fail at the transport
// boundary instead of reaching the real network (DynamoDB, STS or the metadata endpoint).
beforeEach(() => {
  const forbid = () => {
    throw new Error('real network access is forbidden in mutation tests');
  };
  vi.spyOn(http, 'request').mockImplementation(forbid);
  vi.spyOn(https, 'request').mockImplementation(forbid);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const credentials = { accessKeyId: 'localtest', secretAccessKey: 'localtest' };
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

function tableFixture(
  respond: (command: unknown) => Promise<unknown> = async () => ({}),
  now = 1000
) {
  const client = createDynamoStateClient({ region: 'ap-northeast-1', credentials });
  const send = vi.spyOn(client, 'send').mockImplementation(respond as never);
  const table = new DynamoStateTable({
    client,
    tableName: 'test-state',
    namespace: 'generation-one',
    now: () => now,
  });
  return { client, send, table };
}
const inputOf = (send: ReturnType<typeof vi.fn>, i = 0) =>
  (send.mock.calls[i][0] as { input: Record<string, unknown> }).input;

describe('createDynamoStateClient configuration', () => {
  it('rejects malformed regions and non-loopback endpoints with exact codes', () => {
    for (const region of ['', 'us-east', 'US-EAST-1', 'us-east-1x', 'xx']) {
      expect(() => createDynamoStateClient({ region })).toThrow('aws_state_configuration_invalid');
    }
    expect(() =>
      createDynamoStateClient({ region: 'us-east-1', endpoint: 'https://dynamodb.example.test' })
    ).toThrow('aws_state_endpoint_invalid');
    for (const endpoint of [
      'http://localhost:8000',
      'http://127.0.0.1:8000',
      'http://[::1]:8000',
    ]) {
      const client = createDynamoStateClient({ region: 'us-east-1', credentials, endpoint });
      client.destroy();
    }
  });
});

describe('replication write observation middleware', () => {
  const key = { pk: { S: 'p' }, sk: { S: 'STATE' } };
  const commands: Record<string, () => unknown> = {
    PutItemCommand: () => new PutItemCommand({ TableName: 't', Item: key }),
    UpdateItemCommand: () => new UpdateItemCommand({ TableName: 't', Key: key }),
    DeleteItemCommand: () => new DeleteItemCommand({ TableName: 't', Key: key }),
    BatchWriteItemCommand: () =>
      new BatchWriteItemCommand({ RequestItems: { t: [{ PutRequest: { Item: key } }] } }),
    TransactWriteItemsCommand: () =>
      new TransactWriteItemsCommand({ TransactItems: [{ Put: { TableName: 't', Item: key } }] }),
  };

  async function outcome(error: unknown, make: () => unknown): Promise<'known' | 'unknown'> {
    const client = createDynamoStateClient({
      region: 'ap-northeast-1',
      credentials,
      requestHandler: {
        handle: async () => {
          throw error;
        },
      },
    });
    try {
      await runWithReplicationWriteEffects(async () => {
        try {
          await client.send(make() as never);
        } catch {
          // The application catches; the observer must still know whether it was definite.
        }
      });
      return 'known';
    } catch (e) {
      expect((e as Error).message).toBe('replication_writer_outcome_unknown');
      return 'unknown';
    } finally {
      client.destroy();
    }
  }
  const failure = (name: unknown, status: unknown) =>
    Object.assign(new Error('x'), { name, $metadata: { httpStatusCode: status } });

  it.each(Object.keys(commands))('%s failures are observed as uncertain', async (name) => {
    expect(await outcome(new Error('lost'), commands[name])).toBe('unknown');
  });

  it('does not observe reads', async () => {
    expect(
      await outcome(new Error('lost'), () => new GetItemCommand({ TableName: 't', Key: key }))
    ).toBe('known');
  });

  it.each([
    'ConditionalCheckFailedException',
    'TransactionCanceledException',
    'ValidationException',
    'AccessDeniedException',
    'ResourceNotFoundException',
    'ProvisionedThroughputExceededException',
    'RequestLimitExceeded',
    'ThrottlingException',
    'ItemCollectionSizeLimitExceededException',
  ])('treats a 4xx %s as a definite rejection', async (name) => {
    expect(await outcome(failure(name, 400), commands.PutItemCommand)).toBe('known');
    expect(await outcome(failure(name, 499), commands.PutItemCommand)).toBe('known');
  });

  it('does not treat other statuses, names or shapes as definite', async () => {
    const put = commands.PutItemCommand;
    expect(await outcome(failure('ValidationException', 399), put)).toBe('unknown');
    expect(await outcome(failure('ValidationException', 500), put)).toBe('unknown');
    expect(await outcome(failure('ValidationException', '400'), put)).toBe('unknown');
    expect(await outcome(failure('ValidationException', undefined), put)).toBe('unknown');
    expect(await outcome(failure('InternalServerError', 400), put)).toBe('unknown');
    expect(await outcome(failure(undefined, 400), put)).toBe('unknown');
    expect(await outcome(failure(5, 400), put)).toBe('unknown');
    const noMeta = Object.assign(new Error('x'), { name: 'ValidationException' });
    expect(await outcome(noMeta, put)).toBe('unknown');
  });
});

describe('GetItem transport retry boundaries', () => {
  async function attempts(error: Error, command: unknown): Promise<number> {
    let count = 0;
    const client = createDynamoStateClient({
      region: 'ap-northeast-1',
      credentials,
      requestHandler: {
        handle: async () => {
          count++;
          if (count === 1) throw error;
          return {
            response: {
              statusCode: 200,
              headers: { 'content-type': 'application/x-amz-json-1.0' },
              body: Readable.from(['{}']),
            },
          };
        },
      },
    });
    try {
      await client.send(command as never).catch(() => undefined);
    } finally {
      client.destroy();
    }
    return count;
  }
  const get = () =>
    new GetItemCommand({ TableName: 't', Key: { pk: { S: 'p' }, sk: { S: 'STATE' } } });

  it('retries a bare ECONNRESET once but not one carrying an HTTP status or response', async () => {
    expect(await attempts(Object.assign(new Error('r'), { code: 'ECONNRESET' }), get())).toBe(2);
    expect(
      await attempts(
        Object.assign(new Error('r'), { code: 'ECONNRESET', $metadata: { httpStatusCode: 503 } }),
        get()
      )
    ).toBe(1);
    expect(
      await attempts(Object.assign(new Error('r'), { code: 'ECONNRESET', $response: {} }), get())
    ).toBe(1);
    expect(await attempts(Object.assign(new Error('r'), { code: 'ETIMEDOUT' }), get())).toBe(1);
  });
});

describe('DynamoStateTable', () => {
  const base = { tableName: 'test-state', namespace: 'generation-one' };
  const client = createDynamoStateClient({ region: 'ap-northeast-1' });

  it('validates table names and namespaces with anchored patterns and exact length limits', () => {
    const ok = (o: Partial<{ tableName: string; namespace: string }>) =>
      new DynamoStateTable({ client, ...base, ...o });
    const bad = (o: Partial<{ tableName: string; namespace: string }>) =>
      expect(() => ok(o)).toThrow('aws_state_configuration_invalid');
    ok({ tableName: 'abc' });
    ok({ tableName: 'a'.repeat(255) });
    ok({ tableName: 'a_b.c-d' });
    bad({ tableName: 'ab' });
    bad({ tableName: 'a'.repeat(256) });
    bad({ tableName: ' abc' });
    bad({ tableName: 'abc ' });
    bad({ tableName: 'ab:cd' });
    ok({ namespace: 'a' });
    ok({ namespace: 'a'.repeat(128) });
    bad({ namespace: 'a'.repeat(129) });
    bad({ namespace: ' abc' });
    bad({ namespace: 'abc ' });
    bad({ namespace: 'a.b' });
    bad({ namespace: '' });
  });

  it('requires a client created by the single-attempt factory', () => {
    expect(() => new DynamoStateTable({ client: { send: vi.fn() } as never, ...base })).toThrow(
      'aws_state_single_attempt_client_required'
    );
  });

  it('uses Date.now by default and validates the clock', () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1234);
    try {
      expect(new DynamoStateTable({ client, ...base }).now()).toBe(1234);
    } finally {
      spy.mockRestore();
    }
    for (const value of [0, -1, 1.5, Number.NaN]) {
      const table = new DynamoStateTable({ client, ...base, now: () => value });
      expect(() => table.now()).toThrow('Invalid state clock');
    }
  });

  it('builds hashed pk/sk keys and rejects invalid tenants', () => {
    const { table } = tableFixture();
    expect(table.key('tenant-a', 'SESSION', 'id-1')).toEqual({
      pk: { S: `generation-one#T#${hash('tenant-a')}#SESSION#${hash('id-1')}` },
      sk: { S: 'STATE' },
    });
    expect(table.key('tenant-a', 'X', 'i', 'COUNTER#1').sk).toEqual({ S: 'COUNTER#1' });
    expect(table.accountKey('tenant-a', 'user-1').pk.S).toBe(
      `generation-one#T#${hash('tenant-a')}#ACCOUNT#${hash('user-1')}`
    );
    expect(() => table.key('Bad', 'X', 'i')).toThrow('Invalid tenant ID');
    expect(() => table.key('-bad', 'X', 'i')).toThrow('Invalid tenant ID');
  });

  it('reads with a strongly consistent GetItem', async () => {
    const item = { pk: { S: 'a' } };
    const { table, send } = tableFixture(async () => ({ Item: item }));
    expect(await table.get({ pk: { S: 'a' } })).toBe(item);
    expect(inputOf(send)).toEqual({
      TableName: 'test-state',
      Key: { pk: { S: 'a' } },
      ConsistentRead: true,
    });
  });

  it('live() is false for absent, consumed or expired items and strict at the boundary', () => {
    const { table } = tableFixture(undefined, 1000);
    expect(table.live(undefined)).toBe(false);
    expect(table.live({ expiresAtMs: { N: '1001' } })).toBe(true);
    expect(table.live({ expiresAtMs: { N: '1000' } })).toBe(false);
    expect(table.live({ expiresAtMs: { N: '5000' } }, 5000)).toBe(false);
    expect(table.live({ expiresAtMs: { N: '5001' } }, 5000)).toBe(true);
    expect(table.live({ expiresAtMs: { N: '5000' }, consumedAtMs: { N: '1' } })).toBe(false);
    expect(() => table.live({ consumedAtMs: undefined } as never)).toThrow(
      'aws_state_record_invalid'
    );
  });

  it('transient() shapes the item and validates expiry and payload size', () => {
    const { table } = tableFixture();
    const key = { pk: { S: 'p' }, sk: { S: 'STATE' } };
    expect(table.transient(key, { a: 1 }, 10, 2001)).toEqual({
      ...key,
      payloadJson: { S: '{"a":1}' },
      createdAtMs: { N: '10' },
      expiresAtMs: { N: '2001' },
      ttl: { N: '3' },
    });
    expect(table.transient(key, {}, 10, 2000).ttl).toEqual({ N: '2' });
    expect(() => table.transient(key, {}, 10, 0)).toThrow('Invalid state expiry');
    expect(() => table.transient(key, {}, 10, 1.5)).toThrow('Invalid state expiry');
    const exact = 64 * 1024 - '{"v":""}'.length;
    expect(table.transient(key, { v: 'a'.repeat(exact) }, 1, 2).payloadJson.S).toHaveLength(
      64 * 1024
    );
    expect(() => table.transient(key, { v: 'a'.repeat(exact + 1) }, 1, 2)).toThrow(
      'aws_state_payload_too_large'
    );
  });

  describe('consume()', () => {
    const key = { pk: { S: 'p' }, sk: { S: 'STATE' } };
    it('issues one conditional UpdateItem with the exact expressions', async () => {
      const attrs = { expiresAtMs: { N: '2000' } };
      const { table, send } = tableFixture(async () => ({ Attributes: attrs }), 1000);
      expect(await table.consume(key)).toBe(attrs);
      expect(inputOf(send)).toEqual({
        TableName: 'test-state',
        Key: key,
        UpdateExpression: 'SET consumedAtMs = :now',
        ConditionExpression:
          'attribute_exists(pk) AND attribute_not_exists(consumedAtMs) AND expiresAtMs > :now',
        ExpressionAttributeValues: { ':now': { N: '1000' } },
        ReturnValues: 'ALL_OLD',
      });
    });
    it('appends extra condition, values and assignments; omits the liveness clause on request', async () => {
      const { table, send } = tableFixture(async () => ({ Attributes: { x: { S: '1' } } }), 1000);
      await table.consume(key, ' AND a = :a', { ':a': { S: 'v' } }, false, ', b = :a');
      expect(inputOf(send)).toMatchObject({
        UpdateExpression: 'SET consumedAtMs = :now, b = :a',
        ConditionExpression:
          'attribute_exists(pk) AND attribute_not_exists(consumedAtMs) AND a = :a',
        ExpressionAttributeValues: { ':now': { N: '1000' }, ':a': { S: 'v' } },
      });
    });
    it('returns expired attributes only when liveness is not required', async () => {
      const expired = { expiresAtMs: { N: '500' } };
      const { table } = tableFixture(async () => ({ Attributes: expired }), 1000);
      expect(await table.consume(key)).toBeNull();
      expect(await table.consume(key, '', {}, false)).toBe(expired);
    });
    it('requires a receipt, maps conditional failures to null and rethrows others', async () => {
      await expect(tableFixture(async () => ({})).table.consume(key)).rejects.toThrow(
        'aws_state_consume_receipt_missing'
      );
      const cond = Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
      expect(
        await tableFixture(async () => {
          throw cond;
        }).table.consume(key)
      ).toBeNull();
      const other = Object.assign(new Error('o'), { name: 'ThrottlingException' });
      await expect(
        tableFixture(async () => {
          throw other;
        }).table.consume(key)
      ).rejects.toBe(other);
      const notError = 'plain';
      await expect(
        tableFixture(async () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw notError;
        }).table.consume(key)
      ).rejects.toBe(notError);
    });
  });
});

describe('canonicalDynamoStateJson', () => {
  it('sorts object keys recursively, preserves array order and encodes primitives', () => {
    expect(canonicalDynamoStateJson({ b: 1, a: [2, { d: 1, c: null }], B: 'x' })).toBe(
      '{"B":"x","a":[2,{"c":null,"d":1}],"b":1}'
    );
    expect(canonicalDynamoStateJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalDynamoStateJson({})).toBe('{}');
    expect(canonicalDynamoStateJson([])).toBe('[]');
    expect(canonicalDynamoStateJson(null)).toBe('null');
    expect(canonicalDynamoStateJson('s"q')).toBe('"s\\"q"');
    expect(canonicalDynamoStateJson(5)).toBe('5');
    expect(canonicalDynamoStateJson({ 'k"': true })).toBe('{"k\\"":true}');
  });
});
