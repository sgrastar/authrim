import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), queryOne: vi.fn() }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, resolveAuthCorePersistenceAdapterFromEnv: mocks.resolve };
});

import { CloudflareTenantConfigurationReader } from '../tenant-configuration-reader';

describe('CloudflareTenantConfigurationReader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue({ queryOne: mocks.queryOne } as unknown as DatabaseAdapter);
    mocks.queryOne.mockResolvedValue({
      tenant_id: 'tenant-1',
      client_id: 'client-1',
      client_name: 'Current client',
      description: 'Current description',
      updated_at: 10,
    });
  });

  it('resolves the target tenant database and returns only expected declarative fields', async () => {
    const reader = new CloudflareTenantConfigurationReader({} as never);
    await expect(
      reader.readCurrent({
        tenantId: 'tenant-1',
        step: {
          id: 'step-1',
          operation: 'admin.write.clients.metadata',
          toolContractVersion: '1',
          input: {
            client_id: 'client-1',
            client_name: 'Expected client',
          },
          resourcePrecondition: 'per-tenant-validation',
        },
      })
    ).resolves.toEqual({ client_name: 'Current client' });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), 'agent-baseline-evaluation', {
      tenantId: 'tenant-1',
    });
  });

  it('rejects an operation without a trusted owner-state reader', async () => {
    const reader = new CloudflareTenantConfigurationReader({} as never);
    await expect(
      reader.readCurrent({
        tenantId: 'tenant-1',
        step: {
          id: 'step-1',
          operation: 'admin.write.users.suspend',
          toolContractVersion: '1',
          input: { user_id: 'user-1' },
        },
      })
    ).rejects.toThrow('Unsupported Baseline operation');
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
