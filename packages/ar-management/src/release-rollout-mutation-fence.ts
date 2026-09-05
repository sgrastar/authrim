import type { MiddlewareHandler } from 'hono';
import {
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALWAYS_ALLOWED_PATHS = new Set(['/api/admin/logout']);
const SAFE_RECOVERY_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._:%-]{0,511}$/u;
const SETUP_LOGIN_UI_IDEMPOTENCY_KEY = /^setup-login-ui-[a-f0-9]{32}$/u;
const SETUP_DOWNSTREAM_IDEMPOTENCY_KEY = /^setup-downstream-client-[A-Za-z0-9_-]{24}$/u;
const LOGIN_UI_CLIENT_DESCRIPTION =
  'System-managed public OAuth client used by the built-in Authrim Login UI.';
const LOGIN_UI_CALLBACK_PATHS = new Set([
  '/callback',
  '/reauth/callback',
  '/device/callback',
  '/ciba/callback',
]);

function isExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function isExactLoginUiRedirectSet(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length !== LOGIN_UI_CALLBACK_PATHS.size) return false;
  let origin: string | null = null;
  const paths = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return false;
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return false;
    }
    if (origin === null) origin = url.origin;
    if (url.origin !== origin || !LOGIN_UI_CALLBACK_PATHS.has(url.pathname)) return false;
    paths.add(url.pathname);
  }
  return paths.size === LOGIN_UI_CALLBACK_PATHS.size;
}

function isExactLoginUiOriginRegistry(value: unknown, origin: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const registry = value as Record<string, unknown>;
  if (Object.keys(registry).length !== 1 || !Array.isArray(registry.origins)) return false;
  if (registry.origins.length !== 1) return false;
  const entry = registry.origins[0];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  const cors = record.cors;
  return (
    Object.keys(record).length === 4 &&
    record.origin === origin &&
    record.handoff_allowed === true &&
    record.iframe_allowed === false &&
    Boolean(
      cors &&
      typeof cors === 'object' &&
      !Array.isArray(cors) &&
      Object.keys(cors).length === 1 &&
      (cors as Record<string, unknown>).allowed === true
    )
  );
}

async function isAuthorizedInitialSystemClientBootstrap(
  c: Parameters<MiddlewareHandler<{ Bindings: Env }>>[0]
): Promise<boolean> {
  if (c.req.method !== 'POST' || c.req.path !== '/api/admin/clients') return false;
  const auth = (c as unknown as { get: (key: string) => AdminAuthContext | undefined }).get(
    'adminAuth'
  );
  const idempotencyKey = c.req.header('Idempotency-Key') ?? '';
  if (
    auth?.actorType !== 'machine' ||
    auth.authMethod !== 'machine_access_token' ||
    auth.principalType !== 'setup_tool' ||
    auth.clientId !== 'authrim-setup' ||
    !hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.CLIENTS_WRITE) ||
    (!SETUP_LOGIN_UI_IDEMPOTENCY_KEY.test(idempotencyKey) &&
      !SETUP_DOWNSTREAM_IDEMPOTENCY_KEY.test(idempotencyKey))
  ) {
    return false;
  }

  let body: Record<string, unknown>;
  try {
    const parsed = (await c.req.raw.clone().json()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    body = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  if (SETUP_DOWNSTREAM_IDEMPOTENCY_KEY.test(idempotencyKey)) {
    const expectedDownstreamKeys = [
      'application_type',
      'client_credentials_allowed',
      'client_name',
      'description',
      'grant_types',
      'is_trusted',
      'redirect_uris',
      'response_types',
      'scope',
      'skip_consent',
      'token_endpoint_auth_method',
    ];
    return (
      Object.keys(body).sort().join('\n') === expectedDownstreamKeys.sort().join('\n') &&
      body.client_name === 'Downstream Grant Introspection' &&
      body.description ===
        'System-managed confidential client used by Authrim for downstream grant introspection.' &&
      body.application_type === 'service' &&
      body.token_endpoint_auth_method === 'client_secret_basic' &&
      isExactStringArray(body.redirect_uris, [
        'https://downstream-introspection.authrim.invalid/callback',
      ]) &&
      isExactStringArray(body.grant_types, [
        'authorization_code',
        'refresh_token',
        'client_credentials',
      ]) &&
      isExactStringArray(body.response_types, ['code']) &&
      body.scope === 'openid' &&
      body.is_trusted === true &&
      body.skip_consent === true &&
      body.client_credentials_allowed === true
    );
  }
  const expectedKeys = [
    'browser_public_client_mode',
    'browser_refresh_token_policy',
    'client_name',
    'description',
    'grant_types',
    'is_trusted',
    'redirect_uris',
    'require_pkce',
    'response_types',
    'scope',
    'skip_consent',
    'token_endpoint_auth_method',
    'web_origin_registry',
  ];
  if (
    Object.keys(body).sort().join('\n') !== expectedKeys.sort().join('\n') ||
    body.client_name !== 'Login UI' ||
    body.description !== LOGIN_UI_CLIENT_DESCRIPTION ||
    !isExactLoginUiRedirectSet(body.redirect_uris) ||
    !isExactStringArray(body.grant_types, ['authorization_code']) ||
    !isExactStringArray(body.response_types, ['code']) ||
    body.scope !== 'openid profile email' ||
    body.is_trusted !== true ||
    body.skip_consent !== true ||
    body.token_endpoint_auth_method !== 'none' ||
    body.require_pkce !== true ||
    body.browser_public_client_mode !== 'cookie_fallback' ||
    body.browser_refresh_token_policy !== 'disabled'
  ) {
    return false;
  }
  const redirectOrigin = new URL((body.redirect_uris as string[])[0]!).origin;
  return isExactLoginUiOriginRegistry(body.web_origin_registry, redirectOrigin);
}

function isAuthorizedReleaseRecoveryPath(path: string): boolean {
  const segments = path.split('/');
  return (
    segments.length === 10 &&
    segments[1] === 'api' &&
    segments[2] === 'admin' &&
    segments[3] === 'platform' &&
    segments[4] === 'control-plane' &&
    segments[5] === 'release-rollout' &&
    SAFE_RECOVERY_SEGMENT.test(segments[6] ?? '') &&
    segments[7] === 'targets' &&
    SAFE_RECOVERY_SEGMENT.test(segments[8] ?? '') &&
    segments[9] === 'retry'
  );
}

export function releaseRolloutMutationFenceMiddleware(): MiddlewareHandler<{
  Bindings: Env;
}> {
  return async (c, next) => {
    if (
      SAFE_METHODS.has(c.req.method) ||
      ALWAYS_ALLOWED_PATHS.has(c.req.path) ||
      (c.req.method === 'POST' && isAuthorizedReleaseRecoveryPath(c.req.path))
    ) {
      return next();
    }
    const control = c.env.CONTROL;
    if (!control?.getReleaseMigrationRolloutStatus) {
      c.header('Cache-Control', 'no-store');
      c.header('Retry-After', '5');
      return c.json(
        {
          error: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE',
          message: 'Release rollout state could not be verified. Administrative writes are paused.',
        },
        503
      );
    }

    let status;
    try {
      status = await control.getReleaseMigrationRolloutStatus();
    } catch {
      c.header('Cache-Control', 'no-store');
      c.header('Retry-After', '5');
      return c.json(
        {
          error: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE',
          message: 'Release rollout state could not be verified. Administrative writes are paused.',
        },
        503
      );
    }
    if (status.adminMutationMode !== 'read_only') return next();
    if (await isAuthorizedInitialSystemClientBootstrap(c)) return next();

    c.header('Cache-Control', 'no-store');
    c.header('Retry-After', '5');
    return c.json(
      {
        error: 'ADMIN_MUTATION_PAUSED_FOR_RELEASE',
        message:
          'This operation is temporarily unavailable while the release update is in progress.',
        operationId: status.operationId,
        targetVersion: status.targetVersion,
        phase: status.phase,
      },
      409
    );
  };
}
