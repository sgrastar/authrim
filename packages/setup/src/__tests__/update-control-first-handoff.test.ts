import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  createControlCoordinatorDeployer,
  isControlRecordedInLock,
  runControlRolloutHandoffSequence,
  shouldDeployControlBeforeRolloutHandoff,
} from '../core/release-control-first.js';

describe('Control is deployed before it is handed the migration release', () => {
  describe('isControlRecordedInLock', () => {
    it('counts a final ar-control Worker record', () => {
      expect(
        isControlRecordedInLock({
          workers: { 'ar-control': { name: 'prod-ar-control', version: '0.4.2' } },
        })
      ).toBe(true);
    });

    it('counts an ownership checkpoint left by an interrupted ar-control deployment', () => {
      expect(
        isControlRecordedInLock({
          workers: {},
          workerScriptOwnership: {
            'ar-control': {
              name: 'prod-ar-control',
              cloudflareScriptTag: 'a3a02205504f4eda9765e1944959e012',
              state: 'provisional',
              updatedAt: '2026-10-09T00:00:00.000Z',
            },
          },
        })
      ).toBe(true);
    });

    it('treats a lock with neither record as a first Control install', () => {
      expect(
        isControlRecordedInLock({
          workers: { 'ar-auth': { name: 'prod-ar-auth', version: '0.4.2' } },
          workerScriptOwnership: {},
        })
      ).toBe(false);
    });
  });

  describe('shouldDeployControlBeforeRolloutHandoff', () => {
    it('deploys ar-control first when it is updated and managed streams are handed off', () => {
      expect(
        shouldDeployControlBeforeRolloutHandoff({
          componentsToUpdate: ['ar-auth', 'ar-control'],
          controlManagedStreamIds: ['core-d1'],
          handoffAlreadyCreated: false,
          controlAlreadyDeployed: true,
        })
      ).toBe(true);
    });

    it('keeps the earlier order when ar-control is not updated (database-only update)', () => {
      expect(
        shouldDeployControlBeforeRolloutHandoff({
          componentsToUpdate: [],
          controlManagedStreamIds: ['core-d1'],
          handoffAlreadyCreated: false,
          controlAlreadyDeployed: true,
        })
      ).toBe(false);
      expect(
        shouldDeployControlBeforeRolloutHandoff({
          componentsToUpdate: ['ar-auth'],
          controlManagedStreamIds: ['core-d1'],
          handoffAlreadyCreated: false,
          controlAlreadyDeployed: true,
        })
      ).toBe(false);
    });

    it('keeps the earlier order without managed streams', () => {
      expect(
        shouldDeployControlBeforeRolloutHandoff({
          componentsToUpdate: ['ar-control'],
          controlManagedStreamIds: [],
          handoffAlreadyCreated: false,
          controlAlreadyDeployed: true,
        })
      ).toBe(false);
    });

    it('keeps the earlier order when ar-control is not deployed yet (first Control install)', () => {
      expect(
        shouldDeployControlBeforeRolloutHandoff({
          componentsToUpdate: ['ar-control', 'ar-auth'],
          controlManagedStreamIds: ['core-d1'],
          handoffAlreadyCreated: false,
          controlAlreadyDeployed: false,
        })
      ).toBe(false);
    });

    it('keeps the earlier order when a resumed update already owns a handoff row', () => {
      expect(
        shouldDeployControlBeforeRolloutHandoff({
          componentsToUpdate: ['ar-control'],
          controlManagedStreamIds: ['core-d1'],
          handoffAlreadyCreated: true,
          controlAlreadyDeployed: true,
        })
      ).toBe(false);
    });
  });

  describe('runControlRolloutHandoffSequence', () => {
    function steps(calls: string[]) {
      return {
        deployControl: vi.fn(async () => {
          calls.push('deploy-control');
          return 'deployed';
        }),
        publishRelease: vi.fn(async () => {
          calls.push('publish');
          return 'artifact';
        }),
        createHandoff: vi.fn(async (published: string) => {
          calls.push(`handoff:${published}`);
          return 'operation';
        }),
      };
    }

    it('deploys ar-control before the release is published and the handoff row is created', async () => {
      const calls: string[] = [];
      const result = await runControlRolloutHandoffSequence({
        deployControlFirst: true,
        ...steps(calls),
      });

      expect(calls).toEqual(['deploy-control', 'publish', 'handoff:artifact']);
      expect(result).toEqual({
        deployment: 'deployed',
        published: 'artifact',
        handoff: 'operation',
      });
    });

    it('keeps publish then handoff, without a deployment, when ar-control is not deployed first', async () => {
      const calls: string[] = [];
      const given = steps(calls);
      const result = await runControlRolloutHandoffSequence({
        deployControlFirst: false,
        ...given,
      });

      expect(calls).toEqual(['publish', 'handoff:artifact']);
      expect(given.deployControl).not.toHaveBeenCalled();
      expect(result.deployment).toBeUndefined();
    });

    it('creates no handoff and publishes nothing when the early ar-control deployment fails', async () => {
      const calls: string[] = [];
      const given = steps(calls);
      given.deployControl.mockRejectedValueOnce(
        new Error('control_coordinator_deploy_before_handoff_failed:ar-control: boom')
      );

      await expect(
        runControlRolloutHandoffSequence({ deployControlFirst: true, ...given })
      ).rejects.toThrow('control_coordinator_deploy_before_handoff_failed');

      expect(given.publishRelease).not.toHaveBeenCalled();
      expect(given.createHandoff).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });
  });

  describe('createControlCoordinatorDeployer', () => {
    type Options = { scope: string };

    it('deploys ar-control once with the scoped early options, and the regular stage reuses it', async () => {
      const deploy = vi.fn(async (options: Options) => ({ failedCount: 0, scope: options.scope }));
      const deployer = createControlCoordinatorDeployer({ deploy });
      const buildScoped = vi.fn(async () => ({ scope: 'ar-control-only' }));

      expect(deployer.completed).toBe(false);
      const early = await deployer.deployEarly(buildScoped);
      const regular = await deployer.deployRegular({ scope: 'whole-update' });

      expect(deploy).toHaveBeenCalledTimes(1);
      expect(deploy).toHaveBeenCalledWith({ scope: 'ar-control-only' });
      expect(regular).toBe(early);
      expect(deployer.completed).toBe(true);
    });

    it('deploys with the regular options when no early stage ran, without building scoped ones', async () => {
      const deploy = vi.fn(async (options: Options) => ({ failedCount: 0, scope: options.scope }));
      const deployer = createControlCoordinatorDeployer({ deploy });

      await deployer.deployRegular({ scope: 'whole-update' });
      await deployer.deployRegular({ scope: 'ignored-second-time' });

      expect(deploy).toHaveBeenCalledTimes(1);
      expect(deploy).toHaveBeenCalledWith({ scope: 'whole-update' });
    });

    it('shares one in-flight deployment between concurrent stages', async () => {
      const deploy = vi.fn(async () => 'summary');
      const deployer = createControlCoordinatorDeployer({ deploy });

      await Promise.all([
        deployer.deployEarly(async () => ({ scope: 'a' })),
        deployer.deployRegular({ scope: 'b' }),
      ]);

      expect(deploy).toHaveBeenCalledTimes(1);
    });

    it('does not deploy when the scoped options cannot be built, and allows a retry', async () => {
      const deploy = vi.fn(async () => 'summary');
      const deployer = createControlCoordinatorDeployer<Options, string>({ deploy });

      await expect(
        deployer.deployEarly(async () => {
          throw new Error('required_worker_secret_missing');
        })
      ).rejects.toThrow('required_worker_secret_missing');
      expect(deploy).not.toHaveBeenCalled();
      expect(deployer.completed).toBe(false);

      await expect(deployer.deployRegular({ scope: 'whole-update' })).resolves.toBe('summary');
      expect(deploy).toHaveBeenCalledTimes(1);
    });

    it('allows an explicit retry after a failed deployment attempt', async () => {
      const deploy = vi
        .fn<(options: Options) => Promise<string>>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce('summary');
      const deployer = createControlCoordinatorDeployer({ deploy });

      await expect(deployer.deployRegular({ scope: 'x' })).rejects.toThrow('boom');
      await expect(deployer.deployRegular({ scope: 'x' })).resolves.toBe('summary');
      expect(deploy).toHaveBeenCalledTimes(2);
    });
  });

  // updateCommand is too large to execute with mocks; these only pin how it is wired to the
  // behaviour tested above.
  describe('update command wiring', () => {
    async function updateSource(): Promise<string> {
      const source = await readFile(new URL('../cli/commands/update.ts', import.meta.url), 'utf-8');
      return source.slice(source.indexOf('export async function updateCommand('));
    }

    it('creates the rollout row only as the last step of the ordered sequence', async () => {
      const source = await updateSource();

      expect(source.split('await createReleaseRolloutHandoff({').length - 1).toBe(1);
      expect(source).toContain('deployControl: deployControlBeforeHandoff,');
      expect(source).toContain('createHandoff: createInitialHandoff,');
      expect(source.split('createInitialHandoff').length - 1).toBe(2);
    });

    it('scopes the early deployment options to ar-control and builds fresh ones for the whole update later', async () => {
      const source = await updateSource();
      const early = source.indexOf("buildDeployOptions(['ar-control'], ['ar-control'])");
      const sync = source.indexOf('await syncWranglerConfigs({');
      const regular = source.indexOf(
        'await buildDeployOptions(componentsToUpdate, CORE_WORKER_COMPONENTS)'
      );

      expect(early).toBeGreaterThan(0);
      expect(sync).toBeGreaterThan(early);
      expect(regular).toBeGreaterThan(sync);
      expect(source.split('buildDeployOptions(').length - 1).toBe(2);
      expect(source).toContain('controlCoordinatorDeployment.deployRegular(deployOptions)');
    });

    it('lets worker ownership checkpoints land on the current lock', async () => {
      const source = await updateSource();

      expect(source).toContain('currentLock: () => workingLock,');
    });

    it('prints the new order in the dry-run plan', async () => {
      const source = await updateSource();

      expect(source).toContain('if (deployControlFirst)');
      expect(source).toContain('deploy ar-control → publish migration release');
    });
  });
});
