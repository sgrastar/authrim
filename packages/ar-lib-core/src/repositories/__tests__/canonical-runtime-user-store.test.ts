import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { CanonicalRuntimeUserStore } from '../identity/canonical-runtime-user-store';

function adapter(overrides: Partial<DatabaseAdapter> = {}): DatabaseAdapter {
  return {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(async () => ({ success: true, rowsAffected: 0 })),
    transaction: vi.fn(),
    batch: vi.fn(async () => []),
    isHealthy: vi.fn(),
    getType: vi.fn(() => 'mock'),
    getPartition: vi.fn(() => 'test'),
    ...overrides,
  } as unknown as DatabaseAdapter;
}

describe('CanonicalRuntimeUserStore OTP fast path', () => {
  it.each(['1700000000', '1700000000000'])(
    'accepts PostgreSQL int8 timestamps %s',
    async (timestamp) => {
      const store = new CanonicalRuntimeUserStore({
        tenantId: 'tenant-1',
        coreAdapter: adapter({
          queryOne: vi.fn(async () => ({
            user_id: 'user-1',
            account_type: 'end_user',
            account_lifecycle_state: 'active',
            subject_lifecycle_state: 'active',
            directory_publication_state: 'active',
            account_updated_at: timestamp,
            subject_updated_at: timestamp,
          })),
        }),
      });
      await expect(store.findAccountAuthenticationState('user-1')).resolves.toMatchObject({
        lifecycle: 'active',
        sourceVersionMs: 1_700_000_000_000,
      });
    }
  );

  it.each(['not-a-time', '', '1.5', '9007199254740993'])(
    'rejects invalid database timestamp %s',
    async (timestamp) => {
      const store = new CanonicalRuntimeUserStore({
        tenantId: 'tenant-1',
        coreAdapter: adapter({
          queryOne: vi.fn(async () => ({
            user_id: 'user-1',
            account_type: 'end_user',
            account_lifecycle_state: 'active',
            subject_lifecycle_state: 'active',
            directory_publication_state: 'active',
            account_updated_at: timestamp,
            subject_updated_at: timestamp,
          })),
        }),
      });
      await expect(store.findAccountAuthenticationState('user-1')).rejects.toThrow(
        'canonical_account_authentication_timestamp_invalid'
      );
    }
  );

  it('reads a Core-only account authentication state and normalizes restrictive lifecycle', async () => {
    const coreQueryOne = vi.fn(async () => ({
      user_id: 'user-1',
      account_type: 'end_user',
      account_lifecycle_state: 'suspended',
      subject_lifecycle_state: 'active',
      directory_publication_state: 'active',
      account_updated_at: 1_700_000_000_000,
      subject_updated_at: 1_699_000_000_000,
    }));
    const piiQueryOne = vi.fn();
    const store = new CanonicalRuntimeUserStore({
      tenantId: 'tenant-1',
      coreAdapter: adapter({ queryOne: coreQueryOne }),
      piiAdapter: adapter({ queryOne: piiQueryOne }),
    });

    await expect(store.findAccountAuthenticationState('user-1')).resolves.toEqual({
      userId: 'user-1',
      accountType: 'end_user',
      lifecycle: 'suspended',
      sourceVersionMs: 1_700_000_000_000,
    });
    expect(piiQueryOne).not.toHaveBeenCalled();
  });

  it('reads the OTP projection from Core only and trusts the routed challenge email', async () => {
    const coreQueryOne = vi.fn(async () => ({
      id: 'user-1',
      account_type: 'end_user',
      account_lifecycle_state: 'active',
      subject_lifecycle_state: 'active',
      directory_publication_state: 'active',
      display_name: 'User One',
      email_verified: 1,
      created_at: 1_700_000_000_000,
    }));
    const piiQueryOne = vi.fn(async () => {
      throw new Error('PII must not be read');
    });
    const store = new CanonicalRuntimeUserStore({
      tenantId: 'tenant-1',
      coreAdapter: adapter({ queryOne: coreQueryOne }),
      piiAdapter: adapter({ queryOne: piiQueryOne }),
    });

    await expect(store.findForOtpLogin('user-1', 'USER@example.com')).resolves.toEqual({
      id: 'user-1',
      email: 'user@example.com',
      name: 'User One',
      active: 1,
      email_verified: 1,
      account_type: 'end_user',
      created_at: '2023-11-14T22:13:20.000Z',
    });
    expect(coreQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM identity_accounts account'),
      ['tenant-1', 'user-1']
    );
    const otpSql = String(coreQueryOne.mock.calls[0]?.[0]);
    expect(otpSql).toContain('contact.subject_id = subject.id');
    expect(otpSql).toContain('contact.account_id = account.id');
    expect(otpSql).not.toContain('contact.account_id = account.id OR');
    expect(piiQueryOne).not.toHaveBeenCalled();
  });

  it('updates verification and last-login metadata in one Core batch', async () => {
    const coreQueryOne = vi.fn(async () => ({
      id: 'account:user-1',
      tenant_id: 'tenant-1',
      account_type: 'end_user',
      lifecycle_state: 'active',
      legacy_user_id: 'user-1',
      primary_subject_id: 'subject:user-1',
      display_label: 'User One',
      metadata_json: JSON.stringify({ source: 'test' }),
      directory_publication_state: 'active',
      account_route_generation: 1,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    }));
    const batch = vi.fn(async () => [
      { success: true, rowsAffected: 1 },
      { success: true, rowsAffected: 1 },
    ]);
    const piiQueryOne = vi.fn();
    const store = new CanonicalRuntimeUserStore({
      tenantId: 'tenant-1',
      coreAdapter: adapter({ queryOne: coreQueryOne, batch, getType: () => 'd1' }),
      piiAdapter: adapter({ queryOne: piiQueryOne }),
    });

    await expect(store.markEmailVerifiedAndTouchLastLogin('user-1', 1234)).resolves.toBe(true);
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        sql: expect.stringContaining('UPDATE contact_points'),
        params: [1234, 'tenant-1', 'account:user-1', 'subject:user-1'],
      }),
      expect.objectContaining({
        sql: expect.stringContaining('UPDATE identity_accounts'),
        params: [1234, 1234, 1234, 'tenant-1', 'user-1', 'account:user-1', 1234],
      }),
    ]);
    expect(piiQueryOne).not.toHaveBeenCalled();
  });

  it('marks an OTP email verified with one Core statement and no account read', async () => {
    const coreQueryOne = vi.fn();
    const execute = vi.fn(async () => ({ success: true, rowsAffected: 1 }));
    const batch = vi.fn();
    const store = new CanonicalRuntimeUserStore({
      tenantId: 'tenant-1',
      coreAdapter: adapter({ queryOne: coreQueryOne, execute, batch }),
      piiAdapter: adapter(),
    });

    await expect(store.markEmailVerifiedForOtpLogin('user-1', 1234)).resolves.toBe(true);
    expect(coreQueryOne).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE contact_points'), [
      1234,
      'tenant-1',
      'tenant-1',
      'user-1',
      'tenant-1',
      'user-1',
    ]);
  });
});
