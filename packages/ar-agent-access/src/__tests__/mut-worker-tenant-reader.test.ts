import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), queryOne: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  resolveAuthCorePersistenceAdapterFromEnv: mocks.resolve,
}));

import { CloudflareTenantConfigurationReader } from '../platform/cloudflare/tenant-configuration-reader';
import {
  AGENT_ACCESS_MCP_SESSION_ABSOLUTE_MS,
  AGENT_ACCESS_MCP_SESSION_IDLE_MS,
} from '../platform/cloudflare/mcp-session-policy';

function step(input: Record<string, unknown>) {
  return {
    tenantId: 'tenant-1',
    step: {
      id: 'step-1',
      operation: 'admin.write.clients.metadata',
      toolContractVersion: '1',
      input,
    },
  } as never;
}

describe('CloudflareTenantConfigurationReader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue({ queryOne: mocks.queryOne });
  });

  it('returns null for a client that no longer exists', async () => {
    mocks.queryOne.mockResolvedValue(null);
    await expect(
      new CloudflareTenantConfigurationReader({} as never).readCurrent(
        step({ client_id: 'gone', client_name: 'x' })
      )
    ).resolves.toBeNull();
  });

  it('never projects the precondition resource_version and fills absent fields with null', async () => {
    mocks.queryOne.mockResolvedValue({
      tenant_id: 'tenant-1',
      client_id: 'c-1',
      client_name: 'Now',
    });
    await expect(
      new CloudflareTenantConfigurationReader({} as never).readCurrent(
        step({ client_id: 'c-1', resource_version: 'v1', client_name: 'x', description: 'y' })
      )
    ).resolves.toEqual({ client_name: 'Now', description: null });
  });

  it('requires a string client_id before resolving storage', async () => {
    await expect(
      new CloudflareTenantConfigurationReader({} as never).readCurrent(step({ client_id: 1 }))
    ).rejects.toThrow(new TypeError('Baseline client_id is missing'));
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});

describe('MCP session lifetime policy', () => {
  it('idles sessions out after 30 minutes and ends them after 8 hours', () => {
    expect(AGENT_ACCESS_MCP_SESSION_IDLE_MS).toBe(30 * 60 * 1000);
    expect(AGENT_ACCESS_MCP_SESSION_ABSOLUTE_MS).toBe(8 * 60 * 60 * 1000);
  });
});
