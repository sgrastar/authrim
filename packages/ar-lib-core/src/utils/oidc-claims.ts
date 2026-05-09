export type ClaimsTarget = 'userinfo' | 'id_token';

export type ClaimReleasePolicy = 'scope_required' | 'claims_allowed' | 'forbidden';

export interface OIDCIndividualClaimRequest {
  essential?: boolean;
  value?: unknown;
  values?: unknown[];
  [key: string]: unknown;
}

export interface SAORule {
  loc: string;
  method?: 'exists' | 'simple' | 'schema';
  schema?: unknown;
  value?: string | number | boolean;
  values?: Array<string | number | boolean>;
  else: 'abort' | 'omit';
  what?: string[];
}

export interface ClaimsRequestASC {
  sao?: Partial<Record<ClaimsTarget, SAORule[]>>;
  transformed_claims?: Record<string, unknown>;
}

export interface ParsedClaimsRequest {
  userinfo: Record<string, OIDCIndividualClaimRequest | null>;
  id_token: Record<string, OIDCIndividualClaimRequest | null>;
  _asc?: ClaimsRequestASC;
}

export interface OIDCClaimsClientPolicy {
  allow_claims_without_scope?: boolean;
  claims_parameter_policy?: Record<string, ClaimReleasePolicy>;
  asc_enabled?: boolean;
  asc_protected_request_required?: boolean;
  asc_sao_enabled?: boolean;
  asc_transformed_claims_enabled?: boolean;
  asc_allowed_transformed_claims?: string[];
}

export interface EvaluateClaimsOptions {
  target: ClaimsTarget;
  claimsRequest?: ParsedClaimsRequest;
  initialClaims?: Record<string, unknown>;
  availableClaims: Record<string, unknown>;
  grantedScopes: string[];
  clientPolicy?: OIDCClaimsClientPolicy | null;
  includeScopeClaims?: boolean;
  requestIntegrityProtected?: boolean;
  applySAO?: boolean;
}

export type ClaimsEvaluationResult =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; error: string; error_description: string };

export const PROFILE_CLAIMS = [
  'name',
  'family_name',
  'given_name',
  'middle_name',
  'nickname',
  'preferred_username',
  'profile',
  'picture',
  'website',
  'gender',
  'birthdate',
  'zoneinfo',
  'locale',
  'updated_at',
] as const;

export const EMAIL_CLAIMS = ['email', 'email_verified'] as const;
export const PHONE_CLAIMS = ['phone_number', 'phone_number_verified'] as const;
export const ADDRESS_CLAIMS = ['address'] as const;

const CLAIM_SCOPE: Record<string, string> = {
  ...Object.fromEntries(PROFILE_CLAIMS.map((claim) => [claim, 'profile'])),
  ...Object.fromEntries(EMAIL_CLAIMS.map((claim) => [claim, 'email'])),
  ...Object.fromEntries(PHONE_CLAIMS.map((claim) => [claim, 'phone'])),
  address: 'address',
};

const PREDEFINED_TRANSFORMED_BASE_CLAIM: Record<string, string> = {
  age_over_13: 'birthdate',
  age_over_18: 'birthdate',
  age_over_20: 'birthdate',
  email_domain: 'email',
  phone_country_code: 'phone_number',
  address_country: 'address',
};

export const PREDEFINED_TRANSFORMED_CLAIMS = {
  age_over_13: { claim: 'birthdate', fn: ['years_ago', ['gte', 13]] },
  age_over_18: { claim: 'birthdate', fn: ['years_ago', ['gte', 18]] },
  age_over_20: { claim: 'birthdate', fn: ['years_ago', ['gte', 20]] },
  email_domain: { claim: 'email', fn: ['domain'] },
  phone_country_code: { claim: 'phone_number', fn: ['phone_country_code'] },
  address_country: { claim: 'address', fn: ['country'] },
} as const;

export const DEFAULT_ASC_ALLOWED_TRANSFORMED_CLAIMS = Object.keys(PREDEFINED_TRANSFORMED_CLAIMS);

export function parseClaimsRequest(claims?: string): ClaimsEvaluationResult & {
  request?: ParsedClaimsRequest;
} {
  if (!claims) {
    return { ok: true, claims: {}, request: undefined };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(claims);
  } catch {
    return {
      ok: false,
      error: 'invalid_request',
      error_description: 'claims parameter must be valid JSON',
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: 'invalid_request',
      error_description: 'claims parameter must be a JSON object',
    };
  }

  const root = parsed as Record<string, unknown>;
  const validSections = new Set(['userinfo', 'id_token', '_asc']);
  const sections = Object.keys(root);

  for (const section of sections) {
    if (!validSections.has(section)) {
      return {
        ok: false,
        error: 'invalid_request',
        error_description: `Invalid claims section: ${section}. Must be one of: userinfo, id_token, _asc`,
      };
    }
  }

  if (!sections.some((section) => section === 'userinfo' || section === 'id_token')) {
    return {
      ok: false,
      error: 'invalid_request',
      error_description: 'claims parameter must contain at least one of: userinfo, id_token',
    };
  }

  const userinfo = validateClaimSection(root.userinfo, 'userinfo');
  if (!userinfo.ok) return userinfo;

  const idToken = validateClaimSection(root.id_token, 'id_token');
  if (!idToken.ok) return idToken;

  const asc = validateASC(root._asc);
  if (!asc.ok) return asc;

  return {
    ok: true,
    claims: {},
    request: {
      userinfo: userinfo.section,
      id_token: idToken.section,
      ...(asc.asc ? { _asc: asc.asc } : {}),
    },
  };
}

function validateClaimSection(
  value: unknown,
  name: ClaimsTarget
):
  | { ok: true; section: Record<string, OIDCIndividualClaimRequest | null> }
  | { ok: false; error: string; error_description: string } {
  if (value === undefined) {
    return { ok: true, section: {} };
  }
  if (!isPlainObject(value)) {
    return {
      ok: false,
      error: 'invalid_request',
      error_description: `claims.${name} must be an object`,
    };
  }

  const section: Record<string, OIDCIndividualClaimRequest | null> = {};
  for (const [claim, request] of Object.entries(value)) {
    if (request === null) {
      section[claim] = null;
      continue;
    }
    if (!isPlainObject(request)) {
      return {
        ok: false,
        error: 'invalid_request',
        error_description: `claims.${name}.${claim} must be null or an object`,
      };
    }
    const claimRequest = request as OIDCIndividualClaimRequest;
    if ('values' in claimRequest && !Array.isArray(claimRequest.values)) {
      return {
        ok: false,
        error: 'invalid_request',
        error_description: `claims.${name}.${claim}.values must be an array`,
      };
    }
    section[claim] = claimRequest;
  }
  return { ok: true, section };
}

function validateASC(
  value: unknown
): { ok: true; asc?: ClaimsRequestASC } | { ok: false; error: string; error_description: string } {
  if (value === undefined) return { ok: true };
  if (!isPlainObject(value)) {
    return {
      ok: false,
      error: 'invalid_request',
      error_description: 'claims._asc must be an object',
    };
  }

  const ascValue = value as Record<string, unknown>;
  const asc: ClaimsRequestASC = {};

  if (ascValue.transformed_claims !== undefined) {
    if (!isPlainObject(ascValue.transformed_claims)) {
      return {
        ok: false,
        error: 'invalid_request',
        error_description: 'claims._asc.transformed_claims must be an object',
      };
    }
    asc.transformed_claims = ascValue.transformed_claims as Record<string, unknown>;
  }

  if (ascValue.sao !== undefined) {
    if (!isPlainObject(ascValue.sao)) {
      return {
        ok: false,
        error: 'invalid_request',
        error_description: 'claims._asc.sao must be an object',
      };
    }
    const sao: Partial<Record<ClaimsTarget, SAORule[]>> = {};
    for (const target of ['id_token', 'userinfo'] as const) {
      const rules = (ascValue.sao as Record<string, unknown>)[target];
      if (rules === undefined) continue;
      if (!Array.isArray(rules)) {
        return {
          ok: false,
          error: 'invalid_request',
          error_description: `claims._asc.sao.${target} must be an array`,
        };
      }
      const validatedRules: SAORule[] = [];
      for (let i = 0; i < rules.length; i += 1) {
        const rule = validateSAORule(rules[i], `claims._asc.sao.${target}[${i}]`);
        if (!rule.ok) return rule;
        validatedRules.push(rule.rule);
      }
      sao[target] = validatedRules;
    }
    asc.sao = sao;
  }

  return { ok: true, asc };
}

function validateSAORule(
  value: unknown,
  path: string
): { ok: true; rule: SAORule } | { ok: false; error: string; error_description: string } {
  if (!isPlainObject(value)) {
    return { ok: false, error: 'invalid_request', error_description: `${path} must be an object` };
  }
  const rule = value as Record<string, unknown>;
  const method = (rule.method ?? 'exists') as string;

  if (typeof rule.loc !== 'string' || !rule.loc.startsWith('/')) {
    return {
      ok: false,
      error: 'invalid_request',
      error_description: `${path}.loc must be a JSON Pointer string`,
    };
  }
  if (!['exists', 'simple', 'schema'].includes(method)) {
    return {
      ok: false,
      error: 'invalid_request',
      error_description: `${path}.method must be one of: exists, simple, schema`,
    };
  }
  if (rule.else !== 'abort' && rule.else !== 'omit') {
    return {
      ok: false,
      error: 'invalid_request',
      error_description: `${path}.else must be one of: abort, omit`,
    };
  }
  if (method === 'schema') {
    return {
      ok: false,
      error: 'invalid_request',
      error_description: `${path}.method=schema is not supported`,
    };
  }
  if (method === 'simple') {
    const hasValue = Object.prototype.hasOwnProperty.call(rule, 'value');
    const hasValues = Object.prototype.hasOwnProperty.call(rule, 'values');
    if (hasValue === hasValues) {
      return {
        ok: false,
        error: 'invalid_request',
        error_description: `${path} must contain exactly one of value or values for method=simple`,
      };
    }
    if (hasValue && !isPrimitiveComparable(rule.value)) {
      return {
        ok: false,
        error: 'invalid_request',
        error_description: `${path}.value must be a string, number, or boolean`,
      };
    }
    if (
      hasValues &&
      (!Array.isArray(rule.values) || !rule.values.every((item) => isPrimitiveComparable(item)))
    ) {
      return {
        ok: false,
        error: 'invalid_request',
        error_description: `${path}.values must be an array of strings, numbers, or booleans`,
      };
    }
  }
  if (rule.else === 'abort' && rule.what !== undefined) {
    return {
      ok: false,
      error: 'invalid_request',
      error_description: `${path}.what must not be used with else=abort`,
    };
  }
  if (rule.what !== undefined) {
    if (
      !Array.isArray(rule.what) ||
      !rule.what.every((item) => typeof item === 'string' && item.startsWith('/'))
    ) {
      return {
        ok: false,
        error: 'invalid_request',
        error_description: `${path}.what must be an array of JSON Pointer strings`,
      };
    }
  }

  return {
    ok: true,
    rule: {
      loc: rule.loc,
      method: method as SAORule['method'],
      ...(rule.value !== undefined ? { value: rule.value as string | number | boolean } : {}),
      ...(rule.values !== undefined
        ? { values: rule.values as Array<string | number | boolean> }
        : {}),
      else: rule.else,
      ...(rule.what !== undefined ? { what: rule.what } : {}),
    },
  };
}

export function evaluateClaimsForTarget(options: EvaluateClaimsOptions): ClaimsEvaluationResult {
  const clientPolicy = options.clientPolicy ?? {};
  if (options.claimsRequest?._asc?.transformed_claims && isASCEnabled(clientPolicy)) {
    return {
      ok: false,
      error: 'invalid_request',
      error_description:
        'Custom transformed_claims are not supported; use predefined transformed claims',
    };
  }

  const output: Record<string, unknown> = { ...(options.initialClaims ?? {}) };
  const scopes = new Set(options.grantedScopes);

  if (options.includeScopeClaims !== false) {
    for (const [claim, requiredScope] of Object.entries(CLAIM_SCOPE)) {
      if (scopes.has(requiredScope) && options.availableClaims[claim] !== undefined) {
        output[claim] = options.availableClaims[claim];
      }
    }
  }

  const requestedClaims = options.claimsRequest?.[options.target] ?? {};
  const ascApplies = shouldApplyASC(options);
  const saoApplies =
    ascApplies &&
    clientPolicy.asc_sao_enabled !== false &&
    hasSAORulesForTarget(options.claimsRequest, options.target);
  const ignoreValueRestrictions = saoApplies;

  for (const [claimName, claimRequest] of Object.entries(requestedClaims)) {
    const transformed = ascApplies
      ? resolvePredefinedTransformedClaim(claimName, options.availableClaims, clientPolicy)
      : { exists: false as const };
    const value = transformed.exists ? transformed.value : options.availableClaims[claimName];
    const exists = transformed.exists || value !== undefined;

    if (!exists || !canReleaseClaim(claimName, scopes, clientPolicy)) {
      continue;
    }

    if (!ignoreValueRestrictions && claimRequest && !matchesClaimRequest(value, claimRequest)) {
      if (claimName === 'sub') {
        return {
          ok: false,
          error: 'invalid_request',
          error_description: 'Requested sub claim value does not match authenticated subject',
        };
      }
      if (claimName === 'acr' && claimRequest.essential === true) {
        return {
          ok: false,
          error: 'login_required',
          error_description: 'Requested essential acr claim could not be satisfied',
        };
      }
      continue;
    }

    output[claimName] = value;
  }

  if (options.applySAO !== false && saoApplies) {
    const sao = options.claimsRequest?._asc?.sao?.[options.target] ?? [];
    const saoResult = applySAORules(output, sao);
    if (!saoResult.ok) return saoResult;
  }

  return { ok: true, claims: output };
}

export function buildStandardUserClaims(user: {
  name?: string | null;
  family_name?: string | null;
  given_name?: string | null;
  middle_name?: string | null;
  nickname?: string | null;
  preferred_username?: string | null;
  profile?: string | null;
  picture?: string | null;
  website?: string | null;
  gender?: string | null;
  birthdate?: string | null;
  zoneinfo?: string | null;
  locale?: string | null;
  updated_at?: number | null;
  email?: string | null;
  email_verified?: boolean | null;
  phone_number?: string | null;
  phone_number_verified?: boolean | null;
  address?: string | Record<string, unknown> | null;
}): Record<string, unknown> {
  let address: unknown;
  if (typeof user.address === 'string') {
    try {
      address = JSON.parse(user.address);
    } catch {
      address = undefined;
    }
  } else {
    address = user.address ?? undefined;
  }

  return {
    name: user.name || undefined,
    family_name: user.family_name || undefined,
    given_name: user.given_name || undefined,
    middle_name: user.middle_name || undefined,
    nickname: user.nickname || undefined,
    preferred_username: user.preferred_username || undefined,
    profile: user.profile || undefined,
    picture: user.picture || undefined,
    website: user.website || undefined,
    gender: user.gender || undefined,
    birthdate: user.birthdate || undefined,
    zoneinfo: user.zoneinfo || undefined,
    locale: user.locale || undefined,
    updated_at: user.updated_at
      ? user.updated_at >= 1e12
        ? Math.floor(user.updated_at / 1000)
        : user.updated_at
      : Math.floor(Date.now() / 1000),
    email: user.email || undefined,
    email_verified: user.email_verified ?? undefined,
    phone_number: user.phone_number || undefined,
    phone_number_verified: user.phone_number_verified ?? undefined,
    address,
  };
}

export function hasSAORulesForTarget(
  claimsRequest: ParsedClaimsRequest | undefined,
  target: ClaimsTarget
): boolean {
  return (claimsRequest?._asc?.sao?.[target]?.length ?? 0) > 0;
}

function matchesClaimRequest(value: unknown, request: OIDCIndividualClaimRequest): boolean {
  if ('value' in request && !isSameClaimValue(value, request.value)) return false;
  if ('values' in request && !request.values?.some((item) => isSameClaimValue(value, item))) {
    return false;
  }
  return true;
}

function canReleaseClaim(
  claimName: string,
  scopes: Set<string>,
  clientPolicy: OIDCClaimsClientPolicy
): boolean {
  const normalizedClaimName = stripPredefinedPrefix(claimName);
  const policyClaimName =
    PREDEFINED_TRANSFORMED_BASE_CLAIM[normalizedClaimName] ?? normalizedClaimName;
  const policy =
    clientPolicy.claims_parameter_policy?.[claimName] ??
    clientPolicy.claims_parameter_policy?.[normalizedClaimName] ??
    clientPolicy.claims_parameter_policy?.[policyClaimName];
  if (policy === 'forbidden') return false;
  if (policy === 'claims_allowed') return true;

  const requiredScope = CLAIM_SCOPE[policyClaimName];
  if (!requiredScope) return true;
  if (scopes.has(requiredScope)) return true;

  if (policy === 'scope_required') return false;
  return clientPolicy.allow_claims_without_scope === true;
}

function resolvePredefinedTransformedClaim(
  claimName: string,
  claims: Record<string, unknown>,
  clientPolicy: OIDCClaimsClientPolicy
): { exists: true; value: unknown } | { exists: false } {
  if (!claimName.startsWith('::')) return { exists: false };
  if (clientPolicy.asc_transformed_claims_enabled === false || !isASCEnabled(clientPolicy)) {
    return { exists: false };
  }

  const predefinedName = claimName.slice(2);
  const allowed =
    clientPolicy.asc_allowed_transformed_claims ?? DEFAULT_ASC_ALLOWED_TRANSFORMED_CLAIMS;
  if (!allowed.includes(predefinedName) || !(predefinedName in PREDEFINED_TRANSFORMED_CLAIMS)) {
    return { exists: false };
  }

  switch (predefinedName) {
    case 'age_over_13':
      return booleanFromBirthdate(claims.birthdate, 13);
    case 'age_over_18':
      return booleanFromBirthdate(claims.birthdate, 18);
    case 'age_over_20':
      return booleanFromBirthdate(claims.birthdate, 20);
    case 'email_domain':
      return typeof claims.email === 'string'
        ? { exists: true, value: claims.email.split('@')[1] || '' }
        : { exists: false };
    case 'phone_country_code':
      return typeof claims.phone_number === 'string'
        ? { exists: true, value: extractPhoneCountryCode(claims.phone_number) }
        : { exists: false };
    case 'address_country':
      return isPlainObject(claims.address) && typeof claims.address.country === 'string'
        ? { exists: true, value: claims.address.country }
        : { exists: false };
    default:
      return { exists: false };
  }
}

function booleanFromBirthdate(
  value: unknown,
  minimumAge: number
): { exists: true; value: boolean } | { exists: false } {
  if (typeof value !== 'string') return { exists: false };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return { exists: false };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year === 0 ||
    month < 1 ||
    month > 12
  ) {
    return { exists: false };
  }
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > lastDayOfMonth) {
    return { exists: false };
  }

  const today = new Date();
  let age = today.getUTCFullYear() - year;
  const currentMonth = today.getUTCMonth() + 1;
  const currentDay = today.getUTCDate();
  if (currentMonth < month || (currentMonth === month && currentDay < day)) {
    age -= 1;
  }
  return { exists: true, value: age >= minimumAge };
}

function extractPhoneCountryCode(value: string): string {
  const normalized = value.trim();
  const match = /^\+(\d{1,3})/.exec(normalized);
  return match ? `+${match[1]}` : '';
}

function applySAORules(claims: Record<string, unknown>, rules: SAORule[]): ClaimsEvaluationResult {
  for (const rule of rules) {
    const value = getByJsonPointer(claims, rule.loc);
    let matched = value.exists;
    if (value.exists && rule.method === 'simple') {
      if (rule.value !== undefined) {
        matched = isSameClaimValue(value.value, rule.value);
      } else {
        matched = !!rule.values?.some((item) => isSameClaimValue(value.value, item));
      }
    }

    if (matched) continue;
    if (rule.else === 'abort') {
      return {
        ok: false,
        error: 'invalid_request',
        error_description: `ASC SAO abort triggered for ${rule.loc}`,
      };
    }

    const pointers = rule.what?.length ? rule.what : [rule.loc];
    for (const pointer of pointers) {
      deleteByJsonPointer(claims, pointer);
    }
  }

  return { ok: true, claims };
}

function shouldApplyASC(options: EvaluateClaimsOptions): boolean {
  const clientPolicy = options.clientPolicy ?? {};
  if (!hasASCFeature(options.claimsRequest) || !isASCEnabled(clientPolicy)) return false;
  if (clientPolicy.asc_protected_request_required === false) return true;
  return options.requestIntegrityProtected === true;
}

function hasASCFeature(claimsRequest: ParsedClaimsRequest | undefined): boolean {
  if (!claimsRequest) return false;
  if (claimsRequest._asc) return true;
  return (
    Object.keys(claimsRequest.id_token).some((claim) => claim.startsWith('::')) ||
    Object.keys(claimsRequest.userinfo).some((claim) => claim.startsWith('::'))
  );
}

function isASCEnabled(clientPolicy: OIDCClaimsClientPolicy): boolean {
  return clientPolicy.asc_enabled !== false;
}

function getByJsonPointer(
  object: Record<string, unknown>,
  pointer: string
): { exists: true; value: unknown } | { exists: false } {
  const path = parseJsonPointer(pointer);
  let current: unknown = object;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length)
        return { exists: false };
      current = current[index];
    } else if (isPlainObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return { exists: false };
      current = current[segment];
    } else {
      return { exists: false };
    }
  }
  return { exists: true, value: current };
}

function deleteByJsonPointer(object: Record<string, unknown>, pointer: string): void {
  const path = parseJsonPointer(pointer);
  if (path.length === 0) return;
  let current: unknown = object;
  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (isPlainObject(current)) {
      current = current[segment];
    } else {
      return;
    }
  }
  const last = path[path.length - 1];
  if (Array.isArray(current)) {
    const index = Number(last);
    if (Number.isInteger(index)) current.splice(index, 1);
  } else if (isPlainObject(current)) {
    delete current[last];
  }
}

function parseJsonPointer(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function stripPredefinedPrefix(claimName: string): string {
  return claimName.startsWith('::') ? claimName.slice(2) : claimName;
}

function isSameClaimValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitiveComparable(value: unknown): value is string | number | boolean {
  return ['string', 'number', 'boolean'].includes(typeof value);
}
