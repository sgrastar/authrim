import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  authenticateAdminSessionForTenant,
  generateSecureRandomString,
  getAdminCookieSameSite,
  getTenantIdFromContext,
  isAdminRequestIpAllowedForTenant,
  requireAdminDatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import {
  ADMIN_AGENT_LOGIN_HANDOFF_CODE_PATTERN,
  ADMIN_AGENT_LOGIN_HANDOFF_ID_PATTERN,
  AdminAgentAccessRepository,
  hashAdminAgentLoginHandoffBrowserBinding,
  hashAdminAgentLoginHandoffCode,
  hashAdminAgentLoginHandoffSession,
  type AdminAgentLoginHandoffRecord,
} from '@authrim/ar-agent-access/core';
import { getRequestIssuer } from './issuer';

const HANDOFF_PENDING_TTL_SECONDS = 5 * 60;
const HANDOFF_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1000;
const HANDOFF_COOKIE_PATH = '/oauth/admin-agent/login-handoff/consume';
const MAX_AUTHORIZATION_PATH_LENGTH = 16 * 1024;

type HandoffContext = Context<{ Bindings: Env }>;

function repository(c: Context<{ Bindings: Env }>): AdminAgentAccessRepository {
  return new AdminAgentAccessRepository(
    requireAdminDatabaseAdapter(c.env, 'admin-agent-login-handoff')
  );
}

function requestId(c: Context<{ Bindings: Env }>): string {
  return String((c as unknown as { get(key: string): unknown }).get('requestId') ?? 'unknown');
}

function auditMetadata(handoff: {
  targetTenantId: string;
  targetOrigin: string;
}): Record<string, string | boolean> {
  return {
    target_tenant_id: handoff.targetTenantId,
    target_origin: handoff.targetOrigin,
    browser_bound: true,
  };
}

async function auditDenied(
  c: HandoffContext,
  repo: AdminAgentAccessRepository,
  handoff: AdminAgentLoginHandoffRecord,
  reason: string,
  adminUserId?: string
): Promise<void> {
  const now = Date.now();
  await repo.writeAudit({
    id: `audit_${crypto.randomUUID()}`,
    tenantId: handoff.targetTenantId,
    adminUserId,
    action: 'agent.login_handoff.denied',
    resourceType: 'admin_agent_login_handoff',
    resourceId: handoff.id,
    result: 'failure',
    severity: 'warn',
    requestId: requestId(c),
    actorType: adminUserId ? 'admin_user' : 'system',
    actorSub: adminUserId ?? 'admin-agent-login-handoff',
    metadata: { ...auditMetadata(handoff), reason },
    createdAt: now,
  });
}

export function adminAgentHandoffCookieName(handoffId: string): string {
  return `authrim_agent_handoff_${handoffId.slice(-16)}`;
}

function clearBrowserBindingCookie(c: Context<{ Bindings: Env }>, handoffId: string): void {
  deleteCookie(c, adminAgentHandoffCookieName(handoffId), {
    path: HANDOFF_COOKIE_PATH,
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  });
}

function noStore(c: Context<{ Bindings: Env }>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');
}

function authorizationContinuation(handoff: AdminAgentLoginHandoffRecord): URL | null {
  try {
    const continuation = new URL(handoff.authorizationPath, handoff.targetOrigin);
    if (
      continuation.origin !== handoff.targetOrigin ||
      continuation.pathname !== '/oauth/admin-agent/authorize' ||
      continuation.hash
    ) {
      return null;
    }
    return continuation;
  } catch {
    return null;
  }
}

function requireAdminUiOrigin(adminUiUrl: string | undefined): string {
  if (!adminUiUrl) {
    throw new TypeError('ADMIN_UI_URL is required for Admin Agent login handoff');
  }
  try {
    const candidate = new URL(adminUiUrl);
    if (candidate.protocol === 'https:' && candidate.username === '' && candidate.password === '') {
      return candidate.origin;
    }
  } catch {
    // Fall through to the fail-closed configuration error.
  }
  throw new TypeError('ADMIN_UI_URL must be an HTTPS origin without userinfo');
}

export function buildAdminAgentHandoffLoginUrl(
  handoffId: string,
  adminUiUrl: string | undefined
): string {
  if (!ADMIN_AGENT_LOGIN_HANDOFF_ID_PATTERN.test(handoffId)) {
    throw new TypeError('Invalid Admin Agent login handoff identifier');
  }
  const loginUrl = new URL('/admin/login', requireAdminUiOrigin(adminUiUrl));
  loginUrl.searchParams.set('agent_handoff', handoffId);
  return loginUrl.toString();
}

/** Creates the tenant-side, browser-bound handoff before redirecting to the central Admin UI. */
export async function createAdminAgentLoginHandoff(c: HandoffContext): Promise<string> {
  const authorizationUrl = new URL(c.req.url);
  if (
    c.req.method !== 'GET' ||
    authorizationUrl.pathname !== '/oauth/admin-agent/authorize' ||
    authorizationUrl.hash ||
    authorizationUrl.pathname.length + authorizationUrl.search.length >
      MAX_AUTHORIZATION_PATH_LENGTH
  ) {
    throw new TypeError('Invalid Admin Agent authorization continuation');
  }

  const targetTenantId = getTenantIdFromContext(c);
  const targetOrigin = new URL(getRequestIssuer(c)).origin;
  const authorizationPath = `${authorizationUrl.pathname}${authorizationUrl.search}`;
  const handoffId = `alh_${generateSecureRandomString(24)}`;
  const loginUrl = buildAdminAgentHandoffLoginUrl(handoffId, c.env.ADMIN_UI_URL);
  const browserSecret = generateSecureRandomString(32);
  const transitionId = `transition_${crypto.randomUUID()}`;
  const now = Date.now();
  const repo = repository(c);

  await repo.createLoginHandoff({
    id: handoffId,
    targetTenantId,
    targetOrigin,
    authorizationPath,
    browserBindingHash: await hashAdminAgentLoginHandoffBrowserBinding(handoffId, browserSecret),
    transitionId,
    createdAt: now,
    expiresAt: now + HANDOFF_PENDING_TTL_SECONDS * 1000,
    audit: {
      id: `audit_${crypto.randomUUID()}`,
      tenantId: targetTenantId,
      action: 'agent.login_handoff.created',
      resourceType: 'admin_agent_login_handoff',
      resourceId: handoffId,
      severity: 'info',
      requestId: requestId(c),
      actorType: 'system',
      actorSub: 'admin-agent-authorize',
      metadata: auditMetadata({ targetTenantId, targetOrigin }),
      createdAt: now,
    },
  });

  setCookie(c, adminAgentHandoffCookieName(handoffId), browserSecret, {
    path: HANDOFF_COOKIE_PATH,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: HANDOFF_PENDING_TTL_SECONDS,
  });
  const purge = repo
    .purgeLoginHandoffs(now - HANDOFF_RETENTION_MILLISECONDS)
    .then(() => undefined)
    .catch(() => undefined);
  try {
    c.executionCtx.waitUntil(purge);
  } catch {
    // Hono's local test/runtime context may not expose ExecutionContext.
    await purge;
  }
  noStore(c);
  return loginUrl;
}

/** Consumes the code only on its exact tenant issuer and establishes a host-only Admin cookie. */
export async function adminAgentLoginHandoffConsumeHandler(c: HandoffContext): Promise<Response> {
  noStore(c);
  const code = c.req.query('code') ?? '';
  if (!ADMIN_AGENT_LOGIN_HANDOFF_CODE_PATTERN.test(code)) {
    return c.json(
      { error: 'invalid_request', error_description: 'Invalid login handoff code.' },
      400
    );
  }

  const codeHash = await hashAdminAgentLoginHandoffCode(code);
  const repo = repository(c);
  const handoff = await repo.getLoginHandoffByCodeHash(codeHash);
  if (!handoff) {
    return c.json(
      { error: 'invalid_request', error_description: 'Login handoff is unavailable or expired.' },
      410
    );
  }
  const continuation = authorizationContinuation(handoff);
  if (!continuation) {
    await auditDenied(c, repo, handoff, 'invalid_authorization_continuation');
    clearBrowserBindingCookie(c, handoff.id);
    return c.json(
      { error: 'invalid_request', error_description: 'Invalid authorization continuation.' },
      400
    );
  }

  const bindingCookie = getCookie(c, adminAgentHandoffCookieName(handoff.id));
  const currentTenantId = getTenantIdFromContext(c);
  const currentOrigin = new URL(getRequestIssuer(c)).origin;
  const browserBindingHash = bindingCookie
    ? await hashAdminAgentLoginHandoffBrowserBinding(handoff.id, bindingCookie)
    : '';
  if (
    handoff.status !== 'issued' ||
    handoff.expiresAt <= Date.now() ||
    currentTenantId !== handoff.targetTenantId ||
    currentOrigin !== handoff.targetOrigin ||
    browserBindingHash !== handoff.browserBindingHash ||
    !handoff.sourceSessionId ||
    !handoff.sourceSessionHash ||
    !handoff.adminUserId
  ) {
    await auditDenied(c, repo, handoff, 'binding_or_target_mismatch');
    clearBrowserBindingCookie(c, handoff.id);
    return c.json(
      { error: 'invalid_request', error_description: 'Login handoff is unavailable or expired.' },
      410
    );
  }

  const liveAdmin = await authenticateAdminSessionForTenant(
    c,
    handoff.sourceSessionId,
    ['super_admin', 'security_admin', 'admin', 'support', 'viewer'],
    handoff.targetTenantId
  );
  if (
    !liveAdmin ||
    liveAdmin.authMethod !== 'session' ||
    liveAdmin.userId !== handoff.adminUserId ||
    !liveAdmin.mfaVerified ||
    !liveAdmin.sessionExpiresAt ||
    (await hashAdminAgentLoginHandoffSession(handoff.sourceSessionId)) !== handoff.sourceSessionHash
  ) {
    await auditDenied(c, repo, handoff, 'source_session_invalid', handoff.adminUserId);
    clearBrowserBindingCookie(c, handoff.id);
    return c.json(
      { error: 'access_denied', error_description: 'The Admin session is no longer valid.' },
      403
    );
  }
  if (!(await isAdminRequestIpAllowedForTenant(c, handoff.targetTenantId))) {
    await auditDenied(c, repo, handoff, 'target_tenant_ip_denied', handoff.adminUserId);
    clearBrowserBindingCookie(c, handoff.id);
    return c.json(
      { error: 'access_denied', error_description: 'Admin access is not allowed for this tenant.' },
      403
    );
  }

  const now = Date.now();
  const transitionId = `transition_${crypto.randomUUID()}`;
  const targetSessionId = `ash_${generateSecureRandomString(32)}`;
  const consumed = await repo.consumeLoginHandoff({
    id: handoff.id,
    targetTenantId: handoff.targetTenantId,
    codeHash,
    transitionId,
    consumedAt: now,
    targetSession: {
      id: targetSessionId,
      tenantId: liveAdmin.tenantId ?? handoff.targetTenantId,
      adminUserId: liveAdmin.userId,
      parentSessionId: handoff.sourceSessionId,
      parentSessionHash: handoff.sourceSessionHash,
      ipAddress:
        c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim(),
      userAgent: c.req.header('User-Agent'),
      createdAt: liveAdmin.authenticationTimeMs ?? now,
      expiresAt: liveAdmin.sessionExpiresAt,
      mfaVerifiedAt: liveAdmin.authenticationTimeMs ?? now,
    },
    audit: {
      id: `audit_${crypto.randomUUID()}`,
      tenantId: handoff.targetTenantId,
      adminUserId: liveAdmin.userId,
      action: 'agent.login_handoff.consumed',
      resourceType: 'admin_agent_login_handoff',
      resourceId: handoff.id,
      severity: 'info',
      requestId: requestId(c),
      actorType: 'admin_user',
      actorSub: liveAdmin.userId,
      metadata: auditMetadata(handoff),
      createdAt: now,
    },
  });
  if (!consumed) {
    await auditDenied(c, repo, handoff, 'consume_replay_or_expired', liveAdmin.userId);
    clearBrowserBindingCookie(c, handoff.id);
    return c.json(
      { error: 'invalid_request', error_description: 'Login handoff was already used or expired.' },
      410
    );
  }

  const maxAge = Math.floor((liveAdmin.sessionExpiresAt - now) / 1000);
  if (maxAge <= 0) {
    clearBrowserBindingCookie(c, handoff.id);
    return c.json(
      { error: 'access_denied', error_description: 'The Admin session is no longer valid.' },
      403
    );
  }
  clearBrowserBindingCookie(c, handoff.id);
  setCookie(c, 'authrim_admin_session', targetSessionId, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: getAdminCookieSameSite(c.env),
    maxAge,
  });

  return c.redirect(continuation.toString(), 302);
}
