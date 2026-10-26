import { expect, it, vi } from 'vitest';
const jobs = vi.hoisted(() => ({
  scheduler: vi.fn<() => Promise<void>>(),
  metrics: vi.fn<() => Promise<void>>(),
}));
vi.mock('../scheduler', () => ({
  PluginRunnerScheduler: class {
    run() {
      return jobs.scheduler();
    }
  },
}));
vi.mock('../r2-bucket-metrics', () => ({ scanAndReportPluginBundleMetrics: jobs.metrics }));
import PluginRunnerWorker from '../worker';

it('holds source admission after one scheduled branch fails until every started write settles', async () => {
  let finish!: () => void;
  const pendingWrite = new Promise<void>((resolve) => {
    finish = resolve;
  });
  jobs.scheduler.mockReturnValue(pendingWrite);
  jobs.metrics.mockRejectedValue(new Error('metrics failed'));
  const complete = vi.fn(async () => undefined);
  const worker = new PluginRunnerWorker(
    { waitUntil: vi.fn(), props: {} } as never,
    {
      ENABLE_SAML_DR_EXPORT: 'true',
      SAML_DR_MUTATION_CONTROL: {
        acquireEnvironmentBackupMutationPermit: vi.fn(async () => ({ admitted: true })),
        completeEnvironmentBackupMutationPermit: complete,
      },
    } as never
  );
  const result = worker.scheduled();
  const rejection = expect(result).rejects.toThrow('metrics failed');
  await vi.waitFor(() => expect(jobs.metrics).toHaveBeenCalledOnce());
  expect(complete).not.toHaveBeenCalled();
  finish();
  await rejection;
  expect(complete).toHaveBeenCalledOnce();
});
