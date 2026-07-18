import { Hono } from 'hono';
import {
  AdminAgentAccessRepository,
  canonicalizeJson,
  sha256Base64Url,
  type JsonObject,
} from '@authrim/ar-agent-access/core';
import { createAdminToolCatalog } from '@authrim/ar-agent-access/protocol/mcp';
import { encryptCloudflareAgentJson } from '@authrim/ar-agent-access/platform/cloudflare/elevation';
import { CloudflareSecretTextKeyProvider } from '@authrim/ar-agent-access/platform/cloudflare/service-binding';
import {
  adminAuthMiddleware,
  ApprovalRequestApprovalRepository,
  ApprovalRequestRepository,
  canonicalizeApprovalScope,
  generateInvestigationId,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
} from '@authrim/ar-lib-core';
import { isAgentMcpEnabled, type AgentManagementEnv } from '../../agent-downscope-auth';
import { issueApprovalCompletionArtifact } from '../../approval-completion-artifact';
import { startApprovalCibaRequest } from '../../approval-ciba';
import { dispatchApprovalCibaUserCode } from '../../approval-ciba-notification';
import { isFreshAdminHuman } from '../../agent-fresh-auth';

const toolCatalog = createAdminToolCatalog();

export const agentElevationsRouter = new Hono<{
  Bindings: AgentManagementEnv;
  Variables: { adminAuth?: AdminAuthContext };
}>();

agentElevationsRouter.use('*', adminAuthMiddleware());

function findTool(operation: string) {
  return toolCatalog.list().find((candidate) => candidate.id === operation);
}

agentElevationsRouter.get('/:id', async (c) => {
  const auth = c.get('adminAuth') as AdminAuthContext;
  const tenantId = auth.tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'default';
  if (!(await isAgentMcpEnabled(c.env, tenantId))) {
    return c.json({ error: 'AGENT_MCP_DISABLED' }, 404);
  }
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-elevation-review')
  );
  const challenge = await repository.getElevationChallenge(tenantId, c.req.param('id'));
  if (!challenge || challenge.userId !== auth.userId) {
    return c.json({ error: 'AGENT_ELEVATION_NOT_FOUND' }, 404);
  }
  const tool = findTool(challenge.toolName);
  if (!tool) return c.json({ error: 'AGENT_ELEVATION_TOOL_UNAVAILABLE' }, 409);
  return c.json({
    elevation: {
      id: challenge.id,
      grant_id: challenge.grantId,
      client_id: challenge.clientId,
      actor_sub: challenge.actorSub,
      tool: tool.name,
      title: tool.title,
      confirmation_summary: challenge.confirmSummaryRedacted,
      risk_level: tool.riskLevel,
      status: challenge.status,
      expires_at: challenge.expiresAt,
      fresh_auth_required: true,
    },
  });
});

agentElevationsRouter.post('/:id/ciba/start', async (c) => {
  const auth = c.get('adminAuth') as AdminAuthContext;
  const tenantId = auth.tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'default';
  if (!(await isAgentMcpEnabled(c.env, tenantId))) {
    return c.json({ error: 'AGENT_MCP_DISABLED' }, 404);
  }
  if (auth.actorType === 'agent' || auth.actorType === 'machine' || auth.authMethod !== 'session') {
    return c.json({ error: 'AGENT_ELEVATION_HUMAN_SESSION_REQUIRED' }, 403);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'AGENT_ELEVATION_APPROVAL_INVALID' }, 400);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !('approver_id' in body) ||
    typeof body.approver_id !== 'string' ||
    !body.approver_id ||
    body.approver_id === auth.userId
  ) {
    return c.json({ error: 'AGENT_ELEVATION_APPROVER_INVALID' }, 400);
  }
  const approverId = body.approver_id;
  const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'agent-elevation-ciba-start');
  const repository = new AdminAgentAccessRepository(adapter);
  const challenge = await repository.getElevationChallenge(tenantId, c.req.param('id'));
  if (!challenge || challenge.userId !== auth.userId) {
    return c.json({ error: 'AGENT_ELEVATION_NOT_FOUND' }, 404);
  }
  if (challenge.status !== 'pending' || challenge.expiresAt <= Date.now()) {
    return c.json({ error: 'AGENT_ELEVATION_APPROVAL_CONFLICT' }, 409);
  }
  if (challenge.approvalRequestId && challenge.approvalArtifactId) {
    return c.json({
      artifact_id: challenge.approvalArtifactId,
      artifact_path: `/api/approval-artifacts/${encodeURIComponent(challenge.approvalArtifactId)}`,
      reused: true,
    });
  }
  const tool = findTool(challenge.toolName);
  const approverPermissions = await repository.getActiveDelegatorPermissions(
    tenantId,
    approverId,
    Date.now()
  );
  if (
    !tool ||
    !approverPermissions ||
    tool.requiredPermissions.some(
      (permission) => !hasAdminPermission(approverPermissions, permission)
    )
  ) {
    return c.json({ error: 'AGENT_ELEVATION_APPROVER_PERMISSION_DENIED' }, 403);
  }
  const investigationId = generateInvestigationId();
  const scope = canonicalizeApprovalScope({
    version: 1,
    surface: 'agent_mcp',
    action: challenge.toolName,
    tenant_id: tenantId,
    resource_class: 'agent_elevation',
    resource_ids: [challenge.id],
    audience: 'authrim:admin-api',
    investigation_id: investigationId,
    redaction_level: 'summary_only',
    attributes: {
      elevation_id: challenge.id,
      grant_id: challenge.grantId,
      tool_id: challenge.toolName,
      tool_schema_version: challenge.toolSchemaVersion,
      args_hash: challenge.argsHash,
    },
  });
  const requestRepository = new ApprovalRequestRepository(adapter);
  const approvalRepository = new ApprovalRequestApprovalRepository(adapter);
  const approvalRequest = await requestRepository.createApprovalRequest({
    tenant_id: tenantId,
    investigation_id: investigationId,
    requester_subject_type: 'admin_user',
    requester_subject_id: auth.userId,
    target_subject_type: 'tenant_resource',
    target_subject_id: challenge.id,
    request_surface: 'agent_mcp',
    requested_action: challenge.toolName,
    redaction_level: 'summary_only',
    scope_json: scope.normalized,
    scope_canonical: scope.canonical,
    reason_code: 'agent_mcp_elevation',
    reason_note: challenge.confirmSummaryRedacted,
    policy_preset: 'agent_mcp_high_risk',
    reuse_scope: 'request',
    partial_access_allowed: false,
    expires_at: challenge.expiresAt,
  });
  const approval = await approvalRepository.createApproval({
    approval_request_id: approvalRequest.id,
    step_key: 'agent-mcp-elevation',
    side: 'admin_operator',
    subject_type: 'admin_user',
    subject_id: approverId,
    relation_type: null,
    relation_source: 'agent_mcp_policy',
    method: 'ciba',
    transport_channel: null,
    expires_at: challenge.expiresAt,
  });
  const artifact = await issueApprovalCompletionArtifact(c as never, {
    request: approvalRequest,
    approval,
    method: 'ciba',
    expiresAt: challenge.expiresAt,
  });
  const started = await startApprovalCibaRequest({
    env: c.env,
    tenantId,
    artifact,
    request: approvalRequest,
    approval,
  });
  if (!started.userCode) {
    return c.json({ error: 'AGENT_ELEVATION_CIBA_NOT_CONFIGURED' }, 409);
  }
  await dispatchApprovalCibaUserCode(c as never, {
    request: approvalRequest,
    approval,
    artifactId: artifact.artifact_id,
    authReqId: started.authReqId,
    userCode: started.userCode,
  });
  const linked = await repository.linkElevationApprovalRequest({
    tenantId,
    challengeId: challenge.id,
    approvalRequestId: approvalRequest.id,
    approvalArtifactId: artifact.artifact_id,
    now: Date.now(),
  });
  if (!linked) return c.json({ error: 'AGENT_ELEVATION_APPROVAL_CONFLICT' }, 409);
  return c.json({
    approval_request_id: approvalRequest.public_request_id,
    artifact_id: artifact.artifact_id,
    artifact_path: `/api/approval-artifacts/${encodeURIComponent(artifact.artifact_id)}`,
    auth_req_id: started.authReqId,
    expires_at: started.expiresAt,
    interval: started.interval,
    reused: false,
  });
});

agentElevationsRouter.post('/:id/decision', async (c) => {
  const auth = c.get('adminAuth') as AdminAuthContext;
  const tenantId = auth.tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'default';
  if (!(await isAgentMcpEnabled(c.env, tenantId))) {
    return c.json({ error: 'AGENT_MCP_DISABLED' }, 404);
  }
  const now = Date.now();
  if (!isFreshAdminHuman(auth, now)) {
    return c.json({ error: 'AGENT_ELEVATION_FRESH_AUTH_REQUIRED' }, 403);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'AGENT_ELEVATION_DECISION_INVALID' }, 400);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !('decision' in body) ||
    (body.decision !== 'approved' && body.decision !== 'denied')
  ) {
    return c.json({ error: 'AGENT_ELEVATION_DECISION_INVALID' }, 400);
  }
  const decision = body.decision;
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-elevation-decision')
  );
  const challenge = await repository.getElevationChallenge(tenantId, c.req.param('id'));
  if (!challenge || challenge.userId !== auth.userId) {
    return c.json({ error: 'AGENT_ELEVATION_NOT_FOUND' }, 404);
  }
  const tool = findTool(challenge.toolName);
  const grant = await repository.getGrant(tenantId, challenge.grantId);
  if (!tool || !grant || grant.status !== 'active') {
    return c.json({ error: 'AGENT_ELEVATION_CONTEXT_INACTIVE' }, 409);
  }
  if (
    decision === 'approved' &&
    tool.requiredPermissions.some(
      (permission) =>
        !hasAdminPermission(auth.permissions ?? [], permission) ||
        !hasAdminPermission(grant.permissions, permission)
    )
  ) {
    return c.json({ error: 'AGENT_ELEVATION_PERMISSION_DENIED' }, 403);
  }
  const auditId = `aud_${crypto.randomUUID()}`;
  const decided = await repository.decideElevation({
    tenantId,
    challengeId: challenge.id,
    decision,
    approverType: 'self_reauth',
    approverId: auth.userId,
    now,
    audit: {
      id: auditId,
      tenantId,
      adminUserId: auth.userId,
      action: decision === 'approved' ? 'agent.elevation.granted' : 'agent.elevation.denied',
      resourceType: 'agent_elevation',
      resourceId: challenge.id,
      severity: decision === 'approved' ? 'warn' : 'info',
      actorType: 'admin_user',
      actorSub: `admin_user:${auth.userId}`,
      elevationId: challenge.id,
      grantId: challenge.grantId,
      mcpTool: tool.name,
      metadata: {
        approval_mode: 'self_reauth',
        tool_id: tool.id,
        args_hash: challenge.argsHash,
      },
      createdAt: now,
    },
  });
  if (!decided) return c.json({ error: 'AGENT_ELEVATION_DECISION_CONFLICT' }, 409);
  return c.json({ id: challenge.id, status: decision });
});

const RECONCILIATION_SUMMARIES = new Set([
  'target_state_verified',
  'owner_log_verified',
  'manual_verification_inconclusive',
]);

agentElevationsRouter.post('/:id/reconcile', async (c) => {
  const auth = c.get('adminAuth') as AdminAuthContext;
  const tenantId = auth.tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'default';
  if (!(await isAgentMcpEnabled(c.env, tenantId))) {
    return c.json({ error: 'AGENT_MCP_DISABLED' }, 404);
  }
  const now = Date.now();
  if (
    !isFreshAdminHuman(auth, now) ||
    !hasAdminPermission(auth.permissions ?? [], 'admin:agent_elevation:reconcile')
  ) {
    return c.json({ error: 'AGENT_ELEVATION_RECONCILE_DENIED' }, 403);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'AGENT_ELEVATION_RECONCILIATION_INVALID' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'AGENT_ELEVATION_RECONCILIATION_INVALID' }, 400);
  }
  const record = body as Record<string, unknown>;
  const evidence = record.evidence;
  if (
    (record.outcome !== 'executed' &&
      record.outcome !== 'not_executed' &&
      record.outcome !== 'unresolved') ||
    !evidence ||
    typeof evidence !== 'object' ||
    Array.isArray(evidence)
  ) {
    return c.json({ error: 'AGENT_ELEVATION_RECONCILIATION_INVALID' }, 400);
  }
  const evidenceRecord = evidence as Record<string, unknown>;
  if (
    typeof evidenceRecord.summary !== 'string' ||
    !RECONCILIATION_SUMMARIES.has(evidenceRecord.summary) ||
    typeof evidenceRecord.checkedAt !== 'number' ||
    !Number.isSafeInteger(evidenceRecord.checkedAt) ||
    evidenceRecord.checkedAt > now + 60_000 ||
    (evidenceRecord.resourceVersion !== undefined &&
      (typeof evidenceRecord.resourceVersion !== 'string' ||
        !/^[A-Za-z0-9._~-]{1,256}$/u.test(evidenceRecord.resourceVersion))) ||
    Object.keys(evidenceRecord).some(
      (key) => !['summary', 'checkedAt', 'resourceVersion'].includes(key)
    )
  ) {
    return c.json({ error: 'AGENT_ELEVATION_RECONCILIATION_EVIDENCE_INVALID' }, 400);
  }
  const repository = new AdminAgentAccessRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'agent-elevation-human-reconcile')
  );
  const challenge = await repository.getElevationChallenge(tenantId, c.req.param('id'));
  if (!challenge || challenge.status !== 'indeterminate') {
    return c.json({ error: 'AGENT_ELEVATION_NOT_RECONCILABLE' }, 409);
  }
  const tool = findTool(challenge.toolName);
  if (
    !tool ||
    tool.requiredPermissions.some(
      (permission) => !hasAdminPermission(auth.permissions ?? [], permission)
    )
  ) {
    return c.json({ error: 'AGENT_ELEVATION_PERMISSION_DENIED' }, 403);
  }
  const canonicalEvidence: JsonObject = {
    summary: evidenceRecord.summary,
    checked_at: evidenceRecord.checkedAt,
    ...(evidenceRecord.resourceVersion
      ? { resource_version: evidenceRecord.resourceVersion as string }
      : {}),
  };
  const keyVersion = c.env.AGENT_ELEVATION_KEY_VERSION ?? 'v1';
  const keys = new CloudflareSecretTextKeyProvider({
    [keyVersion]: c.env.AGENT_ELEVATION_ENCRYPTION_KEY,
  });
  const aad: JsonObject = {
    purpose: 'authrim-agent-elevation-payload-v1',
    tenant_id: tenantId,
    grant_id: challenge.grantId,
    elevation_id: challenge.id,
    actor_sub: challenge.actorSub,
    tool_name: challenge.toolName,
    tool_schema_version: challenge.toolSchemaVersion,
    payload_kind: 'reconciliation_evidence',
  };
  let evidenceEnvelope: string;
  try {
    evidenceEnvelope = await encryptCloudflareAgentJson(canonicalEvidence, keys, keyVersion, aad);
  } catch {
    return c.json({ error: 'AGENT_ELEVATION_ENCRYPTION_UNAVAILABLE' }, 503);
  }
  const evidenceDigest = await sha256Base64Url(canonicalizeJson(canonicalEvidence));
  const auditId = `aud_${crypto.randomUUID()}`;
  const reconciled = await repository.reconcileIndeterminateElevation({
    tenantId,
    challengeId: challenge.id,
    reconciledBy: auth.userId,
    outcome: record.outcome,
    evidenceEnvelope,
    evidenceDigest,
    reconciledAt: now,
    audit: {
      id: auditId,
      tenantId,
      adminUserId: auth.userId,
      action: 'agent.elevation.reconciled',
      resourceType: 'agent_elevation',
      resourceId: challenge.id,
      severity: 'warn',
      actorType: 'admin_user',
      actorSub: `admin_user:${auth.userId}`,
      elevationId: challenge.id,
      grantId: challenge.grantId,
      mcpTool: tool.name,
      metadata: { outcome: record.outcome, evidence_digest: evidenceDigest },
      createdAt: now,
    },
  });
  if (!reconciled) return c.json({ error: 'AGENT_ELEVATION_RECONCILIATION_CONFLICT' }, 409);
  return c.json({ id: challenge.id, status: 'indeterminate', reconciled_outcome: record.outcome });
});
