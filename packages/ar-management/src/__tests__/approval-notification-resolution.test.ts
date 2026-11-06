import { beforeEach, describe, expect, it, vi } from 'vitest';

const owner: { record: Record<string, unknown> } = vi.hoisted(() => ({ record: {} }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  resolveAccountDataContext: vi.fn(async () => ({
    legacyUserId: 'owner-1',
    coreDb: {},
    piiDb: {},
  })),
  ensureDatabaseAdapter: vi.fn(() => ({})),
  CanonicalRuntimeUserStore: class {
    findById() {
      return Promise.resolve(owner.record);
    }
  },
}));

import { resolveApprovalNotificationTransport } from '../approval-notification-resolution';
import { ApprovalTransportChannelResolutionError } from '../approval-approver-contact';

const request = {
  tenant_id: 'tenant-a',
  policy_preset: 'support_case_default',
  target_subject_type: 'user',
  request_surface: 'service_data',
  requested_action: 'detail_read',
} as never;
const ownerStep = {
  side: 'customer_data_owner' as const,
  subject_type: 'end_user' as const,
  subject_id: 'owner-1',
  method: 'ciba' as const,
  transport_channel: 'ciba',
};

describe('resolveApprovalNotificationTransport', () => {
  beforeEach(() => {
    owner.record = { email: 'owner@example.com', email_verified: true };
  });

  it("falls back to SMS when a retired link step's owner has only a verified phone", async () => {
    owner.record = {
      email: null,
      email_verified: false,
      phone_number: '+819012345678',
      phone_number_verified: true,
    };

    await expect(
      resolveApprovalNotificationTransport({ env: {} } as never, {
        request,
        approval: { ...ownerStep, method: 'portal_confirm', transport_channel: 'portal_confirm' },
        overrideMethod: 'portal_confirm',
        strictMethod: true,
      })
    ).resolves.toMatchObject({ method: 'sms_otp', transportChannel: '+819012345678' });
  });

  it("switches a step to email OTP at the owner's verified address despite its stored label", async () => {
    await expect(
      resolveApprovalNotificationTransport({ env: {} } as never, {
        request,
        approval: ownerStep,
        overrideMethod: 'email_otp',
        overrideTransportChannel: ownerStep.transport_channel,
        strictMethod: true,
      })
    ).resolves.toMatchObject({ method: 'email_otp', transportChannel: 'owner@example.com' });
  });

  it('refuses an OTP destination the caller names that is not the owner’s address', async () => {
    await expect(
      resolveApprovalNotificationTransport({ env: {} } as never, {
        request,
        approval: ownerStep,
        overrideMethod: 'email_otp',
        overrideTransportChannel: 'requester@example.com',
        strictMethod: true,
      })
    ).rejects.toBeInstanceOf(ApprovalTransportChannelResolutionError);
  });
});
