import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const { mockAdapter, mockRequestRepo, mockApprovalRepo, mockGrantRepo } = vi.hoisted(() => ({
  mockAdapter: {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
  } satisfies Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>,
  mockRequestRepo: {
    createApprovalRequest: vi.fn(),
    getApprovalRequestByPublicId: vi.fn(),
    updateApprovalRequestStatus: vi.fn(),
    listApprovalRequests: vi.fn(),
  },
  mockApprovalRepo: {
    createApproval: vi.fn(),
    getApprovalById: vi.fn(),
    listApprovalsForRequest: vi.fn(),
    updateApproval: vi.fn(),
  },
  mockGrantRepo: {
    createElevationGrant: vi.fn(),
    listElevationGrantsForRequest: vi.fn(),
    updateElevationGrantStatus: vi.fn(),
  },
}));

const { mockAppendApprovalTransportEvent, mockLoadApprovalTransportDetail } = vi.hoisted(() => ({
  mockAppendApprovalTransportEvent: vi.fn(),
  mockLoadApprovalTransportDetail: vi.fn(),
}));

const { mockDispatchApprovalNotification } = vi.hoisted(() => ({
  mockDispatchApprovalNotification: vi.fn(),
}));

const { mockIssueApprovalCompletionArtifact } = vi.hoisted(() => ({
  mockIssueApprovalCompletionArtifact: vi.fn(),
}));

const { mockAuditAdminSensitiveRead } = vi.hoisted(() => ({
  mockAuditAdminSensitiveRead: vi.fn(),
}));

const { mockWriteAdminAuditLog } = vi.hoisted(() => ({
  mockWriteAdminAuditLog: vi.fn(),
}));

const { mockCreateElevationGrantSubjectToken } = vi.hoisted(() => ({
  mockCreateElevationGrantSubjectToken: vi.fn(),
}));

const { mockGetRequestAwareIssuerUrl } = vi.hoisted(() => ({
  mockGetRequestAwareIssuerUrl: vi.fn(),
}));

const { mockGetTenantSettings } = vi.hoisted(() => ({
  mockGetTenantSettings: vi.fn(),
}));

const { mockResolveApprovalStepGuide } = vi.hoisted(() => ({
  mockResolveApprovalStepGuide: vi.fn(),
}));

const { mockListApprovalDecisionReceiptsForEvidence } = vi.hoisted(() => ({
  mockListApprovalDecisionReceiptsForEvidence: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ADMIN_PERMISSIONS: {
      ...actual.ADMIN_PERMISSIONS,
      APPROVALS_GRANT_ISSUE: 'admin:approvals:grant:issue',
    },
    adminAuthMiddleware:
      vi.fn((options?: { requirePermissions?: string[] }) =>
        async (c: any, next: () => Promise<void>) => {
          const permissions = (c.req.header('X-Admin-Permissions') || '')
            .split(',')
            .map((value: string) => value.trim())
            .filter(Boolean);
          c.set('adminAuth', {
            userId: 'admin-1',
            authMethod: 'session',
            tenantId: 'tenant-a',
            permissions,
            roles: ['tenant_admin'],
            hierarchyLevel: 50,
            mfaVerified: true,
          });

          if (options?.requirePermissions?.length) {
            const hasAll = options.requirePermissions.every((required) =>
              actual.hasAdminPermission(permissions, required)
            );
            if (!hasAll) {
              return c.json(
                {
                  error: 'insufficient_permissions',
                  error_description:
                    'You do not have the required permissions for this operation.',
                },
                403
              );
            }
          }

          await next();
        }
      ),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    ensureDatabaseAdapter: vi.fn(() => mockAdapter),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    getTenantSettings: mockGetTenantSettings,
    ApprovalRequestRepository: vi.fn(function MockApprovalRequestRepository() {
      return mockRequestRepo;
    }),
    ApprovalRequestApprovalRepository: vi.fn(function MockApprovalRequestApprovalRepository() {
      return mockApprovalRepo;
    }),
    ElevationGrantRepository: vi.fn(function MockElevationGrantRepository() {
      return mockGrantRepo;
    }),
    createElevationGrantSubjectToken: mockCreateElevationGrantSubjectToken,
    ELEVATION_GRANT_SUBJECT_TOKEN_TYPE: 'urn:authrim:token-type:elevation-grant',
  };
});

vi.mock('../approval-transport-detail', () => ({
  appendApprovalTransportEvent: mockAppendApprovalTransportEvent,
  loadApprovalTransportDetail: mockLoadApprovalTransportDetail,
}));

vi.mock('../approval-notification-dispatch', () => ({
  dispatchApprovalNotification: mockDispatchApprovalNotification,
}));

vi.mock('../approval-completion-artifact', () => ({
  issueApprovalCompletionArtifact: mockIssueApprovalCompletionArtifact,
}));

vi.mock('../admin-elevation-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-elevation-access')>();
  return {
    ...actual,
    auditAdminSensitiveRead: mockAuditAdminSensitiveRead,
  };
});

vi.mock('../admin-shared', () => ({
  writeAdminAuditLog: mockWriteAdminAuditLog,
}));

vi.mock('../request-issuer', () => ({
  getRequestAwareIssuerUrl: mockGetRequestAwareIssuerUrl,
}));

vi.mock('../approval-step-guide', () => ({
  resolveApprovalStepGuide: mockResolveApprovalStepGuide,
}));

vi.mock('../approval-decision-receipt-tracking', () => ({
  listApprovalDecisionReceiptsForEvidence: mockListApprovalDecisionReceiptsForEvidence,
}));

import { adminManagementRouter } from '../routes/admin-management';

const mockEnv = {
  DB_ADMIN: {},
  DB: {},
} as unknown as Env;

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin', adminManagementRouter);
  return app;
}

describe('admin approvals router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestRepo.listApprovalRequests.mockResolvedValue([]);
    mockRequestRepo.getApprovalRequestByPublicId.mockResolvedValue(null);
    mockRequestRepo.updateApprovalRequestStatus.mockResolvedValue(null);
    mockApprovalRepo.listApprovalsForRequest.mockResolvedValue([]);
    mockGrantRepo.listElevationGrantsForRequest.mockResolvedValue([]);
    mockGetTenantSettings.mockResolvedValue(null);
    mockAppendApprovalTransportEvent.mockImplementation(async (_c, _adapter, _repo, request) => request);
    mockLoadApprovalTransportDetail.mockResolvedValue(null);
    mockListApprovalDecisionReceiptsForEvidence.mockResolvedValue([]);
    mockDispatchApprovalNotification.mockResolvedValue({
      success: true,
      method: 'portal_confirm',
      transportChannel: 'portal_confirm',
      summary: {
        provider: 'authrim.portal_confirm',
        delivery_status: 'recorded',
        target: 'admin-2',
        correlation_id: 'corr-1',
        transport_request_id: 'transport-1',
      },
      detail: {
        request: { channel: 'portal_confirm' },
        response: { status: 'recorded' },
        metadata: { attempt: 1 },
      },
    });
    mockIssueApprovalCompletionArtifact.mockResolvedValue({
      artifact_id: 'apc_1',
      tenant_id: 'tenant-a',
      request_id: 'apr_public_1',
      approval_id: 'step-1',
      step_key: 'operator-1',
      investigation_id: 'inv_test_1',
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
      expires_at: Date.now() + 300_000,
      created_at: Date.now(),
      consumed: false,
    });
    mockAuditAdminSensitiveRead.mockResolvedValue(undefined);
    mockGetRequestAwareIssuerUrl.mockReturnValue('https://auth.example.com');
    mockCreateElevationGrantSubjectToken.mockResolvedValue({
      subjectToken: 'subject-token-jwt',
      subjectTokenType: 'urn:authrim:token-type:elevation-grant',
      expiresIn: 300,
      authorizationDetails: [{ type: 'authrim_break_glass', grant_id: 'egr_public_1' }],
      jti: 'subject-jti-1',
    });
    mockResolveApprovalStepGuide.mockResolvedValue({
      request_id: 'apr_public_1',
      approval_id: 'step-1',
      step_key: 'operator-1',
      status: 'pending',
      expires_at: Date.now() + 60_000,
      selection_source: 'approval_step',
      resolution_error: null,
      guide: {
        mode: 'artifact_only',
        method: 'portal_confirm',
        transport_channel: 'Authrim approval portal',
        acceptable_methods: ['portal_confirm', 'passkey'],
        guidance_title: 'Review And Confirm In Portal',
        guidance_body:
          'Review the request details on this page and choose Approve or Deny directly in the portal.',
        fallback_note:
          'If this method is unavailable, re-issue the approval artifact with one of: passkey.',
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects create without approvals write permission', async () => {
    const app = createApp();

    const res = await app.request(
      '/api/admin/approvals',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:read',
        },
        body: JSON.stringify({
          target_subject_type: 'user',
          target_subject_id: 'user-1',
          request_surface: 'admin_audit',
          requested_action: 'detail_read',
          resource_class: 'admin_audit_detail',
          reason_code: 'support_case',
          policy_preset: 'support_case_default',
          approvals: [
            {
              step_key: 'operator-1',
              side: 'admin_operator',
              subject_type: 'admin_user',
              subject_id: 'admin-2',
            },
          ],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(403);
    expect(mockRequestRepo.createApprovalRequest).not.toHaveBeenCalled();
  });

  it('creates an approval request and normalizes string reference ids', async () => {
    const app = createApp();
    mockRequestRepo.createApprovalRequest.mockResolvedValue({
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'user',
      target_subject_id: 'user-1',
      request_surface: 'admin_audit',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: {
        version: 1,
        surface: 'admin_audit',
        action: 'detail_read',
        tenant_id: 'tenant-a',
        resource_class: 'admin_audit_detail',
        resource_ids: ['user-1'],
      },
      scope_canonical:
        '{"version":1,"surface":"admin_audit","action":"detail_read","tenant_id":"tenant-a","resource_class":"admin_audit_detail","resource_ids":["user-1"]}',
      reason_code: 'support_case',
      reason_note: null,
      reference: { system: 'external', id: 'case-123' },
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'pending',
      expires_at: Date.now() + 60_000,
      decided_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    mockApprovalRepo.createApproval.mockResolvedValue({
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
      last_notification_action: null,
      last_notified_at: null,
      notification_count: 0,
      decided_at: null,
      expires_at: Date.now() + 60_000,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    mockApprovalRepo.listApprovalsForRequest.mockResolvedValue([
      {
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
        last_notified_at: Date.now() + 1,
        notification_count: 1,
        decided_at: null,
        expires_at: Date.now() + 60_000,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]);

    const res = await app.request(
      '/api/admin/approvals',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:write',
        },
        body: JSON.stringify({
          target_subject_type: 'user',
          target_subject_id: 'user-1',
          request_surface: 'admin_audit',
          requested_action: 'detail_read',
          resource_class: 'admin_audit_detail',
          reason_code: 'support_case',
          reference_id: 'case-123',
          policy_preset: 'support_case_default',
          approvals: [
            {
              step_key: 'operator-1',
              side: 'admin_operator',
              subject_type: 'admin_user',
              subject_id: 'admin-2',
            },
          ],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    expect(mockRequestRepo.createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        requester_subject_id: 'admin-1',
        reason_code: 'support_case',
        reference: expect.objectContaining({ system: 'external', id: 'case-123' }),
        policy_preset: 'support_case_default',
      })
    );
    expect(mockApprovalRepo.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'portal_confirm',
        transport_channel: 'portal_confirm',
      })
    );
    expect(mockDispatchApprovalNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'initial',
        approval: expect.objectContaining({
          step_key: 'operator-1',
          method: 'portal_confirm',
          transport_channel: 'portal_confirm',
        }),
      })
    );
    expect(mockAppendApprovalTransportEvent).toHaveBeenCalledWith(
      expect.anything(),
      mockAdapter,
      mockRequestRepo,
      expect.objectContaining({ public_request_id: 'apr_public_1' }),
      expect.objectContaining({ kind: 'request_created' })
    );
    expect(mockGrantRepo.createElevationGrant).not.toHaveBeenCalled();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.public_request_id).toBe('apr_public_1');
    expect(body.approvals).toHaveLength(1);
    expect(body.grants).toEqual([]);
    expect(body.notification_results).toEqual([
      expect.objectContaining({
        action: 'initial',
        method: 'portal_confirm',
        success: true,
      }),
    ]);
  });

  it('auto-resolves customer data owner approvals to the target user', async () => {
    const app = createApp();
    mockRequestRepo.createApprovalRequest.mockResolvedValue({
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'user',
      target_subject_id: 'user-42',
      request_surface: 'admin_audit',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: {
        version: 1,
        surface: 'admin_audit',
        action: 'detail_read',
        tenant_id: 'tenant-a',
        resource_class: 'admin_audit_detail',
        resource_ids: ['user-42'],
      },
      scope_canonical: '{}',
      reason_code: 'support_case',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'pending',
      expires_at: Date.now() + 60_000,
      decided_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    mockApprovalRepo.createApproval.mockImplementation(async (input) => ({
      id: `step-${input.step_key}`,
      approval_request_id: input.approval_request_id,
      step_key: input.step_key,
      side: input.side,
      subject_type: input.subject_type,
      subject_id: input.subject_id ?? null,
      relation_type: input.relation_type ?? null,
      relation_source: input.relation_source ?? null,
      status: 'pending',
      method: input.method ?? null,
      transport_channel: input.transport_channel ?? null,
      reason_code: null,
      reason_note: null,
      last_notification_action: null,
      last_notified_at: null,
      notification_count: 0,
      requested_at: Date.now(),
      decided_at: null,
      expires_at: input.expires_at,
      created_at: Date.now(),
      updated_at: Date.now(),
    }));

    const res = await app.request(
      '/api/admin/approvals',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:write',
        },
        body: JSON.stringify({
          target_subject_type: 'user',
          target_subject_id: 'user-42',
          request_surface: 'admin_audit',
          requested_action: 'detail_read',
          resource_class: 'admin_audit_detail',
          reason_code: 'support_case',
          policy_preset: 'support_case_default',
          approvals: [
            {
              step_key: 'owner-1',
              side: 'customer_data_owner',
              subject_type: 'end_user',
            },
          ],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    expect(mockApprovalRepo.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        step_key: 'owner-1',
        side: 'customer_data_owner',
        subject_type: 'end_user',
        subject_id: 'user-42',
        relation_source: 'target_subject',
      })
    );
  });

  it('auto-resolves verified email transport for customer data owner OTP approvals', async () => {
    const app = createApp();
    mockRequestRepo.createApprovalRequest.mockResolvedValue({
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'user',
      target_subject_id: 'user-42',
      request_surface: 'admin_audit',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: {
        version: 1,
        surface: 'admin_audit',
        action: 'detail_read',
        tenant_id: 'tenant-a',
        resource_class: 'admin_audit_detail',
        resource_ids: ['user-42'],
      },
      scope_canonical: '{}',
      reason_code: 'support_case',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'pending',
      expires_at: Date.now() + 60_000,
      decided_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    mockAdapter.queryOne
      .mockResolvedValueOnce({
        pii_partition: 'default',
        email_verified: 1,
        phone_number_verified: 0,
      })
      .mockResolvedValueOnce({
        email: 'owner@example.com',
        phone_number: null,
      });
    mockApprovalRepo.createApproval.mockImplementation(async (input) => ({
      id: `step-${input.step_key}`,
      approval_request_id: input.approval_request_id,
      step_key: input.step_key,
      side: input.side,
      subject_type: input.subject_type,
      subject_id: input.subject_id ?? null,
      relation_type: input.relation_type ?? null,
      relation_source: input.relation_source ?? null,
      status: 'pending',
      method: input.method ?? null,
      transport_channel: input.transport_channel ?? null,
      reason_code: null,
      reason_note: null,
      last_notification_action: null,
      last_notified_at: null,
      notification_count: 0,
      requested_at: Date.now(),
      decided_at: null,
      expires_at: input.expires_at,
      created_at: Date.now(),
      updated_at: Date.now(),
    }));
    mockApprovalRepo.listApprovalsForRequest.mockResolvedValue([
      {
        id: 'step-owner-otp',
        approval_request_id: 'req-1',
        step_key: 'owner-otp',
        side: 'customer_data_owner',
        subject_type: 'end_user',
        subject_id: 'user-42',
        relation_type: null,
        relation_source: 'target_subject',
        status: 'pending',
        method: 'email_otp',
        transport_channel: 'owner@example.com',
        reason_code: null,
        reason_note: null,
        last_notification_action: 'initial',
        last_notified_at: Date.now(),
        notification_count: 1,
        decided_at: null,
        expires_at: Date.now() + 60_000,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]);
    mockDispatchApprovalNotification.mockResolvedValueOnce({
      success: true,
      method: 'email_otp',
      transportChannel: 'owner@example.com',
      summary: {
        provider: 'notifier.email',
        delivery_status: 'queued',
        target: 'owner@example.com',
        correlation_id: 'corr-owner-otp',
        transport_request_id: 'transport-owner-otp',
      },
      detail: {
        request: { channel: 'email', to: 'owner@example.com' },
        response: { status: 'queued' },
        metadata: { attempt: 1 },
      },
    });

    const res = await app.request(
      '/api/admin/approvals',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:write',
        },
        body: JSON.stringify({
          target_subject_type: 'user',
          target_subject_id: 'user-42',
          request_surface: 'admin_audit',
          requested_action: 'detail_read',
          resource_class: 'admin_audit_detail',
          reason_code: 'support_case',
          policy_preset: 'support_case_default',
          approvals: [
            {
              step_key: 'owner-otp',
              side: 'customer_data_owner',
              subject_type: 'end_user',
              method: 'email_otp',
            },
          ],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    expect(mockApprovalRepo.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        subject_id: 'user-42',
        method: 'email_otp',
        transport_channel: 'owner@example.com',
      })
    );
    expect(mockDispatchApprovalNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        transportChannel: 'owner@example.com',
      })
    );
  });

  it('previews resolved OTP transport for customer data owner steps', async () => {
    const app = createApp();
    mockAdapter.queryOne
      .mockResolvedValueOnce({
        pii_partition: 'default',
        email_verified: 1,
        phone_number_verified: 0,
      })
      .mockResolvedValueOnce({
        email: 'owner@example.com',
        phone_number: null,
      });

    const res = await app.request(
      '/api/admin/approvals/preview',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:write',
        },
        body: JSON.stringify({
          target_subject_type: 'user',
          target_subject_id: 'user-42',
          request_surface: 'admin_audit',
          requested_action: 'detail_read',
          resource_class: 'admin_audit_detail',
          reason_code: 'support_case',
          policy_preset: 'support_case_default',
          approvals: [
            {
              step_key: 'owner-otp',
              side: 'customer_data_owner',
              subject_type: 'end_user',
              method: 'email_otp',
            },
          ],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      request: {
        target_subject_id: string;
        resolved_policy?: {
          preset: string;
          request_ttl_seconds: number | null;
          notification_cooldown_seconds?: { remind: number; resend: number };
        };
      };
      steps: Array<{
        step_key: string;
        subject_id: string | null;
        method: string | null;
        transport_channel: string | null;
        acceptable_methods: string[];
        guidance_title?: string | null;
        fallback_note?: string | null;
      }>;
    };
    expect(payload.request.target_subject_id).toBe('user-42');
    expect(payload.request.resolved_policy).toEqual(
      expect.objectContaining({
        preset: 'support_case_default',
        request_ttl_seconds: 15 * 60,
        notification_cooldown_seconds: {
          remind: 5 * 60,
          resend: 10 * 60,
        },
      })
    );
    expect(payload.steps).toEqual([
      expect.objectContaining({
        step_key: 'owner-otp',
        subject_id: 'user-42',
        method: 'email_otp',
        transport_channel: 'owner@example.com',
        acceptable_methods: expect.arrayContaining(['email_otp']),
        guidance_title: 'Approve With Email Code',
        fallback_note: expect.stringContaining('ciba'),
      }),
    ]);
  });

  it('defaults customer profile approvals to the product protected resource audience', async () => {
    const app = createApp();

    const res = await app.request(
      '/api/admin/approvals/preview',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:write',
        },
        body: JSON.stringify({
          target_subject_type: 'user',
          target_subject_id: 'user-42',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          reason_code: 'technical_debug',
          policy_preset: 'technical_debug_default',
          approvals: [
            {
              step_key: 'operator',
              side: 'admin_operator',
              subject_type: 'admin_user',
              subject_id: 'admin-2',
            },
          ],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      request: {
        scope_json: {
          resource_class: string;
          resource_ids: string[];
          detail_classes: string[];
          audience?: string | null;
        };
      };
    };
    expect(payload.request.scope_json).toEqual(
      expect.objectContaining({
        resource_class: 'customer_profile',
        resource_ids: ['user-42'],
        detail_classes: ['profile_export'],
        audience: 'svc://op-userinfo/customer-profile',
      })
    );
  });

  it('expands guardian delegate approvals from active relationships', async () => {
    const app = createApp();
    mockRequestRepo.createApprovalRequest.mockResolvedValue({
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'user',
      target_subject_id: 'child-7',
      request_surface: 'admin_audit',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: {
        version: 1,
        surface: 'admin_audit',
        action: 'detail_read',
        tenant_id: 'tenant-a',
        resource_class: 'admin_audit_detail',
        resource_ids: ['child-7'],
      },
      scope_canonical: '{}',
      reason_code: 'support_case',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'guardian_support_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'pending',
      expires_at: Date.now() + 60_000,
      decided_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    mockAdapter.query.mockResolvedValueOnce([
      { relationship_type: 'guardian', from_id: 'guardian-1' },
      { relationship_type: 'delegate', from_id: 'delegate-2' },
    ]);
    mockApprovalRepo.createApproval.mockImplementation(async (input) => ({
      id: `step-${input.step_key}`,
      approval_request_id: input.approval_request_id,
      step_key: input.step_key,
      side: input.side,
      subject_type: input.subject_type,
      subject_id: input.subject_id ?? null,
      relation_type: input.relation_type ?? null,
      relation_source: input.relation_source ?? null,
      status: 'pending',
      method: input.method ?? null,
      transport_channel: input.transport_channel ?? null,
      reason_code: null,
      reason_note: null,
      last_notification_action: null,
      last_notified_at: null,
      notification_count: 0,
      requested_at: Date.now(),
      decided_at: null,
      expires_at: input.expires_at,
      created_at: Date.now(),
      updated_at: Date.now(),
    }));

    const res = await app.request(
      '/api/admin/approvals',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:write',
        },
        body: JSON.stringify({
          target_subject_type: 'user',
          target_subject_id: 'child-7',
          request_surface: 'admin_audit',
          requested_action: 'detail_read',
          resource_class: 'admin_audit_detail',
          reason_code: 'support_case',
          policy_preset: 'guardian_support_default',
          approvals: [
            {
              step_key: 'guardian',
              side: 'guardian_delegate',
              subject_type: 'customer_delegate',
            },
          ],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    expect(mockApprovalRepo.createApproval).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        step_key: 'guardian:1',
        side: 'guardian_delegate',
        subject_type: 'customer_delegate',
        subject_id: 'guardian-1',
        relation_type: 'guardian',
        relation_source: 'rebac_relation',
      })
    );
    expect(mockApprovalRepo.createApproval).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        step_key: 'guardian:2',
        side: 'guardian_delegate',
        subject_type: 'customer_delegate',
        subject_id: 'delegate-2',
        relation_type: 'care_delegate',
        relation_source: 'rebac_relation',
      })
    );
  });

  it('previews guardian delegate expansion from active relationships', async () => {
    const app = createApp();
    mockAdapter.query.mockResolvedValueOnce([
      { relationship_type: 'guardian', from_id: 'guardian-1' },
      { relationship_type: 'delegate', from_id: 'delegate-2' },
    ]);

    const res = await app.request(
      '/api/admin/approvals/preview',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:write',
        },
        body: JSON.stringify({
          target_subject_type: 'user',
          target_subject_id: 'child-7',
          request_surface: 'admin_audit',
          requested_action: 'detail_read',
          resource_class: 'admin_audit_detail',
          reason_code: 'support_case',
          policy_preset: 'guardian_support_default',
          approvals: [
            {
              step_key: 'guardian',
              side: 'guardian_delegate',
              subject_type: 'customer_delegate',
            },
          ],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      steps: Array<{
        step_key: string;
        subject_id: string | null;
        relation_type: string | null;
        relation_source: string | null;
      }>;
    };
    expect(payload.steps).toEqual([
      expect.objectContaining({
        step_key: 'guardian:1',
        subject_id: 'guardian-1',
        relation_type: 'guardian',
        relation_source: 'rebac_relation',
      }),
      expect.objectContaining({
        step_key: 'guardian:2',
        subject_id: 'delegate-2',
        relation_type: 'care_delegate',
        relation_source: 'rebac_relation',
      }),
    ]);
  });

  it('issues an approval completion artifact for a pending step', async () => {
    const app = createApp();
    mockRequestRepo.getApprovalRequestByPublicId.mockResolvedValue({
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
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
        resource_ids: ['user-1'],
      },
      scope_canonical: '{}',
      reason_code: 'support_case',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      expires_at: Date.now() + 60_000,
      decided_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    mockApprovalRepo.getApprovalById.mockResolvedValue({
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
    });
    mockApprovalRepo.listApprovalsForRequest.mockResolvedValue([]);

    const res = await app.request(
      '/api/admin/approvals/apr_public_1/steps/step-1/artifacts',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:write',
        },
        body: JSON.stringify({ method: 'portal_confirm' }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as any;
    expect(payload.artifact.artifact_id).toBe('apc_1');
    expect(payload.completion_requirements).toMatchObject({
      method: 'portal_confirm',
      acceptable_methods: ['portal_confirm', 'passkey', 'reauth'],
      transport_channel: 'Authrim approval portal',
      guidance_title: 'Review And Confirm In Portal',
      portal_path: '/api/approval-artifacts/apc_1/portal',
    });
    expect(mockIssueApprovalCompletionArtifact).toHaveBeenCalled();
    expect(mockAppendApprovalTransportEvent).toHaveBeenCalledWith(
      expect.anything(),
      mockAdapter,
      mockRequestRepo,
      expect.objectContaining({ public_request_id: 'apr_public_1' }),
      expect.objectContaining({ kind: 'step_artifact_issued' })
    );
  });

  it('dispatches initial notifications for approval steps with a configured method', async () => {
    const app = createApp();
    const now = Date.now();
    mockRequestRepo.createApprovalRequest.mockResolvedValue({
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'user',
      target_subject_id: 'user-1',
      request_surface: 'admin_audit',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: {
        version: 1,
        surface: 'admin_audit',
        action: 'detail_read',
        tenant_id: 'tenant-a',
        resource_class: 'admin_audit_detail',
        resource_ids: ['user-1'],
      },
      scope_canonical: '{"version":1}',
      reason_code: 'support_case',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'pending',
      expires_at: now + 60_000,
      decided_at: null,
      created_at: now,
      updated_at: now,
    });
    mockApprovalRepo.createApproval.mockResolvedValue({
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
      last_notification_action: null,
      last_notified_at: null,
      notification_count: 0,
      decided_at: null,
      expires_at: now + 60_000,
      created_at: now,
      updated_at: now,
    });
    mockApprovalRepo.updateApproval.mockResolvedValue({
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
      reason_code: 'support_case',
      reason_note: null,
      last_notification_action: 'initial',
      last_notified_at: now + 1000,
      notification_count: 1,
      decided_at: null,
      expires_at: now + 60_000,
      created_at: now,
      updated_at: now + 1000,
    });
    mockApprovalRepo.listApprovalsForRequest.mockResolvedValue([
      {
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
        reason_code: 'support_case',
        reason_note: null,
        last_notification_action: 'initial',
        last_notified_at: now + 1000,
        notification_count: 1,
        decided_at: null,
        expires_at: now + 60_000,
        created_at: now,
        updated_at: now + 1000,
      },
    ]);

    const res = await app.request(
      '/api/admin/approvals',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:write',
        },
        body: JSON.stringify({
          target_subject_type: 'user',
          target_subject_id: 'user-1',
          request_surface: 'admin_audit',
          requested_action: 'detail_read',
          resource_class: 'admin_audit_detail',
          reason_code: 'support_case',
          policy_preset: 'support_case_default',
          approvals: [
            {
              step_key: 'operator-1',
              side: 'admin_operator',
              subject_type: 'admin_user',
              subject_id: 'admin-2',
              method: 'portal_confirm',
              transport_channel: 'portal_confirm',
            },
          ],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    expect(mockDispatchApprovalNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'initial',
        approval: expect.objectContaining({
          id: 'step-1',
          method: 'portal_confirm',
        }),
      })
    );
    expect(mockAppendApprovalTransportEvent).toHaveBeenCalledWith(
      expect.anything(),
      mockAdapter,
      mockRequestRepo,
      expect.objectContaining({ public_request_id: 'apr_public_1' }),
      expect.objectContaining({
        kind: 'step_initial',
        notificationAction: 'initial',
        notificationCount: 1,
      })
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.notification_results).toEqual([
      expect.objectContaining({
        action: 'initial',
        success: true,
        method: 'portal_confirm',
      }),
    ]);
  });

  it('issues a downstream grant subject token for an active elevation grant', async () => {
    const app = createApp();
    const actual = await vi.importActual<typeof import('@authrim/ar-lib-core')>(
      '@authrim/ar-lib-core'
    );
    const keySet = await actual.generateKeySet('approval-subject-kid-1');
    const request = {
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'user',
      target_subject_id: 'user-1',
      request_surface: 'service_data',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: {
        version: 1,
        surface: 'service_data',
        action: 'detail_read',
        tenant_id: 'tenant-a',
        resource_class: 'customer_profile',
        resource_ids: ['user-1'],
        detail_classes: ['profile_export'],
        audience: 'svc://customer-portal',
      },
      scope_canonical: '{}',
      reason_code: 'technical_debug',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'technical_debug_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'approved',
      expires_at: Date.now() + 600_000,
      decided_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
      detail_object_catalog_id: null,
    };
    const grant = {
      id: 'grant-1',
      public_grant_id: 'egr_public_1',
      approval_request_id: 'req-1',
      tenant_id: 'tenant-a',
      status: 'active',
      target_audience: 'admin_api',
      resource_class: 'customer_profile',
      redaction_level: 'masked',
      scope_canonical: '{}',
      scope_json: request.scope_json,
      authorization_details_json: null,
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      actor_subject_type: 'admin_user',
      actor_subject_id: 'admin-1',
      issued_at: Date.now(),
      expires_at: Date.now() + 300_000,
      revoked_at: null,
      revoke_reason: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    mockRequestRepo.getApprovalRequestByPublicId.mockResolvedValue(request);
    mockGrantRepo.listElevationGrantsForRequest.mockResolvedValue([grant]);
    mockCreateElevationGrantSubjectToken.mockResolvedValueOnce({
      subjectToken: 'subject-token-jwt',
      subjectTokenType: 'urn:authrim:token-type:elevation-grant',
      expiresIn: 180,
      authorizationDetails: [{ type: 'authrim_break_glass', grant_id: 'egr_public_1' }],
      jti: 'subject-jti-1',
    });
    const requestEnv = {
      ...mockEnv,
      ENVIRONMENT: 'test',
      ISSUER_URL: 'https://auth.example.com',
      KEY_MANAGER_SECRET: 'test-key-manager-secret',
      AUTHRIM_CONFIG: {
        get: vi.fn().mockResolvedValue(null),
      },
      KEY_MANAGER: {
        idFromName: vi.fn().mockImplementation((name: string) => ({
          toString: () => name,
        })),
        get: vi.fn().mockReturnValue({
          getActiveKeyWithPrivateRpc: vi.fn().mockResolvedValue({
            kid: 'approval-subject-kid-1',
            privatePEM: keySet.privatePEM,
          }),
          rotateKeysWithPrivateRpc: vi.fn().mockResolvedValue({
            kid: 'approval-subject-kid-1',
            privatePEM: keySet.privatePEM,
          }),
          getAllPublicKeysRpc: vi.fn().mockResolvedValue([keySet.publicJWK]),
        }),
      },
    } as unknown as Env;

    const res = await app.request(
      '/api/admin/approvals/apr_public_1/grants/egr_public_1/subject-token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:grant:issue',
        },
        body: JSON.stringify({
          client_id: 'svc-client-1',
          expires_in: 180,
        }),
      },
      requestEnv
    );

    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    if (mockCreateElevationGrantSubjectToken.mock.calls.length > 0) {
      expect(mockCreateElevationGrantSubjectToken).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-a',
          clientId: 'svc-client-1',
          request,
          grant,
          expiresInSeconds: 180,
        })
      );
    }
    expect(body.subject_token).toEqual(expect.any(String));
    expect(body.subject_token_type).toBe('urn:authrim:token-type:elevation-grant');
    expect(body.expires_in).toBe(180);
    expect(body.token_exchange_hint).toEqual(
      expect.objectContaining({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:authrim:token-type:elevation-grant',
        client_id: 'svc-client-1',
      })
    );
    expect(body.integration_hint).toEqual(
      expect.objectContaining({
        token_endpoint: expect.stringContaining('/token'),
        introspection_endpoint: expect.stringContaining('/introspect'),
        subject_token_client_id: 'svc-client-1',
        authorization_defaults: expect.objectContaining({
          required_resource_class: grant.resource_class,
        }),
      })
    );
    expect(mockAppendApprovalTransportEvent).toHaveBeenCalledWith(
      expect.anything(),
      mockAdapter,
      mockRequestRepo,
      request,
      expect.objectContaining({
        kind: 'grant_subject_token_issued',
        actorSubjectType: 'admin_user',
        actorSubjectId: 'admin-1',
        reasonCode: request.reason_code,
        reasonNote: request.reason_note,
        transportSummary: expect.objectContaining({
          provider: 'authrim.elevation_subject_token',
          delivery_status: 'issued',
          target: 'svc-client-1',
          correlation_id: request.investigation_id,
          transport_request_id: 'subject-jti-1',
        }),
        transportDetail: expect.objectContaining({
          metadata: expect.objectContaining({
            approval_grant_subject_token: expect.objectContaining({
              public_grant_id: grant.public_grant_id,
              client_id: 'svc-client-1',
              subject_token_type: 'urn:authrim:token-type:elevation-grant',
              expires_in: 180,
              jti: 'subject-jti-1',
              target_audience: 'svc://customer-portal',
              resource_class: grant.resource_class,
              resource_ids: ['user-1'],
              detail_classes: ['profile_export'],
              redaction_level: grant.redaction_level,
              requires_online_check: false,
              fail_closed: false,
              require_full_access: true,
            }),
          }),
        }),
      })
    );
    expect(mockWriteAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'approval_grant_subject_token_issued',
        resourceType: 'elevation_grant',
        resourceId: grant.public_grant_id,
        result: 'success',
        severity: 'info',
        metadata: expect.objectContaining({
          approval_request_id: request.public_request_id,
          client_id: 'svc-client-1',
          target_audience: 'svc://customer-portal',
          resource_class: grant.resource_class,
          resource_ids: ['user-1'],
          detail_classes: ['profile_export'],
          redaction_level: grant.redaction_level,
          expires_in: 180,
          subject_token_type: 'urn:authrim:token-type:elevation-grant',
          subject_token_jti: 'subject-jti-1',
          requires_online_check: false,
          fail_closed: false,
        }),
      })
    );
  });

  it('revokes an active elevation grant and records transport evidence', async () => {
    const app = createApp();
    const now = Date.now();
    const request = {
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'user',
      target_subject_id: 'user-1',
      request_surface: 'service_data',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: {
        version: 1,
        surface: 'service_data',
        action: 'detail_read',
        tenant_id: 'tenant-a',
        resource_class: 'customer_profile',
        resource_ids: ['profile-1'],
      },
      scope_canonical: '{}',
      reason_code: 'technical_debug',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'technical_debug_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'approved',
      expires_at: now + 600_000,
      decided_at: now - 60_000,
      created_at: now - 120_000,
      updated_at: now - 60_000,
      detail_object_catalog_id: 'catalog-1',
    };
    const grant = {
      id: 'grant-1',
      public_grant_id: 'egr_public_1',
      approval_request_id: 'req-1',
      tenant_id: 'tenant-a',
      status: 'active',
      target_audience: 'svc://customer-portal',
      resource_class: 'customer_profile',
      redaction_level: 'masked',
      scope_canonical: '{}',
      scope_json: request.scope_json,
      authorization_details_json: null,
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      actor_subject_type: 'admin_user',
      actor_subject_id: 'admin-1',
      issued_at: now - 30_000,
      expires_at: now + 300_000,
      revoked_at: null,
      revoke_reason: null,
      created_at: now - 30_000,
      updated_at: now - 30_000,
    };
    const revokedGrant = {
      ...grant,
      status: 'revoked',
      revoked_at: now,
      revoke_reason: 'manual_revoke',
      updated_at: now,
    };

    mockRequestRepo.getApprovalRequestByPublicId.mockResolvedValue(request);
    mockApprovalRepo.listApprovalsForRequest.mockResolvedValue([]);
    mockGrantRepo.listElevationGrantsForRequest.mockResolvedValue([grant]);
    mockGrantRepo.updateElevationGrantStatus.mockResolvedValue(revokedGrant);

    const res = await app.request(
      '/api/admin/approvals/apr_public_1/grants/egr_public_1/revoke',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:grant:issue',
        },
        body: JSON.stringify({
          reason_code: 'manual_revoke',
          reason_note: 'Support case closed',
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockGrantRepo.updateElevationGrantStatus).toHaveBeenCalledWith(
      'grant-1',
      'revoked',
      expect.objectContaining({
        revokeReason: 'manual_revoke',
      })
    );
    expect(mockAppendApprovalTransportEvent).toHaveBeenCalledWith(
      expect.anything(),
      mockAdapter,
      mockRequestRepo,
      request,
      expect.objectContaining({
        kind: 'grant_revoked',
        reasonCode: 'manual_revoke',
        reasonNote: 'Support case closed',
      })
    );
    expect(mockWriteAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'approval_grant_revoked',
        resourceId: 'egr_public_1',
      })
    );
    await expect(res.json()).resolves.toMatchObject({
      grants: [
        expect.objectContaining({
          public_grant_id: 'egr_public_1',
          status: 'revoked',
          revoke_reason: 'manual_revoke',
        }),
      ],
    });
  });

  it('approves a step and updates the request status', async () => {
    const app = createApp();
    const request = {
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'user',
      target_subject_id: 'user-1',
      request_surface: 'admin_audit',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: {
        version: 1,
        surface: 'admin_audit',
        action: 'detail_read',
        tenant_id: 'tenant-a',
        resource_class: 'admin_audit_detail',
        resource_ids: ['user-1'],
      },
      scope_canonical:
        '{"version":1,"surface":"admin_audit","action":"detail_read","tenant_id":"tenant-a","resource_class":"admin_audit_detail","resource_ids":["user-1"]}',
      reason_code: 'support_case',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'pending',
      expires_at: Date.now() + 60_000,
      decided_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const approval = {
      id: 'step-1',
      approval_request_id: 'req-1',
      step_key: 'operator-1',
      side: 'admin_operator',
      subject_type: 'admin_user',
      subject_id: 'admin-2',
      relation_type: null,
      relation_source: null,
      status: 'pending',
      method: null,
      transport_channel: null,
      reason_code: null,
      reason_note: null,
      last_notification_action: 'initial',
      last_notified_at: Date.now() - 60_000,
      notification_count: 1,
      decided_at: null,
      expires_at: Date.now() + 60_000,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    mockRequestRepo.getApprovalRequestByPublicId.mockResolvedValue(request);
    mockApprovalRepo.getApprovalById.mockResolvedValue(approval);
    mockApprovalRepo.listApprovalsForRequest.mockResolvedValue([
      {
        ...approval,
        status: 'approved',
      },
    ]);
    mockGrantRepo.listElevationGrantsForRequest
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'grant-1',
          public_grant_id: 'egr_public_1',
          approval_request_id: 'req-1',
          tenant_id: 'tenant-a',
          status: 'active',
          target_audience: 'admin_api',
          resource_class: 'admin_audit_detail',
          redaction_level: 'masked',
          scope_canonical: '{"version":1}',
          scope_json: {
            version: 1,
            surface: 'admin_audit',
            action: 'detail_read',
            tenant_id: 'tenant-a',
            resource_class: 'admin_audit_detail',
            resource_ids: ['user-1'],
          },
          authorization_details_json: {
            type: 'authrim_break_glass',
          },
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-1',
          actor_subject_type: 'admin_user',
          actor_subject_id: 'admin-1',
          issued_at: Date.now(),
          expires_at: Date.now() + 60_000,
          revoked_at: null,
          revoke_reason: null,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ]);
    mockRequestRepo.updateApprovalRequestStatus.mockResolvedValue({
      ...request,
      status: 'approved',
    });

    const res = await app.request(
      '/api/admin/approvals/apr_public_1/steps/step-1/approve',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:approve',
        },
        body: JSON.stringify({
          method: 'portal_confirm',
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockApprovalRepo.updateApproval).toHaveBeenCalledWith(
      'step-1',
      expect.objectContaining({
        status: 'approved',
        method: 'portal_confirm',
      })
    );
    expect(mockRequestRepo.updateApprovalRequestStatus).toHaveBeenCalledWith(
      'req-1',
      'approved'
    );
    expect(mockGrantRepo.createElevationGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        approval_request_id: 'req-1',
        target_audience: 'admin_api',
        resource_class: 'admin_audit_detail',
      })
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('approved');
    expect(body.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          public_grant_id: 'egr_public_1',
        }),
      ])
    );
  });

  it('rejects support operation self-approval unless tenant policy allows it', async () => {
    const app = createApp();
    const request = {
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'tenant_resource',
      target_subject_id: 'cohort-1',
      request_surface: 'support_ops',
      requested_action: 'support_action.suspend',
      redaction_level: 'summary_only',
      scope_json: {
        version: 1,
        surface: 'support_ops',
        action: 'support_action.suspend',
        tenant_id: 'tenant-a',
        resource_class: 'support_operation_cohort',
        resource_ids: ['cohort-1'],
      },
      scope_canonical: '{"version":1}',
      reason_code: 'support_ops_action_request',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'pending',
      expires_at: Date.now() + 60_000,
      decided_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const approval = {
      id: 'step-1',
      approval_request_id: 'req-1',
      step_key: 'support-ops-approval',
      side: 'admin_operator',
      subject_type: 'admin_user',
      subject_id: null,
      relation_type: null,
      relation_source: 'support_ops_policy',
      status: 'pending',
      method: null,
      transport_channel: null,
      reason_code: null,
      reason_note: null,
      last_notification_action: 'initial',
      last_notified_at: Date.now() - 60_000,
      notification_count: 1,
      decided_at: null,
      expires_at: Date.now() + 60_000,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    mockRequestRepo.getApprovalRequestByPublicId.mockResolvedValue(request);
    mockApprovalRepo.getApprovalById.mockResolvedValue(approval);

    const res = await app.request(
      '/api/admin/approvals/apr_public_1/steps/step-1/approve',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:approve',
        },
        body: JSON.stringify({
          method: 'portal_confirm',
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'self_approval_not_allowed',
    });
    expect(mockGetTenantSettings).toHaveBeenCalledWith(
      mockEnv.SETTINGS,
      'tenant-a',
      'support-ops'
    );
    expect(mockApprovalRepo.updateApproval).not.toHaveBeenCalled();
    expect(mockRequestRepo.updateApprovalRequestStatus).not.toHaveBeenCalled();
  });

  it('captures the approving admin on unassigned support operation approval steps', async () => {
    const app = createApp();
    const request = {
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-2',
      target_subject_type: 'tenant_resource',
      target_subject_id: 'cohort-1',
      request_surface: 'support_ops',
      requested_action: 'support_action.suspend',
      redaction_level: 'summary_only',
      scope_json: {
        version: 1,
        surface: 'support_ops',
        action: 'support_action.suspend',
        tenant_id: 'tenant-a',
        resource_class: 'support_operation_cohort',
        resource_ids: ['cohort-1'],
      },
      scope_canonical: '{"version":1}',
      reason_code: 'support_ops_action_request',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'pending',
      expires_at: Date.now() + 60_000,
      decided_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const approval = {
      id: 'step-1',
      approval_request_id: 'req-1',
      step_key: 'support-ops-approval',
      side: 'admin_operator',
      subject_type: 'admin_user',
      subject_id: null,
      relation_type: null,
      relation_source: 'support_ops_policy',
      status: 'pending',
      method: null,
      transport_channel: null,
      reason_code: null,
      reason_note: null,
      last_notification_action: 'initial',
      last_notified_at: Date.now() - 60_000,
      notification_count: 1,
      decided_at: null,
      expires_at: Date.now() + 60_000,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    mockRequestRepo.getApprovalRequestByPublicId.mockResolvedValue(request);
    mockApprovalRepo.getApprovalById.mockResolvedValue(approval);
    mockApprovalRepo.updateApproval.mockResolvedValue({
      ...approval,
      status: 'approved',
      subject_id: 'admin-1',
    });
    mockApprovalRepo.listApprovalsForRequest.mockResolvedValue([
      {
        ...approval,
        status: 'approved',
        subject_id: 'admin-1',
      },
    ]);
    mockRequestRepo.updateApprovalRequestStatus.mockResolvedValue({
      ...request,
      status: 'approved',
    });
    mockGrantRepo.listElevationGrantsForRequest.mockResolvedValue([]);

    const res = await app.request(
      '/api/admin/approvals/apr_public_1/steps/step-1/approve',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:approve',
        },
        body: JSON.stringify({
          method: 'portal_confirm',
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockApprovalRepo.updateApproval).toHaveBeenCalledWith(
      'step-1',
      expect.objectContaining({
        status: 'approved',
        subject_id: 'admin-1',
      })
    );
  });

  it('reminds a pending approval step and increments notification summary', async () => {
    const app = createApp();
    const request = {
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'user',
      target_subject_id: 'user-1',
      request_surface: 'admin_audit',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: {
        version: 1,
        surface: 'admin_audit',
        action: 'detail_read',
        tenant_id: 'tenant-a',
        resource_class: 'admin_audit_detail',
        resource_ids: ['user-1'],
      },
      scope_canonical: '{"version":1}',
      reason_code: 'support_case',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'pending',
      expires_at: Date.now() + 60_000,
      decided_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const approval = {
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
      transport_channel: null,
      reason_code: null,
      reason_note: null,
      last_notification_action: 'initial',
      last_notified_at: Date.now() - 10 * 60 * 1000,
      notification_count: 1,
      decided_at: null,
      expires_at: Date.now() + 60_000,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    mockRequestRepo.getApprovalRequestByPublicId.mockResolvedValue(request);
    mockApprovalRepo.getApprovalById.mockResolvedValue(approval);
    mockApprovalRepo.updateApproval.mockResolvedValue({
      ...approval,
      method: 'portal_confirm',
      transport_channel: 'portal_confirm',
      reason_code: 'support_case',
      last_notification_action: 'remind',
      last_notified_at: Date.now(),
      notification_count: 2,
    });
    mockApprovalRepo.listApprovalsForRequest.mockResolvedValue([
      {
        ...approval,
        method: 'portal_confirm',
        transport_channel: 'portal_confirm',
        reason_code: 'support_case',
        last_notification_action: 'remind',
        last_notified_at: Date.now(),
        notification_count: 2,
      },
    ]);

    const res = await app.request(
      '/api/admin/approvals/apr_public_1/steps/step-1/remind',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:write',
        },
        body: JSON.stringify({
          method: 'portal_confirm',
          reason_code: 'support_case',
          transport_detail: {
            request: {
              channel: 'portal_confirm',
            },
            response: {
              status: 'accepted',
            },
            metadata: {
              attempt: 2,
            },
          },
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockApprovalRepo.updateApproval).toHaveBeenCalledWith(
      'step-1',
      expect.objectContaining({
        method: 'portal_confirm',
        transport_channel: 'portal_confirm',
        reason_code: 'support_case',
        last_notification_action: 'remind',
        notification_count: 2,
      })
    );
    expect(mockDispatchApprovalNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'remind',
        request,
        approval,
        operatorTransportDetail: {
          request: {
            channel: 'portal_confirm',
          },
          response: {
            status: 'accepted',
          },
          metadata: {
            attempt: 2,
          },
        },
      })
    );
    expect(mockAppendApprovalTransportEvent).toHaveBeenCalledWith(
      expect.anything(),
      mockAdapter,
      mockRequestRepo,
      request,
      expect.objectContaining({
        kind: 'step_remind',
        notificationAction: 'remind',
        notificationCount: 2,
        transportSummary: {
          provider: 'authrim.portal_confirm',
          delivery_status: 'recorded',
          target: 'admin-2',
          correlation_id: 'corr-1',
          transport_request_id: 'transport-1',
        },
        transportDetail: {
          request: {
            channel: 'portal_confirm',
          },
          response: {
            status: 'recorded',
          },
          metadata: {
            attempt: 1,
            operator_input: {
              request: {
                channel: 'portal_confirm',
              },
              response: {
                status: 'accepted',
              },
              metadata: {
                attempt: 2,
              },
            },
          },
        },
      })
    );
  });

  it('resolves verified email transport when reminding OTP approval steps', async () => {
    const app = createApp();
    const request = {
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'user',
      target_subject_id: 'user-1',
      request_surface: 'admin_audit',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: {
        version: 1,
        surface: 'admin_audit',
        action: 'detail_read',
        tenant_id: 'tenant-a',
        resource_class: 'admin_audit_detail',
        resource_ids: ['user-1'],
      },
      scope_canonical: '{"version":1}',
      reason_code: 'support_case',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'pending',
      expires_at: Date.now() + 60_000,
      decided_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const approval = {
      id: 'step-otp',
      approval_request_id: 'req-1',
      step_key: 'owner-otp',
      side: 'customer_data_owner',
      subject_type: 'end_user',
      subject_id: 'user-1',
      relation_type: null,
      relation_source: 'target_subject',
      status: 'pending',
      method: 'email_otp',
      transport_channel: null,
      reason_code: null,
      reason_note: null,
      last_notification_action: 'initial',
      last_notified_at: Date.now() - 10 * 60 * 1000,
      notification_count: 1,
      decided_at: null,
      expires_at: Date.now() + 60_000,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    mockRequestRepo.getApprovalRequestByPublicId.mockResolvedValue(request);
    mockApprovalRepo.getApprovalById.mockResolvedValue(approval);
    mockAdapter.queryOne
      .mockResolvedValueOnce({
        pii_partition: 'default',
        email_verified: 1,
        phone_number_verified: 0,
      })
      .mockResolvedValueOnce({
        email: 'owner@example.com',
        phone_number: null,
      });
    mockDispatchApprovalNotification.mockResolvedValueOnce({
      success: true,
      method: 'email_otp',
      transportChannel: 'owner@example.com',
      summary: {
        provider: 'notifier.email',
        delivery_status: 'queued',
        target: 'owner@example.com',
        correlation_id: 'corr-remind-otp',
        transport_request_id: 'transport-remind-otp',
      },
      detail: {
        request: { channel: 'email', to: 'owner@example.com' },
        response: { status: 'queued' },
        metadata: { attempt: 1 },
      },
    });
    mockApprovalRepo.updateApproval.mockResolvedValue({
      ...approval,
      method: 'email_otp',
      transport_channel: 'owner@example.com',
      reason_code: 'support_case',
      last_notification_action: 'remind',
      last_notified_at: Date.now(),
      notification_count: 2,
    });
    mockApprovalRepo.listApprovalsForRequest.mockResolvedValue([
      {
        ...approval,
        method: 'email_otp',
        transport_channel: 'owner@example.com',
        reason_code: 'support_case',
        last_notification_action: 'remind',
        last_notified_at: Date.now(),
        notification_count: 2,
      },
    ]);

    const res = await app.request(
      '/api/admin/approvals/apr_public_1/steps/step-otp/remind',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:write',
        },
        body: JSON.stringify({
          method: 'email_otp',
          reason_code: 'support_case',
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockDispatchApprovalNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: 'email_otp',
        transportChannel: null,
      })
    );
    expect(mockApprovalRepo.updateApproval).toHaveBeenCalledWith(
      'step-otp',
      expect.objectContaining({
        transport_channel: 'owner@example.com',
      })
    );
  });

  it('enforces cooldown for remind operations', async () => {
    const app = createApp();
    const request = {
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'user',
      target_subject_id: 'user-1',
      request_surface: 'admin_audit',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: {
        version: 1,
        surface: 'admin_audit',
        action: 'detail_read',
        tenant_id: 'tenant-a',
        resource_class: 'admin_audit_detail',
        resource_ids: ['user-1'],
      },
      scope_canonical: '{"version":1}',
      reason_code: 'support_case',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'pending',
      expires_at: Date.now() + 60_000,
      decided_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const approval = {
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
      transport_channel: null,
      reason_code: null,
      reason_note: null,
      last_notification_action: 'initial',
      last_notified_at: Date.now() - 60 * 1000,
      notification_count: 1,
      decided_at: null,
      expires_at: Date.now() + 60_000,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    mockRequestRepo.getApprovalRequestByPublicId.mockResolvedValue(request);
    mockApprovalRepo.getApprovalById.mockResolvedValue(approval);

    const res = await app.request(
      '/api/admin/approvals/apr_public_1/steps/step-1/remind',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:approvals:write',
        },
        body: JSON.stringify({
          method: 'portal_confirm',
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        error: 'approval_notification_cooldown',
        action: 'remind',
      })
    );
    expect(mockApprovalRepo.updateApproval).not.toHaveBeenCalled();
  });

  it('returns transport evidence through the dedicated detail endpoint', async () => {
    const app = createApp();
    const request = {
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'artifact',
      target_subject_id: 'audit-1',
      request_surface: 'approvals',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: {
        version: 1,
        surface: 'approvals',
        action: 'detail_read',
        tenant_id: 'tenant-a',
        resource_class: 'approval_transport_detail',
        resource_ids: ['apr_public_1'],
      },
      scope_canonical: '{"version":1}',
      reason_code: 'support_case',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'pending',
      expires_at: Date.now() + 60_000,
      decided_at: null,
      detail_object_catalog_id: 'catalog-1',
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    mockRequestRepo.getApprovalRequestByPublicId.mockResolvedValue(request);
    mockLoadApprovalTransportDetail.mockResolvedValue({
      version: 1,
      request: {
        public_request_id: 'apr_public_1',
        investigation_id: 'inv_test_1',
        request_surface: 'approvals',
        requested_action: 'detail_read',
        target_subject_type: 'artifact',
        target_subject_id: 'audit-1',
        redaction_level: 'masked',
        status: 'pending',
        reason_code: 'support_case',
        reason_note: null,
        reference: null,
        ticket_reference: null,
        policy_preset: 'support_case_default',
        reuse_scope: 'request',
        partial_access_allowed: false,
        scope_json: request.scope_json,
        requested_at: Date.now(),
        expires_at: Date.now() + 60_000,
        decided_at: null,
      },
      events: [],
    });

    const res = await app.request(
      '/api/admin/approvals/apr_public_1/evidence',
      {
        method: 'GET',
        headers: {
          'X-Admin-Permissions': 'admin:approvals:detail:read',
        },
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockLoadApprovalTransportDetail).toHaveBeenCalledWith(
      expect.anything(),
      mockAdapter,
      request
    );
    expect(mockAuditAdminSensitiveRead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ grantedBy: 'permission' }),
      expect.objectContaining({
        action: 'approval.transport_detail_read',
        resourceId: 'apr_public_1',
      })
    );
  });

  it('returns approval decision receipts through the dedicated receipts endpoint', async () => {
    const app = createApp();
    const request = {
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'artifact',
      target_subject_id: 'audit-1',
      request_surface: 'approvals',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: {
        version: 1,
        surface: 'approvals',
        action: 'detail_read',
        tenant_id: 'tenant-a',
        resource_class: 'approval_transport_detail',
        resource_ids: ['apr_public_1'],
      },
      scope_canonical: '{"version":1}',
      reason_code: 'support_case',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'approved',
      expires_at: Date.now() + 60_000,
      decided_at: Date.now(),
      detail_object_catalog_id: 'catalog-1',
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const detail = {
      version: 1,
      request: {
        public_request_id: 'apr_public_1',
        investigation_id: 'inv_test_1',
        request_surface: 'approvals',
        requested_action: 'detail_read',
        target_subject_type: 'artifact',
        target_subject_id: 'audit-1',
        redaction_level: 'masked',
        status: 'approved',
        reason_code: 'support_case',
        reason_note: null,
        reference: null,
        ticket_reference: null,
        policy_preset: 'support_case_default',
        reuse_scope: 'request',
        partial_access_allowed: false,
        scope_json: request.scope_json,
        requested_at: Date.now(),
        expires_at: Date.now() + 60_000,
        decided_at: Date.now(),
      },
      events: [],
    };

    mockRequestRepo.getApprovalRequestByPublicId.mockResolvedValue(request);
    mockLoadApprovalTransportDetail.mockResolvedValue(detail);
    mockListApprovalDecisionReceiptsForEvidence.mockResolvedValue([
      {
        event_id: 'evt-1',
        event_at: Date.now(),
        receipt_id: 'adr_1',
        path: '/api/approval-receipts/adr_1',
        portal_path: '/api/approval-receipts/adr_1/portal',
        decision: 'approved',
        request_status: 'approved',
        expires_at: Date.now() + 60_000,
        grant_ids: ['egr_1'],
        receipt: null,
      },
    ]);

    const res = await app.request(
      '/api/admin/approvals/apr_public_1/receipts',
      {
        method: 'GET',
        headers: {
          'X-Admin-Permissions': 'admin:approvals:detail:read',
        },
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockListApprovalDecisionReceiptsForEvidence).toHaveBeenCalledWith(
      mockEnv,
      detail,
      'tenant-a'
    );
    expect(mockAuditAdminSensitiveRead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ grantedBy: 'permission' }),
      expect.objectContaining({
        action: 'approval.decision_receipts_read',
        resourceId: 'apr_public_1',
      })
    );
    expect(await res.json()).toEqual(
      expect.objectContaining({
        request_id: 'apr_public_1',
        investigation_id: 'inv_test_1',
        items: [
          expect.objectContaining({
            receipt_id: 'adr_1',
          }),
        ],
      })
    );
  });

  it('returns a resolved approval step guide through the dedicated guide endpoint', async () => {
    const app = createApp();
    const request = {
      id: 'req-1',
      public_request_id: 'apr_public_1',
      tenant_id: 'tenant-a',
      investigation_id: 'inv_test_1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'artifact',
      target_subject_id: 'audit-1',
      request_surface: 'approvals',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: {
        version: 1,
        surface: 'approvals',
        action: 'detail_read',
        tenant_id: 'tenant-a',
        resource_class: 'approval_transport_detail',
        resource_ids: ['apr_public_1'],
      },
      scope_canonical: '{"version":1}',
      reason_code: 'support_case',
      reason_note: null,
      reference: null,
      ticket_reference: null,
      policy_preset: 'support_case_default',
      reuse_scope: 'request',
      partial_access_allowed: false,
      status: 'pending',
      expires_at: Date.now() + 60_000,
      decided_at: null,
      detail_object_catalog_id: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const approval = {
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
      last_notification_action: null,
      last_notified_at: null,
      notification_count: 0,
      decided_at: null,
      expires_at: Date.now() + 60_000,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    mockRequestRepo.getApprovalRequestByPublicId.mockResolvedValue(request);
    mockApprovalRepo.getApprovalById.mockResolvedValue(approval);

    const res = await app.request(
      '/api/admin/approvals/apr_public_1/steps/step-1/guide',
      {
        method: 'GET',
        headers: {
          'X-Admin-Permissions': 'admin:approvals:read',
        },
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockResolveApprovalStepGuide).toHaveBeenCalledWith(expect.anything(), {
      request,
      approval,
    });
    expect(await res.json()).toEqual(
      expect.objectContaining({
        approval_id: 'step-1',
        guide: expect.objectContaining({
          method: 'portal_confirm',
        }),
      })
    );
  });
});
