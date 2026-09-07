import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import type { Env } from '../../types/env';

const mocks = vi.hoisted(() => ({
  ensureDatabaseAdapter: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../db', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../db')>();
  return { ...original, ensureDatabaseAdapter: mocks.ensureDatabaseAdapter };
});

import { assignSystemAdminRole, getSystemInitStatus } from '../system-init';

function envWithAdminBinding(): Env {
  return { DB_ADMIN: { prepare: vi.fn(), batch: vi.fn() } } as unknown as Env;
}

describe('system initialization database authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureDatabaseAdapter.mockReturnValue({
      queryOne: mocks.queryOne,
      execute: mocks.execute,
    } as unknown as DatabaseAdapter);
  });

  it('uses DB_ADMIN as the sole initialization authority', async () => {
    const env = envWithAdminBinding();
    mocks.queryOne.mockResolvedValueOnce({ count: 1 });

    await expect(getSystemInitStatus(env)).resolves.toEqual({ initialized: true, adminCount: 1 });
    expect(mocks.ensureDatabaseAdapter).toHaveBeenCalledWith(env.DB_ADMIN, 'admin-init');
    expect(mocks.queryOne.mock.calls[0]?.[0]).toContain('FROM admin_role_assignments');
    expect(mocks.queryOne.mock.calls[0]?.[0]).not.toContain('identity_accounts');
  });

  it('fails closed when DB_ADMIN cannot be queried', async () => {
    mocks.queryOne.mockRejectedValueOnce(new Error('admin database unavailable'));

    await expect(getSystemInitStatus(envWithAdminBinding())).resolves.toEqual({
      initialized: false,
      adminCount: 0,
    });
    expect(mocks.ensureDatabaseAdapter).toHaveBeenCalledTimes(1);
  });

  it('assigns only the DB_ADMIN super_admin role', async () => {
    mocks.queryOne.mockResolvedValueOnce({ id: 'role-super-admin' }).mockResolvedValueOnce(null);
    mocks.execute.mockResolvedValueOnce({ rowsAffected: 1 });

    await assignSystemAdminRole(envWithAdminBinding(), 'admin-user', 'tenant-a');

    expect(mocks.queryOne.mock.calls[0]?.[0]).toContain('FROM admin_roles');
    expect(mocks.queryOne.mock.calls[1]?.[0]).toContain('FROM admin_role_assignments');
    expect(mocks.execute.mock.calls[0]?.[0]).toContain('INSERT INTO admin_role_assignments');
    expect(mocks.execute.mock.calls[0]?.[0]).not.toMatch(/INSERT INTO role_assignments\b/u);
  });
});
