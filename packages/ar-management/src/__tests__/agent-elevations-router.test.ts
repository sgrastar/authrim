import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS, type AdminAuthContext, type Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  auth: {} as AdminAuthContext & { authenticationTimeMs?: number },
  featureEnabled: vi.fn(),
  getChallenge: vi.fn(),
  getGrant: vi.fn(),
  decide: vi.fn(),
  reconcile: vi.fn(),
  getActiveDelegatorPermissions: vi.fn(),
  linkApproval: vi.fn(),
  createApprovalRequest: vi.fn(),
  createApproval: vi.fn(),
  issueArtifact: vi.fn(),
  startCiba: vi.fn(),
  dispatchCiba: vi.fn(),
}));

vi.mock('../agent-downscope-auth', () => ({
  isAgentMcpEnabled: mocks.featureEnabled,
}));

vi.mock('@authrim/ar-agent-access/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-agent-access/core')>();
  return {
    ...actual,
    AdminAgentAccessRepository: class {
      getElevationChallenge = mocks.getChallenge;
      getGrant = mocks.getGrant;
      decideElevation = mocks.decide;
      reconcileIndeterminateElevation = mocks.reconcile;
      getActiveDelegatorPermissions = mocks.getActiveDelegatorPermissions;
      linkElevationApprovalRequest = mocks.linkApproval;
    },
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware:
      () =>
      async (
        c: { set(key: 'adminAuth', value: AdminAuthContext): void },
        next: () => Promise<void>
      ) => {
        c.set('adminAuth', mocks.auth);
        await next();
      },
    requireDedicatedAdminDatabaseAdapter: () => ({}),
    ApprovalRequestRepository: class {
      createApprovalRequest = mocks.createApprovalRequest;
    },
    ApprovalRequestApprovalRepository: class {
      createApproval = mocks.createApproval;
    },
  };
});

vi.mock('../approval-completion-artifact', () => ({
  issueApprovalCompletionArtifact: mocks.issueArtifact,
}));

vi.mock('../approval-ciba', () => ({ startApprovalCibaRequest: mocks.startCiba }));
vi.mock('../approval-ciba-notification', () => ({
  dispatchApprovalCibaUserCode: mocks.dispatchCiba,
}));

import { agentElevationsRouter } from '../routes/admin-management/agent-elevations';

function app() {
  const result = new Hono<{ Bindings: Env }>();
  result.route('/api/admin/agent-elevations', agentElevationsRouter as never);
  return result;
}

function decide(decision: 'approved' | 'denied') {
  return app().request(
    '/api/admin/agent-elevations/ael-1/decision',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    },
    { ENABLE_AGENT_MCP: 'true', DB_ADMIN: {} } as unknown as Env
  );
}

describe('Agent elevation review routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = {
      userId: 'admin-2',
      actorType: 'human',
      authMethod: 'session',
      mfaVerified: true,
      tenantId: 'tenant-1',
      roles: [],
      permissions: [ADMIN_PERMISSIONS.USERS_SUSPEND, ADMIN_PERMISSIONS.AGENT_USE],
      authenticationTimeMs: Date.now(),
    };
    mocks.featureEnabled.mockResolvedValue(true);
    mocks.getChallenge.mockResolvedValue({
      id: 'ael-1',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      userId: 'admin-2',
      actorSub: 'client:client-1',
      clientId: 'client-1',
      toolName: 'admin.write.users.suspend',
      toolSchemaVersion: '1',
      argsHash: 'safe-hash',
      confirmSummaryRedacted: 'Suspend user user-1',
      status: 'pending',
      executionAttempt: 0,
      executionFence: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    mocks.getGrant.mockResolvedValue({
      status: 'active',
      permissions: [ADMIN_PERMISSIONS.USERS_SUSPEND],
    });
    mocks.decide.mockResolvedValue(true);
    mocks.reconcile.mockResolvedValue(true);
    mocks.getActiveDelegatorPermissions.mockResolvedValue([ADMIN_PERMISSIONS.USERS_SUSPEND]);
    mocks.linkApproval.mockResolvedValue(true);
    mocks.createApprovalRequest.mockResolvedValue({
      id: 'approval-internal-1',
      public_request_id: 'apr-public-1',
      tenant_id: 'tenant-1',
      investigation_id: 'investigation-1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-2',
      target_subject_type: 'tenant_resource',
      target_subject_id: 'ael-1',
      request_surface: 'agent_mcp',
      requested_action: 'admin.write.users.suspend',
      redaction_level: 'summary_only',
      status: 'pending',
      scope_json: {},
      scope_canonical: '{}',
      reason_code: 'agent_mcp_elevation',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      reuse_scope: 'request',
      policy_preset: 'agent_mcp_high_risk',
      partial_access_allowed: false,
      requested_at: Date.now(),
      expires_at: Date.now() + 60_000,
      decided_at: null,
      detail_object_catalog_id: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    mocks.createApproval.mockResolvedValue({
      id: 'approval-step-1',
      approval_request_id: 'approval-internal-1',
      step_key: 'agent-mcp-elevation',
      side: 'admin_operator',
      subject_type: 'admin_user',
      subject_id: 'admin-3',
      status: 'pending',
      method: 'ciba',
      expires_at: Date.now() + 60_000,
    });
    mocks.issueArtifact.mockResolvedValue({
      artifact_id: 'artifact-1',
      expires_at: Date.now() + 60_000,
    });
    mocks.startCiba.mockResolvedValue({
      authReqId: 'ciba-1',
      expiresAt: Date.now() + 60_000,
      interval: 5,
      userCode: 'ABCD-1234',
      reused: false,
    });
    mocks.dispatchCiba.mockResolvedValue({ channel: 'email', target: 'a@example.test' });
  });

  it('atomically approves an operation after fresh human authentication', async () => {
    const response = await decide('approved');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: 'ael-1',
        decision: 'approved',
        approverType: 'self_reauth',
        approverId: 'admin-2',
        audit: expect.objectContaining({ action: 'agent.elevation.granted' }),
      })
    );
  });

  it('rejects stale sessions before recording an approval', async () => {
    mocks.auth.authenticationTimeMs = Date.now() - 5 * 60 * 1000 - 1;
    const response = await decide('approved');
    expect(response.status).toBe(403);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it('does not approve after the approver loses the operation permission', async () => {
    mocks.auth.permissions = [ADMIN_PERMISSIONS.AGENT_USE];
    const response = await decide('approved');
    expect(response.status).toBe(403);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it('allows the owning delegator to deny without granting the target permission', async () => {
    mocks.auth.permissions = [ADMIN_PERMISSIONS.AGENT_USE];
    const response = await decide('denied');
    expect(response.status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ decision: 'denied' }));
  });

  it('encrypts and atomically audits controlled evidence for human reconciliation', async () => {
    mocks.auth.permissions = [
      ADMIN_PERMISSIONS.AGENT_ELEVATION_RECONCILE,
      ADMIN_PERMISSIONS.USERS_SUSPEND,
    ];
    mocks.getChallenge.mockResolvedValue({
      ...(await mocks.getChallenge()),
      status: 'indeterminate',
    });
    const response = await app().request(
      '/api/admin/agent-elevations/ael-1/reconcile',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          outcome: 'executed',
          evidence: { summary: 'target_state_verified', checkedAt: Date.now() },
        }),
      },
      {
        ENABLE_AGENT_MCP: 'true',
        DB_ADMIN: {},
        AGENT_ELEVATION_ENCRYPTION_KEY: '07'.repeat(32),
        AGENT_ELEVATION_KEY_VERSION: 'v1',
      } as unknown as Env
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'executed',
        evidenceEnvelope: expect.not.stringContaining('target_state_verified'),
        audit: expect.objectContaining({ action: 'agent.elevation.reconciled' }),
      })
    );
  });

  it('rejects free-form reconciliation evidence before encryption or mutation', async () => {
    mocks.auth.permissions = [
      ADMIN_PERMISSIONS.AGENT_ELEVATION_RECONCILE,
      ADMIN_PERMISSIONS.USERS_SUSPEND,
    ];
    const response = await app().request(
      '/api/admin/agent-elevations/ael-1/reconcile',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          outcome: 'executed',
          evidence: { summary: 'token=secret-value', checkedAt: Date.now() },
        }),
      },
      { ENABLE_AGENT_MCP: 'true', DB_ADMIN: {} } as unknown as Env
    );
    expect(response.status).toBe(400);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('starts a distinct-approver CIBA workflow bound to the existing challenge', async () => {
    const response = await app().request(
      '/api/admin/agent-elevations/ael-1/ciba/start',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approver_id: 'admin-3' }),
      },
      { ENABLE_AGENT_MCP: 'true', DB_ADMIN: {} } as unknown as Env
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        request_surface: 'agent_mcp',
        scope_json: expect.objectContaining({
          attributes: expect.objectContaining({
            elevation_id: 'ael-1',
            args_hash: 'safe-hash',
          }),
        }),
      })
    );
    expect(mocks.dispatchCiba).toHaveBeenCalled();
    expect(mocks.linkApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalRequestId: 'approval-internal-1',
        approvalArtifactId: 'artifact-1',
      })
    );
  });

  it('reuses a linked CIBA artifact without exposing the internal ApprovalRequest key', async () => {
    mocks.getChallenge.mockResolvedValue({
      id: 'ael-1',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      userId: 'admin-2',
      actorSub: 'client:client-1',
      clientId: 'client-1',
      toolName: 'admin.write.users.suspend',
      toolSchemaVersion: '1',
      argsHash: 'safe-hash',
      confirmSummaryRedacted: 'Suspend user user-1',
      status: 'pending',
      executionAttempt: 0,
      executionFence: 0,
      approvalRequestId: 'approval-internal-1',
      approvalArtifactId: 'artifact-1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const response = await app().request(
      '/api/admin/agent-elevations/ael-1/ciba/start',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approver_id: 'admin-3' }),
      },
      { ENABLE_AGENT_MCP: 'true', DB_ADMIN: {} } as unknown as Env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      artifact_id: 'artifact-1',
      artifact_path: '/api/approval-artifacts/artifact-1',
      reused: true,
    });
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
  });

  it('rejects CIBA self-approval before creating an ApprovalRequest', async () => {
    const response = await app().request(
      '/api/admin/agent-elevations/ael-1/ciba/start',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approver_id: 'admin-2' }),
      },
      { ENABLE_AGENT_MCP: 'true', DB_ADMIN: {} } as unknown as Env
    );
    expect(response.status).toBe(400);
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
  });
});
