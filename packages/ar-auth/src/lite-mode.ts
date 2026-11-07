/**
 * ar-auth for tenants in lite mode (the lite Login UI).
 *
 * - `readLiteMode`: the tenant's mode, as ar-lib-core readLiteRuntimeState tells it (cached per
 *   isolate; a tenant that was never lite is `off` without reading its policy; `unknown`, refused
 *   as a lite tenant would be, when it cannot be told).
 * - `refuseForLiteTenant`: the endpoints the lite UI does not use are refused for a lite tenant
 *   (`lite_mode_endpoint_unavailable`): the older email-code and passkey-registration endpoints,
 *   which create accounts without human verification, and the sign-in methods the lite UI does
 *   not offer.
 * - `liteAtomicBudget`: for a lite tenant, a per-IP and a tenant-wide limit that never falls back
 *   to the eventually consistent KV counter (the Durable Object, or refuse).
 * - `litePowChallengeHandler`: GET /api/auth/human-verification/pow-challenge?action=…, the proof
 *   of work a lite page embeds.
 */
import type { Context, MiddlewareHandler, Next } from 'hono';
import {
  checkRateLimit,
  createPowChallenge,
  getClientIP,
  getTenantIdFromContext,
  loadPowKeyringFromEnv,
  readLiteModeState,
  readLiteRuntimeState,
  readLitePowSettings,
  type Env,
  type LiteModeState,
} from '@authrim/ar-lib-core';

type AnyContext = Context<{ Bindings: Env }>;

export type { LiteModeState };

/** The tenant's lite mode (see ar-lib-core readLiteModeState). */
export function readLiteMode(env: Env, tenantId: string): Promise<LiteModeState> {
  return readLiteModeState(env, tenantId);
}

function noStore(c: AnyContext): void {
  c.header('Cache-Control', 'no-store');
}

export function liteModeEndpointUnavailable(c: AnyContext): Response {
  noStore(c);
  return c.json(
    {
      error: 'lite_mode_endpoint_unavailable',
      error_description: 'This tenant uses the lite Login UI, which does not use this endpoint',
    },
    403
  );
}

/** Refuses the request for a tenant in lite mode (or whose mode cannot be told). */
export function refuseForLiteTenant(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const mode = await readLiteMode(c.env, getTenantIdFromContext(c));
    if (mode !== 'off') return liteModeEndpointUnavailable(c);
    await next();
  };
}

function budgetExceeded(c: AnyContext, resetAt: number): Response {
  noStore(c);
  c.header('Retry-After', String(Math.max(1, resetAt - Math.floor(Date.now() / 1000))));
  return c.json(
    { error: 'rate_limit_exceeded', error_description: 'Too many requests; try again later' },
    429
  );
}

/**
 * Counts a request against a per-IP and a tenant-wide limit, atomically. Returns the refusal (429,
 * or 503 when the counter cannot be reached), or null to go on.
 */
export async function liteAtomicBudget(
  c: AnyContext,
  tenantId: string,
  endpointClass: string,
  limits: { perIpPerMinute: number; perTenantPerMinute: number }
): Promise<Response | null> {
  const ip = getClientIP(c, 'cloudflare') || 'unknown';
  try {
    for (const [key, maxRequests] of [
      [ip, limits.perIpPerMinute],
      ['tenant-total', limits.perTenantPerMinute],
    ] as const) {
      const result = await checkRateLimit(
        c.env,
        key,
        { maxRequests, windowSeconds: 60, endpointClass, requireAtomic: true },
        tenantId
      );
      if (!result.allowed) return budgetExceeded(c, result.resetAt);
    }
    return null;
  } catch {
    noStore(c);
    return c.json(
      { error: 'temporarily_unavailable', error_description: 'Try again in a moment' },
      503
    );
  }
}

/**
 * For a tenant in lite mode only: the same atomic budget on an endpoint every tenant uses (the
 * lite UI reaches it before human verification, so it must not be free to repeat).
 */
export function liteTenantBudget(
  endpointClass: string,
  limits: { perIpPerMinute: number; perTenantPerMinute: number }
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c: AnyContext, next: Next) => {
    const tenantId = getTenantIdFromContext(c);
    if ((await readLiteMode(c.env, tenantId)) === 'off') return next();
    const refused = await liteAtomicBudget(c, tenantId, endpointClass, limits);
    if (refused) return refused;
    await next();
  };
}

const POW_ACTIONS = new Set(['login', 'signup', 'reauth']);

/** GET /api/auth/human-verification/pow-challenge?action=login|signup|reauth */
export async function litePowChallengeHandler(c: AnyContext): Promise<Response> {
  noStore(c);
  const tenantId = getTenantIdFromContext(c);
  const action = c.req.query('action') ?? '';
  if (!POW_ACTIONS.has(action)) {
    return c.json({ error: 'invalid_request', error_description: 'Unknown action' }, 400);
  }
  if (!c.env.LITE_POLICY_STORE) return c.json({ error: 'not_found' }, 404);
  const snapshot = await readLiteRuntimeState(c.env, tenantId);
  if (snapshot === 'unknown') return c.json({ error: 'temporarily_unavailable' }, 503);
  if (snapshot === 'off') return c.json({ error: 'not_found' }, 404);

  let keyring;
  try {
    keyring = loadPowKeyringFromEnv(c.env);
  } catch {
    keyring = null;
  }
  if (!keyring) return c.json({ error: 'temporarily_unavailable' }, 503);

  const settings = await readLitePowSettings(c.env, tenantId);
  const refused = await liteAtomicBudget(c, tenantId, 'litePowIssue', {
    perIpPerMinute: settings.issuePerIpPerMinute,
    perTenantPerMinute: settings.issuePerTenantPerMinute,
  });
  if (refused) return refused;

  const challenge = await createPowChallenge(
    keyring,
    {
      tenantId,
      action: action as 'login' | 'signup' | 'reauth',
      policyRevision: snapshot.policyRevision,
    },
    { maxNumber: settings.maxNumber, ttlSeconds: settings.ttlSeconds }
  );
  return c.json({ challenge, policy_revision: snapshot.policyRevision });
}
