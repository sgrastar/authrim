/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- fake DynamoDB/Postgres command inputs are intentionally untyped */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createDynamoStateClient,
  DynamoStateTable,
  DynamoTransientStateStore,
} from './dynamodb-state';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
type Handler = (input: any) => any;

function fixture(handlers: Record<string, Handler> = {}, now = 1000) {
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
    now: () => now,
  });
  return { send, table, store: new DynamoTransientStateStore(table) };
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
const keyOf = (kind: string, id: string) => ({
  pk: { S: `generation-one#T#${hash(T)}#${kind}#${hash(id)}` },
  sk: { S: 'STATE' },
});
const accountItem = (extra: Record<string, unknown> = {}) => ({
  lifecycle: { S: 'active' },
  lifecycleVersionMs: { N: '1' },
  revision: { S: 'rev-1' },
  ...extra,
});
const sessionItem = (
  over: Record<string, unknown> = {},
  payload: unknown = { userId: 'user-1' }
) => ({
  ...keyOf('SESSION', 's1'),
  payloadJson: { S: JSON.stringify(payload) },
  createdAtMs: { N: '900' },
  expiresAtMs: { N: '5000' },
  revocationBoundAtMs: { N: '950' },
  ...over,
});

describe('DynamoTransientStateStore sessions', () => {
  const base = { tenantId: T, sessionId: 's1', userId: 'user-1', ttlMs: 4000 };

  it('validates IDs and TTL before any I/O with exact messages', async () => {
    const { store, send } = fixture();
    await expect(store.createSession({ ...base, userId: '' })).rejects.toThrow('Invalid user ID');
    await expect(store.createSession({ ...base, ttlMs: 0 })).rejects.toThrow(
      'Invalid transient state TTL'
    );
    await expect(
      store.createSession({ ...base, ttlMs: 30 * 24 * 60 * 60 * 1000 + 1 })
    ).rejects.toThrow('Invalid transient state TTL');
    await expect(store.createSession({ ...base, sessionId: '' })).rejects.toThrow(
      'Invalid SESSION ID'
    );
    await expect(store.createSession({ ...base, sessionId: 'a'.repeat(1025) })).rejects.toThrow(
      'Invalid SESSION ID'
    );
    await expect(store.createSession({ ...base, sessionId: 'a\u001fb' })).rejects.toThrow(
      'Invalid SESSION ID'
    );
    await expect(store.createSession({ ...base, sessionId: 'a\u007fb' })).rejects.toThrow(
      'Invalid SESSION ID'
    );
    await expect(store.createSession({ ...base, sessionId: 5 as never })).rejects.toThrow(
      'Invalid SESSION ID'
    );
    await expect(store.createSession({ ...base, userId: 'a'.repeat(1025) })).rejects.toThrow(
      'Invalid user ID'
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts a session ID of exactly 1024 characters containing a space and tilde', async () => {
    const { store } = fixture({
      GetItem: () => ({ Item: accountItem() }),
      TransactWriteItems: () => ({}),
    });
    const id = `a b~${'x'.repeat(1020)}`;
    const session = await store.createSession({
      ...base,
      sessionId: id,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(session.sessionId).toBe(id);
    expect(session.expiresAt).toBe(1000 + 30 * 24 * 60 * 60 * 1000);
  });

  it('writes the session with a guarded account revision and the revocation bound', async () => {
    const { store, send } = fixture({
      GetItem: () => ({ Item: accountItem({ revokedAfterMs: { N: '4000' } }) }),
      TransactWriteItems: () => ({}),
    });
    const session = await store.createSession({ ...base, data: { a: 1 } });
    expect(session).toEqual({
      tenantId: T,
      sessionId: 's1',
      userId: 'user-1',
      createdAt: 1000,
      expiresAt: 5000,
      revocationBoundAtMs: 4001,
      data: { a: 1 },
    });
    const [tx] = inputs(send, 'TransactWriteItems');
    expect(tx.TransactItems[0]).toEqual({
      ConditionCheck: {
        TableName: 'test-state',
        Key: {
          pk: { S: `generation-one#T#${hash(T)}#ACCOUNT#${hash('user-1')}` },
          sk: { S: 'STATE' },
        },
        ConditionExpression: 'lifecycle = :active AND revision = :revision',
        ExpressionAttributeValues: { ':active': { S: 'active' }, ':revision': { S: 'rev-1' } },
      },
    });
    expect(tx.TransactItems[1]).toEqual({
      Put: {
        TableName: 'test-state',
        Item: {
          ...keyOf('SESSION', 's1'),
          payloadJson: { S: '{"userId":"user-1","data":{"a":1}}' },
          createdAtMs: { N: '1000' },
          expiresAtMs: { N: '5000' },
          ttl: { N: '5' },
          revocationBoundAtMs: { N: '4001' },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    });
  });

  it('uses now as the bound when it exceeds revokedAfter + 1 and omits absent data', async () => {
    const { store, send } = fixture({
      GetItem: () => ({ Item: accountItem({ revokedAfterMs: { N: '10' } }) }),
      TransactWriteItems: () => ({}),
    });
    const session = await store.createSession(base);
    expect(session.revocationBoundAtMs).toBe(1000);
    expect('data' in session).toBe(false);
    expect(inputs(send, 'TransactWriteItems')[0].TransactItems[1].Put.Item.payloadJson.S).toBe(
      '{"userId":"user-1"}'
    );
    const zero = fixture({
      GetItem: () => ({ Item: accountItem({ revokedAfterMs: { N: '0' } }) }),
      TransactWriteItems: () => ({}),
    });
    expect((await zero.store.createSession(base)).revocationBoundAtMs).toBe(1000);
  });

  it('refuses missing or inactive accounts', async () => {
    for (const item of [undefined, accountItem({ lifecycle: { S: 'suspended' } })]) {
      const { store, send } = fixture({ GetItem: () => ({ Item: item }) });
      await expect(store.createSession(base)).rejects.toThrow(
        'Session unavailable or ID already exists'
      );
      expect(inputs(send, 'TransactWriteItems')).toHaveLength(0);
    }
  });

  it('reports an existing session ID, retries lost races, and gives up after 32 attempts', async () => {
    const exists = fixture({
      GetItem: (i) => ({ Item: i.Key.pk.S.includes('#SESSION#') ? sessionItem() : accountItem() }),
      TransactWriteItems: () => {
        throw canceled;
      },
    });
    await expect(exists.store.createSession(base)).rejects.toThrow(
      'Session unavailable or ID already exists'
    );
    expect(inputs(exists.send, 'TransactWriteItems')).toHaveLength(1);

    const racing = fixture({
      GetItem: (i) => ({ Item: i.Key.pk.S.includes('#SESSION#') ? undefined : accountItem() }),
      TransactWriteItems: () => {
        throw canceled;
      },
    });
    await expect(racing.store.createSession(base)).rejects.toThrow('aws_state_contention');
    expect(inputs(racing.send, 'TransactWriteItems')).toHaveLength(32);

    const other = Object.assign(new Error('o'), { name: 'ThrottlingException' });
    const failing = fixture({
      GetItem: () => ({ Item: accountItem() }),
      TransactWriteItems: () => {
        throw other;
      },
    });
    await expect(failing.store.createSession(base)).rejects.toBe(other);
  });

  describe('getSession', () => {
    const tx = (item: unknown, account: unknown) => () => ({
      Responses: [{ Item: item }, { Item: account }],
    });
    const run = async (handlers: Record<string, Handler>) =>
      fixture(handlers).store.getSession({ tenantId: T, sessionId: 's1' });

    it('returns null for absent or expired/consumed sessions without a transaction', async () => {
      for (const item of [
        undefined,
        sessionItem({ expiresAtMs: { N: '1000' } }),
        sessionItem({ consumedAtMs: { N: '1' } }),
      ]) {
        const f = fixture({ GetItem: () => ({ Item: item }) });
        expect(await f.store.getSession({ tenantId: T, sessionId: 's1' })).toBeNull();
        expect(inputs(f.send, 'TransactGetItems')).toHaveLength(0);
      }
    });

    it('reads session and account in one transaction and returns the session', async () => {
      const f = fixture({
        GetItem: () => ({ Item: sessionItem({}, { userId: 'user-1', data: { k: 'v' } }) }),
        TransactGetItems: tx(
          sessionItem({}, { userId: 'user-1', data: { k: 'v' } }),
          accountItem()
        ),
      });
      const session = await f.store.getSession({ tenantId: T, sessionId: 's1' });
      expect(session).toEqual({
        tenantId: T,
        sessionId: 's1',
        userId: 'user-1',
        createdAt: 900,
        expiresAt: 5000,
        revocationBoundAtMs: 950,
        data: { k: 'v' },
      });
      expect(inputs(f.send, 'TransactGetItems')[0]).toEqual({
        TransactItems: [
          { Get: { TableName: 'test-state', Key: keyOf('SESSION', 's1') } },
          {
            Get: {
              TableName: 'test-state',
              Key: {
                pk: { S: `generation-one#T#${hash(T)}#ACCOUNT#${hash('user-1')}` },
                sk: { S: 'STATE' },
              },
            },
          },
        ],
      });
    });

    it('rejects sessions revoked at or after their bound, accepting only a strictly later bound', async () => {
      const found = () => ({ Item: sessionItem() });
      expect(
        await run({
          GetItem: found,
          TransactGetItems: tx(sessionItem(), accountItem({ revokedAfterMs: { N: '950' } })),
        })
      ).toBeNull();
      expect(
        await run({
          GetItem: found,
          TransactGetItems: tx(sessionItem(), accountItem({ revokedAfterMs: { N: '949' } })),
        })
      ).toMatchObject({ revocationBoundAtMs: 950 });
      expect(
        await run({
          GetItem: found,
          TransactGetItems: tx(sessionItem({ revocationBoundAtMs: { N: '0' } }), accountItem()),
        })
      ).toBeNull();
      expect(
        await run({
          GetItem: found,
          TransactGetItems: tx(sessionItem({ revocationBoundAtMs: { N: '1' } }), accountItem()),
        })
      ).toMatchObject({ revocationBoundAtMs: 1 });
    });

    it('returns null when the snapshot shows an inactive account, missing/changed session', async () => {
      const found = () => ({ Item: sessionItem() });
      expect(
        await run({
          GetItem: found,
          TransactGetItems: tx(sessionItem(), accountItem({ lifecycle: { S: 'locked' } })),
        })
      ).toBeNull();
      expect(
        await run({ GetItem: found, TransactGetItems: tx(sessionItem(), undefined) })
      ).toBeNull();
      expect(
        await run({ GetItem: found, TransactGetItems: tx(undefined, accountItem()) })
      ).toBeNull();
      expect(
        await run({
          GetItem: found,
          TransactGetItems: tx(sessionItem({ consumedAtMs: { N: '1' } }), accountItem()),
        })
      ).toBeNull();
      expect(await run({ GetItem: found, TransactGetItems: () => ({}) })).toBeNull();
      expect(
        await run({
          GetItem: found,
          TransactGetItems: tx(sessionItem({}, { userId: 'user-2' }), accountItem()),
        })
      ).toBeNull();
    });

    it('fails on malformed stored sessions', async () => {
      for (const payload of [
        { userId: '' },
        { userId: 5 },
        {},
        { userId: 'u', data: 'x' },
        { userId: 'u', data: null },
      ]) {
        await expect(run({ GetItem: () => ({ Item: sessionItem({}, payload) }) })).rejects.toThrow(
          'userId' in payload && typeof payload.userId === 'string' && payload.userId
            ? 'aws_state_record_invalid'
            : 'Session storage binding invalid'
        );
      }
      for (const raw of ['[]', '"s"', 'null']) {
        await expect(
          run({ GetItem: () => ({ Item: { ...sessionItem(), payloadJson: { S: raw } } }) })
        ).rejects.toThrow('aws_state_record_invalid');
      }
      const noPayload = sessionItem();
      delete (noPayload as Record<string, unknown>).payloadJson;
      await expect(run({ GetItem: () => ({ Item: noPayload }) })).rejects.toThrow(
        'aws_state_record_invalid'
      );
      await expect(
        run({ GetItem: () => ({ Item: sessionItem({ revocationBoundAtMs: undefined }) }) })
      ).rejects.toThrow('aws_state_record_invalid');
    });
  });

  it('deleteSession marks the session consumed without a liveness requirement', async () => {
    const f = fixture({ UpdateItem: () => ({ Attributes: sessionItem() }) });
    expect(await f.store.deleteSession({ tenantId: T, sessionId: 's1' })).toBe(true);
    const [update] = inputs(f.send, 'UpdateItem');
    expect(update.Key).toEqual(keyOf('SESSION', 's1'));
    expect(update.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_not_exists(consumedAtMs)'
    );
    const gone = fixture({
      UpdateItem: () => {
        throw conditional;
      },
    });
    expect(await gone.store.deleteSession({ tenantId: T, sessionId: 's1' })).toBe(false);
    await expect(gone.store.deleteSession({ tenantId: T, sessionId: '' })).rejects.toThrow(
      'Invalid SESSION ID'
    );
  });
});
