import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { AuthrimConfigSchema, type AuthrimConfig } from '../../core/config.js';
import {
  loadControlGeneratedKeyState,
  loadControlStagedSigningKeys,
  projectControlGeneratedKeyState,
} from '../../core/control-generated-state.js';
import { reconcileLocalControlKeyFiles } from '../../core/control-key-state.js';
import {
  acquireEnvironmentOperationLock,
  loadLockFileAuto,
  saveLockFile,
  type AuthrimLock,
  type ControlKeyState,
} from '../../core/lock.js';
import { findAuthrimBaseDir, getEnvironmentPaths } from '../../core/paths.js';
import { resolveDownstreamIntrospectionKeysDir } from '../../core/downstream-introspection-deploy.js';
import { fetchWithTimeout, readResponseJsonWithLimit } from '../../core/http-limits.js';
import { requestAdminMachineAccessToken } from '../../core/admin-machine-access.js';
import { SECRET_UPLOAD_PLAN } from '../../core/deploy.js';
import {
  cleanupSetupMachineAccessInD1,
  ensureSetupMachineAccessInD1,
  type SetupMachineAccessBootstrapResult,
} from '../../core/cloudflare.js';
import { CORE_WORKER_COMPONENTS, type WorkerComponent } from '../../core/naming.js';
import { resolveIssuerUrl } from '../../core/url-config.js';
import { deployCommand, getDeployKeysDirHint } from './deploy.js';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const LOOKUP_HMAC_TARGET_COUNT = 5;
const WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;
const VERIFICATION_STATUS_KEYS = new Set([
  'phase',
  'expected',
  'succeeded',
  'failed',
  'pending',
  'complete',
]);

export function lookupHmacRotationTargetComponents(): WorkerComponent[] {
  return CORE_WORKER_COMPONENTS.filter((component) => {
    const secrets = SECRET_UPLOAD_PLAN[component] as readonly string[];
    return secrets.includes('LOOKUP_HMAC_KEY_SLOT_A') || secrets.includes('LOOKUP_HMAC_KEY_SLOT_B');
  });
}

export interface LookupHmacRotateOptions {
  env?: string;
  source?: string;
  keysDir?: string;
  skipBuild?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

export interface LookupHmacMetadata {
  generation: number;
  keyId: string;
  slot: 'A' | 'B';
  fingerprint: string;
}

export interface LookupHmacRotation {
  operationId: string;
  state:
    | 'planned'
    | 'distributing'
    | 'activation_dual_write'
    | 'dual_read'
    | 'reindexing'
    | 'verifying'
    | 'grace'
    | 'complete'
    | 'blocked';
  source: LookupHmacMetadata;
  candidate: LookupHmacMetadata;
  fencingToken: number;
}

export interface PendingLookupHmacRotation {
  schemaVersion: 1;
  environmentId: string;
  idempotencyKey: string;
  source: LookupHmacMetadata;
  candidate: LookupHmacMetadata;
  operationId: string | null;
}

interface EnvironmentContext {
  environmentBaseDir: string;
  sourceDir: string;
  env: string;
  configPath: string;
  lockPath: string;
  keysDir: string;
  config: AuthrimConfig;
  apiBaseUrl: string;
}

export async function runWithEphemeralSetupMachineAccess<T>(
  input: {
    env: string;
    config: AuthrimConfig;
    keysDir: string;
    ensure?: (
      env: string,
      config: AuthrimConfig,
      keysDir: string
    ) => Promise<SetupMachineAccessBootstrapResult>;
    cleanup?: (env: string, keysDir: string) => Promise<SetupMachineAccessBootstrapResult>;
  },
  action: () => Promise<T>
): Promise<T> {
  const ensure = input.ensure ?? ensureSetupMachineAccessInD1;
  const cleanup = input.cleanup ?? cleanupSetupMachineAccessInD1;
  const bootstrap = await ensure(input.env, input.config, input.keysDir);
  if (!bootstrap.success) {
    throw new Error(`lookup_hmac_setup_machine_bootstrap_failed:${bootstrap.error ?? 'unknown'}`);
  }

  let result: T | undefined;
  let actionError: unknown;
  try {
    result = await action();
  } catch (error) {
    actionError = error;
  }

  let cleanupResult: SetupMachineAccessBootstrapResult;
  try {
    cleanupResult = await cleanup(input.env, input.keysDir);
  } catch (error) {
    cleanupResult = {
      success: false,
      error: error instanceof Error ? error.message : 'cleanup_threw_non_error',
    };
  }
  if (!cleanupResult.success) {
    const cleanupError = new Error(
      `lookup_hmac_setup_machine_cleanup_failed:${cleanupResult.error ?? 'unknown'}`
    );
    if (actionError) {
      throw new AggregateError(
        [actionError, cleanupError],
        'lookup_hmac_rotation_and_machine_cleanup_failed'
      );
    }
    throw cleanupError;
  }
  if (actionError) {
    if (actionError instanceof Error) throw actionError;
    throw new Error('lookup_hmac_rotation_failed', { cause: actionError });
  }
  return result as T;
}

function pendingMetadataPath(keysDir: string): string {
  return join(keysDir, '.lookup_hmac_rotation.pending.json');
}

function pendingSecretPath(keysDir: string, candidate: LookupHmacMetadata): string {
  return join(
    keysDir,
    `.lookup_hmac_key_slot_${candidate.slot.toLowerCase()}.txt.staged.${candidate.keyId}`
  );
}

function slotPath(keysDir: string, slot: 'A' | 'B'): string {
  return join(keysDir, `lookup_hmac_key_slot_${slot.toLowerCase()}.txt`);
}

function fingerprint(secret: string): string {
  return createHash('sha256').update(secret.trim()).digest('hex');
}

function metadata(value: unknown, code: string): LookupHmacMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(',') !== 'fingerprint,generation,keyId,slot' ||
    !Number.isSafeInteger(item.generation) ||
    (item.generation as number) < 1 ||
    typeof item.keyId !== 'string' ||
    !SAFE_ID.test(item.keyId) ||
    (item.slot !== 'A' && item.slot !== 'B') ||
    typeof item.fingerprint !== 'string' ||
    !HEX_DIGEST.test(item.fingerprint)
  ) {
    throw new Error(code);
  }
  return item as unknown as LookupHmacMetadata;
}

function sameMetadata(left: LookupHmacMetadata, right: LookupHmacMetadata): boolean {
  return (
    left.generation === right.generation &&
    left.keyId === right.keyId &&
    left.slot === right.slot &&
    left.fingerprint === right.fingerprint
  );
}

async function writeSensitive(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

export function parsePendingLookupHmacRotation(
  serialized: string,
  environmentId: string
): PendingLookupHmacRotation {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('lookup_hmac_rotation_pending_state_invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('lookup_hmac_rotation_pending_state_invalid');
  }
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(',') !==
      'candidate,environmentId,idempotencyKey,operationId,schemaVersion,source' ||
    item.schemaVersion !== 1 ||
    item.environmentId !== environmentId ||
    typeof item.idempotencyKey !== 'string' ||
    !SAFE_ID.test(item.idempotencyKey) ||
    (item.operationId !== null &&
      (typeof item.operationId !== 'string' || !SAFE_ID.test(item.operationId)))
  ) {
    throw new Error('lookup_hmac_rotation_pending_state_invalid');
  }
  const source = metadata(item.source, 'lookup_hmac_rotation_pending_state_invalid');
  const candidate = metadata(item.candidate, 'lookup_hmac_rotation_pending_state_invalid');
  if (
    candidate.generation !== source.generation + 1 ||
    candidate.slot === source.slot ||
    candidate.keyId === source.keyId ||
    candidate.fingerprint === source.fingerprint ||
    item.idempotencyKey !== `lookup-hmac-${candidate.generation}-${candidate.keyId}`
  ) {
    throw new Error('lookup_hmac_rotation_pending_state_invalid');
  }
  return {
    schemaVersion: 1,
    environmentId,
    idempotencyKey: item.idempotencyKey,
    source,
    candidate,
    operationId: item.operationId as string | null,
  };
}

async function loadPending(context: EnvironmentContext): Promise<PendingLookupHmacRotation | null> {
  const path = pendingMetadataPath(context.keysDir);
  const serialized = await readFile(path, 'utf8').catch(() => null);
  if (serialized === null) return null;
  return parsePendingLookupHmacRotation(serialized, context.env);
}

async function savePending(
  context: EnvironmentContext,
  pending: PendingLookupHmacRotation
): Promise<void> {
  await writeSensitive(pendingMetadataPath(context.keysDir), JSON.stringify(pending, null, 2));
}

export async function promoteLookupHmacCandidateSecret(
  keysDir: string,
  pending: PendingLookupHmacRotation
): Promise<void> {
  const target = slotPath(keysDir, pending.candidate.slot);
  const source = pendingSecretPath(keysDir, pending.candidate);
  const existing = await readFile(target, 'utf8').catch(() => null);
  if (existing !== null && fingerprint(existing) === pending.candidate.fingerprint) {
    await unlink(source).catch(() => undefined);
    return;
  }
  const candidate = await readFile(source, 'utf8').catch(() => null);
  if (candidate === null || fingerprint(candidate) !== pending.candidate.fingerprint) {
    throw new Error('lookup_hmac_rotation_candidate_secret_missing');
  }
  await rename(source, target);
  await chmod(target, 0o600);
}

export function assertPendingLookupHmacState(
  pending: PendingLookupHmacRotation,
  state: ControlKeyState['lookupHmac']
): void {
  const active = {
    generation: state.activeGeneration,
    keyId: state.activeKeyId,
    slot: state.activeSlot,
    fingerprint: state.activeFingerprint,
  } satisfies LookupHmacMetadata;
  const sourceIsActive =
    sameMetadata(active, pending.source) && state.previousGeneration === undefined;
  const previousMatchesSource =
    state.previousGeneration === pending.source.generation &&
    state.previousKeyId === pending.source.keyId &&
    state.previousSlot === pending.source.slot &&
    state.previousFingerprint === pending.source.fingerprint;
  const completedState =
    pending.operationId !== null &&
    state.previousGeneration === undefined &&
    state.previousKeyId === undefined &&
    state.previousSlot === undefined &&
    state.previousFingerprint === undefined;
  const candidateIsActive =
    sameMetadata(active, pending.candidate) && (previousMatchesSource || completedState);
  if (!sourceIsActive && !candidateIsActive) {
    throw new Error('lookup_hmac_rotation_pending_state_stale');
  }
}

export function assertLookupHmacRotationMatchesPending(
  rotation: LookupHmacRotation,
  pending: PendingLookupHmacRotation
): void {
  if (
    !sameMetadata(rotation.source, pending.source) ||
    !sameMetadata(rotation.candidate, pending.candidate) ||
    (pending.operationId !== null && pending.operationId !== rotation.operationId)
  ) {
    throw new Error('lookup_hmac_rotation_control_state_mismatch');
  }
}

async function loadEnvironment(options: LookupHmacRotateOptions): Promise<EnvironmentContext> {
  const env = options.env ?? 'prod';
  const baseDir = findAuthrimBaseDir(process.cwd());
  const paths = getEnvironmentPaths({ baseDir, env });
  if (!existsSync(paths.config)) throw new Error(`environment_config_not_found:${env}`);
  const config = AuthrimConfigSchema.parse(JSON.parse(await readFile(paths.config, 'utf8')));
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
    sourceDir: options.source ? resolve(options.source) : baseDir,
    env,
    configPath: paths.config,
    lockPath: paths.lock,
    keysDir,
    config,
    apiBaseUrl: resolveIssuerUrl(config, { env }),
  };
}

async function refreshKeyState(
  context: EnvironmentContext,
  lock: AuthrimLock
): Promise<{ lock: AuthrimLock; keyState: ControlKeyState }> {
  const controlDatabaseName = lock.d1.CONTROL_DB?.name;
  if (!controlDatabaseName) throw new Error('control_database_required_for_lookup_hmac_rotation');
  const keyState = await loadControlGeneratedKeyState({
    controlDatabaseName,
    environmentId: context.env,
  });
  if (!keyState) throw new Error('control_generated_key_state_missing');
  const stagedSigningKeys = await loadControlStagedSigningKeys({
    controlDatabaseName,
    environmentId: context.env,
  });
  await reconcileLocalControlKeyFiles({
    keysDir: context.keysDir,
    controlKeyState: keyState,
    stagedSigningKeys,
  });
  const projection = projectControlGeneratedKeyState(lock, keyState);
  if (projection.changed) await saveLockFile(projection.lock, context.lockPath);
  return { lock: projection.lock, keyState };
}

export function parseLookupHmacRotation(value: unknown): LookupHmacRotation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('lookup_hmac_rotation_response_invalid');
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.operationId !== 'string' ||
    !SAFE_ID.test(item.operationId) ||
    typeof item.state !== 'string' ||
    ![
      'planned',
      'distributing',
      'activation_dual_write',
      'dual_read',
      'reindexing',
      'verifying',
      'grace',
      'complete',
      'blocked',
    ].includes(item.state) ||
    !Number.isSafeInteger(item.fencingToken) ||
    (item.fencingToken as number) < 1
  ) {
    throw new Error('lookup_hmac_rotation_response_invalid');
  }
  return {
    operationId: item.operationId,
    state: item.state as LookupHmacRotation['state'],
    source: metadata(item.source, 'lookup_hmac_rotation_response_invalid'),
    candidate: metadata(item.candidate, 'lookup_hmac_rotation_response_invalid'),
    fencingToken: item.fencingToken as number,
  };
}

function createAdminClient(context: EnvironmentContext) {
  let cachedToken: { value: string; expiresAt: number } | null = null;
  const token = async () => {
    if (cachedToken && cachedToken.expiresAt - Date.now() > 30_000) return cachedToken.value;
    const issued = await requestAdminMachineAccessToken({
      apiBaseUrl: context.apiBaseUrl,
      keysDir: context.keysDir,
      tenantId: context.config.tenant.name,
      scopes: ['admin:control_plane:read', 'admin:control_plane:rotate'],
    });
    cachedToken = {
      value: issued.accessToken,
      expiresAt: Date.now() + Math.max(issued.expiresIn, 60) * 1000,
    };
    return cachedToken.value;
  };
  const request = async <T>(path: string, init: globalThis.RequestInit = {}): Promise<T> => {
    const response = await fetchWithTimeout(`${context.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await token()}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Tenant-Id': context.config.tenant.name,
        ...init.headers,
      },
    });
    const body: Record<string, unknown> = await readResponseJsonWithLimit<Record<string, unknown>>(
      response
    ).catch(() => ({}));
    if (!response.ok) {
      const code = typeof body.error === 'string' ? body.error : 'unknown';
      throw new Error(`lookup_hmac_admin_api_failed:${response.status}:${code}`);
    }
    return body as T;
  };
  return {
    start: async (pending: PendingLookupHmacRotation) => {
      const response = await request<{ rotation: unknown }>(
        '/api/admin/platform/control-plane/lookup-hmac/rotations',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': pending.idempotencyKey },
          body: JSON.stringify({ candidate: pending.candidate }),
        }
      );
      return parseLookupHmacRotation(response.rotation);
    },
    get: async (operationId: string) => {
      const response = await request<{ rotation: unknown }>(
        `/api/admin/platform/control-plane/lookup-hmac/rotations/${encodeURIComponent(operationId)}`
      );
      return parseLookupHmacRotation(response.rotation);
    },
    status: async (operationId: string, phase: 'distribution' | 'generation') => {
      const response = await request<{ status: Record<string, unknown> }>(
        `/api/admin/platform/control-plane/lookup-hmac/rotations/${encodeURIComponent(operationId)}/verifications/${phase}`
      );
      return parseLookupHmacVerificationStatus(response.status, phase);
    },
    mutate: async (rotation: LookupHmacRotation, action: 'activate' | 'observe-generation') => {
      const response = await request<{ rotation: unknown }>(
        `/api/admin/platform/control-plane/lookup-hmac/rotations/${encodeURIComponent(rotation.operationId)}/${action}`,
        {
          method: 'POST',
          headers: {
            'Idempotency-Key': `setup:${rotation.operationId}:${action}`,
          },
          body: JSON.stringify({ fencingToken: rotation.fencingToken }),
        }
      );
      return parseLookupHmacRotation(response.rotation);
    },
  };
}

export function parseLookupHmacVerificationStatus(
  value: unknown,
  expectedPhase: 'distribution' | 'generation'
): {
  expected: number;
  succeeded: number;
  failed: number;
  complete: boolean;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('lookup_hmac_verification_status_invalid');
  }
  const status = value as Record<string, unknown>;
  const keys = Object.keys(status);
  if (
    keys.length !== VERIFICATION_STATUS_KEYS.size ||
    keys.some((key) => !VERIFICATION_STATUS_KEYS.has(key)) ||
    status.phase !== expectedPhase ||
    !Number.isSafeInteger(status.expected) ||
    status.expected !== LOOKUP_HMAC_TARGET_COUNT ||
    !Number.isSafeInteger(status.succeeded) ||
    (status.succeeded as number) < 0 ||
    !Number.isSafeInteger(status.failed) ||
    (status.failed as number) < 0 ||
    (status.succeeded as number) + (status.failed as number) > LOOKUP_HMAC_TARGET_COUNT ||
    !Array.isArray(status.pending) ||
    status.pending.length !==
      LOOKUP_HMAC_TARGET_COUNT - (status.succeeded as number) - (status.failed as number) ||
    status.pending.some((worker) => typeof worker !== 'string' || !SAFE_ID.test(worker)) ||
    new Set(status.pending).size !== status.pending.length ||
    typeof status.complete !== 'boolean' ||
    (status.complete === true &&
      ((status.succeeded as number) !== LOOKUP_HMAC_TARGET_COUNT ||
        (status.failed as number) !== 0))
  ) {
    throw new Error('lookup_hmac_verification_status_invalid');
  }
  return {
    expected: status.expected as number,
    succeeded: status.succeeded as number,
    failed: status.failed as number,
    complete: status.complete,
  };
}

async function waitForVerification(
  client: ReturnType<typeof createAdminClient>,
  operationId: string,
  phase: 'distribution' | 'generation'
): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (true) {
    const status = await client.status(operationId, phase);
    console.log(
      chalk.gray(
        `  ${phase}: ${status.succeeded}/${status.expected}` +
          (status.failed > 0 ? `, retrying ${status.failed} failed target(s)` : '')
      )
    );
    if (status.complete) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `lookup_hmac_verification_timeout:${phase}:${status.succeeded}/${status.expected}`
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
}

async function deployRotationState(
  context: EnvironmentContext,
  options: LookupHmacRotateOptions
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
    components: lookupHmacRotationTargetComponents(),
    throwOnFailure: true,
  });
}

export async function rotateLookupHmacKeyCommand(options: LookupHmacRotateOptions): Promise<void> {
  const context = await loadEnvironment(options);
  console.log(chalk.bold('\nAuthrim Lookup HMAC key rotation\n'));
  console.log(`Environment: ${chalk.cyan(context.env)}`);
  console.log(`Verification targets: ${chalk.cyan(LOOKUP_HMAC_TARGET_COUNT)}`);
  if (options.dryRun) {
    console.log(
      chalk.yellow('Dry run only. No key, Control state, secret, or Worker was changed.')
    );
    return;
  }
  if (!options.yes) {
    const accepted = await confirm({
      message: 'Rotate the Lookup blind-index HMAC key and start the resumable reindex?',
      default: false,
    });
    if (!accepted) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  await runWithEphemeralSetupMachineAccess(
    { env: context.env, config: context.config, keysDir: context.keysDir },
    async () => {
      const client = createAdminClient(context);
      let pending: PendingLookupHmacRotation;
      let rotation: LookupHmacRotation;
      const prepareLock = await acquireEnvironmentOperationLock(
        context.lockPath,
        'rotate-lookup-hmac:prepare'
      );
      try {
        const loaded = await loadLockFileAuto(context.environmentBaseDir, context.env);
        if (!loaded.lock) throw new Error(`environment_lock_not_found:${context.env}`);
        const refreshed = await refreshKeyState(context, loaded.lock);
        const existingPending = await loadPending(context);
        if (existingPending) {
          pending = existingPending;
          assertPendingLookupHmacState(pending, refreshed.keyState.lookupHmac);
        } else {
          const current = refreshed.keyState.lookupHmac;
          if (current.previousSlot || current.previousKeyId || current.previousFingerprint) {
            throw new Error('lookup_hmac_rotation_already_active');
          }
          const candidateSlot = current.activeSlot === 'A' ? 'B' : 'A';
          const secret = randomBytes(32).toString('base64url');
          const keyId = `lookup-hmac-${current.activeGeneration + 1}-${randomBytes(4).toString('hex')}`;
          pending = {
            schemaVersion: 1,
            environmentId: context.env,
            idempotencyKey: `lookup-hmac-${current.activeGeneration + 1}-${keyId}`,
            source: {
              generation: current.activeGeneration,
              keyId: current.activeKeyId,
              slot: current.activeSlot,
              fingerprint: current.activeFingerprint,
            },
            candidate: {
              generation: current.activeGeneration + 1,
              keyId,
              slot: candidateSlot,
              fingerprint: fingerprint(secret),
            },
            operationId: null,
          };
          await writeSensitive(pendingSecretPath(context.keysDir, pending.candidate), secret);
          await savePending(context, pending);
        }
        rotation = await client.start(pending);
        assertLookupHmacRotationMatchesPending(rotation, pending);
        if (pending.operationId !== rotation.operationId) {
          pending = { ...pending, operationId: rotation.operationId };
          await savePending(context, pending);
        }
        await promoteLookupHmacCandidateSecret(context.keysDir, pending);
      } finally {
        await prepareLock.release();
      }

      if (rotation.state === 'blocked') throw new Error('lookup_hmac_rotation_blocked');
      if (rotation.state === 'distributing') {
        console.log(chalk.cyan('Deploying the inactive candidate slot...'));
        await deployRotationState(context, options);
        console.log(chalk.cyan('Waiting for candidate HMAC verification on every target...'));
        await waitForVerification(client, rotation.operationId, 'distribution');
        const activationLock = await acquireEnvironmentOperationLock(
          context.lockPath,
          'rotate-lookup-hmac:activate'
        );
        try {
          rotation = await client.mutate(rotation, 'activate');
          const loaded = await loadLockFileAuto(context.environmentBaseDir, context.env);
          if (!loaded.lock) throw new Error(`environment_lock_not_found:${context.env}`);
          await refreshKeyState(context, loaded.lock);
        } finally {
          await activationLock.release();
        }
      }

      if (rotation.state === 'activation_dual_write') {
        console.log(
          chalk.cyan('Deploying the signed active generation with dual-write enabled...')
        );
        await deployRotationState(context, options);
        console.log(
          chalk.cyan('Waiting for every target to observe the signed active generation...')
        );
        await waitForVerification(client, rotation.operationId, 'generation');
        const observeLock = await acquireEnvironmentOperationLock(
          context.lockPath,
          'rotate-lookup-hmac:observe-generation'
        );
        try {
          rotation = await client.mutate(rotation, 'observe-generation');
          const loaded = await loadLockFileAuto(context.environmentBaseDir, context.env);
          if (!loaded.lock) throw new Error(`environment_lock_not_found:${context.env}`);
          await refreshKeyState(context, loaded.lock);
        } finally {
          await observeLock.release();
        }
      }

      if (!['dual_read', 'reindexing', 'verifying', 'grace', 'complete'].includes(rotation.state)) {
        rotation = await client.get(rotation.operationId);
      }
      if (!['dual_read', 'reindexing', 'verifying', 'grace', 'complete'].includes(rotation.state)) {
        throw new Error(`lookup_hmac_rotation_handoff_incomplete:${rotation.state}`);
      }
      await unlink(pendingMetadataPath(context.keysDir)).catch(() => undefined);
      console.log(
        chalk.green(
          `Lookup HMAC rotation handed off to the resumable reindex (${rotation.operationId}, ${rotation.state}).`
        )
      );
    }
  );
}
