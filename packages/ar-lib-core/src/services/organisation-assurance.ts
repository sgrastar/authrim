/**
 * The identity assurance an account is created with when the organisation creates it (an
 * administrator, SCIM or a CSV import): the tenant's `assurance.default_ial`, recorded as
 * `tenant_policy` evidence, or what the provisioning source itself asserts.
 *
 * Accounts people create themselves (self-registration, guests, sign-in from another IdP) are
 * never given it. The setting applies whenever it is set, whether or not assurance levels are
 * enabled: the evidence is read when a requirement or an issuance needs it.
 */

import type { IAL } from '../types/settings/assurance-levels';
import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';
import { isIAL, maxIAL, type InitialAssuranceEvidence } from './identity-assurance';
import { SCIM_MAX_IAL_MAX, SCIM_MAX_IAL_MIN } from '../types/settings/assurance-levels';

/** The evidence type, and issuer, of the tenant's default for accounts the organisation creates. */
export const TENANT_POLICY_EVIDENCE_TYPE = 'tenant_policy';
export const TENANT_POLICY_ISSUER_REF = 'tenant_policy';

/**
 * `assurance.default_ial` could not be read (or is not a level). Creating the account anyway would
 * leave it without the evidence the tenant's policy gives it, so the creation is refused.
 */
export class DefaultIALUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('default_ial_unavailable');
    this.name = 'DefaultIALUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** The tenant's `assurance.default_ial`; throws {@link DefaultIALUnavailableError} when it cannot be read. */
export async function resolveOrganisationDefaultIAL(
  env: EffectiveSettingsEnv,
  tenantId: string
): Promise<IAL> {
  let value: unknown;
  try {
    value = (await resolveEffectiveSettings(env, 'assurance', { tenantId }))[
      'assurance.default_ial'
    ];
  } catch (error) {
    throw new DefaultIALUnavailableError(error);
  }
  if (!isIAL(value)) throw new DefaultIALUnavailableError();
  return value;
}

/**
 * The evidence the tenant's default gives an account the organisation creates; null at IAL1, which
 * records nothing. Throws {@link DefaultIALUnavailableError} when the setting cannot be read.
 */
export async function resolveTenantPolicyInitialAssurance(
  env: EffectiveSettingsEnv,
  tenantId: string,
  now: number = Date.now()
): Promise<InitialAssuranceEvidence | null> {
  const level = await resolveOrganisationDefaultIAL(env, tenantId);
  if (level === 'IAL1') return null;
  return {
    level,
    evidenceType: TENANT_POLICY_EVIDENCE_TYPE,
    issuerRef: TENANT_POLICY_ISSUER_REF,
    verifiedAt: now,
  };
}

/**
 * `assurance.scim_max_ial` could not be read, or holds something that is not a level (1 to 3). A
 * SCIM claim is then neither accepted nor refused as above the ceiling: the request fails, as
 * "no ceiling" is never assumed.
 */
export class ScimMaxIALUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('scim_max_ial_unavailable');
    this.name = 'ScimMaxIALUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * The highest IAL a SCIM token may assert through the assurance extension (the tenant's
 * `assurance.scim_max_ial`; IAL1 until it is raised). It limits SCIM-asserted evidence only: not
 * what an administrator records, the default IAL for accounts the organisation creates, or a CSV
 * import. It applies whether or not assurance levels are enabled. Throws
 * {@link ScimMaxIALUnavailableError} when it cannot be read.
 */
export async function resolveScimMaxIAL(env: EffectiveSettingsEnv, tenantId: string): Promise<IAL> {
  let value: unknown;
  try {
    value = (await resolveEffectiveSettings(env, 'assurance', { tenantId }))[
      'assurance.scim_max_ial'
    ];
  } catch (error) {
    throw new ScimMaxIALUnavailableError(error);
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < SCIM_MAX_IAL_MIN ||
    value > SCIM_MAX_IAL_MAX
  ) {
    throw new ScimMaxIALUnavailableError();
  }
  return `IAL${value}` as IAL;
}

/** Whether a SCIM claim of `claimed` is within the ceiling `max`. */
export function scimClaimWithinMaxIAL(claimed: IAL, max: IAL): boolean {
  return maxIAL(claimed, max) === max;
}
