/**
 * Checks of Settings API values that the catalog's types cannot express, shared by the PATCH
 * routes and the one-time import of the older stores (which must not save what a PATCH refuses).
 */

import {
  aalMapProblem,
  ialAssuranceValuesProblem,
  ialMapProblem,
  idaProfileProblem,
  institutionDisplayNamesProblem,
  institutionScopesProblem,
  INSTITUTION_DISPLAY_NAMES_KEY,
  INSTITUTION_SCOPES_KEY,
  outboundAcrMappingsProblem,
  samlAuthnContextAALProblem,
  SCIM_MAX_IAL_MAX,
  SCIM_MAX_IAL_MIN,
  ALL_CATEGORY_META,
  CIBA_DEFAULTS,
  CIBA_SETTINGS_META,
  CIBA_HARD_LIMITS,
  DEVICE_FLOW_DEFAULTS,
  DEVICE_FLOW_SETTINGS_META,
  isUserCodeCharsetName,
  oidcDefaultSetValueProblem,
  userCodeFormatProblem,
  dcrDefaultTargetProblem,
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

/** What a CIBA PATCH is checked against: the tenant's values before it, and what a key inherits. */
export interface CibaPatchState {
  /** The tenant's effective values before the PATCH. */
  current?: Record<string, unknown>;
  /**
   * What each key falls back to once cleared (the platform, an environment variable or the
   * default), from the settings reader's `inherited.values`. A key missing here counts as its
   * default.
   */
  inherited?: Record<string, unknown>;
}

/** The problem with one value of a setting, as the settings manager would refuse it, or null. */
function settingValueProblem(
  meta: {
    type: string;
    min?: number;
    max?: number;
    integer?: boolean;
    step?: number;
    enum?: string[];
  },
  key: string,
  value: unknown
): string | null {
  if (meta.type === 'boolean') {
    return typeof value === 'boolean' ? null : `${key} must be true or false`;
  }
  if (meta.type === 'enum') {
    return typeof value === 'string' && (!meta.enum || meta.enum.includes(value))
      ? null
      : `${key} must be one of: ${(meta.enum ?? []).join(', ')}`;
  }
  // As the settings manager checks a number: finite, whole only where the setting says so, in range.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${key} must be a number`;
  }
  if (meta.integer && !Number.isSafeInteger(value)) {
    return `${key} must be a whole number`;
  }
  if (meta.step !== undefined && value % meta.step !== 0) {
    return `${key} must be a multiple of ${meta.step}`;
  }
  if (value < (meta.min ?? -Infinity) || value > (meta.max ?? Infinity)) {
    return `${key} must be between ${meta.min} and ${meta.max}`;
  }
  return null;
}

/** The problem with one value of a CIBA key, as the settings manager would refuse it, or null. */
function cibaValueProblem(key: string, value: unknown): string | null {
  return settingValueProblem(
    CIBA_SETTINGS_META[key as keyof typeof CIBA_SETTINGS_META],
    key,
    value
  );
}

/**
 * CIBA settings that only make sense together, checked on the document the save would leave: the
 * request lifetime bounds (`ciba.min_expires_in` <= `ciba.max_expires_in`, with `ciba.expires_in`
 * between them) and the polling interval bounds (`ciba.min_interval` <= `ciba.max_interval`, with
 * `ciba.poll_interval` between them). Runtime keeps such a document usable on its own (a pair
 * that is the wrong way round falls back to the defaults, a value outside its bounds is clamped);
 * this refuses to save one an admin did not mean.
 *
 * The relations are only meaningful for the changes that will really be saved, so first the
 * whole PATCH is refused when any of its CIBA keys would be refused one by one (an unknown key, a
 * value of the wrong type, not whole or out of range, a key named by two operations, a
 * non-boolean disabled): the settings manager would save the rest, leaving a document nobody
 * checked.
 *
 * With `state.current` (the tenant's effective values before the PATCH) the final document is
 * every key the PATCH does not name as it is now. Without it (imports, profiles) only the values
 * the PATCH itself holds are compared. A cleared key takes what it inherits (`state.inherited`:
 * the platform, an environment variable, else the default). Returns the problem, or null.
 */
export function validateCibaPatch(
  body: SettingsPatchRequest,
  state: CibaPatchState = {}
): string | null {
  const known = (key: string) => Object.hasOwn(CIBA_SETTINGS_META, key);
  const operations = new Map<string, number>();
  for (const key of [
    ...new Set(Object.keys(body.set ?? {})),
    ...new Set(body.clear ?? []),
    ...new Set(body.disable ?? []),
  ]) {
    operations.set(key, (operations.get(key) ?? 0) + 1);
  }
  for (const [key, count] of operations) {
    if (!known(key)) return `${key} is not a CIBA setting`;
    if (count > 1) return `${key} is named by more than one operation (set, clear, disable)`;
  }
  for (const [key, value] of Object.entries(body.set ?? {})) {
    const problem = cibaValueProblem(key, value);
    if (problem) return problem;
  }
  for (const key of body.disable ?? []) {
    if (CIBA_SETTINGS_META[key as keyof typeof CIBA_SETTINGS_META].type !== 'boolean') {
      return `${key} cannot be disabled: only on/off settings can`;
    }
  }

  const resulting = (key: keyof typeof CIBA_DEFAULTS): number | undefined => {
    let value: unknown;
    if (body.set && key in body.set) value = body.set[key];
    else if (body.clear?.includes(key)) value = state.inherited?.[key] ?? CIBA_DEFAULTS[key];
    else value = state.current?.[key];
    return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
  };
  const touches = (...keys: string[]) => keys.some((key) => operations.has(key));

  const minInterval = resulting('ciba.min_interval');
  if (
    body.set &&
    'ciba.min_interval' in body.set &&
    minInterval !== undefined &&
    minInterval < CIBA_HARD_LIMITS.minInterval
  ) {
    return `ciba.min_interval must be at least ${CIBA_HARD_LIMITS.minInterval} seconds (each poll is a Durable Object write)`;
  }

  const pairs: Array<
    [
      min: keyof typeof CIBA_DEFAULTS,
      max: keyof typeof CIBA_DEFAULTS,
      value: keyof typeof CIBA_DEFAULTS,
    ]
  > = [
    ['ciba.min_expires_in', 'ciba.max_expires_in', 'ciba.expires_in'],
    ['ciba.min_interval', 'ciba.max_interval', 'ciba.poll_interval'],
  ];
  for (const [minKey, maxKey, valueKey] of pairs) {
    if (!touches(minKey, maxKey, valueKey)) continue;
    const min = resulting(minKey);
    const max = resulting(maxKey);
    const value = resulting(valueKey);
    if (min !== undefined && max !== undefined && min > max) {
      return `${minKey} (${min}) must not be greater than ${maxKey} (${max})`;
    }
    if (value !== undefined && min !== undefined && value < min) {
      return `${valueKey} (${value}) must not be below ${minKey} (${min})`;
    }
    if (value !== undefined && max !== undefined && value > max) {
      return `${valueKey} (${value}) must not be above ${maxKey} (${max})`;
    }
  }
  return null;
}

/** What a device flow PATCH is checked against: the values before it, and what a key inherits. */
export interface DeviceFlowPatchState extends CibaPatchState {
  /**
   * 'client' when the PATCH is for one client: its lifetime and interval bounds may only narrow
   * the tenant's, which are what `inherited` holds. Defaults to the tenant.
   */
  scope?: 'tenant' | 'client';
}

/**
 * Device flow settings that only make sense together, checked on the document the save would
 * leave: the code lifetime bounds (`device_flow.min_expires_in` <= `device_flow.max_expires_in`,
 * with `device_flow.expires_in` between them) and the polling interval bounds
 * (`device_flow.min_interval` <= `device_flow.max_interval`, with `device_flow.poll_interval`
 * between them). Runtime keeps such a document usable on its own (a pair that is the wrong way
 * round falls back to the defaults, a value outside its bounds is clamped); this refuses to save
 * one an admin did not mean.
 *
 * The relations are only meaningful for the changes that will really be saved, so first the whole
 * PATCH is refused when any of its keys would be refused one by one (an unknown key, a value of
 * the wrong type, not whole or out of range, a key named by two operations, any `disable`: no
 * device flow setting is an on/off switch): the settings manager would save the rest, leaving a
 * document nobody checked.
 *
 * With `state.current` (the effective values before the PATCH, for the tenant or the client) the
 * final document is every key the PATCH does not name as it is now. Without it (imports,
 * profiles) only the values the PATCH itself holds are compared. A cleared key takes what it
 * inherits (`state.inherited`: the tenant and platform, an environment variable, else the
 * default). For a client (`state.scope`), the bounds it sets may not widen the tenant's: runtime
 * only ever narrows them, so a wider value would look saved and do nothing.
 *
 * The user code charset and length are checked together on the pair the save would leave (a
 * cleared key counts as what it inherits): the code needs at least 34 bits of entropy, so
 * NUMERIC with 10 digits (33.2 bits) is refused, with a message naming the minimum for the
 * charset. They are tenant settings: for a client PATCH they are refused. Runtime holds the same
 * floor whatever is stored. Returns the problem, or null.
 */
export function validateDeviceFlowPatch(
  body: SettingsPatchRequest,
  state: DeviceFlowPatchState = {}
): string | null {
  const known = (key: string) => Object.hasOwn(DEVICE_FLOW_SETTINGS_META, key);
  const operations = new Map<string, number>();
  for (const key of [
    ...new Set(Object.keys(body.set ?? {})),
    ...new Set(body.clear ?? []),
    ...new Set(body.disable ?? []),
  ]) {
    operations.set(key, (operations.get(key) ?? 0) + 1);
  }
  for (const [key, count] of operations) {
    if (!known(key)) return `${key} is not a device flow setting`;
    if (count > 1) return `${key} is named by more than one operation (set, clear, disable)`;
  }
  for (const [key, value] of Object.entries(body.set ?? {})) {
    const problem = settingValueProblem(
      DEVICE_FLOW_SETTINGS_META[key as keyof typeof DEVICE_FLOW_SETTINGS_META],
      key,
      value
    );
    if (problem) return problem;
  }
  for (const key of body.disable ?? []) {
    return `${key} cannot be disabled: only on/off settings can`;
  }

  type Key = keyof typeof DEVICE_FLOW_DEFAULTS;
  const inheritedValue = (key: Key): unknown => state.inherited?.[key] ?? DEVICE_FLOW_DEFAULTS[key];
  const userCodeKeys = ['device_flow.user_code_charset', 'device_flow.user_code_length'] as const;
  if (state.scope === 'client') {
    const named = userCodeKeys.find((key) => operations.has(key));
    if (named) return `${named} is a tenant setting: a client cannot set it`;
  }
  const resulting = (key: Key): number | undefined => {
    let value: unknown;
    if (body.set && key in body.set) value = body.set[key];
    else if (body.clear?.includes(key)) value = inheritedValue(key);
    else value = state.current?.[key];
    return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
  };
  const touches = (...keys: string[]) => keys.some((key) => operations.has(key));

  // The charset and the length are only usable together
  if (touches(...userCodeKeys)) {
    const charsetKey = 'device_flow.user_code_charset';
    const lengthKey = 'device_flow.user_code_length';
    const resultingValue = (key: Key): unknown =>
      body.set && key in body.set
        ? body.set[key]
        : body.clear?.includes(key)
          ? inheritedValue(key)
          : state.current
            ? (state.current[key] ?? DEVICE_FLOW_DEFAULTS[key])
            : undefined;
    const charset = resultingValue(charsetKey);
    const length = resultingValue(lengthKey);
    if (isUserCodeCharsetName(charset) && typeof length === 'number') {
      const problem = userCodeFormatProblem(charset, length);
      if (problem) return problem;
    }
  }

  const pairs: Array<[min: Key, max: Key, value: Key]> = [
    ['device_flow.min_expires_in', 'device_flow.max_expires_in', 'device_flow.expires_in'],
    ['device_flow.min_interval', 'device_flow.max_interval', 'device_flow.poll_interval'],
  ];
  for (const [minKey, maxKey, valueKey] of pairs) {
    if (!touches(minKey, maxKey, valueKey)) continue;
    const min = resulting(minKey);
    const max = resulting(maxKey);
    const value = resulting(valueKey);
    if (min !== undefined && max !== undefined && min > max) {
      return `${minKey} (${min}) must not be greater than ${maxKey} (${max})`;
    }
    if (value !== undefined && min !== undefined && value < min) {
      return `${valueKey} (${value}) must not be below ${minKey} (${min})`;
    }
    if (value !== undefined && max !== undefined && value > max) {
      return `${valueKey} (${value}) must not be above ${maxKey} (${max})`;
    }
    if (state.scope === 'client') {
      const tenantMin = inheritedValue(minKey);
      const tenantMax = inheritedValue(maxKey);
      if (
        body.set &&
        minKey in body.set &&
        min !== undefined &&
        typeof tenantMin === 'number' &&
        min < tenantMin
      ) {
        return `${minKey} (${min}) must not be below the tenant's ${tenantMin}: a client can only narrow the tenant's bounds`;
      }
      if (
        body.set &&
        maxKey in body.set &&
        max !== undefined &&
        typeof tenantMax === 'number' &&
        max > tenantMax
      ) {
        return `${maxKey} (${max}) must not be above the tenant's ${tenantMax}: a client can only narrow the tenant's bounds`;
      }
    }
  }
  return null;
}

/**
 * A PATCH names only keys the category has. The settings manager would reject an unknown key one
 * by one and save the rest; the categories that retired settings refuse the whole PATCH instead,
 * so a script still setting a retired key hears about it (`noun` is the category as a person
 * names it, as in "tenant.name is not a tenant setting").
 */
export function validateKnownSettingKeys(
  category: keyof typeof ALL_CATEGORY_META,
  noun: string,
  body: SettingsPatchRequest
): string | null {
  const settings = ALL_CATEGORY_META[category].settings;
  for (const key of [
    ...Object.keys(body.set ?? {}),
    ...(body.clear ?? []),
    ...(body.disable ?? []),
  ]) {
    if (!Object.hasOwn(settings, key)) return `${key} is not a ${noun} setting`;
  }
  return null;
}

/**
 * The DCR category: the default access token target of new apps must be a value a registration
 * can use (see services/dcr-default-target.ts). The tenant's own issuer URL is checked by the
 * PATCH route, which knows the tenant.
 */
export function validateDcrPatch(body: SettingsPatchRequest): string | null {
  const unknown = validateKnownSettingKeys('dcr', 'DCR', body);
  if (unknown) return unknown;
  for (const key of ['dcr.default_audience', 'dcr.default_resource'] as const) {
    if (body.set && key in body.set) {
      const problem = dcrDefaultTargetProblem(key, body.set[key]);
      if (problem) return problem;
    }
  }
  return null;
}

/**
 * The institution category: the scopes are one to twenty distinct lowercase domain names and the
 * names are JSON text with at least ja and en (see services/tenant-institution.ts). A value cannot
 * be disabled: "none" is a cleared key, never a marker the reader would turn into something else.
 */
export function validateInstitutionPatch(body: SettingsPatchRequest): string | null {
  const unknown = validateKnownSettingKeys('institution', 'institution', body);
  if (unknown) return unknown;
  if ((body.disable ?? []).length > 0) {
    return 'institution settings cannot be disabled; clear them to have none';
  }
  for (const [key, problemOf] of [
    [INSTITUTION_SCOPES_KEY, institutionScopesProblem],
    [INSTITUTION_DISPLAY_NAMES_KEY, institutionDisplayNamesProblem],
  ] as const) {
    if (body.set && key in body.set) {
      const problem = problemOf(body.set[key]);
      if (problem) return `${key} ${problem}`;
    }
  }
  return null;
}

const OIDC_DEFAULT_SET_KEY = 'identity_mapping.oidc_default_set_id';

/**
 * The identity-mapping category: the value is a Mapping Set ID, or (for a tenant) `none`. It must
 * be saved as a string: the disabled marker and `false` / `null` would all read back as "no
 * value" (the settings reader turns the marker into `false`), so they are refused here, and
 * "no default" is a cleared key (or `none` for a tenant that refuses the platform's). Whether the
 * set exists is checked where the Admin database is at hand (see identity-mapping-reference.ts).
 */
export function validateIdentityMappingPatch(
  body: SettingsPatchRequest,
  scope: 'platform' | 'tenant'
): string | null {
  const unknown = validateKnownSettingKeys('identity-mapping', 'identity mapping', body);
  if (unknown) return unknown;
  if (body.disable?.includes(OIDC_DEFAULT_SET_KEY)) {
    return `${OIDC_DEFAULT_SET_KEY} cannot be disabled; clear it, or save none to refuse the platform's default`;
  }
  if (body.set && OIDC_DEFAULT_SET_KEY in body.set) {
    return oidcDefaultSetValueProblem(body.set[OIDC_DEFAULT_SET_KEY], scope);
  }
  return null;
}

/**
 * What a refusal by a validation is about, for the callers that must not repeat a refusal's text.
 * `value`: only the value that was sent (its form, range, or the keys of the category), so the
 * text cannot hold anything the tenant has saved. `state`: it depends on what is saved or stored
 * (the other settings of the tenant, a database), so the text may name it. Every validation of
 * `validateCategoryPatch` is listed; one that is not is `state`, the safe reading.
 */
export type ValidationKind = 'value' | 'state';

const CATEGORY_VALIDATION_KIND: Readonly<Record<string, ValidationKind>> = {
  // These take the PATCH body alone (see their signatures).
  'identity-mapping': 'value',
  tenant: 'value',
  dcr: 'value',
  plugin: 'value',
  'diagnostic-logging': 'value',
  'bulk-apply': 'value',
  institution: 'value',
  assurance: 'value',
  oauth: 'value',
  tokens: 'value',
  'external-idp': 'value',
  security: 'value',
  discovery: 'value',
  // The bounds of the document the save leaves: the tenant's current and inherited values.
  ciba: 'state',
  'device-flow': 'state',
};

export function categoryValidationKind(category: string): ValidationKind {
  return Object.hasOwn(CATEGORY_VALIDATION_KIND, category)
    ? CATEGORY_VALIDATION_KIND[category]
    : 'state';
}

export function validateCategoryPatch(
  category: string,
  body: SettingsPatchRequest,
  /** Where the patch is saved; the identity-mapping category judges the value by it. */
  scope: 'platform' | 'tenant' | 'client' = 'tenant'
): string | null {
  switch (category) {
    case 'identity-mapping':
      // The platform's rule is the stricter one, and an app has no such setting.
      return validateIdentityMappingPatch(body, scope === 'platform' ? 'platform' : 'tenant');
    case 'bulk-apply':
      return validateKnownSettingKeys('bulk-apply', 'bulk apply', body);
    case 'institution':
      return validateInstitutionPatch(body);
    case 'tenant':
      return validateKnownSettingKeys('tenant', 'tenant', body);
    case 'dcr':
      return validateDcrPatch(body);
    case 'plugin':
      return validateKnownSettingKeys('plugin', 'plugin', body);
    case 'diagnostic-logging':
      return validateKnownSettingKeys('diagnostic-logging', 'diagnostic logging', body);
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
    case 'ciba':
      return validateCibaPatch(body);
    case 'device-flow':
      return validateDeviceFlowPatch(body);
    default:
      return null;
  }
}

/**
 * Categories whose settings are checked against each other on the document a save leaves, so the
 * PATCH routes read the current and inherited values first (see {@link validateCategoryPatchAt}).
 */
export function categoryPatchNeedsState(category: string): boolean {
  return category === 'ciba' || category === 'device-flow';
}

/**
 * The validation of a PATCH at one scope. Categories that need the values around the change
 * (`categoryPatchNeedsState`) are checked against `state`; the others need none.
 */
export function validateCategoryPatchAt(
  category: string,
  scope: 'tenant' | 'client',
  body: SettingsPatchRequest,
  state: CibaPatchState | null
): string | null {
  if (state && category === 'ciba') return validateCibaPatch(body, state);
  if (state && category === 'device-flow')
    return validateDeviceFlowPatch(body, { ...state, scope });
  return validateCategoryPatch(category, body, scope);
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
  return validateCategoryPatch(category, body, scope);
}
