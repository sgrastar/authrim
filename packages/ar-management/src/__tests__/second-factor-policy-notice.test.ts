import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  available: vi.fn(),
  produce: vi.fn(),
  contacts: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  class MockAdminNoticeRepository {
    create = mocks.create;
  }
  return {
    ...actual,
    AdminNoticeRepository: MockAdminNoticeRepository,
    isNotificationDeliveryAvailable: mocks.available,
    produceNotificationDelivery: mocks.produce,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
  };
});
vi.mock('../routes/admin-management/second-factor-recovery-notice', () => ({
  tenantAdminContacts: mocks.contacts,
}));

import {
  noticeSecondFactorKindsWidened,
  showSecondFactorKindsWidenedInConsole,
} from '../routes/settings-v2/second-factor-policy-notice';

const env = { EMAIL_FROM: 'noreply@example.com' } as unknown as Env;
const input = {
  tenantId: 'tenant-a',
  actor: { id: 'admin-1', email: 'admin-1@example.com' },
  kinds: ['hardware', 'totp'],
  now: 1_800_000_000_000,
};

describe('the notices for widening the allowed second-factor kinds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.available.mockResolvedValue(true);
    mocks.contacts.mockResolvedValue([
      { id: 'admin-1', email: 'admin-1@example.com' },
      { id: 'admin-2', email: 'admin-2@example.com' },
    ]);
    mocks.produce.mockResolvedValue({ delivery: 'accepted' });
    mocks.create.mockResolvedValue({});
  });

  it('leaves a console notice for the tenant’s administrators, whether or not mail works', async () => {
    mocks.available.mockResolvedValue(false);

    await showSecondFactorKindsWidenedInConsole(env, input);

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({
      scope_type: 'tenant',
      tenant_id: 'tenant-a',
      severity: 'high',
      category: 'second_factor_policy',
      message_key: 'second_factor_policy_widened',
      params: { email: 'admin-1@example.com', kinds: 'hardware, totp' },
      required_permission: 'admin:admin_users:read',
    });
    expect(mocks.produce).not.toHaveBeenCalled();
  });

  it('emails every administrator of the tenant once, naming who changed what', async () => {
    await noticeSecondFactorKindsWidened(env, input);

    expect(mocks.produce).toHaveBeenCalledTimes(2);
    const recipients = mocks.produce.mock.calls.map(
      (call) => (call[1] as { payload: { to: string } }).payload.to
    );
    expect(recipients.sort()).toEqual(['admin-1@example.com', 'admin-2@example.com']);
    const first = mocks.produce.mock.calls[0]?.[1] as {
      notificationKind: string;
      payload: { body: string; subject: string };
    };
    expect(first.notificationKind).toBe('admin.second-factor-policy-widened');
    expect(first.payload.body).toContain('hardware, totp');
    expect(first.payload.body).toContain('fresh passkey only');
  });

  it('sends nothing where mail is not set up, or the administrators cannot all be reached', async () => {
    mocks.available.mockResolvedValue(false);
    await noticeSecondFactorKindsWidened(env, input);
    expect(mocks.produce).not.toHaveBeenCalled();

    mocks.available.mockResolvedValue(true);
    mocks.contacts.mockResolvedValue(null);
    await noticeSecondFactorKindsWidened(env, input);
    expect(mocks.produce).not.toHaveBeenCalled();
  });

  it('keeps going when one email cannot be queued', async () => {
    mocks.produce.mockRejectedValueOnce(new Error('queue down')).mockResolvedValue({});

    await expect(noticeSecondFactorKindsWidened(env, input)).resolves.toBeUndefined();

    expect(mocks.produce).toHaveBeenCalledTimes(2);
  });
});
