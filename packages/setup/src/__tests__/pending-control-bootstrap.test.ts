import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearPendingControlBootstrap,
  loadPendingControlBootstrap,
  markPendingControlBootstrapRevocationConfirmed,
  stagePendingControlBootstrap,
  stagePendingControlBootstrapRecoveryToken,
  stageReconstructedPendingControlBootstrapRecovery,
  type PendingControlBootstrapArtifact,
} from '../core/pending-control-bootstrap.js';
import { getEnvironmentPaths } from '../core/paths.js';

const environment = 'cutover-test';
const artifact: PendingControlBootstrapArtifact = {
  version: 1,
  environment,
  accountId: '0'.repeat(32),
  ownership: 'account',
  bootstrapToken: 'durable-bootstrap-token-value',
  bootstrapTokenId: '1'.repeat(32),
  bootstrapTokenFingerprint: 'f6b1eae22149bd3420d2347d34c0d62b41b6dec90cbd8d3e0e331e174e155da9',
  childTokens: [
    {
      resourceClass: 'd1',
      tokenId: '2'.repeat(32),
      tokenName: 'authrim-cutover-test-00000000-control-d1',
      secretName: 'CLOUDFLARE_D1_API_TOKEN',
      tokenFingerprint: 'a'.repeat(64),
    },
    {
      resourceClass: 'workers',
      tokenId: '3'.repeat(32),
      tokenName: 'authrim-cutover-test-00000000-control-workers',
      secretName: 'CLOUDFLARE_WORKERS_API_TOKEN',
      tokenFingerprint: 'b'.repeat(64),
    },
  ],
  secretGeneration: { deploymentId: 'deployment-1', versionId: 'version-1' },
  revocationTargetTokenIds: ['1'.repeat(32)],
  recoveryToken: null,
  revocationConfirmed: false,
};

describe('pending Control bootstrap artifact', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(process.cwd(), '.authrim-pending-control-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('atomically stages the exact credential and child generation with mode 0600', async () => {
    await stagePendingControlBootstrap({ baseDir: root, artifact });
    const path = getEnvironmentPaths({ baseDir: root, env: environment }).pendingControlBootstrap;

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(loadPendingControlBootstrap({ baseDir: root, environment })).resolves.toEqual(
      artifact
    );
  });

  it('durably records confirmed revocation before terminal cleanup', async () => {
    await stagePendingControlBootstrap({ baseDir: root, artifact });
    await expect(
      markPendingControlBootstrapRevocationConfirmed({ baseDir: root, environment })
    ).resolves.toMatchObject({ revocationConfirmed: true });
    await expect(
      loadPendingControlBootstrap({ baseDir: root, environment })
    ).resolves.toMatchObject({
      bootstrapToken: artifact.bootstrapToken,
      revocationConfirmed: true,
    });

    await clearPendingControlBootstrap({ baseDir: root, environment });
    expect(
      existsSync(getEnvironmentPaths({ baseDir: root, env: environment }).pendingControlBootstrap)
    ).toBe(false);
  });

  it('stages each independent recovery token before use and retains prior IDs as targets', async () => {
    await stagePendingControlBootstrap({ baseDir: root, artifact });
    const first = await stagePendingControlBootstrapRecoveryToken({
      baseDir: root,
      environment,
      token: 'first-independent-recovery-token',
      tokenId: '4'.repeat(32),
    });
    expect(first.recoveryToken?.tokenId).toBe('4'.repeat(32));
    expect(first.revocationTargetTokenIds).toEqual([artifact.bootstrapTokenId]);

    const second = await stagePendingControlBootstrapRecoveryToken({
      baseDir: root,
      environment,
      token: 'second-independent-recovery-token',
      tokenId: '5'.repeat(32),
    });
    expect(second.recoveryToken?.tokenId).toBe('5'.repeat(32));
    expect(second.revocationTargetTokenIds).toEqual([artifact.bootstrapTokenId, '4'.repeat(32)]);
  });

  it('reconstructs a token-minimal v2 recovery artifact durably with mode 0600', async () => {
    const reconstructed = await stageReconstructedPendingControlBootstrapRecovery({
      baseDir: root,
      environment,
      accountId: artifact.accountId,
      ownership: artifact.ownership,
      bootstrapTokenId: artifact.bootstrapTokenId,
      bootstrapTokenFingerprint: artifact.bootstrapTokenFingerprint,
      childTokens: artifact.childTokens,
      secretGeneration: artifact.secretGeneration,
      recoveryToken: 'independent-recovery-token-value',
      recoveryTokenId: '4'.repeat(32),
    });
    const path = getEnvironmentPaths({ baseDir: root, env: environment }).pendingControlBootstrap;

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(reconstructed).toMatchObject({
      version: 2,
      bootstrapToken: null,
      bootstrapTokenId: artifact.bootstrapTokenId,
      recoveryToken: { tokenId: '4'.repeat(32) },
      revocationTargetTokenIds: [artifact.bootstrapTokenId],
      childTokens: artifact.childTokens,
      secretGeneration: artifact.secretGeneration,
    });
    await expect(loadPendingControlBootstrap({ baseDir: root, environment })).resolves.toEqual(
      reconstructed
    );
  });

  it('rejects reconstructed recovery authority that aliases bootstrap or child identity', async () => {
    const common = {
      baseDir: root,
      environment,
      accountId: artifact.accountId,
      ownership: artifact.ownership,
      bootstrapTokenId: artifact.bootstrapTokenId,
      bootstrapTokenFingerprint: artifact.bootstrapTokenFingerprint,
      childTokens: artifact.childTokens,
      secretGeneration: artifact.secretGeneration,
      recoveryToken: 'independent-recovery-token-value',
    } as const;
    await expect(
      stageReconstructedPendingControlBootstrapRecovery({
        ...common,
        recoveryTokenId: artifact.bootstrapTokenId,
      })
    ).rejects.toThrow('pending_control_bootstrap_invalid');
    await expect(
      stageReconstructedPendingControlBootstrapRecovery({
        ...common,
        recoveryTokenId: artifact.childTokens[0]!.tokenId,
      })
    ).rejects.toThrow('pending_control_bootstrap_invalid');
    await expect(
      stageReconstructedPendingControlBootstrapRecovery({
        ...common,
        recoveryToken: artifact.bootstrapToken,
        recoveryTokenId: '4'.repeat(32),
      })
    ).rejects.toThrow('pending_control_bootstrap_invalid');
  });

  it('rejects duplicate or bootstrap-aliased child secret fingerprints', async () => {
    await expect(
      stagePendingControlBootstrap({
        baseDir: root,
        artifact: {
          ...artifact,
          childTokens: [
            artifact.childTokens[0]!,
            {
              ...artifact.childTokens[1]!,
              tokenFingerprint: artifact.childTokens[0]!.tokenFingerprint,
            },
          ],
        },
      })
    ).rejects.toThrow('pending_control_bootstrap_invalid');
    await expect(
      stagePendingControlBootstrap({
        baseDir: root,
        artifact: {
          ...artifact,
          childTokens: [
            {
              ...artifact.childTokens[0]!,
              tokenFingerprint: artifact.bootstrapTokenFingerprint,
            },
            artifact.childTokens[1]!,
          ],
        },
      })
    ).rejects.toThrow('pending_control_bootstrap_invalid');
  });

  it('rejects a world-readable or corrupted recovery credential', async () => {
    await stagePendingControlBootstrap({ baseDir: root, artifact });
    const path = getEnvironmentPaths({ baseDir: root, env: environment }).pendingControlBootstrap;
    if (process.platform !== 'win32') {
      await chmod(path, 0o644);
      await expect(loadPendingControlBootstrap({ baseDir: root, environment })).rejects.toThrow(
        'pending_control_bootstrap_permissions_invalid'
      );
      await chmod(path, 0o600);
    }
    await writeFile(path, JSON.stringify({ ...artifact, bootstrapToken: 'different-value' }), {
      mode: 0o600,
    });
    await expect(loadPendingControlBootstrap({ baseDir: root, environment })).rejects.toThrow(
      'pending_control_bootstrap_invalid'
    );
  });

  it('does not follow a symlink for the recovery credential', async () => {
    const paths = getEnvironmentPaths({ baseDir: root, env: environment });
    await stagePendingControlBootstrap({ baseDir: root, artifact });
    const target = join(root, 'outside.json');
    await writeFile(target, JSON.stringify(artifact), { mode: 0o600 });
    await rm(paths.pendingControlBootstrap);
    await symlink(target, paths.pendingControlBootstrap);

    await expect(loadPendingControlBootstrap({ baseDir: root, environment })).rejects.toThrow(
      'pending_control_bootstrap_invalid'
    );
  });
});
