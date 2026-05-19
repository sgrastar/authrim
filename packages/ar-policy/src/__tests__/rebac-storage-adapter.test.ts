import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => ({
  resolveOptionalCoreAdapterFromHono: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    resolveOptionalCoreAdapterFromHono: mocked.resolveOptionalCoreAdapterFromHono,
  };
});

import { getPolicyCoreAdapter } from '../rebac-storage-adapter';

describe('policy ReBAC storage adapter', () => {
  it('resolves policy storage through request-context runtime sources', () => {
    const adapter = { getType: vi.fn().mockReturnValue('tenant-policy') };
    const c = { env: {} } as Context<{ Bindings: Env }>;
    mocked.resolveOptionalCoreAdapterFromHono.mockReturnValue(adapter);

    expect(getPolicyCoreAdapter(c)).toBe(adapter);
    expect(mocked.resolveOptionalCoreAdapterFromHono).toHaveBeenCalledWith(c, 'policy');
  });

  it('fails closed when no policy storage source is available', () => {
    const c = { env: {} } as Context<{ Bindings: Env }>;
    mocked.resolveOptionalCoreAdapterFromHono.mockReturnValue(null);

    expect(() => getPolicyCoreAdapter(c)).toThrow('Core database is required for policy storage');
  });
});
