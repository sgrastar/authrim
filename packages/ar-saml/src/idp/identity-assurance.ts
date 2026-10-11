/**
 * Identity assurance (IAL) in the SAML IdP: refusing a person below an SP's minimum, and releasing
 * the assurance attributes (eduPersonAssurance and the IAL itself) a mapping asks for.
 *
 * Both read the person's evidence from their canonical store, each time and never from a cache, so
 * evidence revoked or expired stops them with the next request. When nothing needs it the evidence
 * is not read at all. A read that fails is neither "meets" nor "IAL1": enforcement refuses with a
 * temporary error, and release leaves the attribute out (and logs).
 *
 * Enforcement applies the SP's own minimum (`SAMLSPConfig.minimumIal`) only. The tenant's
 * scope-to-IAL map (`assurance.scope_ial_requirements`) is keyed by OAuth scope and has nothing to
 * match in a SAML request.
 */

import {
  assuranceValuesForIAL,
  evaluateUserIAL,
  parseIALAssuranceValues,
  readClientMinimumIAL,
  resolveEffectiveSettings,
  resolveRequiredIAL,
  resolveUserEffectiveIALOnce,
  type Env,
  type IAL,
  type SAMLSPConfig,
} from '@authrim/ar-lib-core';
import { getSamlUserCoreAdapter } from '../common/user-store';
import {
  findSAMLAssuranceSourceNeeds,
  SAML_ASSURANCE_SUBJECT_KEYS,
  type SAMLAttributeSubject,
  type SAMLIdentityMappingReleaseConfig,
  type SAMLIdentityMappingRuntimeContext,
} from './attributes';

/** What checking a person against an SP's minimum IAL found. */
export type SAMLIdentityAssuranceCheck =
  | { outcome: 'allowed' }
  | { outcome: 'insufficient'; required: IAL; actual: IAL }
  /** The evidence could not be read: the person is not let through, nor judged below the minimum. */
  | { outcome: 'unavailable'; required: IAL; error: unknown };

/**
 * Whether the person may sign in to the SP. With no minimum set the evidence is not read. The
 * request (its Hono context) is the scope an evidence read is shared in, with the assurance
 * attributes of the same request.
 */
export async function checkSAMLIdentityAssurance(
  requestScope: object,
  input: {
    env: Env;
    tenantId: string;
    userId: string;
    spConfig: Pick<SAMLSPConfig, 'minimumIal'>;
  }
): Promise<SAMLIdentityAssuranceCheck> {
  const result = await evaluateUserIAL({
    required: resolveRequiredIAL({
      assuranceSettings: {},
      scope: undefined,
      // A stored minimum that is not a level counts as the highest, never as none.
      clientMinimumIAL: readClientMinimumIAL(input.spConfig.minimumIal),
    }),
    tenantId: input.tenantId,
    userId: input.userId,
    getAdapter: () => getSamlUserCoreAdapter(input.env, input.tenantId, input.userId),
    requestScope,
  });
  switch (result.outcome) {
    case 'not_required':
    case 'met':
      return { outcome: 'allowed' };
    case 'insufficient':
      return { outcome: 'insufficient', required: result.required, actual: result.actual };
    case 'unavailable':
      return { outcome: 'unavailable', required: result.required, error: result.error };
  }
}

/**
 * The subject with the assurance values a mapping releases from it: `assurance_ial` (the IAL) and
 * `edu_person_assurance` (the values of every IAL up to it, from `assurance.ial_assurance_values`).
 *
 * - Nothing is read unless an edge of the mapping that releases attributes reads one of them,
 *   `assurance.enabled` is on, and (for the values) some are configured.
 * - A read that fails releases neither, and is reported through `onError`: never as IAL1.
 * - The values come from the evidence alone: they replace anything the subject carried under the
 *   same names.
 */
export async function withSAMLAssuranceAttributes(
  subject: SAMLAttributeSubject,
  input: {
    requestScope: object;
    env: Env;
    tenantId: string;
    /** The person (the session's user id): the owner of the evidence. */
    userId: string;
    identityMapping: SAMLIdentityMappingReleaseConfig | undefined;
    mappingContext: SAMLIdentityMappingRuntimeContext;
    onError: (message: string, error: unknown) => void;
    now?: number;
  }
): Promise<SAMLAttributeSubject> {
  const base = { ...subject };
  delete base[SAML_ASSURANCE_SUBJECT_KEYS.ial];
  delete base[SAML_ASSURANCE_SUBJECT_KEYS.eduPersonAssurance];
  const needs = findSAMLAssuranceSourceNeeds(input.identityMapping, input.mappingContext);
  if (!needs.ial && !needs.eduPersonAssurance) return base;

  try {
    const settings = await resolveEffectiveSettings(input.env, 'assurance', {
      tenantId: input.tenantId,
    });
    if (settings['assurance.enabled'] !== true) return base;

    const values = parseIALAssuranceValues(settings['assurance.ial_assurance_values']);
    const wantsValues = needs.eduPersonAssurance && Object.keys(values).length > 0;
    if (!needs.ial && !wantsValues) return base;

    const effective = await resolveUserEffectiveIALOnce(
      input.requestScope,
      await getSamlUserCoreAdapter(input.env, input.tenantId, input.userId),
      input.tenantId,
      input.userId,
      input.now ?? Date.now()
    );
    const released = wantsValues ? assuranceValuesForIAL(effective.level, values) : [];
    return {
      ...base,
      ...(needs.ial ? { assurance_ial: effective.level } : {}),
      ...(released.length > 0 ? { edu_person_assurance: released } : {}),
    };
  } catch (error) {
    input.onError('Failed to resolve identity assurance attributes', error);
    return base;
  }
}
