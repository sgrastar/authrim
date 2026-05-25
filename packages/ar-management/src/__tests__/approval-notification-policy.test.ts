import { describe, expect, it } from 'vitest';
import { resolveApprovalNotificationPolicy } from '../approval-notification-policy';

describe('approval notification policy', () => {
  it('defaults admin operator approvals to portal confirm', () => {
    const resolution = resolveApprovalNotificationPolicy({
      request: {
        policy_preset: 'support_case_default',
        target_subject_type: 'artifact',
        request_surface: 'admin_audit',
        requested_action: 'detail_read',
      },
      approval: {
        side: 'admin_operator',
        subject_type: 'admin_user',
        subject_id: 'admin-2',
        method: null,
        transport_channel: null,
      },
    });

    expect(resolution).toEqual(
      expect.objectContaining({
        method: 'portal_confirm',
        transportChannel: 'portal_confirm',
        source: 'policy_default',
      })
    );
    expect(resolution.acceptableMethods.slice(0, 3)).toEqual([
      'portal_confirm',
      'passkey',
      'reauth',
    ]);
  });

  it('defaults standard customer-side approvals to portal confirm with contact fallbacks', () => {
    const resolution = resolveApprovalNotificationPolicy({
      request: {
        policy_preset: 'technical_debug_default',
        target_subject_type: 'user',
        request_surface: 'service_data',
        requested_action: 'detail_read',
      },
      approval: {
        side: 'customer_data_owner',
        subject_type: 'customer_delegate',
        subject_id: 'owner@example.com',
        method: null,
        transport_channel: null,
      },
    });

    expect(resolution).toEqual(
      expect.objectContaining({
        method: 'portal_confirm',
        transportChannel: 'portal_confirm',
        source: 'policy_default',
      })
    );
    expect(resolution.acceptableMethods.slice(0, 4)).toEqual([
      'portal_confirm',
      'email_otp',
      'sms_otp',
      'ciba',
    ]);
  });

  it('defaults guardian-side approvals to portal confirm for lower-risk presets', () => {
    const resolution = resolveApprovalNotificationPolicy({
      request: {
        policy_preset: 'guardian_support_default',
        target_subject_type: 'user',
        request_surface: 'service_data',
        requested_action: 'detail_read',
      },
      approval: {
        side: 'guardian_delegate',
        subject_type: 'customer_delegate',
        subject_id: 'guardian-1',
        method: null,
        transport_channel: null,
      },
    });

    expect(resolution.method).toBe('portal_confirm');
    expect(resolution.acceptableMethods.slice(0, 4)).toEqual([
      'portal_confirm',
      'email_otp',
      'sms_otp',
      'ciba',
    ]);
  });

  it('prefers ciba first for high-assurance customer-side presets', () => {
    const resolution = resolveApprovalNotificationPolicy({
      request: {
        policy_preset: 'security_investigation_default',
        target_subject_type: 'user',
        request_surface: 'service_data',
        requested_action: 'detail_read',
      },
      approval: {
        side: 'customer_data_owner',
        subject_type: 'customer_delegate',
        subject_id: 'owner@example.com',
        method: null,
        transport_channel: null,
      },
    });

    expect(resolution.method).toBe('ciba');
    expect(resolution.acceptableMethods.slice(0, 4)).toEqual([
      'ciba',
      'portal_confirm',
      'email_otp',
      'sms_otp',
    ]);
  });

  it('uses contact subject ids only for contact-based transport methods', () => {
    const resolution = resolveApprovalNotificationPolicy({
      request: {
        policy_preset: 'support_case_default',
        target_subject_type: 'user',
        request_surface: 'service_data',
        requested_action: 'detail_read',
      },
      approval: {
        side: 'customer_data_owner',
        subject_type: 'customer_delegate',
        subject_id: 'owner@example.com',
        method: 'email_otp',
        transport_channel: null,
      },
    });

    expect(resolution).toEqual(
      expect.objectContaining({
        method: 'email_otp',
        transportChannel: 'owner@example.com',
        source: 'approval_step',
      })
    );
  });
});
