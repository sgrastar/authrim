import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSecondFactorRecovery, DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  produceNotificationDelivery: vi.fn(),
  isNotificationDeliveryAvailable: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    produceNotificationDelivery: mocks.produceNotificationDelivery,
    isNotificationDeliveryAvailable: mocks.isNotificationDeliveryAvailable,
  };
});

import {
  RECOVERY_NOTICE_MAX_RECIPIENTS,
  recoveryNoticeAvailable,
  sendRecoveryNotice,
  sendRecoveryNoticeAfterCommit,
} from '../routes/admin-management/second-factor-recovery-notice';

const recovery: AdminSecondFactorRecovery = {
  id: 'rec-1',
  admin_user_id: 'admin-1',
  tenant_id: 'tenant-a',
  status: 'pending',
  kind: 'webauthn_credential',
  credential_id: 'cred-new',
  holder_jkt: null,
  admin_credential_id: null,
  aaguid: null,
  label: null,
  requested_session_id: 'sess-1',
  requested_at: 1,
  notified_at: null,
  not_before: Date.UTC(2026, 10, 5),
  expires_at: 3,
  completed_at: null,
  cancelled_at: null,
  cancelled_by: null,
  cancel_reason: null,
};

const env = { EMAIL_FROM: 'security@example.com' } as Env;
const adapter = { query: mocks.query } as unknown as DatabaseAdapter;

function send(requesterEmail = 'admin-1@example.com') {
  return sendRecoveryNotice(env, adapter, {
    event: 'requested',
    recovery,
    requester: { id: 'admin-1', email: requesterEmail },
    now: 1_700_000_000_000,
  });
}

describe('second-factor recovery notices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue([
      { id: 'admin-1', email: 'admin-1@example.com' },
      { id: 'admin-2', email: 'admin-2@example.com' },
    ]);
    mocks.produceNotificationDelivery.mockResolvedValue({ delivery: 'pending' });
  });

  it('emails the requester and each tenant administrator once', async () => {
    expect(await send()).toBe(true);

    const calls = mocks.produceNotificationDelivery.mock.calls as Array<
      [unknown, Record<string, unknown> & { payload: Record<string, unknown> }]
    >;
    expect(calls.map(([, input]) => input.payload.to)).toEqual([
      'admin-1@example.com',
      'admin-2@example.com',
    ]);
    expect(calls[1]?.[1]).toMatchObject({
      owner: { owner: 'tenant', tenantId: 'tenant-a' },
      notificationKind: 'admin.second-factor-recovery',
      idempotencyKey: 'admin-second-factor-recovery:rec-1:requested:admin-2',
      payload: { channel: 'email', from: 'security@example.com' },
    });
    // Every active admin of the tenant, whatever the role (a super admin can cancel too).
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE tenant_id = ? AND is_active = 1 AND status = 'active'");
    expect(sql).not.toContain('admin_role');
    expect(params).toEqual(['tenant-a', RECOVERY_NOTICE_MAX_RECIPIENTS + 1]);
  });

  it('escapes the requester address in the HTML body', async () => {
    await send('<b>x</b>@example.com');

    const [, input] = mocks.produceNotificationDelivery.mock.calls[0] as [
      unknown,
      { payload: { body: string } },
    ];
    expect(input.payload.body).toContain('&lt;b&gt;x&lt;/b&gt;@example.com');
    expect(input.payload.body).not.toContain('<b>x</b>');
  });

  it.each([
    [
      'a delivery throws',
      () => mocks.produceNotificationDelivery.mockRejectedValueOnce(new Error()),
    ],
    [
      'the provider rejects one',
      () =>
        mocks.produceNotificationDelivery.mockResolvedValueOnce({ delivery: 'permanent_failure' }),
    ],
  ])('reports failure when %s, still trying the others', async (_label, arrange) => {
    arrange();

    expect(await send()).toBe(false);
    expect(mocks.produceNotificationDelivery).toHaveBeenCalledTimes(2);
  });

  it('sends nothing and reports failure when the tenant has more admins than it can reach', async () => {
    mocks.query.mockResolvedValue(
      Array.from({ length: RECOVERY_NOTICE_MAX_RECIPIENTS + 1 }, (_, index) => ({
        id: `admin-${index}`,
        email: `admin-${index}@example.com`,
      }))
    );

    expect(await send()).toBe(false);
    expect(mocks.produceNotificationDelivery).not.toHaveBeenCalled();
  });

  it('turns any failure after a commit into false instead of throwing', async () => {
    mocks.query.mockRejectedValue(new Error('db'));

    await expect(
      sendRecoveryNoticeAfterCommit(env, adapter, {
        event: 'completed',
        recovery,
        requester: { id: 'admin-1', email: 'admin-1@example.com' },
        now: 1,
      })
    ).resolves.toBe(false);
  });

  it('checks email delivery for the tenant', async () => {
    mocks.isNotificationDeliveryAvailable.mockResolvedValue(false);

    expect(await recoveryNoticeAvailable(env, 'tenant-a')).toBe(false);
    expect(mocks.isNotificationDeliveryAvailable).toHaveBeenCalledWith(env, {
      owner: 'tenant',
      tenantId: 'tenant-a',
    });
  });
});
