import {
  accountDirectoryOutboxId,
  CanonicalIdentityRepository,
  CanonicalRuntimeUserWriter,
  type AccountDirectoryPublication,
  type CanonicalRuntimeUserWriteInput,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';

export interface CanonicalAccountAuthoritativeWriteInput {
  publication: AccountDirectoryPublication;
  tenantCoreUsers: DatabaseAdapter;
  tenantPii: DatabaseAdapter;
  runtimeUser: Omit<CanonicalRuntimeUserWriteInput, 'userId' | 'tenantId'>;
}

export async function writeCanonicalAccountAuthoritative(
  input: CanonicalAccountAuthoritativeWriteInput
): Promise<{ userId: string }> {
  const userId = input.publication.accountId.slice('account:'.length);
  if (
    !userId ||
    `account:${userId}` !== input.publication.accountId ||
    input.publication.tenantId.length === 0
  ) {
    throw new Error('account_creation_authoritative_identity_invalid');
  }
  const repository = new CanonicalIdentityRepository(
    input.tenantCoreUsers,
    input.publication.tenantId
  );
  const writer = new CanonicalRuntimeUserWriter(repository, input.tenantPii);
  const runtimeUser: CanonicalRuntimeUserWriteInput = {
    ...input.runtimeUser,
    userId,
    tenantId: input.publication.tenantId,
  };
  const existing = await repository.findAccountByLegacyUserId(userId, {
    includeInactive: true,
  });
  if (!existing) {
    await writer.createFromRuntimeUser(runtimeUser, input.publication);
  } else {
    const reflected = await input.tenantCoreUsers.queryOne<{ payload_json: string }>(
      `SELECT payload_json FROM account_routing_outbox
        WHERE outbox_id = ? AND tenant_id = ? AND account_id = ?`,
      [
        accountDirectoryOutboxId(input.publication.operationId),
        input.publication.tenantId,
        input.publication.accountId,
      ]
    );
    if (
      existing.id !== input.publication.accountId ||
      reflected?.payload_json !== JSON.stringify(input.publication)
    ) {
      throw new Error('account_creation_authoritative_state_conflict');
    }
    await writer.syncFromRuntimeUser(runtimeUser);
  }
  return { userId };
}
