import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { prepareAccountExternalSubjectRemoval } from '../account-identifier-addition';

const { loadKeys } = vi.hoisted(() => ({
  loadKeys: vi.fn(),
}));

vi.mock('../lookup-hmac-runtime', () => ({
  loadLookupHmacRuntimeKeys: loadKeys,
}));

const KEY_A = 'lookup-key-a-0123456789abcdef0123456789abcdef';
const KEY_B = 'lookup-key-b-0123456789abcdef0123456789abcdef';

function input() {
  return {
    operationId: 'account-passkey-remove-passkey-a',
    idempotencyKey: 'account-passkey-remove:passkey-a',
    tenantId: 'tenant-a',
    accountId: 'account:user-a',
    externalSubject: {
      issuer: 'urn:authrim:passkey:login.example.com',
      subject: 'credential-a',
    },
    routeProjection: {
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: 'default-policy',
      targets: [
        {
          dataRole: 'tenant_core/users' as const,
          residencyPartition: 'default',
          shardId: 'users-1',
          bindingRef: 'TDB_USERS_1',
          requiredBindingRouteGeneration: 1,
        },
      ],
    },
  };
}

describe('account external-subject removal preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadKeys.mockResolvedValue({
      readKeys: [
        { generation: 2, secret: KEY_B },
        { generation: 1, secret: KEY_A },
      ],
    });
  });

  it('persists only current and previous blind indexes in a prepared durable outbox', async () => {
    const adapter = {
      queryOne: vi.fn().mockResolvedValue(null),
      batch: vi.fn().mockResolvedValue([{ success: true, rowsAffected: 1 }]),
    } as unknown as DatabaseAdapter;

    const publication = await prepareAccountExternalSubjectRemoval(
      {} as Env,
      input(),
      adapter,
      123
    );

    expect(publication.scope).toBe('identifier');
    expect(publication.indexes).toHaveLength(2);
    expect(publication.indexes.map((index) => index.hmacKeyGeneration).sort()).toEqual([1, 2]);
    expect(JSON.stringify(publication)).not.toContain('credential-a');
    expect(JSON.stringify(publication)).not.toContain('login.example.com');
    expect(adapter.batch).toHaveBeenCalledWith([
      expect.objectContaining({
        sql: expect.stringContaining("'prepared'"),
        params: expect.arrayContaining(['identifier_removed', JSON.stringify(publication)]),
      }),
    ]);
  });

  it('reuses only an exact existing outbox payload', async () => {
    const first = {
      queryOne: vi.fn().mockResolvedValue(null),
      batch: vi.fn().mockResolvedValue([{ success: true, rowsAffected: 1 }]),
    } as unknown as DatabaseAdapter;
    const publication = await prepareAccountExternalSubjectRemoval({} as Env, input(), first, 123);
    const exact = {
      queryOne: vi.fn().mockResolvedValue({
        payload_json: JSON.stringify(publication),
        status: 'pending',
      }),
      batch: vi.fn(),
    } as unknown as DatabaseAdapter;
    await expect(
      prepareAccountExternalSubjectRemoval({} as Env, input(), exact, 124)
    ).resolves.toEqual(publication);
    expect(exact.batch).not.toHaveBeenCalled();

    const conflict = {
      queryOne: vi.fn().mockResolvedValue({ payload_json: '{}', status: 'pending' }),
      batch: vi.fn(),
    } as unknown as DatabaseAdapter;
    await expect(
      prepareAccountExternalSubjectRemoval({} as Env, input(), conflict, 124)
    ).rejects.toThrow('account_identifier_removal_outbox_conflict');
  });
});
