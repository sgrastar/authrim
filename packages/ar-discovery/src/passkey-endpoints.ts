/**
 * W3C "A Well-Known URL for Passkey Endpoints": `/.well-known/passkey-endpoints`.
 *
 * Tells password managers and browsers where a person can create a passkey (`enroll`) and manage
 * the ones they have (`manage`) for this origin. Both point at the placement of the published
 * Authrim account page that shows the passkey list, which the Router serves on the request host
 * at the tenant's account page path.
 *
 * Published only while the tenant lets people sign in with a passkey, the account page is on and
 * it shows the passkey list: otherwise there is nowhere useful to send anyone, so the resource
 * does not exist (404).
 *
 * https://w3c.github.io/webappsec-passkey-endpoints/
 */
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  SELF_SERVICE_DEFAULTS,
  buildRequestIssuerUrl,
  getCacheTTL,
  getLogger,
  getTenantIdFromContext,
  passkeyPlacementId,
  publishedAccountPageFromSettings,
  validateAccountPagePath,
} from '@authrim/ar-lib-core';

export interface PasskeyEndpointsResponse {
  enroll: string;
  manage: string;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

/**
 * Whether the tenant's `authentication-methods` document lets people sign in with a passkey, read
 * the way the public authentication-methods API reads it: `passkey.login_enabled`, falling back
 * to the older single switch `passkey.enabled`, and on where neither is set.
 *
 * Throws when the document is there but cannot be understood: a damaged switch must not leave the
 * endpoint published.
 */
export function passkeyLoginEnabledFromDocument(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('authentication_methods_settings_invalid');
  }
  const settings = parsed as Record<string, unknown>;
  return readBoolean(
    settings['authentication-methods.passkey.login_enabled'],
    readBoolean(settings['authentication-methods.passkey.enabled'], true)
  );
}

/**
 * The account page path the Router serves for the tenant, or null while the page is off. Read the
 * way the Router reads it, so the endpoint points where the page actually is: a document that
 * cannot be understood counts as nothing set, and a path that fails validation falls back to the
 * default path.
 */
export function accountPagePathFromDocument(raw: string | null | undefined): string | null {
  let record: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        record = parsed as Record<string, unknown>;
      }
    } catch {
      record = {};
    }
  }
  const enabledValue = record['self-service.account_page_enabled'];
  const enabled =
    typeof enabledValue === 'boolean'
      ? enabledValue
      : SELF_SERVICE_DEFAULTS['self-service.account_page_enabled'];
  if (!enabled) return null;
  const configuredPath = record['self-service.account_page_path'];
  return validateAccountPagePath(configuredPath)
    ? configuredPath
    : SELF_SERVICE_DEFAULTS['self-service.account_page_path'];
}

/**
 * The tenant's `login-ui` settings, read the way the account capabilities API reads them (which
 * decides what the account page shows): a document that cannot be understood counts as nothing
 * set, so the built-in page applies.
 */
export function loginUiSettingsFromDocument(
  raw: string | null | undefined
): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function notFound(c: Context<{ Bindings: Env }>, cacheControl: string) {
  c.header('Cache-Control', cacheControl);
  c.header('Vary', 'Host');
  return c.json({ error: 'not_found', message: 'The requested resource was not found' }, 404);
}

export async function passkeyEndpointsHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DISCOVERY');
  const tenantId = getTenantIdFromContext(c);
  const settingsKv = c.env.SETTINGS ?? c.env.AUTHRIM_CONFIG;

  let passkeyLoginEnabled: boolean;
  let accountPagePath: string | null;
  let placementId: string | null;
  try {
    const [authenticationMethodsRaw, selfServiceRaw, loginUiRaw] = await Promise.all([
      c.env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`) ?? null,
      settingsKv?.get(`settings:tenant:${tenantId}:self-service`) ?? null,
      c.env.SETTINGS?.get(`settings:tenant:${tenantId}:login-ui`) ?? null,
    ]);
    passkeyLoginEnabled = passkeyLoginEnabledFromDocument(authenticationMethodsRaw);
    accountPagePath = accountPagePathFromDocument(selfServiceRaw);
    placementId = passkeyPlacementId(
      publishedAccountPageFromSettings(loginUiSettingsFromDocument(loginUiRaw))
    );
  } catch (error) {
    // Unreadable settings: not published, and not cached, so it returns once they can be read.
    log.warn('Failed to read settings for passkey endpoints', { tenantId }, error as Error);
    return notFound(c, 'no-store');
  }

  const ttl = await getCacheTTL(c.env, 'discovery');
  const cacheControl = `public, max-age=${ttl}`;
  if (!passkeyLoginEnabled || accountPagePath === null || placementId === null) {
    return notFound(c, cacheControl);
  }

  // The origin the request came to (the tenant's own domain in multi-tenant deployments).
  const origin = new URL(buildRequestIssuerUrl(c.req.raw, c.env, tenantId)).origin;
  const url = `${origin}${accountPagePath}#${placementId}`;
  const body: PasskeyEndpointsResponse = { enroll: url, manage: url };

  c.header('Cache-Control', cacheControl);
  c.header('Vary', 'Host');
  return c.json(body);
}
