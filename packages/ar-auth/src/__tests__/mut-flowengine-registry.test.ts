/**
 * FlowRegistry - lookup priority, profile mapping and GraphDefinition validation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { FlowRegistry, createFlowRegistry, type FlowType } from '../flow-engine/flow-registry';

function adapterReturning(...rowSets: Array<Array<{ graph_definition: string }>>): DatabaseAdapter {
  const query = vi.fn();
  for (const rows of rowSets) query.mockResolvedValueOnce(rows);
  query.mockResolvedValue([]);
  return {
    query,
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  };
}

const valid = {
  id: 'custom',
  flowVersion: '1.0.0',
  name: 'Custom',
  nodes: [],
  edges: [],
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('FlowRegistry lookup order', () => {
  it('falls back to the built-in flow when the database has no tenant flow', async () => {
    const db = adapterReturning([], []);
    const result = await new FlowRegistry({ db }).getFlow('login', 'tenant-1', 'client-1');
    expect(result?.id).toBe('human-basic-login');
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('skips the client query without a clientId', async () => {
    const db = adapterReturning([{ graph_definition: JSON.stringify(valid) }]);
    const result = await new FlowRegistry({ db }).getFlow('login', 'tenant-1');
    expect(result).toEqual(valid);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('client_id IS NULL'), [
      'tenant-1',
      'human-basic',
    ]);
  });

  it.each(['authorization', 'consent', 'logout'] as FlowType[])(
    'maps %s to the human-basic profile',
    async (flowType) => {
      const db = adapterReturning([]);
      expect(await new FlowRegistry({ db }).getFlow(flowType, 'tenant-1')).toBeNull();
      expect(db.query).toHaveBeenCalledWith(expect.any(String), ['tenant-1', 'human-basic']);
    }
  );

  it('does not consult KV without a tenant id and returns null', async () => {
    const kv = { get: vi.fn() } as unknown as KVNamespace;
    expect(await new FlowRegistry({ kv }).getFlow('consent')).toBeNull();
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('factory creates a working registry', async () => {
    expect((await createFlowRegistry().getFlow('login'))?.id).toBe('human-basic-login');
  });
});

describe('FlowRegistry GraphDefinition validation', () => {
  it.each([
    ['a JSON string', '"just-a-string"'],
    ['a number', '42'],
    ['missing id', JSON.stringify({ ...valid, id: undefined })],
    ['numeric id', JSON.stringify({ ...valid, id: 1 })],
    ['numeric flowVersion', JSON.stringify({ ...valid, flowVersion: 1 })],
    ['missing name', JSON.stringify({ ...valid, name: undefined })],
    ['nodes not an array', JSON.stringify({ ...valid, nodes: {} })],
    ['edges not an array', JSON.stringify({ ...valid, edges: 'x' })],
  ])('rejects a database row that is %s', async (_label, graph_definition) => {
    const db = adapterReturning([{ graph_definition }]);
    expect(await new FlowRegistry({ db }).getFlow('consent', 'tenant-1')).toBeNull();
  });

  it('accepts a minimal valid database row', async () => {
    const db = adapterReturning([{ graph_definition: JSON.stringify(valid) }]);
    expect(await new FlowRegistry({ db }).getFlow('consent', 'tenant-1')).toEqual(valid);
  });

  it.each([
    ['a string', 'flow'],
    ['missing edges', { ...valid, edges: undefined }],
  ])('rejects a KV value that is %s', async (_label, stored) => {
    const kv = { get: vi.fn().mockResolvedValue(stored) } as unknown as KVNamespace;
    expect(await new FlowRegistry({ kv }).getFlow('consent', 'tenant-1')).toBeNull();
    expect(kv.get).toHaveBeenCalledWith('flow:tenant-1:consent', 'json');
  });
});
