/**
 * The tenant's institution in an assertion: the scope its scoped attributes must be under, and the
 * attributes a mapping may release about the institution itself (schacHomeOrganization and the
 * organization name, `o`).
 *
 * The institution is the tenant's setting (`institution.*`, set by the platform), read when the
 * assertion is issued. A tenant that has set none is released as before.
 *
 * The two institution attributes are system sources: the subject carries them only when this puts
 * them there, from the settings and never from user data, and only when a mapping that releases
 * them reads them. A mapping that does not ask for them gets nothing added.
 */
import { institutionFromSettings, resolveEffectiveSettings, type Env } from '@authrim/ar-lib-core';
import {
  buildSAMLAttributesForSPWithDiagnostics,
  SAML_INSTITUTION_SUBJECT_KEYS,
  type SAMLAttributeReleaseConfig,
  type SAMLAttributeReleaseResult,
  type SAMLAttributeSubject,
} from './attributes';
import type { SAMLInstitutionScopePolicy } from './institution-scope';

/** What the tenant's institution settings say, for one assertion. */
export interface SAMLInstitutionRelease {
  /** The scopes the scoped attributes must be under (or that they cannot be told). */
  scopePolicy: SAMLInstitutionScopePolicy;
  /** The default scope, when scopes are registered. */
  homeOrganization?: string;
  /** The institution's name as the `o` attribute carries it. */
  organizationName?: string;
  /** Every name the tenant registered, in any language: the values `o` may have. */
  registeredNames?: readonly string[];
}

/**
 * Reads the tenant's institution.
 *
 * When the settings cannot be read it is not known whether scopes are registered, so the policy is
 * `unavailable` (the scoped values are withheld) and `onError` hears of it.
 */
export async function loadSAMLInstitutionRelease(
  env: Env,
  tenantId: string,
  onError: (message: string, error: unknown) => void
): Promise<SAMLInstitutionRelease> {
  try {
    const institution = institutionFromSettings(
      await resolveEffectiveSettings(env, 'institution', { tenantId })
    );
    const names = institution.displayNames;
    return {
      // Saved names that are not valid are as untrustworthy as saved scopes that are not (invalid
      // scopes are the more specific answer).
      scopePolicy:
        institution.namesInvalid && institution.scopes.state !== 'invalid'
          ? { state: 'names_invalid' }
          : institution.scopes,
      ...(institution.scopes.state === 'set'
        ? { homeOrganization: institution.scopes.defaultScope }
        : {}),
      // The attribute has no language: the English name (a saved set of names always has one).
      ...(names.en ? { organizationName: names.en } : {}),
      ...(Object.keys(names).length > 0 ? { registeredNames: Object.values(names) } : {}),
    };
  } catch (error) {
    onError('Failed to read the tenant institution settings', error);
    return { scopePolicy: { state: 'unavailable' } };
  }
}

/**
 * Releases the attributes of the mapping with the tenant's institution applied: the scoped
 * attributes only under its scopes, and the institution sources a mapping reads filled from its
 * settings.
 *
 * The settings are read once for every release (they are cached), and the mapping runs once, with
 * the scopes in hand: the scoped values are checked before the required attributes are, so a
 * missing required attribute and a withheld scoped value are reported together.
 */
export async function releaseSAMLAttributesWithInstitution(input: {
  env: Env;
  tenantId: string;
  subject: SAMLAttributeSubject;
  /** The release config, without the institution. */
  releaseConfig: SAMLAttributeReleaseConfig;
  onError: (message: string, error: unknown) => void;
}): Promise<SAMLAttributeReleaseResult> {
  const institution = await loadSAMLInstitutionRelease(input.env, input.tenantId, input.onError);
  return buildSAMLAttributesForSPWithDiagnostics(
    withSAMLInstitutionAttributes(input.subject, institution),
    {
      ...input.releaseConfig,
      institutionScope: institution.scopePolicy,
      institutionNames: institution.registeredNames,
    }
  );
}

/**
 * The subject with the institution values a mapping can release from it: `schac_home_organization`
 * and `organization_name`. They replace anything the subject carried under the same names. Only an
 * edge of the mapping that reads one of these system sources releases it.
 */
export function withSAMLInstitutionAttributes(
  subject: SAMLAttributeSubject,
  institution: SAMLInstitutionRelease
): SAMLAttributeSubject {
  const base = { ...subject };
  delete base[SAML_INSTITUTION_SUBJECT_KEYS.homeOrganization];
  delete base[SAML_INSTITUTION_SUBJECT_KEYS.organizationName];
  return {
    ...base,
    ...(institution.homeOrganization
      ? { [SAML_INSTITUTION_SUBJECT_KEYS.homeOrganization]: institution.homeOrganization }
      : {}),
    ...(institution.organizationName
      ? { [SAML_INSTITUTION_SUBJECT_KEYS.organizationName]: institution.organizationName }
      : {}),
  };
}
