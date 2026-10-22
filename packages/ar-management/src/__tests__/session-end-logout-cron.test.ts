import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logoutJobs: vi.fn(async () => undefined),
}));

vi.mock('../admin-job-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../admin-job-executor')>()),
  processPendingSessionEndLogoutJobs: mocks.logoutJobs,
}));

vi.mock('../agent-elevation-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-elevation-recovery')>()),
  processScheduledAgentElevationRecovery: vi.fn(async () => undefined),
}));
vi.mock('../agent-token-revocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-token-revocation')>()),
  processScheduledAgentTokenRevocations: vi.fn(async () => undefined),
}));
vi.mock('../agent-payload-retention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-payload-retention')>()),
  processScheduledAgentPayloadRetention: vi.fn(async () => undefined),
}));

describe('downstream logout jobs in the scheduled run', () => {
  it('are sent by the every-minute cron, and a failure there stops nothing else', async () => {
    const worker = (await import('../index')).default;
    mocks.logoutJobs.mockRejectedValueOnce(new Error('admin database unavailable'));
    await expect(
      worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() } as never, {} as never)
    ).resolves.toBeUndefined();
    expect(mocks.logoutJobs).toHaveBeenCalledTimes(1);

    // Not on the other crons (the five-minute admin job run leaves them out).
    await worker.scheduled(
      { cron: '*/2 * * * *', scheduledTime: Date.now() } as never,
      {
        DB_ADMIN: undefined,
      } as never
    );
    expect(mocks.logoutJobs).toHaveBeenCalledTimes(1);
    // The first import of the whole worker entry is slow on a loaded runner.
  }, 60_000);
});
