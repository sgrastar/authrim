import { z } from 'zod';
import { importJWK } from 'jose';
import {
  safeFetchJson,
  validateWebhookUrl,
  CLIENT_ASSERTION_SIGNING_ALGS,
} from '@authrim/ar-lib-core';
import {
  keyRecord,
  publicClientJwksProblem,
  publicSigningAlgorithm,
} from '@authrim/ar-lib-core/utils/public-client-keys';

const publicUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    const result = validateWebhookUrl(value, false);
    return (
      value.startsWith('https://') &&
      result.valid &&
      !new URL(value).username &&
      !new URL(value).password
    );
  }, 'Use a public HTTPS URL without credentials or fragments');
const optionalUrl = z.union([publicUrl, z.literal(''), z.null()]).optional();
export const adminClientAdvancedSchema = z.object({
  enabled: z.boolean().optional(),
  backchannel_token_delivery_mode: z.enum(['poll', 'ping', 'push']).nullable().optional(),
  backchannel_client_notification_endpoint: publicUrl.nullable().optional(),
  backchannel_authentication_request_signing_alg: z
    .enum(CLIENT_ASSERTION_SIGNING_ALGS)
    .nullable()
    .optional(),
  backchannel_user_code_parameter: z.boolean().optional(),
  logo_uri: optionalUrl,
  client_uri: optionalUrl,
  policy_uri: optionalUrl,
  tos_uri: optionalUrl,
  skip_consent: z.boolean().optional(),
  token_exchange_allowed: z.boolean().optional(),
  client_credentials_allowed: z.boolean().optional(),
  default_audience: z.string().max(2048).nullable().optional(),
  jwks: z.record(z.string(), z.unknown()).nullable().optional(),
  jwks_uri: publicUrl.nullable().optional(),
  token_endpoint_auth_signing_alg: z.enum(CLIENT_ASSERTION_SIGNING_ALGS).nullable().optional(),
  contacts: z.array(z.email().max(254)).max(20).nullable().optional(),
  post_logout_redirect_uris: z.array(publicUrl).max(20).nullable().optional(),
  frontchannel_logout_uri: optionalUrl,
  backchannel_logout_uri: optionalUrl,
  frontchannel_logout_session_required: z.boolean().optional(),
  backchannel_logout_session_required: z.boolean().optional(),
  tls_client_certificate_bound_access_tokens: z.boolean().optional(),
});

/** Existing Admin fields that the repository consumes directly, bounded at the HTTP boundary. */
export const adminClientUpdateEnvelopeSchema = adminClientAdvancedSchema
  .extend({
    client_name: z.string().max(256).optional(),
    response_types: z.array(z.string().max(128)).max(20).optional(),
    scope: z.string().max(8192).nullable().optional(),
    is_trusted: z.boolean().optional(),
    allow_claims_without_scope: z.boolean().optional(),
    initiate_login_uri: z.string().max(2048).nullable().optional(),
    login_ui_url: z.string().max(2048).nullable().optional(),
    default_scope: z.string().max(8192).nullable().optional(),
    delegation_mode: z.enum(['none', 'delegation', 'impersonation']).optional(),
    subject_type: z.enum(['public', 'pairwise']).optional(),
    sector_identifier_uri: z.string().max(2048).nullable().optional(),
  })
  .passthrough();

interface KeySettings {
  jwks?: unknown;
  jwks_uri?: string | null;
  token_endpoint_auth_signing_alg?: string | null;
}
/** Repository rows retain serialized JWKS; validate their decoded key material. */
export async function storedClientKeySettingsProblem(
  settings: KeySettings,
  method: string,
  verifyRemote: boolean,
  requireComplete = true
): Promise<string | undefined> {
  let jwks = settings.jwks;
  if (typeof jwks === 'string' && jwks) {
    try {
      jwks = JSON.parse(jwks) as unknown;
    } catch {
      return 'Stored JWKS must be replaced explicitly';
    }
  }
  return clientKeySettingsProblem({ ...settings, jwks }, method, verifyRemote, requireComplete);
}

/** Validate the resulting state before the single repository write. URI transport is SSRF bounded. */
export async function clientKeySettingsProblem(
  settings: KeySettings,
  method: string,
  verifyRemote: boolean,
  requireComplete = true
): Promise<string | undefined> {
  if (settings.jwks && settings.jwks_uri) return 'Choose either jwks or jwks_uri, never both';
  if (requireComplete && method === 'private_key_jwt' && !settings.jwks && !settings.jwks_uri)
    return 'private_key_jwt requires public jwks or a public HTTPS jwks_uri';
  let jwks = settings.jwks;
  if (settings.jwks_uri && verifyRemote && method === 'private_key_jwt') {
    try {
      jwks = await safeFetchJson<unknown>(settings.jwks_uri, {
        requireHttps: true,
        redirect: 'error',
        timeoutMs: 5000,
        maxResponseSize: 65536,
      });
      if (!jwks) return 'Invalid public JWKS';
    } catch {
      return 'Unable to validate public signing keys at jwks_uri';
    }
  }
  if (!jwks) return undefined;
  const error = publicClientJwksProblem(
    jwks,
    method === 'private_key_jwt' ? (settings.token_endpoint_auth_signing_alg ?? null) : undefined
  );
  if (error) return error;
  if (!keyRecord(jwks) || !Array.isArray(jwks.keys)) return 'Invalid public JWKS';
  try {
    for (const key of jwks.keys) {
      if (!keyRecord(key)) return 'Invalid public JWK';
      await importJWK(
        key,
        publicSigningAlgorithm(key) ?? (typeof key.alg === 'string' ? key.alg : 'RSA-OAEP-256')
      );
    }
  } catch {
    return 'Public JWK cannot be imported for its algorithm';
  }
  return undefined;
}
