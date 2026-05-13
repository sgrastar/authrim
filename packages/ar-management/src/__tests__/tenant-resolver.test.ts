import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

const { mockCreateAuthContextFromHono, mockGetTenantIdFromContext } = vi.hoisted(() => ({
  mockCreateAuthContextFromHono: vi.fn(),
  mockGetTenantIdFromContext: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  createAuthContextFromHono: mockCreateAuthContextFromHono,
  getTenantIdFromContext: mockGetTenantIdFromContext,
}));

import {
  resolveSettingsCoreAdapter,
  resolveSettingsTenantId,
} from '../routes/settings/tenant-resolver';

const mockCoreAdapter = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  batch: vi.fn(),
  isHealthy: vi.fn(),
  getType: vi.fn(),
  close: vi.fn(),
} as unknown as DatabaseAdapter;

describe('tenant-resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTenantIdFromContext.mockReturnValue('tenant-from-context');
    mockCreateAuthContextFromHono.mockReturnValue({ coreAdapter: mockCoreAdapter });
  });

  it('resolves the context tenant id', () => {
    const tenantId = resolveSettingsTenantId({ env: {} } as never);

    expect(tenantId).toBe('tenant-from-context');
  });

  it('rejects missing tenant context', () => {
    mockGetTenantIdFromContext.mockReturnValue(null);

    expect(() => resolveSettingsTenantId({ env: {} } as never)).toThrow(
      'Settings routes require tenant context'
    );
  });

  it('resolves core adapter through createAuthContextFromHono', () => {
    const context = { env: {} };

    const adapter = resolveSettingsCoreAdapter(context as never);

    expect(adapter).toBe(mockCoreAdapter);
    expect(mockCreateAuthContextFromHono).toHaveBeenCalledWith(context, 'tenant-from-context');
  });
});
