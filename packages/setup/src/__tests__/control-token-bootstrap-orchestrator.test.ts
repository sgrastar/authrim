import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CloudflareTokenBootstrapError } from '../core/cloudflare-control-token-bootstrap.js';
import {
  advanceReadyControlTokenGeneration,
  checkpointReadyControlTokenGenerationForRedeploy,
  classifyControlTokenBootstrapFailure,
  completeControlTokenBootstrap,
  findMissingControlTokenResourceClasses,
  hasReadyControlTokenBootstrap,
  reconcileControlSecretGenerationWorkerLock,
  resolveControlTokenResourceClasses,
} from '../core/control-token-bootstrap-orchestrator.js';
import { createDefaultConfig } from '../core/config.js';
import type { ControlProvisioningAuthorityState } from '../core/control-provisioning-authority.js';
import type { PendingControlBootstrapArtifact } from '../core/pending-control-bootstrap.js';

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const BOOTSTRAP_ID = '1'.repeat(32);
const BOOTSTRAP_TOKEN = 'checkpointed-bootstrap-token-value';
const CHILD_TOKENS = [
  {
    resourceClass: 'd1' as const,
    tokenId: '2'.repeat(32),
    tokenName: 'authrim-test-01234567-control-d1',
    secretName: 'CLOUDFLARE_D1_API_TOKEN',
    tokenFingerprint: 'a'.repeat(64),
  },
  {
    resourceClass: 'workers' as const,
    tokenId: '3'.repeat(32),
    tokenName: 'authrim-test-01234567-control-workers',
    secretName: 'CLOUDFLARE_WORKERS_API_TOKEN',
    tokenFingerprint: 'b'.repeat(64),
  },
] as const;
const SECRET_GENERATION = { deploymentId: 'deployment-1', versionId: 'version-1' } as const;

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function readyAuthority(): ControlProvisioningAuthorityState {
  return {
    environmentId: 'test',
    automaticProvisioningEnabled: true,
    tokenOwnership: 'account',
    tokenManagement: 'setup',
    capabilityState: 'ready',
    capabilityCheckedAt: 1,
    bootstrapPhase: 'none',
    bootstrapTokenOwnership: 'none',
    bootstrapTokenId: null,
    bootstrapTokenFingerprint: null,
    childTokens: CHILD_TOKENS,
    secretGeneration: SECRET_GENERATION,
    updatedAt: 1,
  };
}

describe('Control token resource classes', () => {
  it('records the active secret-generation version as the authoritative Control Worker version', () => {
    const authority = readyAuthority();
    const lock = {
      version: '1.0.0',
      env: 'test',
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
      d1: {},
      kv: {},
      queues: {},
      r2: {},
      workers: {
        'ar-control': {
          name: 'test-ar-control',
          deployedAt: '2026-08-31T00:00:00.000Z',
          version: '0.4.0',
          cloudflareVersionId: 'code-only-version',
        },
        'ar-auth': {
          name: 'test-ar-auth',
          deployedAt: '2026-08-31T00:00:00.000Z',
          version: '0.4.0',
          cloudflareVersionId: 'auth-version',
        },
      },
    };

    const reconciled = reconcileControlSecretGenerationWorkerLock({ lock, authority });
    expect(reconciled.changed).toBe(true);
    expect(reconciled.lock.workers?.['ar-control']).toMatchObject({
      version: '0.4.0',
      cloudflareVersionId: SECRET_GENERATION.versionId,
      deployedAt: new Date(authority.updatedAt * 1000).toISOString(),
    });
    expect(reconciled.lock.workers?.['ar-auth']).toEqual(lock.workers['ar-auth']);
    expect(
      reconcileControlSecretGenerationWorkerLock({ lock: reconciled.lock, authority })
    ).toEqual({ lock: reconciled.lock, changed: false });
  });

  it('fails closed when secret-generation evidence cannot be tied to the exact environment Worker', () => {
    const baseLock = {
      version: '1.0.0',
      env: 'test',
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
      d1: {},
      kv: {},
      queues: {},
      r2: {},
      workers: {},
    };
    expect(() =>
      reconcileControlSecretGenerationWorkerLock({ lock: baseLock, authority: readyAuthority() })
    ).toThrow('control_secret_generation_worker_lock_missing');
    expect(() =>
      reconcileControlSecretGenerationWorkerLock({
        lock: { ...baseLock, env: 'other' },
        authority: readyAuthority(),
      })
    ).toThrow('control_secret_generation_lock_evidence_invalid');
  });

  it('requests only the baseline split tokens without Dynamic Workers', () => {
    expect(resolveControlTokenResourceClasses(createDefaultConfig('test'))).toEqual([
      'd1',
      'workers',
    ]);
  });

  it('recognizes an already-ready authority only when every required secret name exists', async () => {
    const query = async () => [
      {
        environment_id: 'test',
        automatic_provisioning_enabled: 1,
        provisioning_token_ownership: 'user',
        provisioning_token_management: 'setup',
        provisioning_capability_state: 'ready',
        provisioning_capability_checked_at: 100,
        provisioning_bootstrap_phase: 'none',
        provisioning_bootstrap_token_ownership: 'none',
        provisioning_bootstrap_token_id: null,
        provisioning_bootstrap_token_fingerprint: null,
        provisioning_child_tokens_json: JSON.stringify(CHILD_TOKENS),
        provisioning_secret_generation_deployment_id: SECRET_GENERATION.deploymentId,
        provisioning_secret_generation_version_id: SECRET_GENERATION.versionId,
        updated_at: 100,
      },
    ];
    await expect(
      hasReadyControlTokenBootstrap({
        environmentId: 'test',
        controlDatabaseName: 'control',
        resourceClasses: ['d1', 'workers'],
        secretSink: {
          listNames: async () => ['CLOUDFLARE_D1_API_TOKEN', 'CLOUDFLARE_WORKERS_API_TOKEN'],
          has: async () => false,
          readActiveGeneration: async () => ({
            deploymentId: 'deployment-benign-redeploy',
            versionId: SECRET_GENERATION.versionId,
          }),
        },
        query,
      })
    ).resolves.toBe(true);
  });

  it('reports and restores an exact checkpointed generation after a code redeploy', async () => {
    const row = {
      environment_id: 'test',
      automatic_provisioning_enabled: 1,
      provisioning_token_ownership: 'user',
      provisioning_token_management: 'setup',
      provisioning_capability_state: 'ready',
      provisioning_capability_checked_at: 100,
      provisioning_bootstrap_phase: 'none',
      provisioning_bootstrap_token_ownership: 'none',
      provisioning_bootstrap_token_id: null,
      provisioning_bootstrap_token_fingerprint: null,
      provisioning_child_tokens_json: JSON.stringify(CHILD_TOKENS),
      provisioning_secret_generation_deployment_id: SECRET_GENERATION.deploymentId,
      provisioning_secret_generation_version_id: SECRET_GENERATION.versionId,
      updated_at: 100,
    };
    const activateGeneration = vi.fn(async () => ({
      deploymentId: 'deployment-restored',
      versionId: SECRET_GENERATION.versionId,
    }));
    const sink = {
      listNames: async () => ['CLOUDFLARE_D1_API_TOKEN', 'CLOUDFLARE_WORKERS_API_TOKEN'],
      has: async () => false,
      readActiveGeneration: async () => ({
        deploymentId: 'deployment-code',
        versionId: 'version-code',
      }),
      canActivateGeneration: vi.fn(async () => true),
      activateGeneration,
    };

    await expect(
      hasReadyControlTokenBootstrap({
        environmentId: 'test',
        controlDatabaseName: 'control',
        resourceClasses: ['d1', 'workers'],
        secretSink: sink,
        allowRestorableGeneration: true,
        query: async () => [row],
      })
    ).resolves.toBe(true);
    expect(activateGeneration).not.toHaveBeenCalled();

    await expect(
      hasReadyControlTokenBootstrap({
        environmentId: 'test',
        controlDatabaseName: 'control',
        resourceClasses: ['d1', 'workers'],
        secretSink: sink,
        restoreGenerationOnMismatch: true,
        query: async () => [row],
      })
    ).resolves.toBe(true);
    expect(activateGeneration).toHaveBeenCalledWith(SECRET_GENERATION);
  });

  it('checkpoints a ready Control generation only after restoring its exact version', async () => {
    const config = createDefaultConfig('test');
    config.controlPlane.automaticProvisioning = true;
    let activeVersionId = 'version-from-interrupted-redeploy';
    const activateGeneration = vi.fn(async () => {
      activeVersionId = SECRET_GENERATION.versionId;
      return { deploymentId: 'deployment-restored', versionId: activeVersionId };
    });
    const secretSink = {
      listNames: async () => ['CLOUDFLARE_D1_API_TOKEN', 'CLOUDFLARE_WORKERS_API_TOKEN'],
      has: async () => false,
      readActiveGeneration: async () => ({
        deploymentId: 'active-deployment',
        versionId: activeVersionId,
      }),
      canActivateGeneration: async () => true,
      activateGeneration,
    };
    const authorityRow = {
      environment_id: 'test',
      automatic_provisioning_enabled: 1,
      provisioning_token_ownership: 'account',
      provisioning_token_management: 'setup',
      provisioning_capability_state: 'ready',
      provisioning_capability_checked_at: 100,
      provisioning_bootstrap_phase: 'none',
      provisioning_bootstrap_token_ownership: 'none',
      provisioning_bootstrap_token_id: null,
      provisioning_bootstrap_token_fingerprint: null,
      provisioning_child_tokens_json: JSON.stringify(CHILD_TOKENS),
      provisioning_secret_generation_deployment_id: SECRET_GENERATION.deploymentId,
      provisioning_secret_generation_version_id: SECRET_GENERATION.versionId,
      updated_at: 100,
    };

    await expect(
      checkpointReadyControlTokenGenerationForRedeploy({
        environmentId: 'test',
        rootDir: '/repo',
        config,
        lock: {
          version: '1.0.0',
          env: 'test',
          createdAt: '2026-09-06T00:00:00.000Z',
          d1: { CONTROL_DB: { id: 'control-id', name: 'test-control' } },
          kv: {},
        },
        query: async () => [authorityRow],
        secretSink,
      })
    ).resolves.toMatchObject({
      controlDatabaseName: 'control-id',
      previousVersionId: SECRET_GENERATION.versionId,
      resourceClasses: ['d1', 'workers'],
      secretSink,
    });
    expect(activateGeneration).toHaveBeenCalledOnce();
  });

  it('advances ready authority only to the exact verified managed deployment', async () => {
    const oldRow = {
      environment_id: 'test',
      automatic_provisioning_enabled: 1,
      provisioning_token_ownership: 'user',
      provisioning_token_management: 'setup',
      provisioning_capability_state: 'ready',
      provisioning_capability_checked_at: 100,
      provisioning_bootstrap_phase: 'none',
      provisioning_bootstrap_token_ownership: 'none',
      provisioning_bootstrap_token_id: null,
      provisioning_bootstrap_token_fingerprint: null,
      provisioning_child_tokens_json: JSON.stringify(CHILD_TOKENS),
      provisioning_secret_generation_deployment_id: SECRET_GENERATION.deploymentId,
      provisioning_secret_generation_version_id: SECRET_GENERATION.versionId,
      updated_at: 100,
    };
    const newRow = {
      ...oldRow,
      provisioning_capability_checked_at: 200,
      provisioning_secret_generation_deployment_id: 'deployment-code',
      provisioning_secret_generation_version_id: 'version-code',
      updated_at: 200,
    };
    const query = vi.fn().mockResolvedValueOnce([oldRow]).mockResolvedValueOnce([newRow]);
    const execute = vi.fn(async () => undefined);

    await expect(
      advanceReadyControlTokenGeneration({
        environmentId: 'test',
        controlDatabaseName: 'control',
        resourceClasses: ['d1', 'workers'],
        previousVersionId: SECRET_GENERATION.versionId,
        deployedVersionId: 'version-code',
        secretSink: {
          listNames: async () => ['CLOUDFLARE_D1_API_TOKEN', 'CLOUDFLARE_WORKERS_API_TOKEN'],
          has: async () => false,
          readActiveGeneration: async () => ({
            deploymentId: 'deployment-code',
            versionId: 'version-code',
          }),
        },
        now: 200,
        query,
        execute,
      })
    ).resolves.toMatchObject({
      capabilityState: 'ready',
      secretGeneration: { deploymentId: 'deployment-code', versionId: 'version-code' },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('requests separate KV and R2 tokens when Dynamic Workers are enabled', () => {
    const config = createDefaultConfig('test');
    config.features.pluginDynamicWorkers.enabled = true;

    expect(resolveControlTokenResourceClasses(config)).toEqual(['d1', 'workers', 'kv', 'r2']);
  });

  it('reports only missing resource classes without reading secret values', async () => {
    const checkedNames: string[] = [];
    const missing = await findMissingControlTokenResourceClasses({
      resourceClasses: ['d1', 'workers', 'kv', 'r2'],
      secretSink: {
        has: async (secretName) => {
          checkedNames.push(secretName);
          return (
            secretName === 'CLOUDFLARE_D1_API_TOKEN' ||
            secretName === 'CLOUDFLARE_WORKERS_API_TOKEN'
          );
        },
      },
    });

    expect(missing).toEqual(['kv', 'r2']);
    expect(checkedNames).toEqual([
      'CLOUDFLARE_D1_API_TOKEN',
      'CLOUDFLARE_WORKERS_API_TOKEN',
      'CLOUDFLARE_KV_API_TOKEN',
      'CLOUDFLARE_R2_API_TOKEN',
    ]);
  });

  it('uses one secret-name listing when the sink supports it', async () => {
    let listCount = 0;
    const missing = await findMissingControlTokenResourceClasses({
      resourceClasses: ['d1', 'workers', 'kv', 'r2'],
      secretSink: {
        listNames: async () => {
          listCount += 1;
          return ['CLOUDFLARE_D1_API_TOKEN', 'CLOUDFLARE_WORKERS_API_TOKEN'];
        },
        has: async () => {
          throw new Error('per-secret lookup should not run');
        },
      },
    });

    expect(missing).toEqual(['kv', 'r2']);
    expect(listCount).toBe(1);
  });
});

describe('Control token bootstrap failure authority', () => {
  it('returns to tokenless pending when cleanup is confirmed', () => {
    expect(
      classifyControlTokenBootstrapFailure(
        new CloudflareTokenBootstrapError('cloudflare_control_secret_list_invalid', false),
        'user'
      )
    ).toEqual({ tokenOwnership: 'none', capabilityState: 'pending' });
  });

  it('retains ownership and blocks when cleanup is not confirmed', () => {
    expect(
      classifyControlTokenBootstrapFailure(
        new CloudflareTokenBootstrapError('cloudflare_token_cleanup_unconfirmed', true),
        'account'
      )
    ).toEqual({ tokenOwnership: 'account', capabilityState: 'blocked' });
  });

  it('keeps retryable bootstrap failures tokenless and pending', () => {
    expect(
      classifyControlTokenBootstrapFailure(
        new CloudflareTokenBootstrapError('cloudflare_token_api_http_503', false, undefined, true),
        'account'
      )
    ).toEqual({ tokenOwnership: 'none', capabilityState: 'pending' });
  });

  it('does not claim token ownership for failures before child creation', () => {
    expect(classifyControlTokenBootstrapFailure(new Error('prepare_failed'), 'account')).toEqual({
      tokenOwnership: 'none',
      capabilityState: 'pending',
    });
  });
});

function createCrashHarness(
  crash: 'before_authority_write' | 'before_revoke' | 'after_revoke' | 'after_checkpoint'
) {
  let authority: ControlProvisioningAuthorityState = {
    environmentId: 'test',
    automaticProvisioningEnabled: true,
    tokenOwnership: 'none',
    tokenManagement: 'none',
    capabilityState: 'pending',
    capabilityCheckedAt: null,
    bootstrapPhase: 'none',
    bootstrapTokenOwnership: 'none',
    bootstrapTokenId: null,
    bootstrapTokenFingerprint: null,
    childTokens: [],
    secretGeneration: null,
    updatedAt: 1,
  };
  let staged: PendingControlBootstrapArtifact | null = null;
  let firstAttempt = true;
  let revoked = false;
  const resumeRevocation = vi.fn(async () => {
    if (revoked) {
      throw new CloudflareTokenBootstrapError('cloudflare_token_api_http_403');
    }
    revoked = true;
    return { revoked: true as const };
  });
  const inspectRecoveryToken = vi.fn(async () => ({ tokenId: '4'.repeat(32) }));
  const inspectPendingRecoveryState = vi.fn(async () => ({
    recoveryTokenId: '4'.repeat(32),
  }));
  const reconcileWithRecoveryToken = vi.fn(async () => {
    revoked = true;
    return { revoked: true as const };
  });
  const writeAuthority = vi.fn(async (update: Record<string, unknown>) => {
    if (
      firstAttempt &&
      crash === 'before_authority_write' &&
      update.bootstrapPhase === 'pending_revocation'
    ) {
      firstAttempt = false;
      throw new Error('simulated_process_crash_before_authority_write');
    }
    authority = {
      ...authority,
      automaticProvisioningEnabled: update.automaticProvisioningEnabled as boolean,
      tokenOwnership: update.tokenOwnership as ControlProvisioningAuthorityState['tokenOwnership'],
      tokenManagement:
        (update.tokenManagement as ControlProvisioningAuthorityState['tokenManagement']) ?? 'none',
      capabilityState:
        update.capabilityState as ControlProvisioningAuthorityState['capabilityState'],
      capabilityCheckedAt: update.capabilityState === 'pending' ? null : 10,
      bootstrapPhase:
        (update.bootstrapPhase as ControlProvisioningAuthorityState['bootstrapPhase']) ?? 'none',
      bootstrapTokenOwnership:
        (update.bootstrapTokenOwnership as ControlProvisioningAuthorityState['bootstrapTokenOwnership']) ??
        'none',
      bootstrapTokenId: (update.bootstrapTokenId as string | undefined) ?? null,
      bootstrapTokenFingerprint: (update.bootstrapTokenFingerprint as string | undefined) ?? null,
      childTokens:
        (update.childTokens as ControlProvisioningAuthorityState['childTokens'] | undefined) ?? [],
      secretGeneration:
        (update.secretGeneration as ControlProvisioningAuthorityState['secretGeneration']) ?? null,
      updatedAt: authority.updatedAt + 1,
    };
    return authority;
  });
  const bootstrap = vi.fn(async (input: Record<string, unknown>) => {
    const prepared = {
      ownership: 'account' as const,
      bootstrapTokenId: BOOTSTRAP_ID,
      bootstrapRevoked: false as const,
      childTokens: CHILD_TOKENS,
      secretGeneration: SECRET_GENERATION,
    };
    expect(
      await (input.verifyControlSecretCutover as (value: typeof prepared) => Promise<boolean>)(
        prepared
      )
    ).toBe(true);
    await (input.beforeBootstrapRevocation as (value: typeof prepared) => Promise<void>)(prepared);
    if (firstAttempt && crash === 'before_revoke') {
      firstAttempt = false;
      throw new Error('simulated_process_crash_before_revoke');
    }
    revoked = true;
    const result = { ...prepared, bootstrapRevoked: true as const };
    await (input.afterBootstrapRevocation as (value: typeof result) => Promise<void>)(result);
    if (firstAttempt && crash === 'after_checkpoint') {
      firstAttempt = false;
      throw new Error('simulated_process_crash_after_checkpoint');
    }
    return result;
  });
  return {
    get authority() {
      return authority;
    },
    get revoked() {
      return revoked;
    },
    dependencies: {
      authority: {} as never,
      secretSink: {
        putGeneration: vi.fn(),
        has: vi.fn(async () => true),
        delete: vi.fn(),
        listNames: vi.fn(async () => ['CLOUDFLARE_D1_API_TOKEN', 'CLOUDFLARE_WORKERS_API_TOKEN']),
        readActiveGeneration: vi.fn(async () => SECRET_GENERATION),
      },
      bootstrap: bootstrap as never,
      resumeRevocation: resumeRevocation as never,
      readAuthority: vi.fn(async () => authority) as never,
      writeAuthority: writeAuthority as never,
      stagePending: vi.fn(async (input: { artifact: typeof staged }) => {
        staged = structuredClone(input.artifact) as PendingControlBootstrapArtifact;
      }) as never,
      loadPending: vi.fn(async () => structuredClone(staged)) as never,
      markRevocationConfirmed: vi.fn(async () => {
        if (!staged) throw new Error('pending_control_bootstrap_missing');
        if (firstAttempt && crash === 'after_revoke') {
          firstAttempt = false;
          throw new Error('simulated_process_crash_after_revoke');
        }
        staged = { ...staged, revocationConfirmed: true };
        return structuredClone(staged);
      }) as never,
      clearPending: vi.fn(async () => {
        staged = null;
      }) as never,
      inspectRecoveryToken: inspectRecoveryToken as never,
      inspectPendingRecoveryState: inspectPendingRecoveryState as never,
      stageRecoveryToken: vi.fn(async (input: { token: string; tokenId: string }) => {
        if (!staged) throw new Error('pending_control_bootstrap_missing');
        const previousRecoveryTokenId = staged.recoveryToken?.tokenId;
        staged = {
          ...staged,
          revocationTargetTokenIds: [
            ...staged.revocationTargetTokenIds,
            ...(previousRecoveryTokenId ? [previousRecoveryTokenId] : []),
          ],
          recoveryToken: {
            token: input.token,
            tokenId: input.tokenId,
            tokenFingerprint: 'c'.repeat(64),
          },
        };
        return structuredClone(staged);
      }) as never,
      reconcileWithRecoveryToken: reconcileWithRecoveryToken as never,
      stageReconstructedRecovery: vi.fn(
        async (input: {
          environment: string;
          accountId: string;
          ownership: 'account';
          bootstrapTokenId: string;
          bootstrapTokenFingerprint: string;
          childTokens: typeof CHILD_TOKENS;
          secretGeneration: typeof SECRET_GENERATION;
          recoveryToken: string;
          recoveryTokenId: string;
        }) => {
          staged = {
            version: 2,
            environment: input.environment,
            accountId: input.accountId,
            ownership: input.ownership,
            bootstrapToken: null,
            bootstrapTokenId: input.bootstrapTokenId,
            bootstrapTokenFingerprint: input.bootstrapTokenFingerprint,
            childTokens: input.childTokens,
            secretGeneration: input.secretGeneration,
            revocationTargetTokenIds: [input.bootstrapTokenId],
            recoveryToken: {
              token: input.recoveryToken,
              tokenId: input.recoveryTokenId,
              tokenFingerprint: tokenFingerprint(input.recoveryToken),
            },
            revocationConfirmed: false,
          };
          return structuredClone(staged);
        }
      ) as never,
    },
    bootstrap,
    writeAuthority,
    resumeRevocation,
    inspectRecoveryToken,
    inspectPendingRecoveryState,
    reconcileWithRecoveryToken,
    deleteStagedArtifact() {
      staged = null;
    },
    replaceAuthority(next: ControlProvisioningAuthorityState) {
      authority = next;
    },
  };
}

async function runCrashHarness(harness: ReturnType<typeof createCrashHarness>, token?: string) {
  return completeControlTokenBootstrap({
    accountId: ACCOUNT_ID,
    environment: 'test',
    rootDir: '/tmp/authrim-test',
    controlDatabaseName: 'test-control',
    bootstrapToken: token,
    ownership: 'account',
    resourceClasses: ['d1', 'workers'],
    dependencies: harness.dependencies,
  });
}

describe('Control token bootstrap durable cutover recovery', () => {
  it('fails closed when a caller tries to replace ready authority with another ownership', async () => {
    const bootstrap = vi.fn();
    await expect(
      completeControlTokenBootstrap({
        accountId: ACCOUNT_ID,
        environment: 'test',
        rootDir: '/tmp/authrim-test',
        controlDatabaseName: 'test-control',
        bootstrapToken: 'replacement-bootstrap-token-value',
        ownership: 'user',
        resourceClasses: ['d1', 'workers'],
        dependencies: {
          bootstrap: bootstrap as never,
          loadPending: vi.fn(async () => null) as never,
          readAuthority: vi.fn(async () => readyAuthority()) as never,
          writeAuthority: vi.fn(async () => readyAuthority()) as never,
          secretSink: {
            putGeneration: vi.fn(),
            has: vi.fn(async () => true),
            delete: vi.fn(),
            readActiveGeneration: vi.fn(async () => SECRET_GENERATION),
          },
        },
      })
    ).rejects.toMatchObject({ code: 'cloudflare_bootstrap_token_ownership_mismatch' });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('adopts the staged generation after an authority-write crash without another bootstrap token', async () => {
    const harness = createCrashHarness('before_authority_write');
    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow(
      'simulated_process_crash_before_authority_write'
    );
    expect(harness.authority).toMatchObject({
      capabilityState: 'pending',
      bootstrapPhase: 'none',
      childTokens: [],
    });
    expect(harness.bootstrap).toHaveBeenCalledOnce();

    await expect(runCrashHarness(harness)).resolves.toBeUndefined();
    expect(harness.bootstrap).toHaveBeenCalledOnce();
    expect(harness.resumeRevocation).toHaveBeenCalledOnce();
    expect(harness.authority).toMatchObject({
      capabilityState: 'ready',
      tokenOwnership: 'account',
      bootstrapPhase: 'none',
      childTokens: CHILD_TOKENS,
      secretGeneration: SECRET_GENERATION,
    });
    expect(harness.writeAuthority).toHaveBeenCalledTimes(4);
  });

  it('resumes a crash immediately before revoke without creating another token generation', async () => {
    const harness = createCrashHarness('before_revoke');
    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow(
      'simulated_process_crash_before_revoke'
    );
    expect(harness.authority).toMatchObject({
      capabilityState: 'pending',
      bootstrapPhase: 'pending_revocation',
      bootstrapTokenOwnership: 'account',
    });

    await expect(runCrashHarness(harness)).resolves.toBeUndefined();
    expect(harness.resumeRevocation).toHaveBeenCalledOnce();
    expect(harness.revoked).toBe(true);
    expect(harness.authority).toMatchObject({
      capabilityState: 'ready',
      tokenOwnership: 'account',
      bootstrapPhase: 'none',
      bootstrapTokenId: null,
      childTokens: CHILD_TOKENS,
    });
  });

  it('recovers a crash after provider revoke but before the local confirmation', async () => {
    const harness = createCrashHarness('after_revoke');
    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow(
      'simulated_process_crash_after_revoke'
    );
    expect(harness.revoked).toBe(true);
    expect(harness.authority.bootstrapPhase).toBe('pending_revocation');

    await expect(runCrashHarness(harness)).rejects.toMatchObject({
      code: 'cloudflare_bootstrap_recovery_token_required',
    });
    await expect(
      runCrashHarness(harness, 'independent-recovery-token-value')
    ).resolves.toBeUndefined();
    expect(harness.reconcileWithRecoveryToken).toHaveBeenCalledOnce();
    expect(harness.authority.capabilityState).toBe('ready');
  });

  it('resumes a crash after the confirmed-revocation checkpoint without another token API call', async () => {
    const harness = createCrashHarness('after_checkpoint');
    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow(
      'simulated_process_crash_after_checkpoint'
    );
    expect(harness.authority.bootstrapPhase).toBe('cutover_verified');

    await expect(runCrashHarness(harness)).resolves.toBeUndefined();
    expect(harness.resumeRevocation).not.toHaveBeenCalled();
    expect(harness.authority.capabilityState).toBe('ready');
  });

  it('rejects a replacement recovery token whose strict policy cannot be verified', async () => {
    const harness = createCrashHarness('before_revoke');
    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow();
    harness.inspectRecoveryToken.mockRejectedValueOnce(
      new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_scope_invalid')
    );
    await expect(runCrashHarness(harness, 'different-bootstrap-token-value')).rejects.toMatchObject(
      { code: 'cloudflare_bootstrap_token_scope_invalid' }
    );
    expect(harness.resumeRevocation).not.toHaveBeenCalled();
    expect(harness.authority.bootstrapPhase).toBe('pending_revocation');
  });

  it('uses a separately verified recovery token after the original DELETE/local-checkpoint gap', async () => {
    const harness = createCrashHarness('before_revoke');
    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow();
    harness.resumeRevocation.mockRejectedValue(
      new CloudflareTokenBootstrapError('cloudflare_token_api_http_403')
    );

    await expect(runCrashHarness(harness)).rejects.toMatchObject({
      code: 'cloudflare_bootstrap_recovery_token_required',
    });
    await expect(
      runCrashHarness(harness, 'independent-recovery-token-value')
    ).resolves.toBeUndefined();
    expect(harness.inspectRecoveryToken).toHaveBeenCalledOnce();
    expect(harness.reconcileWithRecoveryToken).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRecoveryTokenId: '4'.repeat(32),
        revocationTargetTokenIds: [BOOTSTRAP_ID],
      })
    );
    expect(harness.authority.capabilityState).toBe('ready');
  });

  it('reconstructs a lost pending artifact before any provider mutation and preserves child IDs', async () => {
    const harness = createCrashHarness('before_revoke');
    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow(
      'simulated_process_crash_before_revoke'
    );
    harness.deleteStagedArtifact();

    await expect(runCrashHarness(harness)).rejects.toMatchObject({
      code: 'cloudflare_bootstrap_recovery_artifact_missing',
    });
    await expect(
      runCrashHarness(harness, 'independent-recovery-token-value')
    ).resolves.toBeUndefined();

    const stageReconstructed = harness.dependencies.stageReconstructedRecovery as ReturnType<
      typeof vi.fn
    >;
    expect(stageReconstructed).toHaveBeenCalledOnce();
    expect(harness.inspectPendingRecoveryState).toHaveBeenCalledTimes(2);
    expect(stageReconstructed.mock.invocationCallOrder[0]).toBeLessThan(
      harness.reconcileWithRecoveryToken.mock.invocationCallOrder[0]!
    );
    expect(harness.authority).toMatchObject({
      capabilityState: 'ready',
      childTokens: CHILD_TOKENS,
      secretGeneration: SECRET_GENERATION,
    });
    expect(harness.bootstrap).toHaveBeenCalledOnce();
  });

  it('resumes reconstructed revocation after interruption without duplicate target deletion', async () => {
    const harness = createCrashHarness('before_revoke');
    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow();
    harness.deleteStagedArtifact();
    let bootstrapDeletes = 0;
    harness.reconcileWithRecoveryToken.mockImplementationOnce(async () => {
      bootstrapDeletes += 1;
      throw new Error('simulated_crash_after_bootstrap_delete');
    });
    harness.reconcileWithRecoveryToken.mockImplementationOnce(async () => {
      return { revoked: true as const };
    });

    await expect(runCrashHarness(harness, 'independent-recovery-token-value')).rejects.toThrow(
      'simulated_crash_after_bootstrap_delete'
    );
    await expect(runCrashHarness(harness)).resolves.toBeUndefined();

    expect(bootstrapDeletes).toBe(1);
    expect(harness.reconcileWithRecoveryToken).toHaveBeenCalledTimes(2);
    expect(
      harness.dependencies.stageReconstructedRecovery as ReturnType<typeof vi.fn>
    ).toHaveBeenCalledOnce();
    expect(harness.authority.childTokens).toEqual(CHILD_TOKENS);
    expect(harness.authority.capabilityState).toBe('ready');
  });

  it('cleans a staged recovery token when another actor reaches ready first', async () => {
    const harness = createCrashHarness('before_revoke');
    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow();
    harness.deleteStagedArtifact();
    const readAuthority = harness.dependencies.readAuthority as ReturnType<typeof vi.fn>;
    readAuthority.mockReset();
    readAuthority.mockResolvedValueOnce(harness.authority);
    readAuthority.mockResolvedValueOnce(readyAuthority());

    await expect(
      runCrashHarness(harness, 'independent-recovery-token-value')
    ).rejects.toMatchObject({ code: 'cloudflare_token_bootstrap_checkpoint_changed' });
    expect(harness.reconcileWithRecoveryToken).not.toHaveBeenCalled();
    harness.replaceAuthority(readyAuthority());
    readAuthority.mockReset();
    readAuthority.mockImplementation(async () => harness.authority);

    await expect(runCrashHarness(harness)).resolves.toBeUndefined();
    expect(harness.reconcileWithRecoveryToken).toHaveBeenCalledOnce();
    expect(
      harness.dependencies.markRevocationConfirmed as ReturnType<typeof vi.fn>
    ).toHaveBeenCalledOnce();
    expect(harness.authority.capabilityState).toBe('ready');
    expect(harness.authority.childTokens).toEqual(CHILD_TOKENS);
  });

  it('rejects the checkpointed bootstrap token as artifact-loss recovery authority', async () => {
    const harness = createCrashHarness('before_revoke');
    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow();
    harness.deleteStagedArtifact();

    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toMatchObject({
      code: 'cloudflare_bootstrap_recovery_token_not_independent',
    });
    expect(harness.inspectPendingRecoveryState).not.toHaveBeenCalled();
    expect(
      harness.dependencies.stageReconstructedRecovery as ReturnType<typeof vi.fn>
    ).not.toHaveBeenCalled();
    expect(harness.reconcileWithRecoveryToken).not.toHaveBeenCalled();
  });

  it('does not reconstruct a lost artifact when the active secret generation changed', async () => {
    const harness = createCrashHarness('before_revoke');
    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow();
    harness.deleteStagedArtifact();
    const sink = harness.dependencies.secretSink as {
      readActiveGeneration: ReturnType<typeof vi.fn>;
    };
    sink.readActiveGeneration.mockResolvedValue({
      deploymentId: 'deployment-overwrite',
      versionId: 'version-overwrite',
    });

    await expect(
      runCrashHarness(harness, 'independent-recovery-token-value')
    ).rejects.toMatchObject({ code: 'cloudflare_control_secret_generation_mismatch' });
    expect(harness.inspectPendingRecoveryState).not.toHaveBeenCalled();
    expect(
      harness.dependencies.stageReconstructedRecovery as ReturnType<typeof vi.fn>
    ).not.toHaveBeenCalled();
    expect(harness.reconcileWithRecoveryToken).not.toHaveBeenCalled();
  });

  it('rechecks active generation after reconstruction and before provider mutation', async () => {
    const harness = createCrashHarness('before_revoke');
    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow();
    harness.deleteStagedArtifact();
    const sink = harness.dependencies.secretSink as {
      readActiveGeneration: ReturnType<typeof vi.fn>;
    };
    sink.readActiveGeneration.mockReset();
    sink.readActiveGeneration.mockResolvedValueOnce(SECRET_GENERATION);
    sink.readActiveGeneration.mockResolvedValueOnce({
      deploymentId: 'deployment-overwrite',
      versionId: 'version-overwrite',
    });

    await expect(
      runCrashHarness(harness, 'independent-recovery-token-value')
    ).rejects.toMatchObject({ code: 'cloudflare_control_secret_generation_mismatch' });
    expect(
      harness.dependencies.stageReconstructedRecovery as ReturnType<typeof vi.fn>
    ).toHaveBeenCalledOnce();
    expect(harness.reconcileWithRecoveryToken).not.toHaveBeenCalled();
  });

  it('fails closed when Control checkpoint identity changes after reconstruction', async () => {
    const harness = createCrashHarness('before_revoke');
    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow();
    harness.deleteStagedArtifact();
    const readAuthority = harness.dependencies.readAuthority as ReturnType<typeof vi.fn>;
    readAuthority.mockReset();
    readAuthority.mockResolvedValueOnce(harness.authority);
    readAuthority.mockResolvedValueOnce({
      ...harness.authority,
      childTokens: [{ ...CHILD_TOKENS[0], tokenFingerprint: 'e'.repeat(64) }, CHILD_TOKENS[1]],
      updatedAt: harness.authority.updatedAt + 1,
    });

    await expect(
      runCrashHarness(harness, 'independent-recovery-token-value')
    ).rejects.toMatchObject({ code: 'cloudflare_token_bootstrap_checkpoint_mismatch' });
    expect(
      harness.dependencies.stageReconstructedRecovery as ReturnType<typeof vi.fn>
    ).toHaveBeenCalledOnce();
    expect(harness.reconcileWithRecoveryToken).not.toHaveBeenCalled();
  });

  it('does not downgrade durable cutover state when authority readback fails in the catch path', async () => {
    const harness = createCrashHarness('before_revoke');
    const readAuthority = harness.dependencies.readAuthority as ReturnType<typeof vi.fn>;
    readAuthority.mockImplementationOnce(async () => harness.authority);
    readAuthority.mockRejectedValue(new Error('control read unavailable'));

    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow(
      'simulated_process_crash_before_revoke'
    );
    expect(harness.authority.bootstrapPhase).toBe('pending_revocation');
    expect(readAuthority).toHaveBeenCalledTimes(1);
  });

  it('rejects resume before revocation when another secret generation became active', async () => {
    const harness = createCrashHarness('before_revoke');
    await expect(runCrashHarness(harness, BOOTSTRAP_TOKEN)).rejects.toThrow();
    const sink = harness.dependencies.secretSink as {
      readActiveGeneration: ReturnType<typeof vi.fn>;
    };
    sink.readActiveGeneration.mockResolvedValue({
      deploymentId: 'deployment-overwrite',
      versionId: 'version-overwrite',
    });

    await expect(runCrashHarness(harness)).rejects.toMatchObject({
      code: 'cloudflare_control_secret_generation_mismatch',
    });
    expect(harness.resumeRevocation).not.toHaveBeenCalled();
    expect(harness.authority.bootstrapPhase).toBe('pending_revocation');
  });
});
