import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { AuthrimConfigSchema } from '../../core/config.js';
import {
  loadControlGeneratedKeyState,
  loadControlStagedSigningKeys,
  projectControlGeneratedKeyState,
  type ControlStagedSigningKey,
} from '../../core/control-generated-state.js';
import { reconcileLocalControlKeyFiles } from '../../core/control-key-state.js';
import { SECRET_UPLOAD_PLAN } from '../../core/deploy.js';
import {
  acquireEnvironmentOperationLock,
  loadLockFileAuto,
  saveLockFile,
  type AuthrimLock,
  type ControlKeyState,
} from '../../core/lock.js';
import { CORE_WORKER_COMPONENTS, type WorkerComponent } from '../../core/naming.js';
import { findAuthrimBaseDir, getEnvironmentPaths } from '../../core/paths.js';
import {
  activateControlSigningKeyRotation,
  stageControlSigningKeyRotation,
  type ControlSigningKeyPurpose,
  type StagedSigningKeyRotation,
} from '../../core/signing-key-rotation.js';
import { waitForSigningKeyVerification } from '../../core/signing-key-verification.js';
import { resolveDownstreamIntrospectionKeysDir } from '../../core/downstream-introspection-deploy.js';
import { deployCommand, getDeployKeysDirHint } from './deploy.js';

export interface SigningKeyRotateOptions {
  env?: string;
  source?: string;
  keysDir?: string;
  skipBuild?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

interface EnvironmentContext {
  environmentBaseDir: string;
  sourceDir: string;
  env: string;
  configPath: string;
  lockPath: string;
  keysDir: string;
}

interface RefreshedSigningState {
  lock: AuthrimLock;
  keyState: ControlKeyState;
  staged: ControlStagedSigningKey[];
}

function assertSigningKeyEnvironmentLock(lock: AuthrimLock, environment: string): void {
  if (lock.env !== environment) {
    throw new Error('signing_key_rotation_lock_environment_mismatch');
  }
}

function purposeState(
  state: ControlKeyState,
  purpose: ControlSigningKeyPurpose
): ControlKeyState['runtimeRegistry'] {
  return purpose === 'runtime_registry' ? state.runtimeRegistry : state.smokeRpc;
}

function verificationSecret(purpose: ControlSigningKeyPurpose): string {
  return purpose === 'runtime_registry'
    ? 'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS'
    : 'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS';
}

export function signingRotationTargetComponents(
  purpose: ControlSigningKeyPurpose
): WorkerComponent[] {
  const secret = verificationSecret(purpose);
  return CORE_WORKER_COMPONENTS.filter(
    (component) =>
      component === 'ar-control' ||
      (SECRET_UPLOAD_PLAN[component] as readonly string[]).includes(secret)
  );
}

export function signingVerificationTargetComponents(
  purpose: ControlSigningKeyPurpose
): WorkerComponent[] {
  const secret = verificationSecret(purpose);
  return CORE_WORKER_COMPONENTS.filter((component) =>
    (SECRET_UPLOAD_PLAN[component] as readonly string[]).includes(secret)
  );
}

function deployedAtMillis(lock: AuthrimLock, component: WorkerComponent): number | null {
  const value = lock.workers?.[component]?.deployedAt;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function activatedSigningRotationNeedsDeployment(
  lock: AuthrimLock,
  purpose: ControlSigningKeyPurpose
): boolean {
  const state = lock.controlKeyState && purposeState(lock.controlKeyState, purpose);
  if (!state?.previousSlot) return false;
  const activatedAtMillis = state.updatedAt * 1000;
  return signingRotationTargetComponents(purpose).some((component) => {
    const deployedAt = deployedAtMillis(lock, component);
    return deployedAt === null || deployedAt <= activatedAtMillis;
  });
}

function latestTargetDeploymentMillis(
  lock: AuthrimLock,
  purpose: ControlSigningKeyPurpose
): number {
  const deployments = signingRotationTargetComponents(purpose).map((component) => {
    const deployedAt = deployedAtMillis(lock, component);
    if (deployedAt === null)
      throw new Error(`signing_key_rotation_target_not_deployed:${component}`);
    return deployedAt;
  });
  return Math.max(...deployments);
}

async function waitUntilEpochSecondAfter(timestampMillis: number): Promise<number> {
  const target = Math.floor(timestampMillis / 1000) + 1;
  const delay = target * 1000 - Date.now();
  if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  return Math.max(target, Math.floor(Date.now() / 1000));
}

async function loadEnvironment(options: SigningKeyRotateOptions): Promise<EnvironmentContext> {
  const env = options.env ?? 'prod';
  const baseDir = findAuthrimBaseDir(process.cwd());
  const paths = getEnvironmentPaths({ baseDir, env });
  if (!existsSync(paths.config)) throw new Error(`environment_config_not_found:${env}`);
  const config = AuthrimConfigSchema.parse(JSON.parse(await readFile(paths.config, 'utf8')));
  if (config.environment.prefix !== env) {
    throw new Error('signing_key_rotation_config_environment_mismatch');
  }
  const source = options.source ? resolve(options.source) : baseDir;
  const keysDir = resolveDownstreamIntrospectionKeysDir({
    env,
    rootDir: baseDir,
    keysDir: getDeployKeysDirHint({
      baseDir,
      explicitKeysDir: options.keysDir,
      configuredKeysDir: config.keys.secretsPath,
    }),
    keysBaseDir: process.cwd(),
  });
  if (!existsSync(keysDir)) throw new Error(`environment_keys_not_found:${env}`);
  return {
    environmentBaseDir: baseDir,
    sourceDir: source,
    env,
    configPath: paths.config,
    lockPath: paths.lock,
    keysDir,
  };
}

async function refreshSigningState(input: {
  context: EnvironmentContext;
  lock: AuthrimLock;
}): Promise<RefreshedSigningState> {
  assertSigningKeyEnvironmentLock(input.lock, input.context.env);
  const controlDatabaseId = input.lock.d1.CONTROL_DB?.id;
  if (!controlDatabaseId) throw new Error('control_database_required_for_signing_key_rotation');
  const keyState = await loadControlGeneratedKeyState({
    controlDatabaseName: controlDatabaseId,
    environmentId: input.context.env,
  });
  if (!keyState) throw new Error('control_generated_key_state_missing');
  const staged = await loadControlStagedSigningKeys({
    controlDatabaseName: controlDatabaseId,
    environmentId: input.context.env,
  });
  await reconcileLocalControlKeyFiles({
    keysDir: input.context.keysDir,
    controlKeyState: keyState,
    stagedSigningKeys: staged,
  });
  const projection = projectControlGeneratedKeyState(input.lock, keyState);
  if (projection.changed) await saveLockFile(projection.lock, input.context.lockPath);
  return { lock: projection.lock, keyState, staged };
}

function stagedForPurpose(
  staged: readonly ControlStagedSigningKey[],
  purpose: ControlSigningKeyPurpose
): ControlStagedSigningKey | undefined {
  const matches = staged.filter((candidate) => candidate.purpose === purpose);
  if (matches.length > 1) throw new Error('control_generated_staged_signing_key_invalid');
  const conflicting = staged.find((candidate) => candidate.purpose !== purpose);
  if (conflicting) {
    throw new Error(`signing_key_rotation_other_purpose_in_progress:${conflicting.purpose}`);
  }
  return matches[0];
}

function assertStagedMatches(
  candidate: ControlStagedSigningKey | undefined,
  staged: StagedSigningKeyRotation
): void {
  if (
    !candidate ||
    candidate.slot !== staged.candidateSlot ||
    candidate.keyId !== staged.candidateKeyId ||
    candidate.fingerprint !== staged.candidateFingerprint
  ) {
    throw new Error('signing_key_rotation_staged_state_changed');
  }
}

async function deployRotationState(
  context: EnvironmentContext,
  options: SigningKeyRotateOptions,
  purpose: ControlSigningKeyPurpose
): Promise<void> {
  await deployCommand({
    env: context.env,
    config: context.configPath,
    source: context.sourceDir,
    keysDir: context.keysDir,
    skipBuild: options.skipBuild,
    skipUi: true,
    yes: true,
    operationKind: 'worker_redeploy',
    components: signingRotationTargetComponents(purpose),
  });
}

async function rotateControlSigningKey(
  purpose: ControlSigningKeyPurpose,
  options: SigningKeyRotateOptions
): Promise<void> {
  const context = await loadEnvironment(options);
  const label = purpose === 'runtime_registry' ? 'Runtime Registry' : 'smoke RPC';
  const initial = await loadLockFileAuto(context.environmentBaseDir, context.env);
  if (!initial.lock) throw new Error(`environment_lock_not_found:${context.env}`);
  assertSigningKeyEnvironmentLock(initial.lock, context.env);

  console.log(chalk.bold(`\nAuthrim ${label} signing key rotation\n`));
  console.log(`Environment: ${chalk.cyan(context.env)}`);
  console.log(`Targets: ${chalk.cyan(signingRotationTargetComponents(purpose).length)}`);
  if (options.dryRun) {
    console.log(chalk.yellow('Dry run only. No key, Control DB, secret, or Worker was changed.'));
    return;
  }
  if (!options.yes) {
    const accepted = await confirm({
      message: `Rotate the ${label} signing key and redeploy all affected Workers twice?`,
      default: false,
    });
    if (!accepted) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  let staged: StagedSigningKeyRotation | undefined;
  let resumeActivated = false;
  const prepareLock = await acquireEnvironmentOperationLock(
    context.lockPath,
    `rotate-signing-key:${purpose}:prepare`
  );
  try {
    const current = await loadLockFileAuto(context.environmentBaseDir, context.env);
    if (!current.lock) throw new Error(`environment_lock_not_found:${context.env}`);
    const refreshed = await refreshSigningState({ context, lock: current.lock });
    const candidate = stagedForPurpose(refreshed.staged, purpose);
    resumeActivated =
      !candidate && activatedSigningRotationNeedsDeployment(refreshed.lock, purpose);
    if (!resumeActivated) {
      const controlDatabaseId = refreshed.lock.d1.CONTROL_DB?.id;
      if (!controlDatabaseId) {
        throw new Error('control_database_required_for_signing_key_rotation');
      }
      staged = await stageControlSigningKeyRotation({
        controlDatabaseId,
        environmentId: context.env,
        keysDir: context.keysDir,
        purpose,
        controlKeyState: refreshed.keyState,
        actorId: 'setup:key-rotation',
      });
      const afterStage = await refreshSigningState({ context, lock: refreshed.lock });
      assertStagedMatches(stagedForPurpose(afterStage.staged, purpose), staged);
    }
  } finally {
    await prepareLock.release();
  }

  if (!resumeActivated) {
    console.log(chalk.cyan('Deploying candidate verification material with the old key active...'));
    await deployRotationState(context, options, purpose);

    const verificationLock = await loadLockFileAuto(context.environmentBaseDir, context.env);
    if (verificationLock.lock) {
      assertSigningKeyEnvironmentLock(verificationLock.lock, context.env);
    }
    const controlDatabaseId = verificationLock.lock?.d1.CONTROL_DB?.id;
    if (!controlDatabaseId || !staged) {
      throw new Error('signing_key_rotation_state_missing');
    }
    const verificationCandidate = (
      await loadControlStagedSigningKeys({
        controlDatabaseName: controlDatabaseId,
        environmentId: context.env,
      })
    ).find((candidate) => candidate.purpose === purpose);
    if (!verificationCandidate) throw new Error('signing_key_rotation_staged_state_missing');
    console.log(chalk.cyan('Waiting for candidate test-vector verification on all targets...'));
    await waitForSigningKeyVerification({
      controlDatabaseName: controlDatabaseId,
      environmentId: context.env,
      purpose,
      keyId: staged.candidateKeyId,
      stagedAt: verificationCandidate.updatedAt,
      expectedWorkerScriptNames: signingVerificationTargetComponents(purpose).map(
        (component) => `${context.env}-${component}`
      ),
      onProgress: (status) => {
        console.log(
          chalk.gray(
            `  verified ${status.succeeded}/${status.expected}` +
              (status.failed > 0 ? `, retrying ${status.failed} failed target(s)` : '')
          )
        );
      },
    });

    const activationLock = await acquireEnvironmentOperationLock(
      context.lockPath,
      `rotate-signing-key:${purpose}:activate`
    );
    try {
      const current = await loadLockFileAuto(context.environmentBaseDir, context.env);
      if (!current.lock || !staged) throw new Error('signing_key_rotation_state_missing');
      const refreshed = await refreshSigningState({ context, lock: current.lock });
      assertStagedMatches(stagedForPurpose(refreshed.staged, purpose), staged);
      const controlDatabaseId = refreshed.lock.d1.CONTROL_DB?.id;
      if (!controlDatabaseId) {
        throw new Error('control_database_required_for_signing_key_rotation');
      }
      const activationNow = await waitUntilEpochSecondAfter(
        latestTargetDeploymentMillis(refreshed.lock, purpose)
      );
      await activateControlSigningKeyRotation({
        controlDatabaseId,
        environmentId: context.env,
        keysDir: context.keysDir,
        staged,
        expectedWorkerScriptNames: signingVerificationTargetComponents(purpose).map(
          (component) => `${context.env}-${component}`
        ),
        actorId: 'setup:key-rotation',
        now: activationNow,
      });
      const activated = await refreshSigningState({ context, lock: refreshed.lock });
      const active = purposeState(activated.keyState, purpose);
      if (
        active.activeSlot !== staged.candidateSlot ||
        active.activeKeyId !== staged.candidateKeyId ||
        active.activeFingerprint !== staged.candidateFingerprint ||
        stagedForPurpose(activated.staged, purpose)
      ) {
        throw new Error('signing_key_rotation_activation_state_invalid');
      }
    } finally {
      await activationLock.release();
    }
  } else {
    console.log(chalk.yellow('Resuming after an already committed active-slot switch.'));
  }

  const beforeFinalDeploy = await loadLockFileAuto(context.environmentBaseDir, context.env);
  if (!beforeFinalDeploy.lock?.controlKeyState) {
    throw new Error('signing_key_rotation_state_missing');
  }
  assertSigningKeyEnvironmentLock(beforeFinalDeploy.lock, context.env);
  await waitUntilEpochSecondAfter(
    purposeState(beforeFinalDeploy.lock.controlKeyState, purpose).updatedAt * 1000
  );
  console.log(chalk.cyan('Deploying the active-slot switch with both verification keys...'));
  await deployRotationState(context, options, purpose);

  const finalLock = await loadLockFileAuto(context.environmentBaseDir, context.env);
  if (finalLock.lock) assertSigningKeyEnvironmentLock(finalLock.lock, context.env);
  if (!finalLock.lock || activatedSigningRotationNeedsDeployment(finalLock.lock, purpose)) {
    throw new Error('signing_key_rotation_final_deployment_not_observed');
  }
  console.log(chalk.green(`${label} signing key rotation completed.`));
}

export function rotateRuntimeRegistrySigningKeyCommand(
  options: SigningKeyRotateOptions
): Promise<void> {
  return rotateControlSigningKey('runtime_registry', options);
}

export function rotateSmokeRpcSigningKeyCommand(options: SigningKeyRotateOptions): Promise<void> {
  return rotateControlSigningKey('smoke_rpc', options);
}
