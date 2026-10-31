/**
 * The identity assurance a SCIM client asserts for a user (the assurance extension of the User
 * resource), kept as evidence of the token's own: `evidence_type = 'scim'`, `issuer_ref =
 * 'scim:<token reference>'`. Each token's claim replaces its own earlier one and never touches
 * another source's evidence (another token's, an administrator's, the tenant's default).
 *
 * A user replaced (PUT) without the extension has the token's claim revoked: a PUT states the
 * whole resource, so leaving the claim out withdraws it. A PATCH changes it only through the
 * extension's paths, or removes it by removing the extension.
 */

import type { Context } from 'hono';
import {
  CanonicalIdentityRepository,
  IAL_FRAMEWORK,
  assuranceEvidenceId,
  isIAL,
  resolveScimMaxIAL,
  scimClaimWithinMaxIAL,
  type AssuranceEvidenceRow,
  type IAL,
  type DatabaseAdapter,
  type Env,
  type InitialAssuranceEvidence,
} from '@authrim/ar-lib-core';
import {
  parseScimAssuranceExtension,
  scimAssuranceExtensionValue,
  SCIM_SCHEMAS,
  type ScimAssuranceClaim,
} from '@authrim/ar-lib-scim';

export const SCIM_EVIDENCE_TYPE = 'scim';

/** What the user resource carries the claim under. */
export const SCIM_ASSURANCE_SCHEMA = SCIM_SCHEMAS.ASSURANCE_USER;

/** The token that authenticated the request (set by the SCIM authentication middleware). */
export function scimTokenRef(c: Context<{ Bindings: Env }>): string {
  const ref = (c as unknown as { get(key: string): unknown }).get('scimTokenRef');
  // A request reaches a handler only past the authentication that sets it; without it nothing
  // can be recorded or revoked on the token's behalf.
  if (typeof ref !== 'string' || ref.length === 0) throw new Error('scim_token_ref_unavailable');
  return ref;
}

export function scimEvidenceSource(tokenRef: string): { evidenceType: string; issuerRef: string } {
  return { evidenceType: SCIM_EVIDENCE_TYPE, issuerRef: `scim:${tokenRef}` };
}

/** The claim a user is created with, as initial evidence. */
export function scimClaimInitialAssurance(
  claim: ScimAssuranceClaim,
  tokenRef: string
): InitialAssuranceEvidence {
  return {
    level: claim.ial,
    ...scimEvidenceSource(tokenRef),
    verifiedAt: claim.verifiedAt,
    expiresAt: claim.expiresAt,
    contentId: claimContentId(claim, tokenRef),
  };
}

/** The claim of a resource already validated (its errors are reported when it is validated). */
export function claimOf(resource: object): ScimAssuranceClaim | null {
  return parseScimAssuranceExtension((resource as Record<string, unknown>)[SCIM_ASSURANCE_SCHEMA])
    .claim;
}

/** Whether two claims (or the absence of both) are the same assertion. */
export function sameClaim(a: ScimAssuranceClaim | null, b: ScimAssuranceClaim | null): boolean {
  if (a === null || b === null) return a === b;
  return a.ial === b.ial && a.verifiedAt === b.verifiedAt && a.expiresAt === b.expiresAt;
}

function claimOfRow(row: AssuranceEvidenceRow): ScimAssuranceClaim | null {
  if (
    row.assurance_framework !== IAL_FRAMEWORK ||
    !isIAL(row.assurance_level) ||
    row.verified_at === null
  ) {
    return null;
  }
  return { ial: row.assurance_level, verifiedAt: row.verified_at, expiresAt: row.expires_at };
}

/** What the token asserts for the user now (none when it asserts nothing). */
export async function readScimAssurance(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  tokenRef: string
): Promise<ScimAssuranceClaim | null> {
  const rows = await new CanonicalIdentityRepository(
    adapter,
    tenantId
  ).listActiveAssuranceEvidenceFromSource(userId, scimEvidenceSource(tokenRef));
  return rows[0] ? claimOfRow(rows[0]) : null;
}

/** The extension as a client reads it, to put in the resource when it is asked for. */
export function scimAssuranceResource(claim: ScimAssuranceClaim): Record<string, string> {
  return scimAssuranceExtensionValue(claim);
}

/**
 * The evidence of a claim is named by its content alone (tenant, subject, token, level, when
 * proofed, expiry), whether it is made when the user is created or later. The rule: identical
 * content never re-activates a revoked claim, whoever revoked it (an administrator, or the client
 * itself by leaving the extension out). To establish a claim again the client sends a new
 * verification: another `verifiedAt`, level or expiry.
 */
function claimContentId(claim: ScimAssuranceClaim, tokenRef: string) {
  return {
    kind: 'scim',
    parts: [tokenRef, claim.ial, claim.verifiedAt, claim.expiresAt] as const,
  };
}

/**
 * Makes what the token asserts for the user `claim`: records it in place of the earlier one (in
 * one batch), or revokes the earlier one when `claim` is null. Nothing is written when it is what
 * the token already asserts, and a claim whose content was recorded before and has been revoked
 * stays revoked ('ignored'). A failure is thrown, never taken for "nothing asserted".
 */
export async function applyScimAssurance(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  tokenRef: string,
  claim: ScimAssuranceClaim | null
): Promise<'unchanged' | 'recorded' | 'revoked' | 'ignored'> {
  const repository = new CanonicalIdentityRepository(adapter, tenantId);
  const source = scimEvidenceSource(tokenRef);
  const current = await repository.listActiveAssuranceEvidenceFromSource(userId, source);
  if (!claim && current.length === 0) return 'unchanged';
  const [only] = current;
  if (claim && current.length === 1 && only) {
    const held = claimOfRow(only);
    if (
      held &&
      held.ial === claim.ial &&
      held.verifiedAt === claim.verifiedAt &&
      held.expiresAt === claim.expiresAt
    ) {
      return 'unchanged';
    }
  }
  const account = await repository.findAccountByLegacyUserId(userId, {
    includeInactive: true,
    consistencyClass: 'primary_required',
  });
  const subjectId = account?.primary_subject_id;
  if (!subjectId) throw new Error('scim_assurance_subject_missing');
  if (!claim) {
    await repository.replaceAssuranceEvidenceFromSource(subjectId, source, null);
    return 'revoked';
  }
  const content = claimContentId(claim, tokenRef);
  const id = await assuranceEvidenceId(content.kind, [tenantId, subjectId, ...content.parts]);
  const known = await repository.findAssuranceEvidence(id);
  if (known) return known.revoked_at === null ? 'unchanged' : 'ignored';
  await repository.replaceAssuranceEvidenceFromSource(subjectId, source, {
    id,
    assurance_framework: IAL_FRAMEWORK,
    assurance_level: claim.ial,
    verified_at: claim.verifiedAt,
    expires_at: claim.expiresAt,
  });
  return 'recorded';
}

/**
 * The claim asserts a level above the ceiling the tenant allows SCIM tokens
 * (`assurance.scim_max_ial`). Nothing is written for the request.
 */
export class ScimIalCeilingError extends Error {
  constructor(readonly ceiling: IAL) {
    super('scim_ial_above_ceiling');
    this.name = 'ScimIalCeilingError';
  }
}

/**
 * Checks, before anything is written, that a claim a request asserts is within the tenant's
 * ceiling for SCIM (`assurance.scim_max_ial`, IAL1 until raised; whether or not assurance levels
 * are enabled). A request without a claim does not read the setting. Resending the claim the
 * token already holds is not a new assertion, so a ceiling lowered later does not block updating
 * a user whose earlier claim is above it (and does not revoke that claim). The setting being
 * unreadable throws `ScimMaxIALUnavailableError`: "no ceiling" is never assumed.
 *
 * `held` reads what the token holds for the user (nothing for a user being created); it is
 * called only for a claim above the ceiling.
 */
export async function assertScimClaimWithinCeiling(
  env: Env,
  tenantId: string,
  claim: ScimAssuranceClaim | null,
  held: () => Promise<ScimAssuranceClaim | null>
): Promise<void> {
  if (!claim) return;
  const ceiling = await resolveScimMaxIAL(env, tenantId);
  if (scimClaimWithinMaxIAL(claim.ial, ceiling)) return;
  if (sameClaim(await held(), claim)) return;
  throw new ScimIalCeilingError(ceiling);
}
