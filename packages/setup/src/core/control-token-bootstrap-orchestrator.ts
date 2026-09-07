import { createHash, timingSafeEqual } from 'node:crypto';
import {
  bootstrapControlWorkerTokens,
  buildCloudflareChildTokenName,
  CloudflareTokenBootstrapError,
  CloudflareTokenAuthorityHttpClient,
  inspectCloudflareBootstrapRecoveryToken,
  inspectCloudflarePendingBootstrapRecoveryState,
  reconcileCloudflareBootstrapRevocationWithRecoveryToken,
  resumeCloudflareBootstrapTokenRevocation,
  WranglerControlSecretSink,
  type CloudflareTokenAuthority,
  type CloudflareTokenOwnership,
  type ControlSecretGenerationReceipt,
  type ControlSecretSink,
  type ControlTokenBootstrapPreparedResult,
  type ControlTokenResourceClass,
} from './cloudflare-control-token-bootstrap.js';
import {
  readControlProvisioningAuthority,
  writeControlProvisioningAuthority,
  type ControlProvisioningAuthorityState,
} from './control-provisioning-authority.js';
import type { AuthrimConfig } from './config.js';
import type { AuthrimLock } from './lock.js';
import {
  clearPendingControlBootstrap,
  loadPendingControlBootstrap,
  markPendingControlBootstrapRevocationConfirmed,
  stageReconstructedPendingControlBootstrapRecovery,
  stagePendingControlBootstrapRecoveryToken,
  stagePendingControlBootstrap,
  type PendingControlBootstrapArtifact,
} from './pending-control-bootstrap.js';

const CONTROL_TOKEN_SECRET_BY_RESOURCE_CLASS = {
  d1: 'CLOUDFLARE_D1_API_TOKEN',
  workers: 'CLOUDFLARE_WORKERS_API_TOKEN',
  kv: 'CLOUDFLARE_KV_API_TOKEN',
  r2: 'CLOUDFLARE_R2_API_TOKEN',
} as const satisfies Record<ControlTokenResourceClass, Parameters<ControlSecretSink['has']>[0]>;

/**
 * Wrangler secret generations are immutable Worker versions. Keep lock evidence on the version
 * that actually serves traffic, rather than the code-only version deployed immediately before
 * token bootstrap.
 */
export function reconcileControlSecretGenerationWorkerLock(input: {
  lock: AuthrimLock;
  authority: ControlProvisioningAuthorityState;
}): { lock: AuthrimLock; changed: boolean } {
  const { lock, authority } = input;
  if (
    authority.environmentId !== lock.env ||
    authority.automaticProvisioningEnabled !== true ||
    authority.capabilityState !== 'ready' ||
    !['setup', 'operator'].includes(authority.tokenManagement) ||
    !authority.secretGeneration
  ) {
    throw new Error('control_secret_generation_lock_evidence_invalid');
  }
  const controlWorker = lock.workers?.['ar-control'];
  if (!controlWorker || controlWorker.name !== `${lock.env}-ar-control`) {
    throw new Error('control_secret_generation_worker_lock_missing');
  }
  if (controlWorker.cloudflareVersionId === authority.secretGeneration.versionId) {
    return { lock, changed: false };
  }
  const deployedAt = new Date(authority.updatedAt * 1000);
  if (!Number.isFinite(deployedAt.getTime())) {
    throw new Error('control_secret_generation_timestamp_invalid');
  }
  return {
    changed: true,
    lock: {
      ...lock,
      workers: {
        ...lock.workers,
        'ar-control': {
          ...controlWorker,
          deployedAt: deployedAt.toISOString(),
          cloudflareVersionId: authority.secretGeneration.versionId,
        },
      },
      updatedAt: deployedAt.toISOString(),
    },
  };
}

export function resolveControlTokenResourceClasses(
  config: Pick<AuthrimConfig, 'features'>
): readonly ControlTokenResourceClass[] {
  return config.features.pluginDynamicWorkers.enabled
    ? ['d1', 'workers', 'kv', 'r2']
    : ['d1', 'workers'];
}

export interface ReadyControlTokenGenerationCheckpoint {
  controlDatabaseName: string;
  previousVersionId: string;
  resourceClasses: readonly ControlTokenResourceClass[];
  secretSink: Pick<
    ControlSecretSink,
    'has' | 'listNames' | 'readActiveGeneration' | 'canActivateGeneration' | 'activateGeneration'
  >;
}

/**
 * Restores and checkpoints the last verified immutable Control version before a managed redeploy.
 * A retry therefore starts from the generation known to contain the setup-managed token values,
 * even if an earlier attempt published a new version but stopped before committing authority.
 */
export async function checkpointReadyControlTokenGenerationForRedeploy(input: {
  environmentId: string;
  rootDir: string;
  config: AuthrimConfig;
  lock: AuthrimLock;
  query?: Parameters<typeof readControlProvisioningAuthority>[0]['query'];
  secretSink?: ReadyControlTokenGenerationCheckpoint['secretSink'];
}): Promise<ReadyControlTokenGenerationCheckpoint | null> {
  if (input.config.controlPlane?.automaticProvisioning !== true) return null;
  const controlDatabaseName = input.lock.d1.CONTROL_DB?.id;
  if (!controlDatabaseName) {
    throw new Error('control_database_required_for_control_worker_redeploy');
  }
  const authority = await readControlProvisioningAuthority({
    environmentId: input.environmentId,
    controlDatabaseName,
    query: input.query,
  });
  if (!authority?.secretGeneration) {
    throw new Error('control_token_bootstrap_ready_generation_missing');
  }
  const resourceClasses = resolveControlTokenResourceClasses(input.config);
  const secretSink =
    input.secretSink ??
    new WranglerControlSecretSink({
      workerName: `${input.environmentId}-ar-control`,
      cwd: input.rootDir,
    });
  const ready = await hasReadyControlTokenBootstrap({
    environmentId: input.environmentId,
    controlDatabaseName,
    resourceClasses,
    secretSink,
    restoreGenerationOnMismatch: true,
    query: input.query,
  });
  if (!ready) {
    throw new Error('control_token_bootstrap_ready_generation_mismatch');
  }
  return {
    controlDatabaseName,
    previousVersionId: authority.secretGeneration.versionId,
    resourceClasses,
    secretSink,
  };
}

export async function commitReadyControlTokenGenerationRedeploy(input: {
  environmentId: string;
  checkpoint: ReadyControlTokenGenerationCheckpoint | null;
  deployedVersionId: string | undefined;
}): Promise<void> {
  if (!input.checkpoint) return;
  if (!input.deployedVersionId) {
    throw new Error('control_worker_redeploy_version_missing');
  }
  await advanceReadyControlTokenGeneration({
    environmentId: input.environmentId,
    controlDatabaseName: input.checkpoint.controlDatabaseName,
    resourceClasses: input.checkpoint.resourceClasses,
    previousVersionId: input.checkpoint.previousVersionId,
    deployedVersionId: input.deployedVersionId,
    secretSink: input.checkpoint.secretSink,
  });
}

export async function findMissingControlTokenResourceClasses(input: {
  resourceClasses: readonly ControlTokenResourceClass[];
  secretSink: Pick<ControlSecretSink, 'has' | 'listNames'>;
}): Promise<ControlTokenResourceClass[]> {
  if (input.secretSink.listNames) {
    const presentNames = new Set(await input.secretSink.listNames());
    return input.resourceClasses.filter(
      (resourceClass) => !presentNames.has(CONTROL_TOKEN_SECRET_BY_RESOURCE_CLASS[resourceClass])
    );
  }
  const checks = await Promise.all(
    input.resourceClasses.map(async (resourceClass) => ({
      resourceClass,
      present: await input.secretSink.has(CONTROL_TOKEN_SECRET_BY_RESOURCE_CLASS[resourceClass]),
    }))
  );
  return checks.filter((check) => !check.present).map((check) => check.resourceClass);
}

export async function hasReadyControlTokenBootstrap(input: {
  environmentId: string;
  controlDatabaseName: string;
  resourceClasses: readonly ControlTokenResourceClass[];
  secretSink: Pick<
    ControlSecretSink,
    'has' | 'listNames' | 'readActiveGeneration' | 'canActivateGeneration' | 'activateGeneration'
  >;
  allowRestorableGeneration?: boolean;
  restoreGenerationOnMismatch?: boolean;
  query?: Parameters<typeof readControlProvisioningAuthority>[0]['query'];
}): Promise<boolean> {
  if (input.allowRestorableGeneration && input.restoreGenerationOnMismatch) {
    throw new Error('control_secret_generation_recovery_mode_ambiguous');
  }
  const authority = await readControlProvisioningAuthority({
    environmentId: input.environmentId,
    controlDatabaseName: input.controlDatabaseName,
    query: input.query,
  });
  if (
    authority?.automaticProvisioningEnabled !== true ||
    authority.capabilityState !== 'ready' ||
    authority.tokenOwnership === 'none' ||
    !['setup', 'operator'].includes(authority.tokenManagement) ||
    authority.secretGeneration === null ||
    !input.secretSink.readActiveGeneration ||
    input.resourceClasses.some((resourceClass) => {
      const child = authority.childTokens.find(
        (candidate) => candidate.resourceClass === resourceClass
      );
      return (
        !child ||
        child.secretName !== CONTROL_TOKEN_SECRET_BY_RESOURCE_CLASS[resourceClass] ||
        typeof child.tokenFingerprint !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(child.tokenFingerprint)
      );
    })
  ) {
    return false;
  }
  if (
    (
      await findMissingControlTokenResourceClasses({
        resourceClasses: input.resourceClasses,
        secretSink: input.secretSink,
      })
    ).length > 0
  ) {
    return false;
  }
  const active = await input.secretSink.readActiveGeneration();
  if (active.versionId === authority.secretGeneration.versionId) return true;
  if (input.restoreGenerationOnMismatch) {
    if (!input.secretSink.activateGeneration) return false;
    const restored = await input.secretSink.activateGeneration(authority.secretGeneration);
    return restored.versionId === authority.secretGeneration.versionId;
  }
  if (input.allowRestorableGeneration) {
    return input.secretSink.canActivateGeneration
      ? input.secretSink.canActivateGeneration(authority.secretGeneration)
      : false;
  }
  return false;
}

/**
 * Move ready authority evidence to the exact version produced by one verified Setup deployment.
 * The caller supplies both sides of the transition so a concurrent or external deployment cannot
 * be mistaken for the managed Control redeploy that preserved the checkpointed secrets.
 */
export async function advanceReadyControlTokenGeneration(input: {
  environmentId: string;
  controlDatabaseName: string;
  resourceClasses: readonly ControlTokenResourceClass[];
  previousVersionId: string;
  deployedVersionId: string;
  secretSink: Pick<ControlSecretSink, 'has' | 'listNames' | 'readActiveGeneration'>;
  now?: number;
  query?: Parameters<typeof readControlProvisioningAuthority>[0]['query'];
  execute?: Parameters<typeof writeControlProvisioningAuthority>[0]['execute'];
}): Promise<ControlProvisioningAuthorityState> {
  const authority = await readControlProvisioningAuthority({
    environmentId: input.environmentId,
    controlDatabaseName: input.controlDatabaseName,
    query: input.query,
  });
  if (
    authority?.automaticProvisioningEnabled !== true ||
    authority.capabilityState !== 'ready' ||
    authority.tokenOwnership === 'none' ||
    !['setup', 'operator'].includes(authority.tokenManagement) ||
    authority.secretGeneration?.versionId !== input.previousVersionId ||
    !input.secretSink.readActiveGeneration ||
    input.resourceClasses.some((resourceClass) => {
      const child = authority.childTokens.find(
        (candidate) => candidate.resourceClass === resourceClass
      );
      return (
        !child ||
        child.secretName !== CONTROL_TOKEN_SECRET_BY_RESOURCE_CLASS[resourceClass] ||
        typeof child.tokenFingerprint !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(child.tokenFingerprint)
      );
    })
  ) {
    throw new Error('control_secret_generation_advance_authority_invalid');
  }
  const missing = await findMissingControlTokenResourceClasses({
    resourceClasses: input.resourceClasses,
    secretSink: input.secretSink,
  });
  if (missing.length > 0) {
    throw new Error(`control_secret_generation_advance_secrets_missing:${missing.join(',')}`);
  }
  const active = await input.secretSink.readActiveGeneration();
  if (active.versionId !== input.deployedVersionId) {
    throw new Error('control_secret_generation_advance_deployment_mismatch');
  }
  return writeControlProvisioningAuthority({
    controlDatabaseName: input.controlDatabaseName,
    environmentId: input.environmentId,
    automaticProvisioningEnabled: true,
    tokenOwnership: authority.tokenOwnership,
    tokenManagement: authority.tokenManagement,
    capabilityState: 'ready',
    childTokens: authority.childTokens,
    secretGeneration: active,
    now: input.now,
    execute: input.execute,
    query: input.query,
  });
}

export function classifyControlTokenBootstrapFailure(
  error: unknown,
  ownership: CloudflareTokenOwnership
): {
  tokenOwnership: CloudflareTokenOwnership | 'none';
  capabilityState: 'pending' | 'blocked';
} {
  if (error instanceof CloudflareTokenBootstrapError && error.bootstrapRetainedForRetry) {
    return { tokenOwnership: 'none', capabilityState: 'pending' };
  }
  return error instanceof CloudflareTokenBootstrapError && error.cleanupRequired
    ? { tokenOwnership: ownership, capabilityState: 'blocked' }
    : { tokenOwnership: 'none', capabilityState: 'pending' };
}

function bootstrapTokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function fingerprintsMatch(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

interface VerifiedControlBootstrapCheckpoint {
  bootstrapTokenId: string;
  bootstrapTokenFingerprint: string;
  childTokens: ControlTokenBootstrapPreparedResult['childTokens'];
  secretGeneration: ControlSecretGenerationReceipt;
}

function assertCheckpointMatchesRequest(input: {
  accountId: string;
  environment: string;
  ownership: CloudflareTokenOwnership;
  resourceClasses: readonly ControlTokenResourceClass[];
  authority: ControlProvisioningAuthorityState;
  artifact?: PendingControlBootstrapArtifact | null;
}): VerifiedControlBootstrapCheckpoint {
  if (input.authority.bootstrapTokenOwnership !== input.ownership) {
    throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_ownership_mismatch');
  }
  if (
    input.authority.environmentId !== input.environment ||
    input.authority.automaticProvisioningEnabled !== true ||
    input.authority.tokenOwnership !== 'none' ||
    input.authority.tokenManagement !== 'setup' ||
    input.authority.capabilityState !== 'pending' ||
    !['pending_revocation', 'cutover_verified'].includes(input.authority.bootstrapPhase)
  ) {
    throw new CloudflareTokenBootstrapError('cloudflare_token_bootstrap_checkpoint_mismatch');
  }
  if (
    typeof input.authority.bootstrapTokenId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(input.authority.bootstrapTokenId) ||
    typeof input.authority.bootstrapTokenFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(input.authority.bootstrapTokenFingerprint)
  ) {
    throw new CloudflareTokenBootstrapError('cloudflare_token_bootstrap_checkpoint_mismatch');
  }
  const requested = [...new Set(input.resourceClasses)].sort();
  const checkpointed = input.authority.childTokens.map((child) => child.resourceClass).sort();
  if (
    requested.length !== checkpointed.length ||
    requested.some((resourceClass, index) => resourceClass !== checkpointed[index]) ||
    input.authority.childTokens.some(
      (child) =>
        child.tokenName !==
          buildCloudflareChildTokenName({
            accountId: input.accountId,
            environment: input.environment,
            resourceClass: child.resourceClass,
          }) ||
        child.secretName !== CONTROL_TOKEN_SECRET_BY_RESOURCE_CLASS[child.resourceClass] ||
        !/^[0-9a-f]{32}$/u.test(child.tokenId) ||
        child.tokenId === input.authority.bootstrapTokenId ||
        typeof child.tokenFingerprint !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(child.tokenFingerprint)
    ) ||
    new Set(input.authority.childTokens.map((child) => child.tokenId)).size !==
      input.authority.childTokens.length ||
    new Set(input.authority.childTokens.map((child) => child.tokenFingerprint)).size !==
      input.authority.childTokens.length ||
    input.authority.childTokens.some(
      (child) => child.tokenFingerprint === input.authority.bootstrapTokenFingerprint
    )
  ) {
    throw new CloudflareTokenBootstrapError('cloudflare_token_bootstrap_checkpoint_mismatch');
  }
  if (input.authority.secretGeneration === null) {
    throw new CloudflareTokenBootstrapError('cloudflare_token_bootstrap_checkpoint_mismatch');
  }
  if (input.artifact) {
    if (
      input.artifact.accountId !== input.accountId ||
      input.artifact.environment !== input.environment ||
      input.artifact.ownership !== input.ownership ||
      input.artifact.bootstrapTokenId !== input.authority.bootstrapTokenId ||
      input.artifact.bootstrapTokenFingerprint !== input.authority.bootstrapTokenFingerprint ||
      JSON.stringify(input.artifact.childTokens) !== JSON.stringify(input.authority.childTokens) ||
      JSON.stringify(input.artifact.secretGeneration) !==
        JSON.stringify(input.authority.secretGeneration)
    ) {
      throw new CloudflareTokenBootstrapError('cloudflare_token_bootstrap_checkpoint_mismatch');
    }
  }
  return {
    bootstrapTokenId: input.authority.bootstrapTokenId,
    bootstrapTokenFingerprint: input.authority.bootstrapTokenFingerprint,
    childTokens: input.authority.childTokens.map((child) => ({
      resourceClass: child.resourceClass,
      tokenId: child.tokenId,
      tokenName: child.tokenName,
      secretName:
        child.secretName as ControlTokenBootstrapPreparedResult['childTokens'][number]['secretName'],
      tokenFingerprint: child.tokenFingerprint!,
    })),
    secretGeneration: input.authority.secretGeneration,
  };
}

function assertReadyCheckpointMatchesArtifact(input: {
  accountId: string;
  environment: string;
  ownership: CloudflareTokenOwnership;
  resourceClasses: readonly ControlTokenResourceClass[];
  authority: ControlProvisioningAuthorityState;
  artifact: PendingControlBootstrapArtifact;
}): VerifiedControlBootstrapCheckpoint {
  const requested = [...new Set(input.resourceClasses)].sort();
  const checkpointed = input.authority.childTokens.map((child) => child.resourceClass).sort();
  if (
    input.authority.environmentId !== input.environment ||
    input.authority.automaticProvisioningEnabled !== true ||
    input.authority.tokenOwnership !== input.ownership ||
    input.authority.tokenManagement !== 'setup' ||
    input.authority.capabilityState !== 'ready' ||
    input.authority.bootstrapPhase !== 'none' ||
    input.authority.bootstrapTokenOwnership !== 'none' ||
    input.authority.bootstrapTokenId !== null ||
    input.authority.bootstrapTokenFingerprint !== null ||
    input.authority.secretGeneration === null ||
    input.artifact.accountId !== input.accountId ||
    input.artifact.environment !== input.environment ||
    input.artifact.ownership !== input.ownership ||
    requested.length !== checkpointed.length ||
    requested.some((resourceClass, index) => resourceClass !== checkpointed[index]) ||
    JSON.stringify(input.artifact.childTokens) !== JSON.stringify(input.authority.childTokens) ||
    JSON.stringify(input.artifact.secretGeneration) !==
      JSON.stringify(input.authority.secretGeneration)
  ) {
    throw new CloudflareTokenBootstrapError('cloudflare_token_bootstrap_checkpoint_mismatch');
  }
  return {
    bootstrapTokenId: input.artifact.bootstrapTokenId,
    bootstrapTokenFingerprint: input.artifact.bootstrapTokenFingerprint,
    childTokens: input.artifact.childTokens,
    secretGeneration: input.artifact.secretGeneration,
  };
}

async function assertExactControlSecretGeneration(input: {
  resourceClasses: readonly ControlTokenResourceClass[];
  secretSink: ControlSecretSink;
  expected: ControlSecretGenerationReceipt;
}): Promise<void> {
  const missing = await findMissingControlTokenResourceClasses({
    resourceClasses: input.resourceClasses,
    secretSink: input.secretSink,
  });
  if (missing.length > 0 || !input.secretSink.readActiveGeneration) {
    throw new CloudflareTokenBootstrapError(
      'cloudflare_control_secret_cutover_verification_failed',
      true
    );
  }
  const active = await input.secretSink.readActiveGeneration();
  // The deployment ID is retained as audit evidence for the original cutover. Re-deploying the
  // same immutable version at 100% can legitimately create another deployment ID, so only the
  // version identity is the secret-value security boundary.
  if (active.versionId !== input.expected.versionId) {
    throw new CloudflareTokenBootstrapError('cloudflare_control_secret_generation_mismatch', true);
  }
}

interface CompleteControlTokenBootstrapDependencies {
  authority?: CloudflareTokenAuthority;
  secretSink?: ControlSecretSink;
  bootstrap?: typeof bootstrapControlWorkerTokens;
  resumeRevocation?: typeof resumeCloudflareBootstrapTokenRevocation;
  readAuthority?: typeof readControlProvisioningAuthority;
  writeAuthority?: typeof writeControlProvisioningAuthority;
  stagePending?: typeof stagePendingControlBootstrap;
  loadPending?: typeof loadPendingControlBootstrap;
  markRevocationConfirmed?: typeof markPendingControlBootstrapRevocationConfirmed;
  clearPending?: typeof clearPendingControlBootstrap;
  inspectRecoveryToken?: typeof inspectCloudflareBootstrapRecoveryToken;
  inspectPendingRecoveryState?: typeof inspectCloudflarePendingBootstrapRecoveryState;
  reconcileWithRecoveryToken?: typeof reconcileCloudflareBootstrapRevocationWithRecoveryToken;
  stageRecoveryToken?: typeof stagePendingControlBootstrapRecoveryToken;
  stageReconstructedRecovery?: typeof stageReconstructedPendingControlBootstrapRecovery;
}

export async function completeControlTokenBootstrap(input: {
  accountId: string;
  environment: string;
  rootDir: string;
  controlDatabaseName: string;
  bootstrapToken?: string;
  ownership: CloudflareTokenOwnership;
  resourceClasses: readonly ControlTokenResourceClass[];
  /** Dependency overrides are used by deterministic crash-boundary tests only. */
  dependencies?: CompleteControlTokenBootstrapDependencies;
}): Promise<void> {
  const readAuthority = input.dependencies?.readAuthority ?? readControlProvisioningAuthority;
  const writeAuthority = input.dependencies?.writeAuthority ?? writeControlProvisioningAuthority;
  const stagePending = input.dependencies?.stagePending ?? stagePendingControlBootstrap;
  const loadPending = input.dependencies?.loadPending ?? loadPendingControlBootstrap;
  const markRevocationConfirmed =
    input.dependencies?.markRevocationConfirmed ?? markPendingControlBootstrapRevocationConfirmed;
  const clearPending = input.dependencies?.clearPending ?? clearPendingControlBootstrap;
  const inspectRecoveryToken =
    input.dependencies?.inspectRecoveryToken ?? inspectCloudflareBootstrapRecoveryToken;
  const inspectPendingRecoveryState =
    input.dependencies?.inspectPendingRecoveryState ??
    inspectCloudflarePendingBootstrapRecoveryState;
  const reconcileWithRecoveryToken =
    input.dependencies?.reconcileWithRecoveryToken ??
    reconcileCloudflareBootstrapRevocationWithRecoveryToken;
  const stageRecoveryToken =
    input.dependencies?.stageRecoveryToken ?? stagePendingControlBootstrapRecoveryToken;
  const stageReconstructedRecovery =
    input.dependencies?.stageReconstructedRecovery ??
    stageReconstructedPendingControlBootstrapRecovery;
  const secretSink =
    input.dependencies?.secretSink ??
    new WranglerControlSecretSink({
      workerName: `${input.environment}-ar-control`,
      cwd: input.rootDir,
    });
  const authorityFor = (bootstrapToken: string): CloudflareTokenAuthority =>
    input.dependencies?.authority ??
    new CloudflareTokenAuthorityHttpClient({
      accountId: input.accountId,
      ownership: input.ownership,
      bootstrapToken,
    });
  let staged = await loadPending({ baseDir: input.rootDir, environment: input.environment });
  let cutoverStarted = staged !== null;
  let existing = await readAuthority({
    environmentId: input.environment,
    controlDatabaseName: input.controlDatabaseName,
  });
  if (existing?.capabilityState === 'ready') cutoverStarted = true;
  try {
    if (existing?.automaticProvisioningEnabled === true && existing.capabilityState === 'ready') {
      if (existing.tokenOwnership !== input.ownership) {
        throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_ownership_mismatch');
      }
      if (!existing.secretGeneration) {
        throw new CloudflareTokenBootstrapError('cloudflare_token_bootstrap_checkpoint_mismatch');
      }
      await assertExactControlSecretGeneration({
        resourceClasses: input.resourceClasses,
        secretSink,
        expected: existing.secretGeneration,
      });
      if (staged) {
        let checkpoint = assertReadyCheckpointMatchesArtifact({
          ...input,
          authority: existing,
          artifact: staged,
        });
        if (!staged.revocationConfirmed) {
          const suppliedRecoveryToken =
            input.bootstrapToken &&
            !fingerprintsMatch(
              staged.bootstrapTokenFingerprint,
              bootstrapTokenFingerprint(input.bootstrapToken)
            ) &&
            (!staged.recoveryToken ||
              !fingerprintsMatch(
                staged.recoveryToken.tokenFingerprint,
                bootstrapTokenFingerprint(input.bootstrapToken)
              ))
              ? input.bootstrapToken
              : undefined;
          if (suppliedRecoveryToken) {
            const inspected = await inspectRecoveryToken({
              accountId: input.accountId,
              ownership: input.ownership,
              authority: authorityFor(suppliedRecoveryToken),
            });
            staged = await stageRecoveryToken({
              baseDir: input.rootDir,
              environment: input.environment,
              token: suppliedRecoveryToken,
              tokenId: inspected.tokenId,
            });
            checkpoint = assertReadyCheckpointMatchesArtifact({
              ...input,
              authority: existing,
              artifact: staged,
            });
          }
          if (!staged.recoveryToken) {
            throw new CloudflareTokenBootstrapError(
              'cloudflare_bootstrap_recovery_token_required',
              true,
              undefined,
              true
            );
          }
          const refreshedAuthority = await readAuthority({
            environmentId: input.environment,
            controlDatabaseName: input.controlDatabaseName,
          });
          if (!refreshedAuthority) {
            throw new CloudflareTokenBootstrapError(
              'cloudflare_token_bootstrap_checkpoint_changed'
            );
          }
          const refreshedCheckpoint = assertReadyCheckpointMatchesArtifact({
            ...input,
            authority: refreshedAuthority,
            artifact: staged,
          });
          if (JSON.stringify(refreshedCheckpoint) !== JSON.stringify(checkpoint)) {
            throw new CloudflareTokenBootstrapError(
              'cloudflare_token_bootstrap_checkpoint_changed'
            );
          }
          await assertExactControlSecretGeneration({
            resourceClasses: input.resourceClasses,
            secretSink,
            expected: refreshedCheckpoint.secretGeneration,
          });
          const recoveryAuthority = authorityFor(staged.recoveryToken.token);
          const inspected = await inspectPendingRecoveryState({
            accountId: input.accountId,
            environment: input.environment,
            ownership: input.ownership,
            expectedBootstrapTokenId: checkpoint.bootstrapTokenId,
            expectedBootstrapTokenFingerprint: checkpoint.bootstrapTokenFingerprint,
            childTokens: checkpoint.childTokens,
            authority: recoveryAuthority,
          });
          if (inspected.recoveryTokenId !== staged.recoveryToken.tokenId) {
            throw new CloudflareTokenBootstrapError(
              'cloudflare_bootstrap_recovery_token_identity_mismatch'
            );
          }
          await reconcileWithRecoveryToken({
            accountId: input.accountId,
            ownership: input.ownership,
            expectedRecoveryTokenId: staged.recoveryToken.tokenId,
            revocationTargetTokenIds: staged.revocationTargetTokenIds,
            authority: recoveryAuthority,
          });
          staged = await markRevocationConfirmed({
            baseDir: input.rootDir,
            environment: input.environment,
          });
        }
      }
      await clearPending({ baseDir: input.rootDir, environment: input.environment });
      return;
    }

    // A process can stop after the private artifact is fsynced but before the Control checkpoint.
    // Reconstruct only that exact pending transition; never create a second child-token generation.
    if (staged && existing?.bootstrapPhase === 'none') {
      if (
        staged.accountId !== input.accountId ||
        staged.environment !== input.environment ||
        staged.ownership !== input.ownership
      ) {
        throw new CloudflareTokenBootstrapError('cloudflare_token_bootstrap_checkpoint_mismatch');
      }
      await writeAuthority({
        controlDatabaseName: input.controlDatabaseName,
        environmentId: input.environment,
        automaticProvisioningEnabled: true,
        tokenOwnership: 'none',
        tokenManagement: 'setup',
        capabilityState: 'pending',
        bootstrapPhase: staged.revocationConfirmed ? 'cutover_verified' : 'pending_revocation',
        bootstrapTokenOwnership: staged.ownership,
        bootstrapTokenId: staged.bootstrapTokenId,
        bootstrapTokenFingerprint: staged.bootstrapTokenFingerprint,
        childTokens: staged.childTokens,
        secretGeneration: staged.secretGeneration,
      });
      existing = await readAuthority({
        environmentId: input.environment,
        controlDatabaseName: input.controlDatabaseName,
      });
    }

    if (
      existing?.bootstrapPhase === 'pending_revocation' ||
      existing?.bootstrapPhase === 'cutover_verified'
    ) {
      cutoverStarted = true;
      const checkpoint = assertCheckpointMatchesRequest({
        ...input,
        authority: existing,
        artifact: staged,
      });
      await assertExactControlSecretGeneration({
        resourceClasses: input.resourceClasses,
        secretSink,
        expected: checkpoint.secretGeneration,
      });
      if (existing.bootstrapPhase === 'pending_revocation') {
        if (!staged) {
          if (!input.bootstrapToken) {
            throw new CloudflareTokenBootstrapError(
              'cloudflare_bootstrap_recovery_artifact_missing'
            );
          }
          const suppliedFingerprint = bootstrapTokenFingerprint(input.bootstrapToken);
          if (fingerprintsMatch(checkpoint.bootstrapTokenFingerprint, suppliedFingerprint)) {
            throw new CloudflareTokenBootstrapError(
              'cloudflare_bootstrap_recovery_token_not_independent'
            );
          }
          const recoveryAuthority = authorityFor(input.bootstrapToken);
          const inspected = await inspectPendingRecoveryState({
            accountId: input.accountId,
            environment: input.environment,
            ownership: input.ownership,
            expectedBootstrapTokenId: checkpoint.bootstrapTokenId,
            expectedBootstrapTokenFingerprint: checkpoint.bootstrapTokenFingerprint,
            childTokens: checkpoint.childTokens,
            authority: recoveryAuthority,
          });
          staged = await stageReconstructedRecovery({
            baseDir: input.rootDir,
            environment: input.environment,
            accountId: input.accountId,
            ownership: input.ownership,
            bootstrapTokenId: checkpoint.bootstrapTokenId,
            bootstrapTokenFingerprint: checkpoint.bootstrapTokenFingerprint,
            childTokens: checkpoint.childTokens,
            secretGeneration: checkpoint.secretGeneration,
            recoveryToken: input.bootstrapToken,
            recoveryTokenId: inspected.recoveryTokenId,
          });
          assertCheckpointMatchesRequest({ ...input, authority: existing, artifact: staged });
        }
        if (!staged.revocationConfirmed) {
          const currentRecoveryFingerprint = staged.recoveryToken?.tokenFingerprint;
          const suppliedRecoveryToken =
            input.bootstrapToken &&
            !fingerprintsMatch(
              staged.bootstrapTokenFingerprint,
              bootstrapTokenFingerprint(input.bootstrapToken)
            ) &&
            (!currentRecoveryFingerprint ||
              !fingerprintsMatch(
                currentRecoveryFingerprint,
                bootstrapTokenFingerprint(input.bootstrapToken)
              ))
              ? input.bootstrapToken
              : undefined;
          if (suppliedRecoveryToken) {
            const recoveryAuthority = authorityFor(suppliedRecoveryToken);
            const inspected = await inspectRecoveryToken({
              accountId: input.accountId,
              ownership: input.ownership,
              authority: recoveryAuthority,
            });
            staged = await stageRecoveryToken({
              baseDir: input.rootDir,
              environment: input.environment,
              token: suppliedRecoveryToken,
              tokenId: inspected.tokenId,
            });
          }
          const refreshedAuthority = await readAuthority({
            environmentId: input.environment,
            controlDatabaseName: input.controlDatabaseName,
          });
          if (!refreshedAuthority || refreshedAuthority.bootstrapPhase !== 'pending_revocation') {
            throw new CloudflareTokenBootstrapError(
              'cloudflare_token_bootstrap_checkpoint_changed'
            );
          }
          const refreshedCheckpoint = assertCheckpointMatchesRequest({
            ...input,
            authority: refreshedAuthority,
            artifact: staged,
          });
          if (JSON.stringify(refreshedCheckpoint) !== JSON.stringify(checkpoint)) {
            throw new CloudflareTokenBootstrapError(
              'cloudflare_token_bootstrap_checkpoint_changed'
            );
          }
          await assertExactControlSecretGeneration({
            resourceClasses: input.resourceClasses,
            secretSink,
            expected: refreshedCheckpoint.secretGeneration,
          });
          if (staged.recoveryToken) {
            const recoveryAuthority = authorityFor(staged.recoveryToken.token);
            const inspected = await inspectPendingRecoveryState({
              accountId: input.accountId,
              environment: input.environment,
              ownership: input.ownership,
              expectedBootstrapTokenId: checkpoint.bootstrapTokenId,
              expectedBootstrapTokenFingerprint: checkpoint.bootstrapTokenFingerprint,
              childTokens: checkpoint.childTokens,
              authority: recoveryAuthority,
            });
            if (inspected.recoveryTokenId !== staged.recoveryToken.tokenId) {
              throw new CloudflareTokenBootstrapError(
                'cloudflare_bootstrap_recovery_token_identity_mismatch'
              );
            }
            await reconcileWithRecoveryToken({
              accountId: input.accountId,
              ownership: input.ownership,
              expectedRecoveryTokenId: staged.recoveryToken.tokenId,
              revocationTargetTokenIds: staged.revocationTargetTokenIds,
              authority: recoveryAuthority,
            });
          } else {
            if (staged.bootstrapToken === null) {
              throw new CloudflareTokenBootstrapError(
                'cloudflare_bootstrap_recovery_artifact_invalid'
              );
            }
            try {
              await (
                input.dependencies?.resumeRevocation ?? resumeCloudflareBootstrapTokenRevocation
              )({
                accountId: input.accountId,
                ownership: input.ownership,
                expectedBootstrapTokenId: checkpoint.bootstrapTokenId,
                authority: authorityFor(staged.bootstrapToken),
              });
            } catch (error) {
              if (
                error instanceof CloudflareTokenBootstrapError &&
                [
                  'cloudflare_token_api_http_401',
                  'cloudflare_token_api_http_403',
                  'cloudflare_token_api_rejected',
                  'cloudflare_bootstrap_revocation_unconfirmed',
                ].includes(error.code)
              ) {
                throw new CloudflareTokenBootstrapError(
                  'cloudflare_bootstrap_recovery_token_required',
                  true,
                  undefined,
                  true
                );
              }
              throw error;
            }
          }
          staged = await markRevocationConfirmed({
            baseDir: input.rootDir,
            environment: input.environment,
          });
        }
        await writeAuthority({
          controlDatabaseName: input.controlDatabaseName,
          environmentId: input.environment,
          automaticProvisioningEnabled: true,
          tokenOwnership: 'none',
          tokenManagement: 'setup',
          capabilityState: 'pending',
          bootstrapPhase: 'cutover_verified',
          bootstrapTokenOwnership: input.ownership,
          bootstrapTokenId: checkpoint.bootstrapTokenId,
          bootstrapTokenFingerprint: checkpoint.bootstrapTokenFingerprint,
          childTokens: checkpoint.childTokens,
          secretGeneration: checkpoint.secretGeneration,
        });
      }
      await writeAuthority({
        controlDatabaseName: input.controlDatabaseName,
        environmentId: input.environment,
        automaticProvisioningEnabled: true,
        tokenOwnership: input.ownership,
        tokenManagement: 'setup',
        capabilityState: 'ready',
        childTokens: checkpoint.childTokens,
        secretGeneration: checkpoint.secretGeneration,
      });
      await clearPending({ baseDir: input.rootDir, environment: input.environment });
      return;
    }

    if (!input.bootstrapToken) {
      throw new CloudflareTokenBootstrapError('cloudflare_bootstrap_token_required');
    }
    const bootstrapToken = input.bootstrapToken;
    const fingerprint = bootstrapTokenFingerprint(bootstrapToken);
    const result = await (input.dependencies?.bootstrap ?? bootstrapControlWorkerTokens)({
      accountId: input.accountId,
      environment: input.environment,
      ownership: input.ownership,
      resourceClasses: input.resourceClasses,
      authority: authorityFor(bootstrapToken),
      secretSink,
      verifyControlSecretCutover: async (prepared) => {
        await assertExactControlSecretGeneration({
          resourceClasses: input.resourceClasses,
          secretSink,
          expected: prepared.secretGeneration,
        });
        return true;
      },
      beforeBootstrapRevocation: async (prepared: ControlTokenBootstrapPreparedResult) => {
        await stagePending({
          baseDir: input.rootDir,
          artifact: {
            version: 1,
            environment: input.environment,
            accountId: input.accountId,
            ownership: input.ownership,
            bootstrapToken,
            bootstrapTokenId: prepared.bootstrapTokenId,
            bootstrapTokenFingerprint: fingerprint,
            childTokens: prepared.childTokens,
            secretGeneration: prepared.secretGeneration,
            revocationTargetTokenIds: [prepared.bootstrapTokenId],
            recoveryToken: null,
            revocationConfirmed: false,
          },
        });
        staged = await loadPending({ baseDir: input.rootDir, environment: input.environment });
        if (!staged) throw new Error('pending_control_bootstrap_reflection_failed');
        cutoverStarted = true;
        await writeAuthority({
          controlDatabaseName: input.controlDatabaseName,
          environmentId: input.environment,
          automaticProvisioningEnabled: true,
          tokenOwnership: 'none',
          tokenManagement: 'setup',
          capabilityState: 'pending',
          bootstrapPhase: 'pending_revocation',
          bootstrapTokenOwnership: input.ownership,
          bootstrapTokenId: prepared.bootstrapTokenId,
          bootstrapTokenFingerprint: fingerprint,
          childTokens: prepared.childTokens,
          secretGeneration: prepared.secretGeneration,
        });
      },
      afterBootstrapRevocation: async (revoked) => {
        staged = await markRevocationConfirmed({
          baseDir: input.rootDir,
          environment: input.environment,
        });
        await writeAuthority({
          controlDatabaseName: input.controlDatabaseName,
          environmentId: input.environment,
          automaticProvisioningEnabled: true,
          tokenOwnership: 'none',
          tokenManagement: 'setup',
          capabilityState: 'pending',
          bootstrapPhase: 'cutover_verified',
          bootstrapTokenOwnership: input.ownership,
          bootstrapTokenId: revoked.bootstrapTokenId,
          bootstrapTokenFingerprint: fingerprint,
          childTokens: revoked.childTokens,
          secretGeneration: revoked.secretGeneration,
        });
      },
    });
    await writeAuthority({
      controlDatabaseName: input.controlDatabaseName,
      environmentId: input.environment,
      automaticProvisioningEnabled: true,
      tokenOwnership: input.ownership,
      tokenManagement: 'setup',
      capabilityState: 'ready',
      childTokens: result.childTokens,
      secretGeneration: result.secretGeneration,
    });
    await clearPending({ baseDir: input.rootDir, environment: input.environment });
  } catch (error) {
    if (!cutoverStarted) {
      const current = await readAuthority({
        environmentId: input.environment,
        controlDatabaseName: input.controlDatabaseName,
      }).catch(() => null);
      if (
        current?.bootstrapPhase === 'pending_revocation' ||
        current?.bootstrapPhase === 'cutover_verified'
      ) {
        cutoverStarted = true;
      }
    }
    // After the private intent exists, a failed authority read must not erase or downgrade the
    // only durable evidence needed to finish revocation safely.
    if (cutoverStarted) throw error;
    const failureAuthority = classifyControlTokenBootstrapFailure(error, input.ownership);
    await writeAuthority({
      controlDatabaseName: input.controlDatabaseName,
      environmentId: input.environment,
      automaticProvisioningEnabled: true,
      ...failureAuthority,
    }).catch(() => undefined);
    throw error;
  }
}
