import { createHash } from 'node:crypto';
import { GetItemCommand, ScanCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
vi.mock('../import/auth-state-restore', () => ({
  assertDynamoAuthStateTable: vi.fn(async () => {
    order.push('table');
  }),
  assertDynamoAuthStateSealed: vi.fn(async () => {
    order.push('sealed');
  }),
}));
vi.mock('../storage/dynamodb-state', async (importActual) => {
  const actual = await importActual<typeof import('../storage/dynamodb-state')>();
  return { ...actual, createDynamoStateClient: vi.fn(actual.createDynamoStateClient) };
});

import {
  assertDynamoAuthStateSealed,
  assertDynamoAuthStateTable,
  type DynamoAuthStateRestoreReceipt,
} from '../import/auth-state-restore';
import { createDynamoStateClient } from '../storage/dynamodb-state';
import type { DynamoAuthStateConfig } from '../storage/auth-state-config';
import { readSyntheticDynamoAuthStateSnapshot } from './selected-auth-state-snapshot';

const FAILED = 'aws_synthetic_auth_state_snapshot_invalid';
const NAMESPACE = '00000000-0000-4000-8000-000000000000';
const target = {
  backend: 'dynamodb',
  region: 'ap-northeast-1',
  tableArn: 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/test-auth-state',
  namespace: NAMESPACE,
} as unknown as DynamoAuthStateConfig;
const receipt = {
  formatVersion: 1,
  authState: target,
  tenantId: 'tenant-a',
  source: { tenantId: 'tenant-a', issuer: 'https://tenant-a.example.test', productVersion: '1' },
  bundleId: 'a'.repeat(32),
  snapshotId: 'snapshot',
  inventoryDigestSha256: 'b'.repeat(64),
  supplementSha256: 'c'.repeat(64),
  accountAuthStates: 1,
  passkeyCounters: 1,
  persistentNameIds: 0,
} as unknown as DynamoAuthStateRestoreReceipt;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const PREFIX = `${NAMESPACE}#T#${sha('tenant-a')}#`;
const NOW = 1_000_000;
type Item = Record<string, { S?: string; N?: string }>;

const session = (id: string, userId = 'user-tenant-a'): Item => ({
  pk: { S: `${PREFIX}SESSION#${sha(id)}` },
  sk: { S: 'STATE' },
  payloadJson: { S: JSON.stringify({ userId }) },
});
function challenge(
  index: number,
  options: {
    userId?: string;
    type?: string;
    consumed?: boolean;
    expires?: string | null;
    pk?: string;
    sk?: string;
    itemId?: string;
  } = {}
): Item {
  const itemId = options.itemId ?? `browser-sp:_browser_${index}`;
  const item: Item = {
    pk: { S: options.pk ?? `${PREFIX}CHALLENGE#${sha(itemId)}` },
    sk: { S: options.sk ?? 'STATE' },
    itemId: { S: itemId },
    payloadJson: {
      S: JSON.stringify({
        userId: options.userId ?? 'user-tenant-a',
        type: options.type ?? 'synthetic-browser-sp',
      }),
    },
  };
  if (options.consumed) item.consumedAtMs = { N: String(NOW - 5) };
  if (options.expires !== null) item.expiresAtMs = { N: options.expires ?? String(NOW + 60_000) };
  return item;
}

interface World {
  client: DynamoDBClient;
  sent: Array<ScanCommand | GetItemCommand>;
  scans: ScanCommand[];
  destroy: ReturnType<typeof vi.fn>;
}
function world(
  options: { counter?: Item | undefined; pages?: Array<{ items: Item[]; next?: object }> } = {}
) {
  const sent: World['sent'] = [];
  const pages = options.pages ?? [{ items: [] }];
  let scan = 0;
  const destroy = vi.fn();
  const client = createDynamoStateClient({ region: 'ap-northeast-1' });
  client.send = vi.fn(async (command: unknown) => {
    sent.push(command as never);
    if (command instanceof GetItemCommand)
      return { Item: 'counter' in options ? options.counter : { counter: { N: '4' } } };
    if (command instanceof ScanCommand) {
      const page = pages[scan++] ?? { items: [] };
      return { Items: page.items, LastEvaluatedKey: page.next };
    }
    throw new Error('unexpected command');
  }) as never;
  client.destroy = destroy as never;
  return {
    client,
    sent,
    destroy,
    get scans() {
      return sent.filter((command): command is ScanCommand => command instanceof ScanCommand);
    },
  } as World;
}
const baseInput = { target, receipt, passkeyRowId: 'passkey-a' };
const read = (
  w: World,
  input: Partial<typeof baseInput> = {},
  now: number | (() => number) = NOW
) =>
  readSyntheticDynamoAuthStateSnapshot(
    { ...baseInput, ...input },
    { createClient: () => w.client, now: typeof now === 'number' ? () => now : now }
  );

beforeEach(() => {
  order.length = 0;
  vi.mocked(assertDynamoAuthStateTable).mockClear();
  vi.mocked(assertDynamoAuthStateSealed).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('selected auth state snapshot input validation', () => {
  it.each(['a b', 'a/b', '', 'a'.repeat(201), 'ok\n', '\nok'])(
    'rejects the passkey row id %j before creating a client',
    async (passkeyRowId) => {
      const w = world();
      const createClient = vi.fn(() => w.client);
      await expect(
        readSyntheticDynamoAuthStateSnapshot({ ...baseInput, passkeyRowId }, { createClient })
      ).rejects.toThrow(FAILED);
      expect(createClient).not.toHaveBeenCalled();
      expect(assertDynamoAuthStateTable).not.toHaveBeenCalled();
    }
  );
  it('accepts a 200 character row id and the full allowed alphabet', async () => {
    const id = 'aZ09._:-'.repeat(25);
    expect(id).toHaveLength(200);
    await expect(read(world(), { passkeyRowId: id })).resolves.toMatchObject({ counter: 4 });
  });
  it('rejects a receipt for another tenant or another source tenant', async () => {
    for (const changed of [
      { ...receipt, tenantId: 'tenant-b' },
      { ...receipt, source: { ...receipt.source, tenantId: 'tenant-b' } },
    ]) {
      const w = world();
      const createClient = vi.fn(() => w.client);
      await expect(
        readSyntheticDynamoAuthStateSnapshot({ ...baseInput, receipt: changed }, { createClient })
      ).rejects.toThrow(FAILED);
      expect(createClient).not.toHaveBeenCalled();
    }
  });
});

describe('selected auth state snapshot client and seal handling', () => {
  it('creates the client from the target, verifies the table and seals before and after the scan', async () => {
    const w = world();
    const createClient = vi.fn(() => w.client);
    await readSyntheticDynamoAuthStateSnapshot(baseInput, { createClient, now: () => NOW });
    expect(createClient).toHaveBeenCalledWith(target);
    expect(assertDynamoAuthStateTable).toHaveBeenCalledWith(w.client, target);
    expect(assertDynamoAuthStateSealed).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(assertDynamoAuthStateSealed).mock.calls)
      expect(call[0]).toEqual({ ...baseInput, client: w.client });
    expect(order).toEqual(['table', 'sealed', 'sealed']);
    expect(w.sent.map((command) => command.constructor.name)).toEqual([
      'GetItemCommand',
      'ScanCommand',
    ]);
    expect(w.destroy).toHaveBeenCalledOnce();
  });
  it('falls back to a single-attempt state client for the target region', async () => {
    const w = world();
    vi.mocked(createDynamoStateClient).mockImplementationOnce(() => w.client);
    await readSyntheticDynamoAuthStateSnapshot(baseInput, { now: () => NOW });
    expect(createDynamoStateClient).toHaveBeenLastCalledWith({ region: 'ap-northeast-1' });
    expect(w.destroy).toHaveBeenCalledOnce();
  });
  it('uses the wall clock when no clock is injected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const w = world({
      pages: [{ items: [challenge(1, { expires: String(NOW + 1) })] }],
    });
    const report = await readSyntheticDynamoAuthStateSnapshot(baseInput, {
      createClient: () => w.client,
    });
    expect(report.outstanding).toBe(1);
    vi.setSystemTime(NOW + 1);
    const later = world({ pages: [{ items: [challenge(1, { expires: String(NOW + 1) })] }] });
    expect(
      (await readSyntheticDynamoAuthStateSnapshot(baseInput, { createClient: () => later.client }))
        .outstanding
    ).toBe(0);
  });
  it.each([
    ['table check', 'table'],
    ['first seal', 'sealed-1'],
    ['second seal', 'sealed-2'],
  ])('fails closed and destroys the client when the %s rejects', async (_label, point) => {
    const w = world();
    if (point === 'table')
      vi.mocked(assertDynamoAuthStateTable).mockRejectedValueOnce(new Error('private detail'));
    if (point === 'sealed-1')
      vi.mocked(assertDynamoAuthStateSealed).mockRejectedValueOnce(new Error('private detail'));
    if (point === 'sealed-2')
      vi.mocked(assertDynamoAuthStateSealed)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('private detail'));
    await expect(read(w)).rejects.toThrow(new RegExp(`^${FAILED}$`, 'u'));
    expect(w.destroy).toHaveBeenCalledOnce();
  });
});

describe('selected auth state snapshot counter', () => {
  it.each([
    ['0', 0],
    ['12', 12],
    ['123', 123],
    ['4294967295', 4294967295],
  ])('returns the counter %s', async (value, expected) => {
    const report = await read(world({ counter: { counter: { N: value } } }));
    expect(report).toEqual({ counter: expected, sessions: 0, outstanding: 0, consumed: 0 });
  });
  it.each([
    ['a missing item', undefined],
    ['a missing attribute', {}],
    ['a negative value', { counter: { N: '-1' } }],
    ['a leading zero', { counter: { N: '01' } }],
    ['a fraction', { counter: { N: '1.5' } }],
    ['a trailing space', { counter: { N: '5 ' } }],
    ['an exponent', { counter: { N: '1e0' } }],
    ['a value above 32 bits', { counter: { N: '4294967296' } }],
    ['an empty value', { counter: { N: '' } }],
  ])('rejects %s', async (_label, counter) => {
    const w = world({ counter: counter as Item | undefined });
    await expect(read(w)).rejects.toThrow(FAILED);
    expect(w.scans).toHaveLength(0);
    expect(w.destroy).toHaveBeenCalledOnce();
  });
  it('reads the account counter key bound to the hashed passkey row id', async () => {
    const w = world();
    await read(w);
    const get = w.sent[0] as GetItemCommand;
    expect(get.input).toEqual({
      TableName: 'test-auth-state',
      Key: {
        pk: { S: `${PREFIX}ACCOUNT#${sha('user-tenant-a')}` },
        sk: { S: `COUNTER#${sha('passkey-a')}` },
      },
      ConsistentRead: true,
    });
  });
});

describe('selected auth state snapshot clock', () => {
  it.each([0, -1, 1.5, Number.NaN])('rejects the invalid clock value %s', async (now) => {
    await expect(read(world(), {}, now)).rejects.toThrow(FAILED);
  });
  it('accepts the smallest valid clock value', async () => {
    await expect(read(world(), {}, 1)).resolves.toMatchObject({ counter: 4 });
  });
});

describe('selected auth state snapshot scan', () => {
  it('scans consistently with a bounded page size and follows non-empty cursors only', async () => {
    const cursor = { pk: { S: 'cursor-1' }, sk: { S: 'STATE' } };
    const w = world({
      pages: [
        { items: [session('s1')], next: cursor },
        { items: [session('s2')], next: {} },
        { items: [session('never')] },
      ],
    });
    const report = await read(w);
    expect(report.sessions).toBe(2);
    expect(w.scans).toHaveLength(2);
    const expectedBase = {
      TableName: 'test-auth-state',
      ConsistentRead: true,
      Limit: 200,
      FilterExpression: 'begins_with(pk, :sessions) OR begins_with(pk, :challenges)',
      ExpressionAttributeValues: {
        ':sessions': { S: `${PREFIX}SESSION#` },
        ':challenges': { S: `${PREFIX}CHALLENGE#` },
      },
    };
    expect(w.scans[0].input).toEqual(expectedBase);
    expect(w.scans[0].input).not.toHaveProperty('ExclusiveStartKey');
    expect(w.scans[1].input).toEqual({ ...expectedBase, ExclusiveStartKey: cursor });
  });
  it('treats a page without items as empty', async () => {
    const w = world();
    client_noItems(w);
    await expect(read(w)).resolves.toEqual({
      counter: 4,
      sessions: 0,
      outstanding: 0,
      consumed: 0,
    });
  });
  it('counts only sessions of the synthetic user and ignores other users entirely', async () => {
    const w = world({
      pages: [
        {
          items: [
            session('a'),
            session('b'),
            session('c', 'someone-else'),
            challenge(1, { userId: 'someone-else', pk: 'unbound', sk: 'unbound' }),
          ],
        },
      ],
    });
    expect(await read(w)).toEqual({ counter: 4, sessions: 2, outstanding: 0, consumed: 0 });
  });
  it('counts consumed and outstanding synthetic browser requests separately', async () => {
    const w = world({
      pages: [
        {
          items: [
            challenge(1, { consumed: true, expires: null }),
            challenge(2, { consumed: true }),
            challenge(3, { expires: String(NOW + 1) }),
            challenge(4, { expires: String(NOW) }),
            challenge(5, { expires: String(NOW - 1) }),
            challenge(6, { expires: '1' }),
          ],
        },
      ],
    });
    expect(await read(w)).toEqual({ counter: 4, sessions: 0, outstanding: 1, consumed: 2 });
  });
  it('ignores challenges that are not synthetic browser SP requests', async () => {
    const w = world({
      pages: [
        {
          items: [
            challenge(1, { type: 'other' }),
            challenge(2, { itemId: 'browser-sp:other' }),
            challenge(3, { itemId: 'xbrowser-sp:_browser_3' }),
            {
              ...challenge(4),
              itemId: undefined as never,
            },
          ],
        },
      ],
    });
    expect(await read(w)).toEqual({ counter: 4, sessions: 0, outstanding: 0, consumed: 0 });
  });
  it('does not count a session-prefixed row as a browser request', async () => {
    const row = { ...challenge(1), pk: { S: `${PREFIX}SESSION#${sha('x')}` } };
    expect(await read(world({ pages: [{ items: [row] }] }))).toEqual({
      counter: 4,
      sessions: 1,
      outstanding: 0,
      consumed: 0,
    });
  });
  it('does not count a challenge from another tenant prefix as a session', async () => {
    const row = {
      ...challenge(1, { type: 'other' }),
      pk: { S: `other#T#${sha('tenant-b')}#SESSION#${sha('x')}` },
    };
    expect((await read(world({ pages: [{ items: [row] }] }))).sessions).toBe(0);
  });
  it.each([
    ['payload missing', { payloadJson: undefined }],
    ['payload null', { payloadJson: { S: 'null' } }],
    ['payload array', { payloadJson: { S: '[]' } }],
    ['payload string', { payloadJson: { S: '"text"' } }],
    ['payload number', { payloadJson: { S: '7' } }],
    ['payload not json', { payloadJson: { S: '{' } }],
  ])('rejects %s', async (_label, patch) => {
    const w = world({ pages: [{ items: [{ ...session('a'), ...patch } as Item] }] });
    await expect(read(w)).rejects.toThrow(FAILED);
    expect(w.destroy).toHaveBeenCalledOnce();
  });
  it('rejects a payload missing for a row of another user too', async () => {
    const w = world({
      pages: [{ items: [{ ...session('a', 'other'), payloadJson: { S: 'null' } }] }],
    });
    await expect(read(w)).rejects.toThrow(FAILED);
  });
  it('rejects a browser request stored under an unbound partition or sort key', async () => {
    for (const options of [{ pk: `${PREFIX}CHALLENGE#${sha('another-id')}` }, { sk: 'OTHER' }]) {
      const w = world({ pages: [{ items: [challenge(1, options)] }] });
      await expect(read(w)).rejects.toThrow(FAILED);
    }
  });
  it.each([null, '0', '-1', '1.5', 'abc'])(
    'rejects an unconsumed browser request with expiry %j',
    async (expires) => {
      const w = world({ pages: [{ items: [challenge(1, { expires })] }] });
      await expect(read(w)).rejects.toThrow(FAILED);
    }
  );
  it('accepts an expiry of exactly 1 as expired', async () => {
    const w = world({ pages: [{ items: [challenge(1, { expires: '1' })] }] });
    expect(await read(w)).toMatchObject({ outstanding: 0, consumed: 0 });
  });
});

function client_noItems(w: World) {
  const send = w.client.send as unknown as (command: unknown) => Promise<object>;
  w.client.send = vi.fn(async (command: unknown) =>
    command instanceof ScanCommand ? {} : send(command)
  ) as never;
}
