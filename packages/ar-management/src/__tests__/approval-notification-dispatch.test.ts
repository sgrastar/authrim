import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockGetRequiredPluginContext } = vi.hoisted(() => ({
  mockGetRequiredPluginContext: vi.fn(),
}));

const { mockIssueApprovalCompletionArtifact } = vi.hoisted(() => ({
  mockIssueApprovalCompletionArtifact: vi.fn(),
}));

const { mockIssueApprovalOtpChallenge } = vi.hoisted(() => ({
  mockIssueApprovalOtpChallenge: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getRequiredPluginContext: mockGetRequiredPluginContext,
    produceNotificationDelivery: vi.fn(async (_env, input) => {
      const notifier = mockGetRequiredPluginContext().registry.getNotifier(input.payload.channel);
      if (!notifier) throw new Error('notification_delivery_provider_order_unavailable');
      const result = await notifier.send(input.payload);
      return {
        reference: { intentId: input.intentId },
        bindingRef: 'PLATFORM_NOTIFICATION_DB',
        delivery: result.success ? 'delivered' : 'permanent_failure',
      };
    }),
  };
});

vi.mock('../approval-completion-artifact', () => ({
  issueApprovalCompletionArtifact: mockIssueApprovalCompletionArtifact,
}));

vi.mock('../approval-otp', () => ({
  issueApprovalOtpChallenge: mockIssueApprovalOtpChallenge,
}));

import { dispatchApprovalNotification } from '../approval-notification-dispatch';

describe('approval notification dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRequiredPluginContext.mockReturnValue({
      registry: {
        getNotifier: vi.fn().mockReturnValue(undefined),
      },
    });
    mockIssueApprovalCompletionArtifact.mockResolvedValue({
      artifact_id: 'apc_1',
      tenant_id: 'tenant-a',
      request_id: 'apr_public_1',
      approval_id: 'step-1',
      step_key: 'operator-1',
      investigation_id: 'inv-1',
      request_surface: 'admin_audit',
      requested_action: 'detail_read',
      target_subject_type: 'artifact',
      target_subject_id: 'artifact-1',
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
    });
    mockIssueApprovalOtpChallenge.mockResolvedValue({
      code: '123456',
      expiresAt: Date.now() + 300_000,
    });
  });

  it('records internal portal notifications without external notifier delivery', async () => {
    const result = await dispatchApprovalNotification({ env: {} } as never, {
      request: {
        id: 'req-1',
        public_request_id: 'apr_public_1',
        tenant_id: 'tenant-a',
        investigation_id: 'inv-1',
        requester_subject_type: 'admin_user',
        requester_subject_id: 'admin-1',
        target_subject_type: 'artifact',
        target_subject_id: 'artifact-1',
        request_surface: 'admin_audit',
        requested_action: 'detail_read',
        redaction_level: 'masked',
        status: 'pending',
        scope_canonical: '{}',
        scope_json: {
          version: 1,
          surface: 'admin_audit',
          action: 'detail_read',
          tenant_id: 'tenant-a',
          resource_class: 'admin_audit_detail',
          resource_ids: ['artifact-1'],
        },
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
      },
      approval: {
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
        last_notification_action: null,
        last_notified_at: null,
        notification_count: 0,
        requested_at: Date.now(),
        decided_at: null,
        expires_at: Date.now() + 60_000,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      action: 'initial',
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe('portal_confirm');
    expect(result.transportChannel).toBe('portal_confirm');
    expect(result.summary.provider).toBe('authrim.portal_confirm');
    expect(result.summary.delivery_status).toBe('recorded');
    expect(result.summary.transport_request_id).toBe('apc_1');
  });

  it('sends email notifications through the configured notifier', async () => {
    const send = vi.fn().mockResolvedValue({
      success: true,
      messageId: 'email-msg-1',
    });
    mockGetRequiredPluginContext.mockReturnValue({
      registry: {
        getNotifier: vi.fn().mockImplementation((channel: string) =>
          channel === 'email'
            ? {
                send,
              }
            : undefined
        ),
      },
    });

    const result = await dispatchApprovalNotification(
      { env: { EMAIL_FROM: 'ops@example.com' } } as never,
      {
        request: {
          id: 'req-1',
          public_request_id: 'apr_public_1',
          tenant_id: 'tenant-a',
          investigation_id: 'inv-1',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-1',
          target_subject_type: 'user',
          target_subject_id: 'user-1',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          redaction_level: 'masked',
          status: 'pending',
          scope_canonical: '{}',
          scope_json: {
            version: 1,
            surface: 'service_data',
            action: 'detail_read',
            tenant_id: 'tenant-a',
            resource_class: 'customer_profile',
            resource_ids: ['user-1'],
          },
          reason_code: 'technical_debug',
          reason_note: null,
          reference: null,
          ticket_reference: null,
          reuse_scope: 'request',
          policy_preset: 'technical_debug_default',
          partial_access_allowed: false,
          requested_at: Date.now(),
          expires_at: Date.now() + 60_000,
          decided_at: null,
          detail_object_catalog_id: null,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
        approval: {
          id: 'step-1',
          approval_request_id: 'req-1',
          step_key: 'customer-owner',
          side: 'customer_data_owner',
          subject_type: 'customer_delegate',
          subject_id: 'owner@example.com',
          relation_type: null,
          relation_source: null,
          status: 'pending',
          method: 'email_otp',
          transport_channel: 'owner@example.com',
          reason_code: null,
          reason_note: null,
          last_notification_action: null,
          last_notified_at: null,
          notification_count: 0,
          requested_at: Date.now(),
          decided_at: null,
          expires_at: Date.now() + 60_000,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
        action: 'resend',
      }
    );

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'email',
        to: 'owner@example.com',
        from: 'ops@example.com',
        body: expect.stringContaining('/api/approval-artifacts/apc_1/portal'),
      })
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('123456'),
      })
    );
    expect(result.summary.provider).toBe('notifier.email');
    expect(result.summary.delivery_status).toBe('sent');
    expect(result.summary.transport_request_id).toBe('approval-notification:apc_1');
    expect(result.completionArtifact).toEqual({
      artifactId: 'apc_1',
      path: '/api/approval-artifacts/apc_1/portal',
      expiresAt: expect.any(Number),
    });
  });

  it('returns a failure result when no sms notifier is configured', async () => {
    const result = await dispatchApprovalNotification({ env: {} } as never, {
      request: {
        id: 'req-1',
        public_request_id: 'apr_public_1',
        tenant_id: 'tenant-a',
        investigation_id: 'inv-1',
        requester_subject_type: 'admin_user',
        requester_subject_id: 'admin-1',
        target_subject_type: 'user',
        target_subject_id: 'user-1',
        request_surface: 'service_data',
        requested_action: 'detail_read',
        redaction_level: 'masked',
        status: 'pending',
        scope_canonical: '{}',
        scope_json: {
          version: 1,
          surface: 'service_data',
          action: 'detail_read',
          tenant_id: 'tenant-a',
          resource_class: 'customer_profile',
          resource_ids: ['user-1'],
        },
        reason_code: 'technical_debug',
        reason_note: null,
        reference: null,
        ticket_reference: null,
        reuse_scope: 'request',
        policy_preset: 'technical_debug_default',
        partial_access_allowed: false,
        requested_at: Date.now(),
        expires_at: Date.now() + 60_000,
        decided_at: null,
        detail_object_catalog_id: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      approval: {
        id: 'step-1',
        approval_request_id: 'req-1',
        step_key: 'guardian-1',
        side: 'guardian_delegate',
        subject_type: 'customer_delegate',
        subject_id: '+819000000000',
        relation_type: 'guardian',
        relation_source: 'rebac_relation',
        status: 'pending',
        method: 'sms_otp',
        transport_channel: '+819000000000',
        reason_code: null,
        reason_note: null,
        last_notification_action: null,
        last_notified_at: null,
        notification_count: 0,
        requested_at: Date.now(),
        decided_at: null,
        expires_at: Date.now() + 60_000,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      action: 'remind',
    });

    expect(result.success).toBe(false);
    expect(result.summary.provider).toBe('notifier.sms');
    expect(result.summary.delivery_status).toBe('failed');
    expect(result.error).toBe('notification_delivery_unavailable');
    expect(mockIssueApprovalOtpChallenge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        artifactId: 'apc_1',
        method: 'sms_otp',
      })
    );
  });
});
