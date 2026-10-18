import type { Env } from '../types/env';

const AUTHENTICATION_METHODS_CACHE_GLOBAL_REVISION_KEY =
  'cache:authentication-methods:v1:revision:global';
const AUTHENTICATION_METHODS_CACHE_TENANT_REVISION_PREFIX =
  'cache:authentication-methods:v1:revision:tenant:';
const FALLBACK_REVISION = '0';

/**
 * The shape of the `/api/auth/authentication-methods` response, in the cache keys of the router
 * and of the edge cache. The revision above moves when a setting is saved; it does not move when
 * the code starts to answer with another shape, so a response cached before a deploy that adds a
 * field would be served for the whole cache lifetime (a day at the router). Raise this number
 * whenever the response gains, loses or changes a field.
 *
 * 1: the methods and the UI config; 2: `humanVerification` carries `required`, `requiredFor`,
 * `available` and `reason`.
 */
export const AUTHENTICATION_METHODS_RESPONSE_SHAPE_VERSION = 2;

type SettingsEnv = Pick<Env, 'SETTINGS'>;

export function buildAuthenticationMethodsTenantCacheRevisionKey(tenantId: string): string {
  return `${AUTHENTICATION_METHODS_CACHE_TENANT_REVISION_PREFIX}${tenantId}`;
}

export async function readAuthenticationMethodsCacheRevision(
  env: SettingsEnv,
  tenantId: string
): Promise<string> {
  const settings = env.SETTINGS;
  if (!settings) return `${FALLBACK_REVISION}.${FALLBACK_REVISION}`;

  const [globalRevision, tenantRevision] = await Promise.all([
    settings.get(AUTHENTICATION_METHODS_CACHE_GLOBAL_REVISION_KEY),
    settings.get(buildAuthenticationMethodsTenantCacheRevisionKey(tenantId)),
  ]);

  return `${globalRevision || FALLBACK_REVISION}.${tenantRevision || FALLBACK_REVISION}`;
}

export async function bumpAuthenticationMethodsCacheRevision(
  env: SettingsEnv,
  tenantId?: string | null
): Promise<string | null> {
  const settings = env.SETTINGS;
  if (!settings) return null;

  const revision = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
  const key = tenantId
    ? buildAuthenticationMethodsTenantCacheRevisionKey(tenantId)
    : AUTHENTICATION_METHODS_CACHE_GLOBAL_REVISION_KEY;
  await settings.put(key, revision);
  return revision;
}
