import { expect, it, vi } from 'vitest';
import { runSamlDrCoveredOperation } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer';
import type { PluginRunnerEnv } from '../types';
const mocks = vi.hoisted(() => ({ finish: vi.fn<(id: string) => Promise<void>>() }));
vi.mock('@authrim/ar-lib-core/control-plane', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core/control-plane')>()),
  loadVerifiedPluginRunnerRegistry: vi.fn(async () => ({})),
}));
vi.mock('../registry-state', () => ({
  D1PluginRunnerStateRepository: class {
    async advanceSweep() {
      return null;
    }
    async claimDueShards() {
      return [
        { shardId: 'failed', bindingRef: 'missing' },
        { shardId: 'pending', bindingRef: 'missing' },
      ];
    }
    finishShard(input: { claim: { shardId: string } }) {
      return mocks.finish(input.claim.shardId);
    }
  },
}));
import { PluginRunnerScheduler } from '../scheduler';

it('retains admission when a failed shard leaves another shard write in progress', async () => {
  let finish!: () => void;
  const write = new Promise<void>((resolve) => {
    finish = resolve;
  });
  mocks.finish.mockImplementation(async (id) => {
    if (id === 'failed') throw new Error('shard checkpoint failed');
    await write;
  });
  const complete = vi.fn(async () => undefined);
  const env = {
    ENABLE_SAML_DR_EXPORT: 'true',
    SAML_DR_MUTATION_CONTROL: {
      acquireEnvironmentBackupMutationPermit: vi.fn(async () => ({ admitted: true })),
      completeEnvironmentBackupMutationPermit: complete,
    },
  } as unknown as PluginRunnerEnv;
  const pending = runSamlDrCoveredOperation(env, undefined, (covered) =>
    new PluginRunnerScheduler(covered).run()
  );
  const rejection = expect(pending).rejects.toThrow('shard checkpoint failed');
  await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledTimes(2));
  expect(complete).not.toHaveBeenCalled();
  finish();
  await rejection;
  expect(complete).toHaveBeenCalledOnce();
});
