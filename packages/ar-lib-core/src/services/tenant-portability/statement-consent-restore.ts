/** The provisioned target and import operation supply identity; portable source rows never do. */
export function statementConsentRestoreIdentity(physicalId: string, restoreEpoch: string) {
  for (const value of [physicalId, restoreEpoch]) {
    if (!value || value.length > 256 || value.includes('\0'))
      throw new Error('statement_consent_restore_identity_invalid');
  }
  return {
    account_id: `restore:${physicalId}`,
    physical_id: physicalId,
    restore_epoch: restoreEpoch,
  };
}

export const STATEMENT_CONSENT_REBOUND_TABLES: ReadonlySet<string> = new Set([
  'statement_consent_key_states',
  'statement_consent_operations',
  'statement_consent_admissions',
]);
