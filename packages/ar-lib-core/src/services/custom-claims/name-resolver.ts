/**
 * Claim Name Resolver
 *
 * Applies claim_namespace prefix and detects collisions with
 * standard OIDC / JWT reserved claim names.
 */

const STANDARD_CLAIM_NAMES = new Set([
  // JWT registered claims (RFC 7519)
  'sub',
  'iss',
  'aud',
  'exp',
  'iat',
  'jti',
  'nbf',
  // OIDC Core claims
  'auth_time',
  'nonce',
  'at_hash',
  'c_hash',
  'acr',
  'amr',
  'azp',
  'sid',
  'ds_hash',
  // OIDC Standard Claims (Section 5.1)
  'name',
  'given_name',
  'family_name',
  'middle_name',
  'nickname',
  'preferred_username',
  'profile',
  'picture',
  'website',
  'email',
  'email_verified',
  'gender',
  'birthdate',
  'zoneinfo',
  'locale',
  'phone_number',
  'phone_number_verified',
  'address',
  'updated_at',
  'authrim_account_lifecycle',
  // The grant a token was issued under: written by the authorization server only.
  'authrim_consent_generation',
  'authrim_consent_client_id',
  'authrim_subject_issuer',
  'authrim_subject_ref',
  'authrim_subject_principal',
  'original_issuer',
  // How Authrim tells a client or admin principal's token from a user's.
  'token_use',
  'client_id',
  'actor_type',
  'actor_id',
  'actor_mode',
  'grant_id',
]);

export interface CustomClaimSchemaBase {
  field_key: string;
  claim_namespace: string | null;
}

export class ClaimNameResolver {
  resolve(schema: CustomClaimSchemaBase): string {
    if (schema.claim_namespace) {
      return `${schema.claim_namespace}${schema.field_key}`;
    }
    return schema.field_key;
  }

  isStandardClaimCollision(claimName: string): boolean {
    return STANDARD_CLAIM_NAMES.has(claimName);
  }
}
