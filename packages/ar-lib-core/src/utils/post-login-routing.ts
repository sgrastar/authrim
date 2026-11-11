import type { KVNamespace } from '@cloudflare/workers-types';
import { LOGIN_ENTRY_DEFAULTS } from '../types/settings/login-entry';
import { SELF_SERVICE_DEFAULTS } from '../types/settings/self-service';
import { arrayBufferToBase64Url, generateSecureRandomString } from './crypto';

export type PostLoginBehavior = 'home' | 'account' | 'custom_url' | 'app_login' | 'saml_login';

/** The most bytes a SAML RelayState may have (SAML 2.0 bindings, 3.4.3 / 3.5.3). */
export const MAX_SAML_LOGIN_RELAY_STATE_BYTES = 80;
/** The longest SAML entity ID a post-login SAML sign-in names. */
const MAX_SAML_ENTITY_ID_LENGTH = 1024;
// eslint-disable-next-line no-control-regex -- a control character is what it refuses
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

const RESERVED_RELATIVE_PATH_PREFIXES = [
  '/admin',
  '/api',
  '/oauth',
  '/oidc',
  '/saml',
  '/.well-known',
  '/authorize',
  '/token',
  '/userinfo',
  '/introspect',
  '/revoke',
  '/par',
  '/jwks',
  '/login',
  '/signup',
  '/consent',
  '/device',
  '/discover',
  '/callback',
  '/reauth',
  '/verify-email-code',
  '/error',
  '/logout',
  '/handoff',
  '/_authrim_login',
  '/_authrim_admin',
  '/_app',
];

type SettingsKV = Pick<KVNamespace, 'get'>;

interface PostLoginSettingsEnv {
  SETTINGS?: SettingsKV | null;
  AUTHRIM_CONFIG?: SettingsKV | null;
}

export interface PostLoginResolution {
  redirectUrl: string;
  behavior: PostLoginBehavior;
}

function hasKVGet(value: unknown): value is SettingsKV {
  return !!value && typeof (value as { get?: unknown }).get === 'function';
}

async function readSettingsRecord(
  kv: unknown,
  key: string
): Promise<Record<string, unknown> | null> {
  if (!hasKVGet(kv)) {
    return null;
  }

  try {
    const raw = await kv.get(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isSingleSlashRelativePath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}

function matchesPathPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isReservedAuthrimPath(path: string): boolean {
  if (path === '/') {
    return false;
  }
  return RESERVED_RELATIVE_PATH_PREFIXES.some((prefix) => matchesPathPrefix(path, prefix));
}

export function validateAccountPagePath(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const path = value.trim();
  return (
    path.length > 1 &&
    isSingleSlashRelativePath(path) &&
    !path.includes('?') &&
    !path.includes('#') &&
    !isReservedAuthrimPath(path)
  );
}

function readTrustedRedirectOriginCandidates(value: string): unknown[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return value
      .split(/[\n,]/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
}

function normalizeTrustedRedirectOrigin(candidate: unknown): string | null {
  if (typeof candidate !== 'string') {
    return null;
  }

  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function parseTrustedRedirectOrigins(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim() === '') {
    return [];
  }

  const candidates = readTrustedRedirectOriginCandidates(value);
  if (!candidates) {
    return [];
  }

  const origins = new Set<string>();
  for (const candidate of candidates) {
    const origin = normalizeTrustedRedirectOrigin(candidate);
    if (origin) {
      origins.add(origin);
    }
  }
  return [...origins].sort();
}

export function validateTrustedRedirectOrigins(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.trim() === '') {
    return true;
  }
  const candidates = readTrustedRedirectOriginCandidates(value);
  return (
    !!candidates && candidates.every((candidate) => !!normalizeTrustedRedirectOrigin(candidate))
  );
}

export function validatePostLoginRedirectUrl(
  value: unknown,
  trustedOrigins: readonly string[]
): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const redirectUrl = value.trim();
  if (!redirectUrl) {
    return false;
  }

  if (isSingleSlashRelativePath(redirectUrl)) {
    try {
      const parsed = new URL(redirectUrl, 'https://authrim.local');
      return !isReservedAuthrimPath(parsed.pathname);
    } catch {
      return false;
    }
  }

  if (redirectUrl.startsWith('//')) {
    return false;
  }

  try {
    const parsed = new URL(redirectUrl);
    return parsed.protocol === 'https:' && trustedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

const POST_LOGIN_BEHAVIORS: readonly PostLoginBehavior[] = [
  'home',
  'account',
  'custom_url',
  'app_login',
  'saml_login',
];

function readPostLoginBehavior(value: unknown): PostLoginBehavior {
  return POST_LOGIN_BEHAVIORS.includes(value as PostLoginBehavior)
    ? (value as PostLoginBehavior)
    : 'home';
}

/** A SAML service provider's entity ID as a post-login SAML sign-in names it. */
export function validateSamlLoginSpEntityId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const entityId = value.trim();
  return (
    entityId.length > 0 &&
    entityId.length <= MAX_SAML_ENTITY_ID_LENGTH &&
    !CONTROL_CHARACTER.test(entityId)
  );
}

/** A RelayState for the SAML service provider: empty, or at most 80 bytes with no control characters. */
export function validateSamlLoginRelayState(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return (
    new TextEncoder().encode(value).length <= MAX_SAML_LOGIN_RELAY_STATE_BYTES &&
    !CONTROL_CHARACTER.test(value)
  );
}

/**
 * The SAML IdP-initiated sign-in to the service provider (`/saml/idp/init`): it uses the session
 * the Login UI has just made, and runs the provider's own consent and assurance checks.
 */
function buildSamlLoginUrl(loginEntry: Record<string, unknown>): string | null {
  const entityId = loginEntry['login-entry.saml_login_sp_entity_id'];
  if (!validateSamlLoginSpEntityId(entityId)) return null;
  const relayState = loginEntry['login-entry.saml_login_relay_state'];
  const params = new URLSearchParams({ sp: entityId.trim() });
  if (validateSamlLoginRelayState(relayState) && relayState) {
    params.set('relay_state', relayState);
  }
  return `/saml/idp/init?${params.toString()}`;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function encodeBase64Url(value: string): string {
  return arrayBufferToBase64Url(new TextEncoder().encode(value));
}

function createAppLoginState(finalReturnTo: string | null): string {
  return `ar_app_login.${encodeBase64Url(
    JSON.stringify({
      id: generateSecureRandomString(32),
      ...(finalReturnTo ? { return_to: finalReturnTo } : {}),
    })
  )}`;
}

function buildAppLoginAuthorizeUrl(
  loginEntry: Record<string, unknown>,
  trustedOrigins: readonly string[]
): string | null {
  const clientId = readNonEmptyString(
    loginEntry['login-entry.app_login_client_id'] ??
      LOGIN_ENTRY_DEFAULTS['login-entry.app_login_client_id']
  );
  const redirectUri = readNonEmptyString(
    loginEntry['login-entry.app_login_redirect_uri'] ??
      LOGIN_ENTRY_DEFAULTS['login-entry.app_login_redirect_uri']
  );
  const scope =
    readNonEmptyString(
      loginEntry['login-entry.app_login_scope'] ??
        LOGIN_ENTRY_DEFAULTS['login-entry.app_login_scope']
    ) ?? LOGIN_ENTRY_DEFAULTS['login-entry.app_login_scope'];
  if (!clientId || !redirectUri) {
    return null;
  }

  // Where the service app goes after its callback: checked here as well as where it is saved (a
  // registration Flow's own completion is read from its policy), and left out when it is not a
  // non-reserved path or a trusted HTTPS URL.
  const configuredReturnTo = readNonEmptyString(
    loginEntry['login-entry.app_login_final_return_to']
  );
  const finalReturnTo =
    configuredReturnTo && validatePostLoginRedirectUrl(configuredReturnTo, trustedOrigins)
      ? configuredReturnTo
      : null;
  const state = createAppLoginState(finalReturnTo);
  const nonce = generateSecureRandomString(32);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    nonce,
  });
  return `/authorize?${params.toString()}`;
}

export async function resolvePostLoginRedirectUrl(
  env: PostLoginSettingsEnv,
  tenantId: string
): Promise<PostLoginResolution> {
  const settingsKv = env.SETTINGS ?? env.AUTHRIM_CONFIG;
  const [loginEntry, selfService, security] = await Promise.all([
    readSettingsRecord(settingsKv, `settings:tenant:${tenantId}:login-entry`),
    readSettingsRecord(settingsKv, `settings:tenant:${tenantId}:self-service`),
    readSettingsRecord(settingsKv, `settings:tenant:${tenantId}:security`),
  ]);
  return resolvePostLoginFrom(loginEntry, selfService, security);
}

/** Where a sign-in goes by these settings (the tenant's, or a Flow's own laid out as them). */
function resolvePostLoginFrom(
  loginEntry: Record<string, unknown> | null,
  selfService: Record<string, unknown> | null,
  security: Record<string, unknown> | null
): PostLoginResolution {
  const behavior = readPostLoginBehavior(
    loginEntry?.['login-entry.post_login_behavior'] ??
      LOGIN_ENTRY_DEFAULTS['login-entry.post_login_behavior']
  );

  if (behavior === 'account') {
    const enabled =
      selfService?.['self-service.account_page_enabled'] ??
      SELF_SERVICE_DEFAULTS['self-service.account_page_enabled'];
    const accountPath =
      selfService?.['self-service.account_page_path'] ??
      SELF_SERVICE_DEFAULTS['self-service.account_page_path'];
    if (enabled === true && validateAccountPagePath(accountPath)) {
      return { redirectUrl: accountPath, behavior };
    }
    return { redirectUrl: '/', behavior: 'home' };
  }

  if (behavior === 'custom_url') {
    const trustedOrigins = parseTrustedRedirectOrigins(
      security?.['security.trusted_redirect_origins']
    );
    const configuredUrl = loginEntry?.['login-entry.post_login_redirect_url'];
    if (validatePostLoginRedirectUrl(configuredUrl, trustedOrigins)) {
      return { redirectUrl: configuredUrl.trim(), behavior };
    }
    return { redirectUrl: '/', behavior: 'home' };
  }

  if (behavior === 'app_login' && loginEntry) {
    const authorizeUrl = buildAppLoginAuthorizeUrl(
      loginEntry,
      parseTrustedRedirectOrigins(security?.['security.trusted_redirect_origins'])
    );
    if (authorizeUrl) {
      return { redirectUrl: authorizeUrl, behavior };
    }
    return { redirectUrl: '/', behavior: 'home' };
  }

  if (behavior === 'saml_login' && loginEntry) {
    const samlUrl = buildSamlLoginUrl(loginEntry);
    if (samlUrl) {
      return { redirectUrl: samlUrl, behavior };
    }
    return { redirectUrl: '/', behavior: 'home' };
  }

  return { redirectUrl: '/', behavior: 'home' };
}

/** A registration Flow's own completion (ar-lib-core `registration-policy.ts`). */
export interface RegistrationCompletionInput {
  behavior: 'account' | 'home' | 'custom_url' | 'app_login' | 'saml_login' | 'service_site';
  redirect_url?: string;
  app_login_client_id?: string;
  app_login_redirect_uri?: string;
  app_login_scope?: string;
  app_login_final_return_to?: string;
  saml_login_sp_entity_id?: string;
  saml_login_relay_state?: string;
  service_site_path?: string;
}

/** A path on this site the attached service Worker serves: relative, not one of Authrim's. */
export function validateServiceSitePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const path = value.trim();
  if (!isSingleSlashRelativePath(path) || path.length > 512) return false;
  // A backslash or a control character can make a browser read the path as another host
  // (`/\evil.example`): refused, and what it resolves to must stay on this site.
  if (path.includes('\\') || CONTROL_CHARACTER.test(path)) return false;
  try {
    const base = 'https://authrim.local';
    const resolved = new URL(path, base);
    return resolved.origin === base && !isReservedAuthrimPath(resolved.pathname);
  } catch {
    return false;
  }
}

/**
 * Where a person goes once signed up through a registration Flow that sets its own destination,
 * checked as the tenant's post-sign-in destination is (the account page enabled, a trusted URL,
 * the App Login client, the SAML service provider). `service_site`: a path the attached service
 * Worker serves, only while the router passes such paths to it (`service-site.fallback_enabled`).
 */
export async function resolveRegistrationCompletionRedirectUrl(
  env: PostLoginSettingsEnv,
  tenantId: string,
  completion: RegistrationCompletionInput
): Promise<{ redirectUrl: string; behavior: PostLoginBehavior | 'service_site' }> {
  const settingsKv = env.SETTINGS ?? env.AUTHRIM_CONFIG;
  if (completion.behavior === 'service_site') {
    const serviceSite = await readSettingsRecord(
      settingsKv,
      `settings:tenant:${tenantId}:service-site`
    );
    if (
      serviceSite?.['service-site.fallback_enabled'] === true &&
      validateServiceSitePath(completion.service_site_path)
    ) {
      return { redirectUrl: completion.service_site_path.trim(), behavior: 'service_site' };
    }
    return { redirectUrl: '/', behavior: 'home' };
  }
  const [selfService, security] = await Promise.all([
    readSettingsRecord(settingsKv, `settings:tenant:${tenantId}:self-service`),
    readSettingsRecord(settingsKv, `settings:tenant:${tenantId}:security`),
  ]);
  return resolvePostLoginFrom(
    {
      'login-entry.post_login_behavior': completion.behavior,
      'login-entry.post_login_redirect_url': completion.redirect_url,
      'login-entry.app_login_client_id': completion.app_login_client_id,
      'login-entry.app_login_redirect_uri': completion.app_login_redirect_uri,
      'login-entry.app_login_scope': completion.app_login_scope,
      'login-entry.app_login_final_return_to': completion.app_login_final_return_to,
      'login-entry.saml_login_sp_entity_id': completion.saml_login_sp_entity_id,
      'login-entry.saml_login_relay_state': completion.saml_login_relay_state,
    },
    selfService,
    security
  );
}

export function validateLoginEntryPostLoginSettings(
  values: Record<string, unknown>,
  trustedOrigins: readonly string[] = []
): Record<string, string> {
  const rejected: Record<string, string> = {};
  const behavior = values['login-entry.post_login_behavior'];
  if (behavior !== undefined && !POST_LOGIN_BEHAVIORS.includes(behavior as PostLoginBehavior)) {
    rejected['login-entry.post_login_behavior'] =
      `Value must be one of: ${POST_LOGIN_BEHAVIORS.join(', ')}`;
  }

  const redirectUrl = values['login-entry.post_login_redirect_url'];
  if (redirectUrl !== undefined && !validatePostLoginRedirectUrl(redirectUrl, trustedOrigins)) {
    rejected['login-entry.post_login_redirect_url'] =
      'Must be a non-reserved relative path or an HTTPS URL whose origin is trusted';
  }
  const finalReturnTo = values['login-entry.app_login_final_return_to'];
  if (
    finalReturnTo !== undefined &&
    finalReturnTo !== '' &&
    !validatePostLoginRedirectUrl(finalReturnTo, trustedOrigins)
  ) {
    rejected['login-entry.app_login_final_return_to'] =
      'Must be empty, a non-reserved relative path, or an HTTPS URL whose origin is trusted';
  }
  const entityId = values['login-entry.saml_login_sp_entity_id'];
  if (entityId !== undefined && entityId !== '' && !validateSamlLoginSpEntityId(entityId)) {
    rejected['login-entry.saml_login_sp_entity_id'] =
      'Must be a SAML entity ID of at most 1024 characters, without control characters';
  }
  const relayState = values['login-entry.saml_login_relay_state'];
  if (relayState !== undefined && !validateSamlLoginRelayState(relayState)) {
    rejected['login-entry.saml_login_relay_state'] =
      'Must be at most 80 bytes, without control characters';
  }
  return rejected;
}
