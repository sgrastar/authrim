import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { GraphDefinition } from '../flow-engine/types';
import { FlowRegistry } from '../flow-engine/flow-registry';

function createMockAdapter(): DatabaseAdapter {
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  };
}

function createGraphDefinition(id: string): GraphDefinition {
  return {
    id,
    flowVersion: '1.0.0',
    name: id,
    description: `${id} description`,
    profileId: 'human-basic',
    nodes: [],
    edges: [],
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'test-user',
    },
  };
}

describe('FlowRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a DatabaseAdapter source for client-specific flow lookups', async () => {
    const adapter = createMockAdapter();
    const clientFlow = createGraphDefinition('client-flow');

    vi.mocked(adapter.query).mockImplementation(async (_sql, params) => {
      if (params?.[2] === 'client-1') {
        return [{ graph_definition: JSON.stringify(clientFlow) }];
      }
      return [];
    });

    const registry = new FlowRegistry({ db: adapter });
    const result = await registry.getFlow('login', 'tenant-1', 'client-1');

    expect(result).toEqual(clientFlow);
    expect(adapter.query).toHaveBeenCalledWith(expect.stringContaining('FROM flows'), [
      'tenant-1',
      'human-basic',
      'client-1',
    ]);
  });

  it('falls back to the tenant default flow when client-specific flow is absent', async () => {
    const adapter = createMockAdapter();
    const tenantFlow = createGraphDefinition('tenant-default-flow');

    vi.mocked(adapter.query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ graph_definition: JSON.stringify(tenantFlow) }]);

    const registry = new FlowRegistry({ db: adapter });
    const result = await registry.getFlow('login', 'tenant-1', 'client-1');

    expect(result).toEqual(tenantFlow);
    expect(adapter.query).toHaveBeenNthCalledWith(1, expect.stringContaining('client_id = ?'), [
      'tenant-1',
      'human-basic',
      'client-1',
    ]);
    expect(adapter.query).toHaveBeenNthCalledWith(2, expect.stringContaining('client_id IS NULL'), [
      'tenant-1',
      'human-basic',
    ]);
  });

  it('returns the built-in login flow when no custom flow is configured', async () => {
    const registry = new FlowRegistry();
    const result = await registry.getFlow('login', 'tenant-1', 'client-1');

    expect(result?.id).toBe('human-basic-login');
    expect(registry.getBuiltinFlowIds()).toEqual(['human-basic-login']);
  });

  it('falls back to a legacy KV custom flow when no database or built-in flow exists', async () => {
    const kvFlow = createGraphDefinition('kv-authorization-flow');
    const kv = {
      get: vi.fn().mockResolvedValue(kvFlow),
    } as unknown as KVNamespace;

    const registry = new FlowRegistry({ kv });
    const result = await registry.getFlow('authorization', 'tenant-1');

    expect(result).toEqual(kvFlow);
    expect(kv.get).toHaveBeenCalledWith('flow:tenant-1:authorization', 'json');
  });

  it('ignores malformed database rows and falls through to null when no fallback exists', async () => {
    const adapter = createMockAdapter();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(adapter.query).mockResolvedValueOnce([{ graph_definition: '{not-json' }]);

    const registry = new FlowRegistry({ db: adapter });
    const result = await registry.getFlow('logout', 'tenant-1');

    expect(result).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get flow from database')
    );

    consoleError.mockRestore();
  });
});
