/**
 * What a SAML provider gets when it is added or its metadata is imported and nothing says
 * otherwise: the tenant's NameID format and bindings (`federation.saml_nameid_format`,
 * `saml_sso_binding`, `saml_slo_binding`). They are defaults at that moment, not overrides: a
 * provider keeps what it was given, and a service provider profile's own NameID format and logout
 * binding come before the tenant's.
 *
 * Metadata that names its own NameID format or offers only one binding is read as it always was;
 * that is handled where the metadata is parsed (see parseIdPMetadata and parseSPMetadata in
 * providers.ts). The same defaults also complete a draft when it is edited or enabled later.
 * An incomplete IdP draft defers the automatic NameID format so its first metadata import can
 * supply one; an administrator's explicit choice is always kept.
 */

import type { SAMLSPConfig, SamlProvisioningDefaults } from '@authrim/ar-lib-core';
import { SAML_SP_PROFILE_DEFAULTS } from './profile-defaults';

type ProvisioningConfig = Partial<
  Pick<SAMLSPConfig, 'nameIdFormat' | 'allowedBindings' | 'samlProfile' | 'sloBinding' | 'sloUrl'>
>;

export function fillSAMLProviderProvisioningDefaults<T extends ProvisioningConfig>(
  providerType: 'saml_idp' | 'saml_sp',
  config: T,
  defaults: SamlProvisioningDefaults,
  options: { deferNameIdFormat?: boolean } = {}
): T {
  if (providerType === 'saml_idp') {
    return {
      ...config,
      ...(config.nameIdFormat || !options.deferNameIdFormat
        ? { nameIdFormat: config.nameIdFormat || defaults.nameIdFormat }
        : {}),
      // Only a list that is absent is filled; an empty one is the request's own choice (signed in
      // by POST), as it always was.
      allowedBindings: Array.isArray(config.allowedBindings)
        ? config.allowedBindings
        : [defaults.ssoBinding],
    };
  }

  const profile = config.samlProfile ? SAML_SP_PROFILE_DEFAULTS[config.samlProfile] : undefined;
  const sloBinding =
    config.sloBinding ?? (config.sloUrl ? (profile?.sloBinding ?? defaults.sloBinding) : undefined);
  return {
    ...config,
    nameIdFormat: config.nameIdFormat || profile?.nameIdFormat || defaults.nameIdFormat,
    ...(sloBinding ? { sloBinding } : {}),
  };
}
