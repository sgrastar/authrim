import {
  accountDirectoryOutboxId,
  CanonicalIdentityRepository,
  CanonicalRuntimeUserWriter,
  type AccountDirectoryPublication,
  type CanonicalRuntimeUserWriteInput,
  type DatabaseAdapter,
  InitialAssuranceRecordError,
  type InitialAssuranceEvidence,
} from '@authrim/ar-lib-core';

export interface CanonicalAccountAuthoritativeWriteInput {
  publication: AccountDirectoryPublication;
  tenantCoreUsers: DatabaseAdapter;
  tenantPii: DatabaseAdapter;
  runtimeUser: Omit<CanonicalRuntimeUserWriteInput, 'userId' | 'tenantId'>;
  /**
   * The identity assurance the account is created with, recorded as evidence in the same store as
   * the account: the tenant's default for accounts the organisation creates, or what the SCIM
   * client or CSV row asserts. Recorded once, also when the write is resumed. Omit it for accounts
   * people create themselves (self-registration, guests, sign-in from another IdP).
   */
  initialAssurance?: InitialAssuranceEvidence | null;
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
  let subjectId: string | null | undefined;
  if (!existing) {
    const created = await writer.createFromRuntimeUser(runtimeUser, input.publication);
    subjectId = created.graph?.subject.id;
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
    subjectId = existing.primary_subject_id;
  }
  if (input.initialAssurance) {
    // After the account, and again on a resumed write: the evidence has a fixed id, so it is
    // recorded once, and a failure here fails the write for the retry to complete.
    if (!subjectId) throw new Error('account_creation_authoritative_subject_missing');
    try {
      await repository.recordInitialAssurance(subjectId, input.initialAssurance);
    } catch (error) {
      throw new InitialAssuranceRecordError(error);
    }
  }
  return { userId };
}
