/**
 * The identity assurance columns of a CSV user import: `ial` (IAL1, IAL2 or IAL3) and, optionally,
 * `ial_verified_at` (when the identity was proofed: a date, or a date-time with a time zone).
 *
 * A new account is created with the IAL as `import` evidence of the job (and the tenant's default
 * is then not recorded: the row gives its own). For an account that exists, a row with an IAL
 * replaces what earlier imports asserted, and a row without one keeps it. Evidence of other
 * sources (an administrator, SCIM, the tenant's default) is never touched, so an import cannot
 * lower a person below what those give.
 */

import { parseIsoDate, parseIsoDateTime } from '@authrim/ar-lib-scim';
import { ASSURANCE_IMPORT_COLUMNS } from './admin-shared';
import {
  CanonicalIdentityRepository,
  IAL_FRAMEWORK,
  assuranceEvidenceId,
  isIAL,
  type DatabaseAdapter,
  type IAL,
  type InitialAssuranceEvidence,
} from '@authrim/ar-lib-core';

export const IMPORT_EVIDENCE_TYPE = 'import';

/** What a row asserts. `verifiedAt` is null when the row gives none (the time of the import counts). */
export interface ImportedAssurance {
  ial: IAL;
  verifiedAt: number | null;
}

/** How far ahead of the server's clock `ial_verified_at` may be, for clocks that differ a little. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function parseVerifiedAt(value: string): number {
  // A day that does not exist is not rolled over into the next month: it is refused.
  const ms = parseIsoDate(value) ?? parseIsoDateTime(value);
  if (ms === null) throw new Error(`Invalid ial_verified_at: ${value}`);
  return ms;
}

/**
 * The `ial` and `ial_verified_at` columns carry assurance, so a custom attribute of the tenant
 * with either name could not be loaded from the file as it was before: its value would become
 * evidence. A row with such a column is refused while the tenant has an active attribute named
 * so. The definitions are read for each row that has the columns (one indexed read, nothing for
 * rows without them), never remembered: an attribute activated during a job is seen by the next
 * row. A failed read is thrown, never taken for "no such attribute".
 */
export async function assertAssuranceColumnsFree(
  schemaDb: DatabaseAdapter,
  tenantId: string,
  record: Record<string, string | undefined>
): Promise<void> {
  const used = ASSURANCE_IMPORT_COLUMNS.filter((name) =>
    Object.keys(record).some((key) => key.trim().toLowerCase() === name)
  );
  if (used.length === 0) return;
  const rows = await schemaDb.query<{ field_key: string }>(
    `SELECT field_key FROM custom_claim_schemas
      WHERE tenant_id = ? AND active_field_key IN (${used.map(() => '?').join(', ')})`,
    [tenantId, ...used]
  );
  const names = new Set(rows.map((row) => row.field_key));
  for (const name of used) {
    if (names.has(name)) {
      throw new Error(
        `This tenant has a custom attribute named ${name}, so the ${name} column would be read as identity assurance, not as that attribute: rename the custom attribute or remove the column`
      );
    }
  }
}

/** The assurance a normalized row asserts, or null when it has no `ial`. A bad value throws. */
export function parseImportedAssurance(
  record: Record<string, string | undefined>,
  now: number = Date.now()
): ImportedAssurance | null {
  const rawIal = record.ial?.trim() ?? '';
  const rawVerifiedAt = record.ial_verified_at?.trim() ?? '';
  if (!rawIal) {
    if (rawVerifiedAt) throw new Error('ial_verified_at needs ial');
    return null;
  }
  const ial = rawIal.toUpperCase();
  if (!isIAL(ial)) throw new Error(`Unsupported ial: ${rawIal}`);
  if (!rawVerifiedAt) return { ial, verifiedAt: null };
  const verifiedAt = parseVerifiedAt(rawVerifiedAt);
  if (verifiedAt > now + CLOCK_SKEW_MS)
    throw new Error('ial_verified_at must not be in the future');
  return { ial, verifiedAt };
}

/**
 * What a new account is created with when its row asserts an IAL. The evidence is named by its
 * content (tenant, subject, level, when proofed), as it is when an existing account is updated.
 * A row without `ial_verified_at` is proofed at `importedAt`, the time of the import job.
 */
export function importedAssuranceEvidence(
  assurance: ImportedAssurance,
  jobId: string,
  importedAt: number = Date.now()
): InitialAssuranceEvidence {
  const verifiedAt = assurance.verifiedAt ?? importedAt;
  return {
    level: assurance.ial,
    evidenceType: IMPORT_EVIDENCE_TYPE,
    issuerRef: `import:${jobId}`,
    verifiedAt,
    contentId: { kind: 'import', parts: [assurance.ial, verifiedAt] },
  };
}

/**
 * Makes what imports assert for an account that exists the row's IAL: recorded in place of an
 * earlier import's, kept when the row gives none. A failure is thrown.
 *
 * The row's verification time is resolved once: `ial_verified_at`, or the time of the import job
 * when the row gives none. A claim is its level and that time. It is unchanged when the import
 * evidence in force is exactly that claim; anything else, including the same level proofed at
 * another time, is a new claim, so a row without `ial_verified_at` in a later import states that
 * the person is proofed as of that import. The evidence is identified by the claim (tenant,
 * subject, level, time): the claim recorded before, from any job, is never recorded again, so
 * once an administrator revoked it a row processed again after a failure brings nothing back.
 * Only a new verification (another `ial_verified_at`, level, or import) is new evidence. The
 * result is the same before and after the evidence in force was revoked.
 */
export async function applyImportedAssurance(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  jobId: string,
  importedAt: number,
  assurance: ImportedAssurance | null | undefined
): Promise<'kept' | 'unchanged' | 'recorded'> {
  if (!assurance) return 'kept';
  const verifiedAt = assurance.verifiedAt ?? importedAt;
  const repository = new CanonicalIdentityRepository(adapter, tenantId);
  const source = {
    evidenceType: IMPORT_EVIDENCE_TYPE,
    issuerRef: `import:${jobId}`,
    anyIssuer: true,
  };
  const held = await repository.listActiveAssuranceEvidenceFromSource(userId, source);
  const [only] = held;
  if (
    held.length === 1 &&
    only?.assurance_framework === IAL_FRAMEWORK &&
    only.assurance_level === assurance.ial &&
    only.verified_at === verifiedAt
  ) {
    return 'unchanged';
  }
  const account = await repository.findAccountByLegacyUserId(userId, {
    includeInactive: true,
    consistencyClass: 'primary_required',
  });
  if (!account?.primary_subject_id) throw new Error('import_assurance_subject_missing');
  const id = await assuranceEvidenceId('import', [
    tenantId,
    account.primary_subject_id,
    assurance.ial,
    verifiedAt,
  ]);
  if (await repository.findAssuranceEvidence(id)) return 'unchanged';
  await repository.replaceAssuranceEvidenceFromSource(account.primary_subject_id, source, {
    id,
    assurance_framework: IAL_FRAMEWORK,
    assurance_level: assurance.ial,
    verified_at: verifiedAt,
  });
  return 'recorded';
}
