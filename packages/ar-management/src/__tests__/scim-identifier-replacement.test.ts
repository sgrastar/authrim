import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  resume: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  createLookupBlindIndexes: vi.fn(async (kind: string) => [
    {
      kind,
      normalizationVersion: 1,
      hmacKeyGeneration: 1,
      virtualBucket: 7,
      digest: kind === 'external_subject' ? 'a'.repeat(64) : 'b'.repeat(64),
    },
  ]),
  normalizeLookupEmail: vi.fn((value: string) => value.trim().toLowerCase()),
  produceNotificationDelivery: vi.fn(async () => {}),
}));

vi.mock('../identifier-replacement-credential-revocation', () => ({
  revokeIdentifierReplacementCredentials: vi.fn(async () => {}),
}));

vi.mock('../identifier-replacement-operation', () => ({
  IdentifierReplacementOperationRepository: class {
    create = mocks.create;
  },
}));

vi.mock('../identifier-replacement-coordinator', () => ({
  IdentifierReplacementCoordinator: class {
    resume = mocks.resume;
  },
}));

vi.mock('../lookup-bucket-write-route', () => ({
  createLookupBucketWriteResolver: vi.fn(async () => async () => ({})),
}));

vi.mock('../lookup-hmac-runtime', () => ({
  loadLookupHmacRuntimeKeys: vi.fn(async () => ({ readKeys: [{}] })),
}));

import { syncScimIdentifierReplacements } from '../scim-identifier-replacement';

describe('syncScimIdentifierReplacements', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.resume.mockReset();
  });

  it('starts a deterministic new attempt when an identical prior operation was canceled', async () => {
    mocks.create
      .mockResolvedValueOnce({ state: 'canceled', updatedAt: 1200 })
      .mockResolvedValueOnce({ state: 'directory_pending', updatedAt: 1300 });
    mocks.resume.mockResolvedValue({ state: 'completed' });

    await syncScimIdentifierReplacements({
      env: {} as never,
      core: {} as never,
      pii: {} as never,
      tenantId: 'tenant-a',
      accountId: 'user-a',
      actorRef: 'scim-token:test',
      oldValues: { userName: 'OldUser', email: 'same@example.test' },
      newValues: { userName: 'NewUser', email: 'same@example.test' },
    });

    expect(mocks.create).toHaveBeenCalledTimes(2);
    const first = mocks.create.mock.calls[0][0];
    const retry = mocks.create.mock.calls[1][0];
    expect(first.operationId).not.toBe(retry.operationId);
    expect(first.idempotencyKeySha256).not.toBe(retry.idempotencyKeySha256);
    expect(first.requestFingerprintSha256).not.toBe(retry.requestFingerprintSha256);
    expect(retry).toMatchObject({
      identifierKind: 'external_subject',
      tenantId: 'tenant-a',
      accountId: 'user-a',
      oldValue: 'OldUser',
      newValue: 'NewUser',
    });
    expect(mocks.resume).toHaveBeenCalledWith({
      operationId: retry.operationId,
      tenantId: 'tenant-a',
      accountId: 'user-a',
    });
  });
});
