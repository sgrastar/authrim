/**
 * Assurance Levels Settings (NIST SP 800-63-4)
 *
 * Settings for Authentication Assurance Level (AAL), Federation Assurance Level (FAL),
 * and Identity Assurance Level (IAL) per NIST SP 800-63 Revision 4.
 *
 * API: the Settings API (assurance category)
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Authentication Assurance Level (AAL)
 *
 * AAL1: Single-factor authentication
 * AAL2: Two-factor authentication (something you have + know/are)
 * AAL3: Hardware-based authenticator with verifier impersonation resistance
 */
export type AAL = 'AAL1' | 'AAL2' | 'AAL3';

/**
 * Federation Assurance Level (FAL)
 *
 * FAL1: Bearer assertions (basic OIDC/SAML)
 * FAL2: Proof of possession (DPoP, holder-of-key)
 * FAL3: Cryptographic authenticator + signed assertions
 */
export type FAL = 'FAL1' | 'FAL2' | 'FAL3';

/**
 * Identity Assurance Level (IAL)
 *
 * IAL1: No identity proofing required
 * IAL2: Remote or in-person identity proofing
 * IAL3: In-person identity proofing with physical verification
 */
export type IAL = 'IAL1' | 'IAL2' | 'IAL3';

/**
 * ACR to Assurance Level Mapping
 *
 * Maps OIDC ACR values to NIST assurance levels
 */
export interface ACRAssuranceMapping {
  /** The ACR value (e.g., 'urn:mace:incommon:iap:silver') */
  acr: string;
  /** Corresponding AAL level */
  aal: AAL;
  /** Corresponding FAL level */
  fal: FAL;
  /** Optional IAL level (if identity proofing is associated) */
  ial?: IAL;
  /** Human-readable description */
  description?: string;
}

/**
 * Default ACR to Assurance Level Mappings
 *
 * Based on NIST SP 800-63-4 guidelines and common ACR values
 */
export const DEFAULT_ACR_MAPPINGS: ACRAssuranceMapping[] = [
  {
    acr: 'urn:mace:incommon:iap:bronze',
    aal: 'AAL1',
    fal: 'FAL1',
    description: 'Basic password authentication',
  },
  {
    acr: 'urn:mace:incommon:iap:silver',
    aal: 'AAL2',
    fal: 'FAL1',
    description: 'Multi-factor authentication',
  },
  {
    acr: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password',
    aal: 'AAL1',
    fal: 'FAL1',
    description: 'Simple password authentication',
  },
  {
    acr: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
    aal: 'AAL1',
    fal: 'FAL1',
    description: 'Password over TLS',
  },
  {
    acr: 'urn:oasis:names:tc:SAML:2.0:ac:classes:X509',
    aal: 'AAL3',
    fal: 'FAL3',
    description: 'X.509 certificate authentication',
  },
  {
    acr: 'phishing_resistant',
    aal: 'AAL2',
    fal: 'FAL2',
    description: 'Phishing-resistant authentication (passkeys)',
  },
  {
    acr: 'hardware_key',
    aal: 'AAL3',
    fal: 'FAL3',
    description: 'Hardware security key authentication',
  },
];

/**
 * Assurance Levels Settings Interface
 */
export interface AssuranceLevelsSettings {
  /** Enable explicit assurance level tracking */
  'assurance.enabled': boolean;

  /** Default AAL when not explicitly set */
  'assurance.default_aal': AAL;

  /** Default FAL when not explicitly set */
  'assurance.default_fal': FAL;

  /** The IAL recorded for accounts the organisation creates (admin, SCIM, CSV) */
  'assurance.default_ial': IAL;

  /** Require minimum IAL for specific scopes (JSON) */
  'assurance.scope_ial_requirements': string;

  /** The assurance values (URIs) released for each IAL (JSON) */
  'assurance.ial_assurance_values': string;

  /** The AAL a SAML AuthnContextClassRef stands for (JSON) */
  'assurance.saml_authn_context_aal': string;

  /** The OpenID Connect for Identity Assurance profile verified_claims are released under (JSON) */
  'assurance.ida_profile': string;

  /** Require minimum AAL for specific scopes (JSON) */
  'assurance.scope_aal_requirements': string;

  /** The AAL an external or SAML IdP's acr is taken for (JSON) */
  'assurance.upstream_acr_mappings': string;

  /** The acr values of other vocabularies Authrim may return when asked, with their AAL (JSON) */
  'assurance.outbound_acr_mappings': string;

  /** Include assurance levels in ID token */
  'assurance.include_in_id_token': boolean;

  /** Include assurance levels in access token */
  'assurance.include_in_access_token': boolean;

  /** Require DPoP for FAL2+ */
  'assurance.fal2_requires_dpop': boolean;

  /** Require PAR for FAL3 */
  'assurance.fal3_requires_par': boolean;
}

/**
 * Assurance Levels Settings Metadata
 */
export const ASSURANCE_LEVELS_SETTINGS_META: Record<keyof AssuranceLevelsSettings, SettingMeta> = {
  'assurance.enabled': {
    key: 'assurance.enabled',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_NIST_ASSURANCE_LEVELS',
    label: 'Enable Assurance Levels',
    description:
      'Enforce the AAL and FAL below (NIST SP 800-63-4); off leaves authorization, tokens and discovery as they were',
  },
  'assurance.default_aal': {
    key: 'assurance.default_aal',
    type: 'enum',
    default: 'AAL1',
    envKey: 'DEFAULT_AAL',
    label: 'Default AAL',
    description:
      'The AAL every authorization requires when AAL2 or AAL3: a session below it re-authenticates (guests are exempt). AAL1 requires nothing beyond what a login already does',
    enum: ['AAL1', 'AAL2', 'AAL3'],
  },
  'assurance.default_fal': {
    key: 'assurance.default_fal',
    type: 'enum',
    default: 'FAL1',
    envKey: 'DEFAULT_FAL',
    label: 'Default FAL',
    description:
      'The FAL tokens for a user must meet: FAL1 bearer, FAL2 bound to a DPoP key, FAL3 also from a pushed (PAR) authorization request with a signed request object',
    enum: ['FAL1', 'FAL2', 'FAL3'],
  },
  'assurance.default_ial': {
    key: 'assurance.default_ial',
    // Saved and validated, not applied yet: runtime use lands with the identity assurance work.
    status: 'in_development',
    type: 'enum',
    default: 'IAL1',
    envKey: 'DEFAULT_IAL',
    label: 'Default IAL',
    description:
      'The IAL recorded, as tenant-policy evidence, for accounts the organisation creates (by an administrator, SCIM or a CSV import) when IAL2 or IAL3. Self-registration, guests and sign-in from another IdP are never given it (not applied yet)',
    enum: ['IAL1', 'IAL2', 'IAL3'],
  },
  'assurance.scope_aal_requirements': {
    key: 'assurance.scope_aal_requirements',
    type: 'string',
    default: '{}',
    label: 'Scope AAL Requirements',
    description:
      'JSON mapping of scopes to the AAL they require (e.g., {"admin": "AAL2", "financial": "AAL3"}); a request for such a scope re-authenticates until it is met',
  },
  'assurance.upstream_acr_mappings': {
    key: 'assurance.upstream_acr_mappings',
    type: 'string',
    default: '{}',
    label: 'Upstream ACR Mappings',
    description:
      'JSON mapping of the acr (or SAML AuthnContextClassRef) an external IdP returns to the AAL it is taken for (e.g., {"urn:mace:incommon:iap:silver": "AAL2"}); unmapped logins count as AAL1',
  },
  'assurance.outbound_acr_mappings': {
    key: 'assurance.outbound_acr_mappings',
    type: 'string',
    default: '{}',
    label: 'Outbound ACR Mappings',
    description:
      'JSON mapping of acr values from another vocabulary that Authrim may return to a client, to the AAL each requires (e.g., {"urn:mace:incommon:iap:silver": "AAL2", "urn:mace:incommon:iap:bronze": "AAL1"}). A client asking for one in acr_values (or as an essential acr) is stepped up to that AAL like for urn:authrim:aal:N and gets the value back once it is met; values not listed are never returned. The opposite direction of Upstream ACR Mappings',
  },
  'assurance.scope_ial_requirements': {
    key: 'assurance.scope_ial_requirements',
    // Saved and validated, not applied yet: runtime use lands with the identity assurance work.
    status: 'in_development',
    type: 'string',
    default: '{}',
    label: 'Scope IAL Requirements',
    description:
      'JSON mapping of scopes to the IAL they require (e.g., {"payroll": "IAL2"}); a request for such a scope by someone below it is refused (access_denied), since no sign-in can raise an IAL. Applies while assurance levels are enabled (not applied yet)',
  },
  'assurance.ial_assurance_values': {
    key: 'assurance.ial_assurance_values',
    // Saved and validated, not applied yet: runtime use lands with the identity assurance work.
    status: 'in_development',
    type: 'string',
    default: '{}',
    label: 'IAL Assurance Values',
    description:
      'JSON mapping of each IAL to the assurance values (URIs) released for it, e.g. {"IAL2": ["https://www.gakunin.jp/profile/IAL2"]}. A person gets the values of every IAL up to theirs, as the SAML attribute eduPersonAssurance (through attribute mapping) and the OIDC claim eduperson_assurance. Applies while assurance levels are enabled (not applied yet)',
  },
  'assurance.saml_authn_context_aal': {
    key: 'assurance.saml_authn_context_aal',
    // Saved and validated, not applied yet: runtime use lands with the identity assurance work.
    status: 'in_development',
    type: 'string',
    default: '{}',
    label: 'SAML AuthnContext AAL',
    description:
      'JSON mapping of SAML AuthnContextClassRef values to the AAL each stands for, e.g. {"https://www.gakunin.jp/profile/AAL2": "AAL2"}. An SP requesting one is answered only from a session at that AAL, after re-authentication if needed. Applies while assurance levels are enabled (not applied yet)',
  },
  'assurance.ida_profile': {
    key: 'assurance.ida_profile',
    // Saved and validated, not applied yet: runtime use lands with the identity assurance work.
    status: 'in_development',
    type: 'string',
    default: '{}',
    label: 'Identity Assurance Profile',
    description:
      'JSON describing the OpenID Connect for Identity Assurance verified_claims released to a client that requests them: {"trust_framework": "…", "assurance_levels": {"IAL2": "…"}, "claims": ["given_name", "family_name", "birthdate"]}. Empty releases no verified_claims. Released only for people at IAL2 or above, and only claims the request and its scopes allow. Applies while assurance levels are enabled (not applied yet)',
  },
  'assurance.include_in_id_token': {
    key: 'assurance.include_in_id_token',
    type: 'boolean',
    default: true,
    label: 'Include in ID Token',
    description:
      'Give ID tokens an acr of the form urn:authrim:aal:N: the most preferred requested value the authentication meets (Outbound ACR Mappings included), otherwise the acr of the AAL reached (none at AAL0); an essential acr request always gets one of its values',
  },
  'assurance.include_in_access_token': {
    key: 'assurance.include_in_access_token',
    type: 'boolean',
    default: false,
    label: 'Include in Access Token',
    description:
      'Give access tokens from an authorization (the authorization code, implicit and hybrid flows, and refreshes of them) auth_time, the acr of the AAL reached and the methods the authentication proved (RFC 9068)',
    visibility: 'admin',
  },
  'assurance.fal2_requires_dpop': {
    key: 'assurance.fal2_requires_dpop',
    type: 'boolean',
    default: true,
    label: 'FAL2 Requires DPoP',
    description:
      'At FAL2 and above, refuse token requests without a DPoP proof and access tokens from the authorization endpoint',
    visibility: 'admin',
  },
  'assurance.fal3_requires_par': {
    key: 'assurance.fal3_requires_par',
    type: 'boolean',
    default: true,
    label: 'FAL3 Requires PAR',
    description:
      'At FAL3, accept only pushed (PAR) authorization requests whose request object the client signed, and refuse flows without one (device, CIBA, token exchange and others)',
    visibility: 'admin',
  },
};

/**
 * Assurance Levels Category Metadata
 */
export const ASSURANCE_LEVELS_CATEGORY_META: CategoryMeta = {
  category: 'assurance',
  label: 'Assurance Levels',
  description: 'NIST SP 800-63-4 assurance level configuration',
  settings: ASSURANCE_LEVELS_SETTINGS_META,
};

/**
 * Default Assurance Levels settings values
 */
export const ASSURANCE_LEVELS_DEFAULTS: AssuranceLevelsSettings = {
  'assurance.enabled': false,
  'assurance.default_aal': 'AAL1',
  'assurance.default_fal': 'FAL1',
  'assurance.default_ial': 'IAL1',
  'assurance.scope_aal_requirements': '{}',
  'assurance.upstream_acr_mappings': '{}',
  'assurance.outbound_acr_mappings': '{}',
  'assurance.scope_ial_requirements': '{}',
  'assurance.ial_assurance_values': '{}',
  'assurance.saml_authn_context_aal': '{}',
  'assurance.ida_profile': '{}',
  'assurance.include_in_id_token': true,
  'assurance.include_in_access_token': false,
  'assurance.fal2_requires_dpop': true,
  'assurance.fal3_requires_par': true,
};

/**
 * Determine FAL based on token binding and assertion signing
 *
 * @param hasDPoP - Whether DPoP proof is present
 * @param hasPAR - Whether request came via PAR
 * @param hasSignedRequest - Whether request object is signed
 * @returns The FAL level
 */
export function determineFAL(hasDPoP: boolean, hasPAR: boolean, hasSignedRequest: boolean): FAL {
  if (hasDPoP && hasPAR && hasSignedRequest) {
    return 'FAL3';
  }
  if (hasDPoP) {
    return 'FAL2';
  }
  return 'FAL1';
}

/**
 * Compare assurance levels
 *
 * @param a - First level
 * @param b - Second level
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
export function compareAAL(a: AAL, b: AAL): number {
  const order: Record<AAL, number> = { AAL1: 1, AAL2: 2, AAL3: 3 };
  return order[a] - order[b];
}

export function compareFAL(a: FAL, b: FAL): number {
  const order: Record<FAL, number> = { FAL1: 1, FAL2: 2, FAL3: 3 };
  return order[a] - order[b];
}

export function compareIAL(a: IAL, b: IAL): number {
  const order: Record<IAL, number> = { IAL1: 1, IAL2: 2, IAL3: 3 };
  return order[a] - order[b];
}
