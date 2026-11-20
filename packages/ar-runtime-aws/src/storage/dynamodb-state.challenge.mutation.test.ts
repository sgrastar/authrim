/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- fake DynamoDB/Postgres command inputs are intentionally untyped */
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
  return { send, store: new DynamoTransientStateStore(table) };
}
const inputs = (send: ReturnType<typeof vi.fn>, name: string): any[] =>
  send.mock.calls
    .map((c) => c[0] as { constructor: { name: string }; input: unknown })
    .filter((c) => c.constructor.name === `${name}Command`)
    .map((c) => c.input);
const T = 'tenant-a';
const conditional = Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
const keyOf = (id: string) => ({
  pk: { S: `generation-one#T#${hash(T)}#CHALLENGE#${hash(id)}` },
  sk: { S: 'STATE' },
});
const base = {
  tenantId: T,
  id: 'ch1',
  type: 'passkey',
  userId: 'user-1',
  challenge: 'secret',
  ttlMs: 500,
};
function challengeItem(over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  const p = { type: 'passkey', userId: 'user-1', challenge: 'secret', ...payload };
  return {
    ...keyOf('ch1'),
    payloadJson: { S: JSON.stringify(p) },
    createdAtMs: { N: '900' },
    expiresAtMs: { N: '5000' },
    itemId: { S: 'ch1' },
    challengeType: { S: 'passkey' },
    challengeHash: { S: hash('secret') },
    ...over,
  };
}

describe('storeChallenge', () => {
  it('validates each field with its own message and limit', async () => {
    const { store, send } = fixture();
    const bad = (o: Record<string, unknown>, msg: string) =>
      expect(store.storeChallenge({ ...base, ...o })).rejects.toThrow(msg);
    await bad({ id: '' }, 'Invalid CHALLENGE ID');
    await bad({ type: '' }, 'Invalid challenge type');
    await bad({ type: 'a'.repeat(129) }, 'Invalid challenge type');
    await bad({ userId: '' }, 'Invalid user ID');
    await bad({ challenge: '' }, 'Invalid challenge value');
    await bad({ challenge: 'a'.repeat(4097) }, 'Invalid challenge value');
    await bad({ ttlMs: 0 }, 'Invalid transient state TTL');
    await bad({ notAfterMs: 0 }, 'Invalid challenge deadline');
    await bad({ notAfterMs: 1.5 }, 'Invalid challenge deadline');
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts boundary-sized values', async () => {
    const { store } = fixture({ PutItem: () => ({}) });
    expect(
      await store.storeChallenge({
        ...base,
        type: 'a'.repeat(128),
        challenge: 'c'.repeat(4096),
        ttlMs: 30 * 24 * 60 * 60 * 1000,
      })
    ).toBe(true);
    expect(await store.storeChallenge({ ...base, notAfterMs: 1001 })).toBe(true);
  });

  it('puts the item with bound hash attributes and the reuse condition', async () => {
    const { store, send } = fixture({ PutItem: () => ({}) });
    expect(
      await store.storeChallenge({
        ...base,
        email: 'a@example.test',
        redirectUri: 'https://x.example.test/cb',
        metadata: { m: 1 },
      })
    ).toBe(true);
    const [put] = inputs(send, 'PutItem');
    expect(put).toEqual({
      TableName: 'test-state',
      Item: {
        ...keyOf('ch1'),
        payloadJson: {
          S: JSON.stringify({
            type: 'passkey',
            userId: 'user-1',
            challenge: 'secret',
            email: 'a@example.test',
            redirectUri: 'https://x.example.test/cb',
            metadata: { m: 1 },
          }),
        },
        createdAtMs: { N: '1000' },
        expiresAtMs: { N: '1500' },
        ttl: { N: '2' },
        itemId: { S: 'ch1' },
        challengeType: { S: 'passkey' },
        challengeHash: { S: hash('secret') },
      },
      ConditionExpression:
        'attribute_not_exists(pk) OR attribute_exists(consumedAtMs) OR expiresAtMs <= :now',
      ExpressionAttributeValues: { ':now': { N: '1000' } },
    });
  });

  it('omits empty optional payload fields', async () => {
    const { store, send } = fixture({ PutItem: () => ({}) });
    await store.storeChallenge({ ...base, email: '', redirectUri: '' });
    expect(inputs(send, 'PutItem')[0].Item.payloadJson.S).toBe(
      '{"type":"passkey","userId":"user-1","challenge":"secret"}'
    );
  });

  it('caps expiry at notAfterMs and refuses a deadline that is not in the future', async () => {
    const f = fixture({ PutItem: () => ({}) });
    expect(await f.store.storeChallenge({ ...base, notAfterMs: 1200 })).toBe(true);
    expect(inputs(f.send, 'PutItem')[0].Item.expiresAtMs).toEqual({ N: '1200' });
    for (const notAfterMs of [1000, 999]) {
      const g = fixture({ PutItem: () => ({}) });
      expect(await g.store.storeChallenge({ ...base, notAfterMs })).toBe(false);
      expect(g.send).not.toHaveBeenCalled();
    }
    const h = fixture({ PutItem: () => ({}) });
    await h.store.storeChallenge({ ...base, notAfterMs: 99_999 });
    expect(inputs(h.send, 'PutItem')[0].Item.expiresAtMs).toEqual({ N: '1500' });
  });

  it('returns false for a live duplicate and rethrows other failures; claim delegates', async () => {
    const dup = fixture({
      PutItem: () => {
        throw conditional;
      },
    });
    expect(await dup.store.storeChallenge(base)).toBe(false);
    expect(await dup.store.claimChallenge(base)).toBe(false);
    const other = Object.assign(new Error('o'), { name: 'ThrottlingException' });
    await expect(
      fixture({
        PutItem: () => {
          throw other;
        },
      }).store.claimChallenge(base)
    ).rejects.toBe(other);
    const ok = fixture({ PutItem: () => ({}) });
    expect(await ok.store.claimChallenge(base)).toBe(true);
    expect(inputs(ok.send, 'PutItem')).toHaveLength(1);
  });
});

describe('consumeChallenge', () => {
  const ref = { tenantId: T, id: 'ch1', type: 'passkey' };
  it('validates inputs', async () => {
    const { store, send } = fixture();
    await expect(store.consumeChallenge({ ...ref, type: '' })).rejects.toThrow(
      'Invalid challenge type'
    );
    await expect(store.consumeChallenge({ ...ref, type: 't'.repeat(129) })).rejects.toThrow(
      'Invalid challenge type'
    );
    await expect(store.consumeChallenge({ ...ref, challenge: '' })).rejects.toThrow(
      'Invalid challenge value'
    );
    await expect(store.consumeChallenge({ ...ref, challenge: 'c'.repeat(4097) })).rejects.toThrow(
      'Invalid challenge value'
    );
    await expect(store.consumeChallenge({ ...ref, operationId: '' })).rejects.toThrow(
      'Invalid challenge operation ID'
    );
    await expect(store.consumeChallenge({ ...ref, operationId: 'o'.repeat(257) })).rejects.toThrow(
      'Invalid challenge operation ID'
    );
    await expect(store.consumeChallenge({ ...ref, id: '' })).rejects.toThrow(
      'Invalid CHALLENGE ID'
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('binds only the type by default', async () => {
    const f = fixture({ UpdateItem: () => ({ Attributes: challengeItem() }) });
    const result = await f.store.consumeChallenge(ref);
    expect(result).toEqual({
      tenantId: T,
      id: 'ch1',
      type: 'passkey',
      userId: 'user-1',
      challenge: 'secret',
      createdAt: 900,
      expiresAt: 5000,
    });
    const [update] = inputs(f.send, 'UpdateItem');
    expect(update.UpdateExpression).toBe('SET consumedAtMs = :now');
    expect(update.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_not_exists(consumedAtMs) AND expiresAtMs > :now AND challengeType = :type'
    );
    expect(update.ExpressionAttributeValues).toEqual({
      ':now': { N: '1000' },
      ':type': { S: 'passkey' },
    });
  });

  it('adds the challenge hash and operation id when provided and returns the optional fields', async () => {
    const f = fixture({
      UpdateItem: () => ({
        Attributes: challengeItem(
          {},
          { email: 'a@example.test', redirectUri: 'https://r.example.test', metadata: { k: 1 } }
        ),
      }),
    });
    const result = await f.store.consumeChallenge({
      ...ref,
      challenge: 'secret',
      operationId: 'op-1',
    });
    expect(result).toMatchObject({
      email: 'a@example.test',
      redirectUri: 'https://r.example.test',
      metadata: { k: 1 },
    });
    const [update] = inputs(f.send, 'UpdateItem');
    expect(update.UpdateExpression).toBe('SET consumedAtMs = :now, consumedBy = :operation');
    expect(update.ConditionExpression).toContain('challengeType = :type AND challengeHash = :hash');
    expect(update.ExpressionAttributeValues).toEqual({
      ':now': { N: '1000' },
      ':type': { S: 'passkey' },
      ':hash': { S: hash('secret') },
      ':operation': { S: 'op-1' },
    });
  });

  it('returns null when nothing was consumed', async () => {
    const f = fixture({
      UpdateItem: () => {
        throw conditional;
      },
    });
    expect(await f.store.consumeChallenge(ref)).toBeNull();
  });

  it('rejects consumed rows whose stored binding does not match', async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{}, { type: 5 }],
      [{}, { userId: 5 }],
      [{}, { challenge: 5 }],
      [{ itemId: { S: 'other' } }, {}],
      [{ challengeType: { S: 'other' } }, {}],
      [{ challengeHash: { S: 'bad' } }, {}],
    ];
    for (const [over, payload] of cases) {
      const f = fixture({ UpdateItem: () => ({ Attributes: challengeItem(over, payload) }) });
      await expect(f.store.consumeChallenge(ref)).rejects.toThrow(
        'Challenge storage binding invalid'
      );
    }
    const f = fixture({
      UpdateItem: () => ({ Attributes: challengeItem({}, { metadata: 'x' }) }),
    });
    await expect(f.store.consumeChallenge(ref)).rejects.toThrow('aws_state_record_invalid');
    const g = fixture({
      UpdateItem: () => ({ Attributes: challengeItem({}, { email: 5, redirectUri: 5 }) }),
    });
    const out = await g.store.consumeChallenge(ref);
    expect(out && 'email' in out).toBe(false);
    expect(out && 'redirectUri' in out).toBe(false);
  });
});

describe('getChallenge / getConsumedChallenge / isChallengeClaimHeld / deleteChallenge', () => {
  const ref = { tenantId: T, id: 'ch1' };
  it('getChallenge returns only live items', async () => {
    expect(
      await fixture({ GetItem: () => ({ Item: challengeItem() }) }).store.getChallenge(ref)
    ).toMatchObject({ id: 'ch1', challenge: 'secret' });
    for (const item of [
      undefined,
      challengeItem({ expiresAtMs: { N: '1000' } }),
      challengeItem({ consumedAtMs: { N: '1' } }),
    ]) {
      expect(await fixture({ GetItem: () => ({ Item: item }) }).store.getChallenge(ref)).toBeNull();
    }
    await expect(fixture().store.getChallenge({ ...ref, id: '' })).rejects.toThrow(
      'Invalid CHALLENGE ID'
    );
  });

  it('getConsumedChallenge requires a consumed, unexpired item with a non-empty consumedBy', async () => {
    const consumed = (over: Record<string, unknown> = {}) =>
      challengeItem({ consumedAtMs: { N: '950' }, consumedBy: { S: 'op-1' }, ...over });
    const get = (item: unknown) =>
      fixture({ GetItem: () => ({ Item: item }) }).store.getConsumedChallenge(ref);
    expect(await get(consumed())).toMatchObject({ id: 'ch1', consumedBy: 'op-1' });
    expect(await get(undefined)).toBeNull();
    expect(await get(challengeItem({ consumedBy: { S: 'op-1' } }))).toBeNull();
    expect(await get(consumed({ expiresAtMs: { N: '1000' } }))).toBeNull();
    expect(await get(consumed({ expiresAtMs: { N: '999' } }))).toBeNull();
    expect(await get(consumed({ expiresAtMs: { N: '1001' } }))).not.toBeNull();
    expect(await get(consumed({ consumedBy: undefined }))).toBeNull();
    expect(await get(consumed({ consumedBy: { S: '' } }))).toBeNull();
    expect(await get(consumed({ consumedBy: { N: '5' } }))).toBeNull();
    await expect(fixture().store.getConsumedChallenge({ ...ref, id: '' })).rejects.toThrow(
      'Invalid CHALLENGE ID'
    );
  });

  it('isChallengeClaimHeld validates and compares challenge and remaining lifetime', async () => {
    const held = (extra: Record<string, unknown> = {}, item: unknown = challengeItem()) =>
      fixture({ GetItem: () => ({ Item: item ?? undefined }) }).store.isChallengeClaimHeld({
        ...ref,
        challenge: 'secret',
        minRemainingMs: 0,
        ...extra,
      });
    expect(await held()).toBe(true);
    expect(await held({ challenge: 'other' })).toBe(false);
    expect(await held({}, null)).toBe(false);
    expect(await held({ minRemainingMs: 4000 })).toBe(true);
    expect(await held({ minRemainingMs: 4001 })).toBe(false);
    await expect(held({ challenge: '' })).rejects.toThrow('Invalid challenge value');
    await expect(held({ challenge: 'c'.repeat(4097) })).rejects.toThrow('Invalid challenge value');
    await expect(held({ minRemainingMs: -1 })).rejects.toThrow(
      'Invalid minimum remaining lifetime'
    );
    await expect(held({ minRemainingMs: 1.5 })).rejects.toThrow(
      'Invalid minimum remaining lifetime'
    );
  });

  it('deleteChallenge consumes without a liveness requirement', async () => {
    const f = fixture({ UpdateItem: () => ({ Attributes: challengeItem() }) });
    expect(await f.store.deleteChallenge(ref)).toBe(true);
    const [update] = inputs(f.send, 'UpdateItem');
    expect(update.Key).toEqual(keyOf('ch1'));
    expect(update.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_not_exists(consumedAtMs)'
    );
    expect(
      await fixture({
        UpdateItem: () => {
          throw conditional;
        },
      }).store.deleteChallenge(ref)
    ).toBe(false);
    await expect(fixture().store.deleteChallenge({ ...ref, id: '' })).rejects.toThrow(
      'Invalid CHALLENGE ID'
    );
  });
});
