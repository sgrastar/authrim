import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { AdminSessionRepository } from '../admin/admin-session';

function adapter() {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
  } as unknown as DatabaseAdapter;
}

describe('AdminSessionRepository tenant isolation', () => {
  it('requires a tenant at construction and rejects cross-tenant creation', async () => {
    const db = adapter();
    expect(() => new AdminSessionRepository(db, '  ')).toThrow(
      'AdminSessionRepository requires tenantId'
    );

    const repository = new AdminSessionRepository(db, 'tenant-a');
    await expect(
      repository.createSession({
        tenant_id: 'tenant-b',
        admin_user_id: 'admin-1',
        expires_at: Date.now() + 60_000,
      })
    ).rejects.toThrow('cannot create a session for another tenant');
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('creates sessions with the repository tenant and MFA evidence', async () => {
    const db = adapter();
    const repository = new AdminSessionRepository(db, 'tenant-a');

    const session = await repository.createSession({
      id: 'session-1',
      tenant_id: 'tenant-a',
      admin_user_id: 'admin-1',
      expires_at: Date.now() + 60_000,
      mfa_verified: true,
    });

    expect(session).toMatchObject({
      id: 'session-1',
      tenant_id: 'tenant-a',
      admin_user_id: 'admin-1',
      mfa_verified: true,
      mfa_verified_at: expect.any(Number),
    });
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining('tenant_id'), [
      'session-1',
      'tenant-a',
      'admin-1',
      null,
      null,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      1,
      expect.any(Number),
      null,
      null,
    ]);
  });

  it('records the sign-in passkey as the first passkey evidence', async () => {
    const db = adapter();
    const repository = new AdminSessionRepository(db, 'tenant-a');

    const session = await repository.createSession({
      id: 'session-1',
      tenant_id: 'tenant-a',
      admin_user_id: 'admin-1',
      expires_at: Date.now() + 60_000,
      mfa_verified: true,
      passkey_credential_id: 'credential-1',
    });

    expect(session.passkey_credential_id).toBe('credential-1');
    expect(session.passkey_verified_at).toBe(session.created_at);
    const params = vi.mocked(db.execute).mock.calls[0]?.[1] ?? [];
    expect(params.slice(-2)).toEqual([session.created_at, 'credential-1']);
  });

  it('records an in-session passkey verification only on a live session of its tenant', async () => {
    const db = adapter();
    const repository = new AdminSessionRepository(db, 'tenant-a');

    await expect(
      repository.recordPasskeyVerification('session-1', 'credential-2', 1_000)
    ).resolves.toBe(true);
    const [sql, params] = vi.mocked(db.execute).mock.calls[0] ?? [];
    expect(sql).toContain('tenant_id = ?');
    expect(sql).toContain('expires_at > ?');
    expect(params).toEqual([1_000, 'credential-2', 'tenant-a', 'session-1', 1_000]);

    vi.mocked(db.execute).mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    await expect(
      repository.recordPasskeyVerification('session-1', 'credential-2', 2_000)
    ).resolves.toBe(false);
  });

  it('does not let a generic session update forge passkey evidence', async () => {
    const db = adapter();
    const repository = new AdminSessionRepository(db, 'tenant-a');
    vi.mocked(db.queryOne).mockResolvedValue({
      id: 'session-1',
      tenant_id: 'tenant-a',
      admin_user_id: 'admin-1',
      created_at: 1,
      expires_at: Date.now() + 60_000,
      last_activity_at: 1,
      mfa_verified: 1,
      mfa_verified_at: 1,
      passkey_verified_at: null,
      passkey_credential_id: null,
    });

    await repository.update('session-1', {
      last_activity_at: 2,
      passkey_verified_at: Date.now(),
      passkey_credential_id: 'credential-x',
    });

    const updates = vi.mocked(db.execute).mock.calls.map(([sql]) => sql);
    expect(updates).toEqual([expect.stringContaining('last_activity_at = ?')]);
    expect(updates[0]).not.toContain('passkey_');
  });

  it.each([
    ['getSession', ['session-1']],
    ['getSessionIncludingExpired', ['session-1']],
    ['updateActivity', ['session-1']],
    ['extendSession', ['session-1', Date.now() + 60_000]],
    ['deleteSession', ['session-1']],
    ['deleteAllByUser', ['admin-1']],
    ['deleteAllByUserExcept', ['admin-1', 'session-1']],
    ['getSessionsByUser', ['admin-1']],
    ['countSessionsByUser', ['admin-1']],
    ['cleanupExpiredSessions', []],
    ['getSessionsByIp', ['203.0.113.5']],
  ] as const)('%s includes tenant_id in its SQL boundary', async (method, args) => {
    const db = adapter();
    const repository = new AdminSessionRepository(db, 'tenant-a');

    const callable = repository[method] as (...values: never[]) => Promise<unknown>;
    await callable.apply(repository, args as never);

    const calls = [
      ...vi.mocked(db.query).mock.calls,
      ...vi.mocked(db.queryOne).mock.calls,
      ...vi.mocked(db.execute).mock.calls,
    ];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toContain('tenant_id = ?');
    expect(calls[0]?.[1]).toContain('tenant-a');
  });
});
