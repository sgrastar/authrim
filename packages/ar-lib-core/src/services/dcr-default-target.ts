/**
 * The default access token target a tenant gives to the apps that register themselves
 * (`dcr.default_audience` and `dcr.default_resource`, the `dcr` category, tenant scope).
 *
 * The values are COPIED into the new app's `default_audience` / `default_resource` columns when it
 * registers; nothing reads them afterwards, so changing them never retargets an app that already
 * exists. At registration (see `resolveDefaultAccessTokenTarget` in ar-management/register.ts):
 *
 * 1. the registration request's own `default_audience` / `default_resource` win;
 * 2. an app that uses the authorization code grant gets the issuer URL, as before (its tokens are
 *    accepted at /userinfo, which takes the issuer or issuer/userinfo as the audience): the
 *    tenant's default never replaces that;
 * 3. an app without that grant but with one that falls back to the default target (client
 *    credentials, CIBA, device, token exchange: `grantsUseDefaultTarget`) has no target otherwise and
 *    could never get a token (`invalid_target`): the tenant's default fills in;
 * 4. else none (implicit and refresh token only apps never use a default target).
 *
 * Validation lives here so that saving a value (the Settings API) and using it (registration)
 * agree: a stored value that does not pass is ignored, as if unset.
 */

import { DCR_SETTINGS_META } from '../types/settings/dcr';
import { buildIssuerUrl } from '../utils/issuer';
import { getTenantReachableIssuers } from '../utils/tenant-binding-policy';
import { resolveEffectiveSettings, type EffectiveSettingsEnv } from './effective-settings';
import { buildCanonicalTenantIssuerUrl } from './tenant-vanity-domain-resolver';
import type { Env } from '../types/env';
import type { DatabaseSource } from '../db/adapter-source';

/**
 * The grant types whose token path really falls back to the app's default target when the token
 * request names no resource or audience (`resolveAccessTokenAudience` in ar-token/token.ts):
 * client credentials, CIBA, the device grant, and token exchange (which Native SSO uses). This is
 * the token endpoint's truth, and it is wider than what dynamic registration accepts: DCR
 * currently registers client_credentials and CIBA apps from this set (`validGrantTypes` in
 * ar-management/register.ts); device and token-exchange apps are created through the admin API,
 * which does not copy this default. The authorization code grant has the issuer URL; implicit and
 * hybrid responses pin the access token audience to the issuer (ar-auth/authorize.ts); a refresh
 * token reuses the audience of the grant it came from; JWT bearer takes its target from the
 * trusted issuer. The tenant's default is only given to an app with at least one of these grants:
 * anywhere else it would never be used.
 */
export const DEFAULT_TARGET_GRANT_TYPES: readonly string[] = [
  'client_credentials',
  'urn:openid:params:grant-type:ciba',
  'urn:ietf:params:oauth:grant-type:device_code',
  'urn:ietf:params:oauth:grant-type:token-exchange',
];

/** Whether an app with these grant types has a token path that uses the app's default target. */
export function grantsUseDefaultTarget(grantTypes: readonly string[]): boolean {
  return grantTypes.some((grantType) => DEFAULT_TARGET_GRANT_TYPES.includes(grantType));
}

/** Longest default audience or resource (characters). */
export const DCR_DEFAULT_TARGET_MAX_LENGTH = 2048;

// eslint-disable-next-line no-control-regex -- matches C0/DEL control characters on purpose (input hygiene)
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f]/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A URL in the form two spellings of the same issuer share: scheme and host case, internationalised
 * hosts as punycode, default port, trailing slash, and the case of percent-encodings.
 */
function comparable(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '').replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
    return `${url.protocol}//${url.host}${path}${url.search.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase())}`;
  } catch {
    return value;
  }
}

/**
 * The problem with a default resource (RFC 8707 section 2: an absolute URI without a fragment),
 * or null. An empty string means "no default" and is fine. Only https is accepted, and http for a
 * local development host.
 */
export function dcrDefaultResourceProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'dcr.default_resource must be a string';
  if (value === '') return null;
  if (value.length > DCR_DEFAULT_TARGET_MAX_LENGTH) {
    return `dcr.default_resource must be at most ${DCR_DEFAULT_TARGET_MAX_LENGTH} characters`;
  }
  if (WHITESPACE_OR_CONTROL.test(value)) {
    return 'dcr.default_resource must not contain spaces or control characters';
  }
  if (value.includes('#')) return 'dcr.default_resource must not contain a fragment (RFC 8707)';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'dcr.default_resource must be an absolute URI (RFC 8707)';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return null;
  return 'dcr.default_resource must use https (http only for localhost, 127.0.0.1 or [::1])';
}

/**
 * The problem with a default audience, or null. It is an absolute URI or an opaque identifier, so
 * only its shape is checked: not empty, no spaces or control characters, bounded length. An empty
 * string means "no default" and is fine.
 */
export function dcrDefaultAudienceProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'dcr.default_audience must be a string';
  if (value === '') return null;
  if (value.length > DCR_DEFAULT_TARGET_MAX_LENGTH) {
    return `dcr.default_audience must be at most ${DCR_DEFAULT_TARGET_MAX_LENGTH} characters`;
  }
  if (WHITESPACE_OR_CONTROL.test(value)) {
    return 'dcr.default_audience must not contain spaces or control characters';
  }
  return null;
}

/**
 * The problem with a default target that equals an audience the platform keeps for itself: the
 * tenant's issuer URL (what authorization code apps get) or its /userinfo URL. A new app given one
 * of those would hold tokens for the platform's own endpoints. Returns null for anything else.
 */
export function dcrReservedTargetProblem(
  key: 'dcr.default_audience' | 'dcr.default_resource',
  value: string,
  issuerUrls: readonly string[]
): string | null {
  if (value === '') return null;
  const candidate = comparable(value);
  for (const issuer of issuerUrls) {
    if (!issuer) continue;
    const base = comparable(issuer);
    if (candidate === base || candidate === `${base}/userinfo`) {
      return `${key} must not be this tenant's issuer URL or its /userinfo URL: those are the platform's own audiences`;
    }
  }
  return null;
}

/** Every problem of one key's value (format, then reserved audiences), or null. */
export function dcrDefaultTargetProblem(
  key: 'dcr.default_audience' | 'dcr.default_resource',
  value: unknown,
  issuerUrls: readonly string[] = []
): string | null {
  const format =
    key === 'dcr.default_audience'
      ? dcrDefaultAudienceProblem(value)
      : dcrDefaultResourceProblem(value);
  if (format) return format;
  return dcrReservedTargetProblem(key, value as string, issuerUrls);
}

/**
 * The issuer URLs of a tenant that a default target must not equal: every issuer the tenant
 * answers protocol requests on (see `getTenantReachableIssuers`: its allowed domains and
 * identifiers, its primary custom domain, the naked domain when it is the primary tenant's), the
 * environment's issuer, and any the caller already knows (the issuer the request arrived at).
 * Every host the tenant's host/identifier policy allows is reserved, whether or not a
 * vanity/lookup assignment routes it today. The primary custom domain lookup is STRICT: this
 * THROWS when the tenant's binding policy or its primary custom domain cannot be read (a lookup
 * that succeeds and finds none is fine), so a default is never accepted on a guess.
 */
export async function tenantIssuerUrls(
  baseEnv: Partial<Env>,
  tenantId: string,
  known: readonly string[] = [],
  /** The tenant's core database when the request already resolved it (else the registry does). */
  options: { tenantCoreDb?: DatabaseSource } = {}
): Promise<string[]> {
  const env = (
    options.tenantCoreDb ? { ...baseEnv, tenantCoreDb: options.tenantCoreDb } : baseEnv
  ) as Partial<Env>;
  const urls = new Set<string>(known.filter(Boolean));
  const configured = buildIssuerUrl(env, tenantId);
  if (configured) urls.add(configured);
  const canonical = await buildCanonicalTenantIssuerUrl(env, tenantId, configured, {
    strict: true,
  });
  if (canonical) urls.add(canonical);
  const reachable = await getTenantReachableIssuers(env.AUTHRIM_CONFIG, env, tenantId, {
    strictVanity: true,
  });
  for (const issuer of reachable) {
    urls.add(issuer);
  }
  return [...urls];
}

export interface DcrDefaultTarget {
  audience?: string;
  resource?: string;
  /** Stored values that were not used, with why (for a warning in the log). */
  ignored: Array<{ key: string; problem: string }>;
}

/**
 * The tenant's default target for new apps. A stored value that does not pass the checks above is
 * ignored (reported in `ignored`) and counts as unset, each key on its own.
 *
 * THROWS when the tenant's `dcr` settings document exists but cannot be read: that must not mean
 * "no default", so the caller refuses the registration. A missing document is not an error. The
 * document is read without the per-isolate cache.
 */
export async function resolveDcrDefaultTarget(
  env: EffectiveSettingsEnv,
  tenantId: string,
  issuerUrls: readonly string[]
): Promise<DcrDefaultTarget> {
  // Fresh: the value is copied into the app for good, so a change or a clear an admin just made
  // must not be missed because an isolate read the document a moment ago.
  const values = await resolveEffectiveSettings(env, 'dcr', { tenantId, fresh: true });
  const result: DcrDefaultTarget = { ignored: [] };
  for (const key of ['dcr.default_audience', 'dcr.default_resource'] as const) {
    const value = values[key] ?? DCR_SETTINGS_META[key].default;
    if (value === '') continue;
    const problem = dcrDefaultTargetProblem(key, value, issuerUrls);
    if (problem) {
      result.ignored.push({ key, problem });
      continue;
    }
    if (key === 'dcr.default_audience') result.audience = value as string;
    else result.resource = value as string;
  }
  return result;
}
