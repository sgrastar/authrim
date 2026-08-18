import { describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS, encryptValue, type DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  listAdminEmailDeliveries,
  resolveEmailDeliveryRecipientVisibility,
} from '../admin-email-deliveries';

const KEY = '34'.repeat(32);

async function row() {
  return {
    intent_id: 'intent-a',
    account_id: 'account-a',
    notification_kind: 'account.identifier-replacement-otp',
    recipient_masked: 'us***@example.com',
    recipient_encrypted: (await encryptValue('user@example.com', KEY, 'AES-256-GCM', 1)).encrypted,
    plugin_installation_id: 'provider-a',
    active_plugin_installation_id: 'provider-a',
    provider_message_id: 'message-a',
    state: 'delivered',
    delivery_status: 'provider_accepted',
    attempt_count: 1,
    last_error_code: null,
    outbox_status: 'succeeded',
    effective_status: 'provider_accepted',
    requested_at: 1_000,
    provider_accepted_at: 1_001,
    delivery_status_updated_at: 1_001,
  };
}

function adapter(value: Awaited<ReturnType<typeof row>>): DatabaseAdapter {
  return { query: vi.fn(async () => [value]) } as unknown as DatabaseAdapter;
}

describe('Admin email delivery history', () => {
  it.each([
    ['admin', ['admin'], [], 'full'],
    [
      'technical investigator',
      ['technical_investigator'],
      [ADMIN_PERMISSIONS.EMAIL_DELIVERIES_RECIPIENT_FULL_READ],
      'full',
    ],
    [
      'support readonly',
      ['support_readonly'],
      [ADMIN_PERMISSIONS.EMAIL_DELIVERIES_RECIPIENT_MASKED_READ],
      'masked',
    ],
    [
      'base-only custom role',
      ['custom_email_delivery_viewer'],
      [ADMIN_PERMISSIONS.EMAIL_DELIVERIES_READ],
      'none',
    ],
  ] as const)('assigns %s recipient visibility to %s', (_label, roles, permissions, expected) => {
    expect(
      resolveEmailDeliveryRecipientVisibility({
        roles: [...roles],
        permissions: [...permissions],
      })
    ).toBe(expected);
  });

  it.each([
    ['none', null],
    ['masked', 'us***@example.com'],
    ['full', 'user@example.com'],
  ] as const)('projects recipients using %s visibility', async (visibility, recipient) => {
    const result = await listAdminEmailDeliveries(adapter(await row()), {
      tenantId: 'tenant-a',
      visibility,
      piiEncryptionKey: KEY,
    });
    expect(result[0]).toMatchObject({
      recipient,
      recipient_visibility: visibility,
      api_status: 'recorded',
      status: 'provider_accepted',
      final_delivery_tracked: false,
      provider_message_id: 'message-a',
    });
  });

  it('labels pending retry and scopes a user query without exposing message contents', async () => {
    const value = {
      ...(await row()),
      state: 'pending',
      outbox_status: 'waiting_retry',
      effective_status: 'retrying',
    };
    const db = adapter(value);
    const result = await listAdminEmailDeliveries(db, {
      tenantId: 'tenant-a',
      accountId: '_account-a',
      visibility: 'masked',
    });
    expect(result[0]?.status).toBe('retrying');
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('i.account_id = ?'),
      ['tenant-a', '_account-a', 50],
      { consistencyClass: 'primary_required' }
    );
    expect(JSON.stringify(result)).not.toContain('body');
  });

  it.each([
    ['requested', 'pending', 'requested', false],
    ['provider accepted', 'delivered', 'provider_accepted', false],
    ['final delivery', 'delivered', 'delivered', true],
    ['provider bounce', 'delivered', 'bounced', true],
    ['Authrim dispatch failure', 'dead_letter', 'failed', false],
  ] as const)(
    'keeps %s responsibility separate from final delivery evidence',
    async (_label, state, effectiveStatus, finalDeliveryTracked) => {
      const value = {
        ...(await row()),
        state,
        delivery_status: effectiveStatus,
        effective_status: effectiveStatus,
      };
      const result = await listAdminEmailDeliveries(adapter(value), {
        tenantId: 'tenant-a',
        visibility: 'none',
      });
      expect(result[0]).toMatchObject({
        api_status: 'recorded',
        status: effectiveStatus,
        final_delivery_tracked: finalDeliveryTracked,
      });
    }
  );

  it('applies status filtering in the database before the result limit', async () => {
    const db = adapter({ ...(await row()), effective_status: 'bounced' });
    await listAdminEmailDeliveries(db, {
      tenantId: 'tenant-a',
      status: 'bounced',
      limit: 25,
      visibility: 'none',
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE history.effective_status = ?'),
      ['tenant-a', 'bounced', 25],
      { consistencyClass: 'primary_required' }
    );
  });
});
