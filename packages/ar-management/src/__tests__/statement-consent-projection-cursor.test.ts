import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({ directory: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  listEnvironmentTenantDefaultStores: mocks.directory,
}));
import { processStatementConsentProjectionJobs } from '../statement-consent-projection-jobs';

const log = { warn: vi.fn() };
function env(cursor: string | null) {
  const put = vi.fn(async () => undefined);
  return {
    env: {
      AUTHRIM_CONFIG: { get: vi.fn(async () => cursor), put },
      TENANT_RUNTIME_REGISTRY: {},
    } as unknown as Env,
    put,
  };
}

describe('statement consent projection tenant paging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.directory.mockResolvedValue([]);
  });

  it('asks the routed directory for the first page without a cursor when none is stored', async () => {
    // The directory rejects an empty string as a cursor (lookup_alias_cursor_invalid), which
    // stopped this scheduler on every run.
    await processStatementConsentProjectionJobs(env(null).env, log);
    expect(mocks.directory).toHaveBeenCalledTimes(1);
    const options = mocks.directory.mock.calls[0]?.[1] as { afterTenantId?: string };
    expect(options.afterTenantId).toBeUndefined();
  });

  it('resumes after the stored tenant', async () => {
    await processStatementConsentProjectionJobs(env('tenant-a').env, log);
    const options = mocks.directory.mock.calls[0]?.[1] as { afterTenantId?: string };
    expect(options.afterTenantId).toBe('tenant-a');
  });
});
