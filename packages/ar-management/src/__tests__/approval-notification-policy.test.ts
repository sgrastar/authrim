import { describe, expect, it } from 'vitest';
import { resolveApprovalNotificationPolicy } from '../approval-notification-policy';

describe('approval notification policy', () => {
  it("defaults admin operator approvals to the approver's passkey, never a link", () => {
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
        method: 'passkey',
        transportChannel: 'passkey',
        source: 'policy_default',
      })
    );
    expect(resolution.acceptableMethods).toEqual(['passkey', 'reauth']);
  });

  it('replaces a portal confirm stored or requested for an admin approver', () => {
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
        method: 'portal_confirm',
        transport_channel: 'portal_confirm',
      },
      overrideMethod: 'portal_confirm',
    });

    expect(resolution.method).toBe('passkey');
    expect(resolution.acceptableMethods).not.toContain('portal_confirm');
  });

  it('defaults standard customer-side approvals to a code to their contact', () => {
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

    // A data owner verifies with a code to their own contact, never by confirming a link.
    expect(resolution).toEqual(
      expect.objectContaining({
        method: 'email_otp',
        source: 'policy_default',
      })
    );
    expect(resolution.acceptableMethods.slice(0, 3)).toEqual(['email_otp', 'sms_otp', 'ciba']);
    expect(resolution.acceptableMethods).not.toContain('portal_confirm');
  });

  it('defaults guardian-side approvals to a code for lower-risk presets', () => {
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

    expect(resolution.method).toBe('email_otp');
    expect(resolution.acceptableMethods.slice(0, 3)).toEqual(['email_otp', 'sms_otp', 'ciba']);
    expect(resolution.acceptableMethods).not.toContain('portal_confirm');
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
    expect(resolution.acceptableMethods.slice(0, 3)).toEqual(['ciba', 'email_otp', 'sms_otp']);
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
