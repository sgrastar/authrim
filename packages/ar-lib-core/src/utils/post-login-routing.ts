import type { KVNamespace } from '@cloudflare/workers-types';
import { LOGIN_ENTRY_DEFAULTS, type LoginEntrySettings } from '../types/settings/login-entry';
import { SELF_SERVICE_DEFAULTS } from '../types/settings/self-service';

export type PostLoginBehavior = 'home' | 'account' | 'custom_url';

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

function readPostLoginBehavior(value: unknown): PostLoginBehavior {
  return value === 'account' || value === 'custom_url' || value === 'home' ? value : 'home';
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

  return { redirectUrl: '/', behavior: 'home' };
}

export function validateLoginEntryPostLoginSettings(
  values: Record<string, unknown>,
  trustedOrigins: readonly string[] = []
): Record<string, string> {
  const rejected: Record<string, string> = {};
  const behavior = values['login-entry.post_login_behavior'];
  if (
    behavior !== undefined &&
    behavior !== 'home' &&
    behavior !== 'account' &&
    behavior !== 'custom_url'
  ) {
    rejected['login-entry.post_login_behavior'] = 'Value must be one of: home, account, custom_url';
  }

  const redirectUrl = values['login-entry.post_login_redirect_url'];
  if (redirectUrl !== undefined && !validatePostLoginRedirectUrl(redirectUrl, trustedOrigins)) {
    rejected['login-entry.post_login_redirect_url'] =
      'Must be a non-reserved relative path or an HTTPS URL whose origin is trusted';
  }
  return rejected;
}
