/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- fake DynamoDB/Postgres command inputs are intentionally untyped */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createDynamoStateClient,
  DynamoAccountAuthStateStore,
  DynamoStateTable,
} from './dynamodb-state';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
type Handler = (input: any) => any;

function fixture(handlers: Record<string, Handler> = {}) {
  const client = createDynamoStateClient({
    region: 'ap-northeast-1',
    credentials: { accessKeyId: 'localtest', secretAccessKey: 'localtest' },
  });
  const send = vi.spyOn(client, 'send').mockImplementation((async (command: {
    constructor: { name: string };
    input: unknown;
  }) => {
    const name = command.constructor.name.replace(/Command$/, '');
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected ${name}`);
    return handler(command.input);
  }) as never);
  const table = new DynamoStateTable({
    client,
    tableName: 'test-state',
    namespace: 'generation-one',
    now: () => 1000,
  });
  return { send, table, store: new DynamoAccountAuthStateStore(table) };
}
const T = 'tenant-a';
const U = 'user-1';
const A = 'account:user-1';
const conditional = Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
const canceled = (reasons?: { Code?: string }[]) =>
  Object.assign(new Error('t'), {
    name: 'TransactionCanceledException',
    CancellationReasons: reasons,
  });
const activeItem = (extra: Record<string, unknown> = {}) => ({
  lifecycle: { S: 'active' },
  lifecycleVersionMs: { N: '7' },
  revision: { S: 'rev-1' },
  ...extra,
});

describe('account identity validation', () => {
  it('rejects bad tenant, user and account IDs with the exact code', async () => {
    const { store, send } = fixture();
    const code = 'session_revocation_identity_invalid';
    await expect(store.getAccountStateRpc('Bad', U, A)).rejects.toThrow(code);
    await expect(store.getAccountStateRpc(T, '.lead', '.lead'.padStart(0))).rejects.toThrow(code);
    await expect(store.getAccountStateRpc(T, ' user', 'account: user')).rejects.toThrow(code);
    await expect(store.getAccountStateRpc(T, 'user ', 'account:user ')).rejects.toThrow(code);
    await expect(
      store.getAccountStateRpc(T, 'a'.repeat(257), `account:${'a'.repeat(257)}`)
    ).rejects.toThrow(code);
    await expect(store.getAccountStateRpc(T, '', 'account:')).rejects.toThrow(code);
    await expect(store.getAccountStateRpc(T, U, 'account:other')).rejects.toThrow(code);
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts 256-character users and the dotted/colon punctuation set', async () => {
    const { store } = fixture({ GetItem: () => ({}) });
    const long = 'a'.repeat(256);
    await store.getAccountStateRpc(T, long, `account:${long}`);
    await store.getAccountStateRpc(T, 'a.b:c-d_e', 'account:a.b:c-d_e');
    await store.getAccountStateRpc(T, '_x', 'account:_x');
  });
});

describe('getAccountStateRpc snapshot', () => {
  it('returns the all-null snapshot for a missing item', async () => {
    const { store, send } = fixture({ GetItem: () => ({}) });
    expect(await store.getAccountStateRpc(T, U, A)).toEqual({
      lifecycle: null,
      lifecycleVersionMs: null,
      lifecycleOperationId: null,
      revokedAfterMs: null,
      lastLoginAtMs: null,
    });
    expect((send.mock.calls[0][0] as { input: unknown }).input).toEqual({
      TableName: 'test-state',
      Key: { pk: { S: `generation-one#T#${hash(T)}#ACCOUNT#${hash(U)}` }, sk: { S: 'STATE' } },
      ConsistentRead: true,
    });
  });

  it('maps every optional attribute and treats absent ones as null', async () => {
    const full = fixture({
      GetItem: () => ({
        Item: activeItem({
          lifecycleOperationId: { S: 'op-1' },
          revokedAfterMs: { N: '0' },
          lastLoginAtMs: { N: '55' },
        }),
      }),
    });
    expect(await full.store.getAccountStateRpc(T, U, A)).toEqual({
      lifecycle: 'active',
      lifecycleVersionMs: 7,
      lifecycleOperationId: 'op-1',
      revokedAfterMs: 0,
      lastLoginAtMs: 55,
    });
    const bare = fixture({ GetItem: () => ({ Item: activeItem() }) });
    expect(await bare.store.getAccountStateRpc(T, U, A)).toEqual({
      lifecycle: 'active',
      lifecycleVersionMs: 7,
      lifecycleOperationId: null,
      revokedAfterMs: null,
      lastLoginAtMs: null,
    });
  });

  it('rejects unknown lifecycles, missing or invalid numbers', async () => {
    const code = 'aws_state_record_invalid';
    for (const lifecycle of ['bogus', '']) {
      const { store } = fixture({
        GetItem: () => ({ Item: activeItem({ lifecycle: { S: lifecycle } }) }),
      });
      await expect(store.getAccountStateRpc(T, U, A)).rejects.toThrow(code);
    }
    for (const lifecycle of ['active', 'suspended', 'locked', 'deleting', 'deleted', 'inactive']) {
      const { store } = fixture({
        GetItem: () => ({ Item: activeItem({ lifecycle: { S: lifecycle } }) }),
      });
      expect((await store.getAccountStateRpc(T, U, A)).lifecycle).toBe(lifecycle);
    }
    const missing = activeItem();
    delete (missing as Record<string, unknown>).lifecycleVersionMs;
    await expect(
      fixture({ GetItem: () => ({ Item: missing }) }).store.getAccountStateRpc(T, U, A)
    ).rejects.toThrow(code);
    const noLifecycle = activeItem();
    delete (noLifecycle as Record<string, unknown>).lifecycle;
    await expect(
      fixture({ GetItem: () => ({ Item: noLifecycle }) }).store.getAccountStateRpc(T, U, A)
    ).rejects.toThrow(code);
    for (const bad of ['-1', '1.5', 'abc']) {
      const { store } = fixture({
        GetItem: () => ({ Item: activeItem({ lifecycleVersionMs: { N: bad } }) }),
      });
      await expect(store.getAccountStateRpc(T, U, A)).rejects.toThrow(code);
    }
    const zero = fixture({
      GetItem: () => ({ Item: activeItem({ lifecycleVersionMs: { N: '0' } }) }),
    });
    expect((await zero.store.getAccountStateRpc(T, U, A)).lifecycleVersionMs).toBe(0);
  });
});

describe('initializeAccountStateRpc', () => {
  it('validates lifecycle and timestamp before writing', async () => {
    const { store, send } = fixture();
    await expect(store.initializeAccountStateRpc(T, U, A, 'bogus' as never, 5)).rejects.toThrow(
      'account_authentication_lifecycle_invalid'
    );
    await expect(store.initializeAccountStateRpc(T, U, A, 'active', 0)).rejects.toThrow(
      'Invalid account auth state timestamp'
    );
    await expect(store.initializeAccountStateRpc('Bad', U, A, 'active', 5)).rejects.toThrow(
      'session_revocation_identity_invalid'
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('puts a new account conditionally and returns the stored snapshot', async () => {
    const { store, send } = fixture({
      PutItem: () => ({}),
      GetItem: () => ({ Item: activeItem() }),
    });
    const snap = await store.initializeAccountStateRpc(T, U, A, 'active', 7);
    expect(snap.lifecycle).toBe('active');
    const put = (send.mock.calls[0][0] as { input: Record<string, any> }).input;
    expect(put).toEqual({
      TableName: 'test-state',
      Item: {
        pk: { S: `generation-one#T#${hash(T)}#ACCOUNT#${hash(U)}` },
        sk: { S: 'STATE' },
        lifecycle: { S: 'active' },
        lifecycleVersionMs: { N: '7' },
        revision: { S: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('swallows a conditional failure (re-reading), rethrows others, and requires the item', async () => {
    const existing = fixture({
      PutItem: () => {
        throw conditional;
      },
      GetItem: () => ({ Item: activeItem({ lifecycle: { S: 'suspended' } }) }),
    });
    expect((await existing.store.initializeAccountStateRpc(T, U, A, 'active', 7)).lifecycle).toBe(
      'suspended'
    );
    const other = Object.assign(new Error('o'), { name: 'ThrottlingException' });
    await expect(
      fixture({
        PutItem: () => {
          throw other;
        },
      }).store.initializeAccountStateRpc(T, U, A, 'active', 7)
    ).rejects.toBe(other);
    await expect(
      fixture({ PutItem: () => ({}), GetItem: () => ({}) }).store.initializeAccountStateRpc(
        T,
        U,
        A,
        'active',
        7
      )
    ).rejects.toThrow('account_auth_state_uninitialized');
  });
});

describe('advancePasskeyCounterRpc', () => {
  const call = (
    store: DynamoAccountAuthStateStore,
    source = 1,
    next = 2,
    at = 9,
    cred = 'cred-1'
  ) => store.advancePasskeyCounterRpc(T, U, A, cred, source, next, at);

  it('validates credential id, counters, timestamp and replay before writing', async () => {
    const { store, send } = fixture();
    for (const cred of ['', ' a', 'a ', 'a'.repeat(257), 'a/b']) {
      await expect(call(store, 1, 2, 9, cred)).rejects.toThrow(
        'account_authentication_credential_id_invalid'
      );
    }
    await expect(call(store, -1, 2)).rejects.toThrow('Invalid passkey counter');
    await expect(call(store, 1, -2)).rejects.toThrow('Invalid passkey counter');
    await expect(call(store, 1, 2, 0)).rejects.toThrow('Invalid passkey counter timestamp');
    await expect(call(store, 2, 2)).rejects.toThrow('passkey_counter_replay');
    await expect(call(store, 3, 2)).rejects.toThrow('passkey_counter_replay');
    await expect(call(store, 3, 0)).rejects.toThrow('passkey_counter_replay');
    expect(send).not.toHaveBeenCalled();
  });

  it('writes an account guard plus counter update and reports advancement', async () => {
    const { store, send } = fixture({ TransactWriteItems: () => ({}) });
    expect(await call(store, 1, 2, 9, 'a'.repeat(256))).toEqual({ counter: 2, advanced: true });
    const input = (send.mock.calls[0][0] as { input: Record<string, any> }).input;
    const accountKey = {
      pk: { S: `generation-one#T#${hash(T)}#ACCOUNT#${hash(U)}` },
      sk: { S: 'STATE' },
    };
    expect(input.TransactItems).toEqual([
      {
        ConditionCheck: {
          TableName: 'test-state',
          Key: accountKey,
          ConditionExpression: 'lifecycle = :active',
          ExpressionAttributeValues: { ':active': { S: 'active' } },
        },
      },
      {
        Update: {
          TableName: 'test-state',
          Key: { pk: accountKey.pk, sk: { S: `COUNTER#${hash('a'.repeat(256))}` } },
          UpdateExpression: 'SET #counter = :new, updatedAtMs = :at',
          ConditionExpression: 'attribute_not_exists(#counter) OR #counter < :new',
          ExpressionAttributeNames: { '#counter': 'counter' },
          ExpressionAttributeValues: { ':new': { N: '2' }, ':at': { N: '9' } },
        },
      },
    ]);
  });

  it('accepts a 0 -> 0 counter without advancing and uses the equality condition', async () => {
    const { store, send } = fixture({ TransactWriteItems: () => ({}) });
    expect(await call(store, 0, 0)).toEqual({ counter: 0, advanced: false });
    const input = (send.mock.calls[0][0] as { input: Record<string, any> }).input;
    expect(input.TransactItems[1].Update.ConditionExpression).toBe(
      'attribute_not_exists(#counter) OR #counter = :new'
    );
  });

  it('maps a lost conditional transaction to the account-aware error', async () => {
    const fail = (reasons: { Code?: string }[] | undefined, item?: unknown) =>
      fixture({
        TransactWriteItems: () => {
          throw canceled(reasons);
        },
        GetItem: () => ({ Item: item }),
      });
    await expect(
      call(fail([{ Code: 'ConditionalCheckFailed' }], activeItem()).store)
    ).rejects.toThrow('passkey_counter_replay');
    await expect(call(fail([{ Code: 'TransactionConflict' }], activeItem()).store)).rejects.toThrow(
      'passkey_counter_replay'
    );
    await expect(
      call(fail([{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }], activeItem()).store)
    ).rejects.toThrow('passkey_counter_replay');
    await expect(
      call(fail([{ Code: 'ConditionalCheckFailed' }, {}], activeItem()).store)
    ).rejects.toThrow('passkey_counter_replay');
    await expect(call(fail([{ Code: 'ConditionalCheckFailed' }], undefined).store)).rejects.toThrow(
      'account_auth_state_uninitialized'
    );
    await expect(
      call(
        fail([{ Code: 'ConditionalCheckFailed' }], activeItem({ lifecycle: { S: 'locked' } })).store
      )
    ).rejects.toThrow('account_authentication_not_allowed');
  });

  it('rethrows cancellations that are not purely conditional and non-cancellation errors', async () => {
    const rethrown = async (error: unknown) => {
      const { store, send } = fixture({
        TransactWriteItems: () => {
          throw error;
        },
        GetItem: () => ({ Item: activeItem() }),
      });
      await expect(call(store)).rejects.toBe(error);
      expect(send).toHaveBeenCalledTimes(1);
    };
    await rethrown(
      canceled([{ Code: 'ConditionalCheckFailed' }, { Code: 'ProvisionedThroughputExceeded' }])
    );
    await rethrown(canceled([{ Code: 'ConditionalCheckFailed' }, { Code: 'ValidationError' }]));
    await rethrown(canceled([{ Code: 'None' }]));
    await rethrown(canceled([]));
    await rethrown(canceled(undefined));
    await rethrown(
      Object.assign(new Error('x'), {
        name: 'Other',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      })
    );
    await rethrown('not an error');
  });
});
