import { Hono } from 'hono';
import {
  AdminAgentAccessRepository,
  type AgentConsentWithGrant,
} from '@authrim/ar-agent-access/core';
import {
  adminAuthMiddleware,
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';

export const myAgentConsentsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

myAgentConsentsRouter.use('*', adminAuthMiddleware());

function responseConsent(consent: AgentConsentWithGrant) {
  return {
    id: consent.id,
    type: consent.type,
    grant_id: consent.grantId,
    client_id: consent.clientId,
    consent_version: consent.consentVersion,
    scopes: consent.scopes,
    granted_at: consent.grantedAt,
    revoked_at: consent.revokedAt ?? null,
    revoked_reason: consent.revokedReason ?? null,
    grant_status: consent.grantStatus,
    grant_generation: consent.grantGeneration,
  };
}

myAgentConsentsRouter.get('/', async (c) => {
  const auth = c.get('adminAuth') as AdminAuthContext;
  const tenantId = auth.tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'default';
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'my-agent-consents')
  );
  const consents = await repository.listUserConsents(tenantId, auth.userId);
  return c.json({ consents: consents.map(responseConsent) });
});

myAgentConsentsRouter.delete('/:id', async (c) => {
  const auth = c.get('adminAuth') as AdminAuthContext;
  const tenantId = auth.tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'default';
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'my-agent-consents')
  );
  const consent = (await repository.listUserConsents(tenantId, auth.userId)).find(
    (candidate) => candidate.id === c.req.param('id')
  );
  if (!consent) {
    return c.json({ error: 'AGENT_CONSENT_NOT_FOUND' }, 404);
  }
  if (consent.revokedAt !== undefined) {
    return c.json({ error: 'AGENT_CONSENT_ALREADY_REVOKED' }, 409);
  }
  const now = Date.now();
  if (consent.type === 'delegation') {
    if (consent.grantStatus !== 'active') {
      return c.json({ error: 'AGENT_GRANT_NOT_ACTIVE' }, 409);
    }
    const grant = await repository.getGrant(tenantId, consent.grantId);
    if (!grant || grant.delegatorId !== auth.userId) {
      return c.json({ error: 'AGENT_CONSENT_NOT_FOUND' }, 404);
    }
    const outboxId = `agro_${crypto.randomUUID()}`;
    const result = await repository.invalidateGrantAndQueueTokenRevocation({
      tenantId,
      grantId: grant.grantId,
      clientId: grant.clientId,
      expectedGeneration: grant.generation,
      status: 'suspended',
      reason: 'user',
      outboxId,
      now,
      audit: {
        id: `audit_${crypto.randomUUID()}`,
        tenantId,
        adminUserId: auth.userId,
        action: 'agent.consent.delegation.revoked',
        resourceType: 'admin_agent_grant',
        resourceId: grant.grantId,
        severity: 'warn',
        result: 'success',
        actorType: 'admin_user',
        actorSub: `admin_user:${auth.userId}`,
        grantId: grant.grantId,
        metadata: { consent_id: consent.id, outbox_id: outboxId },
        createdAt: now,
      },
    });
    return c.json({
      consent_id: consent.id,
      consent_type: consent.type,
      grant_status: 'suspended',
      token_families_pending_revocation: result.familyCount,
    });
  }

  const transitionId = `agro_${crypto.randomUUID()}`;
  const result = await repository.revokeOauthClientConsentAndQueueTokenRevocation({
    consentId: consent.id,
    tenantId,
    userId: auth.userId,
    grantId: consent.grantId,
    clientId: consent.clientId,
    grantGeneration: consent.grantGeneration,
    outboxId: transitionId,
    now,
    audit: {
      id: transitionId,
      tenantId,
      adminUserId: auth.userId,
      action: 'agent.consent.oauth_client.revoked',
      resourceType: 'agent_consent',
      resourceId: consent.id,
      severity: 'warn',
      result: 'success',
      actorType: 'admin_user',
      actorSub: `admin_user:${auth.userId}`,
      grantId: consent.grantId,
      metadata: { consent_type: consent.type, client_id: consent.clientId },
      createdAt: now,
    },
  });
  return c.json({
    consent_id: consent.id,
    consent_type: consent.type,
    grant_status: consent.grantStatus,
    token_families_pending_revocation: result.familyCount,
  });
});
