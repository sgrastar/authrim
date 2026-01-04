/**
 * Assurance Levels Settings (NIST SP 800-63-4)
 *
 * Settings for Authentication Assurance Level (AAL), Federation Assurance Level (FAL),
 * and Identity Assurance Level (IAL) per NIST SP 800-63 Revision 4.
 *
 * API: GET/PUT/DELETE /api/admin/settings/assurance-levels
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
 * AMR (Authentication Methods References) to AAL mapping
 */
export const AMR_TO_AAL: Record<string, AAL> = {
  // AAL1 methods
  pwd: 'AAL1',
  pin: 'AAL1',
  sms: 'AAL1',
  email: 'AAL1',

  // AAL2 methods (multi-factor)
  otp: 'AAL2',
  mfa: 'AAL2',
  swk: 'AAL2', // Software key
  pop: 'AAL2', // Proof of possession

  // AAL3 methods (hardware)
  hwk: 'AAL3', // Hardware key
  fpt: 'AAL3', // Fingerprint (when with hardware)
  face: 'AAL3', // Face recognition (when with hardware)
};

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

  /** Default IAL for new users */
  'assurance.default_ial': IAL;

  /** Require minimum AAL for specific scopes (JSON) */
  'assurance.scope_aal_requirements': string;

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
    envKey: 'NIST_ASSURANCE_LEVELS_ENABLED',
    label: 'Enable Assurance Levels',
    description: 'Enable explicit AAL/FAL/IAL tracking per NIST SP 800-63-4',
  },
  'assurance.default_aal': {
    key: 'assurance.default_aal',
    type: 'enum',
    default: 'AAL1',
    envKey: 'DEFAULT_AAL',
    label: 'Default AAL',
    description: 'Default Authentication Assurance Level',
    enum: ['AAL1', 'AAL2', 'AAL3'],
  },
  'assurance.default_fal': {
    key: 'assurance.default_fal',
    type: 'enum',
    default: 'FAL1',
    envKey: 'DEFAULT_FAL',
    label: 'Default FAL',
    description: 'Default Federation Assurance Level',
    enum: ['FAL1', 'FAL2', 'FAL3'],
  },
  'assurance.default_ial': {
    key: 'assurance.default_ial',
    type: 'enum',
    default: 'IAL1',
    envKey: 'DEFAULT_IAL',
    label: 'Default IAL',
    description: 'Default Identity Assurance Level for new users',
    enum: ['IAL1', 'IAL2', 'IAL3'],
  },
  'assurance.scope_aal_requirements': {
    key: 'assurance.scope_aal_requirements',
    type: 'string',
    default: '{}',
    label: 'Scope AAL Requirements',
    description:
      'JSON mapping of scopes to minimum AAL (e.g., {"admin": "AAL2", "financial": "AAL3"})',
  },
  'assurance.include_in_id_token': {
    key: 'assurance.include_in_id_token',
    type: 'boolean',
    default: true,
    label: 'Include in ID Token',
    description: 'Include acr/amr/aal/fal claims in ID tokens',
  },
  'assurance.include_in_access_token': {
    key: 'assurance.include_in_access_token',
    type: 'boolean',
    default: false,
    label: 'Include in Access Token',
    description: 'Include assurance level claims in access tokens',
    visibility: 'admin',
  },
  'assurance.fal2_requires_dpop': {
    key: 'assurance.fal2_requires_dpop',
    type: 'boolean',
    default: true,
    label: 'FAL2 Requires DPoP',
    description: 'Require DPoP proof-of-possession for FAL2 and higher',
    visibility: 'admin',
  },
  'assurance.fal3_requires_par': {
    key: 'assurance.fal3_requires_par',
    type: 'boolean',
    default: true,
    label: 'FAL3 Requires PAR',
    description: 'Require Pushed Authorization Requests for FAL3',
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
  'assurance.include_in_id_token': true,
  'assurance.include_in_access_token': false,
  'assurance.fal2_requires_dpop': true,
  'assurance.fal3_requires_par': true,
};

/**
 * Determine AAL from authentication methods
 *
 * @param amr - Array of authentication method references
 * @returns The highest AAL level achieved
 */
export function determineAALFromAMR(amr: string[]): AAL {
  if (!amr || amr.length === 0) {
    return 'AAL1';
  }

  let highestAAL: AAL = 'AAL1';

  for (const method of amr) {
    const aal = AMR_TO_AAL[method];
    if (aal === 'AAL3') {
      return 'AAL3'; // Can't get higher
    }
    if (aal === 'AAL2' && highestAAL === 'AAL1') {
      highestAAL = 'AAL2';
    }
  }

  // Multi-factor check: if multiple factors are present, bump to AAL2
  if (amr.length >= 2 && highestAAL === 'AAL1') {
    highestAAL = 'AAL2';
  }

  return highestAAL;
}

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
