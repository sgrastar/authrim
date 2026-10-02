/**
 * Protocol settings (FAPI, PAR, request objects, response types, DPoP nonces and the like) for
 * the authorization, PAR, token, registration and discovery code.
 *
 * The values saved in the Settings API (the client's, else the tenant's, else the platform's) in
 * the shape that code has always read: the older `system_settings` document's `fapi`, `oidc` and
 * `security` sections. A setting nothing
 * saved is left out, so each caller keeps its own environment variable and default for it.
 */

import type { CategoryName } from '../types/settings/catalog';
import type { SettingSource } from '../utils/settings-manager';
import {
  SYSTEM_SETTINGS_FIELDS,
  writeSystemSettingsField,
  type SystemSettingsField,
} from '../utils/system-settings-fields';
import {
  resolveEffectiveSettingsWithSources,
  type EffectiveSettingsEnv,
} from './effective-settings';

export type ProtocolSettingsSection = 'fapi' | 'oidc' | 'security';

export type AuthorizationSigningAlgorithm = 'RS256' | 'ES256' | 'PS256';

export interface FAPIMessageSigningSettings {
  enabled?: boolean;
  requireSignedRequestObject?: boolean;
  requireJarm?: boolean;
  requestObjectSigningAlgorithms?: string[];
  authorizationSigningAlgorithms?: AuthorizationSigningAlgorithm[];
  defaultAuthorizationSigningAlgorithm?: AuthorizationSigningAlgorithm;
  maxRequestObjectAgeSeconds?: number;
  maxRequestObjectLifetimeSeconds?: number;
  clockSkewSeconds?: number;
}

export interface FAPIProtocolSettings {
  enabled?: boolean;
  strictDPoP?: boolean;
  allowPublicClients?: boolean;
  /** True: always required; false: never required by FAPI mode; unset: required in FAPI mode. */
  requireDpop?: boolean;
  requirePrivateKeyJwt?: boolean;
  clientAssertionAudience?: 'issuer' | 'endpoint_or_issuer';
  maxRequestUriExpiry?: number;
  messageSigning?: FAPIMessageSigningSettings;
}

export interface OIDCProtocolSettings {
  requirePar?: boolean;
  parExpiry?: number;
  allowNoneAlgorithm?: boolean;
  rar?: { enabled?: boolean };
  aiScopes?: { enabled?: boolean };
  aiEphemeralAuth?: { enabled?: boolean };
  /** Checked by the caller: a list of response types. */
  responseTypesSupported?: unknown;
  tokenEndpointAuthMethodsSupported?: string[];
  claimsSupported?: string[];
  httpsRequestUri?: {
    /** Checked by the caller: a boolean. */
    enabled?: unknown;
    /** Checked by the caller: a list of domains. */
    allowedDomains?: unknown;
    timeoutMs?: number;
    maxSizeBytes?: number;
  };
  clientCredentials?: { enabled?: boolean };
}

export interface SecurityProtocolSettings {
  dpop_nonce_enabled?: boolean;
  dpop_nonce_resource_overrides?: Record<string, boolean>;
}

export interface ProtocolSettings {
  fapi: FAPIProtocolSettings;
  oidc: OIDCProtocolSettings;
  security: SecurityProtocolSettings;
}

/** The settings this resolver hands out (the rest of the older document went elsewhere). */
const PROTOCOL_SETTING_KEYS: ReadonlySet<string> = new Set([
  'security.fapi_enabled',
  'security.fapi_strict_dpop',
  'security.fapi_allow_public_clients',
  'security.dpop_required',
  'security.fapi_require_private_key_jwt',
  'security.fapi_client_assertion_audience',
  'oauth.par_fapi_ttl',
  'security.fapi_message_signing_enabled',
  'security.require_signed_request_object',
  'security.require_jarm',
  'security.request_object_signing_algs',
  'security.authorization_signing_algs',
  'security.default_authorization_signing_alg',
  'security.request_object_max_age_seconds',
  'security.request_object_max_lifetime_seconds',
  'security.request_object_clock_skew_seconds',
  'security.par_required',
  'oauth.par_default_ttl',
  'security.allow_unsigned_request_object',
  'feature.enable_rar',
  'feature.enable_ai_scopes',
  'feature.enable_ai_ephemeral_auth',
  'oauth.response_types_supported',
  'oauth.token_endpoint_auth_methods_supported',
  'discovery.claims_supported',
  'oauth.https_request_uri_enabled',
  'oauth.https_request_uri_allowed_domains',
  'oauth.https_request_uri_timeout_ms',
  'oauth.https_request_uri_max_size',
  'feature.enable_client_credentials',
  'security.dpop_nonce_enabled',
  'security.dpop_nonce_resource_overrides',
]);

/**
 * The protocol settings read from the given sections of the older document, by category: the
 * settings a certification profile manages when it covers those sections.
 */
export function protocolSettingKeys(
  sections: readonly ProtocolSettingsSection[]
): Map<CategoryName, string[]> {
  const keys = new Map<CategoryName, string[]>();
  for (const field of SYSTEM_SETTINGS_FIELDS) {
    if (!PROTOCOL_SETTING_KEYS.has(field.key)) continue;
    if (!(sections as readonly string[]).includes(field.path[0])) continue;
    keys.set(field.category, [...(keys.get(field.category) ?? []), field.key]);
  }
  return keys;
}

/** Where a saved value comes from (an environment variable or the default is not one). */
const SAVED_SOURCES: ReadonlySet<SettingSource> = new Set<SettingSource>([
  'kv',
  'tenant',
  'platform',
]);

export interface ProtocolSettingsOptions {
  /** The client the request is for, so the values saved for it apply. */
  clientId?: string;
  /** The sections the caller reads whole. */
  sections?: readonly ProtocolSettingsSection[];
  /**
   * Single settings the caller reads besides those sections (by Settings API key). Only what is
   * asked for is resolved, so a document the caller does not need cannot fail its read.
   */
  keys?: readonly string[];
}

/**
 * The saved protocol settings for a tenant (or one of its clients). Throws when a saved value
 * cannot be read, so it is never taken for an unset one.
 */
export async function resolveProtocolSettings(
  env: EffectiveSettingsEnv,
  tenantId: string,
  options: ProtocolSettingsOptions
): Promise<ProtocolSettings> {
  const sections: readonly string[] = options.sections ?? [];
  const keys = options.keys ?? [];
  const fieldsByCategory = new Map<CategoryName, SystemSettingsField[]>();
  for (const field of SYSTEM_SETTINGS_FIELDS) {
    if (!PROTOCOL_SETTING_KEYS.has(field.key)) continue;
    if (!sections.includes(field.path[0]) && !keys.includes(field.key)) continue;
    const fields = fieldsByCategory.get(field.category) ?? [];
    fields.push(field);
    fieldsByCategory.set(field.category, fields);
  }

  const document: Record<string, unknown> = { fapi: {}, oidc: {}, security: {} };
  const resolved = await Promise.all(
    [...fieldsByCategory].map(async ([category, fields]) => ({
      fields,
      ...(await resolveEffectiveSettingsWithSources(env, category, {
        tenantId,
        clientId: options.clientId,
      })),
    }))
  );
  for (const { fields, values, sources } of resolved) {
    for (const field of fields) {
      if (SAVED_SOURCES.has(sources[field.key])) {
        writeSystemSettingsField(document, field, values[field.key]);
      }
    }
  }
  return document as unknown as ProtocolSettings;
}
