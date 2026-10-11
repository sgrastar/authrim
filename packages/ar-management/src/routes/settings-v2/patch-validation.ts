/**
 * Checks of Settings API values that the catalog's types cannot express, shared by the PATCH
 * routes and the one-time import of the older stores (which must not save what a PATCH refuses).
 */

import {
  aalMapProblem,
  ialAssuranceValuesProblem,
  ialMapProblem,
  idaProfileProblem,
  outboundAcrMappingsProblem,
  samlAuthnContextAALProblem,
  SCIM_MAX_IAL_MAX,
  SCIM_MAX_IAL_MIN,
  ALL_CATEGORY_META,
  AUTHORIZATION_SIGNING_ALGORITHMS,
  REQUEST_OBJECT_SIGNING_ALGORITHMS,
  CLIENT_AUTH_METHODS,
  isValidUIPath,
  parseAllowedOriginsEnv,
  validateResponseType,
  validateUIBaseUrl,
  validateExternalUrl,
  type Env,
  type SettingsPatchRequest,
  profileUpdateFieldsProblem,
} from '@authrim/ar-lib-core';

/** Every UI path a tenant can set (`tenant.ui_*_path`), including those runtime reads later. */
const TENANT_UI_PATH_SETTINGS = Object.keys(ALL_CATEGORY_META.tenant.settings).filter((key) =>
  /^tenant\.ui_[a-z_]+_path$/.test(key)
);

export function validateTenantUIPaths(body: SettingsPatchRequest): string | null {
  for (const key of TENANT_UI_PATH_SETTINGS) {
    const path = body.set?.[key];
    if (path !== undefined && !isValidUIPath(path)) {
      return `${key} must be a path starting with a single / (no query or fragment)`;
    }
  }
  return null;
}

/**
 * The platform's UI routing (`tenant.ui_*` at the platform): the base URL must be an allowed UI
 * origin (the issuer, localhost or ALLOWED_ORIGINS), and each path must stay on the UI's host.
 */
export function validatePlatformUIPatch(body: SettingsPatchRequest, env: Env): string | null {
  const baseUrl = body.set?.['tenant.ui_base_url'];
  if (baseUrl !== undefined) {
    if (typeof baseUrl !== 'string' || baseUrl.trim() === '' || baseUrl !== baseUrl.trim()) {
      return 'tenant.ui_base_url must be a URL; clear it to use UI_URL';
    }
    const validation = validateUIBaseUrl(
      baseUrl,
      env.ISSUER_URL,
      parseAllowedOriginsEnv(env.ALLOWED_ORIGINS)
    );
    if (!validation.valid) {
      return `tenant.ui_base_url is not an allowed UI origin: ${validation.error ?? 'invalid'}`;
    }
  }
  return validateTenantUIPaths(body);
}

const TOKEN_ENDPOINT_AUTH_METHODS: readonly string[] = Object.values(CLIENT_AUTH_METHODS);

/** A non-empty array of distinct strings, each accepted by `valid`. */
function isListOf(value: unknown, valid: (entry: string) => boolean): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && valid(entry)) &&
    new Set(value).size === value.length
  );
}

/**
 * OAuth settings whose JSON value must be a list runtime can use: the response types and the
 * token endpoint authentication methods. Returns the problem, or null.
 */
export function validateOAuthListPatch(body: SettingsPatchRequest): string | null {
  const responseTypes = body.set?.['oauth.response_types_supported'];
  if (
    responseTypes !== undefined &&
    !isListOf(responseTypes, (entry) => validateResponseType(entry).valid)
  ) {
    return 'oauth.response_types_supported must be a non-empty array of distinct supported response types';
  }
  const authMethods = body.set?.['oauth.token_endpoint_auth_methods_supported'];
  if (
    authMethods !== undefined &&
    !isListOf(authMethods, (entry) => TOKEN_ENDPOINT_AUTH_METHODS.includes(entry))
  ) {
    return `oauth.token_endpoint_auth_methods_supported must be a non-empty array of distinct methods (${TOKEN_ENDPOINT_AUTH_METHODS.join(', ')})`;
  }
  return null;
}

/** Subject token types Token Exchange can accept (never refresh_token, RFC 8693 security). */
const TOKEN_EXCHANGE_SUBJECT_TYPES: readonly string[] = ['access_token', 'jwt', 'id_token'];

const commaList = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * Token settings whose string value is a list runtime must be able to use: the Token Exchange
 * subject token types, and the ID-JAG issuers (https URLs without credentials, query or
 * fragment). Returns the problem, or null.
 */
export function validateTokensPatch(body: SettingsPatchRequest): string | null {
  const types = body.set?.['tokens.exchange_allowed_subject_token_types'];
  if (types !== undefined) {
    if (typeof types !== 'string') {
      return 'tokens.exchange_allowed_subject_token_types must be a comma-separated string';
    }
    const invalid = commaList(types).filter((type) => !TOKEN_EXCHANGE_SUBJECT_TYPES.includes(type));
    if (invalid.length > 0) {
      return `tokens.exchange_allowed_subject_token_types may list only ${TOKEN_EXCHANGE_SUBJECT_TYPES.join(', ')} (refresh_token is never allowed): ${invalid.join(', ')}`;
    }
  }
  const issuers = body.set?.['tokens.id_jag_allowed_issuers'];
  if (issuers !== undefined) {
    if (
      !Array.isArray(issuers) ||
      issuers.some((issuer) => typeof issuer !== 'string' || issuer.trim() === '')
    ) {
      return 'tokens.id_jag_allowed_issuers must be an array of issuer URLs';
    }
    for (const issuer of issuers as string[]) {
      const problem = validateExternalUrl(issuer, {
        requireHttps: true,
        fieldName: 'ID-JAG issuer',
      });
      if (problem) return `Invalid ID-JAG issuer URL: ${problem.error_description}`;
      const parsed = new URL(issuer);
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        return 'Invalid ID-JAG issuer URL: credentials, query, and fragment are not allowed';
      }
    }
  }
  return null;
}

/**
 * External IdP settings whose string value is a list the bridge must be able to use: the JIT
 * allowed providers (empty allows all; otherwise comma-separated IDs, none of them empty, so a
 * value never reads as allowing every provider by accident). Returns the problem, or null.
 */
export function validateExternalIdpPatch(body: SettingsPatchRequest): string | null {
  const updateFields = body.set?.['external_idp.jit_update_fields'];
  if (updateFields !== undefined) {
    const problem = profileUpdateFieldsProblem(updateFields);
    if (problem) return `external_idp.jit_update_fields ${problem}`;
  }
  const providers = body.set?.['external_idp.jit_allowed_provider_ids'];
  if (providers === undefined) return null;
  if (typeof providers !== 'string') {
    return 'external_idp.jit_allowed_provider_ids must be a comma-separated string';
  }
  if (providers !== '' && providers.split(',').some((id) => id.trim() === '')) {
    return 'external_idp.jit_allowed_provider_ids must be empty (every provider) or comma-separated provider IDs, none of them empty';
  }
  return null;
}

/**
 * Security settings whose value must be one runtime can use: the message signing algorithm lists
 * (one or more known algorithms; the authorization response list may also be empty), and the DPoP nonce choices by resource (resource URI to true or
 * false). Returns the problem, or null.
 */
export function validateSecurityPatch(body: SettingsPatchRequest): string | null {
  for (const [key, allowed] of [
    ['security.request_object_signing_algs', REQUEST_OBJECT_SIGNING_ALGORITHMS],
    ['security.authorization_signing_algs', AUTHORIZATION_SIGNING_ALGORITHMS],
  ] as const) {
    const value = body.set?.[key];
    if (value === undefined) continue;
    // No authorization response list: any algorithm the client registered.
    if (key === 'security.authorization_signing_algs' && value === '') continue;
    if (
      typeof value !== 'string' ||
      commaList(value).length === 0 ||
      commaList(value).some((algorithm) => !allowed.includes(algorithm))
    ) {
      return `${key} must be a comma-separated list of one or more of ${allowed.join(', ')}`;
    }
  }
  const overrides = body.set?.['security.dpop_nonce_resource_overrides'];
  if (
    overrides !== undefined &&
    (!overrides ||
      typeof overrides !== 'object' ||
      Array.isArray(overrides) ||
      Object.entries(overrides).some(
        ([resource, required]) => resource.trim() === '' || typeof required !== 'boolean'
      ))
  ) {
    return 'security.dpop_nonce_resource_overrides must be an object of resource URI to true or false';
  }
  return null;
}

/**
 * Discovery settings whose string value is a list: the claims advertised (empty for the claims
 * Authrim can issue; otherwise comma-separated names, none of them empty). Returns the problem,
 * or null.
 */
export function validateDiscoveryPatch(body: SettingsPatchRequest): string | null {
  const claims = body.set?.['discovery.claims_supported'];
  if (claims === undefined) return null;
  if (typeof claims !== 'string' || (claims !== '' && claims.split(',').some((c) => !c.trim()))) {
    return 'discovery.claims_supported must be empty (the claims Authrim can issue) or comma-separated claim names';
  }
  return null;
}

/**
 * The problem with a PATCH of a category whose values the catalog's types cannot fully check
 * (lists runtime must be able to use), or null.
 */
/**
 * Assurance: the JSON-text settings are each checked the way runtime reads them, so runtime never
 * meets a value it would read differently: scope and upstream maps of names to AAL1..AAL3, the
 * outbound map (acr values of other vocabularies, none of Authrim's own, to AAL1..AAL3), a scope
 * map to IAL1..IAL3, assurance values per IAL (absolute URIs), AuthnContextClassRefs to an AAL, and
 * the Identity Assurance profile.
 */
export function validateAssurancePatch(body: SettingsPatchRequest): string | null {
  // The highest IAL a SCIM token may assert: a whole number over the IALs of the service.
  const ceiling = body.set?.['assurance.scim_max_ial'];
  if (
    ceiling !== undefined &&
    (typeof ceiling !== 'number' ||
      !Number.isInteger(ceiling) ||
      ceiling < SCIM_MAX_IAL_MIN ||
      ceiling > SCIM_MAX_IAL_MAX)
  ) {
    return `assurance.scim_max_ial must be a whole number from ${SCIM_MAX_IAL_MIN} to ${SCIM_MAX_IAL_MAX}`;
  }
  const checks: Array<[string, (parsed: unknown) => string | null]> = [
    ['assurance.scope_aal_requirements', aalMapProblem],
    ['assurance.upstream_acr_mappings', aalMapProblem],
    ['assurance.outbound_acr_mappings', outboundAcrMappingsProblem],
    ['assurance.scope_ial_requirements', ialMapProblem],
    ['assurance.ial_assurance_values', ialAssuranceValuesProblem],
    ['assurance.saml_authn_context_aal', samlAuthnContextAALProblem],
    ['assurance.ida_profile', (parsed) => idaProfileProblem(parsed)],
  ];
  for (const [key, problemOf] of checks) {
    const value = body.set?.[key];
    if (value === undefined) continue;
    let parsed: unknown;
    try {
      parsed = typeof value === 'string' ? JSON.parse(value) : undefined;
    } catch {
      parsed = undefined;
    }
    const problem = problemOf(parsed);
    if (problem) return `${key} ${problem} (as JSON text)`;
  }
  return null;
}

export function validateCategoryPatch(category: string, body: SettingsPatchRequest): string | null {
  switch (category) {
    case 'assurance':
      return validateAssurancePatch(body);
    case 'oauth':
      return validateOAuthListPatch(body);
    case 'tokens':
      return validateTokensPatch(body);
    case 'external-idp':
      return validateExternalIdpPatch(body);
    case 'security':
      return validateSecurityPatch(body);
    case 'discovery':
      return validateDiscoveryPatch(body);
    default:
      return null;
  }
}

/**
 * The problem with saving one value at a scope, as the PATCH routes would report it, or null.
 * Covers the checks that need no tenant lookup (a tenant's UI base URL is not imported).
 */
export function validateSettingValue(
  category: string,
  scope: 'platform' | 'tenant' | 'client',
  key: string,
  value: unknown,
  env: Env
): string | null {
  const body: SettingsPatchRequest = { ifMatch: '', set: { [key]: value } };
  if (category === 'tenant') {
    return scope === 'platform' ? validatePlatformUIPatch(body, env) : validateTenantUIPaths(body);
  }
  return validateCategoryPatch(category, body);
}
