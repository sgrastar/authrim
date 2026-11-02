/**
 * Built-in OpenID4VCI Credential Configurations
 *
 * Single source for issuer metadata, credential issuance and deferred issuance. Every
 * configuration is `dc+sd-jwt`, signed with ES256 and bound to a holder `jwk`.
 *
 * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#appendix-A.3
 */

import { ADMIN_CREDENTIAL_CONFIGURATION_ID } from '@authrim/ar-lib-core';

export type CredentialSubjectKind = 'end_user' | 'admin';

interface LocalizedName {
  name: string;
  locale: string;
}

export interface CredentialClaimDescriptor {
  path: string[];
  mandatory?: boolean;
  display?: LocalizedName[];
}

export interface CredentialDisplay extends LocalizedName {
  background_color?: string;
  text_color?: string;
}

export interface CredentialConfigurationDefinition {
  id: string;
  vct: string;
  scope: string;
  /** Who a credential of this configuration is issued to. Admin configurations are reserved. */
  subjectKind: CredentialSubjectKind;
  /** Top-level claim names issued as SD-JWT disclosures. */
  selectivelyDisclosableClaims: string[];
  /** Lifetime written to `exp`, in seconds. */
  validitySeconds: number;
  display: CredentialDisplay[];
  claims: CredentialClaimDescriptor[];
}

const DAY_SECONDS = 86_400;

const CONFIGURATIONS: readonly CredentialConfigurationDefinition[] = [
  {
    id: 'AuthrimIdentityCredential',
    vct: 'https://authrim.com/credentials/identity/v1',
    scope: 'authrim_identity_credential',
    subjectKind: 'end_user',
    selectivelyDisclosableClaims: ['given_name', 'family_name', 'email', 'birthdate'],
    validitySeconds: 365 * DAY_SECONDS,
    display: [
      {
        name: 'Authrim Identity Credential',
        locale: 'en',
        background_color: '#1E3A8A',
        text_color: '#FFFFFF',
      },
    ],
    claims: [
      { path: ['given_name'], display: [{ name: 'Given Name', locale: 'en' }] },
      { path: ['family_name'], display: [{ name: 'Family Name', locale: 'en' }] },
      { path: ['email'], display: [{ name: 'Email', locale: 'en' }] },
      { path: ['birthdate'], display: [{ name: 'Date of Birth', locale: 'en' }] },
    ],
  },
  {
    id: 'AuthrimAgeVerification',
    vct: 'https://authrim.com/credentials/age-verification/v1',
    scope: 'authrim_age_verification',
    subjectKind: 'end_user',
    selectivelyDisclosableClaims: ['age_over_18', 'age_over_21'],
    validitySeconds: 365 * DAY_SECONDS,
    display: [
      {
        name: 'Age Verification',
        locale: 'en',
        background_color: '#047857',
        text_color: '#FFFFFF',
      },
    ],
    claims: [
      {
        path: ['age_over_18'],
        mandatory: true,
        display: [{ name: 'Age Over 18', locale: 'en' }],
      },
      { path: ['age_over_21'], display: [{ name: 'Age Over 21', locale: 'en' }] },
    ],
  },
  {
    id: ADMIN_CREDENTIAL_CONFIGURATION_ID,
    vct: 'https://authrim.com/credentials/admin/v1',
    scope: 'authrim_admin_credential',
    subjectKind: 'admin',
    selectivelyDisclosableClaims: ['email', 'name'],
    validitySeconds: 30 * DAY_SECONDS,
    display: [
      { name: 'Authrim administrator', locale: 'en' },
      { name: 'Authrim 管理者', locale: 'ja' },
    ],
    claims: [
      {
        path: ['tenant_id'],
        mandatory: true,
        display: [
          { name: 'Tenant', locale: 'en' },
          { name: 'テナント', locale: 'ja' },
        ],
      },
      {
        path: ['name'],
        display: [
          { name: 'Name', locale: 'en' },
          { name: '名前', locale: 'ja' },
        ],
      },
      {
        path: ['email'],
        display: [
          { name: 'Email', locale: 'en' },
          { name: 'メールアドレス', locale: 'ja' },
        ],
      },
    ],
  },
];

const BY_ID = new Map(CONFIGURATIONS.map((configuration) => [configuration.id, configuration]));

/** Signing and proof algorithm actually implemented by the issuer and the proof validator. */
export const VCI_SIGNING_ALGORITHM = 'ES256';

export function listCredentialConfigurations(): readonly CredentialConfigurationDefinition[] {
  return CONFIGURATIONS;
}

export function getCredentialConfiguration(
  id: string | undefined
): CredentialConfigurationDefinition | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined;
}

/** Whether a configuration may only be issued through the dedicated admin path. */
export function isReservedCredentialConfiguration(id: string): boolean {
  return BY_ID.get(id)?.subjectKind === 'admin';
}

/** The `credential_configurations_supported` entry for issuer metadata (Final, Appendix A.3). */
export function toCredentialConfigurationMetadata(
  configuration: CredentialConfigurationDefinition
): Record<string, unknown> {
  return {
    format: 'dc+sd-jwt',
    scope: configuration.scope,
    vct: configuration.vct,
    cryptographic_binding_methods_supported: ['jwk'],
    credential_signing_alg_values_supported: [VCI_SIGNING_ALGORITHM],
    proof_types_supported: {
      jwt: { proof_signing_alg_values_supported: [VCI_SIGNING_ALGORITHM] },
    },
    credential_metadata: {
      display: configuration.display,
      claims: configuration.claims,
    },
  };
}
