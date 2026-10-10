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
import { isIAL, type InitialAssuranceEvidence } from './identity-assurance';

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
