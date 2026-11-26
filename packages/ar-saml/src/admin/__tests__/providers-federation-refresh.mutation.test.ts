/**
 * handleRefreshFederationMetadataSource: permission/route guards, the step-up gate handed to the
 * poller, audit contents and the mapping of refresh failure codes to HTTP answers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdapter, harnessContext, parseJson } from './helpers/provider-handler-harness';

vi.mock('../../mapping-set-owner', () => ({
  resolveSAMLMappingSetOwner: vi.fn(async (_adapter: unknown, tenantId: string) => tenantId),
}));

const mocks = vi.hoisted(() => ({
  stepUp: vi.fn(async (..._args: unknown[]): Promise<Response | null> => null),
  adapter: null as ReturnType<typeof createAdapter> | null,
  audit: vi.fn(async (..._args: unknown[]) => undefined),
  refresh: vi.fn(),
  capability: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  logWarn: vi.fn(),
  errors: [] as Array<{ code: string; options: unknown }>,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireAdminStepUp: mocks.stepUp,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    createAuditLog: mocks.audit,
    tenantCapabilityRefusal: mocks.capability,
    createErrorResponse: (c: never, code: string, options?: unknown) => {
      mocks.errors.push({ code, options });
      return (actual.createErrorResponse as (...args: unknown[]) => unknown)(c, code, options);
    },
    getLogger: () => ({
      module: () => ({
        error: vi.fn(),
        warn: mocks.logWarn,
        info: vi.fn(),
        debug: vi.fn(),
      }),
    }),
  };
});

vi.mock('../metadata-polling', () => ({ refreshFederationMetadataSource: mocks.refresh }));

import { handleRefreshFederationMetadataSource } from '../providers';

function adapter() {
  if (!mocks.adapter) throw new Error('adapter not initialised');
  return mocks.adapter;
}

function auditEntries(): Array<Record<string, unknown>> {
  return mocks.audit.mock.calls.map((call) => call[1] as Record<string, unknown>);
}

const RESULT = {
  changed: true,
  entityCount: 12,
  providersUpdated: 3,
  providersMissing: 2,
  providersFailed: 1,
  verificationStatus: 'verified',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.errors.length = 0;
  mocks.adapter = createAdapter();
  mocks.refresh.mockReset();
  mocks.capability.mockResolvedValue(null);
});

describe('guards', () => {
  it('refuses a caller without the refresh permission', async () => {
    const response = await handleRefreshFederationMetadataSource(
      harnessContext({ id: 'src-1', permissions: [] })
    );

    expect(response.status).toBe(403);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('answers 404 without a source id', async () => {
    const response = await handleRefreshFederationMetadataSource(harnessContext({}));

    expect(response.status).toBe(404);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('answers with the capability refusal while metadata URLs are switched off', async () => {
    mocks.capability.mockResolvedValue({
      status: 503,
      body: { error: 'temporarily_unavailable' },
    });

    const response = await handleRefreshFederationMetadataSource(harnessContext({ id: 'src-1' }));

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('answers a 403 capability refusal without a Retry-After header', async () => {
    mocks.capability.mockResolvedValue({
      status: 403,
      body: { error: 'capability_disabled' },
    });

    const response = await handleRefreshFederationMetadataSource(harnessContext({ id: 'src-1' }));

    expect(response.status).toBe(403);
    expect(response.headers.get('Retry-After')).toBeNull();
  });
});

describe('successful refresh', () => {
  it('runs a manual refresh for the tenant and reports the result with an audit entry', async () => {
    mocks.refresh.mockResolvedValue(RESULT);

    const response = await handleRefreshFederationMetadataSource(harnessContext({ id: 'src-1' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, ...RESULT });
    expect(mocks.refresh.mock.calls[0]?.slice(1, 5)).toEqual([
      'src-1',
      'tenant-a',
      'manual',
      undefined,
    ]);
    expect(auditEntries()).toHaveLength(1);
    expect(auditEntries()[0]).toMatchObject({
      action: 'saml.federation.metadata_refresh_requested',
      resource: 'federation_trust_source',
      resourceId: 'src-1',
      severity: 'info',
    });
    expect(parseJson(String(auditEntries()[0]?.metadata))).toEqual({
      protocol: 'saml',
      changed: true,
      entity_count: 12,
      providers_updated: 3,
      providers_missing: 2,
      providers_failed: 1,
      verification_status: 'verified',
    });
  });

  it('hands the poller a gate that applies the step-up and passes when it allows', async () => {
    mocks.refresh.mockImplementation(async (...args: unknown[]) => {
      await (args[5] as () => Promise<void>)();
      return RESULT;
    });

    const response = await handleRefreshFederationMetadataSource(harnessContext({ id: 'src-1' }));

    expect(response.status).toBe(200);
    expect(mocks.stepUp).toHaveBeenCalledTimes(1);
  });

  it('returns the step-up refusal itself when the gate refuses, without auditing a failure', async () => {
    mocks.stepUp.mockResolvedValueOnce(new Response('step-up', { status: 428 }));
    mocks.refresh.mockImplementation(async (...args: unknown[]) => {
      await (args[5] as () => Promise<void>)();
      return RESULT;
    });

    const response = await handleRefreshFederationMetadataSource(harnessContext({ id: 'src-1' }));

    expect(response.status).toBe(428);
    expect(auditEntries()).toEqual([]);
  });
});

describe('failure mapping', () => {
  it.each([
    ['federation_source_not_found', 404],
    ['federation_source_metadata_url_required', 400],
    ['metadata_refresh_conflict', 409],
    ['metadata_refresh_superseded', 409],
    ['federation_trust_context_changed', 409],
    ['signature_invalid', 400],
  ])('maps %s to %i and audits the failure', async (code, status) => {
    mocks.refresh.mockRejectedValue(new Error(code));

    const response = await handleRefreshFederationMetadataSource(harnessContext({ id: 'src-1' }));

    expect(response.status).toBe(status);
    expect(auditEntries()[0]).toMatchObject({
      action: 'saml.federation.metadata_refresh_requested',
      resource: 'federation_trust_source',
      resourceId: 'src-1',
      severity: 'warning',
    });
  });

  it('names metadataUrl as the missing field', async () => {
    mocks.refresh.mockRejectedValue(new Error('federation_source_metadata_url_required'));

    await handleRefreshFederationMetadataSource(harnessContext({ id: 'src-1' }));

    expect((mocks.errors.at(-1)?.options as { variables: { field: string } }).variables.field).toBe(
      'metadataUrl'
    );
  });

  it('warns with the failure code for an unclassified error', async () => {
    mocks.refresh.mockRejectedValue(new Error('metadata_fetch_failed'));

    await handleRefreshFederationMetadataSource(harnessContext({ id: 'src-1' }));

    expect(mocks.logWarn).toHaveBeenCalledWith(
      'Federation metadata refresh failed',
      { sourceId: 'src-1', code: 'metadata_fetch_failed' },
      expect.any(Error)
    );
  });

  it('treats a non-Error rejection as a generic refresh failure', async () => {
    mocks.refresh.mockRejectedValue('boom');

    const response = await handleRefreshFederationMetadataSource(harnessContext({ id: 'src-1' }));

    expect(response.status).toBe(400);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'Federation metadata refresh failed',
      { sourceId: 'src-1', code: 'metadata_refresh_failed' },
      'boom'
    );
  });

  it('audits an unknown source id as "unknown"', async () => {
    mocks.refresh.mockRejectedValue(new Error('metadata_fetch_failed'));
    mocks.capability.mockResolvedValue(null);

    await handleRefreshFederationMetadataSource(harnessContext({ id: 'src-9' }));

    expect(auditEntries()[0]?.resourceId).toBe('src-9');
  });

  it('leaves the database untouched (the poller owns persistence)', async () => {
    mocks.refresh.mockResolvedValue(RESULT);

    await handleRefreshFederationMetadataSource(harnessContext({ id: 'src-1' }));

    expect(adapter().execute).not.toHaveBeenCalled();
  });
});
