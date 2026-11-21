/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- fake DynamoDB/Postgres command inputs are intentionally untyped */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalDynamoStateJson,
  createDynamoStateClient,
  DynamoAuthorizationCodeStore,
  DynamoPersistentNameIDRegistry,
  DynamoRateLimitStore,
  DynamoReplayGuardStore,
  DynamoStateTable,
} from './dynamodb-state';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
type Handler = (input: any) => any;

function fixture(handlers: Record<string, Handler> = {}, now: () => number = () => 1_500_999) {
  const client = createDynamoStateClient({
    region: 'ap-northeast-1',
    credentials: { accessKeyId: 'localtest', secretAccessKey: 'localtest' },
  });
  const send = vi.spyOn(client, 'send').mockImplementation((async (command: {
    constructor: { name: string };
    input: unknown;
  }) => {
    const handler = handlers[command.constructor.name.replace(/Command$/, '')];
    if (!handler) throw new Error(`unexpected ${command.constructor.name}`);
    return handler(command.input);
  }) as never);
  const table = new DynamoStateTable({
    client,
    tableName: 'test-state',
    namespace: 'generation-one',
    now,
  });
  return {
    send,
    table,
    rate: new DynamoRateLimitStore(table),
    replay: new DynamoReplayGuardStore(table),
    codes: new DynamoAuthorizationCodeStore(table),
    nameIds: new DynamoPersistentNameIDRegistry(table),
  };
}
const inputs = (send: ReturnType<typeof vi.fn>, name: string): any[] =>
  send.mock.calls
    .map((c) => c[0] as { constructor: { name: string }; input: unknown })
    .filter((c) => c.constructor.name === `${name}Command`)
    .map((c) => c.input);
const T = 'tenant-a';
const conditional = Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
const canceled = Object.assign(new Error('t'), {
  name: 'TransactionCanceledException',
  CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
});
const other = Object.assign(new Error('o'), { name: 'ThrottlingException' });
const throws = (e: unknown) => () => {
  throw e;
};

describe('DynamoRateLimitStore', () => {
  const base = { key: 'k', windowSeconds: 60, maxRequests: 5 };
  const gKey = { pk: { S: `generation-one#GLOBAL#RATE#${hash('k')}` }, sk: { S: 'STATE' } };

  it('validates tenant, key and bounds with exact messages', async () => {
    const { rate, send } = fixture();
    await expect(rate.check({ ...base, tenantId: 'Bad' })).rejects.toThrow(
      'Invalid rate limit tenant'
    );
    await expect(rate.check({ ...base, key: '' })).rejects.toThrow('Invalid rate limit key');
    await expect(rate.check({ ...base, key: 'k'.repeat(4097) })).rejects.toThrow(
      'Invalid rate limit key'
    );
    for (const windowSeconds of [0, 86_401, 1.5]) {
      await expect(rate.check({ ...base, windowSeconds })).rejects.toThrow(
        'Invalid rate limit window'
      );
    }
    for (const maxRequests of [0, 1_000_001, 1.5]) {
      await expect(rate.check({ ...base, maxRequests })).rejects.toThrow(
        'Invalid rate limit maximum'
      );
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts boundary values', async () => {
    const { rate } = fixture({ GetItem: () => ({}), PutItem: () => ({}) });
    await rate.check({ key: 'k'.repeat(4096), windowSeconds: 1, maxRequests: 1 });
    await rate.check({ key: 'k', windowSeconds: 86_400, maxRequests: 1_000_000 });
  });

  it('starts a global window with a conditional create', async () => {
    const { rate, send } = fixture({ GetItem: () => ({}), PutItem: () => ({}) });
    expect(await rate.check(base)).toEqual({ allowed: true, remaining: 4, resetAt: 1560 });
    expect(inputs(send, 'GetItem')[0].Key).toEqual(gKey);
    const put = inputs(send, 'PutItem')[0];
    expect(put).toEqual({
      TableName: 'test-state',
      Item: {
        ...gKey,
        requestCount: { N: '1' },
        resetAt: { N: '1560' },
        ttl: { N: '1560' },
        revision: { S: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect('ExpressionAttributeValues' in put).toBe(false);
  });

  it('uses a hashed tenant key and increments an open window under a revision guard', async () => {
    const current = {
      requestCount: { N: '2' },
      resetAt: { N: '1600' },
      revision: { S: 'rev-0' },
    };
    const { rate, send, table } = fixture({
      GetItem: () => ({ Item: current }),
      PutItem: () => ({}),
    });
    expect(await rate.check({ ...base, tenantId: T })).toEqual({
      allowed: true,
      remaining: 2,
      resetAt: 1600,
    });
    expect(inputs(send, 'GetItem')[0].Key).toEqual(table.key(T, 'RATE', 'k'));
    const put = inputs(send, 'PutItem')[0];
    expect(put.Item.requestCount).toEqual({ N: '3' });
    expect(put.Item.resetAt).toEqual({ N: '1600' });
    expect(put.Item.ttl).toEqual({ N: '1600' });
    expect(put.ConditionExpression).toBe('revision = :old');
    expect(put.ExpressionAttributeValues).toEqual({ ':old': { S: 'rev-0' } });
  });

  it('caps the count at max+1 and reports denial; window resets when resetAt <= now', async () => {
    const at = (count: string, reset: string) =>
      fixture({
        GetItem: () => ({
          Item: { requestCount: { N: count }, resetAt: { N: reset }, revision: { S: 'r' } },
        }),
        PutItem: () => ({}),
      });
    expect(await at('5', '1600').rate.check(base)).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: 1600,
    });
    const big = at('99', '1600');
    await big.rate.check(base);
    expect(inputs(big.send, 'PutItem')[0].Item.requestCount).toEqual({ N: '6' });
    expect(await at('4', '1600').rate.check(base)).toEqual({
      allowed: true,
      remaining: 0,
      resetAt: 1600,
    });
    expect(await at('9', '1500').rate.check(base)).toEqual({
      allowed: true,
      remaining: 4,
      resetAt: 1560,
    });
    expect(await at('9', '1501').rate.check(base)).toMatchObject({ resetAt: 1501, allowed: false });
  });

  it('rejects malformed stored counters', async () => {
    const bad = fixture({
      GetItem: () => ({
        Item: { requestCount: { N: '-1' }, resetAt: { N: '1600' }, revision: { S: 'r' } },
      }),
    });
    await expect(bad.rate.check(base)).rejects.toThrow('aws_state_record_invalid');
    const noReset = fixture({
      GetItem: () => ({ Item: { requestCount: { N: '1' }, revision: { S: 'r' } } }),
    });
    await expect(noReset.rate.check(base)).rejects.toThrow('aws_state_record_invalid');
  });

  it('retries lost races up to 32 times, then reports contention; rethrows others', async () => {
    const racing = fixture({ GetItem: () => ({}), PutItem: throws(conditional) });
    await expect(racing.rate.check(base)).rejects.toThrow('aws_state_contention');
    expect(inputs(racing.send, 'PutItem')).toHaveLength(32);
    let calls = 0;
    const recovering = fixture({
      GetItem: () => ({}),
      PutItem: () => {
        if (++calls < 2) throw conditional;
        return {};
      },
    });
    expect((await recovering.rate.check(base)).allowed).toBe(true);
    await expect(
      fixture({ GetItem: () => ({}), PutItem: throws(other) }).rate.check(base)
    ).rejects.toBe(other);
  });
});

describe('DynamoReplayGuardStore', () => {
  const input = { tenantId: T, key: 'jti', ttlSeconds: 10 };

  it('validates key and TTL with exact messages', async () => {
    const { replay, send } = fixture();
    await expect(replay.record({ ...input, key: '' })).rejects.toThrow('Invalid replay guard key');
    await expect(replay.record({ ...input, key: 'k'.repeat(4097) })).rejects.toThrow(
      'Invalid replay guard key'
    );
    for (const ttlSeconds of [0, 30 * 24 * 60 * 60 + 1, 1.5]) {
      await expect(replay.record({ ...input, ttlSeconds })).rejects.toThrow(
        'Invalid replay guard TTL'
      );
    }
    await expect(replay.record({ ...input, tenantId: 'Bad' })).rejects.toThrow('Invalid tenant ID');
    await expect(replay.isRecorded({ tenantId: T, key: '' })).rejects.toThrow(
      'Invalid replay guard key'
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('records with a single conditional put and reports replays', async () => {
    const f = fixture({ PutItem: () => ({}) });
    expect(
      await f.replay.record({ ...input, key: 'k'.repeat(4096), ttlSeconds: 30 * 24 * 60 * 60 })
    ).toBe('recorded');
    await f.replay.record({ ...input, ttlSeconds: 1 });
    const put = inputs(f.send, 'PutItem')[1];
    expect(put).toEqual({
      TableName: 'test-state',
      Item: {
        ...f.table.key(T, 'JTI', 'jti'),
        expiresAtMs: { N: String(1_500_999 + 1000) },
        ttl: { N: String(Math.ceil((1_500_999 + 1000) / 1000)) },
      },
      ConditionExpression: 'attribute_not_exists(pk) OR expiresAtMs <= :now',
      ExpressionAttributeValues: { ':now': { N: '1500999' } },
    });
    expect(await fixture({ PutItem: throws(conditional) }).replay.record(input)).toBe('replayed');
    await expect(fixture({ PutItem: throws(other) }).replay.record(input)).rejects.toBe(other);
  });

  it('isRecorded is true only for an unexpired item (strict boundary)', async () => {
    const get = (item: unknown, key = 'jti') =>
      fixture({ GetItem: () => ({ Item: item }) }).replay.isRecorded({ tenantId: T, key });
    expect(await get(undefined)).toBe(false);
    expect(await get({ expiresAtMs: { N: '1500999' } })).toBe(false);
    expect(await get({ expiresAtMs: { N: '1501000' } })).toBe(true);
    expect(await get({ expiresAtMs: { N: '1' } })).toBe(false);
    await expect(get({ expiresAtMs: { N: 'x' } })).rejects.toThrow('aws_state_record_invalid');
    expect(await get({ expiresAtMs: { N: '1501000' } }, 'k'.repeat(4096))).toBe(true);
  });
});

describe('DynamoAuthorizationCodeStore', () => {
  const CODE = '123e4567-e89b-42d3-a456-426614174000';
  const request = (over: Record<string, unknown> = {}) =>
    ({
      code: CODE,
      tenantId: T,
      userId: 'user-1',
      clientId: 'client-1',
      redirectUri: 'https://authrim.local/direct-auth/callback',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      scope: 'openid',
      ...over,
    }) as any;
  const happy = (extra: Record<string, Handler> = {}) => ({
    GetItem: () => ({}),
    Query: () => ({ Count: 0 }),
    TransactWriteItems: () => ({}),
    ...extra,
  });
  const UNSUPPORTED = 'aws_authorization_code_profile_unsupported';

  it('rejects every profile violation', async () => {
    const { codes, send } = fixture();
    const cases: Record<string, unknown>[] = [
      { tenantId: 'Bad' },
      { code: '123e4567-e89b-52d3-a456-426614174000' },
      { code: '123e4567-e89b-42d3-c456-426614174000' },
      { code: '123E4567-E89B-42D3-A456-426614174000' },
      { code: `x${CODE}` },
      { code: `${CODE}x` },
      { code: '123e4567-e89b-42d3-a456-42661417400' },
      { userId: '' },
      { userId: 'u'.repeat(257) },
      { clientId: '' },
      { clientId: 'c'.repeat(257) },
      { redirectUri: 'https://evil.example/cb' },
      { codeChallengeMethod: 'plain' },
      { codeChallenge: '' },
      { codeChallenge: 'x'.repeat(257) },
      { authorizationServer: 'other' },
      { authorizationServer: '' },
      { subjectType: 'service' },
      { subjectType: '' },
      { ttlSeconds: 3601 },
      { maxCodesPerUser: 10_001 },
    ];
    for (const c of cases) {
      await expect(codes.store(request(c))).rejects.toThrow(UNSUPPORTED);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts boundary values, the default server/subject and the version-4 variant set', async () => {
    for (const variant of ['8', '9', 'a', 'b']) {
      const f = fixture(happy());
      await f.codes.store(request({ code: `123e4567-e89b-42d3-${variant}456-426614174000` }));
    }
    const f = fixture(happy());
    await f.codes.store(
      request({
        userId: 'u'.repeat(256),
        clientId: 'c'.repeat(256),
        codeChallenge: 'x'.repeat(256),
        authorizationServer: 'default',
        subjectType: 'end_user',
        ttlSeconds: 3600,
        maxCodesPerUser: 10_000,
      })
    );
    expect(inputs(f.send, 'Query')[0].Limit).toBe(10_000);
  });

  it('rejects oversized payloads', async () => {
    const { codes, send } = fixture(happy());
    await expect(codes.store(request({ scope: 'a'.repeat(64 * 1024) }))).rejects.toThrow(
      'aws_state_payload_too_large'
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('counts live codes with a bounded query and reserves the code in one transaction', async () => {
    const f = fixture(happy({ Query: () => ({ Count: 3 }) }));
    const result = await f.codes.store(request({ ttlSeconds: 30, maxCodesPerUser: 10 }));
    expect(result).toEqual({ success: true, expiresAt: 1_500_999 + 30_000 });
    const guardKey = f.table.key(T, 'CODE_USER', 'user-1', 'GUARD');
    expect(inputs(f.send, 'GetItem')[0].Key).toEqual(guardKey);
    expect(inputs(f.send, 'Query')[0]).toEqual({
      TableName: 'test-state',
      ConsistentRead: true,
      Select: 'COUNT',
      Limit: 10,
      KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :start AND :end',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: {
        ':pk': guardKey.pk,
        ':start': { S: `CODE#${String(1_500_999 + 1).padStart(16, '0')}#` },
        ':end': { S: 'CODE#9999999999999999#~' },
      },
    });
    const codeHash = hash(CODE);
    const expiresAt = 1_500_999 + 30_000;
    const items = inputs(f.send, 'TransactWriteItems')[0].TransactItems;
    expect(items).toHaveLength(3);
    expect(items[0].Put).toEqual({
      TableName: 'test-state',
      Item: { ...guardKey, revision: { S: expect.stringMatching(/^[0-9a-f-]{36}$/) } },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    const { code: _code, ...details } = request({ ttlSeconds: 30, maxCodesPerUser: 10 });
    expect(items[1].Put).toEqual({
      TableName: 'test-state',
      Item: {
        ...f.table.key(T, 'CODE', codeHash),
        payloadJson: { S: JSON.stringify(details) },
        createdAtMs: { N: '1500999' },
        expiresAtMs: { N: String(expiresAt) },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(items[2].Put).toEqual({
      TableName: 'test-state',
      Item: {
        pk: guardKey.pk,
        sk: { S: `CODE#${String(expiresAt).padStart(16, '0')}#${codeHash}` },
        ttl: { N: String(Math.ceil(expiresAt / 1000)) },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('uses defaults of 60 seconds and 100 codes for non-positive or non-integer values', async () => {
    for (const bad of [0, -3, 1.5, Number.NaN, '5']) {
      const f = fixture(happy());
      const result = await f.codes.store(request({ ttlSeconds: bad, maxCodesPerUser: bad }));
      expect(result.expiresAt).toBe(1_500_999 + 60_000);
      expect(inputs(f.send, 'Query')[0].Limit).toBe(100);
    }
  });

  it('guards an existing user record by its revision', async () => {
    const f = fixture(happy({ GetItem: () => ({ Item: { revision: { S: 'old-rev' } } }) }));
    await f.codes.store(request());
    const put = inputs(f.send, 'TransactWriteItems')[0].TransactItems[0].Put;
    expect(put.ConditionExpression).toBe('revision = :old');
    expect(put.ExpressionAttributeValues).toEqual({ ':old': { S: 'old-rev' } });
    const fresh = fixture(happy());
    await fresh.codes.store(request());
    expect(
      'ExpressionAttributeValues' in
        inputs(fresh.send, 'TransactWriteItems')[0].TransactItems[0].Put
    ).toBe(false);
  });

  it('pages the count query and refuses when the budget is reached', async () => {
    const pages = [
      { Count: 2, LastEvaluatedKey: { pk: { S: 'a' } } },
      { Count: 1, LastEvaluatedKey: {} },
    ];
    const f = fixture(happy({ Query: () => pages.shift() }));
    await f.codes.store(request({ maxCodesPerUser: 10 }));
    const queries = inputs(f.send, 'Query');
    expect(queries).toHaveLength(2);
    expect(queries[0].Limit).toBe(10);
    expect('ExclusiveStartKey' in queries[0]).toBe(false);
    expect(queries[1].Limit).toBe(8);
    expect(queries[1].ExclusiveStartKey).toEqual({ pk: { S: 'a' } });

    const exact = fixture(happy({ Query: () => ({ Count: 2 }) }));
    await expect(exact.codes.store(request({ maxCodesPerUser: 2 }))).rejects.toThrow(
      'aws_authorization_code_unavailable'
    );
    expect(inputs(exact.send, 'TransactWriteItems')).toHaveLength(0);
    const below = fixture(happy({ Query: () => ({ Count: 1 }) }));
    await below.codes.store(request({ maxCodesPerUser: 2 }));
  });

  it('rejects invalid query counts', async () => {
    for (const page of [{}, { Count: -1 }, { Count: 1.5 }, { Count: '1' }]) {
      const f = fixture(happy({ Query: () => page }));
      await expect(f.codes.store(request())).rejects.toThrow('aws_state_query_invalid');
    }
    const zero = fixture(happy({ Query: () => ({ Count: 0 }) }));
    await zero.codes.store(request());
  });

  it('fails when the code would already be expired after counting', async () => {
    let calls = 0;
    const f = fixture(happy(), () => (++calls <= 1 ? 1_000 : 1_000 + 60_000));
    await expect(f.codes.store(request())).rejects.toThrow('aws_authorization_code_expiry_invalid');
    let ok = 0;
    const edge = fixture(happy(), () => (++ok <= 1 ? 1_000 : 1_000 + 59_999));
    expect((await edge.codes.store(request())).expiresAt).toBe(61_000);
  });

  it('reports reused codes, retries lost guard races and rethrows other failures', async () => {
    const reused = fixture(
      happy({
        TransactWriteItems: throws(canceled),
        GetItem: (i) => ({ Item: i.Key.pk.S.includes('#CODE#') ? { x: { S: '1' } } : undefined }),
      })
    );
    await expect(reused.codes.store(request())).rejects.toThrow(
      'aws_authorization_code_unavailable'
    );
    expect(inputs(reused.send, 'TransactWriteItems')).toHaveLength(1);
    const racing = fixture(happy({ TransactWriteItems: throws(canceled) }));
    await expect(racing.codes.store(request())).rejects.toThrow('aws_state_contention');
    expect(inputs(racing.send, 'TransactWriteItems')).toHaveLength(32);
    await expect(
      fixture(happy({ TransactWriteItems: throws(other) })).codes.store(request())
    ).rejects.toBe(other);
  });
});

describe('DynamoPersistentNameIDRegistry', () => {
  const key = 'saml:persistent-nameid:tenant:tenant-a:sp:sp:subject:subject';
  const record = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 1,
      tenantId: T,
      spEntityId: 'sp',
      subjectId: 'subject',
      nameId: 'name',
      createdAt: 5,
      ...over,
    });
  const invalid = 'aws_persistent_nameid_invalid';

  it('get returns the validated stored value or null', async () => {
    const f = fixture({ GetItem: () => ({ Item: { valueJson: { S: record() } } }) });
    expect(await f.nameIds.get({ tenantId: T, key })).toBe(record());
    expect(inputs(f.send, 'GetItem')[0].Key).toEqual(f.table.key(T, 'NAMEID', key));
    expect(await fixture({ GetItem: () => ({}) }).nameIds.get({ tenantId: T, key })).toBeNull();
    await expect(fixture().nameIds.get({ tenantId: 'tenant-b', key })).rejects.toThrow(invalid);
    await expect(
      fixture({ GetItem: () => ({ Item: { other: { S: 'x' } } }) }).nameIds.get({
        tenantId: T,
        key,
      })
    ).rejects.toThrow('aws_state_record_invalid');
    await expect(
      fixture({
        GetItem: () => ({ Item: { valueJson: { S: record({ tenantId: 'x' }) } } }),
      }).nameIds.get({ tenantId: T, key })
    ).rejects.toThrow(invalid);
  });

  it('put stores once keyed by a createdAt-independent semantic hash', async () => {
    const f = fixture({ UpdateItem: () => ({}) });
    await f.nameIds.put({ tenantId: T, key, value: record() });
    const semantic = hash(
      canonicalDynamoStateJson({
        version: 1,
        tenantId: T,
        spEntityId: 'sp',
        subjectId: 'subject',
        nameId: 'name',
      })
    );
    expect(inputs(f.send, 'UpdateItem')[0]).toEqual({
      TableName: 'test-state',
      Key: f.table.key(T, 'NAMEID', key),
      UpdateExpression: 'SET valueJson = if_not_exists(valueJson, :value), semanticHash = :hash',
      ConditionExpression: 'attribute_not_exists(pk) OR semanticHash = :hash',
      ExpressionAttributeValues: { ':value': { S: record() }, ':hash': { S: semantic } },
    });
  });

  it('put rejects mismatched tenants/records, maps conflicts and rethrows others', async () => {
    const value = record();
    await expect(fixture().nameIds.put({ tenantId: 'tenant-b', key, value })).rejects.toThrow(
      invalid
    );
    await expect(
      fixture().nameIds.put({ tenantId: T, key, value: record({ nameId: '' }) })
    ).rejects.toThrow(invalid);
    await expect(
      fixture({ UpdateItem: throws(conditional) }).nameIds.put({ tenantId: T, key, value })
    ).rejects.toThrow('aws_persistent_nameid_conflict');
    await expect(
      fixture({ UpdateItem: throws(other) }).nameIds.put({ tenantId: T, key, value })
    ).rejects.toBe(other);
  });
});
