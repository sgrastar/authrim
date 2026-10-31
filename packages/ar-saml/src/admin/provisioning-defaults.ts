/**
 * What a SAML provider gets when it is added or its metadata is imported and nothing says
 * otherwise: the tenant's NameID format and bindings (`federation.saml_nameid_format`,
 * `saml_sso_binding`, `saml_slo_binding`). They are defaults at that moment, not overrides: a
 * provider keeps what it was given, and a service provider profile's own NameID format and logout
 * binding come before the tenant's.
 *
 * Metadata that names its own NameID format or offers only one binding is read as it always was;
 * that is handled where the metadata is parsed (see parseIdPMetadata and parseSPMetadata in
 * providers.ts). This covers a provider added without metadata.
 */

import type { SAMLIdPConfig, SAMLSPConfig, SamlProvisioningDefaults } from '@authrim/ar-lib-core';
import { SAML_SP_PROFILE_DEFAULTS } from './profile-defaults';

export function fillSAMLProviderProvisioningDefaults<T extends SAMLIdPConfig | SAMLSPConfig>(
  providerType: 'saml_idp' | 'saml_sp',
  config: T,
  defaults: SamlProvisioningDefaults
): T {
  if (providerType === 'saml_idp') {
    const idp = config as SAMLIdPConfig;
    return {
      ...idp,
      nameIdFormat: idp.nameIdFormat || defaults.nameIdFormat,
      // Only a list that is absent is filled; an empty one is the request's own choice (signed in
      // by POST), as it always was.
      allowedBindings: Array.isArray(idp.allowedBindings)
        ? idp.allowedBindings
        : [defaults.ssoBinding],
    } as T;
  }

  const sp = config as SAMLSPConfig;
  const profile = sp.samlProfile ? SAML_SP_PROFILE_DEFAULTS[sp.samlProfile] : undefined;
  const sloBinding =
    sp.sloBinding ?? (sp.sloUrl ? (profile?.sloBinding ?? defaults.sloBinding) : undefined);
  return {
    ...sp,
    nameIdFormat: sp.nameIdFormat || profile?.nameIdFormat || defaults.nameIdFormat,
    ...(sloBinding ? { sloBinding } : {}),
  } as T;
}
