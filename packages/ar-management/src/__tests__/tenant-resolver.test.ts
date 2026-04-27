import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

const {
  mockCreateAuthContextFromHono,
  mockGetDefaultTenantId,
  mockGetTenantIdFromContext,
} = vi.hoisted(() => ({
  mockCreateAuthContextFromHono: vi.fn(),
  mockGetDefaultTenantId: vi.fn(),
  mockGetTenantIdFromContext: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  createAuthContextFromHono: mockCreateAuthContextFromHono,
  getDefaultTenantId: mockGetDefaultTenantId,
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
    mockGetDefaultTenantId.mockReturnValue('tenant-default');
    mockCreateAuthContextFromHono.mockReturnValue({ coreAdapter: mockCoreAdapter });
  });

  it('prefers explicit tenant id', () => {
    const tenantId = resolveSettingsTenantId({ env: {} } as never, 'tenant-explicit');

    expect(tenantId).toBe('tenant-explicit');
    expect(mockGetTenantIdFromContext).not.toHaveBeenCalled();
  });

  it('falls back to context tenant id before environment default', () => {
    const tenantId = resolveSettingsTenantId({ env: {} } as never);

    expect(tenantId).toBe('tenant-from-context');
    expect(mockGetDefaultTenantId).not.toHaveBeenCalled();
  });

  it('resolves core adapter through createAuthContextFromHono', () => {
    const context = { env: {} };

    const adapter = resolveSettingsCoreAdapter(context as never, 'tenant-explicit');

    expect(adapter).toBe(mockCoreAdapter);
    expect(mockCreateAuthContextFromHono).toHaveBeenCalledWith(context, 'tenant-explicit');
  });
});
