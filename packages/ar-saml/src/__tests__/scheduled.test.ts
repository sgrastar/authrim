import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  observe: vi.fn(),
  poll: vi.fn(),
  audit: vi.fn(async () => undefined),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLog: mocks.audit,
    createLogger: () => ({
      module: () => ({
        debug: mocks.debug,
        info: mocks.info,
        warn: mocks.warn,
        error: mocks.error,
      }),
    }),
  };
});

vi.mock('../idp/slo-state', () => ({
  observeExpiredSAMLIdPLogoutFanoutTransactions: mocks.observe,
}));

vi.mock('../admin/metadata-polling', () => ({
  pollSAMLMetadata: mocks.poll,
}));

import { handleScheduled } from '../scheduled';

function createStateStore() {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

describe('SAML scheduled logout observation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poll.mockResolvedValue({
      federationSourcesProcessed: 0,
      federationSourcesFailed: 0,
      individualProvidersProcessed: 0,
      individualProvidersFailed: 0,
      tenantsProcessed: 0,
    });
  });

  it('uses the scheduled timestamp and exits quietly when no transaction expired', async () => {
    mocks.observe.mockResolvedValue({ scanned: 3, updated: 0, timedOutTransactions: [] });
    await handleScheduled(
      { scheduledTime: 1234, cron: '*/5 * * * *' },
      { STATE_STORE: createStateStore() } as never,
      {} as never
    );
    expect(mocks.observe).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ now: 1234, maxRecords: 100 })
    );
    expect(mocks.poll).toHaveBeenCalledWith(expect.anything(), 1234);
    expect(mocks.debug).toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('audits every timed-out fanout transaction using the current clock fallback', async () => {
    mocks.observe.mockResolvedValue({
      scanned: 1,
      updated: 1,
      timedOutTransactions: [
        {
          tenantId: 'tenant-a',
          transactionId: 'transaction-a',
          sessionIndex: undefined,
          targets: [
            {
              spEntityId: 'https://sp.example.test/entity',
              status: 'failed',
              requestId: undefined,
              failureReason: 'timeout',
            },
          ],
        },
      ],
    });
    await handleScheduled({}, { STATE_STORE: createStateStore() } as never, {} as never);
    expect(mocks.warn).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant-a', severity: 'warning' })
    );
  });

  it('starts metadata polling without waiting for logout observation to finish', async () => {
    let finishObservation!: (value: {
      scanned: number;
      updated: number;
      timedOutTransactions: never[];
    }) => void;
    mocks.observe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishObservation = resolve;
        })
    );

    const scheduled = handleScheduled(
      { scheduledTime: 1234 },
      { STATE_STORE: createStateStore() } as never,
      {} as never
    );
    await Promise.resolve();

    expect(mocks.poll).toHaveBeenCalledWith(expect.anything(), 1234);
    finishObservation({ scanned: 0, updated: 0, timedOutTransactions: [] });
    await scheduled;
  });

  it('contains observation failures without rejecting the scheduled event', async () => {
    mocks.observe.mockRejectedValue(new Error('state unavailable'));
    await expect(
      handleScheduled({}, { STATE_STORE: createStateStore() } as never, {} as never)
    ).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalled();
    expect(mocks.poll).toHaveBeenCalledOnce();
  });

  it('contains metadata polling failures without rejecting the scheduled event', async () => {
    mocks.observe.mockResolvedValue({ scanned: 0, updated: 0, timedOutTransactions: [] });
    mocks.poll.mockRejectedValue(new Error('metadata store unavailable'));
    await expect(
      handleScheduled({}, { STATE_STORE: createStateStore() } as never, {} as never)
    ).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalled();
  });
});
