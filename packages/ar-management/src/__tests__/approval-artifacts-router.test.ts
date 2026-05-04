import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const {
  mockAdapter,
  mockRequestRepo,
  mockApprovalRepo,
  mockGrantRepo,
  mockPasskeyRepo,
  mockSessionRepo,
} = vi.hoisted(() => ({
  mockAdapter: {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
  } satisfies Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>,
  mockRequestRepo: {
    getApprovalRequestByPublicId: vi.fn(),
  },
  mockApprovalRepo: {
    getApprovalById: vi.fn(),
  },
  mockGrantRepo: {},
  mockPasskeyRepo: {
    getPasskeysByUser: vi.fn(),
    findByCredentialId: vi.fn(),
    updateCounter: vi.fn(),
  },
  mockSessionRepo: {
    setMfaVerified: vi.fn(),
  },
}));

const { mockGetApprovalCompletionArtifact, mockConsumeApprovalCompletionArtifact } = vi.hoisted(() => ({
  mockGetApprovalCompletionArtifact: vi.fn(),
  mockConsumeApprovalCompletionArtifact: vi.fn(),
}));

const { mockIssueApprovalDecisionReceipt } = vi.hoisted(() => ({
  mockIssueApprovalDecisionReceipt: vi.fn(),
}));

const { mockApplyApprovalDecisionForRequest } = vi.hoisted(() => ({
  mockApplyApprovalDecisionForRequest: vi.fn(),
}));

const { mockAppendApprovalTransportEvent } = vi.hoisted(() => ({
  mockAppendApprovalTransportEvent: vi.fn(),
}));

const { mockVerifyApprovalOtpChallenge } = vi.hoisted(() => ({
  mockVerifyApprovalOtpChallenge: vi.fn(),
}));

const { mockSwitchApprovalArtifactMethod } = vi.hoisted(() => ({
  mockSwitchApprovalArtifactMethod: vi.fn(),
}));

const {
  mockStartApprovalCibaRequest,
  mockGetApprovalCibaStatus,
  mockRespondToApprovalCibaRequest,
} = vi.hoisted(() => ({
  mockStartApprovalCibaRequest: vi.fn(),
  mockGetApprovalCibaStatus: vi.fn(),
  mockRespondToApprovalCibaRequest: vi.fn(),
}));

const { mockDispatchApprovalCibaUserCode } = vi.hoisted(() => ({
  mockDispatchApprovalCibaUserCode: vi.fn(),
}));

const {
  mockAssertApprovalCibaNotificationCooldown,
  mockRecordApprovalCibaNotificationDispatch,
  MockApprovalCibaNotificationError,
} = vi.hoisted(() => ({
  mockAssertApprovalCibaNotificationCooldown: vi.fn(),
  mockRecordApprovalCibaNotificationDispatch: vi.fn(),
  MockApprovalCibaNotificationError: class ApprovalCibaNotificationError extends Error {
    status: number;
    retryAfterMs: number | null;

    constructor(message: string, status = 409, retryAfterMs: number | null = null) {
      super(message);
      this.status = status;
      this.retryAfterMs = retryAfterMs;
    }
  },
}));

const { mockWebAuthnFunctions } = vi.hoisted(() => ({
  mockWebAuthnFunctions: {
    generateAuthenticationOptions: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
  },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware:
      vi.fn(() =>
        async (c: any, next: () => Promise<void>) => {
          c.set('adminAuth', {
            userId: c.req.header('X-Admin-User-Id') ?? 'admin-2',
            authMethod: c.req.header('X-Admin-Auth-Method') ?? 'session',
            tenantId: 'tenant-a',
            permissions: ['admin:approvals:write'],
            roles: ['tenant_admin'],
            hierarchyLevel: 50,
            mfaVerified: c.req.header('X-Admin-Mfa-Verified') !== 'false',
            sessionId: c.req.header('X-Admin-Session-Id') ?? 'admin-session-1',
          });
          await next();
        }
      ),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    ApprovalRequestRepository: vi.fn(function MockApprovalRequestRepository() {
      return mockRequestRepo;
    }),
    ApprovalRequestApprovalRepository: vi.fn(function MockApprovalRequestApprovalRepository() {
      return mockApprovalRepo;
    }),
    ElevationGrantRepository: vi.fn(function MockElevationGrantRepository() {
      return mockGrantRepo;
    }),
    AdminPasskeyRepository: vi.fn(function MockAdminPasskeyRepository() {
      return mockPasskeyRepo;
    }),
    AdminSessionRepository: vi.fn(function MockAdminSessionRepository() {
      return mockSessionRepo;
    }),
  };
});

vi.mock('../approval-completion-artifact', () => ({
  getApprovalCompletionArtifact: mockGetApprovalCompletionArtifact,
  consumeApprovalCompletionArtifact: mockConsumeApprovalCompletionArtifact,
}));

vi.mock('../approval-completion-receipt', () => ({
  issueApprovalDecisionReceipt: mockIssueApprovalDecisionReceipt,
}));

vi.mock('../approval-workflow', () => ({
  applyApprovalDecisionForRequest: mockApplyApprovalDecisionForRequest,
}));

vi.mock('../approval-transport-detail', () => ({
  appendApprovalTransportEvent: mockAppendApprovalTransportEvent,
}));

vi.mock('../approval-otp', () => ({
  verifyApprovalOtpChallenge: mockVerifyApprovalOtpChallenge,
}));

vi.mock('../approval-artifact-method-switch', () => ({
  ApprovalArtifactMethodSwitchError: class ApprovalArtifactMethodSwitchError extends Error {
    status: number;
    code: string;
    retryAfterMs: number | null;

    constructor(input: { status: number; code: string; message: string; retryAfterMs?: number | null }) {
      super(input.message);
      this.status = input.status;
      this.code = input.code;
      this.retryAfterMs = input.retryAfterMs ?? null;
    }
  },
  switchApprovalArtifactMethod: mockSwitchApprovalArtifactMethod,
}));

vi.mock('../approval-ciba', () => ({
  startApprovalCibaRequest: mockStartApprovalCibaRequest,
  getApprovalCibaStatus: mockGetApprovalCibaStatus,
  respondToApprovalCibaRequest: mockRespondToApprovalCibaRequest,
}));

vi.mock('../approval-ciba-notification', () => ({
  ApprovalCibaNotificationError: MockApprovalCibaNotificationError,
  assertApprovalCibaNotificationCooldown: mockAssertApprovalCibaNotificationCooldown,
  dispatchApprovalCibaUserCode: mockDispatchApprovalCibaUserCode,
  recordApprovalCibaNotificationDispatch: mockRecordApprovalCibaNotificationDispatch,
}));

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: mockWebAuthnFunctions.generateAuthenticationOptions,
  verifyAuthenticationResponse: mockWebAuthnFunctions.verifyAuthenticationResponse,
}));

import { approvalArtifactsRouter } from '../routes/approval-artifacts';
import { ApprovalArtifactMethodSwitchError } from '../approval-artifact-method-switch';

function makeArtifact(overrides: Record<string, unknown> = {}) {
  return {
    artifact_id: 'apc_1',
    tenant_id: 'tenant-a',
    request_id: 'apr_public_1',
    approval_id: 'step-1',
    step_key: 'operator-1',
    investigation_id: 'inv_1',
    request_surface: 'admin_audit',
    requested_action: 'detail_read',
    target_subject_type: 'user',
    target_subject_id: 'user-1',
    requester_subject_type: 'admin_user',
    requester_subject_id: 'admin-1',
    approver_side: 'admin_operator',
    approver_subject_type: 'admin_user',
    approver_subject_id: 'admin-2',
    relation_type: null,
    relation_source: null,
    method: 'portal_confirm',
    transport_channel: 'portal_confirm',
    redaction_level: 'masked',
    policy_preset: 'support_case_default',
    reuse_scope: 'request',
    partial_access_allowed: false,
    reference: null,
    ticket_reference: null,
    expires_at: Date.now() + 60_000,
    created_at: Date.now(),
    consumed: false,
    ...overrides,
  };
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    public_request_id: 'apr_public_1',
    tenant_id: 'tenant-a',
    investigation_id: 'inv_1',
    requester_subject_type: 'admin_user',
    requester_subject_id: 'admin-1',
    target_subject_type: 'user',
    target_subject_id: 'user-1',
    request_surface: 'admin_audit',
    requested_action: 'detail_read',
    redaction_level: 'masked',
    status: 'pending',
    scope_json: {
      version: 1,
      surface: 'admin_audit',
      action: 'detail_read',
      tenant_id: 'tenant-a',
      resource_class: 'admin_audit_detail',
    },
    scope_canonical: '{}',
    reason_code: 'support_case',
    reason_note: null,
    reference: null,
    ticket_reference: null,
    reuse_scope: 'request',
    policy_preset: 'support_case_default',
    partial_access_allowed: false,
    requested_at: Date.now(),
    expires_at: Date.now() + 60_000,
    decided_at: null,
    detail_object_catalog_id: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function makeApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: 'step-1',
    approval_request_id: 'req-1',
    step_key: 'operator-1',
    side: 'admin_operator',
    subject_type: 'admin_user',
    subject_id: 'admin-2',
    relation_type: null,
    relation_source: null,
    status: 'pending',
    method: 'portal_confirm',
    transport_channel: 'portal_confirm',
    reason_code: null,
    reason_note: null,
    last_notification_action: 'initial',
    last_notified_at: Date.now(),
    notification_count: 1,
    requested_at: Date.now(),
    decided_at: null,
    expires_at: Date.now() + 60_000,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

const mockEnv = {
  DB_ADMIN: {},
  AUTHRIM_CONFIG: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
} as unknown as Env;

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/approval-artifacts', approvalArtifactsRouter);
  return app;
}

describe('approval artifacts router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApprovalCompletionArtifact.mockResolvedValue(makeArtifact());
    mockConsumeApprovalCompletionArtifact.mockResolvedValue(makeArtifact({ consumed: true }));
    mockIssueApprovalDecisionReceipt.mockResolvedValue({
      receipt_id: 'adr_1',
      artifact_id: 'apc_1',
      tenant_id: 'tenant-a',
      request_id: 'apr_public_1',
      approval_id: 'step-1',
      step_key: 'operator-1',
      investigation_id: 'inv_1',
      request_surface: 'admin_audit',
      requested_action: 'detail_read',
      target_subject_type: 'user',
      target_subject_id: 'user-1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      approver_side: 'admin_operator',
      approver_subject_type: 'admin_user',
      approver_subject_id: 'admin-2',
      relation_type: null,
      relation_source: null,
      method: 'portal_confirm',
      transport_channel: 'portal_confirm',
      redaction_level: 'masked',
      request_status: 'approved',
      decision: 'approved',
      grant_ids: ['egr_public_1'],
      reference: null,
      ticket_reference: null,
      completed_at: Date.now(),
      expires_at: Date.now() + 60_000,
      created_at: Date.now(),
    });
    mockRequestRepo.getApprovalRequestByPublicId.mockResolvedValue(makeRequest());
    mockApprovalRepo.getApprovalById.mockResolvedValue(makeApproval());
    mockApplyApprovalDecisionForRequest.mockResolvedValue({
      request: {
        public_request_id: 'apr_public_1',
        status: 'approved',
      },
      approvals: [],
      grants: [{ public_grant_id: 'egr_public_1' }],
    });
    mockAppendApprovalTransportEvent.mockImplementation(async (_c, _adapter, _requestRepo, request) => request);
    mockVerifyApprovalOtpChallenge.mockResolvedValue({
      verifiedAt: Date.now(),
    });
    mockStartApprovalCibaRequest.mockResolvedValue({
      authReqId: 'g1:apac:1:cba_internal',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      interval: 5,
      userCode: 'ABCD-EFGH',
      reused: false,
    });
    mockGetApprovalCibaStatus.mockResolvedValue({
      authReqId: 'g1:apac:1:cba_internal',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      interval: 5,
      status: 'pending',
      userCode: 'ABCD-EFGH',
      decisionAt: null,
    });
    mockRespondToApprovalCibaRequest.mockResolvedValue({
      authReqId: 'g1:apac:1:cba_internal',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      interval: 5,
      status: 'approved',
      userCode: 'ABCD-EFGH',
      decisionAt: Date.now(),
    });
    mockDispatchApprovalCibaUserCode.mockResolvedValue({
      channel: 'email',
      target: 'customer@example.com',
      messageId: 'msg_1',
    });
    mockAssertApprovalCibaNotificationCooldown.mockResolvedValue(null);
    mockRecordApprovalCibaNotificationDispatch.mockResolvedValue({
      auth_req_id: 'g1:apac:1:cba_internal',
      notification_count: 1,
      last_notified_at: Date.now(),
    });
    mockPasskeyRepo.getPasskeysByUser.mockResolvedValue([
      {
        id: 'apk_1',
        admin_user_id: 'admin-2',
        credential_id: 'credential-1',
        public_key: Buffer.from('public-key').toString('base64'),
        counter: 1,
        device_name: 'Security Key',
        transports: ['internal'],
        attestation_type: null,
        aaguid: null,
        created_at: Date.now(),
        last_used_at: null,
      },
    ]);
    mockPasskeyRepo.findByCredentialId.mockResolvedValue({
      id: 'apk_1',
      admin_user_id: 'admin-2',
      credential_id: 'credential-1',
      public_key: Buffer.from('public-key').toString('base64'),
      counter: 1,
      device_name: 'Security Key',
      transports: ['internal'],
      attestation_type: null,
      aaguid: null,
      created_at: Date.now(),
      last_used_at: null,
    });
    mockPasskeyRepo.updateCounter.mockResolvedValue(true);
    mockSessionRepo.setMfaVerified.mockResolvedValue(true);
    (mockEnv.AUTHRIM_CONFIG!.get as any).mockResolvedValue(null);
    (mockEnv.AUTHRIM_CONFIG!.put as any).mockResolvedValue(undefined);
    (mockEnv.AUTHRIM_CONFIG!.delete as any).mockResolvedValue(undefined);
    mockSwitchApprovalArtifactMethod.mockResolvedValue({
      requestWithDetail: makeRequest(),
      approval: makeApproval(),
      dispatchResult: {
        success: true,
        method: 'passkey',
        transportChannel: 'Registered passkey on this device',
        completionArtifact: {
          artifactId: 'apc_2',
          path: '/api/approval-artifacts/apc_2/portal',
          expiresAt: Date.now() + 60_000,
        },
        summary: {
          provider: 'authrim.passkey',
          delivery_status: 'recorded',
          target: 'admin-2',
          correlation_id: 'inv_1',
          transport_request_id: 'apc_2',
        },
        detail: {
          request: {},
          response: {},
          metadata: {},
        },
      },
      allowedMethods: ['portal_confirm', 'passkey', 'reauth'],
      replacedArtifactId: 'apc_1',
    });
    mockWebAuthnFunctions.generateAuthenticationOptions.mockResolvedValue({
      challenge: 'passkey-challenge',
      rpId: 'admin.example.com',
      allowCredentials: [],
    });
    mockWebAuthnFunctions.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        newCounter: 7,
      },
    });
  });

  it('returns artifact preview details', async () => {
    const app = createApp();
    const res = await app.request('/api/approval-artifacts/apc_1', {}, mockEnv);

    expect(res.status).toBe(200);
    const payload = (await res.json()) as any;
    expect(payload.artifact.artifact_id).toBe('apc_1');
    expect(payload.request.public_request_id).toBe('apr_public_1');
    expect(payload.approval.id).toBe('step-1');
    expect(payload.completion_requirements).toEqual({
      mode: 'artifact_only',
      method: 'portal_confirm',
      acceptable_methods: ['portal_confirm', 'passkey', 'reauth'],
      artifact_path: '/api/approval-artifacts/apc_1',
      portal_path: '/api/approval-artifacts/apc_1/portal',
      switch_method_path: '/api/approval-artifacts/apc_1/switch-method',
      assertion_endpoints: null,
      transport_channel: 'Authrim approval portal',
      guidance_title: 'Review And Confirm In Portal',
      guidance_body:
        'Review the request details on this page and choose Approve or Deny directly in the portal.',
      fallback_note:
        'If this method is unavailable, re-issue the approval artifact with one of: passkey, reauth.',
      approver_binding: {
        subject_type: 'admin_user',
        subject_id: 'admin-2',
        relation_type: null,
        relation_source: null,
      },
    });
  });

  it('masks OTP transport targets and includes fallback guidance', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'email_otp',
        transport_channel: 'person@example.com',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        side: 'customer_data_owner',
        method: 'email_otp',
        transport_channel: 'person@example.com',
        subject_type: 'customer_delegate',
        subject_id: 'customer-1',
      })
    );

    const app = createApp();
    const res = await app.request('/api/approval-artifacts/apc_1', {}, mockEnv);

    expect(res.status).toBe(200);
    const payload = (await res.json()) as any;
    expect(payload.completion_requirements.transport_channel).toBe('pe***@example.com');
    expect(payload.completion_requirements.guidance_title).toBe('Approve With Email Code');
    expect(payload.completion_requirements.fallback_note).toContain('ciba');
    expect(payload.completion_requirements.portal_path).toBe('/api/approval-artifacts/apc_1/portal');
    expect(payload.completion_requirements.switch_method_path).toBe(
      '/api/approval-artifacts/apc_1/switch-method'
    );
  });

  it('starts a CIBA completion request and returns device/status links', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'ciba',
        transport_channel: 'customer@example.com',
        approver_subject_type: 'customer_delegate',
        approver_subject_id: 'customer-1',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        subject_type: 'customer_delegate',
        subject_id: 'customer-1',
        method: 'ciba',
        transport_channel: 'customer@example.com',
      })
    );

    const app = createApp();
    const res = await app.request('/api/approval-artifacts/apc_1/ciba/start', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      auth_req_id: 'g1:apac:1:cba_internal',
      status_path: '/api/approval-artifacts/apc_1/ciba/status',
      device_path: '/api/approval-artifacts/apc_1/ciba/device?auth_req_id=g1%3Aapac%3A1%3Acba_internal',
    });
    expect(mockDispatchApprovalCibaUserCode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        artifactId: 'apc_1',
        authReqId: 'g1:apac:1:cba_internal',
        userCode: 'ABCD-EFGH',
      })
    );
    expect(mockRecordApprovalCibaNotificationDispatch).toHaveBeenCalledWith({
      env: mockEnv,
      artifactId: 'apc_1',
      authReqId: 'g1:apac:1:cba_internal',
      expiresAt: expect.any(Number),
      previousState: null,
    });
  });

  it('rate-limits repeated public CIBA starts within the resend cooldown window', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'ciba',
        transport_channel: 'customer@example.com',
        approver_subject_type: 'customer_delegate',
        approver_subject_id: 'customer-1',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        subject_type: 'customer_delegate',
        subject_id: 'customer-1',
        method: 'ciba',
        transport_channel: 'customer@example.com',
      })
    );
    (mockEnv.AUTHRIM_CONFIG!.get as any).mockResolvedValueOnce(
      JSON.stringify({
        auth_req_id: 'g1:apac:1:cba_internal',
        notification_count: 1,
        last_notified_at: Date.now(),
      })
    );
    mockAssertApprovalCibaNotificationCooldown.mockRejectedValueOnce(
      new MockApprovalCibaNotificationError(
        'This approval step was notified too recently. Please wait before retrying.',
        429,
        60_000
      )
    );

    const app = createApp();
    const res = await app.request('/api/approval-artifacts/apc_1/ciba/start', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({
      error: 'approval_ciba_delivery_failed',
      retry_after_ms: expect.any(Number),
    });
    expect(mockStartApprovalCibaRequest).not.toHaveBeenCalled();
    expect(mockDispatchApprovalCibaUserCode).not.toHaveBeenCalled();
  });

  it('returns approved CIBA status with a completion assertion', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'ciba',
        transport_channel: 'customer@example.com',
        approver_subject_type: 'customer_delegate',
        approver_subject_id: 'customer-1',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        subject_type: 'customer_delegate',
        subject_id: 'customer-1',
        method: 'ciba',
        transport_channel: 'customer@example.com',
      })
    );
    mockGetApprovalCibaStatus.mockResolvedValueOnce({
      authReqId: 'g1:apac:1:cba_internal',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      interval: 5,
      status: 'approved',
      userCode: 'ABCD-EFGH',
      decisionAt: 1710000000000,
    });

    const app = createApp();
    const res = await app.request('/api/approval-artifacts/apc_1/ciba/status', {}, mockEnv);

    expect(res.status).toBe(200);
    const payload = (await res.json()) as any;
    expect(payload).toMatchObject({
      auth_req_id: 'g1:apac:1:cba_internal',
      status: 'approved',
      completion_assertion: {
        method: 'ciba',
        actor_subject_type: 'customer_delegate',
        actor_subject_id: 'customer-1',
        metadata: {
          source: 'approval_ciba',
          auth_req_id: 'g1:apac:1:cba_internal',
        },
      },
    });
    expect(payload.user_code).toBeUndefined();
  });

  it('renders a dedicated authentication device page for CIBA approval', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'ciba',
        transport_channel: 'customer@example.com',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        method: 'ciba',
        transport_channel: 'customer@example.com',
      })
    );

    const app = createApp();
    const res = await app.request('/api/approval-artifacts/apc_1/ciba/device', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Authentication device approval');
  });

  it('records CIBA device approval decisions', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'ciba',
        transport_channel: 'customer@example.com',
        approver_subject_id: 'customer-1',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        subject_type: 'customer_delegate',
        subject_id: 'customer-1',
        method: 'ciba',
        transport_channel: 'customer@example.com',
      })
    );

    const app = createApp();
    const res = await app.request(
      '/api/approval-artifacts/apc_1/ciba/respond',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: 'approved',
          auth_req_id: 'g1:apac:1:cba_internal',
          user_code: 'ABCD-EFGH',
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      auth_req_id: 'g1:apac:1:cba_internal',
      status: 'approved',
    });
    expect(mockRespondToApprovalCibaRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        authReqId: 'g1:apac:1:cba_internal',
        userCode: 'ABCD-EFGH',
      })
    );
  });

  it('rejects CIBA device decisions without a verification code', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'ciba',
        transport_channel: 'customer@example.com',
        approver_subject_id: 'customer-1',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        subject_type: 'customer_delegate',
        subject_id: 'customer-1',
        method: 'ciba',
        transport_channel: 'customer@example.com',
      })
    );

    const app = createApp();
    const res = await app.request(
      '/api/approval-artifacts/apc_1/ciba/respond',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', auth_req_id: 'g1:apac:1:cba_internal' }),
      },
      mockEnv
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'invalid_request',
    });
  });

  it('renders a human-usable portal confirmation page', async () => {
    const app = createApp();
    const res = await app.request('/api/approval-artifacts/apc_1/portal', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Approval request');
    expect(html).toContain('Approve');
    expect(html).toContain('/api/approval-artifacts/apc_1/complete');
    expect(html).toContain('/api/approval-artifacts/apc_1/switch-method');
    expect(html).toContain('Switch to passkey');
    expect(html).toContain('Switch to reauth');
  });

  it('switches a public approval artifact to a fallback completion method', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/approval-artifacts/apc_1/switch-method',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'passkey' }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as any;
    expect(mockSwitchApprovalArtifactMethod).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        currentArtifactId: 'apc_1',
        currentMethod: 'portal_confirm',
        requestedMethod: 'passkey',
      })
    );
    expect(payload.replaced_artifact_id).toBe('apc_1');
    expect(payload.artifact).toEqual({
      artifact_id: 'apc_2',
      path: '/api/approval-artifacts/apc_2/portal',
      expires_at: expect.any(Number),
    });
    expect(payload.completion_requirements.method).toBe('passkey');
    expect(payload.completion_requirements.portal_path).toBe('/api/approval-artifacts/apc_2/portal');
    expect(payload.notification_result.delivery_status).toBe('recorded');
  });

  it('rejects disallowed public fallback method switches', async () => {
    mockSwitchApprovalArtifactMethod.mockRejectedValueOnce(
      new ApprovalArtifactMethodSwitchError({
        status: 409,
        code: 'approval_completion_method_not_allowed',
        message: 'The requested fallback method is not allowed for this approval step.',
      })
    );

    const app = createApp();
    const res = await app.request(
      '/api/approval-artifacts/apc_1/switch-method',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'sms_otp' }),
      },
      mockEnv
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'approval_completion_method_not_allowed',
    });
  });

  it('renders passkey portal actions for passkey completion artifacts', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'passkey',
        transport_channel: 'passkey',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        method: 'passkey',
        transport_channel: 'passkey',
      })
    );

    const app = createApp();
    const res = await app.request('/api/approval-artifacts/apc_1/portal', {}, mockEnv);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('passkey-approve-button');
    expect(html).toContain('/api/approval-artifacts/apc_1/passkey/options');
    expect(html).toContain('/api/approval-artifacts/apc_1/passkey/verify');
  });

  it('renders reauth portal actions for reauth completion artifacts', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'reauth',
        transport_channel: 'reauth',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        method: 'reauth',
        transport_channel: 'reauth',
      })
    );

    const app = createApp();
    const res = await app.request('/api/approval-artifacts/apc_1/portal', {}, mockEnv);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('reauth-approve-button');
    expect(html).toContain('/api/approval-artifacts/apc_1/reauth/assert');
  });

  it('creates a passkey options challenge for step-up completion', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'passkey',
        transport_channel: 'passkey',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        method: 'passkey',
        transport_channel: 'passkey',
      })
    );

    const app = createApp();
    const res = await app.request(
      '/api/approval-artifacts/apc_1/passkey/options',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://admin.example.com',
        },
        body: JSON.stringify({}),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as any;
    expect(payload.challenge_id).toContain('apc_1:pk:');
    expect(mockWebAuthnFunctions.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'admin.example.com',
      })
    );
    expect(mockEnv.AUTHRIM_CONFIG!.put).toHaveBeenCalled();
    expect(payload.completion_requirements.assertion_endpoints).toEqual({
      options: '/api/approval-artifacts/apc_1/passkey/options',
      verify: '/api/approval-artifacts/apc_1/passkey/verify',
    });
  });

  it('verifies a passkey completion challenge and returns an assertion', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'passkey',
        transport_channel: 'passkey',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        method: 'passkey',
        transport_channel: 'passkey',
      })
    );
    (mockEnv.AUTHRIM_CONFIG!.get as any).mockResolvedValueOnce(
      JSON.stringify({
        challenge: 'passkey-challenge',
        rpID: 'admin.example.com',
        origin: 'https://admin.example.com',
        artifactId: 'apc_1',
        approvalId: 'step-1',
        approverSubjectId: 'admin-2',
      })
    );

    const app = createApp();
    const res = await app.request(
      '/api/approval-artifacts/apc_1/passkey/verify',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://admin.example.com',
        },
        body: JSON.stringify({
          challenge_id: 'apc_1:pk:test',
          credential: {
            id: 'credential-1',
            rawId: 'credential-1',
            type: 'public-key',
            response: {},
          },
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as any;
    expect(payload.completion_assertion).toEqual(
      expect.objectContaining({
        method: 'passkey',
        actor_subject_type: 'admin_user',
        actor_subject_id: 'admin-2',
      })
    );
    expect(mockPasskeyRepo.findByCredentialId).toHaveBeenCalledWith('credential-1');
    expect(mockPasskeyRepo.updateCounter).toHaveBeenCalledWith('apk_1', 7);
    expect(mockEnv.AUTHRIM_CONFIG!.delete).toHaveBeenCalledWith(
      'approval_passkey:challenge:apc_1:pk:test'
    );
  });

  it('creates a reauth assertion from a matching admin session', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'reauth',
        transport_channel: 'reauth',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        method: 'reauth',
        transport_channel: 'reauth',
      })
    );

    const app = createApp();
    const res = await app.request(
      '/api/approval-artifacts/apc_1/reauth/assert',
      {
        method: 'POST',
        headers: {
          'X-Admin-User-Id': 'admin-2',
          'X-Admin-Auth-Method': 'session',
          'X-Admin-Session-Id': 'session-reauth-1',
        },
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as any;
    expect(payload.completion_assertion).toEqual(
      expect.objectContaining({
        method: 'reauth',
        actor_subject_type: 'admin_user',
        actor_subject_id: 'admin-2',
      })
    );
    expect(mockSessionRepo.setMfaVerified).toHaveBeenCalledWith('session-reauth-1');
  });

  it('verifies an approval OTP and returns a completion assertion', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'email_otp',
        transport_channel: 'owner@example.com',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        side: 'customer_data_owner',
        subject_type: 'customer_delegate',
        subject_id: 'owner-1',
        method: 'email_otp',
        transport_channel: 'owner@example.com',
      })
    );

    const app = createApp();
    const res = await app.request(
      '/api/approval-artifacts/apc_1/otp/verify',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          code: '123456',
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as any;
    expect(payload.completion_assertion).toEqual(
      expect.objectContaining({
        method: 'email_otp',
        actor_subject_type: 'customer_delegate',
        actor_subject_id: 'owner-1',
      })
    );
    expect(mockVerifyApprovalOtpChallenge).toHaveBeenCalledWith(
      mockEnv,
      expect.objectContaining({
        artifactId: 'apc_1',
        code: '123456',
        target: 'owner@example.com',
      })
    );
  });

  it('consumes an artifact and applies the decision', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/approval-artifacts/apc_1/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockConsumeApprovalCompletionArtifact).toHaveBeenCalledWith(mockEnv, 'apc_1');
    expect(mockApplyApprovalDecisionForRequest).toHaveBeenCalled();
    const payload = (await res.json()) as any;
    expect(payload.request_status).toBe('approved');
    expect(payload.grant_ids).toEqual(['egr_public_1']);
    expect(payload.receipt_id).toBe('adr_1');
    expect(payload.receipt_path).toBe('/api/approval-receipts/adr_1');
    expect(payload.receipt_portal_path).toBe('/api/approval-receipts/adr_1/portal');
    expect(mockIssueApprovalDecisionReceipt).toHaveBeenCalledWith(
      mockEnv,
      expect.objectContaining({
        artifact: expect.objectContaining({ artifact_id: 'apc_1' }),
        decision: 'approved',
      })
    );
    expect(mockAppendApprovalTransportEvent).toHaveBeenCalledWith(
      expect.anything(),
      mockAdapter,
      mockRequestRepo,
      expect.objectContaining({
        public_request_id: 'apr_public_1',
      }),
      expect.objectContaining({
        kind: 'step_receipt_issued',
      })
    );
  });

  it('requires a completion assertion for step-up methods', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'passkey',
        transport_channel: 'passkey',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        method: 'passkey',
        transport_channel: 'passkey',
      })
    );

    const app = createApp();
    const res = await app.request(
      '/api/approval-artifacts/apc_1/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      },
      mockEnv
    );

    expect(res.status).toBe(409);
    const payload = (await res.json()) as any;
    expect(payload.error).toBe('approval_step_up_required');
    expect(mockConsumeApprovalCompletionArtifact).not.toHaveBeenCalled();
  });

  it('requires a completion assertion for email otp methods', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'email_otp',
        transport_channel: 'owner@example.com',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        side: 'customer_data_owner',
        subject_type: 'customer_delegate',
        subject_id: 'owner-1',
        method: 'email_otp',
        transport_channel: 'owner@example.com',
      })
    );

    const app = createApp();
    const res = await app.request(
      '/api/approval-artifacts/apc_1/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      },
      mockEnv
    );

    expect(res.status).toBe(409);
    const payload = (await res.json()) as any;
    expect(payload.error).toBe('approval_step_up_required');
  });

  it('allows denial without a completion assertion for step-up methods', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'email_otp',
        transport_channel: 'owner@example.com',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        side: 'customer_data_owner',
        subject_type: 'customer_delegate',
        subject_id: 'owner-1',
        method: 'email_otp',
        transport_channel: 'owner@example.com',
      })
    );
    mockConsumeApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'email_otp',
        transport_channel: 'owner@example.com',
        consumed: true,
        approver_subject_type: 'customer_delegate',
        approver_subject_id: 'owner-1',
      })
    );

    const app = createApp();
    const res = await app.request(
      '/api/approval-artifacts/apc_1/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'denied' }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockConsumeApprovalCompletionArtifact).toHaveBeenCalledWith(mockEnv, 'apc_1');
    expect(mockApplyApprovalDecisionForRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        nextStatus: 'denied',
      })
    );
  });

  it('accepts a matching completion assertion for step-up methods', async () => {
    mockGetApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'passkey',
        transport_channel: 'passkey',
      })
    );
    mockApprovalRepo.getApprovalById.mockResolvedValueOnce(
      makeApproval({
        method: 'passkey',
        transport_channel: 'passkey',
      })
    );
    mockConsumeApprovalCompletionArtifact.mockResolvedValueOnce(
      makeArtifact({
        method: 'passkey',
        transport_channel: 'passkey',
        consumed: true,
      })
    );

    const app = createApp();
    const res = await app.request(
      '/api/approval-artifacts/apc_1/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: 'approved',
          completion_assertion: {
            method: 'passkey',
            actor_subject_type: 'admin_user',
            actor_subject_id: 'admin-2',
          },
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockConsumeApprovalCompletionArtifact).toHaveBeenCalledWith(mockEnv, 'apc_1');
    expect(mockApplyApprovalDecisionForRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        transportDetail: expect.objectContaining({
          metadata: expect.objectContaining({
            completion_assertion: expect.objectContaining({
              method: 'passkey',
              actor_subject_id: 'admin-2',
            }),
          }),
        }),
      })
    );
  });
});
