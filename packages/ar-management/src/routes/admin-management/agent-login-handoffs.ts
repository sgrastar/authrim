import { Hono, type Context } from 'hono';
import {
  ADMIN_AGENT_LOGIN_HANDOFF_CODE_TTL_MS,
  ADMIN_AGENT_LOGIN_HANDOFF_ID_PATTERN,
  AdminAgentAccessRepository,
  buildAdminAgentLoginHandoffConsumeUrl,
  hashAdminAgentLoginHandoffCode,
  hashAdminAgentLoginHandoffSession,
  type AdminAgentLoginHandoffRecord,
} from '@authrim/ar-agent-access/core';
import {
  ADMIN_PERMISSIONS,
  adminAuthMiddleware,
  authenticateAdminSessionForTenant,
  generateSecureRandomString,
  getRateLimitProfileAsync,
  hasAdminPermission,
  isAdminRequestIpAllowedForTenant,
  rateLimitMiddleware,
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';
import type { AgentManagementEnv } from '../../agent-downscope-auth';

type AgentLoginHandoffContext = Context<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>;

const REQUIRED_ADMIN_ROLES = ['super_admin', 'security_admin', 'admin', 'support', 'viewer'];

interface RootAdminSessionRow {
  id: string;
  tenant_id: string;
  admin_user_id: string;
  expires_at: number;
  mfa_verified: number;
  parent_session_id: string | null;
}

export const agentLoginHandoffsRouter = new Hono<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>();

agentLoginHandoffsRouter.use('*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'strict');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/admin/agent-login-handoffs/'],
  })(c as unknown as Context<{ Bindings: Env }>, next);
});

agentLoginHandoffsRouter.use(
  '*',
  adminAuthMiddleware({ plane: 'platform', sessionOnly: true, requireMfa: true })
);

function noStore(c: AgentLoginHandoffContext): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');
}

function requestId(c: AgentLoginHandoffContext): string {
  return String((c as unknown as { get(key: string): unknown }).get('requestId') ?? 'unknown');
}

function metadata(handoff: AdminAgentLoginHandoffRecord): Record<string, string | boolean> {
  return {
    target_tenant_id: handoff.targetTenantId,
    target_origin: handoff.targetOrigin,
    browser_bound: true,
    approval_plane: 'central_admin',
  };
}

async function auditDenied(
  c: AgentLoginHandoffContext,
  repository: AdminAgentAccessRepository,
  handoff: AdminAgentLoginHandoffRecord,
  reason: string,
  adminUserId: string
): Promise<void> {
  await repository.writeAudit({
    id: `audit_${crypto.randomUUID()}`,
    tenantId: handoff.targetTenantId,
    adminUserId,
    action: 'agent.login_handoff.denied',
    resourceType: 'admin_agent_login_handoff',
    resourceId: handoff.id,
    result: 'failure',
    severity: 'warn',
    requestId: requestId(c),
    actorType: 'admin_user',
    actorSub: adminUserId,
    metadata: { ...metadata(handoff), reason },
    createdAt: Date.now(),
  });
}

agentLoginHandoffsRouter.post('/:handoff_id/approve', async (c) => {
  noStore(c);
  const handoffId = c.req.param('handoff_id');
  if (!ADMIN_AGENT_LOGIN_HANDOFF_ID_PATTERN.test(handoffId)) {
    return c.json(
      { error: 'invalid_request', error_description: 'Invalid login handoff identifier.' },
      400
    );
  }

  const auth = c.get('adminAuth') as AdminAuthContext;
  if (
    auth.authMethod !== 'session' ||
    !auth.sessionId ||
    !auth.sessionExpiresAt ||
    !auth.mfaVerified ||
    !hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.AGENT_USE)
  ) {
    return c.json(
      { error: 'access_denied', error_description: 'A permitted Admin session is required.' },
      403
    );
  }

  const now = Date.now();
  const database = requireDedicatedAdminDatabaseAdapter(
    c.env,
    'admin-agent-login-handoff-approval'
  );
  const repository = new AdminAgentAccessRepository(database);
  const handoff = await repository.getLoginHandoffById(handoffId);
  if (!handoff || handoff.status !== 'pending' || handoff.expiresAt <= now) {
    return c.json(
      { error: 'invalid_request', error_description: 'Login handoff is unavailable or expired.' },
      410
    );
  }

  const rootSession = await database.queryOne<RootAdminSessionRow>(
    `SELECT id, tenant_id, admin_user_id, expires_at, mfa_verified, parent_session_id
       FROM admin_sessions
      WHERE id = ? AND admin_user_id = ? AND expires_at > ?`,
    [auth.sessionId, auth.userId, now]
  );
  if (!rootSession || rootSession.parent_session_id || rootSession.mfa_verified !== 1) {
    await auditDenied(c, repository, handoff, 'source_session_not_root', auth.userId);
    return c.json(
      { error: 'access_denied', error_description: 'A central Admin session is required.' },
      403
    );
  }

  const targetAuth = await authenticateAdminSessionForTenant(
    c as unknown as Context<{ Bindings: Env }>,
    rootSession.id,
    REQUIRED_ADMIN_ROLES,
    handoff.targetTenantId
  );
  if (
    !targetAuth ||
    targetAuth.authMethod !== 'session' ||
    targetAuth.sessionId !== rootSession.id ||
    targetAuth.userId !== auth.userId ||
    !targetAuth.mfaVerified ||
    !targetAuth.sessionExpiresAt ||
    !hasAdminPermission(targetAuth.permissions ?? [], ADMIN_PERMISSIONS.AGENT_USE)
  ) {
    await auditDenied(c, repository, handoff, 'target_tenant_authorization_denied', auth.userId);
    return c.json(
      { error: 'access_denied', error_description: 'Admin access is not allowed for this tenant.' },
      403
    );
  }

  if (
    !(await isAdminRequestIpAllowedForTenant(
      c as unknown as Context<{ Bindings: Env }>,
      handoff.targetTenantId
    ))
  ) {
    await auditDenied(c, repository, handoff, 'target_tenant_ip_denied', auth.userId);
    return c.json(
      { error: 'access_denied', error_description: 'Admin access is not allowed for this tenant.' },
      403
    );
  }

  const expiresAt = Math.min(
    now + ADMIN_AGENT_LOGIN_HANDOFF_CODE_TTL_MS,
    targetAuth.sessionExpiresAt,
    handoff.expiresAt
  );
  if (expiresAt <= now) {
    await auditDenied(c, repository, handoff, 'source_session_expired', auth.userId);
    return c.json(
      { error: 'access_denied', error_description: 'The Admin session is no longer valid.' },
      403
    );
  }

  const code = `ahc_${generateSecureRandomString(32)}`;
  let consumeUrl: string;
  try {
    consumeUrl = buildAdminAgentLoginHandoffConsumeUrl(handoff.targetOrigin, code);
  } catch {
    await auditDenied(c, repository, handoff, 'invalid_target_origin', auth.userId);
    return c.json(
      { error: 'invalid_request', error_description: 'Login handoff target is invalid.' },
      410
    );
  }

  const transitionId = `transition_${crypto.randomUUID()}`;
  const issued = await repository.issueLoginHandoff({
    id: handoff.id,
    targetTenantId: handoff.targetTenantId,
    sourceSessionId: rootSession.id,
    sourceSessionHash: await hashAdminAgentLoginHandoffSession(rootSession.id),
    adminUserId: auth.userId,
    codeHash: await hashAdminAgentLoginHandoffCode(code),
    transitionId,
    issuedAt: now,
    expiresAt,
    audit: {
      id: `audit_${crypto.randomUUID()}`,
      tenantId: handoff.targetTenantId,
      adminUserId: auth.userId,
      action: 'agent.login_handoff.issued',
      resourceType: 'admin_agent_login_handoff',
      resourceId: handoff.id,
      severity: 'info',
      requestId: requestId(c),
      actorType: 'admin_user',
      actorSub: auth.userId,
      metadata: metadata(handoff),
      createdAt: now,
    },
  });
  if (!issued) {
    await auditDenied(c, repository, handoff, 'issue_replay_or_expired', auth.userId);
    return c.json(
      { error: 'invalid_request', error_description: 'Login handoff was already used or expired.' },
      410
    );
  }

  return c.json({ consume_url: consumeUrl }, 200);
});

export default agentLoginHandoffsRouter;
