/**
 * What a key's generations leave behind (account-directory-producer.ts, resolveGeneration): a
 * warning from the sixteenth generation on, and an audit when all 32 are used up. Neither names
 * the address, and SCIM is named by kind, never by its token's digest.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountCreationOperation } from '../account-creation-operation';

const mocks = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createAuditLog: vi.fn(async () => undefined),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createLogger: () => ({ module: () => mocks.log }),
    createAuditLog: mocks.createAuditLog,
  };
});

const { executeDurableInitialAccountDirectoryWrite } =
  await import('../account-directory-producer');
const { accountCreationGenerationKey } = await import('../account-creation-generation');

const KEY = `auth-account:${'a'.repeat(64)}`;
const HASH = 'b'.repeat(64);

function operation(generation: number): AccountCreationOperation {
  return {
    operationId: `operation-${generation}`,
    tenantId: 'tenant-a',
    actorId: 'auth:email_code',
    idempotencyKey: accountCreationGenerationKey(KEY, generation),
    allocationIdempotencyKey: `account-create:${'c'.repeat(64)}`,
    requestHash: HASH,
    userId: `user-${generation}`,
    accountId: `account:user-${generation}`,
    status: 'succeeded',
    publication: null,
  };
}

function write(newest: number, actorId = 'auth:email_code') {
  return executeDurableInitialAccountDirectoryWrite(
    {} as never,
    {
      tenantId: 'tenant-a',
      actorId,
      idempotencyKey: KEY,
      requestHash: HASH,
      candidateOperationId: 'operation-new',
      candidateUserId: 'user-new',
      email: 'person@example.com',
      residencyPolicyId: 'policy-a',
      residencyPartition: 'default',
      onDeletedAccount: 'renew',
    },
    {
      operationRepository: {
        findByIdempotencyKeys: vi.fn(async () => [operation(newest)]),
        // Stops right after the key is chosen.
        acquire: vi.fn(async () => ({ ...operation(newest), status: 'blocked' })),
      } as never,
      // The newest generation's account was deleted and removed.
      readPreviousAccount: vi.fn(async () => 'removed' as const),
      now: () => 100,
      writeAuthoritative: vi.fn(),
    }
  );
}

beforeEach(() => vi.clearAllMocks());

describe('the generations of a key derived from its request', () => {
  it('warns from the sixteenth generation on, without the address', async () => {
    await expect(write(14)).rejects.toThrow('account_creation_operation_blocked');
    expect(mocks.log.warn).not.toHaveBeenCalled();

    await expect(write(15)).rejects.toThrow('account_creation_operation_blocked');
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'Account creation key renewed after many deletions',
      {
        tenantId: 'tenant-a',
        flow: 'auth:email_code',
        generation: 16,
      }
    );
    expect(JSON.stringify(mocks.log.warn.mock.calls)).not.toContain('person@example.com');
  });

  it('audits a refusal once the generations are used up, naming SCIM by kind', async () => {
    const actorId = `scim-token:${'d'.repeat(64)}`;
    await expect(write(31, actorId)).rejects.toThrow('account_creation_generations_exhausted');
    await expect(write(31, actorId)).rejects.toThrow('account_creation_generations_exhausted');

    expect(mocks.createAuditLog).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.createAuditLog.mock.calls as unknown as Array<
      [unknown, { id: string; action: string; metadata: string; tenantId: string }]
    >;
    // One record per key and day: the same refusal sent again writes the same one (its id, its
    // time and its content), so a stored audit is never asked to change.
    expect(second[1]).toEqual(first[1]);
    expect((first[1] as unknown as { createdAt: number }).createdAt % 86_400_000).toBe(0);
    expect(first[1]).toMatchObject({ tenantId: 'tenant-a', action: 'account.creation_refused' });
    expect(JSON.parse(first[1].metadata)).toEqual({
      reason: 'generations_exhausted',
      flow: 'scim',
      generations: 32,
    });
    expect(JSON.stringify(mocks.createAuditLog.mock.calls)).not.toContain('person@example.com');
    expect(JSON.stringify(mocks.createAuditLog.mock.calls)).not.toContain('d'.repeat(64));
  });

  it('still refuses when the audit cannot be written', async () => {
    mocks.createAuditLog.mockRejectedValueOnce(new Error('audit_unavailable'));
    await expect(write(31)).rejects.toThrow('account_creation_generations_exhausted');
    expect(mocks.log.error).toHaveBeenCalledWith(
      'Account creation refusal not audited',
      {},
      expect.any(Error)
    );
  });
});
