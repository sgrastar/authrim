import { describe, expect, it, vi } from 'vitest';

const { mockQueryOne } = vi.hoisted(() => ({ mockQueryOne: vi.fn() }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  ensureDatabaseAdapter: vi.fn(() => ({ queryOne: mockQueryOne })),
}));

import {
  ApprovalTransportChannelResolutionError,
  resolveApprovalTransportChannel,
} from '../approval-approver-contact';

const request = { tenant_id: 'tenant-a' } as never;
const adminStep = {
  subject_type: 'admin_user' as const,
  subject_id: 'admin-2',
  transport_channel: 'requester@example.com',
  method: 'email_otp' as const,
};
const context = { env: { DB_ADMIN: {} } } as never;

describe('resolveApprovalTransportChannel', () => {
  it("sends an OTP to the approver's verified contact, not the channel stored on the step", async () => {
    mockQueryOne.mockResolvedValueOnce({ email: 'admin2@example.com', email_verified: 1 });

    await expect(resolveApprovalTransportChannel(context, request, adminStep)).resolves.toBe(
      'admin2@example.com'
    );
  });

  it('refuses a caller-named OTP destination other than that contact', async () => {
    mockQueryOne.mockResolvedValueOnce({ email: 'admin2@example.com', email_verified: 1 });

    await expect(
      resolveApprovalTransportChannel(context, request, adminStep, {
        transportChannel: 'requester@example.com',
      })
    ).rejects.toBeInstanceOf(ApprovalTransportChannelResolutionError);
  });

  it('keeps a caller-named label for methods that send no secret', async () => {
    await expect(
      resolveApprovalTransportChannel(
        context,
        request,
        { ...adminStep, method: 'passkey' },
        {
          transportChannel: 'Security key',
        }
      )
    ).resolves.toBe('Security key');
  });
});
