/**
 * Institution Settings Category
 *
 * The institution a tenant stands for: the scopes its users' identifiers and affiliations are
 * issued under (a domain such as `example.ac.jp`) and the institution's name in each language.
 * The SAML IdP releases scoped attributes (eduPersonScopedAffiliation, eduPersonPrincipalName) only
 * under these scopes, publishes them in its metadata (shibmd:Scope) and names the institution in
 * its metadata (md:Organization).
 *
 * Tenant scope only, and only the platform can change them (see `CATEGORY_SCOPE_CONFIG`): a scope
 * says which domain an identity provider speaks for, so a tenant administrator cannot claim one.
 * There is no environment variable: the values are the institution's own, not the deployment's.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/institution
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface InstitutionSettings {
  'institution.scopes': string;
  'institution.display_names': string;
}

export const INSTITUTION_SCOPES_KEY = 'institution.scopes';
export const INSTITUTION_DISPLAY_NAMES_KEY = 'institution.display_names';

/** The most scopes an institution may hold, and the most languages its name may be given in. */
export const MAX_INSTITUTION_SCOPES = 20;
export const MAX_INSTITUTION_DISPLAY_NAMES = 16;
/** The longest name, in UTF-16 code units. */
export const MAX_INSTITUTION_NAME_LENGTH = 200;
/** The languages a name must be given in. */
export const REQUIRED_INSTITUTION_NAME_LANGUAGES: readonly string[] = ['ja', 'en'];

export const INSTITUTION_SETTINGS_META: Record<keyof InstitutionSettings, SettingMeta> = {
  'institution.scopes': {
    key: 'institution.scopes',
    scopes: ['tenant'],
    type: 'string',
    default: '',
    label: 'Institution Scopes',
    description:
      'Comma-separated domain names (lowercase, no wildcard, at most 20) the institution issues identifiers and affiliations under, the first being the default, e.g. "example.ac.jp,med.example.ac.jp". Only the platform can change it. While set, the SAML IdP releases eduPersonScopedAffiliation and eduPersonPrincipalName only under these scopes (a value under another scope is withheld, and recorded without the value; a value with no scope gets the default), publishes them in its metadata (shibmd:Scope), and releases the default as schacHomeOrganization to a service provider whose field mapping set maps the system source Home Organization to it. Empty (the default) leaves scoped attributes as the users\' own values say, with no scope in the metadata; schacHomeOrganization is then never released (and the organization name only if names are registered). It does not apply to OIDC',
  },
  'institution.display_names': {
    key: 'institution.display_names',
    scopes: ['tenant'],
    type: 'string',
    default: '{}',
    label: 'Institution Names',
    description:
      'JSON text mapping a language tag to the institution\'s name, e.g. {"ja": "例大学", "en": "Example University"}; ja and en are required, at most 16 languages. Only the platform can change it. While set, the SAML IdP metadata names the institution with it (md:Organization) and releases the English name as the organization name attribute (o) to a service provider whose field mapping set maps the system source Organization Name to it. Empty (the default) keeps the metadata\'s own organization and releases no name. It does not apply to OIDC',
  },
};

export const INSTITUTION_CATEGORY_META: CategoryMeta = {
  category: 'institution',
  label: 'Institution',
  description: 'The institution a tenant stands for: its scopes and its name',
  settings: INSTITUTION_SETTINGS_META,
};

export const INSTITUTION_DEFAULTS: InstitutionSettings = {
  'institution.scopes': '',
  'institution.display_names': '{}',
};
