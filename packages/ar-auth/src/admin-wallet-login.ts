/**
 * Administrator sign-in by a HAIP presentation of the admin credential (design D-L, S4).
 *
 * The console starts a login here; the wallet answers the verifier (ar-vc) directly; the browser
 * that started the login then takes the result once. Only this browser can: it holds a secret
 * (cookie) whose hash the request was started with, and a same-device login also needs the
 * response code the wallet's redirect carries. The sign-in re-checks that the administrator is
 * still eligible, then creates the admin session (the passkey sign-in's session, with the second
 * factor satisfied by the attested holder key the presentation proved).
 *
 * - POST /api/admin/auth/wallet-login/start    { flow }            -> the QR / link and the request id
 * - GET  /api/admin/auth/wallet-login/status?request_id=            -> the progress
 * - POST /api/admin/auth/wallet-login/complete { request_id, response_code? } -> the session
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '@authrim/ar-lib-core';
import {
  AdminSessionRepository,
  evaluateAdminCredentialEligibility,
  getAdminCookieSameSite,
  getLogger,
  getRateLimitProfileAsync,
  getTenantIdFromContext,
  rateLimitMiddleware,
  requireDedicatedAdminDatabaseAdapter,
  scheduleAdminAuthenticationAudit,
} from '@authrim/ar-lib-core';
import { getRequestIssuer } from './issuer';
import { resolveSessionTtl } from './session-ttl';

export const adminWalletLoginApp = new Hono<{ Bindings: Env }>();

const BASE = '/api/admin/auth/wallet-login';
/** Holds the secret of the browser that started a login; never readable by scripts. */
const BINDING_COOKIE = 'authrim_admin_wallet_login';
const BINDING_COOKIE_MAX_AGE = 300;
/** Where the wallet sends the browser after a same-device answer; the console page takes it from there. */
export const ADMIN_WALLET_LOGIN_CALLBACK_PATH = '/admin/login/wallet';
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const RESPONSE_CODE = /^[A-Za-z0-9_-]{43}$/u;

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function configuredConsoleOrigin(env: Env): string | null {
  const configured = (env as unknown as { ADMIN_UI_URL?: string }).ADMIN_UI_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

function refuse(c: Context<{ Bindings: Env }>, status: 400 | 403 | 404 | 424 | 503, error: string) {
  c.header('Cache-Control', 'no-store');
  return c.json({ error }, status);
}

function bindingCookieOptions(c: Context<{ Bindings: Env }>) {
  return {
    path: BASE,
    httpOnly: true,
    secure: true,
    sameSite: getAdminCookieSameSite(c.env),
  } as const;
}

async function jsonBody(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown> | null> {
  if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
    return null;
  }
  try {
    const body: unknown = await c.req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function limitRequests(
  c: Context<{ Bindings: Env }>,
  next: () => Promise<void>
): Promise<Response | void> {
  // The console polls the status while the person takes the wallet: that has its own, wider budget.
  const polling = c.req.method === 'GET' && c.req.path === `${BASE}/status`;
  const profile = await getRateLimitProfileAsync(c.env, polling ? 'moderate' : 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: [`${BASE}`],
    endpointClass: polling ? 'admin_wallet_login_status' : 'admin_wallet_login',
    // Fail closed rather than count in eventually consistent KV.
    requireAtomic: true,
  })(c, next);
}
adminWalletLoginApp.use(`${BASE}/*`, limitRequests);

adminWalletLoginApp.post(`${BASE}/start`, async (c) => {
  if (!c.env.VC_ISSUER) return refuse(c, 424, 'wallet_login_unavailable');
  const body = await jsonBody(c);
  const flow = body?.flow;
  // Admin sign-in is same-device only (HAIP 1.0 §5.1): a QR shown here could be answered by anyone
  // holding an administrator credential, and nothing would tie that person to this browser.
  if (flow !== 'same_device') return refuse(c, 400, 'invalid_request');
  const issuer = new URL(getRequestIssuer(c)).origin;
  const bindingSecret = randomSecret();
  // The wallet returns the browser to the console, whose host holds the binding cookie.
  const consoleOrigin = configuredConsoleOrigin(c.env) ?? issuer;
  try {
    const started = await c.env.VC_ISSUER.createHaipLoginRequest({
      tenantId: getTenantIdFromContext(c),
      credentialIssuer: issuer,
      flow,
      bindingSecret,
      redirectUri: `${consoleOrigin}${ADMIN_WALLET_LOGIN_CALLBACK_PATH}`,
    });
    setCookie(c, BINDING_COOKIE, bindingSecret, {
      ...bindingCookieOptions(c),
      maxAge: BINDING_COOKIE_MAX_AGE,
    });
    c.header('Cache-Control', 'no-store');
    return c.json({
      request_id: started.requestId,
      expires_at: started.expiresAt,
      deep_link: started.deepLink,
    });
  } catch (error) {
    // Without a usable issuer certificate chain the tenant offers no wallet login.
    if (error instanceof Error && error.message.includes('haip_login_unavailable')) {
      return refuse(c, 424, 'wallet_login_unavailable');
    }
    getLogger(c)
      .module('ADMIN_WALLET_LOGIN')
      .error('Start failed', {}, error as Error);
    return refuse(c, 503, 'wallet_login_unavailable');
  }
});

adminWalletLoginApp.get(`${BASE}/status`, async (c) => {
  if (!c.env.VC_ISSUER) return refuse(c, 424, 'wallet_login_unavailable');
  const requestId = c.req.query('request_id') ?? '';
  const bindingSecret = getCookie(c, BINDING_COOKIE);
  if (!REQUEST_ID.test(requestId) || !bindingSecret) return refuse(c, 400, 'invalid_request');
  try {
    const status = await c.env.VC_ISSUER.getHaipLoginStatus({
      tenantId: getTenantIdFromContext(c),
      requestId,
      bindingSecret,
    });
    if (!status) return refuse(c, 404, 'not_found');
    c.header('Cache-Control', 'no-store');
    return c.json({
      status: status.status,
      flow: status.flow,
      expires_at: status.expiresAt,
      ...(status.errorCode ? { error_code: status.errorCode } : {}),
    });
  } catch (error) {
    getLogger(c)
      .module('ADMIN_WALLET_LOGIN')
      .error('Status failed', {}, error as Error);
    return refuse(c, 503, 'wallet_login_unavailable');
  }
});

adminWalletLoginApp.post(`${BASE}/complete`, async (c) => {
  if (!c.env.VC_ISSUER) return refuse(c, 424, 'wallet_login_unavailable');
  const body = await jsonBody(c);
  const requestId = body?.request_id;
  const responseCode = body?.response_code;
  const bindingSecret = getCookie(c, BINDING_COOKIE);
  if (
    typeof requestId !== 'string' ||
    !REQUEST_ID.test(requestId) ||
    // Only same-device logins exist: the code the wallet redirect carried is always required.
    typeof responseCode !== 'string' ||
    !RESPONSE_CODE.test(responseCode) ||
    !bindingSecret
  ) {
    return refuse(c, 400, 'invalid_request');
  }
  const tenantId = getTenantIdFromContext(c);
  const log = getLogger(c).module('ADMIN_WALLET_LOGIN');
  try {
    // Once, and only for this browser (and this redirect, when the wallet was on the same device).
    const result = await c.env.VC_ISSUER.consumeHaipLoginResult({
      tenantId,
      requestId,
      bindingSecret,
      responseCode,
    });
    // An old callback that matches nothing must not cancel a newer login of this browser.
    if (!result) return refuse(c, 400, 'wallet_login_not_ready');
    deleteCookie(c, BINDING_COOKIE, { path: BASE });

    // The administrator must be one right now: the credential is a proof of who, not of standing.
    const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-wallet-login');
    const eligibility = await evaluateAdminCredentialEligibility(adapter, {
      tenantId,
      adminUserId: result.adminUserId,
      now: Date.now(),
    });
    if (!eligibility.eligible) {
      scheduleAdminAuthenticationAudit(c, {
        tenantId,
        action: 'admin.login_failed',
        method: 'wallet_presentation',
        adminUserId: result.adminUserId,
        reason: 'not_eligible',
      });
      return refuse(c, 403, 'wallet_login_not_allowed');
    }

    const sessionTtl = await resolveSessionTtl(c.env, tenantId, 'admin_passkey');
    const sessionId = crypto.randomUUID();
    await new AdminSessionRepository(adapter, tenantId).createSession({
      id: sessionId,
      tenant_id: tenantId,
      admin_user_id: result.adminUserId,
      ip_address: c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || undefined,
      user_agent: c.req.header('User-Agent') || undefined,
      expires_at: Date.now() + sessionTtl.milliseconds,
      // Possession of the holder key is not evidence that the person was verified at this
      // presentation (PIN, biometrics), so the session does not count as a second factor.
      mfa_verified: false,
    });
    scheduleAdminAuthenticationAudit(c, {
      tenantId,
      action: 'admin.login',
      method: 'wallet_presentation',
      adminUserId: result.adminUserId,
      sessionId,
      metadata: { credential_id: result.credentialId, holder_jkt: result.holderJkt },
    });
    setCookie(c, 'authrim_admin_session', sessionId, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: getAdminCookieSameSite(c.env),
      maxAge: sessionTtl.seconds,
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ success: true });
  } catch (error) {
    log.error('Complete failed', {}, error as Error);
    return refuse(c, 503, 'wallet_login_unavailable');
  }
});
