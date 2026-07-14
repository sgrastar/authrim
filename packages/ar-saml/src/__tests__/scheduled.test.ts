import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  observe: vi.fn(),
  audit: vi.fn(async () => undefined),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLog: mocks.audit,
    createLogger: () => ({
      module: () => ({ debug: mocks.debug, warn: mocks.warn, error: mocks.error }),
    }),
  };
});

vi.mock('../idp/slo-state', () => ({
  observeExpiredSAMLIdPLogoutFanoutTransactions: mocks.observe,
}));

import { handleScheduled } from '../scheduled';

describe('SAML scheduled logout observation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the scheduled timestamp and exits quietly when no transaction expired', async () => {
    mocks.observe.mockResolvedValue({ scanned: 3, updated: 0, timedOutTransactions: [] });
    await handleScheduled(
      { scheduledTime: 1234, cron: '*/5 * * * *' },
      { STATE_STORE: {} } as never,
      {} as never
    );
    expect(mocks.observe).toHaveBeenCalledWith(expect.anything(), { now: 1234 });
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
    await handleScheduled({}, { STATE_STORE: {} } as never, {} as never);
    expect(mocks.warn).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant-a', severity: 'warning' })
    );
  });

  it('contains observation failures without rejecting the scheduled event', async () => {
    mocks.observe.mockRejectedValue(new Error('state unavailable'));
    await expect(handleScheduled({}, {} as never, {} as never)).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalled();
  });
});
