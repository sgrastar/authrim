import { beforeEach, describe, expect, it, vi } from 'vitest';
import { awsAuthStateConfigurationEvidence, selectAwsAuthState } from './selected-auth-state';

const mocks = vi.hoisted(() => ({
  stores: vi.fn(),
  assertSource: vi.fn(),
  pgRestore: vi.fn(),
  pgStaging: vi.fn(),
  pgLive: vi.fn(),
  dynamoReceipt: vi.fn(),
  dynamoTable: vi.fn(),
  dynamoSealed: vi.fn(),
  dynamoRestore: vi.fn(),
  dynamoStaging: vi.fn(),
  dynamoLive: vi.fn(),
  dynamoCounters: vi.fn(),
}));

vi.mock('../storage/create-state-stores', () => ({ createAwsStateStores: mocks.stores }));
vi.mock('./state-restore', () => ({
  assertVerifiedAwsStateSource: mocks.assertSource,
  assertVerifiedAwsStateRestored: mocks.pgStaging,
  assertAwsLiveStateCompatible: mocks.pgLive,
  restoreVerifiedAwsState: mocks.pgRestore,
}));
vi.mock('./auth-state-restore', () => ({
  createDynamoAuthStateRestoreReceipt: mocks.dynamoReceipt,
  assertDynamoAuthStateTable: mocks.dynamoTable,
  assertDynamoAuthStateSealed: mocks.dynamoSealed,
  restoreVerifiedDynamoAuthState: mocks.dynamoRestore,
  assertVerifiedDynamoAuthStateRestored: mocks.dynamoStaging,
  assertDynamoAuthStateLiveCompatible: mocks.dynamoLive,
  readDynamoAuthStateCounters: mocks.dynamoCounters,
}));

const restoreId = '00000000-0000-4000-8000-000000000001';
const dynamo = {
  backend: 'dynamodb' as const,
  region: 'ap-northeast-1',
  tableArn: 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/auth-state',
  namespace: restoreId,
};
const manifest = {
  source: {
    tenantId: 'tenant-a',
    issuer: 'https://tenant-a.example.test',
    productVersion: '0.4.2',
  },
  bundleId: 'a'.repeat(32),
  snapshotId: 'snapshot-a',
  inventoryDigestSha256: 'b'.repeat(64),
};
const supplement = {
  receipt: { supplementSha256: 'c'.repeat(64) },
  accountAuthStates: [{ userId: 'user-a' }],
  passkeyCounters: [{ passkeyId: 'passkey-a' }],
  persistentNameIds: [{ registryKey: 'name-a' }],
};

function fixture(authState?: unknown) {
  const release = vi.fn();
  const client = { release };
  const connect = vi.fn(async () => client);
  const query = vi.fn(async () => ({
    rows: [{ user_id: 'user-a', credential_id: 'cred-a', counter: '7' }],
  }));
  const stateDb = { connect, query };
  const input = {
    authState,
    restoreId,
    stateDb,
    manifest,
    supplement,
    expected: { passkeys: [{ passkeyId: 'passkey-a' }] },
  } as never;
  return { input, connect, query, release, stateDb };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.stores.mockReturnValue({ label: 'selected-stores' });
  mocks.dynamoReceipt.mockReturnValue({ label: 'dynamo-receipt' });
  mocks.dynamoCounters.mockResolvedValue([{ passkeyId: 'passkey-a', counter: '7' }]);
});

describe('AWS auth state configuration evidence', () => {
  it('keeps absent legacy configuration absent in activation evidence', () => {
    expect(awsAuthStateConfigurationEvidence(undefined, restoreId)).toEqual({});
    expect(awsAuthStateConfigurationEvidence({ backend: 'postgresql' }, restoreId)).toEqual({
      authState: { backend: 'postgresql' },
    });
  });

  it('rejects a Dynamo namespace that does not match the selected restore', () => {
    expect(() =>
      awsAuthStateConfigurationEvidence(
        { ...dynamo, namespace: '00000000-0000-4000-8000-000000000002' },
        restoreId
      )
    ).toThrow('aws_auth_state_config_invalid');
  });
});

describe('PostgreSQL auth state selection', () => {
  it('pins the source receipt and reads passkey counters from the selected tenant', async () => {
    const { input, query, stateDb } = fixture();
    const selected = selectAwsAuthState(input);

    expect(selected.evidence).toEqual({ config: { backend: 'postgresql' } });
    expect(selected.receipt).toMatchObject({
      tenantId: 'tenant-a',
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      supplementSha256: supplement.receipt.supplementSha256,
      accountAuthStates: 1,
      passkeyCounters: 1,
      persistentNameIds: 1,
    });
    expect(mocks.stores).toHaveBeenCalledWith({ backend: 'postgresql', db: stateDb });
    await expect(selected.bound.assertReady()).resolves.toBeUndefined();
    await expect(selected.readPasskeyCounters()).resolves.toEqual([
      { user_id: 'user-a', credential_id: 'cred-a', counter: '7' },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM authrim_aws_passkey_counters WHERE tenant_id=$1'),
      ['tenant-a']
    );
    await expect(selected.close()).resolves.toBeUndefined();
  });

  it('releases a dedicated connection even when the restore callback fails', async () => {
    const { input, connect, release } = fixture({ backend: 'postgresql' });
    const selected = selectAwsAuthState(input);
    const failure = new Error('synthetic_restore_failed');
    mocks.pgRestore.mockImplementation(
      async (source: {
        connection: {
          withDedicatedConnection(run: (client: unknown) => Promise<unknown>): Promise<unknown>;
        };
      }) =>
        source.connection.withDedicatedConnection(async () => {
          throw failure;
        })
    );

    await expect(selected.restore()).rejects.toBe(failure);
    expect(connect).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects a restore receipt that differs from the pinned source evidence', async () => {
    const { input } = fixture({ backend: 'postgresql' });
    const selected = selectAwsAuthState(input);
    mocks.pgRestore.mockResolvedValue({ ...selected.receipt, passkeyCounters: 2 });

    await expect(selected.restore()).rejects.toThrow('aws_auth_state_receipt_mismatch');
  });

  it('passes the pinned receipt to staging and live verification', async () => {
    const { input } = fixture({ backend: 'postgresql' });
    const selected = selectAwsAuthState(input);
    await selected.assertStaging();
    await selected.assertLive();
    expect(mocks.pgStaging).toHaveBeenCalledWith(
      expect.objectContaining({ receipt: selected.receipt })
    );
    expect(mocks.pgLive).toHaveBeenCalledWith(
      expect.objectContaining({ receipt: selected.receipt })
    );
  });
});

describe('DynamoDB auth state selection', () => {
  it('uses the injected client, sealed receipt, and exact table namespace', async () => {
    const { input } = fixture(dynamo);
    const destroy = vi.fn();
    const client = { destroy };
    const createDynamoClient = vi.fn(() => client as never);
    const selected = selectAwsAuthState(input, { createDynamoClient });

    expect(createDynamoClient).toHaveBeenCalledExactlyOnceWith(dynamo);
    expect(mocks.stores).toHaveBeenCalledWith({
      backend: 'dynamodb',
      client,
      tableName: 'auth-state',
      namespace: restoreId,
    });
    expect(selected.evidence).toEqual({ config: dynamo, receipt: selected.receipt });
    await selected.bound.assertReady();
    expect(mocks.dynamoSealed).toHaveBeenCalledWith({
      client,
      target: dynamo,
      receipt: selected.receipt,
    });
    await selected.assertStaging();
    expect(mocks.dynamoStaging).toHaveBeenCalledWith(
      expect.objectContaining({ client, receipt: selected.receipt })
    );
    await selected.assertLive();
    expect(mocks.dynamoTable).toHaveBeenCalledWith(client, dynamo);
    expect(mocks.dynamoLive).toHaveBeenCalledWith(
      expect.objectContaining({ client, receipt: selected.receipt })
    );
    await expect(selected.readPasskeyCounters()).resolves.toEqual([
      { passkeyId: 'passkey-a', counter: '7' },
    ]);
    expect(mocks.dynamoCounters).toHaveBeenCalledWith({
      client,
      target: dynamo,
      receipt: selected.receipt,
      passkeys: [{ passkeyId: 'passkey-a' }],
    });
    await selected.close();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('checks the table before restoring and rejects a mismatched receipt', async () => {
    const { input } = fixture(dynamo);
    const client = { destroy: vi.fn() };
    const selected = selectAwsAuthState(input, { createDynamoClient: () => client as never });
    mocks.dynamoRestore.mockResolvedValue({ label: 'other-receipt' });

    await expect(selected.restore()).rejects.toThrow('aws_auth_state_receipt_mismatch');
    expect(mocks.dynamoTable).toHaveBeenCalledWith(client, dynamo);
    expect(mocks.dynamoRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        target: dynamo,
        restoreId,
      })
    );
  });

  it('rejects invalid selected configuration before touching storage or AWS', () => {
    const { input } = fixture({ ...dynamo, namespace: 'wrong-restore' });
    const createDynamoClient = vi.fn();

    expect(() => selectAwsAuthState(input, { createDynamoClient })).toThrow(
      'aws_auth_state_config_invalid'
    );
    expect(mocks.assertSource).not.toHaveBeenCalled();
    expect(mocks.stores).not.toHaveBeenCalled();
    expect(createDynamoClient).not.toHaveBeenCalled();
  });
});
