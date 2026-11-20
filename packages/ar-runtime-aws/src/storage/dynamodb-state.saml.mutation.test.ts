/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- fake DynamoDB/Postgres command inputs are intentionally untyped */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalDynamoStateJson,
  createDynamoStateClient,
  DynamoStateTable,
  DynamoTransientStateStore,
} from './dynamodb-state';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
type Handler = (input: any) => any;

function fixture(handlers: Record<string, Handler> = {}, now = 1_000_000) {
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
const SP = 'https://sp.example.test';
const NOW = 1_000_000;
const conditional = Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
const keyOf = (kind: string, id: string) => ({
  pk: { S: `generation-one#T#${hash(T)}#${kind}#${hash(id)}` },
  sk: { S: 'STATE' },
});
const request = (over: Record<string, unknown> = {}) =>
  ({
    requestId: 'r1',
    issuer: SP,
    destination: 'https://idp.example.test/sso',
    type: 'authn_request',
    binding: 'redirect',
    expiresAt: NOW + 60_000,
    retainUntil: NOW + 120_000,
    ...over,
  }) as any;
const ref = { tenantId: T, spEntityId: SP, requestId: 'r1' };

function samlItem(
  over: Record<string, unknown> = {},
  p: Record<string, unknown> = {},
  req: Record<string, unknown> = {}
) {
  return {
    ...keyOf('SAML', 'r1'),
    payloadJson: {
      S: JSON.stringify({
        spEntityId: SP,
        request: { requestId: 'r1', issuer: SP, type: 'authn_request', ...req },
        ...p,
      }),
    },
    createdAtMs: { N: '900' },
    expiresAtMs: { N: String(NOW + 60_000) },
    revision: { N: '1' },
    spHash: { S: hash(SP) },
    ...over,
  };
}

describe('createSamlRequest', () => {
  it('validates identifiers, binding and timestamps with exact messages', async () => {
    const { store, send } = fixture();
    const bad = (input: any, msg: string) =>
      expect(store.createSamlRequest(input)).rejects.toThrow(msg);
    await bad({ tenantId: T, spEntityId: '', request: request() }, 'Invalid SP entity ID');
    await bad(
      { tenantId: T, spEntityId: 's'.repeat(4097), request: request() },
      'Invalid SP entity ID'
    );
    await bad(
      { tenantId: T, spEntityId: SP, request: request({ requestId: '' }) },
      'Invalid SAML ID'
    );
    await bad(
      { tenantId: T, spEntityId: SP, request: request({ type: 'logout' }) },
      'Invalid SAML request binding'
    );
    await bad(
      { tenantId: T, spEntityId: SP, request: request({ issuer: 'other' }) },
      'Invalid SAML request binding'
    );
    await bad(
      { tenantId: T, spEntityId: SP, request: request({ expiresAt: 0 }) },
      'Invalid SAML request expiry'
    );
    await bad(
      { tenantId: T, spEntityId: SP, request: request({ retainUntil: undefined }) },
      'Invalid SAML request retention'
    );
    await bad(
      { tenantId: T, spEntityId: SP, request: request({ retainUntil: 0 }) },
      'Invalid SAML request retention'
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('enforces the 30 minute expiry window and 60 minute retention window inclusively', async () => {
    const run = (o: Record<string, unknown>) =>
      fixture({ PutItem: () => ({}) }).store.createSamlRequest({
        tenantId: T,
        spEntityId: SP,
        request: request(o),
      });
    const expired = 'SAML request expired or binding conflict';
    await expect(run({ expiresAt: NOW, retainUntil: NOW + 10 })).rejects.toThrow(expired);
    await expect(run({ expiresAt: NOW - 1, retainUntil: NOW + 10 })).rejects.toThrow(expired);
    await expect(run({ expiresAt: NOW + 1_800_001, retainUntil: NOW + 1_800_001 })).rejects.toThrow(
      expired
    );
    expect(await run({ expiresAt: NOW + 1, retainUntil: NOW + 1 })).toBe(true);
    expect(await run({ expiresAt: NOW + 1_800_000, retainUntil: NOW + 1_800_000 })).toBe(true);
    const retention = 'Invalid SAML request retention';
    await expect(run({ expiresAt: NOW + 100, retainUntil: NOW + 99 })).rejects.toThrow(retention);
    await expect(run({ expiresAt: NOW + 100, retainUntil: NOW + 3_600_001 })).rejects.toThrow(
      retention
    );
    expect(await run({ expiresAt: NOW + 100, retainUntil: NOW + 3_600_000 })).toBe(true);
  });

  it('puts the request with immutable hash, SP hash and retention TTL', async () => {
    const { store, send } = fixture({ PutItem: () => ({}) });
    const req = request({
      acsUrl: 'https://sp.example.test/acs',
      relayState: 'rs',
      data: { z: 1, a: 2 },
    });
    expect(await store.createSamlRequest({ tenantId: T, spEntityId: SP, request: req })).toBe(true);
    const immutable = hash(
      canonicalDynamoStateJson({
        requestId: 'r1',
        issuer: SP,
        destination: 'https://idp.example.test/sso',
        acsUrl: 'https://sp.example.test/acs',
        binding: 'redirect',
        type: 'authn_request',
        relayState: 'rs',
        data: { a: 2, z: 1 },
      })
    );
    expect(inputs(send, 'PutItem')[0]).toEqual({
      TableName: 'test-state',
      Item: {
        ...keyOf('SAML', 'r1'),
        payloadJson: {
          S: JSON.stringify({ spEntityId: SP, request: { ...req, revision: 1, used: false } }),
        },
        createdAtMs: { N: String(NOW) },
        expiresAtMs: { N: String(NOW + 60_000) },
        ttl: { N: String(Math.ceil((NOW + 120_000) / 1000)) },
        retainUntilMs: { N: String(NOW + 120_000) },
        revision: { N: '1' },
        immutableHash: { S: immutable },
        spHash: { S: hash(SP) },
      },
      ConditionExpression: 'attribute_not_exists(pk) OR retainUntilMs <= :now',
      ExpressionAttributeValues: { ':now': { N: String(NOW) } },
    });
  });

  it('defaults absent optional fields to null in the immutable hash', async () => {
    const { store, send } = fixture({ PutItem: () => ({}) });
    await store.createSamlRequest({ tenantId: T, spEntityId: SP, request: request() });
    const immutable = hash(
      canonicalDynamoStateJson({
        requestId: 'r1',
        issuer: SP,
        destination: 'https://idp.example.test/sso',
        acsUrl: null,
        binding: 'redirect',
        type: 'authn_request',
        relayState: null,
        data: null,
      })
    );
    expect(inputs(send, 'PutItem')[0].Item.immutableHash).toEqual({ S: immutable });
  });

  it('returns false on conflict and rethrows other failures', async () => {
    const input = { tenantId: T, spEntityId: SP, request: request() };
    expect(
      await fixture({
        PutItem: () => {
          throw conditional;
        },
      }).store.createSamlRequest(input)
    ).toBe(false);
    const other = Object.assign(new Error('o'), { name: 'ThrottlingException' });
    await expect(
      fixture({
        PutItem: () => {
          throw other;
        },
      }).store.createSamlRequest(input)
    ).rejects.toBe(other);
  });
});

describe('readSamlRequest', () => {
  const read = (item: unknown, r = ref) =>
    fixture({ GetItem: () => ({ Item: item }) }).store.readSamlRequest(r);

  it('returns the waiting request bound to the SP with store metadata', async () => {
    expect(await read(samlItem({ revision: { N: '4' } }, {}, { extra: 'x' }))).toEqual({
      requestId: 'r1',
      issuer: SP,
      type: 'authn_request',
      extra: 'x',
      createdAt: 900,
      expiresAt: NOW + 60_000,
      revision: 4,
      used: false,
    });
  });

  it('returns null when absent, consumed, expired or bound to another SP', async () => {
    expect(await read(undefined)).toBeNull();
    expect(await read(samlItem({ consumedAtMs: { N: '1' } }))).toBeNull();
    expect(await read(samlItem({ expiresAtMs: { N: String(NOW) } }))).toBeNull();
    expect(await read(samlItem({ spHash: { S: hash('other') } }))).toBeNull();
    expect(await read(samlItem({ spHash: undefined }))).toBeNull();
  });

  it('validates the SP entity ID and request identifier', async () => {
    await expect(read(undefined, { ...ref, spEntityId: '' })).rejects.toThrow(
      'Invalid SP entity ID'
    );
    await expect(read(undefined, { ...ref, spEntityId: 's'.repeat(4097) })).rejects.toThrow(
      'Invalid SP entity ID'
    );
    await expect(read(undefined, { ...ref, requestId: '' })).rejects.toThrow('Invalid SAML ID');
  });

  it('fails when the stored binding differs from the lookup', async () => {
    const code = 'SAML request storage binding invalid';
    await expect(read(samlItem({}, { spEntityId: 'other' }))).rejects.toThrow(code);
    await expect(read(samlItem({}, {}, { requestId: 'other' }))).rejects.toThrow(code);
    await expect(read(samlItem({}, {}, { issuer: 'other' }))).rejects.toThrow(code);
    await expect(read(samlItem({}, {}, { type: 'logout_request' }))).rejects.toThrow(code);
    await expect(read(samlItem({}, { request: 'x' }))).rejects.toThrow('aws_state_record_invalid');
  });
});

describe('updateSamlRequest', () => {
  const update = (handlers: Record<string, Handler>, over: Record<string, unknown> = {}) => {
    const f = fixture(handlers);
    return {
      f,
      run: () =>
        f.store.updateSamlRequest({
          ...ref,
          expectedRevision: 1,
          context: { n: 1 } as any,
          ...over,
        }),
    };
  };

  it('validates the expected revision', async () => {
    for (const expectedRevision of [0, -1, 1.5]) {
      await expect(update({}, { expectedRevision }).run()).rejects.toThrow(
        'Invalid SAML request revision'
      );
    }
  });

  it('returns null for missing items and revision mismatches', async () => {
    expect(await update({ GetItem: () => ({}) }).run()).toBeNull();
    expect(
      await update({ GetItem: () => ({ Item: samlItem({ revision: { N: '2' } }) }) }).run()
    ).toBeNull();
  });

  it('writes the next revision with context and a fully conditioned update', async () => {
    const stored = samlItem({ revision: { N: '2' } }, {}, { context: { n: 1 }, revision: 2 });
    const { f, run } = update({
      GetItem: () => ({ Item: samlItem({}, {}, { keep: 'k' }) }),
      UpdateItem: () => ({ Attributes: stored }),
    });
    expect(await run()).toMatchObject({ revision: 2, used: false, requestId: 'r1' });
    expect(inputs(f.send, 'UpdateItem')[0]).toEqual({
      TableName: 'test-state',
      Key: keyOf('SAML', 'r1'),
      UpdateExpression: 'SET payloadJson = :payload, revision = :next',
      ConditionExpression:
        'attribute_exists(pk) AND attribute_not_exists(consumedAtMs) AND expiresAtMs > :now AND spHash = :sp AND revision = :rev',
      ExpressionAttributeValues: {
        ':payload': {
          S: JSON.stringify({
            spEntityId: SP,
            request: {
              requestId: 'r1',
              issuer: SP,
              type: 'authn_request',
              keep: 'k',
              context: { n: 1 },
              revision: 2,
            },
          }),
        },
        ':next': { N: '2' },
        ':rev': { N: '1' },
        ':sp': { S: hash(SP) },
        ':now': { N: String(NOW) },
      },
      ReturnValues: 'ALL_NEW',
    });
  });

  it('handles lost updates, missing receipts, expired results and other failures', async () => {
    const found = () => ({ Item: samlItem() });
    expect(
      await update({
        GetItem: found,
        UpdateItem: () => {
          throw conditional;
        },
      }).run()
    ).toBeNull();
    await expect(update({ GetItem: found, UpdateItem: () => ({}) }).run()).rejects.toThrow(
      'aws_state_consume_receipt_missing'
    );
    expect(
      await update({
        GetItem: found,
        UpdateItem: () => ({ Attributes: samlItem({ expiresAtMs: { N: String(NOW) } }) }),
      }).run()
    ).toBeNull();
    const other = Object.assign(new Error('o'), { name: 'ThrottlingException' });
    await expect(
      update({
        GetItem: found,
        UpdateItem: () => {
          throw other;
        },
      }).run()
    ).rejects.toBe(other);
  });
});

describe('completeSamlRequest', () => {
  const found = (over: Record<string, unknown> = {}, ctx: unknown = { loginNonceHash: 'h1' }) => ({
    Item: samlItem(over, {}, { context: ctx }),
  });
  const consumed = () => ({ Attributes: samlItem() });

  it('validates its inputs', async () => {
    const { store, send } = fixture();
    await expect(store.completeSamlRequest({ ...ref, spEntityId: '' })).rejects.toThrow(
      'Invalid SP entity ID'
    );
    await expect(store.completeSamlRequest({ ...ref, expectedRevision: 0 })).rejects.toThrow(
      'Invalid SAML request revision'
    );
    await expect(store.completeSamlRequest({ ...ref, loginNonceHash: '' })).rejects.toThrow(
      'Invalid SAML login nonce hash'
    );
    await expect(
      store.completeSamlRequest({ ...ref, loginNonceHash: 'h'.repeat(257) })
    ).rejects.toThrow('Invalid SAML login nonce hash');
    expect(send).not.toHaveBeenCalled();
  });

  it('consumes directly (no read) without a nonce hash, binding SP and optional revision', async () => {
    const f = fixture({ UpdateItem: consumed });
    expect(await f.store.completeSamlRequest(ref)).toMatchObject({ used: true, requestId: 'r1' });
    expect(inputs(f.send, 'GetItem')).toHaveLength(0);
    let [u] = inputs(f.send, 'UpdateItem');
    expect(u.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_not_exists(consumedAtMs) AND expiresAtMs > :now AND spHash = :sp'
    );
    expect(u.ExpressionAttributeValues).toEqual({
      ':now': { N: String(NOW) },
      ':sp': { S: hash(SP) },
    });
    await f.store.completeSamlRequest({ ...ref, expectedRevision: 3 });
    [, u] = inputs(f.send, 'UpdateItem');
    expect(u.ConditionExpression).toMatch(/ AND spHash = :sp AND revision = :rev$/);
    expect(u.ExpressionAttributeValues[':rev']).toEqual({ N: '3' });
  });

  it('with a nonce hash reads the waiting item and completes at the read revision', async () => {
    const f = fixture({
      GetItem: () => found({ revision: { N: '5' } }),
      UpdateItem: consumed,
    });
    expect(await f.store.completeSamlRequest({ ...ref, loginNonceHash: 'h1' })).toMatchObject({
      used: true,
    });
    expect(inputs(f.send, 'UpdateItem')[0].ExpressionAttributeValues[':rev']).toEqual({ N: '5' });
    const exact = fixture({ GetItem: () => found({ revision: { N: '5' } }), UpdateItem: consumed });
    expect(
      await exact.store.completeSamlRequest({ ...ref, loginNonceHash: 'h1', expectedRevision: 5 })
    ).not.toBeNull();
    expect(
      await exact.store.completeSamlRequest({ ...ref, loginNonceHash: 'h1', expectedRevision: 4 })
    ).toBeNull();
  });

  it('returns null when the item, context or hash does not match', async () => {
    const run = (handlers: Record<string, Handler>) =>
      fixture({ UpdateItem: consumed, ...handlers }).store.completeSamlRequest({
        ...ref,
        loginNonceHash: 'h1',
      });
    expect(await run({ GetItem: () => ({}) })).toBeNull();
    expect(await run({ GetItem: () => found({}, { loginNonceHash: 'other' }) })).toBeNull();
    expect(await run({ GetItem: () => found({}, { loginNonceHash: 5 }) })).toBeNull();
    expect(await run({ GetItem: () => found({}, {}) })).toBeNull();
    expect(await run({ GetItem: () => found({}, [{ loginNonceHash: 'h1' }]) })).toBeNull();
    expect(await run({ GetItem: () => found({}, null) })).toBeNull();
    expect(await run({ GetItem: () => found({}, 'h1') })).toBeNull();
  });

  it('re-reads up to three times when a nonce completion races, but once with an explicit revision', async () => {
    const lost = () => {
      throw conditional;
    };
    const retry = fixture({ GetItem: () => found(), UpdateItem: lost });
    expect(await retry.store.completeSamlRequest({ ...ref, loginNonceHash: 'h1' })).toBeNull();
    expect(inputs(retry.send, 'GetItem')).toHaveLength(3);
    expect(inputs(retry.send, 'UpdateItem')).toHaveLength(3);
    const once = fixture({ GetItem: () => found(), UpdateItem: lost });
    expect(
      await once.store.completeSamlRequest({ ...ref, loginNonceHash: 'h1', expectedRevision: 1 })
    ).toBeNull();
    expect(inputs(once.send, 'UpdateItem')).toHaveLength(1);
    const plain = fixture({ UpdateItem: lost });
    expect(await plain.store.completeSamlRequest(ref)).toBeNull();
    expect(inputs(plain.send, 'UpdateItem')).toHaveLength(1);
  });

  it('succeeds on a later attempt once the race clears', async () => {
    let calls = 0;
    const f = fixture({
      GetItem: () => found(),
      UpdateItem: () => {
        if (++calls < 3) throw conditional;
        return consumed();
      },
    });
    expect(await f.store.completeSamlRequest({ ...ref, loginNonceHash: 'h1' })).not.toBeNull();
    expect(calls).toBe(3);
  });
});

describe('transient KV keys', () => {
  it('putKey validates ttl and key length and writes the item', async () => {
    const { store, send } = fixture({ PutItem: () => ({}) });
    await expect(store.putKey({ tenantId: T, key: 'k', value: 'v', ttlMs: 0 })).rejects.toThrow(
      'Invalid transient state TTL'
    );
    await expect(store.putKey({ tenantId: T, key: '', value: 'v', ttlMs: 5 })).rejects.toThrow(
      'Invalid KV ID'
    );
    await expect(
      store.putKey({ tenantId: T, key: 'k'.repeat(4097), value: 'v', ttlMs: 5 })
    ).rejects.toThrow('Invalid KV ID');
    expect(send).not.toHaveBeenCalled();
    await store.putKey({ tenantId: T, key: 'k'.repeat(4096), value: 'v', ttlMs: 5000 });
    await store.putKey({ tenantId: T, key: 'key', value: 'v', ttlMs: 2500 });
    expect(inputs(send, 'PutItem')[1]).toEqual({
      TableName: 'test-state',
      Item: {
        ...keyOf('KV', 'key'),
        payloadJson: { S: '{"value":"v"}' },
        createdAtMs: { N: String(NOW) },
        expiresAtMs: { N: String(NOW + 2500) },
        ttl: { N: String(Math.ceil((NOW + 2500) / 1000)) },
      },
    });
  });

  it('getKey returns live string values and rejects malformed ones', async () => {
    const kv = (over: Record<string, unknown> = {}, value: unknown = 'v') => ({
      ...keyOf('KV', 'key'),
      payloadJson: { S: JSON.stringify({ value }) },
      createdAtMs: { N: '1' },
      expiresAtMs: { N: String(NOW + 1) },
      ...over,
    });
    const get = (item: unknown, key = 'key') =>
      fixture({ GetItem: () => ({ Item: item }) }).store.getKey({ tenantId: T, key });
    expect(await get(kv())).toBe('v');
    expect(await get(undefined)).toBeNull();
    expect(await get(kv({ expiresAtMs: { N: String(NOW) } }))).toBeNull();
    expect(await get(kv({ consumedAtMs: { N: '1' } }))).toBeNull();
    await expect(get(kv({}, 5))).rejects.toThrow('Transient key payload invalid');
    await expect(get(undefined, '')).rejects.toThrow('Invalid KV ID');
    await expect(get(undefined, 'k'.repeat(4097))).rejects.toThrow('Invalid KV ID');
  });

  it('deleteKey consumes without requiring liveness', async () => {
    const f = fixture({ UpdateItem: () => ({ Attributes: { x: { S: '1' } } }) });
    expect(await f.store.deleteKey({ tenantId: T, key: 'key' })).toBe(true);
    const [u] = inputs(f.send, 'UpdateItem');
    expect(u.Key).toEqual(keyOf('KV', 'key'));
    expect(u.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_not_exists(consumedAtMs)'
    );
    await expect(f.store.deleteKey({ tenantId: T, key: 'k'.repeat(4097) })).rejects.toThrow(
      'Invalid KV ID'
    );
    expect(
      await fixture({
        UpdateItem: () => {
          throw conditional;
        },
      }).store.deleteKey({ tenantId: T, key: 'key' })
    ).toBe(false);
  });
});
