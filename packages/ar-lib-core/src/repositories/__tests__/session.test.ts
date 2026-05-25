import { beforeEach, describe, expect, it } from 'vitest';
import { MockDatabaseAdapter } from './mock-adapter';
import { SessionRepository } from '../core/session';

describe('SessionRepository tenant isolation', () => {
  let adapter: MockDatabaseAdapter;

  const seedSessions = () => {
    adapter.initTable('sessions', 'id');
    adapter.seed('sessions', [
      {
        id: 'sess-a-1',
        tenant_id: 'tenant-a',
        user_id: 'shared-user',
        expires_at: Date.now() + 60_000,
        created_at: 300,
        external_provider_id: 'idp-a',
        external_provider_sub: 'shared-sub',
      },
      {
        id: 'sess-a-2',
        tenant_id: 'tenant-a',
        user_id: 'shared-user',
        expires_at: Date.now() + 120_000,
        created_at: 200,
        external_provider_id: 'idp-a',
        external_provider_sub: 'shared-sub',
      },
      {
        id: 'sess-b-1',
        tenant_id: 'tenant-b',
        user_id: 'shared-user',
        expires_at: Date.now() + 180_000,
        created_at: 100,
        external_provider_id: 'idp-b',
        external_provider_sub: 'shared-sub',
      },
    ]);
  };

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
  });

  it('lists duplicated user_id sessions only within the repository tenant', async () => {
    seedSessions();

    const tenantARepository = new SessionRepository(adapter, 'tenant-a');
    const tenantBRepository = new SessionRepository(adapter, 'tenant-b');

    const tenantASessions = await tenantARepository.findByUserId('shared-user', true);
    const tenantBSessions = await tenantBRepository.findByUserId('shared-user', true);

    expect(tenantASessions.map((session) => session.id)).toEqual(['sess-a-1', 'sess-a-2']);
    expect(tenantASessions.every((session) => session.tenant_id === 'tenant-a')).toBe(true);
    expect(tenantBSessions.map((session) => session.id)).toEqual(['sess-b-1']);
    expect(tenantBSessions[0]?.tenant_id).toBe('tenant-b');
  });

  it('deletes duplicated user_id sessions only within the repository tenant', async () => {
    seedSessions();

    const tenantARepository = new SessionRepository(adapter, 'tenant-a');
    const tenantBRepository = new SessionRepository(adapter, 'tenant-b');

    await expect(tenantARepository.deleteByUserId('shared-user')).resolves.toBe(2);

    await expect(tenantARepository.findByUserId('shared-user')).resolves.toEqual([]);
    await expect(tenantBRepository.findByUserId('shared-user')).resolves.toMatchObject([
      { id: 'sess-b-1', tenant_id: 'tenant-b' },
    ]);
  });

  it('counts duplicated user_id sessions only within the repository tenant', async () => {
    seedSessions();

    const tenantARepository = new SessionRepository(adapter, 'tenant-a');
    const tenantBRepository = new SessionRepository(adapter, 'tenant-b');

    await expect(tenantARepository.countByUserId('shared-user', true)).resolves.toBe(2);
    await expect(tenantBRepository.countByUserId('shared-user', true)).resolves.toBe(1);
  });

  it('rejects empty repository tenantId', () => {
    expect(() => new SessionRepository(adapter, '')).toThrow('SessionRepository requires tenantId');
  });
});
