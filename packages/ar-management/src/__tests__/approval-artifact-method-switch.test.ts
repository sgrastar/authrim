import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDispatchApprovalNotification } = vi.hoisted(() => ({
  mockDispatchApprovalNotification: vi.fn(),
}));

const { mockAppendApprovalTransportEvent } = vi.hoisted(() => ({
  mockAppendApprovalTransportEvent: vi.fn(),
}));

const { mockConsumeApprovalCompletionArtifact } = vi.hoisted(() => ({
  mockConsumeApprovalCompletionArtifact: vi.fn(),
}));

vi.mock('../approval-notification-dispatch', () => ({
  dispatchApprovalNotification: mockDispatchApprovalNotification,
}));

vi.mock('../approval-transport-detail', () => ({
  appendApprovalTransportEvent: mockAppendApprovalTransportEvent,
}));

vi.mock('../approval-completion-artifact', () => ({
  consumeApprovalCompletionArtifact: mockConsumeApprovalCompletionArtifact,
}));

import {
  switchApprovalArtifactMethod,
} from '../approval-artifact-method-switch';

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
  } as any;
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
    last_notified_at: Date.now() - 10 * 60 * 1000,
    notification_count: 1,
    requested_at: Date.now(),
    decided_at: null,
    expires_at: Date.now() + 60_000,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  } as any;
}

describe('switchApprovalArtifactMethod', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchApprovalNotification.mockResolvedValue({
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
    });
    mockAppendApprovalTransportEvent.mockImplementation(async (_c, _adapter, _repo, request) => request);
    mockConsumeApprovalCompletionArtifact.mockResolvedValue(undefined);
  });

  it('reissues a pending approval artifact with an allowed fallback method', async () => {
    const request = makeRequest();
    const approval = makeApproval();
    const approvalRepo = {
      updateApproval: vi.fn().mockResolvedValue({
        ...approval,
        method: 'passkey',
        transport_channel: 'Registered passkey on this device',
        last_notification_action: 'resend',
        notification_count: 2,
      }),
    };
    const result = await switchApprovalArtifactMethod(
      { env: {} } as any,
      {
        adapter: {} as any,
        requestRepo: {} as any,
        approvalRepo: approvalRepo as any,
        request,
        approval,
        currentArtifactId: 'apc_1',
        currentMethod: 'portal_confirm',
        requestedMethod: 'passkey',
      }
    );

    expect(mockDispatchApprovalNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        request,
        approval,
        action: 'resend',
        method: 'passkey',
      })
    );
    expect(approvalRepo.updateApproval).toHaveBeenCalledWith(
      'step-1',
      expect.objectContaining({
        method: 'passkey',
        last_notification_action: 'resend',
      })
    );
    expect(mockConsumeApprovalCompletionArtifact).toHaveBeenCalledWith({}, 'apc_1');
    expect(result.replacedArtifactId).toBe('apc_1');
    expect(result.allowedMethods).toEqual(['portal_confirm', 'passkey', 'reauth']);
  });

  it('rejects fallback methods outside the allowed policy', async () => {
    await expect(
      switchApprovalArtifactMethod(
        { env: {} } as any,
        {
          adapter: {} as any,
          requestRepo: {} as any,
          approvalRepo: { updateApproval: vi.fn() } as any,
          request: makeRequest(),
          approval: makeApproval(),
          currentArtifactId: 'apc_1',
          currentMethod: 'portal_confirm',
          requestedMethod: 'sms_otp',
        }
      )
    ).rejects.toMatchObject({
      status: 409,
      code: 'approval_completion_method_not_allowed',
    });
  });

  it('enforces resend cooldowns before switching methods', async () => {
    await expect(
      switchApprovalArtifactMethod(
        { env: {} } as any,
        {
          adapter: {} as any,
          requestRepo: {} as any,
          approvalRepo: { updateApproval: vi.fn() } as any,
          request: makeRequest(),
          approval: makeApproval({
            last_notified_at: Date.now() - 2_000,
          }),
          currentArtifactId: 'apc_1',
          currentMethod: 'portal_confirm',
          requestedMethod: 'passkey',
        }
      )
    ).rejects.toMatchObject({
      status: 429,
      code: 'approval_notification_cooldown',
    });
  });
});
