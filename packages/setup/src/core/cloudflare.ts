/**
 * Cloudflare API Integration Module
 *
 * Provides programmatic access to Cloudflare resources via wrangler CLI.
 * Used for provisioning D1 databases, KV namespaces, and other resources.
 */

import { execa, type ExecaError } from 'execa';
import {
  AUTHRIM_MIGRATIONS_COLUMN_ALTERS,
  AUTHRIM_MIGRATIONS_TABLE_SQL,
  AUTHRIM_MIGRATION_HISTORY_SQL,
  validateAuthrimMigrationHistoryRows,
  type AuthrimMigrationHistoryRow,
} from '@authrim/ar-lib-core/control-plane';
import { createHash, randomUUID } from 'node:crypto';
import { resolve4, resolve6, resolveCname } from 'node:dns/promises';
import { basename, join as pathJoin } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import {
  getD1DatabaseName,
  getKVNamespaceName,
  getQueueName,
  D1_DATABASES,
  KV_NAMESPACES,
} from './naming.js';
import type { AuthrimConfig, D1Location, D1Jurisdiction } from './config.js';
import type { DnsOwnershipEntry, DnsOwnershipRole, DnsRecordRestoreSnapshot } from './lock.js';
import type {
  ProvisioningResourceCheckpoint,
  ProvisioningResourceIdentity,
  ProvisioningResourceState,
} from './provisioning-intent.js';
import { getPortableSqlExpressions, renderPortableMigrationSql } from './sql-portability.js';
import {
  discoverReleaseMigrationStream,
  loadTargetReleaseMigrationManifest,
  type ReleaseMigrationManifest,
} from './release-migrations.js';
import {
  buildAdminUiBffMachineAccessBootstrapSql,
  buildSetupMachineAccessCleanupSql,
  buildSetupMachineAccessBootstrapSql,
  deleteSetupMachineKeyFiles,
  ensureSetupMachineKeyFiles,
  loadAdminUiBffPublicJwk,
  loadSetupMachinePublicJwk,
} from './admin-machine-access.js';
import {
  withPrivateTemporaryBinaryFile,
  withPrivateTemporaryOutputFile,
  withPrivateTemporaryTextFile,
} from './private-temporary-file.js';
const D1_MIGRATION_EXECUTE_TIMEOUT_MS = 180_000;
const D1_MIGRATION_MAX_ATTEMPTS = 4;
const D1_MIGRATION_AUTH_MAX_ATTEMPTS = 8;
const QUEUE_PROVISIONING_DEFINITIONS = [
  { binding: 'AUDIT_QUEUE', nameSuffix: 'audit-queue' },
  { binding: 'LOGGING_DELIVERY_CRITICAL_QUEUE', nameSuffix: 'logging-delivery-critical-queue' },
  { binding: 'LOGGING_DELIVERY_QUEUE', nameSuffix: 'logging-delivery-queue' },
  { binding: 'LOGGING_DELIVERY_BULK_QUEUE', nameSuffix: 'logging-delivery-bulk-queue' },
] as const;

export function getRequiredQueues(env: string): Array<{ binding: string; name: string }> {
  validateEnvName(env);
  return QUEUE_PROVISIONING_DEFINITIONS.map((definition) => ({
    binding: definition.binding,
    name: getQueueName(env, definition.nameSuffix),
  }));
}
const QUEUE_CONSUMER_DETACH_PROPAGATION_DELAY_MS = 15_000;
const WORKER_DELETE_PROPAGATION_DELAY_MS = 20_000;
const WORKER_DELETE_MAX_ATTEMPTS = 3;
const WORKER_DELETE_RETRY_DELAY_MS = 1_000;
const WORKER_INVENTORY_MAX_ATTEMPTS = 3;
const WORKER_INVENTORY_REQUEST_TIMEOUT_MS = 10_000;
const WORKER_INVENTORY_RETRY_DELAY_MS = 1_000;
const ENVIRONMENT_DELETE_VERIFY_MAX_ATTEMPTS = 5;
const ENVIRONMENT_DELETE_VERIFY_RETRY_DELAY_MS = 2_000;
// Cloudflare's REST API is rate limited. Keep deletion concurrent, while letting the request
// retry/backoff logic absorb transient 429/971 responses instead of adding a fixed delay per object.
const R2_OBJECT_DELETE_CONCURRENCY = 5;
const R2_BUCKET_LIST_PER_PAGE = 1_000;
// Cloudflare currently permits up to 1,000,000 buckets per account. Keep the traversal bounded at
// that documented ceiling so a malformed stream of unique cursors cannot make Setup loop forever.
const R2_BUCKET_LIST_MAX_PAGES = 1_000;
const R2_OBJECT_LIST_MAX_PAGES = process.env.NODE_ENV === 'test' ? 4 : 1_000;
const R2_OBJECT_LIST_MAX_KEYS = process.env.NODE_ENV === 'test' ? 2_500 : 1_000_000;
const R2_OBJECT_LIST_MAX_CURSOR_LENGTH = 4_096;
export const R2_MANUAL_CLEANUP_THRESHOLD = 2_000;
const CLOUDFLARE_API_REQUEST_TIMEOUT_MS = process.env.NODE_ENV === 'test' ? 50 : 30_000;
const CLOUDFLARE_API_READ_MAX_ATTEMPTS = 4;
const CLOUDFLARE_API_MAX_RETRY_DELAY_MS = 30_000;
const CLOUDFLARE_INVENTORY_MAX_PAGES = 1_000;
const CLOUDFLARE_INVENTORY_MAX_RESOURCES = 100_000;

type CloudflareApiRetryMode = 'read' | 'idempotent_mutation' | 'non_idempotent_mutation';

interface CloudflareApiJsonRequestOptions<T> {
  label: string;
  retryMode: CloudflareApiRetryMode;
  timeoutMs?: number;
  maxAttempts?: number;
  isRetryableResponse?: (response: Response, data: T) => boolean;
}

interface CloudflareApiJsonResult<T> {
  response: Response;
  data: T;
}

class CloudflareApiRequestInterruptedError extends Error {
  constructor(
    readonly reason: 'timeout' | 'caller_abort',
    label: string
  ) {
    super(
      reason === 'timeout'
        ? `${label} request exceeded its deadline`
        : `${label} request was cancelled`
    );
    this.name = 'CloudflareApiRequestInterruptedError';
  }
}

/**
 * Parse Cloudflare's Retry-After response header without allowing a provider response to keep the
 * setup operation lock indefinitely. Both delta-seconds and HTTP-date forms are supported.
 */
export function parseCloudflareRetryAfterMs(
  value: string | null | undefined,
  nowMs = Date.now()
): number | null {
  const normalized = value?.trim();
  if (!normalized) return null;

  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1_000), CLOUDFLARE_API_MAX_RETRY_DELAY_MS);
  }

  const retryAt = Date.parse(normalized);
  if (!Number.isFinite(retryAt)) return null;
  return Math.min(Math.max(0, retryAt - nowMs), CLOUDFLARE_API_MAX_RETRY_DELAY_MS);
}

function getCloudflareRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = parseCloudflareRetryAfterMs(response.headers?.get?.('retry-after'));
  return retryAfter ?? Math.min(500 * 2 ** (attempt - 1), CLOUDFLARE_API_MAX_RETRY_DELAY_MS);
}

async function requestCloudflareApiJsonOnce<T>(
  input: string | URL,
  init: globalThis.RequestInit,
  options: Pick<CloudflareApiJsonRequestOptions<T>, 'label' | 'timeoutMs'>
): Promise<CloudflareApiJsonResult<T>> {
  const timeoutMs = options.timeoutMs ?? CLOUDFLARE_API_REQUEST_TIMEOUT_MS;
  const requestController = new AbortController();
  const callerSignal = init.signal;
  let deadlineReached = false;

  const abortFromCaller = () => requestController.abort();
  if (callerSignal?.aborted) {
    throw new CloudflareApiRequestInterruptedError('caller_abort', options.label);
  }
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

  let rejectOnAbort: ((error: CloudflareApiRequestInterruptedError) => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const rejectForAbort = () => {
    rejectOnAbort?.(
      new CloudflareApiRequestInterruptedError(
        deadlineReached ? 'timeout' : 'caller_abort',
        options.label
      )
    );
  };
  requestController.signal.addEventListener('abort', rejectForAbort, { once: true });

  const timeoutId = setTimeout(() => {
    deadlineReached = true;
    requestController.abort();
  }, timeoutMs);

  const request = (async (): Promise<CloudflareApiJsonResult<T>> => {
    const response = await fetch(input, {
      ...init,
      signal: requestController.signal,
    });
    const jsonReader = (response as Response & { json?: () => Promise<unknown> }).json;
    const data =
      typeof jsonReader === 'function'
        ? ((await jsonReader.call(response).catch(() => ({}))) as T)
        : ({} as T);
    return { response, data };
  })();

  try {
    return await Promise.race([request, interrupted]);
  } finally {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener('abort', abortFromCaller);
    requestController.signal.removeEventListener('abort', rejectForAbort);
  }
}

async function requestCloudflareApiJson<T>(
  input: string | URL,
  init: globalThis.RequestInit,
  options: CloudflareApiJsonRequestOptions<T>
): Promise<CloudflareApiJsonResult<T>> {
  const canRetry = options.retryMode !== 'non_idempotent_mutation';
  const maxAttempts = canRetry
    ? Math.max(1, options.maxAttempts ?? CLOUDFLARE_API_READ_MAX_ATTEMPTS)
    : 1;
  let lastFailureReason = 'network failure';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await requestCloudflareApiJsonOnce<T>(input, init, options);
      const retryableResponse =
        isRetryableCloudflareHttpStatus(result.response.status) ||
        options.isRetryableResponse?.(result.response, result.data) === true;
      if (!retryableResponse || !canRetry || attempt >= maxAttempts) return result;

      lastFailureReason = `HTTP ${result.response.status}`;
      const delayMs = getCloudflareRetryDelayMs(result.response, attempt);
      if (delayMs > 0 && process.env.NODE_ENV !== 'test') await sleep(delayMs);
    } catch (error) {
      if (
        error instanceof CloudflareApiRequestInterruptedError &&
        error.reason === 'caller_abort'
      ) {
        throw error;
      }
      if (!canRetry) throw error;
      lastFailureReason =
        error instanceof CloudflareApiRequestInterruptedError && error.reason === 'timeout'
          ? 'request timeout'
          : 'network failure';
      if (attempt >= maxAttempts) {
        throw new Error(
          `${options.label} failed after ${maxAttempts} attempts (${lastFailureReason})`
        );
      }
      if (process.env.NODE_ENV !== 'test') {
        await sleep(Math.min(500 * 2 ** (attempt - 1), CLOUDFLARE_API_MAX_RETRY_DELAY_MS));
      }
    }
  }

  throw new Error(`${options.label} retry loop exited unexpectedly (${lastFailureReason})`);
}

// =============================================================================
// Types
// =============================================================================

export interface CloudflareAuth {
  isLoggedIn: boolean;
  accountId?: string;
  email?: string;
}

export interface D1DatabaseInfo {
  binding: string;
  name: string;
  id: string;
}

export interface KVNamespaceInfo {
  binding: string;
  name: string;
  id: string;
  previewId?: string;
}

export interface QueueInfo {
  binding: string;
  name: string;
  id: string;
}

export interface R2BucketInfo {
  binding: string;
  name: string;
  creationDate?: string;
  ownershipMarkerKey?: string;
  ownershipId?: string;
}

export type R2BucketProvisioningState = 'configured' | 'recorded_but_missing' | 'missing';

export interface R2BucketProvisioningStatus extends R2BucketInfo {
  recorded: boolean;
  exists: boolean;
  configured: boolean;
  state: R2BucketProvisioningState;
}

export type D1MigrationDatabaseRole = 'core' | 'pii' | 'admin';
export type D1MigrationFileStatus = 'applied' | 'pending' | 'changed' | 'orphaned';

export interface D1MigrationFileState {
  filename: string;
  status: D1MigrationFileStatus;
  checksum?: string;
  appliedChecksum?: string | null;
  appliedAt?: number | null;
  executionTimeMs?: number | null;
}

export interface D1MigrationDatabaseStatus {
  role: D1MigrationDatabaseRole;
  dbName: string;
  success: boolean;
  error?: string;
  counts: {
    total: number;
    applied: number;
    pending: number;
    changed: number;
    orphaned: number;
  };
  migrations: D1MigrationFileState[];
}

export interface D1MigrationEnvironmentStatus {
  env: string;
  success: boolean;
  databases: D1MigrationDatabaseStatus[];
}

export interface EnvironmentReleaseMigrationOptions {
  productVersion: string;
  allowDraft?: boolean;
  backfillLegacyChecksums?: boolean;
  /** Immutable provider IDs from the environment lock. Existing-environment callers must set all roles. */
  databaseIdentifiers?: Partial<Record<D1MigrationDatabaseRole, string>>;
  /** Do not borrow migrations from the process cwd when operating on a resolved source checkout. */
  strictMigrationsRoot?: boolean;
}

function resolveEnvironmentMigrationDatabaseIdentifier(input: {
  env: string;
  role: D1MigrationDatabaseRole;
  release?: EnvironmentReleaseMigrationOptions;
}): string {
  const pinnedIdentifiers = input.release?.databaseIdentifiers;
  if (pinnedIdentifiers) {
    const identifier = pinnedIdentifiers[input.role]?.trim();
    if (!identifier) {
      throw new Error(`fixed_migration_database_id_required:${input.role}`);
    }
    return identifier;
  }
  return getD1DatabaseName(input.env, `${input.role}-db`);
}

export interface ProvisionedResources {
  d1: D1DatabaseInfo[];
  kv: KVNamespaceInfo[];
  queues: QueueInfo[];
  r2: R2BucketInfo[];
}

/** Options for creating a D1 database with location/jurisdiction */
export interface D1CreateOptions {
  /** D1 location hint - geographic preference */
  location?: D1Location;
  /** D1 jurisdiction - overrides location if set */
  jurisdiction?: D1Jurisdiction;
}

/** Database configuration for provisioning */
export interface DatabaseProvisionConfig {
  core?: D1CreateOptions;
  /** PII database config - also used for admin-db (both contain sensitive data) */
  pii?: D1CreateOptions;
}

export interface ProvisionOptions {
  env: string;
  createD1?: boolean;
  createKV?: boolean;
  createQueues?: boolean;
  createR2?: boolean;
  onProgress?: (message: string) => void;
  onResourceProvisioned: (resource: ProvisioningResourceCheckpoint) => Promise<void>;
  /** Persist the immutable provider identity before visibility polling or later setup work. */
  onResourceIdentified: (resource: ProvisioningResourceCheckpoint) => Promise<void>;
  /**
   * Per-resource write-ahead checkpoints from the exact durable provisioning intent. An empty
   * record is a fresh attempt and authorizes adoption of no pre-existing provider resources.
   */
  provisioningIntentResources: Readonly<Record<string, ProvisioningResourceCheckpoint>>;
  /** Persisted immediately after strict absence verification and before the provider mutation. */
  onResourceCreateIssued: (resource: ProvisioningResourceIdentity) => Promise<void>;
  /** Persist a definite non-commit so a later retry cannot adopt a raced deterministic name. */
  onResourceCreateRejected: (resource: ProvisioningResourceIdentity) => Promise<void>;
  /** Database location configuration */
  databaseConfig?: DatabaseProvisionConfig;
}

interface ProvisioningCreateBehavior {
  allowExisting?: boolean;
  recordedState?: ProvisioningResourceState;
  expectedExistingId?: string;
  expectedCreationDate?: string;
  ownershipMarkerKey?: string;
  ownershipId?: string;
  onCreateIssued?: () => Promise<void>;
  onCreateRejected?: () => Promise<void>;
  onProviderIdentityIdentified?: (
    identity: Pick<
      ProvisioningResourceCheckpoint,
      'id' | 'creationDate' | 'ownershipMarkerKey' | 'ownershipId'
    >
  ) => Promise<void>;
}

export interface ProvisioningResourceAdoptionPolicy {
  allowExisting: boolean;
  recordedState?: ProvisioningResourceState;
  expectedExistingId?: string;
  expectedCreationDate?: string;
  ownershipMarkerKey?: string;
  ownershipId?: string;
}

export function getProvisioningResourceAdoptionPolicy(
  resources: Readonly<Record<string, ProvisioningResourceCheckpoint>>,
  resource: ProvisioningResourceIdentity
): ProvisioningResourceAdoptionPolicy {
  const checkpointKey = `${resource.kind}:${resource.binding}`;
  const checkpoint = resources[checkpointKey];
  if (
    checkpoint &&
    (checkpoint.kind !== resource.kind ||
      checkpoint.binding !== resource.binding ||
      checkpoint.name !== resource.name)
  ) {
    throw new Error(`provisioning_resource_identity_changed:${checkpointKey}`);
  }
  if (
    checkpoint &&
    checkpoint.kind !== 'r2' &&
    (checkpoint.state === 'identified' || checkpoint.state === 'created') &&
    !checkpoint.id
  ) {
    throw new Error(`provisioning_resource_identity_missing:${checkpointKey}`);
  }
  if (
    checkpoint?.kind === 'r2' &&
    (checkpoint.state === 'identified' || checkpoint.state === 'created') &&
    (!checkpoint.creationDate || !checkpoint.ownershipMarkerKey || !checkpoint.ownershipId)
  ) {
    throw new Error(`provisioning_resource_identity_missing:${checkpointKey}`);
  }
  return {
    // `create_issued` proves only intent to call Cloudflare. `identified` is the earliest state
    // carrying immutable provider evidence and is therefore safe for exact reconciliation.
    allowExisting: checkpoint?.state === 'identified' || checkpoint?.state === 'created',
    recordedState: checkpoint?.state,
    expectedExistingId: checkpoint?.id,
    expectedCreationDate: checkpoint?.creationDate,
    ownershipMarkerKey: checkpoint?.ownershipMarkerKey,
    ownershipId: checkpoint?.ownershipId,
  };
}

function getProvisioningCreateBehavior(
  options: Pick<
    ProvisionOptions,
    | 'provisioningIntentResources'
    | 'onResourceCreateIssued'
    | 'onResourceCreateRejected'
    | 'onResourceIdentified'
  >,
  resource: ProvisioningResourceIdentity
): ProvisioningCreateBehavior {
  const policy = getProvisioningResourceAdoptionPolicy(
    options.provisioningIntentResources,
    resource
  );
  return {
    ...policy,
    onCreateIssued: () => options.onResourceCreateIssued(resource),
    onCreateRejected: () => options.onResourceCreateRejected(resource),
    onProviderIdentityIdentified: (providerIdentity) =>
      options.onResourceIdentified({
        ...resource,
        ...providerIdentity,
        state: 'identified',
      }),
  };
}

async function throwDefiniteProvisioningCreateFailure(
  behavior: ProvisioningCreateBehavior,
  providerError: unknown,
  resourceDescription: string
): Promise<never> {
  try {
    await behavior.onCreateRejected?.();
  } catch (checkpointError) {
    throw new AggregateError(
      [providerError, checkpointError],
      `${resourceDescription} creation failed and its rejection checkpoint could not be persisted`
    );
  }
  throw providerError;
}

export const R2_BUCKETS = [
  { binding: 'MIGRATION_RELEASES', suffix: 'migration-releases', baseline: true },
  { binding: 'PLUGIN_BUNDLES', suffix: 'plugin-bundles', baseline: false },
  { binding: 'PUBLIC_ASSETS', suffix: 'public-assets', baseline: false },
  { binding: 'DIAGNOSTIC_LOGS', suffix: 'diagnostic-logs', baseline: false },
  { binding: 'AUDIT_ARCHIVE', suffix: 'audit-archive', baseline: false },
  { binding: 'IMPORT_ARTIFACTS', suffix: 'import-artifacts', baseline: false },
  { binding: 'EXPORT_ARTIFACTS', suffix: 'export-artifacts', baseline: false },
  { binding: 'SENSITIVE_DETAILS', suffix: 'sensitive-details', baseline: false },
] as const;

export type R2BucketBinding = (typeof R2_BUCKETS)[number]['binding'];

export function getR2BucketName(env: string, binding: R2BucketBinding): string {
  const bucket = R2_BUCKETS.find((candidate) => candidate.binding === binding);
  if (!bucket) {
    throw new Error(`Unknown R2 bucket binding: ${binding}`);
  }
  return `${env}-${bucket.suffix}`;
}

export function getRequiredR2Buckets(
  env: string,
  options: { includeFeatureBuckets?: boolean } = {}
): R2BucketInfo[] {
  const includeFeatureBuckets = options.includeFeatureBuckets ?? true;
  return R2_BUCKETS.filter((bucket) => bucket.baseline || includeFeatureBuckets).map((bucket) => ({
    binding: bucket.binding,
    name: `${env}-${bucket.suffix}`,
  }));
}

export function buildR2BucketProvisioningStatus(
  env: string,
  recordedBuckets: Record<string, { name: string }> | null | undefined,
  cloudflareBucketNames: Iterable<string>
): {
  env: string;
  enabled: boolean;
  required: number;
  configured: number;
  missing: R2BucketProvisioningStatus[];
  buckets: R2BucketProvisioningStatus[];
} {
  const existingNames = new Set(cloudflareBucketNames);
  const buckets = getRequiredR2Buckets(env).map((bucket) => {
    const recordedName = recordedBuckets?.[bucket.binding]?.name;
    const name = recordedName ?? bucket.name;
    const recorded = Boolean(recordedName);
    const exists = existingNames.has(name);
    const configured = recorded && exists;
    const state: R2BucketProvisioningState = recorded
      ? exists
        ? 'configured'
        : 'recorded_but_missing'
      : 'missing';

    return {
      ...bucket,
      name,
      recorded,
      exists,
      configured,
      state,
    };
  });

  return {
    env,
    enabled: buckets.every((bucket) => bucket.configured),
    required: buckets.length,
    configured: buckets.filter((bucket) => bucket.configured).length,
    missing: buckets.filter((bucket) => !bucket.configured),
    buckets,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientD1MigrationError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    isD1AuthenticationError(message) ||
    isD1RateLimitError(message) ||
    normalized.includes('file could not be uploaded') ||
    normalized.includes('internalerror') ||
    normalized.includes('please retry') ||
    normalized.includes('we encountered an internal error') ||
    normalized.includes('internal server error') ||
    normalized.includes('bad gateway') ||
    normalized.includes('service unavailable') ||
    normalized.includes('gateway timeout') ||
    normalized.includes('fetch failed') ||
    normalized.includes('econnreset') ||
    normalized.includes('etimedout') ||
    normalized.includes('timed out')
  );
}

function isAmbiguousCloudflareMutationFailure(message: string): boolean {
  // Authentication code 10000 and explicit rate-limit responses reject the request before the
  // provider mutation. Create callers retry these boundedly inside the same create_issued
  // operation; exhaustion remains a definite rejection so the intent can be retried later.
  if (isD1AuthenticationError(message) || isD1RateLimitError(message)) return false;
  const normalized = message.toLowerCase();
  const explicitNameCollision =
    normalized.includes('already exists') ||
    normalized.includes('already in use') ||
    /\bname\s+conflict\b/u.test(normalized);
  const labelledStatusCodes = [
    ...normalized.matchAll(
      /\b(?:http(?: status)?|status(?: code)?|error(?: code)?|code)\s*[:=]?\s*(\d{3,5})\b/gu
    ),
  ].map((match) => Number(match[1]));
  const explicitHttpStatus = labelledStatusCodes.find((code) => code >= 400 && code <= 599);

  // A provider can use 409 for transient state conflicts as well as deterministic name
  // collisions. Treat it as a definite non-commit only when the response explicitly identifies
  // a same-name collision, independent of the status/message ordering.
  if (explicitNameCollision) return false;

  if (explicitHttpStatus !== undefined) {
    if (explicitHttpStatus === 409) return true;
    return (
      explicitHttpStatus === 408 ||
      explicitHttpStatus === 425 ||
      explicitHttpStatus === 429 ||
      explicitHttpStatus >= 500
    );
  }

  if (
    /\b5\d{2}\s+(?:internal server error|bad gateway|service unavailable|gateway timeout)\b/u.test(
      normalized
    )
  ) {
    return true;
  }

  // Only an explicit local/provider validation or authorization rejection is known not to have
  // committed. Process errors without a parsed non-retryable 4xx are ambiguous by default: undici,
  // Node, proxies, and Wrangler use many different strings for a response lost after commit.
  const deterministicClientFailure =
    normalized.includes('permission denied') ||
    /\bmissing\b.{0,40}\bpermission\b/u.test(normalized) ||
    normalized.includes('not authorized') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden') ||
    normalized.includes('invalid argument') ||
    normalized.includes('invalid name') ||
    normalized.includes('validation error') ||
    normalized.includes('configuration error');

  return !deterministicClientFailure;
}

interface ProviderResourceIdentity {
  id: string;
  name: string;
}

class ProviderResourceIdentityMismatchError extends Error {}

function provisioningVisibilityMaxAttempts(): number {
  return process.env.NODE_ENV === 'test' ? 3 : 6;
}

function provisioningVisibilityRetryDelayMs(attempt: number): number {
  if (process.env.NODE_ENV === 'test') return 0;
  return Math.min(500 * 2 ** (attempt - 1), 4_000);
}

async function waitForProviderResourceVisible<T extends ProviderResourceIdentity>(input: {
  resourceDescription: string;
  expectedId?: string;
  createError?: unknown;
  findExisting: () => Promise<T | null>;
}): Promise<T> {
  const maxAttempts = provisioningVisibilityMaxAttempts();
  let lastInventoryError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const existing = await input.findExisting();
      if (existing) {
        if (input.expectedId && existing.id !== input.expectedId) {
          throw new ProviderResourceIdentityMismatchError(
            `${input.resourceDescription} does not match the provider create response`
          );
        }
        return existing;
      }
    } catch (error) {
      if (error instanceof ProviderResourceIdentityMismatchError) throw error;
      lastInventoryError = error;
    }

    if (attempt < maxAttempts) {
      const delayMs = provisioningVisibilityRetryDelayMs(attempt);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  const visibilityError = new Error(
    `${input.resourceDescription} was not visible after creation (${maxAttempts} readback attempts)`
  );
  const causes = [input.createError, lastInventoryError, visibilityError].filter(
    (cause): cause is NonNullable<typeof cause> => cause !== undefined
  );
  if (causes.length > 1) {
    const createErrorDetail =
      input.createError instanceof Error ? `: ${input.createError.message}` : '';
    throw new AggregateError(
      causes,
      `${input.resourceDescription} creation outcome could not be verified${createErrorDetail}`
    );
  }
  throw visibilityError;
}

function isD1AuthenticationError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('authentication error') && normalized.includes('code: 10000');
}

interface WranglerOAuthRefreshState {
  attempted: boolean;
}

function hasAuthoritativeWranglerApiToken(): boolean {
  // Wrangler reads CLOUDFLARE_API_TOKEN. Authrim's resource-specific token variables are secrets
  // installed into Control Workers; Wrangler does not use them as its own operator credential.
  // Treating one of those unrelated variables as authoritative here would prevent a stale OAuth
  // session from being refreshed even though that session is what Wrangler actually used.
  return Boolean(process.env.CLOUDFLARE_API_TOKEN?.trim());
}

async function refreshWranglerOAuthAfterCode10000(
  message: string,
  state: WranglerOAuthRefreshState
): Promise<boolean> {
  if (!isD1AuthenticationError(message)) {
    return false;
  }
  return refreshWranglerOAuthSession(message, state);
}

function pinnedWranglerOAuthAccountId(message: string): string {
  const configuredAccountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim().toLowerCase();
  const messageAccountIds = Array.from(
    new Set(
      [...message.matchAll(/\/accounts\/([a-f0-9]{32})(?:\/|\?|\b)/giu)].map((match) =>
        match[1].toLowerCase()
      )
    )
  );
  if (messageAccountIds.length > 1) {
    throw new Error('cloudflare_oauth_account_id_ambiguous_before_refresh');
  }
  const messageAccountId = messageAccountIds[0];
  if (configuredAccountId && messageAccountId && configuredAccountId !== messageAccountId) {
    throw new Error('cloudflare_oauth_account_id_mismatch_before_refresh');
  }
  const pinnedAccountId = configuredAccountId || messageAccountId;
  if (!pinnedAccountId || !/^[a-f0-9]{32}$/u.test(pinnedAccountId)) {
    throw new Error('cloudflare_oauth_account_id_required_before_refresh');
  }
  return pinnedAccountId;
}

async function refreshWranglerOAuthSession(
  message: string,
  state: WranglerOAuthRefreshState
): Promise<boolean> {
  if (state.attempted || hasAuthoritativeWranglerApiToken()) return false;
  const pinnedAccountId = pinnedWranglerOAuthAccountId(message);
  state.attempted = true;
  const { stdout, stderr } = await wrangler(['whoami'], { timeout: 30_000 });
  assertCloudflareOAuthRefreshAccount(pinnedAccountId, `${stdout}\n${stderr}`);
  return true;
}

async function wranglerCreateWithDefiniteRejectionRetry(
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  let lastError: unknown;
  const oauthRefresh: WranglerOAuthRefreshState = { attempted: false };
  for (let attempt = 1; attempt <= D1_MIGRATION_AUTH_MAX_ATTEMPTS; attempt++) {
    try {
      return await wrangler(args);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        (!isD1AuthenticationError(message) && !isD1RateLimitError(message)) ||
        attempt >= D1_MIGRATION_AUTH_MAX_ATTEMPTS
      ) {
        throw error;
      }
      await refreshWranglerOAuthAfterCode10000(message, oauthRefresh);
      const delayMs = d1MigrationRetryDelayMs(attempt);
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw lastError;
}

function isD1RateLimitError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    /\b429\b/u.test(normalized) ||
    /\bcode:\s*971\b/u.test(normalized) ||
    normalized.includes('rate limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('throttl')
  );
}

function d1MigrationRetryDelayMs(attempt: number): number {
  if (process.env.NODE_ENV === 'test') {
    return 0;
  }
  return Math.min(2_000 * 2 ** (attempt - 1), 30_000);
}

function isExpectedMigrationTrackingColumnError(message: string): boolean {
  return /duplicate column name:\s*(checksum|execution_time_ms|setup_version|tool_version)\b/iu.test(
    message
  );
}

async function executeD1PreparationCommand(
  dbName: string,
  sql: string,
  onProgress?: (message: string) => void
): Promise<{ success: boolean; error?: string }> {
  const oauthRefresh: WranglerOAuthRefreshState = { attempted: false };
  for (let attempt = 1; attempt <= D1_MIGRATION_AUTH_MAX_ATTEMPTS; attempt++) {
    try {
      await wrangler(['d1', 'execute', dbName, '--remote', '--yes', '--command', sql]);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const maxAttempts = isD1AuthenticationError(message)
        ? D1_MIGRATION_AUTH_MAX_ATTEMPTS
        : D1_MIGRATION_MAX_ATTEMPTS;
      const canRetry = attempt < maxAttempts && isTransientD1MigrationError(message);
      if (!canRetry) {
        return { success: false, error: message };
      }

      await refreshWranglerOAuthAfterCode10000(message, oauthRefresh);

      const delayMs = d1MigrationRetryDelayMs(attempt);
      const failureKind = isD1AuthenticationError(message)
        ? 'Transient Cloudflare D1 authentication failure'
        : 'Transient Cloudflare D1 preparation failure';
      onProgress?.(
        `  ⚠️ ${failureKind} while preparing migration tracking for ${dbName} ` +
          `(attempt ${attempt}/${maxAttempts}); retrying in ${Math.round(delayMs / 1000)}s`
      );
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
  return { success: false, error: 'D1 migration preparation retry loop exited unexpectedly' };
}

// =============================================================================
// Wrangler Wrapper
// =============================================================================

/**
 * Execute a wrangler command
 */
async function wrangler(
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    // Use npx to ensure wrangler is found regardless of Volta/npm/pnpm environment
    // Default timeout: 30 seconds (wrangler API calls can be slow)
    const result = await execa('npx', ['wrangler', ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      reject: false,
      timeout: options.timeout ?? 30000,
    });

    if (result.exitCode !== 0) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join('\n');
      throw new Error(`Wrangler command failed (${result.exitCode}): ${detail || args.join(' ')}`);
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const execaError = error as ExecaError;
    // Handle timeout specifically
    if (execaError.timedOut) {
      throw new Error(`Wrangler command timed out: ${args.join(' ')}`);
    }
    throw new Error(`Wrangler command failed: ${execaError.message}`);
  }
}

/**
 * Check if wrangler is installed
 */
export async function isWranglerInstalled(): Promise<boolean> {
  try {
    // Use npx to check for wrangler availability
    await execa('npx', ['wrangler', '--version']);
    return true;
  } catch {
    return false;
  }
}

function extractWranglerAccountIds(output: string): string[] {
  return Array.from(
    new Set([...output.matchAll(/\b[a-f0-9]{32}\b/giu)].map((match) => match[0].toLowerCase()))
  );
}

/**
 * Check if user is authenticated with Cloudflare
 */
export async function checkAuth(): Promise<CloudflareAuth> {
  // An explicitly supplied API token is the operator-selected credential for this process.
  // Do not let an unrelated cached Wrangler OAuth session silently select a different account.
  if (process.env.CLOUDFLARE_API_TOKEN?.trim()) {
    const tokenAuth = await (async (): Promise<CloudflareAuth | null> => {
      const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
      if (
        !token ||
        !(await verifyCloudflareApiToken(
          token,
          process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined
        ))
      ) {
        return null;
      }
      return {
        isLoggedIn: true,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined,
        email: 'api-token',
      };
    })();
    return tokenAuth ?? { isLoggedIn: false };
  }

  const apiTokenAuth = async (): Promise<CloudflareAuth | null> => {
    const tokenInfo = await getCloudflareApiToken();
    if (!tokenInfo?.token) {
      return null;
    }

    if (
      !(await verifyCloudflareApiToken(
        tokenInfo.token,
        process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined
      ))
    ) {
      return null;
    }

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined;
    return {
      isLoggedIn: true,
      accountId,
      email: tokenInfo.source === 'env' ? 'api-token' : undefined,
    };
  };

  try {
    const { stdout, stderr } = await wrangler(['whoami']);
    const combinedOutput = (stdout + '\n' + stderr).toLowerCase();

    // Check for various "not logged in" patterns (case-insensitive)
    const notLoggedInPatterns = [
      'not logged in',
      'not authenticated',
      'error: not logged',
      '[error] not logged',
      'you are not logged',
      'login as: unknown',
      'unknown user',
    ];

    const isNotLoggedIn = notLoggedInPatterns.some((pattern) => combinedOutput.includes(pattern));

    // Also check for positive login indicators
    const hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(stdout);
    const hasLoggedInMessage = stdout.toLowerCase().includes('you are logged in');

    // Parse output to extract account info
    const emailMatch = stdout.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const envAccountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined;
    const accountIds = extractWranglerAccountIds(`${stdout}\n${stderr}`);
    const unambiguousWranglerAccountId = accountIds.length === 1 ? accountIds[0] : undefined;

    // Consider logged in if: no negative patterns AND (has email OR has logged in message)
    const isLoggedIn = !isNotLoggedIn && (hasEmail || hasLoggedInMessage);
    if (!isLoggedIn) {
      const tokenAuth = await apiTokenAuth();
      if (tokenAuth) {
        return tokenAuth;
      }
    }

    return {
      isLoggedIn,
      email: emailMatch?.[1],
      // An explicit account is the operator's selection. Without one, never silently choose the
      // first row from a Wrangler session that can access multiple Cloudflare accounts.
      accountId: envAccountId ?? unambiguousWranglerAccountId,
    };
  } catch {
    const tokenAuth = await apiTokenAuth();
    if (tokenAuth) {
      return tokenAuth;
    }
    return { isLoggedIn: false };
  }
}

async function verifyCloudflareApiToken(token: string, accountId?: string): Promise<boolean> {
  const verifyAt = async (url: string): Promise<boolean> => {
    const { response, data } = await requestCloudflareApiJson<{ success?: boolean }>(
      url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      { label: 'Cloudflare API token verification', retryMode: 'read' }
    );
    return response.ok && data.success !== false;
  };

  try {
    if (await verifyAt('https://api.cloudflare.com/client/v4/user/tokens/verify')) return true;
  } catch {
    // An account-owned token is expected to be rejected by the user-token verification route.
    // Continue only when the operator also pinned the exact account authority below.
  }
  if (!accountId || !/^[a-f0-9]{32}$/iu.test(accountId)) return false;
  try {
    return await verifyAt(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`
    );
  } catch {
    return false;
  }
}

/**
 * Get account ID from wrangler
 */
export async function getAccountId(): Promise<string | null> {
  const auth = await checkAuth();
  if (auth.accountId) return auth.accountId;

  // With an explicit API token, a cached OAuth account is not evidence for the token's account.
  // Require CLOUDFLARE_ACCOUNT_ID instead of crossing credential/account authorities.
  if (process.env.CLOUDFLARE_API_TOKEN?.trim()) return null;

  // Try to get from wrangler.toml or env
  try {
    const { stdout } = await wrangler(['whoami', '--verbose']);
    const accountIds = extractWranglerAccountIds(stdout);
    return accountIds.length === 1 ? accountIds[0] : null;
  } catch {
    return null;
  }
}

// =============================================================================
// Cloudflare API Token
// =============================================================================

export interface CloudflareApiToken {
  token: string;
  source: 'oauth' | 'env';
}

/**
 * Get the explicit Cloudflare API token or the Wrangler OAuth credential.
 * An operator-supplied environment token is authoritative and must not be shadowed by an
 * unrelated or expired local OAuth session.
 */
export async function getCloudflareApiToken(): Promise<CloudflareApiToken | null> {
  try {
    const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
    if (apiToken) {
      return { token: apiToken, source: 'env' };
    }

    const { readFile } = await import('node:fs/promises');
    const { homedir, platform } = await import('node:os');
    const { join } = await import('node:path');
    const { existsSync } = await import('node:fs');

    // Build list of possible config paths based on platform
    const home = homedir();
    const configPaths: string[] = [];

    if (platform() === 'darwin') {
      configPaths.push(join(home, 'Library/Preferences/.wrangler/config/default.toml'));
      configPaths.push(join(home, '.wrangler/config/default.toml'));
    } else if (platform() === 'win32') {
      const appData = process.env.APPDATA;
      if (appData) {
        configPaths.push(join(appData, 'xdg.config/.wrangler/config/default.toml'));
        configPaths.push(join(appData, '.wrangler/config/default.toml'));
      }
      configPaths.push(join(home, '.wrangler/config/default.toml'));
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        configPaths.push(join(localAppData, 'xdg.config/.wrangler/config/default.toml'));
        configPaths.push(join(localAppData, '.wrangler/config/default.toml'));
      }
    } else {
      const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
      configPaths.push(join(xdgConfigHome, '.wrangler/config/default.toml'));
      configPaths.push(join(home, '.wrangler/config/default.toml'));
    }

    for (const configPath of configPaths) {
      if (!existsSync(configPath)) continue;
      try {
        const configContent = await readFile(configPath, 'utf-8');
        const tokenMatch = configContent.match(/oauth_token\s*=\s*"([^"]+)"/);
        if (tokenMatch?.[1]) {
          return { token: tokenMatch[1], source: 'oauth' };
        }
      } catch {
        // Continue to next path
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get the workers.dev subdomain for the account
 * This is needed because workers.dev URLs are: {worker}.{subdomain}.workers.dev
 */
export async function getWorkersSubdomain(): Promise<string | null> {
  try {
    const accountId = await getAccountId();
    if (!accountId) return null;

    const tokenInfo = await getCloudflareApiToken();
    if (!tokenInfo) return null;

    const { response, data } = await requestCloudflareApiJson<{
      result?: { subdomain?: string };
      success?: boolean;
    }>(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      {
        headers: {
          Authorization: `Bearer ${tokenInfo.token}`,
        },
      },
      { label: 'Cloudflare Workers subdomain lookup', retryMode: 'read' }
    );

    if (!response.ok) return null;
    return data.result?.subdomain || null;
  } catch {
    return null;
  }
}

export interface SetupCapabilityDiagnostics {
  wranglerInstalled: boolean;
  loggedIn: boolean;
  tokenAvailable: boolean;
  workersSubdomainAvailable: boolean;
  zoneReadAvailable: boolean;
  accessibleZoneCount: number;
  dnsReadAvailable: boolean;
  uiWorkersApiAvailable: boolean;
}

export interface SetupCapabilityEstimate {
  workersDeploy: boolean;
  customDomain: boolean;
  multiTenant: boolean;
  nakedDomain: boolean;
  pages: boolean;
}

export type SetupCapabilityStatus = 'ok' | 'review' | 'ng';

export interface SetupCapabilityStatuses {
  workersDeploy: SetupCapabilityStatus;
  customDomain: SetupCapabilityStatus;
  multiTenant: SetupCapabilityStatus;
  nakedDomain: SetupCapabilityStatus;
  pages: SetupCapabilityStatus;
}

export function deriveSetupCapabilityEstimate(
  diagnostics: SetupCapabilityDiagnostics
): SetupCapabilityEstimate {
  const workersDeploy = diagnostics.wranglerInstalled && diagnostics.loggedIn;
  const customDomain =
    workersDeploy &&
    diagnostics.tokenAvailable &&
    diagnostics.zoneReadAvailable &&
    diagnostics.accessibleZoneCount > 0;
  const multiTenant = customDomain && diagnostics.dnsReadAvailable;
  const nakedDomain = multiTenant;
  const pages = workersDeploy && diagnostics.tokenAvailable && diagnostics.uiWorkersApiAvailable;

  return {
    workersDeploy,
    customDomain,
    multiTenant,
    nakedDomain,
    pages,
  };
}

export function deriveSetupCapabilityStatuses(
  diagnostics: SetupCapabilityDiagnostics
): SetupCapabilityStatuses {
  const workersDeploy: SetupCapabilityStatus =
    diagnostics.wranglerInstalled && diagnostics.loggedIn ? 'ok' : 'ng';

  let customDomain: SetupCapabilityStatus;
  if (workersDeploy === 'ng') {
    customDomain = 'ng';
  } else if (diagnostics.zoneReadAvailable && diagnostics.accessibleZoneCount > 0) {
    customDomain = 'ok';
  } else if (diagnostics.zoneReadAvailable && diagnostics.accessibleZoneCount === 0) {
    customDomain = 'ng';
  } else {
    customDomain = 'review';
  }

  let multiTenant: SetupCapabilityStatus;
  if (customDomain === 'ng') {
    multiTenant = 'ng';
  } else if (diagnostics.dnsReadAvailable) {
    multiTenant = 'ok';
  } else {
    multiTenant = 'review';
  }

  const nakedDomain: SetupCapabilityStatus =
    multiTenant === 'ok' ? 'ok' : multiTenant === 'review' ? 'review' : 'ng';

  let pages: SetupCapabilityStatus;
  if (workersDeploy === 'ng') {
    pages = 'ng';
  } else if (diagnostics.uiWorkersApiAvailable) {
    pages = 'ok';
  } else {
    pages = 'review';
  }

  return {
    workersDeploy,
    customDomain,
    multiTenant,
    nakedDomain,
    pages,
  };
}

export async function getSetupCapabilityDiagnostics(
  auth: CloudflareAuth,
  wranglerInstalled: boolean,
  workersSubdomain?: string | null
): Promise<SetupCapabilityDiagnostics> {
  const baseDiagnostics: SetupCapabilityDiagnostics = {
    wranglerInstalled,
    loggedIn: auth.isLoggedIn,
    tokenAvailable: false,
    workersSubdomainAvailable: !!workersSubdomain,
    zoneReadAvailable: false,
    accessibleZoneCount: 0,
    dnsReadAvailable: false,
    uiWorkersApiAvailable: false,
  };

  if (!wranglerInstalled || !auth.isLoggedIn) {
    return baseDiagnostics;
  }

  const tokenInfo = await getCloudflareApiToken();
  if (!tokenInfo?.token) {
    return baseDiagnostics;
  }

  baseDiagnostics.tokenAvailable = true;

  try {
    const { response: zoneResponse, data: zoneData } = await requestCloudflareApiJson<{
      success?: boolean;
      result?: Array<{ id?: string }>;
    }>(
      'https://api.cloudflare.com/client/v4/zones?per_page=1',
      {
        headers: {
          Authorization: `Bearer ${tokenInfo.token}`,
        },
      },
      { label: 'Cloudflare zone capability lookup', retryMode: 'read' }
    );

    if (zoneResponse.ok) {
      if (zoneData.success) {
        baseDiagnostics.zoneReadAvailable = true;
        baseDiagnostics.accessibleZoneCount = zoneData.result?.length ?? 0;

        const sampleZoneId = zoneData.result?.[0]?.id;
        if (sampleZoneId) {
          const { response: dnsResponse } = await requestCloudflareApiJson<Record<string, unknown>>(
            `https://api.cloudflare.com/client/v4/zones/${sampleZoneId}/dns_records?per_page=1`,
            {
              headers: {
                Authorization: `Bearer ${tokenInfo.token}`,
              },
            },
            { label: 'Cloudflare DNS capability lookup', retryMode: 'read' }
          );
          baseDiagnostics.dnsReadAvailable = dnsResponse.ok;
        }
      }
    }
  } catch {
    // Keep defaults; this is an estimate only.
  }

  if (auth.accountId) {
    try {
      const { response: workersResponse } = await requestCloudflareApiJson<Record<string, unknown>>(
        `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/workers/scripts`,
        {
          headers: {
            Authorization: `Bearer ${tokenInfo.token}`,
          },
        },
        { label: 'Cloudflare Workers capability lookup', retryMode: 'read' }
      );
      baseDiagnostics.uiWorkersApiAvailable = workersResponse.ok;
    } catch {
      // Keep default false; this is an estimate only.
    }
  }

  return baseDiagnostics;
}

// =============================================================================
// Zone Check
// =============================================================================

export interface ZoneInfo {
  id: string;
  name: string;
  status: string;
}

export type ZoneCheckDiagnosticCode =
  | 'zone_found'
  | 'not_logged_in'
  | 'token_unavailable'
  | 'zone_read_forbidden'
  | 'zone_not_found'
  | 'api_error'
  | 'network_error';

export type ZoneCheckDiagnosticSeverity = 'success' | 'warning' | 'error';

export type ZoneCheckAction =
  | 'retry_check'
  | 'reload_page'
  | 'run_wrangler_login'
  | 'check_cloudflare_permissions'
  | 'open_cloudflare_dashboard';

export interface ZoneCheckDiagnostic {
  code: ZoneCheckDiagnosticCode;
  severity: ZoneCheckDiagnosticSeverity;
  allowBinding: boolean;
  actions: ZoneCheckAction[];
}

export interface ZoneCheckResult {
  found: boolean;
  zone?: ZoneInfo;
  zoneName?: string;
  error?: string;
  diagnostic?: ZoneCheckDiagnostic;
}

function createZoneDiagnostic(
  code: ZoneCheckDiagnosticCode,
  overrides: Partial<ZoneCheckDiagnostic> = {}
): ZoneCheckDiagnostic {
  const defaults: Record<ZoneCheckDiagnosticCode, ZoneCheckDiagnostic> = {
    zone_found: {
      code: 'zone_found',
      severity: 'success',
      allowBinding: true,
      actions: [],
    },
    not_logged_in: {
      code: 'not_logged_in',
      severity: 'error',
      allowBinding: false,
      actions: ['retry_check', 'reload_page', 'run_wrangler_login'],
    },
    token_unavailable: {
      code: 'token_unavailable',
      severity: 'error',
      allowBinding: false,
      actions: ['retry_check', 'reload_page', 'run_wrangler_login'],
    },
    zone_read_forbidden: {
      code: 'zone_read_forbidden',
      severity: 'warning',
      allowBinding: true,
      actions: ['retry_check', 'reload_page', 'run_wrangler_login', 'check_cloudflare_permissions'],
    },
    zone_not_found: {
      code: 'zone_not_found',
      severity: 'warning',
      allowBinding: false,
      actions: ['retry_check', 'open_cloudflare_dashboard'],
    },
    api_error: {
      code: 'api_error',
      severity: 'error',
      allowBinding: false,
      actions: ['retry_check', 'reload_page'],
    },
    network_error: {
      code: 'network_error',
      severity: 'error',
      allowBinding: false,
      actions: ['retry_check', 'reload_page'],
    },
  };

  return {
    ...defaults[code],
    ...overrides,
    actions: overrides.actions ?? defaults[code].actions,
  };
}

function createZoneCheckResult(
  code: ZoneCheckDiagnosticCode,
  options: {
    found?: boolean;
    zone?: ZoneInfo;
    zoneName?: string;
    error?: string;
  } = {}
): ZoneCheckResult {
  return {
    found: options.found ?? code === 'zone_found',
    zone: options.zone,
    zoneName: options.zoneName,
    error: options.error,
    diagnostic: createZoneDiagnostic(code),
  };
}

export function isZoneReadPermissionError(
  errorOrResult?: string | ZoneCheckResult | ZoneCheckDiagnostic | null
): boolean {
  if (!errorOrResult) {
    return false;
  }
  if (typeof errorOrResult === 'string') {
    return errorOrResult.includes('zone:read');
  }
  if ('diagnostic' in errorOrResult) {
    return (
      errorOrResult.diagnostic?.code === 'zone_read_forbidden' ||
      (errorOrResult.error ?? '').includes('zone:read')
    );
  }
  if ('code' in errorOrResult) {
    return errorOrResult.code === 'zone_read_forbidden';
  }
  return false;
}

/**
 * Extract zone name (registrable domain) from a hostname.
 * e.g., "auth.example.com" → "example.com"
 *       "example.co.jp" → "example.co.jp"
 */
export function extractZoneName(hostname: string): string {
  const parts = hostname.split('.');
  // Comprehensive two-part TLD list based on the Public Suffix List (PSL).
  // Only includes patterns commonly used for web hosting on Cloudflare.
  // Sorted alphabetically by country code.
  const twoPartTlds = new Set([
    // ae - United Arab Emirates
    'ac.ae',
    'co.ae',
    'net.ae',
    'org.ae',
    // ar - Argentina
    'com.ar',
    'net.ar',
    'org.ar',
    // at - Austria
    'co.at',
    'or.at',
    // au - Australia
    'com.au',
    'net.au',
    'org.au',
    // bd - Bangladesh
    'com.bd',
    'net.bd',
    'org.bd',
    // bh - Bahrain
    'com.bh',
    'net.bh',
    'org.bh',
    // bn - Brunei
    'com.bn',
    'net.bn',
    'org.bn',
    // bo - Bolivia
    'com.bo',
    'net.bo',
    'org.bo',
    // br - Brazil
    'com.br',
    'net.br',
    'org.br',
    // bw - Botswana
    'co.bw',
    'org.bw',
    // bz - Belize
    'co.bz',
    'com.bz',
    'net.bz',
    'org.bz',
    // cn - China
    'com.cn',
    'net.cn',
    'org.cn',
    // co - Colombia
    'com.co',
    'net.co',
    'org.co',
    // cr - Costa Rica
    'co.cr',
    'or.cr',
    // cu - Cuba
    'com.cu',
    'net.cu',
    'org.cu',
    // cy - Cyprus
    'com.cy',
    'net.cy',
    'org.cy',
    // do - Dominican Republic
    'com.do',
    'net.do',
    'org.do',
    // dz - Algeria
    'com.dz',
    'net.dz',
    'org.dz',
    // ec - Ecuador
    'com.ec',
    'net.ec',
    'org.ec',
    // eg - Egypt
    'com.eg',
    'net.eg',
    'org.eg',
    // et - Ethiopia
    'com.et',
    'net.et',
    'org.et',
    // fj - Fiji
    'com.fj',
    'net.fj',
    'org.fj',
    // ge - Georgia
    'com.ge',
    'net.ge',
    'org.ge',
    // gh - Ghana
    'com.gh',
    'net.gh',
    'org.gh',
    // gr - Greece
    'com.gr',
    'net.gr',
    'org.gr',
    // gt - Guatemala
    'com.gt',
    'net.gt',
    'org.gt',
    // gy - Guyana
    'co.gy',
    'com.gy',
    'net.gy',
    'org.gy',
    // hk - Hong Kong
    'com.hk',
    'net.hk',
    'org.hk',
    // hn - Honduras
    'com.hn',
    'net.hn',
    'org.hn',
    // hr - Croatia
    'com.hr',
    // id - Indonesia
    'co.id',
    'or.id',
    'web.id',
    'net.id',
    // il - Israel
    'co.il',
    'net.il',
    'org.il',
    // im - Isle of Man
    'co.im',
    'com.im',
    'net.im',
    'org.im',
    // in - India
    'co.in',
    'net.in',
    'org.in',
    // io - British Indian Ocean Territory
    'com.io',
    'net.io',
    'org.io',
    // iq - Iraq
    'com.iq',
    'net.iq',
    'org.iq',
    // ir - Iran
    'co.ir',
    'net.ir',
    'org.ir',
    // je - Jersey
    'co.je',
    'net.je',
    'org.je',
    // jo - Jordan
    'com.jo',
    'net.jo',
    'org.jo',
    // jp - Japan
    'co.jp',
    'ne.jp',
    'or.jp',
    'ac.jp',
    'go.jp',
    'gr.jp',
    'ed.jp',
    'ad.jp',
    'lg.jp',
    // ke - Kenya
    'co.ke',
    'or.ke',
    'ne.ke',
    // kh - Cambodia (uses .com.kh etc.)
    'com.kh',
    'net.kh',
    'org.kh',
    // kr - South Korea
    'co.kr',
    'or.kr',
    'ne.kr',
    // kw - Kuwait
    'com.kw',
    'net.kw',
    'org.kw',
    // kz - Kazakhstan
    'com.kz',
    'net.kz',
    'org.kz',
    // lb - Lebanon
    'com.lb',
    'net.lb',
    'org.lb',
    // lc - Saint Lucia
    'co.lc',
    'com.lc',
    'net.lc',
    'org.lc',
    // lk - Sri Lanka
    'com.lk',
    'net.lk',
    'org.lk',
    // ly - Libya
    'com.ly',
    'net.ly',
    'org.ly',
    // ma - Morocco
    'co.ma',
    'net.ma',
    'org.ma',
    // mm - Myanmar
    'com.mm',
    'net.mm',
    'org.mm',
    // mo - Macau
    'com.mo',
    'net.mo',
    'org.mo',
    // mt - Malta
    'com.mt',
    'net.mt',
    'org.mt',
    // mu - Mauritius
    'co.mu',
    'com.mu',
    'net.mu',
    'org.mu',
    // mv - Maldives
    'com.mv',
    'net.mv',
    'org.mv',
    // mx - Mexico
    'com.mx',
    'net.mx',
    'org.mx',
    // my - Malaysia
    'com.my',
    'net.my',
    'org.my',
    // mz - Mozambique
    'co.mz',
    'net.mz',
    'org.mz',
    // na - Namibia
    'co.na',
    'com.na',
    'net.na',
    'org.na',
    // ng - Nigeria
    'com.ng',
    'net.ng',
    'org.ng',
    // ni - Nicaragua
    'com.ni',
    'net.ni',
    'org.ni',
    // np - Nepal
    'com.np',
    'net.np',
    'org.np',
    // nz - New Zealand
    'co.nz',
    'net.nz',
    'org.nz',
    // om - Oman
    'com.om',
    'net.om',
    'org.om',
    // pa - Panama
    'com.pa',
    'net.pa',
    'org.pa',
    // pe - Peru
    'com.pe',
    'net.pe',
    'org.pe',
    // pg - Papua New Guinea
    'com.pg',
    'net.pg',
    'org.pg',
    // ph - Philippines
    'com.ph',
    'net.ph',
    'org.ph',
    // pk - Pakistan
    'com.pk',
    'net.pk',
    'org.pk',
    // pr - Puerto Rico
    'com.pr',
    'net.pr',
    'org.pr',
    // ps - Palestine
    'com.ps',
    'net.ps',
    'org.ps',
    // pt - Portugal
    'com.pt',
    'net.pt',
    'org.pt',
    // py - Paraguay
    'com.py',
    'net.py',
    'org.py',
    // qa - Qatar
    'com.qa',
    'net.qa',
    'org.qa',
    // ro - Romania
    'com.ro',
    'net.ro',
    'org.ro',
    // rs - Serbia
    'co.rs',
    'org.rs',
    // ru - Russia (ru uses direct TLD, but also has some patterns)
    'com.ru',
    'net.ru',
    'org.ru',
    // rw - Rwanda
    'co.rw',
    'net.rw',
    'org.rw',
    // sa - Saudi Arabia
    'com.sa',
    'net.sa',
    'org.sa',
    // sb - Solomon Islands
    'com.sb',
    'net.sb',
    'org.sb',
    // sc - Seychelles
    'com.sc',
    'net.sc',
    'org.sc',
    // sd - Sudan
    'com.sd',
    'net.sd',
    'org.sd',
    // sg - Singapore
    'com.sg',
    'net.sg',
    'org.sg',
    // sl - Sierra Leone
    'com.sl',
    'net.sl',
    'org.sl',
    // sv - El Salvador
    'com.sv',
    'org.sv',
    // sy - Syria
    'com.sy',
    'net.sy',
    'org.sy',
    // th - Thailand
    'co.th',
    'in.th',
    'ac.th',
    'or.th',
    'net.th',
    // tn - Tunisia
    'com.tn',
    'net.tn',
    'org.tn',
    // tr - Turkey
    'com.tr',
    'net.tr',
    'org.tr',
    // tt - Trinidad and Tobago
    'co.tt',
    'com.tt',
    'net.tt',
    'org.tt',
    // tw - Taiwan
    'com.tw',
    'net.tw',
    'org.tw',
    // tz - Tanzania
    'co.tz',
    'or.tz',
    'ne.tz',
    // ua - Ukraine
    'com.ua',
    'net.ua',
    'org.ua',
    // ug - Uganda
    'co.ug',
    'or.ug',
    'ne.ug',
    // uk - United Kingdom
    'co.uk',
    'org.uk',
    'me.uk',
    'net.uk',
    // uy - Uruguay
    'com.uy',
    'net.uy',
    'org.uy',
    // uz - Uzbekistan
    'co.uz',
    'com.uz',
    'net.uz',
    'org.uz',
    // vc - Saint Vincent and the Grenadines
    'com.vc',
    'net.vc',
    'org.vc',
    // ve - Venezuela
    'co.ve',
    'com.ve',
    'net.ve',
    'org.ve',
    // vn - Vietnam
    'com.vn',
    'net.vn',
    'org.vn',
    // za - South Africa
    'co.za',
    'net.za',
    'org.za',
    // zm - Zambia
    'co.zm',
    'com.zm',
    'net.zm',
    'org.zm',
    // zw - Zimbabwe
    'co.zw',
    'org.zw',
  ]);
  const lastTwo = parts.slice(-2).join('.');
  if (twoPartTlds.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
}

/**
 * Check if a Cloudflare zone exists for the given domain.
 * Gracefully handles authentication failures and network errors.
 */
export async function checkZoneExists(domain: string): Promise<ZoneCheckResult> {
  try {
    const zoneName = extractZoneName(domain);
    const tokenInfo = await getCloudflareApiToken();
    if (!tokenInfo) {
      const auth = await checkAuth();
      if (!auth.isLoggedIn) {
        return createZoneCheckResult('not_logged_in', {
          zoneName,
          error: 'Not logged in to Cloudflare (run: wrangler login)',
        });
      }
      return createZoneCheckResult('token_unavailable', {
        zoneName,
        error: 'Cloudflare API token is unavailable',
      });
    }

    const { response, data } = await requestCloudflareApiJson<{
      success: boolean;
      result: Array<{ id: string; name: string; status: string }>;
      errors?: CloudflareApiMessage[];
    }>(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zoneName)}`,
      {
        headers: {
          Authorization: `Bearer ${tokenInfo.token}`,
        },
      },
      { label: 'Cloudflare zone lookup', retryMode: 'read' }
    );

    if (!response.ok) {
      if (response.status === 403) {
        return createZoneCheckResult('zone_read_forbidden', {
          zoneName,
          error: 'Token lacks zone:read permission',
        });
      }
      return createZoneCheckResult('api_error', {
        zoneName,
        error: `Cloudflare API returned ${response.status}`,
      });
    }

    if (!data.success) {
      const apiMessage = data.errors?.find((item) => item.message)?.message;
      return createZoneCheckResult('api_error', {
        zoneName,
        error: apiMessage || 'Cloudflare API returned an unsuccessful response',
      });
    }

    if (!data.result || data.result.length === 0) {
      return createZoneCheckResult('zone_not_found', { zoneName });
    }

    const zone = data.result[0];
    return createZoneCheckResult('zone_found', {
      found: true,
      zone: { id: zone.id, name: zone.name, status: zone.status },
      zoneName,
    });
  } catch (error) {
    return createZoneCheckResult('network_error', {
      zoneName: extractZoneName(domain),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export interface EnsureWildcardDnsResult {
  created: boolean;
  updated: boolean;
  recordId?: string;
  name: string;
  target: string;
  verificationLimited?: boolean;
  ownership?: DnsOwnershipEntry;
}

export interface DnsOwnershipPersistence {
  get(role: DnsOwnershipRole): DnsOwnershipEntry | undefined;
  persist(entry: DnsOwnershipEntry): Promise<void>;
}

interface CloudflareApiMessage {
  code?: number;
  message?: string;
}

interface CloudflareDnsRecordResponse {
  success?: boolean;
  result?: Array<{
    id: string;
    type: string;
    name: string;
    content: string;
    proxied?: boolean;
    ttl?: number;
    comment?: string | null;
    tags?: string[];
    settings?: Record<string, string | number | boolean | null>;
  }>;
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
}

interface CloudflareDnsMutationResponse {
  success?: boolean;
  result?: { id?: string };
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
}

interface CloudflareR2ObjectListResponse {
  success?: boolean;
  result?: Array<{
    key?: string;
    size?: number;
    last_modified?: string;
    etag?: string;
  }>;
  result_info?: {
    cursor?: string;
    is_truncated?: boolean;
  };
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
}

interface CloudflareR2BucketListResponse {
  success?: boolean;
  result?: {
    buckets?: unknown;
  };
  result_info?: {
    cursor?: unknown;
    per_page?: unknown;
  };
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
}

interface CloudflareAccountsResponse {
  success?: boolean;
  result?: Array<{ id?: string }>;
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
}

function hasCloudflareAlreadyExistsError(payload: {
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
}): boolean {
  const entries = [...(payload.errors ?? []), ...(payload.messages ?? [])];
  return entries.some(
    (entry) =>
      entry.code === 81057 || entry.code === 81058 || /already exists/i.test(entry.message ?? '')
  );
}

const DNS_API_REQUEST_TIMEOUT_MS = process.env.NODE_ENV === 'test' ? 100 : 30_000;
const DNS_API_READ_ATTEMPTS = process.env.NODE_ENV === 'test' ? 3 : 5;

interface DnsRecordReadResult {
  forbidden: boolean;
  records: NonNullable<CloudflareDnsRecordResponse['result']>;
}

function isRetryableCloudflareHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function readDnsRecordsExact(options: {
  zoneId: string;
  recordName: string;
  token: string;
}): Promise<DnsRecordReadResult> {
  const url =
    `https://api.cloudflare.com/client/v4/zones/${options.zoneId}/dns_records?name=` +
    encodeURIComponent(options.recordName);
  let lastError: unknown;

  for (let attempt = 1; attempt <= DNS_API_READ_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${options.token}` },
        signal: AbortSignal.timeout(DNS_API_REQUEST_TIMEOUT_MS),
      });
      if (response.status === 403) return { forbidden: true, records: [] };
      if (!response.ok) {
        const error = new Error(`Failed to query DNS records (${response.status})`);
        if (isRetryableCloudflareHttpStatus(response.status) && attempt < DNS_API_READ_ATTEMPTS) {
          lastError = error;
          continue;
        }
        throw error;
      }

      const data = (await response.json().catch(() => null)) as CloudflareDnsRecordResponse | null;
      if (!data || data.success !== true || !Array.isArray(data.result)) {
        throw new Error('Cloudflare DNS query returned an invalid or unsuccessful response');
      }
      return { forbidden: false, records: data.result };
    } catch (error) {
      lastError = error;
      if (attempt >= DNS_API_READ_ATTEMPTS) throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Cloudflare DNS query retry loop exited unexpectedly');
}

function findDesiredProxiedCname(
  records: NonNullable<CloudflareDnsRecordResponse['result']>,
  recordName: string,
  recordTarget: string,
  marker?: string
) {
  return records.find(
    (record) =>
      record.type === 'CNAME' &&
      record.name === recordName &&
      record.content === recordTarget &&
      record.proxied === true &&
      (marker === undefined || record.comment === marker)
  );
}

function toDnsRestoreSnapshot(
  record: NonNullable<CloudflareDnsRecordResponse['result']>[number]
): DnsRecordRestoreSnapshot {
  if (record.type !== 'CNAME') {
    throw new Error(`dns_record_type_not_safe_to_replace:${record.name}:${record.type}`);
  }
  return {
    id: record.id,
    type: 'CNAME',
    name: record.name,
    content: record.content,
    ...(record.proxied === undefined ? {} : { proxied: record.proxied }),
    ...(record.ttl === undefined ? {} : { ttl: record.ttl }),
    ...(record.comment === undefined ? {} : { comment: record.comment }),
    ...(record.tags === undefined ? {} : { tags: record.tags }),
    ...(record.settings === undefined ? {} : { settings: record.settings }),
  };
}

function dnsSnapshotMatches(
  record: NonNullable<CloudflareDnsRecordResponse['result']>[number],
  snapshot: DnsRecordRestoreSnapshot
): boolean {
  return (
    record.id === snapshot.id &&
    record.type === snapshot.type &&
    record.name === snapshot.name &&
    record.content === snapshot.content &&
    record.proxied === snapshot.proxied &&
    record.ttl === snapshot.ttl &&
    (record.comment ?? null) === (snapshot.comment ?? null) &&
    JSON.stringify(record.tags ?? []) === JSON.stringify(snapshot.tags ?? []) &&
    JSON.stringify(Object.entries(record.settings ?? {}).sort()) ===
      JSON.stringify(Object.entries(snapshot.settings ?? {}).sort())
  );
}

function assertDnsOwnershipScope(
  ownership: DnsOwnershipEntry,
  options: {
    role: DnsOwnershipRole;
    zoneId: string;
    recordName: string;
    recordTarget: string;
  }
): void {
  if (
    ownership.role !== options.role ||
    ownership.zoneId !== options.zoneId ||
    ownership.name !== options.recordName ||
    ownership.target !== options.recordTarget
  ) {
    throw new Error(`dns_ownership_scope_mismatch:${options.role}`);
  }
}

function createDnsOwnershipMarker(operationId: string): string {
  return `Authrim Setup managed DNS ownership ${operationId}`;
}

async function waitForDesiredProxiedCname(options: {
  zoneId: string;
  recordName: string;
  recordTarget: string;
  token: string;
  marker?: string;
}) {
  let lastRecords: NonNullable<CloudflareDnsRecordResponse['result']> = [];
  for (let attempt = 1; attempt <= DNS_API_READ_ATTEMPTS; attempt++) {
    const readback = await readDnsRecordsExact(options);
    if (readback.forbidden) {
      throw new Error(`DNS read permission was lost while verifying ${options.recordName}`);
    }
    lastRecords = readback.records;
    const desired = findDesiredProxiedCname(
      readback.records,
      options.recordName,
      options.recordTarget,
      options.marker
    );
    if (desired) return desired;
    if (attempt < DNS_API_READ_ATTEMPTS && process.env.NODE_ENV !== 'test') {
      await sleep(Math.min(500 * 2 ** (attempt - 1), 4_000));
    }
  }

  const conflicting = lastRecords.some((record) => record.name === options.recordName);
  throw new Error(
    conflicting
      ? `DNS record ${options.recordName} does not match the required proxied CNAME target`
      : `DNS record ${options.recordName} was not visible after the Cloudflare mutation`
  );
}

/**
 * Ensure a proxied wildcard DNS record exists for tenant subdomains.
 *
 * Creates or updates `*.{baseDomain}` as a proxied CNAME pointing to `{baseDomain}`.
 * This allows wildcard tenant hosts to resolve through Cloudflare so Worker routes can match.
 */
export async function ensureWildcardDnsRecord(
  baseDomain: string,
  zoneId?: string | null,
  ownership?: DnsOwnershipPersistence
): Promise<EnsureWildcardDnsResult> {
  return ensureProxiedCnameDnsRecord({
    role: 'tenant_wildcard',
    recordName: `*.${baseDomain}`,
    recordTarget: baseDomain,
    zoneLookupName: baseDomain,
    zoneId,
    permissionErrorName: 'wildcard DNS record',
    ownership,
  });
}

export async function ensureApiBaseDnsRecord(
  baseDomain: string,
  targetHostname: string,
  zoneId?: string | null,
  ownership?: DnsOwnershipPersistence
): Promise<EnsureWildcardDnsResult> {
  return ensureProxiedCnameDnsRecord({
    role: 'api_base',
    recordName: baseDomain,
    recordTarget: targetHostname,
    zoneLookupName: baseDomain,
    zoneId,
    permissionErrorName: 'API base DNS record',
    ownership,
  });
}

async function ensureProxiedCnameDnsRecord(options: {
  role: DnsOwnershipRole;
  recordName: string;
  recordTarget: string;
  zoneLookupName: string;
  zoneId?: string | null;
  permissionErrorName: string;
  ownership?: DnsOwnershipPersistence;
}): Promise<EnsureWildcardDnsResult> {
  const tokenInfo = await getCloudflareApiToken();
  if (!tokenInfo) {
    throw new Error('Not logged in to Cloudflare (run: wrangler login)');
  }

  const { role, recordName, recordTarget, zoneLookupName, zoneId, permissionErrorName } = options;

  let resolvedZoneId = zoneId || undefined;
  if (!resolvedZoneId) {
    const zoneResult = await checkZoneExists(zoneLookupName);
    if (!zoneResult.found || !zoneResult.zone?.id) {
      if (zoneResult.diagnostic?.code === 'zone_read_forbidden') {
        return {
          created: false,
          updated: false,
          name: recordName,
          target: recordTarget,
          verificationLimited: true,
        };
      }
      throw new Error(`Cloudflare zone not found for ${zoneLookupName}`);
    }
    resolvedZoneId = zoneResult.zone.id;
  }

  const persistedOwnership = options.ownership?.get(role);
  if (persistedOwnership) {
    assertDnsOwnershipScope(persistedOwnership, {
      role,
      zoneId: resolvedZoneId,
      recordName,
      recordTarget,
    });
  }

  const persistManagedOwnership = async (
    ownership: DnsOwnershipEntry,
    recordId: string
  ): Promise<DnsOwnershipEntry> => {
    const managed: DnsOwnershipEntry = {
      ...ownership,
      state: 'managed',
      recordId,
      updatedAt: new Date().toISOString(),
    };
    await options.ownership?.persist(managed);
    return managed;
  };

  let mutationOwnership = persistedOwnership;
  const buildPayload = (marker?: string) => ({
    type: 'CNAME',
    name: recordName,
    content: recordTarget,
    proxied: true,
    ttl: 1,
    ...(marker ? { comment: marker } : {}),
  });

  const createWildcardRecord = async (
    dnsReadForbidden: boolean
  ): Promise<EnsureWildcardDnsResult> => {
    if (options.ownership && dnsReadForbidden) {
      return {
        created: false,
        updated: false,
        name: recordName,
        target: recordTarget,
        verificationLimited: true,
      };
    }
    if (options.ownership && !mutationOwnership) {
      const operationId = randomUUID();
      mutationOwnership = {
        role,
        state: 'mutation_pending',
        action: 'created',
        operationId,
        zoneId: resolvedZoneId,
        name: recordName,
        target: recordTarget,
        marker: createDnsOwnershipMarker(operationId),
        previous: null,
        updatedAt: new Date().toISOString(),
      };
      await options.ownership.persist(mutationOwnership);
    }
    const marker = mutationOwnership?.marker;
    const payload = buildPayload(marker);
    let createResponse: Response | null = null;
    let createdData: CloudflareDnsMutationResponse = {};
    let mutationError: unknown;
    try {
      createResponse = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${resolvedZoneId}/dns_records`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenInfo.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(DNS_API_REQUEST_TIMEOUT_MS),
        }
      );
      createdData = (await createResponse
        .json()
        .catch(() => ({}))) as CloudflareDnsMutationResponse;
    } catch (error) {
      mutationError = error;
    }

    const conflict =
      createResponse !== null &&
      (createResponse.status === 409 || hasCloudflareAlreadyExistsError(createdData));
    const mutationSucceeded =
      createResponse !== null && createResponse.ok && createdData.success !== false;

    if (dnsReadForbidden) {
      if (mutationSucceeded) {
        return {
          created: true,
          updated: false,
          recordId: createdData.result?.id,
          name: recordName,
          target: recordTarget,
          verificationLimited: true,
        };
      }
      if (conflict || createResponse?.status === 403) {
        return {
          created: false,
          updated: false,
          name: recordName,
          target: recordTarget,
          verificationLimited: true,
        };
      }
      if (mutationError) {
        throw mutationError instanceof Error
          ? mutationError
          : new Error(describeInventoryError(mutationError, 'unknown DNS mutation error'));
      }
      throw new Error(`Failed to create ${permissionErrorName} (${createResponse?.status ?? 0})`);
    }

    if (createResponse?.status === 403) {
      throw new Error(`Token lacks dns:edit permission to create ${permissionErrorName}`);
    }

    try {
      const verified = await waitForDesiredProxiedCname({
        zoneId: resolvedZoneId,
        recordName,
        recordTarget,
        token: tokenInfo.token,
        marker,
      });
      const managedOwnership = mutationOwnership
        ? await persistManagedOwnership(mutationOwnership, verified.id)
        : undefined;
      return {
        created: mutationOwnership?.action === 'created' || (mutationSucceeded && !conflict),
        updated: false,
        recordId: verified.id,
        name: recordName,
        target: recordTarget,
        ownership: managedOwnership,
      };
    } catch (verificationError) {
      if (mutationError) {
        throw new AggregateError(
          [mutationError, verificationError],
          `Failed to verify ${permissionErrorName} after an ambiguous create`
        );
      }
      if (!mutationSucceeded && !conflict) {
        throw new AggregateError(
          [
            new Error(
              `Failed to create ${permissionErrorName} (${createResponse?.status ?? 0})${formatCloudflareApiMessages(createdData) ? `: ${formatCloudflareApiMessages(createdData)}` : ''}`
            ),
            verificationError,
          ],
          `Failed to create and verify ${permissionErrorName}`
        );
      }
      throw verificationError;
    }
  };

  const initialRead = await readDnsRecordsExact({
    zoneId: resolvedZoneId,
    recordName,
    token: tokenInfo.token,
  });
  if (initialRead.forbidden) return createWildcardRecord(true);

  const exactNameRecords = initialRead.records.filter((record) => record.name === recordName);
  if (exactNameRecords.length > 1) {
    throw new Error(`dns_record_inventory_ambiguous:${recordName}`);
  }
  const existingRecord = exactNameRecords[0];

  if (persistedOwnership?.state === 'managed') {
    if (!existingRecord) {
      throw new Error(`dns_managed_record_missing:${role}`);
    }
    if (existingRecord.id !== persistedOwnership.recordId) {
      throw new Error(`dns_managed_record_identity_mismatch:${role}`);
    }
    const desired = findDesiredProxiedCname(
      [existingRecord],
      recordName,
      recordTarget,
      persistedOwnership.marker
    );
    if (!desired) {
      throw new Error(`dns_managed_record_value_mismatch:${role}`);
    }
    return {
      created: false,
      updated: false,
      recordId: existingRecord.id,
      name: recordName,
      target: recordTarget,
      ownership: persistedOwnership,
    };
  }

  if (persistedOwnership?.state === 'mutation_pending') {
    if (
      existingRecord &&
      findDesiredProxiedCname([existingRecord], recordName, recordTarget, persistedOwnership.marker)
    ) {
      if (
        persistedOwnership.action === 'updated' &&
        existingRecord.id !== persistedOwnership.previous?.id
      ) {
        throw new Error(`dns_pending_record_identity_mismatch:${role}`);
      }
      const managedOwnership = await persistManagedOwnership(persistedOwnership, existingRecord.id);
      return {
        created: false,
        updated: false,
        recordId: existingRecord.id,
        name: recordName,
        target: recordTarget,
        ownership: managedOwnership,
      };
    }
    if (persistedOwnership.action === 'created' && existingRecord) {
      throw new Error(`dns_pending_record_collision:${role}`);
    }
    if (persistedOwnership.action === 'updated') {
      if (!existingRecord || !persistedOwnership.previous) {
        throw new Error(`dns_pending_record_missing:${role}`);
      }
      if (!dnsSnapshotMatches(existingRecord, persistedOwnership.previous)) {
        throw new Error(`dns_pending_previous_value_mismatch:${role}`);
      }
    }
  }

  if (existingRecord) {
    if (existingRecord.content === recordTarget && existingRecord.proxied === true) {
      const adoptedOwnership: DnsOwnershipEntry | undefined = options.ownership
        ? {
            role,
            state: 'managed',
            action: 'adopted',
            operationId: randomUUID(),
            zoneId: resolvedZoneId,
            recordId: existingRecord.id,
            name: recordName,
            target: recordTarget,
            updatedAt: new Date().toISOString(),
          }
        : undefined;
      if (adoptedOwnership) await options.ownership?.persist(adoptedOwnership);
      return {
        created: false,
        updated: false,
        recordId: existingRecord.id,
        name: recordName,
        target: recordTarget,
        ownership: adoptedOwnership,
      };
    }

    if (options.ownership && !mutationOwnership) {
      const previous = toDnsRestoreSnapshot(existingRecord);
      const operationId = randomUUID();
      mutationOwnership = {
        role,
        state: 'mutation_pending',
        action: 'updated',
        operationId,
        zoneId: resolvedZoneId,
        recordId: existingRecord.id,
        name: recordName,
        target: recordTarget,
        marker: createDnsOwnershipMarker(operationId),
        previous,
        updatedAt: new Date().toISOString(),
      };
      await options.ownership.persist(mutationOwnership);
    }
    const marker = mutationOwnership?.marker;
    const payload = buildPayload(marker);

    let updateResponse: Response | null = null;
    let updateData: CloudflareDnsMutationResponse = {};
    let updateError: unknown;
    try {
      updateResponse = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${resolvedZoneId}/dns_records/${existingRecord.id}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${tokenInfo.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(DNS_API_REQUEST_TIMEOUT_MS),
        }
      );
      updateData = (await updateResponse.json().catch(() => ({}))) as CloudflareDnsMutationResponse;
    } catch (error) {
      updateError = error;
    }

    try {
      const verified = await waitForDesiredProxiedCname({
        zoneId: resolvedZoneId,
        recordName,
        recordTarget,
        token: tokenInfo.token,
        marker,
      });
      if (mutationOwnership?.action === 'updated' && verified.id !== existingRecord.id) {
        throw new Error(`dns_updated_record_identity_mismatch:${role}`);
      }
      const managedOwnership = mutationOwnership
        ? await persistManagedOwnership(mutationOwnership, verified.id)
        : undefined;
      return {
        created: false,
        updated: true,
        recordId: verified.id,
        name: recordName,
        target: recordTarget,
        ownership: managedOwnership,
      };
    } catch (verificationError) {
      if (updateError) {
        throw new AggregateError(
          [updateError, verificationError],
          `Failed to verify ${permissionErrorName} after an ambiguous update`
        );
      }
      if (!updateResponse?.ok || updateData.success === false) {
        throw new AggregateError(
          [
            new Error(`Failed to update ${permissionErrorName} (${updateResponse?.status ?? 0})`),
            verificationError,
          ],
          `Failed to update and verify ${permissionErrorName}`
        );
      }
      throw verificationError;
    }
  }

  return createWildcardRecord(false);
}

export async function ensureWildcardDnsForMultiTenant(
  cfg: Partial<AuthrimConfig> | null | undefined,
  onProgress?: (message: string) => void,
  verifyPublicDns: (baseDomain: string) => Promise<boolean> = verifyWildcardDnsPublicResolution,
  ownership?: DnsOwnershipPersistence
): Promise<void> {
  const baseDomain = cfg?.tenant?.multiTenant === true ? cfg.tenant.baseDomain?.trim() : undefined;
  if (!baseDomain) {
    return;
  }

  const apiAutoHostname = extractHostnameFromUrl(cfg?.urls?.api?.auto);
  const apiUsesCustomDomainBinding = cfg?.urls?.api?.customDomainBinding === true;
  if (apiAutoHostname && apiAutoHostname !== baseDomain && !apiUsesCustomDomainBinding) {
    onProgress?.(`Ensuring API DNS for ${baseDomain}...`);
    const apiDnsResult = await ensureApiBaseDnsRecord(
      baseDomain,
      apiAutoHostname,
      cfg?.urls?.api?.zoneId ?? null,
      ownership
    );
    if (apiDnsResult.verificationLimited) {
      throw new Error(
        `Token lacks zone:read or dns:edit permission to verify the exact proxied CNAME target for ${apiDnsResult.name}`
      );
    } else if (apiDnsResult.created) {
      onProgress?.(`✓ API DNS created: ${apiDnsResult.name} -> ${apiDnsResult.target}`);
    } else if (apiDnsResult.updated) {
      onProgress?.(`✓ API DNS updated: ${apiDnsResult.name} -> ${apiDnsResult.target}`);
    } else {
      onProgress?.(`✓ API DNS already present: ${apiDnsResult.name} -> ${apiDnsResult.target}`);
    }
  } else if (apiUsesCustomDomainBinding) {
    onProgress?.(`✓ API DNS will be managed by Worker custom domain binding: ${baseDomain}`);
  }

  onProgress?.(`Ensuring wildcard DNS for *.${baseDomain}...`);

  const result = await ensureWildcardDnsRecord(
    baseDomain,
    cfg?.urls?.api?.zoneId ?? null,
    ownership
  );
  if (result.verificationLimited) {
    const providerMutationWasNotObserved =
      result.created === false &&
      result.updated === false &&
      result.recordId === undefined &&
      result.ownership === undefined;
    if (providerMutationWasNotObserved && (await verifyPublicDns(baseDomain))) {
      onProgress?.(
        `✓ Wildcard DNS resolves publicly and remains externally managed: ${result.name}`
      );
      return;
    }
    throw new Error(
      `Token lacks zone:read or dns:edit permission to verify the exact proxied CNAME target for ${result.name}`
    );
  } else if (result.created) {
    onProgress?.(`✓ Wildcard DNS created: ${result.name} -> ${result.target}`);
  } else if (result.updated) {
    onProgress?.(`✓ Wildcard DNS updated: ${result.name} -> ${result.target}`);
  } else {
    onProgress?.(`✓ Wildcard DNS already present: ${result.name} -> ${result.target}`);
  }
}

export interface ManagedDnsCleanupIssue {
  role: DnsOwnershipRole | 'unknown';
  name: string;
  reason: string;
}

async function readSingleDnsRecordForOwnership(options: {
  entry: DnsOwnershipEntry;
  token: string;
}): Promise<NonNullable<CloudflareDnsRecordResponse['result']>[number] | null> {
  const readback = await readDnsRecordsExact({
    zoneId: options.entry.zoneId,
    recordName: options.entry.name,
    token: options.token,
  });
  if (readback.forbidden) throw new Error(`dns_read_permission_required:${options.entry.role}`);
  const exact = readback.records.filter((record) => record.name === options.entry.name);
  if (exact.length > 1) throw new Error(`dns_record_inventory_ambiguous:${options.entry.name}`);
  return exact[0] ?? null;
}

function managedDnsRecordMatches(
  record: NonNullable<CloudflareDnsRecordResponse['result']>[number],
  entry: DnsOwnershipEntry
): boolean {
  return (
    record.id === entry.recordId &&
    Boolean(findDesiredProxiedCname([record], entry.name, entry.target, entry.marker))
  );
}

async function mutateManagedDnsRecord(options: {
  entry: DnsOwnershipEntry;
  token: string;
  method: 'DELETE' | 'PUT';
  body?: Record<string, unknown>;
}): Promise<void> {
  let response: Response | null = null;
  let mutationError: unknown;
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${options.entry.zoneId}/dns_records/${options.entry.recordId}`,
      {
        method: options.method,
        headers: {
          Authorization: `Bearer ${options.token}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(DNS_API_REQUEST_TIMEOUT_MS),
      }
    );
    await response.json().catch(() => undefined);
  } catch (error) {
    mutationError = error;
  }
  if (response?.status === 403) {
    throw new Error(`dns_edit_permission_required:${options.entry.role}`);
  }
  if (response && !response.ok && response.status !== 404) {
    mutationError = new Error(
      `dns_cleanup_mutation_failed:${options.entry.role}:${response.status}`
    );
  }
  // Mutation responses are not authoritative: callers always perform exact readback and accept
  // an ambiguous timeout only when the requested final state is visible. The captured error is
  // intentionally not used to issue a second mutation.
  void mutationError;
}

async function waitForManagedDnsCleanupState(options: {
  entry: DnsOwnershipEntry;
  token: string;
  expected: 'absent' | DnsRecordRestoreSnapshot;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DNS_API_READ_ATTEMPTS; attempt++) {
    try {
      const record = await readSingleDnsRecordForOwnership(options);
      if (options.expected === 'absent') {
        if (!record || record.id !== options.entry.recordId) return;
      } else if (record && dnsSnapshotMatches(record, options.expected)) {
        return;
      }
      lastError = new Error(`dns_cleanup_readback_mismatch:${options.entry.role}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < DNS_API_READ_ATTEMPTS && process.env.NODE_ENV !== 'test') {
      await sleep(Math.min(500 * 2 ** (attempt - 1), 4_000));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`dns_cleanup_readback_failed:${options.entry.role}`);
}

/**
 * Revert only DNS mutations whose exact ownership is recorded by Setup. Same-name replacement
 * records are never deleted or overwritten. This operation is idempotent across a crash after the
 * provider mutation because the requested absent/restored state is accepted on the next run.
 */
export async function cleanupManagedDnsRecords(options: {
  entries: Partial<Record<DnsOwnershipRole, DnsOwnershipEntry>> | undefined;
  required: boolean;
  requiredRoles?: DnsOwnershipRole[];
  preflightOnly?: boolean;
  onProgress?: (message: string) => void;
}): Promise<{ completedNames: string[]; issues: ManagedDnsCleanupIssue[] }> {
  const entries = Object.values(options.entries ?? {});
  const missingRoleIssues: ManagedDnsCleanupIssue[] = (options.requiredRoles ?? [])
    .filter((role) => options.entries?.[role] === undefined)
    .map((role) => ({
      role,
      name: `(${role})`,
      reason: 'dns_ownership_evidence_missing',
    }));
  if (entries.length === 0) {
    return {
      completedNames: [],
      issues:
        missingRoleIssues.length > 0
          ? missingRoleIssues
          : options.required
            ? [
                {
                  role: 'unknown',
                  name: '(multi-tenant DNS)',
                  reason: 'dns_ownership_evidence_missing',
                },
              ]
            : [],
    };
  }
  const tokenInfo = await getCloudflareApiToken();
  if (!tokenInfo) {
    return {
      completedNames: [],
      issues: entries.map((entry) => ({
        role: entry.role,
        name: entry.name,
        reason: 'cloudflare_login_required_for_dns_cleanup',
      })),
    };
  }

  const completedNames: string[] = [];
  const issues: ManagedDnsCleanupIssue[] = [...missingRoleIssues];
  for (const entry of entries) {
    options.onProgress?.(`  ⏳ Reconciling DNS ownership: ${entry.name}...`);
    try {
      const current = await readSingleDnsRecordForOwnership({ entry, token: tokenInfo.token });
      let cleanupEntry = entry;
      if (entry.state === 'mutation_pending' && current) {
        const pendingDesired = Boolean(
          findDesiredProxiedCname([current], entry.name, entry.target, entry.marker)
        );
        if (entry.action === 'created' && pendingDesired) {
          cleanupEntry = { ...entry, state: 'managed', recordId: current.id };
        } else if (
          entry.action === 'updated' &&
          entry.previous &&
          current.id === entry.previous.id &&
          pendingDesired
        ) {
          cleanupEntry = { ...entry, state: 'managed', recordId: current.id };
        }
      }
      if (entry.action === 'adopted') {
        if (current && !managedDnsRecordMatches(current, entry)) {
          throw new Error(`dns_adopted_record_identity_mismatch:${entry.role}`);
        }
        if (options.preflightOnly) continue;
        completedNames.push(entry.name);
        options.onProgress?.(`  ✅ ${entry.name} (pre-existing record preserved)`);
        continue;
      }

      if (!entry.marker) throw new Error(`dns_ownership_marker_missing:${entry.role}`);
      if (entry.action === 'created') {
        if (!current) {
          if (options.preflightOnly) continue;
          completedNames.push(entry.name);
          options.onProgress?.(`  ✅ ${entry.name} (already absent)`);
          continue;
        }
        if (!managedDnsRecordMatches(current, cleanupEntry)) {
          throw new Error(`dns_managed_record_identity_mismatch:${entry.role}`);
        }
        if (options.preflightOnly) continue;
        await mutateManagedDnsRecord({
          entry: cleanupEntry,
          token: tokenInfo.token,
          method: 'DELETE',
        });
        await waitForManagedDnsCleanupState({
          entry: cleanupEntry,
          token: tokenInfo.token,
          expected: 'absent',
        });
        completedNames.push(entry.name);
        options.onProgress?.(`  ✅ ${entry.name} (Setup-created record deleted)`);
        continue;
      }

      const previous = entry.previous;
      if (!previous) throw new Error(`dns_previous_value_missing:${entry.role}`);
      if (current && dnsSnapshotMatches(current, previous)) {
        if (options.preflightOnly) continue;
        completedNames.push(entry.name);
        options.onProgress?.(`  ✅ ${entry.name} (previous value already restored)`);
        continue;
      }
      if (!current || !managedDnsRecordMatches(current, cleanupEntry)) {
        throw new Error(`dns_managed_record_identity_mismatch:${entry.role}`);
      }
      if (options.preflightOnly) continue;
      await mutateManagedDnsRecord({
        entry: cleanupEntry,
        token: tokenInfo.token,
        method: 'PUT',
        body: {
          type: previous.type,
          name: previous.name,
          content: previous.content,
          ...(previous.proxied === undefined ? {} : { proxied: previous.proxied }),
          ...(previous.ttl === undefined ? {} : { ttl: previous.ttl }),
          ...(previous.comment === undefined ? {} : { comment: previous.comment }),
          ...(previous.tags === undefined ? {} : { tags: previous.tags }),
          ...(previous.settings === undefined ? {} : { settings: previous.settings }),
        },
      });
      await waitForManagedDnsCleanupState({
        entry: cleanupEntry,
        token: tokenInfo.token,
        expected: previous,
      });
      completedNames.push(entry.name);
      options.onProgress?.(`  ✅ ${entry.name} (previous value restored)`);
    } catch (error) {
      const reason = sanitizeError(error);
      issues.push({ role: entry.role, name: entry.name, reason });
      options.onProgress?.(`  ❌ ${entry.name} - ${reason}`);
    }
  }
  return { completedNames, issues };
}

function extractHostnameFromUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

export async function verifyHostnameDnsPublicResolution(hostname: string): Promise<boolean> {
  const attempts = [
    () => resolveCname(hostname),
    () => resolve4(hostname),
    () => resolve6(hostname),
  ];

  for (const attempt of attempts) {
    try {
      const records = await attempt();
      if (records.length > 0) {
        return true;
      }
    } catch {
      // Try the next record type.
    }
  }

  return false;
}

export async function verifyWildcardDnsPublicResolution(baseDomain: string): Promise<boolean> {
  const hostname = `authrim-wildcard-check-${Date.now()}.${baseDomain}`;

  return verifyHostnameDnsPublicResolution(hostname);
}

// =============================================================================
// D1 Database Operations
// =============================================================================

type D1DatabaseListRow = { name: string; uuid: string };

function stripAnsiSequences(value: string): string {
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}

function findJsonContainerCandidates(
  value: string,
  openingCharacter: '[' | '{',
  closingCharacter: ']' | '}'
): string[] {
  const candidates: string[] = [];
  const normalized = stripAnsiSequences(value);

  for (let start = 0; start < normalized.length; start++) {
    if (normalized[start] !== openingCharacter) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < normalized.length; index++) {
      const character = normalized[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === openingCharacter) {
        depth++;
      } else if (character === closingCharacter) {
        depth--;
        if (depth === 0) {
          candidates.push(normalized.slice(start, index + 1));
          break;
        }
      }
    }
  }

  return candidates;
}

function parseValidatedJsonOutput<T>(
  stdout: string,
  normalizeRows: (rows: unknown) => T[],
  invalidOutputMessage: string
): T[] {
  const normalized = stripAnsiSequences(stdout).trim();
  const candidates = Array.from(
    new Set([
      normalized,
      ...findJsonContainerCandidates(normalized, '[', ']'),
      ...findJsonContainerCandidates(normalized, '{', '}'),
    ])
  ).sort((left, right) => right.length - left.length);

  for (const candidate of candidates) {
    try {
      return normalizeRows(JSON.parse(candidate));
    } catch {
      // Try the next complete JSON container found in noisy Wrangler output.
    }
  }

  throw new SyntaxError(invalidOutputMessage);
}

function describeInventoryError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return fallback;
}

async function resolveCloudflareInventoryCredentials(accountIdHint?: string): Promise<{
  accountId: string;
  token: string;
  source: CloudflareApiToken['source'];
} | null> {
  const hintedAccountId = accountIdHint?.trim();
  if (hintedAccountId && !/^[a-f0-9]{32}$/u.test(hintedAccountId)) {
    throw new Error('cloudflare_account_id_invalid');
  }
  if (
    process.env.NODE_ENV === 'test' &&
    ((!hintedAccountId && !process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) ||
      !process.env.CLOUDFLARE_API_TOKEN?.trim())
  ) {
    return null;
  }

  const envToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  let tokenInfo = envToken
    ? ({ token: envToken, source: 'env' } satisfies CloudflareApiToken)
    : await getCloudflareApiToken();
  let oauthAccountId: string | null = null;
  if (tokenInfo?.source === 'oauth') {
    // `wrangler whoami` refreshes an expired cached OAuth session. Re-read the token only after
    // that command; a configured account ID must not cause Setup to skip credential refresh.
    oauthAccountId = await getAccountId();
    const refreshed = await getCloudflareApiToken();
    if (!refreshed || refreshed.source !== 'oauth') return null;
    tokenInfo = refreshed;
  }
  const configuredAccountId = hintedAccountId || process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (configuredAccountId && oauthAccountId && configuredAccountId !== oauthAccountId) {
    throw new Error('cloudflare_oauth_account_id_mismatch');
  }
  const accountId = configuredAccountId || oauthAccountId || (await getAccountId());
  if (!accountId || !tokenInfo?.token) {
    return null;
  }

  return { accountId, token: tokenInfo.token, source: tokenInfo.source };
}

async function resolveCloudflareD1Credentials(accountIdHint?: string): Promise<{
  accountId: string;
  token: string;
  source: CloudflareApiToken['source'] | 'd1_env';
} | null> {
  const d1Token = process.env.CLOUDFLARE_D1_API_TOKEN?.trim();
  if (
    process.env.NODE_ENV === 'test' &&
    ((!accountIdHint?.trim() && !process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) ||
      (!d1Token && !process.env.CLOUDFLARE_API_TOKEN?.trim()))
  ) {
    return null;
  }
  const accountId =
    accountIdHint?.trim() || process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || (await getAccountId());
  if (d1Token && accountId) return { accountId, token: d1Token, source: 'd1_env' };
  return resolveCloudflareInventoryCredentials(accountIdHint);
}

export function shouldRefreshD1OAuthCredential(input: {
  status: number;
  source: CloudflareApiToken['source'] | 'd1_env';
  attempt: number;
}): boolean {
  return (
    input.source === 'oauth' &&
    input.attempt === 1 &&
    (input.status === 401 || input.status === 403)
  );
}

export function shouldRefreshCloudflareOAuthCredential(input: {
  status: number;
  errorCodes?: readonly number[];
  source: CloudflareApiToken['source'];
  attempt: number;
}): boolean {
  return (
    input.source === 'oauth' &&
    input.attempt === 1 &&
    (input.status === 401 || input.errorCodes?.includes(10_000) === true)
  );
}

export function assertCloudflareOAuthRefreshAccount(
  pinnedAccountId: string,
  whoamiOutput: string
): void {
  const authenticatedAccountIds = extractWranglerAccountIds(whoamiOutput);
  if (authenticatedAccountIds.length !== 1 || authenticatedAccountIds[0] !== pinnedAccountId) {
    throw new Error('cloudflare_oauth_account_id_mismatch_after_refresh');
  }
}

async function refreshPinnedCloudflareOAuthToken(
  accountId: string
): Promise<{ accountId: string; token: string; source: 'oauth' } | null> {
  if (process.env.CLOUDFLARE_API_TOKEN?.trim()) return null;
  const { stdout, stderr } = await wrangler(['whoami'], { timeout: 30_000 });
  assertCloudflareOAuthRefreshAccount(accountId, `${stdout}\n${stderr}`);
  const refreshed = await getCloudflareApiToken();
  if (!refreshed || refreshed.source !== 'oauth') return null;
  return { accountId, token: refreshed.token, source: 'oauth' };
}

async function listCloudflarePaginatedResourcesViaApi<T>(input: {
  path: string;
  label: string;
  normalizeRows: (rows: unknown) => T[];
  identityKey: (row: T) => string;
  perPage?: number;
}): Promise<T[] | null> {
  let credentials = await resolveCloudflareInventoryCredentials();
  if (!credentials) return null;

  const resources: T[] = [];
  const perPage = input.perPage ?? 1000;
  let page = 1;
  const seenIdentities = new Set<string>();
  let expectedTotalCount: number | undefined;
  let expectedTotalPages: number | undefined;
  let expectedPerPage: number | undefined;

  while (page <= CLOUDFLARE_INVENTORY_MAX_PAGES) {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/${input.path}`
    );
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));

    let apiResult:
      | CloudflareApiJsonResult<{
          success?: boolean;
          result?: unknown;
          errors?: CloudflareApiMessage[];
          result_info?: {
            count?: unknown;
            page?: unknown;
            per_page?: unknown;
            total_count?: unknown;
            total_pages?: unknown;
          };
        }>
      | undefined;
    for (let authAttempt = 1; authAttempt <= 2; authAttempt++) {
      apiResult = await requestCloudflareApiJson(
        url,
        {
          headers: {
            Authorization: `Bearer ${credentials.token}`,
          },
        },
        { label: `Cloudflare ${input.label}`, retryMode: 'read' }
      );
      const errorCodes = (apiResult.data.errors ?? []).flatMap((error) =>
        typeof error.code === 'number' ? [error.code] : []
      );
      if (
        shouldRefreshCloudflareOAuthCredential({
          status: apiResult.response.status,
          errorCodes,
          source: credentials.source,
          attempt: authAttempt,
        })
      ) {
        const refreshed = await refreshPinnedCloudflareOAuthToken(credentials.accountId);
        if (refreshed) {
          credentials = refreshed;
          continue;
        }
      }
      break;
    }
    if (!apiResult) throw new Error(`Cloudflare ${input.label} returned no response`);
    const { response, data: payload } = apiResult;
    if (!response.ok) {
      throw new Error(`Cloudflare ${input.label} failed (${response.status})`);
    }
    if (payload.success === false) {
      throw new Error(`Cloudflare ${input.label} returned an unsuccessful response`);
    }

    const rows = input.normalizeRows(payload.result);
    for (const row of rows) {
      const identity = input.identityKey(row);
      if (!identity || seenIdentities.has(identity)) {
        throw new Error(`Cloudflare ${input.label} returned a duplicate resource identity`);
      }
      seenIdentities.add(identity);
    }
    resources.push(...rows);

    const resultInfo = payload.result_info;
    const totalCount = resultInfo?.total_count;
    const totalPages = resultInfo?.total_pages;
    const responsePage = resultInfo?.page;
    const responsePerPage = resultInfo?.per_page;
    const validInteger = (value: unknown, minimum: number): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value >= minimum;
    if (responsePage !== undefined && !validInteger(responsePage, 1)) {
      throw new Error(`Cloudflare ${input.label} returned invalid page metadata`);
    }
    if (responsePerPage !== undefined && !validInteger(responsePerPage, 1)) {
      throw new Error(`Cloudflare ${input.label} returned invalid per-page metadata`);
    }
    if (totalCount !== undefined && !validInteger(totalCount, 0)) {
      throw new Error(`Cloudflare ${input.label} returned invalid total-count metadata`);
    }
    if (totalPages !== undefined && !validInteger(totalPages, 0)) {
      throw new Error(`Cloudflare ${input.label} returned invalid total-pages metadata`);
    }
    if (resultInfo?.count !== undefined && !validInteger(resultInfo.count, 0)) {
      throw new Error(`Cloudflare ${input.label} returned invalid count metadata`);
    }
    if (responsePage !== undefined && responsePage !== page) {
      throw new Error(`Cloudflare ${input.label} returned an unexpected page`);
    }
    if (
      page > 1 &&
      ((expectedTotalCount === undefined) !== (totalCount === undefined) ||
        (expectedTotalPages === undefined) !== (totalPages === undefined) ||
        (expectedPerPage === undefined) !== (responsePerPage === undefined))
    ) {
      throw new Error(`Cloudflare ${input.label} changed pagination metadata shape`);
    }
    if (expectedTotalCount !== undefined && totalCount !== expectedTotalCount) {
      throw new Error(`Cloudflare ${input.label} changed total count during pagination`);
    }
    if (expectedTotalPages !== undefined && totalPages !== expectedTotalPages) {
      throw new Error(`Cloudflare ${input.label} changed total pages during pagination`);
    }
    if (expectedPerPage !== undefined && responsePerPage !== expectedPerPage) {
      throw new Error(`Cloudflare ${input.label} changed page size during pagination`);
    }
    expectedTotalCount ??= totalCount;
    expectedTotalPages ??= totalPages;
    expectedPerPage ??= responsePerPage;
    if (typeof totalCount === 'number' && resources.length > totalCount) {
      throw new Error(`Cloudflare ${input.label} exceeded its declared total count`);
    }
    if (typeof totalCount === 'number' && resources.length === totalCount) {
      if (typeof totalPages === 'number' && page !== totalPages && totalPages !== 0) {
        throw new Error(`Cloudflare ${input.label} ended before its declared final page`);
      }
      return resources;
    }
    if (typeof totalPages === 'number' && page >= totalPages) {
      if (typeof totalCount === 'number') {
        throw new Error(`Cloudflare ${input.label} ended before its declared total count`);
      }
      return resources;
    }

    const authoritativePagination =
      typeof totalCount === 'number' || typeof totalPages === 'number';
    if (!authoritativePagination) {
      const effectivePerPage =
        typeof responsePerPage === 'number' && responsePerPage > 0 ? responsePerPage : perPage;
      if (rows.length < effectivePerPage) return resources;
    }
    if (rows.length === 0) {
      throw new Error(
        `Cloudflare ${input.label} pagination stopped before all resources were read`
      );
    }
    page++;
  }

  throw new Error(
    `Cloudflare ${input.label} exceeded the ${CLOUDFLARE_INVENTORY_MAX_PAGES}-page safety limit`
  );
}

function normalizeD1DatabaseRows(rows: unknown): D1DatabaseListRow[] {
  if (!Array.isArray(rows)) {
    throw new TypeError('D1 database list was not an array');
  }

  return rows.map((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new TypeError(`D1 database list row ${index} was not an object`);
    }

    const { name, uuid } = row as { name?: unknown; uuid?: unknown };
    if (
      typeof name !== 'string' ||
      name.trim().length === 0 ||
      typeof uuid !== 'string' ||
      uuid.trim().length === 0
    ) {
      throw new TypeError(`D1 database list row ${index} did not contain a name and UUID`);
    }

    return { name: name.trim(), uuid: uuid.trim() };
  });
}

function assertUniqueNamedResourceInventory<T>(input: {
  rows: T[];
  label: string;
  name: (row: T) => string;
  id: (row: T) => string;
}): T[] {
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const row of input.rows) {
    const name = input.name(row);
    const id = input.id(row);
    if (names.has(name)) throw new Error(`${input.label} contained a duplicate resource name`);
    if (ids.has(id)) throw new Error(`${input.label} contained a duplicate immutable resource ID`);
    names.add(name);
    ids.add(id);
  }
  return input.rows;
}

export function parseD1DatabaseListOutput(stdout: string): D1DatabaseListRow[] {
  return assertUniqueNamedResourceInventory({
    rows: parseValidatedJsonOutput(
      stdout,
      normalizeD1DatabaseRows,
      'Wrangler output did not contain a valid D1 database list'
    ),
    label: 'Wrangler D1 database inventory',
    name: (row) => row.name,
    id: (row) => row.uuid,
  });
}

async function listD1DatabasesViaApi(): Promise<D1DatabaseListRow[] | null> {
  return listCloudflarePaginatedResourcesViaApi({
    path: 'd1/database',
    label: 'D1 database list',
    normalizeRows: normalizeD1DatabaseRows,
    identityKey: (row) => row.uuid,
  });
}

/**
 * List all D1 databases
 * @throws Error if wrangler command fails (caller should handle)
 */
export async function listD1Databases(): Promise<Array<{ name: string; uuid: string }>> {
  let apiError: unknown;
  try {
    const apiDatabases = await listD1DatabasesViaApi();
    if (apiDatabases) {
      return assertUniqueNamedResourceInventory({
        rows: apiDatabases,
        label: 'Cloudflare API D1 database inventory',
        name: (row) => row.name,
        id: (row) => row.uuid,
      });
    }
  } catch (error) {
    apiError = error;
  }

  try {
    const { stdout, stderr } = await wrangler(['d1', 'list', '--json']);

    // Check for auth errors
    if (stderr && stderr.includes('not logged in')) {
      throw new Error('Not logged in to Cloudflare. Run: wrangler login');
    }

    return parseD1DatabaseListOutput(stdout);
  } catch (error) {
    if (apiError) {
      const apiMessage = describeInventoryError(apiError, 'unknown API error');
      const wranglerMessage = describeInventoryError(error, 'unknown Wrangler error');
      throw new Error(
        `Failed to list D1 databases via the Cloudflare API (${apiMessage}) and Wrangler (${wranglerMessage})`
      );
    }
    if (error instanceof SyntaxError) {
      throw new Error('Failed to parse D1 database list - wrangler output was not valid JSON');
    }
    throw error;
  }
}

/**
 * Check if a D1 database exists
 */
export async function d1DatabaseExists(name: string): Promise<{ exists: boolean; id?: string }> {
  const databases = await listD1Databases();
  const db = databases.find((d) => d.name === name);
  return { exists: !!db, id: db?.uuid };
}

/**
 * Create a D1 database
 */
/** Valid D1 location values (whitelist for security) */
const VALID_D1_LOCATIONS = ['auto', 'wnam', 'enam', 'weur', 'eeur', 'apac', 'oc'] as const;
/** Valid D1 jurisdiction values (whitelist for security) */
const VALID_D1_JURISDICTIONS = ['none', 'eu'] as const;

/**
 * Validate D1 location value against whitelist
 */
function isValidD1Location(value: unknown): value is D1Location {
  return typeof value === 'string' && VALID_D1_LOCATIONS.includes(value as D1Location);
}

/**
 * Validate D1 jurisdiction value against whitelist
 */
function isValidD1Jurisdiction(value: unknown): value is D1Jurisdiction {
  return typeof value === 'string' && VALID_D1_JURISDICTIONS.includes(value as D1Jurisdiction);
}

function extractD1CreateResponseId(output: string): string | undefined {
  return output.match(
    /(?:"(?:uuid|database_id|id)"|\b(?:uuid|database_id|id)\b)\s*[:=]\s*"?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})"?/iu
  )?.[1];
}

export async function createD1Database(
  name: string,
  options?: D1CreateOptions,
  behavior: ProvisioningCreateBehavior = {}
): Promise<{ id: string; name: string }> {
  // Check if already exists
  const existing = await d1DatabaseExists(name);
  if (existing.exists && existing.id) {
    if (behavior.allowExisting === false) {
      throw new Error(`D1 database ${name} already exists outside this provisioning attempt`);
    }
    if (behavior.expectedExistingId && behavior.expectedExistingId !== existing.id) {
      throw new Error(`D1 database ${name} does not match the recorded provisioning resource`);
    }
    return { id: existing.id, name };
  }
  if (behavior.recordedState === 'created') {
    throw new Error(`D1 database ${name} recorded by provisioning is missing`);
  }
  if (behavior.recordedState === 'identified') {
    if (!behavior.expectedExistingId) {
      throw new Error(`D1 database ${name} identified checkpoint omitted its immutable ID`);
    }
    return waitForProviderResourceVisible({
      resourceDescription: `D1 database ${name}`,
      expectedId: behavior.expectedExistingId,
      findExisting: async () => {
        const reconciled = await d1DatabaseExists(name);
        return reconciled.exists && reconciled.id ? { id: reconciled.id, name } : null;
      },
    });
  }
  if (behavior.recordedState === 'create_issued') {
    throw new Error(
      `D1 database ${name} has an interrupted create_issued checkpoint without immutable ` +
        'provider evidence. Setup will not reissue the create; inspect Cloudflare and recover explicitly.'
    );
  }

  // Build command args with optional location/jurisdiction
  const args = ['d1', 'create', name];

  // Jurisdiction takes precedence over location (per Cloudflare docs)
  // Security: Validate against whitelist before passing to wrangler
  if (
    options?.jurisdiction &&
    isValidD1Jurisdiction(options.jurisdiction) &&
    options.jurisdiction !== 'none'
  ) {
    args.push(`--jurisdiction=${options.jurisdiction}`);
  } else if (
    options?.location &&
    isValidD1Location(options.location) &&
    options.location !== 'auto'
  ) {
    args.push(`--location=${options.location}`);
  }

  await behavior.onCreateIssued?.();

  // Create new database. A provider commit can outlive a lost Wrangler response, so reconcile
  // by exact deterministic name before deciding the operation failed.
  let stdout: string;
  try {
    ({ stdout } = await wranglerCreateWithDefiniteRejectionRetry(args));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isAmbiguousCloudflareMutationFailure(message)) {
      return throwDefiniteProvisioningCreateFailure(behavior, error, `D1 database ${name}`);
    }
    const responseId = extractD1CreateResponseId(message);
    if (!responseId) {
      throw new Error(
        `D1 database ${name} creation outcome is ambiguous and Cloudflare returned no immutable ` +
          'database ID. Setup will not adopt a same-name database; inspect or delete it before retrying.',
        { cause: error }
      );
    }
    await behavior.onProviderIdentityIdentified?.({ id: responseId });
    return waitForProviderResourceVisible({
      resourceDescription: `D1 database ${name}`,
      createError: error,
      expectedId: responseId,
      findExisting: async () => {
        const reconciled = await d1DatabaseExists(name);
        return reconciled.exists && reconciled.id ? { id: reconciled.id, name } : null;
      },
    });
  }

  // Wrangler output is useful evidence, but only provider inventory visibility makes the resource
  // safe to journal and use in generated bindings. A delayed list must not trigger another create.
  const createdId = extractD1CreateResponseId(stdout);
  if (!createdId) {
    throw new Error(
      `D1 database ${name} create succeeded but returned no immutable database ID. ` +
        'Setup will not adopt a same-name database; inspect the provider inventory before retrying.'
    );
  }
  await behavior.onProviderIdentityIdentified?.({ id: createdId });
  return waitForProviderResourceVisible({
    resourceDescription: `D1 database ${name}`,
    expectedId: createdId,
    findExisting: async () => {
      const reconciled = await d1DatabaseExists(name);
      return reconciled.exists && reconciled.id ? { id: reconciled.id, name } : null;
    },
  });
}

export async function putKVKeyByNamespaceId(
  namespaceId: string,
  key: string,
  value: string,
  options: { expirationTtl?: number; onProgress?: (message: string) => void } = {}
): Promise<void> {
  await withPrivateTemporaryTextFile(value, async (valuePath) => {
    const oauthRefresh: WranglerOAuthRefreshState = { attempted: false };
    const args = [
      'kv',
      'key',
      'put',
      key,
      '--path',
      valuePath,
      '--namespace-id',
      namespaceId,
      '--remote',
    ];
    if (options.expirationTtl !== undefined) {
      args.push('--ttl', String(options.expirationTtl));
    }
    for (let attempt = 1; attempt <= D1_MIGRATION_AUTH_MAX_ATTEMPTS; attempt++) {
      try {
        await wrangler(args, { timeout: 60000 });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const maxAttempts = isD1AuthenticationError(message)
          ? D1_MIGRATION_AUTH_MAX_ATTEMPTS
          : D1_MIGRATION_MAX_ATTEMPTS;
        if (attempt >= maxAttempts || !isTransientD1MigrationError(message)) throw error;
        await refreshWranglerOAuthAfterCode10000(message, oauthRefresh);
        const delayMs = d1MigrationRetryDelayMs(attempt);
        options.onProgress?.(
          `  ⚠️ Transient Cloudflare KV write failure for ${key} ` +
            `(attempt ${attempt}/${maxAttempts}); retrying in ${Math.round(delayMs / 1000)}s`
        );
        if (delayMs > 0) await sleep(delayMs);
      }
    }
    throw new Error('KV write retry loop exited unexpectedly');
  });
}

export async function getKVKeyByNamespaceId(namespaceId: string, key: string): Promise<string> {
  const { stdout } = await wrangler(
    ['kv', 'key', 'get', key, '--namespace-id', namespaceId, '--remote'],
    {
      timeout: 60000,
    }
  );
  return stdout;
}

interface KVKeyListRow {
  name: string;
}

function normalizeKVKeyListRows(rows: unknown): KVKeyListRow[] {
  if (!Array.isArray(rows)) {
    throw new TypeError('KV key list was not an array');
  }
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new TypeError(`KV key list row ${index} was not an object`);
    }
    const name = (row as { name?: unknown }).name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(`KV key list row ${index} did not contain a name`);
    }
    return { name };
  });
}

export function parseKVKeyListOutput(stdout: string): KVKeyListRow[] {
  return parseValidatedJsonOutput(
    stdout,
    normalizeKVKeyListRows,
    'Wrangler output did not contain a valid KV key list'
  );
}

export async function getOptionalKVKeyByNamespaceId(
  namespaceId: string,
  key: string
): Promise<string | null> {
  const { stdout } = await wrangler(
    ['kv', 'key', 'list', '--namespace-id', namespaceId, '--prefix', key, '--remote'],
    { timeout: 60000 }
  );
  const exactMatches = parseKVKeyListOutput(stdout).filter((row) => row.name === key);
  if (exactMatches.length === 0) return null;
  if (exactMatches.length !== 1) {
    throw new Error('Cloudflare KV returned duplicate exact keys');
  }
  return getKVKeyByNamespaceId(namespaceId, key);
}

/**
 * Delete a D1 database
 */
function isCloudflareResourceAlreadyAbsent(error: unknown): boolean {
  const detail = [
    error instanceof Error ? error.message : String(error),
    typeof (error as { stderr?: unknown })?.stderr === 'string'
      ? (error as { stderr: string }).stderr
      : '',
    typeof (error as { stdout?: unknown })?.stdout === 'string'
      ? (error as { stdout: string }).stdout
      : '',
  ]
    .join('\n')
    .toLowerCase();
  return /(?:not found|does not exist|could not find|no such (?:database|queue|resource))/u.test(
    detail
  );
}

type ExactResourceDeleteResult =
  | { status: 'deleted' }
  | { status: 'already_absent' }
  | { status: 'failed'; error: string };

type CloudflareDeletionCredentials = { accountId: string; token: string };

function normalizeDeletionResourceId(id: string, label: string): string {
  const normalized = id.trim();
  if (!normalized || normalized !== id || normalized.length > 256) {
    throw new Error(`${label} immutable resource ID is invalid`);
  }
  return normalized;
}

async function deleteCloudflareAccountResourceById(input: {
  credentials: CloudflareDeletionCredentials;
  resourcePath: string;
  resourceId: string;
  label: string;
}): Promise<ExactResourceDeleteResult> {
  try {
    const resourceId = normalizeDeletionResourceId(input.resourceId, input.label);
    const { response, data } = await requestCloudflareApiJson<{
      success?: boolean;
      errors?: CloudflareApiMessage[];
      messages?: CloudflareApiMessage[];
    }>(
      `https://api.cloudflare.com/client/v4/accounts/${input.credentials.accountId}/${input.resourcePath}/${encodeURIComponent(resourceId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${input.credentials.token}` },
      },
      {
        label: input.label,
        retryMode: 'idempotent_mutation',
        maxAttempts: 7,
        isRetryableResponse: (_response, payload) =>
          (payload.errors ?? []).some(
            (error) => error.code === 971 || /throttl|too many requests/iu.test(error.message ?? '')
          ),
      }
    );
    if (response.status === 404) return { status: 'already_absent' };
    if (response.ok && data.success !== false) return { status: 'deleted' };
    const detail = formatCloudflareApiMessages(data);
    return {
      status: 'failed',
      error: `${input.label} failed (${response.status})${detail ? `: ${detail}` : ''}`,
    };
  } catch (error) {
    return { status: 'failed', error: sanitizeError(error) };
  }
}

async function deleteD1DatabaseWithResult(
  databaseId: string,
  credentials?: CloudflareDeletionCredentials
): Promise<ExactResourceDeleteResult> {
  let resolved = credentials;
  try {
    resolved ??= (await resolveCloudflareD1Credentials()) ?? undefined;
  } catch (error) {
    return { status: 'failed', error: sanitizeError(error) };
  }
  if (!resolved) {
    return { status: 'failed', error: 'Cloudflare D1 API credentials are unavailable' };
  }
  return deleteCloudflareAccountResourceById({
    credentials: resolved,
    resourcePath: 'd1/database',
    resourceId: databaseId,
    label: 'Cloudflare D1 database delete',
  });
}

/** Delete a D1 database by its immutable Cloudflare database ID. */
export async function deleteD1Database(databaseId: string): Promise<boolean> {
  const result = await deleteD1DatabaseWithResult(databaseId);
  return result.status !== 'failed';
}

/**
 * Get D1 database info (size, tables, region, etc.)
 */
export interface D1Info {
  name: string;
  createdAt: string | null;
  databaseSize: string | null;
  numTables: number | null;
  region: string | null;
}

export async function getD1Info(name: string): Promise<D1Info> {
  try {
    const { stdout } = await wrangler(['d1', 'info', name]);

    // Parse the table output
    const createdAtMatch = stdout.match(/created_at\s*│\s*(\S+)/u);
    const sizeMatch = stdout.match(/database_size\s*│\s*([^\n│]+)/u);
    const tablesMatch = stdout.match(/num_tables\s*│\s*(\d+)/u);
    const regionMatch = stdout.match(/running_in_region\s*│\s*(\S+)/u);

    return {
      name,
      createdAt: createdAtMatch?.[1]?.trim() || null,
      databaseSize: sizeMatch?.[1]?.trim() || null,
      numTables: tablesMatch ? parseInt(tablesMatch[1], 10) : null,
      region: regionMatch?.[1]?.trim() || null,
    };
  } catch {
    return {
      name,
      createdAt: null,
      databaseSize: null,
      numTables: null,
      region: null,
    };
  }
}

/**
 * Execute D1 migration SQL file
 */
export async function executeD1Migration(
  dbName: string,
  sqlFilePath: string,
  onProgress?: (message: string) => void,
  options: {
    transactionSuffixSql?: string;
    verifyCommitted?: () => Promise<boolean>;
  } = {}
): Promise<{ success: boolean; error?: string }> {
  try {
    onProgress?.(`  Executing migration: ${sqlFilePath}`);
    const { readFileSync } = await import('node:fs');
    const renderedSql = renderPortableMigrationSql(readFileSync(sqlFilePath, 'utf-8'), 'sqlite');
    const transactionSql = options.transactionSuffixSql
      ? `${renderedSql.trimEnd()}\n\n${options.transactionSuffixSql}\n`
      : renderedSql;
    return await withPrivateTemporaryTextFile(
      transactionSql,
      async (tempSqlPath) => {
        const oauthRefresh: WranglerOAuthRefreshState = { attempted: false };
        for (let attempt = 1; attempt <= D1_MIGRATION_AUTH_MAX_ATTEMPTS; attempt++) {
          try {
            await wrangler(['d1', 'execute', dbName, '--remote', '--file', tempSqlPath, '--yes'], {
              timeout: D1_MIGRATION_EXECUTE_TIMEOUT_MS,
            });
            return { success: true };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (options.verifyCommitted) {
              for (
                let verificationAttempt = 1;
                verificationAttempt <= D1_MIGRATION_AUTH_MAX_ATTEMPTS;
                verificationAttempt++
              ) {
                try {
                  if (await options.verifyCommitted()) return { success: true };
                  break;
                } catch (verificationError) {
                  const verificationErrorMessage =
                    verificationError instanceof Error
                      ? verificationError.message
                      : String(verificationError);
                  const verificationMaxAttempts = isD1AuthenticationError(verificationErrorMessage)
                    ? D1_MIGRATION_AUTH_MAX_ATTEMPTS
                    : D1_MIGRATION_MAX_ATTEMPTS;
                  const canRetryVerification =
                    verificationAttempt < verificationMaxAttempts &&
                    isTransientD1MigrationError(verificationErrorMessage);
                  if (!canRetryVerification) {
                    return {
                      success: false,
                      error:
                        `${message}; could not determine whether the migration committed: ` +
                        verificationErrorMessage,
                    };
                  }

                  const verificationDelayMs = d1MigrationRetryDelayMs(verificationAttempt);
                  onProgress?.(
                    `  ⚠️ Transient D1 commit verification failure for ${basename(sqlFilePath)} ` +
                      `(attempt ${verificationAttempt}/${verificationMaxAttempts}); ` +
                      `retrying verification in ${Math.round(verificationDelayMs / 1000)}s`
                  );
                  if (verificationDelayMs > 0) {
                    await sleep(verificationDelayMs);
                  }
                }
              }
            }
            const maxAttempts = isD1AuthenticationError(message)
              ? D1_MIGRATION_AUTH_MAX_ATTEMPTS
              : D1_MIGRATION_MAX_ATTEMPTS;
            const canRetry = attempt < maxAttempts && isTransientD1MigrationError(message);
            if (!canRetry) {
              return { success: false, error: message };
            }

            await refreshWranglerOAuthAfterCode10000(message, oauthRefresh);

            const delayMs = d1MigrationRetryDelayMs(attempt);
            const failureKind = isD1AuthenticationError(message)
              ? 'Transient Cloudflare D1 authentication failure'
              : 'Transient D1 migration failure';
            onProgress?.(
              `  ⚠️ ${failureKind} for ${basename(sqlFilePath)} ` +
                `(attempt ${attempt}/${maxAttempts}); retrying in ${Math.round(delayMs / 1000)}s`
            );
            if (delayMs > 0) {
              await sleep(delayMs);
            }
          }
        }
        return { success: false, error: 'D1 migration retry loop exited unexpectedly' };
      },
      { directoryPrefix: 'authrim-migration-', filename: 'migration.sql' }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface D1ExecuteCommandResult {
  stdout: string;
  stderr: string;
}

export interface D1BatchStatement {
  sql: string;
  params?: readonly unknown[];
}

export interface D1BatchExecutionResult {
  success: true;
  results?: unknown[];
  meta?: unknown;
}

export interface D1BatchExecutionOptions {
  accountId?: string;
}

export async function executeD1Batch(
  databaseId: string,
  batch: readonly D1BatchStatement[],
  options: D1BatchExecutionOptions = {}
): Promise<D1BatchExecutionResult[]> {
  if (!/^[a-fA-F0-9-]{16,64}$/u.test(databaseId)) {
    throw new Error('invalid_d1_database_id');
  }
  if (batch.length === 0 || batch.length > 512) {
    throw new Error('invalid_d1_batch_size');
  }
  const normalized = batch.map((statement) => {
    if (!statement.sql.trim() || statement.sql.length > 100_000) {
      throw new Error('invalid_d1_batch_statement');
    }
    return {
      sql: statement.sql,
      ...(statement.params ? { params: [...statement.params] } : {}),
    };
  });
  const body = JSON.stringify({ batch: normalized });
  if (Buffer.byteLength(body, 'utf8') > 4 * 1024 * 1024) {
    throw new Error('d1_batch_payload_too_large');
  }
  let credentials = await resolveCloudflareD1Credentials(options.accountId);
  if (!credentials) throw new Error('cloudflare_api_credentials_required');
  let response: Response | undefined;
  let payload: { success?: unknown; result?: unknown } = {};
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await requestCloudflareApiJson<{ success?: unknown; result?: unknown }>(
        `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${databaseId}/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
          },
          body,
        },
        { label: 'Cloudflare D1 batch', retryMode: 'non_idempotent_mutation' }
      );
      response = result.response;
      payload = result.data;
    } catch (error) {
      if (
        error instanceof CloudflareApiRequestInterruptedError &&
        error.reason === 'caller_abort'
      ) {
        throw new Error('cloudflare_d1_batch_aborted');
      }
      // D1 query is a POST and may have committed before a transport failure. The deployment
      // coordinator must reconcile the durable lease/state before deciding whether to issue it again.
      throw new Error('cloudflare_d1_batch_ambiguous');
    }
    if (response.ok) break;
    if (
      !shouldRefreshD1OAuthCredential({
        status: response.status,
        source: credentials.source,
        attempt,
      })
    ) {
      if (response.status === 408 || response.status === 425 || response.status >= 500) {
        throw new Error(`cloudflare_d1_batch_ambiguous:${response.status}`);
      }
      throw new Error(`cloudflare_d1_batch_failed:${response.status}`);
    }
    await wrangler(['whoami'], { timeout: 30_000 });
    const refreshed = await resolveCloudflareD1Credentials(options.accountId);
    if (!refreshed || refreshed.source !== 'oauth') {
      throw new Error(`cloudflare_d1_batch_failed:${response.status}`);
    }
    credentials = refreshed;
  }
  if (!response?.ok) throw new Error(`cloudflare_d1_batch_failed:${response?.status ?? 0}`);
  if (
    payload.success !== true ||
    !Array.isArray(payload.result) ||
    payload.result.length !== normalized.length ||
    payload.result.some(
      (result) =>
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        (result as { success?: unknown }).success !== true
    )
  ) {
    throw new Error('cloudflare_d1_batch_unsuccessful');
  }
  return payload.result as D1BatchExecutionResult[];
}

export async function executeD1Command(
  dbName: string,
  sql: string,
  options: { json?: boolean; timeout?: number; onProgress?: (message: string) => void } = {}
): Promise<D1ExecuteCommandResult> {
  const args = [
    'd1',
    'execute',
    dbName,
    '--remote',
    '--yes',
    '--command',
    sql,
    ...(options.json ? ['--json'] : []),
  ];
  const oauthRefresh: WranglerOAuthRefreshState = { attempted: false };
  for (let attempt = 1; attempt <= D1_MIGRATION_AUTH_MAX_ATTEMPTS; attempt++) {
    try {
      return await wrangler(args, {
        timeout: options.timeout ?? D1_MIGRATION_EXECUTE_TIMEOUT_MS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const maxAttempts = isD1AuthenticationError(message)
        ? D1_MIGRATION_AUTH_MAX_ATTEMPTS
        : D1_MIGRATION_MAX_ATTEMPTS;
      const canRetry =
        attempt < maxAttempts && (isD1AuthenticationError(message) || isD1RateLimitError(message));
      if (!canRetry) throw error;

      await refreshWranglerOAuthAfterCode10000(message, oauthRefresh);

      const delayMs = d1MigrationRetryDelayMs(attempt);
      const failureKind = isD1AuthenticationError(message)
        ? 'Transient Cloudflare D1 authentication failure'
        : 'Cloudflare D1 rate limit';
      options.onProgress?.(
        `  ⚠️ ${failureKind} for ${dbName} ` +
          `(attempt ${attempt}/${maxAttempts}); ` +
          `retrying in ${Math.round(delayMs / 1000)}s`
      );
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw new Error('D1 command retry loop exited unexpectedly');
}

function normalizeD1QueryRows<T extends Record<string, unknown>>(payload: unknown): T[] {
  let queryResults = payload;
  if (!Array.isArray(payload) && payload && typeof payload === 'object' && 'result' in payload) {
    const envelope = payload as { success?: unknown; result?: unknown };
    if (envelope.success !== true) {
      throw new TypeError('Cloudflare D1 query response was not successful');
    }
    queryResults = envelope.result;
  }

  const entries = Array.isArray(queryResults) ? queryResults : [queryResults];
  return entries.flatMap((entry, entryIndex) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`D1 result entry ${entryIndex} was not an object`);
    }
    if ((entry as { success?: unknown }).success === false) {
      throw new TypeError(`D1 result entry ${entryIndex} was not successful`);
    }
    const results = (entry as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      throw new TypeError(`D1 result entry ${entryIndex} did not contain a results array`);
    }
    return results.map((row, rowIndex) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new TypeError(`D1 result row ${rowIndex} was not an object`);
      }
      return row as T;
    });
  });
}

export function parseD1RowsFromWranglerJson<T extends Record<string, unknown>>(
  output: string
): T[] {
  return parseValidatedJsonOutput(
    output,
    normalizeD1QueryRows<T>,
    'Wrangler output did not contain a valid D1 query result'
  );
}

function parseD1RowsFromWranglerResult<T extends Record<string, unknown>>(
  result: D1ExecuteCommandResult
): T[] {
  const candidates = Array.from(
    new Set(
      [result.stdout, result.stderr, [result.stdout, result.stderr].filter(Boolean).join('\n')]
        .map((output) => output.trim())
        .filter(Boolean)
    )
  );

  for (const candidate of candidates) {
    try {
      return parseD1RowsFromWranglerJson<T>(candidate);
    } catch {
      // Wrangler has emitted JSON on both stdout and stderr across released versions.
    }
  }

  throw new SyntaxError('Wrangler stdout and stderr did not contain a valid D1 query result');
}

export async function queryD1Rows<T extends Record<string, unknown>>(
  dbName: string,
  sql: string
): Promise<T[]> {
  let wranglerError: unknown;
  try {
    const result = await executeD1Command(dbName, sql, { json: true });
    return parseD1RowsFromWranglerResult<T>(result);
  } catch (error) {
    wranglerError = error;
  }

  try {
    const apiRows = await queryD1RowsViaApi<T>(dbName, sql);
    if (apiRows) return apiRows;
  } catch (apiError) {
    const wranglerMessage = describeInventoryError(wranglerError, 'unknown Wrangler error');
    const apiMessage = describeInventoryError(apiError, 'unknown API error');
    throw new Error(
      `Could not query D1 via Wrangler (${wranglerMessage}) or the Cloudflare API (${apiMessage})`
    );
  }

  throw wranglerError;
}

async function queryD1RowsViaApi<T extends Record<string, unknown>>(
  databaseIdentifier: string,
  sql: string
): Promise<T[] | null> {
  const credentials = await resolveCloudflareInventoryCredentials();
  if (!credentials) return null;

  const databases = await listD1DatabasesViaApi();
  const databaseById = databases?.find((candidate) => candidate.uuid === databaseIdentifier);
  const databasesByName = databaseById
    ? []
    : (databases?.filter((candidate) => candidate.name === databaseIdentifier) ?? []);
  if (!databaseById && databasesByName.length > 1) {
    throw new Error(`Cloudflare D1 database name ${databaseIdentifier} is ambiguous`);
  }
  const database = databaseById ?? databasesByName[0];
  if (!database) {
    throw new Error(`Cloudflare D1 database ${databaseIdentifier} was not found`);
  }

  const { response, data } = await requestCloudflareApiJson<unknown>(
    new URL(
      `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${database.uuid}/query`
    ),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql }),
    },
    { label: 'Cloudflare D1 read query', retryMode: 'read' }
  );
  if (!response.ok) {
    throw new Error(`Cloudflare D1 query failed (${response.status})`);
  }

  return normalizeD1QueryRows<T>(data);
}

/**
 * Ensure the authrim_migrations tracking table exists in the target database.
 * Retries provider transients, tolerates only the expected legacy-column duplicates,
 * and throws with the provider detail when preparation cannot complete.
 */
async function ensureMigrationsTable(
  dbName: string,
  onProgress?: (message: string) => void
): Promise<void> {
  const createResult = await executeD1PreparationCommand(
    dbName,
    AUTHRIM_MIGRATIONS_TABLE_SQL,
    onProgress
  );
  if (!createResult.success) {
    const message = createResult.error ?? 'unknown Cloudflare D1 error';
    onProgress?.(`  ❌ Could not prepare migration tracking for ${dbName}: ${message}`);
    throw new Error(`Could not prepare migration tracking for ${dbName}: ${message}`);
  }

  for (const sql of AUTHRIM_MIGRATIONS_COLUMN_ALTERS) {
    const alterResult = await executeD1PreparationCommand(dbName, sql, onProgress);
    if (alterResult.success) continue;
    const message = alterResult.error ?? 'unknown Cloudflare D1 error';
    if (isExpectedMigrationTrackingColumnError(message)) {
      continue;
    }
    onProgress?.(`  ❌ Could not update migration tracking for ${dbName}: ${message}`);
    throw new Error(`Could not update migration tracking for ${dbName}: ${message}`);
  }
}

/**
 * Return the set of migration filenames already recorded in authrim_migrations.
 * Errors propagate so callers never mistake an unreadable history for a new database.
 */
async function getAppliedMigrations(dbName: string): Promise<Set<string>> {
  const rows = await getAppliedMigrationRows(dbName);
  return new Set(rows.map((r) => r.filename));
}

type AppliedMigrationRow = AuthrimMigrationHistoryRow;

function validateAppliedMigrationRows(rows: AppliedMigrationRow[]): AppliedMigrationRow[] {
  return validateAuthrimMigrationHistoryRows(rows);
}

async function getAppliedMigrationRows(
  dbName: string,
  onProgress?: (message: string) => void
): Promise<AppliedMigrationRow[]> {
  await ensureMigrationsTable(dbName, onProgress);

  let apiError: unknown;
  try {
    const apiRows = await queryD1RowsViaApi<AppliedMigrationRow>(
      dbName,
      AUTHRIM_MIGRATION_HISTORY_SQL
    );
    if (apiRows) {
      return validateAppliedMigrationRows(apiRows);
    }
  } catch (error) {
    apiError = error;
  }

  try {
    const result = await executeD1Command(dbName, AUTHRIM_MIGRATION_HISTORY_SQL, { json: true });
    return validateAppliedMigrationRows(parseD1RowsFromWranglerResult<AppliedMigrationRow>(result));
  } catch (error) {
    if (apiError) {
      const apiMessage = describeInventoryError(apiError, 'unknown API error');
      const wranglerMessage = describeInventoryError(error, 'unknown Wrangler error');
      throw new Error(
        `Could not query migration history via the Cloudflare API (${apiMessage}) or Wrangler (${wranglerMessage})`
      );
    }
    throw error;
  }
}

function extractMigrationVersion(filename: string): number {
  const match = filename.match(/^(\d+)_/u);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export async function validateD1MigrationVersion(
  dbName: string,
  expectedVersion: number
): Promise<{ success: boolean; latestVersion: number; error?: string }> {
  try {
    const applied = await getAppliedMigrations(dbName);
    const latestVersion = Math.max(0, ...Array.from(applied).map(extractMigrationVersion));
    if (latestVersion < expectedVersion) {
      return {
        success: false,
        latestVersion,
        error: `D1 database ${dbName} migration version ${latestVersion} is below expected ${expectedVersion}`,
      };
    }
    return { success: true, latestVersion };
  } catch (error) {
    return {
      success: false,
      latestVersion: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Record a migration filename as applied.
 */
export function buildRecordMigrationSql(filename: string, appliedAt = Date.now()): string {
  const escapedFilename = filename.replace(/'/g, "''");
  return `INSERT INTO authrim_migrations (filename, checksum, applied_at, execution_time_ms, setup_version, tool_version)
SELECT '${escapedFilename}', '', ${appliedAt}, NULL, NULL, NULL
WHERE NOT EXISTS (
  SELECT 1
  FROM authrim_migrations
  WHERE filename = '${escapedFilename}'
);`;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

export function buildLegacyMigrationChecksumBackfillSql(
  files: ReadonlyArray<{ path: string; checksum: string }>
): string {
  return files
    .map(
      (file) =>
        `UPDATE authrim_migrations SET checksum = '${escapeSqlString(file.checksum)}' ` +
        `WHERE filename = '${escapeSqlString(file.path)}' AND (checksum IS NULL OR checksum = '');`
    )
    .join('\n');
}

export function collectManifestMigrationChecksumEvidence(
  files: ReadonlyArray<{
    path: string;
    checksum: string;
    supersedes?: ReadonlyArray<{ path: string; checksum: string }>;
  }>
): Array<{ path: string; checksum: string }> {
  const evidence = new Map<string, string>();
  for (const file of files) {
    for (const candidate of [file, ...(file.supersedes ?? [])]) {
      const existing = evidence.get(candidate.path);
      if (existing && existing !== candidate.checksum) {
        throw new Error(`Conflicting release manifest checksums: ${candidate.path}`);
      }
      evidence.set(candidate.path, candidate.checksum);
    }
  }
  return [...evidence].map(([path, checksum]) => ({ path, checksum }));
}

async function backfillLegacyMigrationChecksums(
  dbName: string,
  manifestFiles: ReadonlyArray<{
    path: string;
    checksum: string;
    supersedes?: ReadonlyArray<{ path: string; checksum: string }>;
  }>,
  onProgress?: (message: string) => void
): Promise<number> {
  const rows = await getAppliedMigrationRows(dbName);
  const legacyFilenames = new Set(
    rows
      .filter((row) => row.checksum === null || row.checksum === undefined || row.checksum === '')
      .map((row) => row.filename)
  );
  const backfills = collectManifestMigrationChecksumEvidence(manifestFiles).filter((file) =>
    legacyFilenames.has(file.path)
  );
  if (backfills.length === 0) return 0;
  await executeD1Command(dbName, buildLegacyMigrationChecksumBackfillSql(backfills), {
    onProgress,
  });
  return backfills.length;
}

function buildRecordMigrationWithChecksumSql(input: {
  filename: string;
  checksum: string;
  appliedAt?: number;
  executionTimeMs?: number | null;
  setupVersion?: string | null;
  toolVersion?: string | null;
}): string {
  const appliedAt =
    input.appliedAt === undefined
      ? "CAST(strftime('%s', 'now') AS INTEGER) * 1000"
      : String(input.appliedAt);
  const executionTimeMs = Number.isFinite(input.executionTimeMs ?? Number.NaN)
    ? String(Math.max(0, Math.round(input.executionTimeMs ?? 0)))
    : 'NULL';
  const setupVersion = input.setupVersion ? `'${escapeSqlString(input.setupVersion)}'` : 'NULL';
  const toolVersion = input.toolVersion ? `'${escapeSqlString(input.toolVersion)}'` : 'NULL';
  return `INSERT INTO authrim_migrations (filename, checksum, applied_at, execution_time_ms, setup_version, tool_version)
SELECT '${escapeSqlString(input.filename)}', '${escapeSqlString(input.checksum)}', ${appliedAt}, ${executionTimeMs}, ${setupVersion}, ${toolVersion}
WHERE NOT EXISTS (
  SELECT 1
  FROM authrim_migrations
  WHERE filename = '${escapeSqlString(input.filename)}'
);`;
}

export function calculateD1MigrationChecksum(sqlFilePath: string): string {
  const renderedSql = renderPortableMigrationSql(readFileSync(sqlFilePath, 'utf-8'), 'sqlite');
  return createHash('sha256').update(renderedSql).digest('hex');
}

const CORE_DB_EXCLUDED_MIGRATION_DIRS = new Set(['admin', 'archive', 'external', 'pii']);

export interface ListD1MigrationOptions {
  excludeTopLevelDirectories?: ReadonlySet<string>;
  manifestFiles?: ReadonlyArray<{
    path: string;
    checksum: string;
    supersedes?: ReadonlyArray<{ path: string; checksum: string }>;
  }>;
  /** Show a consolidated release bundle as applied when every superseded draft is applied. */
  materializeSuperseded?: boolean;
}

export interface RunD1MigrationOptions extends ListD1MigrationOptions {
  logSummaryLimit?: number;
  onlyFiles?: ReadonlySet<string>;
  releaseVersion?: string;
  /** Backfill pre-checksum history only when files came from a published release manifest. */
  backfillLegacyChecksums?: boolean;
}

export function listD1MigrationSqlFiles(
  migrationsDir: string,
  options: ListD1MigrationOptions = {}
): string[] {
  const files: string[] = [];

  function walk(relativeDir: string): void {
    const absoluteDir = relativeDir ? pathJoin(migrationsDir, relativeDir) : migrationsDir;
    for (const entry of readdirSync(absoluteDir).sort()) {
      if (entry.startsWith('.')) {
        continue;
      }
      const relativePath = relativeDir ? `${relativeDir}/${entry}` : entry;
      const absolutePath = pathJoin(migrationsDir, relativePath);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        if (!relativeDir && options.excludeTopLevelDirectories?.has(entry)) {
          continue;
        }
        walk(relativePath);
        continue;
      }
      if (stat.isFile() && entry.endsWith('.sql')) {
        files.push(relativePath);
      }
    }
  }

  walk('');
  return files.sort();
}

function formatMigrationFileSummary(files: string[], limit = 8): string {
  if (files.length === 0) {
    return '';
  }

  const visible = files.slice(0, limit).join(', ');
  const remaining = files.length - limit;
  return remaining > 0 ? `${visible}, +${remaining} more` : visible;
}

export function getBlockingChangedMigrationFiles(
  migrations: D1MigrationFileState[],
  onlyFiles?: ReadonlySet<string>
): string[] {
  return migrations
    .filter((item) => item.status === 'changed')
    .filter((item) => !onlyFiles || onlyFiles.has(item.filename))
    .map((item) => item.filename);
}

export type SupersededMigrationState = 'none_applied' | 'fully_applied' | 'partially_applied';

export function evaluateSupersededMigrationState(
  supersedes: ReadonlyArray<{ path: string; checksum: string }>,
  migrations: ReadonlyArray<D1MigrationFileState>
): { state: SupersededMigrationState; error?: string } {
  const migrationByFilename = new Map(
    migrations.map((migration) => [migration.filename, migration])
  );
  const present = supersedes.flatMap((expected) => {
    const actual = migrationByFilename.get(expected.path);
    return actual?.status === 'orphaned' ? [{ expected, actual }] : [];
  });
  if (present.length === 0) return { state: 'none_applied' };
  const checksumMismatch = present.find(
    ({ expected, actual }) => actual.appliedChecksum !== expected.checksum
  );
  if (checksumMismatch) {
    return {
      state: 'partially_applied',
      error: `Superseded migration checksum mismatch: ${checksumMismatch.expected.path}`,
    };
  }
  if (present.length !== supersedes.length) return { state: 'partially_applied' };
  return { state: 'fully_applied' };
}

async function recordMigration(
  dbName: string,
  input: {
    filename: string;
    checksum: string;
    executionTimeMs?: number | null;
    releaseVersion?: string;
  },
  onProgress?: (message: string) => void
): Promise<{ success: boolean; error?: string }> {
  const sql = buildRecordMigrationWithChecksumSql({
    filename: input.filename,
    checksum: input.checksum,
    executionTimeMs: input.executionTimeMs,
    setupVersion: input.releaseVersion,
  });
  try {
    await executeD1Command(dbName, sql, { onProgress });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: describeInventoryError(error, 'unknown error'),
    };
  }
}

function countMigrationStates(
  migrations: D1MigrationFileState[]
): D1MigrationDatabaseStatus['counts'] {
  return {
    total: migrations.length,
    applied: migrations.filter((item) => item.status === 'applied').length,
    pending: migrations.filter((item) => item.status === 'pending').length,
    changed: migrations.filter((item) => item.status === 'changed').length,
    orphaned: migrations.filter((item) => item.status === 'orphaned').length,
  };
}

export async function getD1MigrationStatus(
  dbName: string,
  migrationsDir: string,
  role: D1MigrationDatabaseRole,
  options: ListD1MigrationOptions = {},
  onProgress?: (message: string) => void
): Promise<D1MigrationDatabaseStatus> {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');

  if (!existsSync(migrationsDir)) {
    return {
      role,
      dbName,
      success: false,
      error: `Migrations directory not found: ${migrationsDir}`,
      counts: { total: 0, applied: 0, pending: 0, changed: 0, orphaned: 0 },
      migrations: [],
    };
  }

  try {
    const discoveredManifest =
      options.materializeSuperseded && !options.manifestFiles
        ? discoverReleaseMigrationStream(migrationsDir)
        : null;
    const manifestFiles = options.manifestFiles ?? discoveredManifest?.stream.files;
    const allSqlFiles = listD1MigrationSqlFiles(migrationsDir, options);
    const allSqlFileSet = new Set(allSqlFiles);
    const sqlFiles = manifestFiles
      ? manifestFiles.map((file) => file.path).sort((a, b) => a.localeCompare(b))
      : allSqlFiles;
    const missingFiles = sqlFiles.filter((filename) => !allSqlFileSet.has(filename));
    if (missingFiles.length > 0) {
      throw new Error(
        `Release manifest references missing migration files: ${formatMigrationFileSummary(missingFiles)}`
      );
    }
    const appliedRows = await getAppliedMigrationRows(dbName, onProgress);
    const appliedByFilename = new Map(appliedRows.map((row) => [row.filename, row]));
    const localFilenames = new Set(sqlFiles);
    const migrations: D1MigrationFileState[] = [];

    for (const filename of sqlFiles) {
      const checksum = calculateD1MigrationChecksum(join(migrationsDir, filename));
      const manifestFile = manifestFiles?.find((file) => file.path === filename);
      if (manifestFile && manifestFile.checksum !== checksum) {
        throw new Error(`Release manifest checksum mismatch: ${filename}`);
      }
      const applied = appliedByFilename.get(filename);
      const appliedChecksum = applied?.checksum ?? null;
      const status: D1MigrationFileStatus = !applied
        ? 'pending'
        : appliedChecksum === checksum
          ? 'applied'
          : 'changed';
      migrations.push({
        filename,
        status,
        checksum,
        appliedChecksum,
        appliedAt: applied?.applied_at ?? null,
        executionTimeMs: applied?.execution_time_ms ?? null,
      });
    }

    for (const applied of appliedRows) {
      if (!localFilenames.has(applied.filename)) {
        migrations.push({
          filename: applied.filename,
          status: 'orphaned',
          appliedChecksum: applied.checksum ?? null,
          appliedAt: applied.applied_at ?? null,
          executionTimeMs: applied.execution_time_ms ?? null,
        });
      }
    }

    if (options.materializeSuperseded && manifestFiles) {
      const migrationByFilename = new Map(
        migrations.map((migration) => [migration.filename, migration])
      );
      const consumedSupersededFiles = new Set<string>();
      for (const manifestFile of manifestFiles) {
        if (!manifestFile.supersedes?.length) continue;
        const target = migrationByFilename.get(manifestFile.path);
        if (!target || (target.status !== 'pending' && target.status !== 'applied')) continue;
        const supersededState = evaluateSupersededMigrationState(
          manifestFile.supersedes,
          migrations
        );
        if (supersededState.state !== 'fully_applied') continue;

        const supersededRows = manifestFile.supersedes
          .map((source) => migrationByFilename.get(source.path))
          .filter((source): source is D1MigrationFileState => source !== undefined);
        if (target.status === 'pending') {
          target.status = 'applied';
          target.appliedChecksum = target.checksum ?? manifestFile.checksum;
          target.appliedAt = Math.max(...supersededRows.map((source) => source.appliedAt ?? 0));
          target.executionTimeMs = supersededRows.reduce(
            (total, source) => total + (source.executionTimeMs ?? 0),
            0
          );
        }
        for (const source of manifestFile.supersedes) {
          consumedSupersededFiles.add(source.path);
        }
      }
      if (consumedSupersededFiles.size > 0) {
        for (let index = migrations.length - 1; index >= 0; index--) {
          const migration = migrations[index];
          if (migration?.status === 'orphaned' && consumedSupersededFiles.has(migration.filename)) {
            migrations.splice(index, 1);
          }
        }
      }
    }

    migrations.sort((a, b) => a.filename.localeCompare(b.filename));

    return {
      role,
      dbName,
      success: true,
      counts: countMigrationStates(migrations),
      migrations,
    };
  } catch (error) {
    return {
      role,
      dbName,
      success: false,
      error: `Could not read migration history for ${dbName}: ${describeInventoryError(
        error,
        'unknown error'
      )}`,
      counts: { total: 0, applied: 0, pending: 0, changed: 0, orphaned: 0 },
      migrations: [],
    };
  }
}

/**
 * Run all D1 migrations for a database.
 *
 * Uses an `authrim_migrations` tracking table inside the D1 database to skip
 * files that have already been applied, making repeated runs idempotent.
 */
export async function runD1Migrations(
  dbName: string,
  migrationsDir: string,
  onProgress?: (message: string) => void,
  options: RunD1MigrationOptions = {}
): Promise<{ success: boolean; appliedCount: number; skippedCount: number; error?: string }> {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');

  if (!existsSync(migrationsDir)) {
    return {
      success: false,
      appliedCount: 0,
      skippedCount: 0,
      error: `Migrations directory not found: ${migrationsDir}`,
    };
  }

  const discoveredManifest = options.manifestFiles
    ? null
    : discoverReleaseMigrationStream(migrationsDir);
  const manifestFiles = options.manifestFiles ?? discoveredManifest?.stream.files;
  const releaseVersion = options.releaseVersion ?? discoveredManifest?.manifest.productVersion;
  const allSqlFiles = listD1MigrationSqlFiles(migrationsDir, options);
  const manifestFileSet = manifestFiles
    ? new Set(manifestFiles.map((file) => file.path))
    : undefined;
  if (options.onlyFiles && manifestFileSet) {
    const outsideManifest = [...options.onlyFiles].filter((file) => !manifestFileSet.has(file));
    if (outsideManifest.length > 0) {
      return {
        success: false,
        appliedCount: 0,
        skippedCount: 0,
        error: `Requested migration files are not part of the selected release manifest: ${formatMigrationFileSummary(outsideManifest.sort())}`,
      };
    }
  }
  const selectedFiles = options.onlyFiles ?? manifestFileSet;
  const sqlFiles = selectedFiles
    ? allSqlFiles.filter((file) => selectedFiles.has(file))
    : allSqlFiles;

  if (manifestFileSet) {
    const missingFiles = [...manifestFileSet].filter((file) => !allSqlFiles.includes(file));
    if (missingFiles.length > 0) {
      return {
        success: false,
        appliedCount: 0,
        skippedCount: 0,
        error: `Release manifest references missing migration files: ${formatMigrationFileSummary(missingFiles)}`,
      };
    }
    for (const manifestFile of manifestFiles ?? []) {
      const actualChecksum = calculateD1MigrationChecksum(join(migrationsDir, manifestFile.path));
      if (actualChecksum !== manifestFile.checksum) {
        return {
          success: false,
          appliedCount: 0,
          skippedCount: 0,
          error: `Release manifest checksum mismatch: ${manifestFile.path}`,
        };
      }
    }
  }

  if (manifestFiles && options.backfillLegacyChecksums) {
    try {
      const backfilledCount = await backfillLegacyMigrationChecksums(
        dbName,
        manifestFiles,
        onProgress
      );
      if (backfilledCount > 0) {
        onProgress?.(`  Upgraded ${backfilledCount} legacy migration checksum record(s)`);
      }
    } catch (error) {
      return {
        success: false,
        appliedCount: 0,
        skippedCount: 0,
        error: `Could not upgrade legacy migration checksum history: ${describeInventoryError(
          error,
          'unknown error'
        )}`,
      };
    }
  }

  if (sqlFiles.length === 0) {
    onProgress?.(`  No migration files found in ${migrationsDir}`);
    return { success: true, appliedCount: 0, skippedCount: 0 };
  }

  onProgress?.(`  Found ${sqlFiles.length} migration files`);

  const status = await getD1MigrationStatus(
    dbName,
    migrationsDir,
    'core',
    {
      ...options,
      ...(manifestFiles ? { manifestFiles } : {}),
      materializeSuperseded: false,
    },
    onProgress
  );
  if (!status.success) {
    return {
      success: false,
      appliedCount: 0,
      skippedCount: 0,
      error:
        `${status.error ?? `Could not read migration history for ${dbName}`}. ` +
        'Refusing to run migrations without a trustworthy applied-migration history.',
    };
  }
  const changedFiles = getBlockingChangedMigrationFiles(status.migrations, selectedFiles);
  if (changedFiles.length > 0) {
    return {
      success: false,
      appliedCount: 0,
      skippedCount: status.counts.applied,
      error:
        'Applied migration file checksum mismatch. Create a new migration instead of modifying applied files: ' +
        formatMigrationFileSummary(changedFiles),
    };
  }
  const applied = new Set(
    status.migrations.filter((item) => item.status === 'applied').map((item) => item.filename)
  );
  for (const manifestFile of manifestFiles ?? []) {
    if (applied.has(manifestFile.path) || !manifestFile.supersedes?.length) continue;
    const supersededState = evaluateSupersededMigrationState(
      manifestFile.supersedes,
      status.migrations
    );
    if (supersededState.state === 'none_applied') continue;
    if (supersededState.state === 'partially_applied') {
      return {
        success: false,
        appliedCount: 0,
        skippedCount: applied.size,
        error:
          `${supersededState.error ?? `Release migration ${manifestFile.path} only partially supersedes applied draft migrations.`} ` +
          'Apply every draft migration from the previous checkout or recreate the pre-release database.',
      };
    }
    const recorded = await recordMigration(
      dbName,
      {
        filename: manifestFile.path,
        checksum: manifestFile.checksum,
        executionTimeMs: 0,
        releaseVersion,
      },
      onProgress
    );
    if (!recorded.success) {
      return {
        success: false,
        appliedCount: 0,
        skippedCount: applied.size,
        error:
          `Could not record consolidated release migration ${manifestFile.path}: ` +
          (recorded.error ?? 'unknown error'),
      };
    }
    applied.add(manifestFile.path);
  }
  onProgress?.(`  ${applied.size} migration(s) already recorded as applied`);

  let appliedCount = 0;
  let skippedCount = 0;
  const alreadyAppliedFiles: string[] = [];
  const summaryLimit = options.logSummaryLimit ?? 8;

  for (const sqlFile of sqlFiles) {
    if (applied.has(sqlFile)) {
      alreadyAppliedFiles.push(sqlFile);
      skippedCount++;
      continue;
    }

    const sqlFilePath = join(migrationsDir, sqlFile);
    const checksum = calculateD1MigrationChecksum(sqlFilePath);
    const trackingSql = buildRecordMigrationWithChecksumSql({
      filename: sqlFile,
      checksum,
      executionTimeMs: null,
      setupVersion: releaseVersion,
    });
    const result = await executeD1Migration(dbName, sqlFilePath, onProgress, {
      transactionSuffixSql: trackingSql,
      verifyCommitted: async () => {
        const rows = await getAppliedMigrationRows(dbName, onProgress);
        return rows.some((row) => row.filename === sqlFile && row.checksum === checksum);
      },
    });
    if (!result.success) {
      return {
        success: false,
        appliedCount,
        skippedCount,
        error: `Failed on ${sqlFile}: ${result.error}`,
      };
    }

    appliedCount++;
  }

  if (alreadyAppliedFiles.length > 0) {
    onProgress?.(
      `  ⏭  Skipping ${alreadyAppliedFiles.length} already-applied migration(s): ${formatMigrationFileSummary(
        alreadyAppliedFiles,
        summaryLimit
      )}`
    );
  }

  return { success: true, appliedCount, skippedCount };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build idempotent SQL that guarantees the configured initial tenant exists.
 *
 * Fresh databases currently start with a hard-coded `default` row. When setup
 * configures a different initial tenant ID, that row must be renamed or a new
 * tenant must be inserted so host-based tenant resolution succeeds.
 */
export function buildInitialTenantBootstrapSql(config: AuthrimConfig): string {
  const sqlExpr = getPortableSqlExpressions('sqlite');
  const tenantId = config.tenant?.name?.trim() || 'default';
  const tenantCode = tenantId;
  const displayName = config.tenant?.displayName?.trim() || 'Initial Tenant';
  const placementPolicy = config.tenant?.placementPolicy ?? 'tenant_exclusive';

  const tenantIdSql = sqlString(tenantId);
  const tenantCodeSql = sqlString(tenantCode);
  const displayNameSql = sqlString(displayName);
  const placementPolicySql = sqlString(placementPolicy);

  // Note: D1's HTTP API (used by `wrangler d1 execute --command`) does not support
  // explicit BEGIN TRANSACTION / COMMIT statements. Each statement runs as its own
  // implicit transaction, which is safe here because this bootstrap runs once during
  // deployment with no concurrent writes.
  return `
UPDATE tenants
SET id = ${tenantIdSql},
    tenant_code = ${tenantCodeSql},
    name = ${displayNameSql},
    tenant_key = COALESCE(tenant_key, 't_' || lower(hex(randomblob(18)))),
    lifecycle_state = 'active',
    isolation_policy = ${placementPolicySql},
    updated_at = MAX(${sqlExpr.nowEpochSeconds}, updated_at + 1)
WHERE id = 'default'
  AND ${tenantIdSql} <> 'default'
  AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantIdSql})
  AND (SELECT COUNT(*) FROM tenants) = 1;

UPDATE flows
SET tenant_id = ${tenantIdSql},
    updated_at = ${sqlExpr.nowEpochSeconds}
WHERE tenant_id = 'default'
  AND ${tenantIdSql} <> 'default'
  AND EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantIdSql})
  AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = 'default');

UPDATE flow_versions
SET tenant_id = ${tenantIdSql}
WHERE tenant_id = 'default'
  AND ${tenantIdSql} <> 'default'
  AND EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantIdSql})
  AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = 'default');

UPDATE flow_assignments
SET tenant_id = ${tenantIdSql},
    updated_at = ${sqlExpr.nowEpochSeconds}
WHERE tenant_id = 'default'
  AND ${tenantIdSql} <> 'default'
  AND EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantIdSql})
  AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = 'default');

DELETE FROM screens
WHERE tenant_id = 'default'
  AND ${tenantIdSql} <> 'default'
  AND EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantIdSql})
  AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = 'default')
  AND EXISTS (
    SELECT 1
    FROM screens target
    WHERE target.tenant_id = ${tenantIdSql}
      AND target.screen_key = screens.screen_key
  );

UPDATE screens
SET tenant_id = ${tenantIdSql},
    updated_at = ${sqlExpr.nowEpochSeconds}
WHERE tenant_id = 'default'
  AND ${tenantIdSql} <> 'default'
  AND EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantIdSql})
  AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = 'default');

INSERT INTO tenants (
  id, tenant_code, tenant_key, name, description, lifecycle_state, is_default,
  default_tenant_guard, created_at, updated_at, isolation_policy
)
SELECT ${tenantIdSql}, ${tenantCodeSql}, 't_' || lower(hex(randomblob(18))), ${displayNameSql}, NULL, 'active',
       CASE WHEN EXISTS (SELECT 1 FROM tenants WHERE is_default = 1) THEN 0 ELSE 1 END,
       CASE WHEN EXISTS (SELECT 1 FROM tenants WHERE is_default = 1) THEN NULL ELSE 'default' END,
       ${sqlExpr.nowEpochSeconds}, ${sqlExpr.nowEpochSeconds}, ${placementPolicySql}
WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantIdSql});

UPDATE tenants
SET tenant_code = ${tenantCodeSql},
    name = ${displayNameSql},
    tenant_key = COALESCE(tenant_key, 't_' || lower(hex(randomblob(18)))),
    lifecycle_state = 'active',
    isolation_policy = ${placementPolicySql},
    updated_at = MAX(${sqlExpr.nowEpochSeconds}, updated_at + 1)
WHERE id = ${tenantIdSql};
`.trim();
}

/**
 * Build idempotent SQL that canonicalizes built-in admin roles in DB_ADMIN.
 *
 * System roles are global templates and must exist only under tenant `default`.
 * Older setup versions copied them into the initial tenant; this rewrites any
 * assignments to the canonical default roles and deletes those stale copies.
 */
export function buildInitialAdminRolesBootstrapSql(config: AuthrimConfig): string {
  const tenantId = config.tenant?.name?.trim() || 'default';
  const tenantIdSql = sqlString(tenantId);

  return `
DELETE FROM admin_role_assignments
WHERE admin_role_id IN (
  SELECT copy.id
  FROM admin_roles copy
  JOIN admin_roles canonical
    ON canonical.tenant_id = 'default'
   AND canonical.is_system = 1
   AND canonical.name = copy.name
  WHERE copy.tenant_id = ${tenantIdSql}
    AND copy.tenant_id <> 'default'
    AND copy.is_system = 1
)
AND EXISTS (
  SELECT 1
  FROM admin_role_assignments existing
  JOIN admin_roles copy
    ON copy.id = admin_role_assignments.admin_role_id
  JOIN admin_roles canonical
    ON canonical.tenant_id = 'default'
   AND canonical.is_system = 1
   AND canonical.name = copy.name
  WHERE existing.tenant_id = admin_role_assignments.tenant_id
    AND existing.admin_user_id = admin_role_assignments.admin_user_id
    AND existing.admin_role_id = canonical.id
    AND existing.scope_type = admin_role_assignments.scope_type
    AND COALESCE(existing.scope_id, '') = COALESCE(admin_role_assignments.scope_id, '')
);

UPDATE admin_role_assignments
SET admin_role_id = (
  SELECT canonical.id
  FROM admin_roles copy
  JOIN admin_roles canonical
    ON canonical.tenant_id = 'default'
   AND canonical.is_system = 1
   AND canonical.name = copy.name
  WHERE copy.id = admin_role_assignments.admin_role_id
  LIMIT 1
)
WHERE admin_role_id IN (
  SELECT copy.id
  FROM admin_roles copy
  JOIN admin_roles canonical
    ON canonical.tenant_id = 'default'
   AND canonical.is_system = 1
   AND canonical.name = copy.name
  WHERE copy.tenant_id = ${tenantIdSql}
    AND copy.tenant_id <> 'default'
    AND copy.is_system = 1
);

DELETE FROM admin_roles
WHERE tenant_id = ${tenantIdSql}
  AND ${tenantIdSql} <> 'default'
  AND is_system = 1
  AND EXISTS (
    SELECT 1
    FROM admin_roles canonical
    WHERE canonical.tenant_id = 'default'
      AND canonical.is_system = 1
      AND canonical.name = admin_roles.name
  );
`.trim();
}

export interface InitialTenantBootstrapResult {
  success: boolean;
  error?: string;
}

export interface InitialAdminRolesBootstrapResult {
  success: boolean;
  error?: string;
}

export interface SetupMachineAccessBootstrapResult {
  success: boolean;
  error?: string;
}

export interface RuntimeProfileSeedResult {
  success: boolean;
  seededCount: number;
  backend: 'kv' | 'database';
  error?: string;
}

export interface DefaultCanonicalCatalogSeedResult {
  success: boolean;
  seededCount: number;
  error?: string;
}

/**
 * Ensure the configured initial tenant exists in the core D1 database.
 *
 * This runs after migrations so host-based tenant validation can find the
 * configured tenant immediately after deployment.
 */
export async function ensureInitialTenantInD1(
  env: string,
  config: AuthrimConfig,
  onProgress?: (message: string) => void,
  options: { databaseIdentifier?: string } = {}
): Promise<InitialTenantBootstrapResult> {
  const dbName = options.databaseIdentifier?.trim() || getD1DatabaseName(env, 'core-db');
  const tenantId = config.tenant?.name?.trim() || 'default';
  const sql = buildInitialTenantBootstrapSql(config);

  try {
    onProgress?.(`🔧 Ensuring initial tenant exists in ${dbName} (${tenantId})...`);
    const { stdout, stderr } = await executeD1Command(dbName, sql, { onProgress });
    const combined = (stdout + '\n' + stderr).toLowerCase();
    if (combined.includes('[error]') || combined.includes('✘ [error]')) {
      const errorDetail = stderr || stdout;
      onProgress?.(`  ❌ Initial tenant bootstrap failed: ${errorDetail}`);
      return { success: false, error: errorDetail };
    }
    onProgress?.(`  ✅ Initial tenant ready: ${tenantId}`);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.(`  ❌ Initial tenant bootstrap failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Ensure built-in admin roles exist for the configured initial tenant.
 */
export async function ensureInitialAdminRolesInD1(
  env: string,
  config: AuthrimConfig,
  onProgress?: (message: string) => void,
  options: { databaseIdentifier?: string } = {}
): Promise<InitialAdminRolesBootstrapResult> {
  const dbName = options.databaseIdentifier?.trim() || getD1DatabaseName(env, 'admin-db');
  const tenantId = config.tenant?.name?.trim() || 'default';
  const sql = buildInitialAdminRolesBootstrapSql(config);

  try {
    onProgress?.(`🔧 Ensuring admin roles exist in ${dbName} (${tenantId})...`);
    const { stdout, stderr } = await executeD1Command(dbName, sql, { onProgress });
    const combined = (stdout + '\n' + stderr).toLowerCase();
    if (combined.includes('[error]') || combined.includes('✘ [error]')) {
      const errorDetail = stderr || stdout;
      onProgress?.(`  ❌ Admin role bootstrap failed: ${errorDetail}`);
      return { success: false, error: errorDetail };
    }
    onProgress?.(`  ✅ Admin roles ready: ${tenantId}`);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.(`  ❌ Admin role bootstrap failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Ensure the setup tool machine principal and public JWK credential exist in DB_ADMIN.
 */
export async function ensureSetupMachineAccessInD1(
  env: string,
  config: AuthrimConfig,
  keysDir: string,
  onProgress?: (message: string) => void,
  options: { databaseIdentifier?: string } = {}
): Promise<SetupMachineAccessBootstrapResult> {
  const dbName = options.databaseIdentifier?.trim() || getD1DatabaseName(env, 'admin-db');

  try {
    await ensureSetupMachineKeyFiles(keysDir);
    const publicJwk = await loadSetupMachinePublicJwk(keysDir);
    const sql = buildSetupMachineAccessBootstrapSql(config, publicJwk);

    onProgress?.(`🔧 Ensuring setup machine access exists in ${dbName}...`);
    const { stdout, stderr } = await executeD1Command(dbName, sql, { onProgress });
    const combined = (stdout + '\n' + stderr).toLowerCase();
    if (combined.includes('[error]') || combined.includes('✘ [error]')) {
      const errorDetail = stderr || stdout;
      onProgress?.(`  ❌ Setup machine access bootstrap failed: ${errorDetail}`);
      return { success: false, error: errorDetail };
    }

    onProgress?.('  ✅ Setup machine access ready');
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.(`  ❌ Setup machine access bootstrap failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Remove the deploy-only setup machine principal and its local private key.
 *
 * The initial admin setup token is managed separately and is intentionally not
 * touched here.
 */
export async function cleanupSetupMachineAccessInD1(
  env: string,
  keysDir: string,
  onProgress?: (message: string) => void,
  options: { databaseIdentifier?: string } = {}
): Promise<SetupMachineAccessBootstrapResult> {
  const dbName = options.databaseIdentifier?.trim() || getD1DatabaseName(env, 'admin-db');
  let remoteError: string | undefined;
  let localError: string | undefined;
  try {
    try {
      const sql = buildSetupMachineAccessCleanupSql();

      onProgress?.(`🧹 Removing setup machine access from ${dbName}...`);
      const { stdout, stderr } = await executeD1Command(dbName, sql, { onProgress });
      const combined = (stdout + '\n' + stderr).toLowerCase();
      if (combined.includes('[error]') || combined.includes('✘ [error]')) {
        remoteError = stderr || stdout;
      }
    } catch (error) {
      remoteError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    // The private key is useful only for this bounded setup operation. Retaining it after an
    // unknown/failed remote revocation increases exposure without improving recovery: the fixed
    // principal can be cleaned up by SQL and a later ensure call safely generates a new key pair.
    try {
      await deleteSetupMachineKeyFiles(keysDir);
    } catch (error) {
      localError = error instanceof Error ? error.message : String(error);
    }
  }

  if (remoteError || localError) {
    const error = [
      remoteError ? `remote cleanup failed: ${remoteError}` : undefined,
      localError ? `local key cleanup failed: ${localError}` : undefined,
    ]
      .filter((entry): entry is string => entry !== undefined)
      .join('; ');
    onProgress?.(`  ❌ Setup machine access cleanup failed: ${error}`);
    return { success: false, error };
  }
  onProgress?.('  ✅ Setup machine access removed');
  return { success: true };
}

/**
 * Ensure the Admin UI BFF machine principal and public JWK credential exist in DB_ADMIN.
 */
export async function ensureAdminUiBffMachineAccessInD1(
  env: string,
  config: AuthrimConfig,
  keysDir: string,
  onProgress?: (message: string) => void,
  options: { databaseIdentifier?: string } = {}
): Promise<SetupMachineAccessBootstrapResult> {
  const dbName = options.databaseIdentifier?.trim() || getD1DatabaseName(env, 'admin-db');

  try {
    const publicJwk = await loadAdminUiBffPublicJwk(keysDir);
    const sql = buildAdminUiBffMachineAccessBootstrapSql(config, publicJwk);

    onProgress?.(`🔧 Ensuring Admin UI BFF machine access exists in ${dbName}...`);
    const { stdout, stderr } = await executeD1Command(dbName, sql, { onProgress });
    const combined = (stdout + '\n' + stderr).toLowerCase();
    if (combined.includes('[error]') || combined.includes('✘ [error]')) {
      const errorDetail = stderr || stdout;
      onProgress?.(`  ❌ Admin UI BFF machine access bootstrap failed: ${errorDetail}`);
      return { success: false, error: errorDetail };
    }

    onProgress?.('  ✅ Admin UI BFF machine access ready');
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.(`  ❌ Admin UI BFF machine access bootstrap failed: ${message}`);
    return { success: false, error: message };
  }
}

type SeededRuntimeProfile = {
  kind: 'audit' | 'residency';
  id: string;
  payload: Record<string, unknown>;
};

type DefaultCanonicalCatalogEntrySeed = {
  stableFieldId: string;
  path: string;
  valueType: string;
  cardinality: 'single' | 'multi';
  classification: 'internal' | 'pii';
  groupKey: string;
  groupLabel: string;
  groupOrder: number;
  fieldOrder: number;
  examples: unknown[];
};

const DEFAULT_CANONICAL_CATALOG_ID = 'system_default_canonical_catalog';
const DEFAULT_CANONICAL_CATALOG_VERSION_ID = 'system_default_canonical_catalog_v1';
const DEFAULT_CANONICAL_CATALOG_KEY = 'authrim.default_canonical';
const DEFAULT_CANONICAL_CATALOG_VERSION_LABEL = '2026-05-30';
const DEFAULT_CANONICAL_CATALOG_BUNDLE_HASH =
  '0000000000000000000000000000000000000000000000000000000000000001';

const DEFAULT_CANONICAL_CATALOG_ENTRIES: DefaultCanonicalCatalogEntrySeed[] = [
  {
    stableFieldId: 'field.canonical.name',
    path: 'name',
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    groupKey: 'name',
    groupLabel: 'Name',
    groupOrder: 10,
    fieldOrder: 10,
    examples: ['John Doe', '山田 太郎', '김민준'],
  },
  {
    stableFieldId: 'field.canonical.given_name',
    path: 'given_name',
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    groupKey: 'name',
    groupLabel: 'Name',
    groupOrder: 10,
    fieldOrder: 20,
    examples: ['John', '太郎', '민준'],
  },
  {
    stableFieldId: 'field.canonical.family_name',
    path: 'family_name',
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    groupKey: 'name',
    groupLabel: 'Name',
    groupOrder: 10,
    fieldOrder: 30,
    examples: ['Doe', '山田', '김'],
  },
  {
    stableFieldId: 'field.canonical.middle_name',
    path: 'middle_name',
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    groupKey: 'name',
    groupLabel: 'Name',
    groupOrder: 10,
    fieldOrder: 40,
    examples: ['Quincy'],
  },
  {
    stableFieldId: 'field.canonical.nickname',
    path: 'nickname',
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    groupKey: 'name',
    groupLabel: 'Name',
    groupOrder: 10,
    fieldOrder: 50,
    examples: ['Johnny', 'たろう'],
  },
  {
    stableFieldId: 'field.canonical.preferred_username',
    path: 'preferred_username',
    valueType: 'string',
    cardinality: 'single',
    classification: 'internal',
    groupKey: 'name',
    groupLabel: 'Name',
    groupOrder: 10,
    fieldOrder: 60,
    examples: ['jdoe', 'taro.yamada'],
  },
  {
    stableFieldId: 'field.canonical.email',
    path: 'email',
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    groupKey: 'contact',
    groupLabel: 'Contact',
    groupOrder: 20,
    fieldOrder: 10,
    examples: ['john@example.edu'],
  },
  {
    stableFieldId: 'field.canonical.email_verified',
    path: 'email_verified',
    valueType: 'boolean',
    cardinality: 'single',
    classification: 'internal',
    groupKey: 'contact',
    groupLabel: 'Contact',
    groupOrder: 20,
    fieldOrder: 20,
    examples: [true],
  },
  {
    stableFieldId: 'field.canonical.phone_number',
    path: 'phone_number',
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    groupKey: 'contact',
    groupLabel: 'Contact',
    groupOrder: 20,
    fieldOrder: 30,
    examples: ['+1 415 555 0100'],
  },
  {
    stableFieldId: 'field.canonical.phone_number_verified',
    path: 'phone_number_verified',
    valueType: 'boolean',
    cardinality: 'single',
    classification: 'internal',
    groupKey: 'contact',
    groupLabel: 'Contact',
    groupOrder: 20,
    fieldOrder: 40,
    examples: [false],
  },
  {
    stableFieldId: 'field.canonical.address',
    path: 'address',
    valueType: 'json',
    cardinality: 'multi',
    classification: 'pii',
    groupKey: 'address',
    groupLabel: 'Address',
    groupOrder: 30,
    fieldOrder: 10,
    examples: [
      {
        formatted: '1-1 Chiyoda, Chiyoda-ku, Tokyo 100-8111, JP',
        streetAddress: '1-1 Chiyoda',
        locality: 'Chiyoda-ku',
        region: 'Tokyo',
        postalCode: '100-8111',
        country: 'JP',
      },
    ],
  },
  {
    stableFieldId: 'field.canonical.address_street_address',
    path: 'address_street_address',
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    groupKey: 'address',
    groupLabel: 'Address',
    groupOrder: 30,
    fieldOrder: 20,
    examples: ['1-1 Chiyoda'],
  },
  {
    stableFieldId: 'field.canonical.address_locality',
    path: 'address_locality',
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    groupKey: 'address',
    groupLabel: 'Address',
    groupOrder: 30,
    fieldOrder: 30,
    examples: ['Chiyoda-ku'],
  },
  {
    stableFieldId: 'field.canonical.address_region',
    path: 'address_region',
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    groupKey: 'address',
    groupLabel: 'Address',
    groupOrder: 30,
    fieldOrder: 40,
    examples: ['Tokyo'],
  },
  {
    stableFieldId: 'field.canonical.address_postal_code',
    path: 'address_postal_code',
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    groupKey: 'address',
    groupLabel: 'Address',
    groupOrder: 30,
    fieldOrder: 50,
    examples: ['100-8111'],
  },
  {
    stableFieldId: 'field.canonical.address_country',
    path: 'address_country',
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    groupKey: 'address',
    groupLabel: 'Address',
    groupOrder: 30,
    fieldOrder: 60,
    examples: ['JP'],
  },
  {
    stableFieldId: 'field.canonical.profile',
    path: 'profile',
    valueType: 'string',
    cardinality: 'single',
    classification: 'internal',
    groupKey: 'profile',
    groupLabel: 'Profile',
    groupOrder: 40,
    fieldOrder: 10,
    examples: ['https://example.edu/users/jdoe'],
  },
  {
    stableFieldId: 'field.canonical.picture',
    path: 'picture',
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    groupKey: 'profile',
    groupLabel: 'Profile',
    groupOrder: 40,
    fieldOrder: 20,
    examples: ['https://example.edu/users/jdoe/photo.jpg'],
  },
  {
    stableFieldId: 'field.canonical.website',
    path: 'website',
    valueType: 'string',
    cardinality: 'single',
    classification: 'internal',
    groupKey: 'profile',
    groupLabel: 'Profile',
    groupOrder: 40,
    fieldOrder: 30,
    examples: ['https://jdoe.example.edu'],
  },
  {
    stableFieldId: 'field.canonical.birthdate',
    path: 'birthdate',
    valueType: 'date',
    cardinality: 'single',
    classification: 'pii',
    groupKey: 'profile',
    groupLabel: 'Profile',
    groupOrder: 40,
    fieldOrder: 40,
    examples: ['1990-04-12'],
  },
  {
    stableFieldId: 'field.canonical.zoneinfo',
    path: 'zoneinfo',
    valueType: 'string',
    cardinality: 'single',
    classification: 'internal',
    groupKey: 'profile',
    groupLabel: 'Profile',
    groupOrder: 40,
    fieldOrder: 50,
    examples: ['Asia/Tokyo'],
  },
  {
    stableFieldId: 'field.canonical.locale',
    path: 'locale',
    valueType: 'string',
    cardinality: 'single',
    classification: 'internal',
    groupKey: 'profile',
    groupLabel: 'Profile',
    groupOrder: 40,
    fieldOrder: 60,
    examples: ['ja-JP'],
  },
  {
    stableFieldId: 'field.canonical.group_membership',
    path: 'group_membership',
    valueType: 'array',
    cardinality: 'multi',
    classification: 'internal',
    groupKey: 'access',
    groupLabel: 'Access',
    groupOrder: 50,
    fieldOrder: 10,
    examples: ['library-staff', 'researcher'],
  },
  {
    stableFieldId: 'field.canonical.entitlements',
    path: 'entitlements',
    valueType: 'array',
    cardinality: 'multi',
    classification: 'internal',
    groupKey: 'access',
    groupLabel: 'Access',
    groupOrder: 50,
    fieldOrder: 20,
    examples: ['publisher:journal:read'],
  },
  {
    stableFieldId: 'field.canonical.subject_id',
    path: 'subject_id',
    valueType: 'string',
    cardinality: 'single',
    classification: 'internal',
    groupKey: 'identity',
    groupLabel: 'Identity',
    groupOrder: 60,
    fieldOrder: 10,
    examples: ['user_01HZY9G3V3W0M7K9D2B1N6A8CQ'],
  },
  {
    stableFieldId: 'field.canonical.linked_identity',
    path: 'linked_identity',
    valueType: 'string',
    cardinality: 'single',
    classification: 'internal',
    groupKey: 'identity',
    groupLabel: 'Identity',
    groupOrder: 60,
    fieldOrder: 20,
    examples: ['saml:urn:example:idp:00u123'],
  },
  {
    stableFieldId: 'field.canonical.lifecycle_state',
    path: 'lifecycle_state',
    valueType: 'string',
    cardinality: 'single',
    classification: 'internal',
    groupKey: 'identity',
    groupLabel: 'Identity',
    groupOrder: 60,
    fieldOrder: 30,
    examples: ['active'],
  },
];

function collectSeededRuntimeProfiles(config: AuthrimConfig): SeededRuntimeProfile[] {
  const seeded: SeededRuntimeProfile[] = [];
  for (const profile of config.profiles?.seed?.audit ?? []) {
    seeded.push({
      kind: 'audit',
      id: profile.id,
      payload: {
        ...profile,
        kind: 'audit',
        builtin: false,
      },
    });
  }
  for (const profile of config.profiles?.seed?.residency ?? []) {
    seeded.push({
      kind: 'residency',
      id: profile.id,
      payload: {
        ...profile,
        kind: 'residency',
        builtin: false,
      },
    });
  }
  return seeded;
}

export function buildRuntimeProfileSeedSql(config: AuthrimConfig): string | null {
  const seeded = collectSeededRuntimeProfiles(config);
  if (seeded.length === 0) {
    return null;
  }

  return seeded
    .map((profile) => {
      const payloadSql = sqlString(JSON.stringify(profile.payload));
      const kindSql = sqlString(profile.kind);
      const idSql = sqlString(profile.id);
      return `
UPDATE profile_registry
SET payload_json = ${payloadSql},
    updated_at = CURRENT_TIMESTAMP
WHERE kind = ${kindSql}
  AND id = ${idSql};

INSERT INTO profile_registry (id, kind, payload_json, created_at, updated_at)
SELECT ${idSql}, ${kindSql}, ${payloadSql}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1
  FROM profile_registry
  WHERE kind = ${kindSql}
    AND id = ${idSql}
);`.trim();
    })
    .join('\n\n');
}

function defaultCanonicalCatalogEntryId(stableFieldId: string): string {
  return `system_${stableFieldId.replace(/^field\.canonical\./, 'canonical_').replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

export function buildDefaultCanonicalCatalogSeedSql(config: AuthrimConfig): string {
  const tenantId = config.tenant?.name?.trim() || 'default';
  const tenantSql = sqlString(tenantId);
  const catalogIdSql = sqlString(DEFAULT_CANONICAL_CATALOG_ID);
  const versionIdSql = sqlString(DEFAULT_CANONICAL_CATALOG_VERSION_ID);
  const catalogKeySql = sqlString(DEFAULT_CANONICAL_CATALOG_KEY);
  const nowSql = "CAST(strftime('%s','now') AS INTEGER) * 1000";

  const catalogSql = `
UPDATE field_catalogs
SET display_name = 'Authrim Default Canonical Catalog',
    lifecycle_state = 'active',
    updated_at = ${nowSql}
WHERE tenant_id = ${tenantSql}
  AND catalog_key = ${catalogKeySql};

INSERT INTO field_catalogs (
  id, tenant_id, catalog_key, display_name, lifecycle_state, created_at, updated_at
)
SELECT ${catalogIdSql}, ${tenantSql}, ${catalogKeySql}, 'Authrim Default Canonical Catalog',
       'active', ${nowSql}, ${nowSql}
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalogs
  WHERE tenant_id = ${tenantSql}
    AND catalog_key = ${catalogKeySql}
);

UPDATE field_catalog_versions
SET bundle_hash = ${sqlString(DEFAULT_CANONICAL_CATALOG_BUNDLE_HASH)},
    compatibility_range = '*',
    lifecycle_state = 'active',
    updated_at = ${nowSql}
WHERE tenant_id = ${tenantSql}
  AND id = ${versionIdSql};

INSERT INTO field_catalog_versions (
  id, tenant_id, catalog_id, version_label, bundle_hash, compatibility_range,
  lifecycle_state, created_at, updated_at
)
SELECT ${versionIdSql}, ${tenantSql}, c.id, ${sqlString(DEFAULT_CANONICAL_CATALOG_VERSION_LABEL)},
       ${sqlString(DEFAULT_CANONICAL_CATALOG_BUNDLE_HASH)}, '*', 'active', ${nowSql}, ${nowSql}
FROM field_catalogs c
WHERE c.tenant_id = ${tenantSql}
  AND c.catalog_key = ${catalogKeySql}
  AND NOT EXISTS (
    SELECT 1 FROM field_catalog_versions
    WHERE tenant_id = ${tenantSql}
      AND id = ${versionIdSql}
  );`.trim();

  const entrySql = DEFAULT_CANONICAL_CATALOG_ENTRIES.map((entry) => {
    const idSql = sqlString(defaultCanonicalCatalogEntryId(entry.stableFieldId));
    const stableFieldIdSql = sqlString(entry.stableFieldId);
    const namespaceSql = sqlString('authrim.canonical');
    const pathSql = sqlString(entry.path);
    const valueTypeSql = sqlString(entry.valueType);
    const cardinalitySql = sqlString(entry.cardinality);
    const classificationSql = sqlString(entry.classification);
    const groupKeySql = sqlString(entry.groupKey);
    const groupLabelSql = sqlString(entry.groupLabel);
    const aliasesSql = sqlString('[]');
    const validationSql = sqlString('{}');
    const examplesSql = sqlString(JSON.stringify(entry.examples));

    return `
UPDATE field_catalog_entries
SET namespace = ${namespaceSql},
    path = ${pathSql},
    target_taxonomy = 'canonical',
    value_type = ${valueTypeSql},
    cardinality = ${cardinalitySql},
    classification = ${classificationSql},
    aliases_json = ${aliasesSql},
    validation_json = ${validationSql},
    ui_group_key = ${groupKeySql},
    ui_group_label = ${groupLabelSql},
    ui_group_order = ${entry.groupOrder},
    ui_field_order = ${entry.fieldOrder},
    examples_json = ${examplesSql},
    updated_at = ${nowSql}
WHERE tenant_id = ${tenantSql}
  AND catalog_version_id = ${versionIdSql}
  AND stable_field_id = ${stableFieldIdSql};

INSERT INTO field_catalog_entries (
  id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
  value_type, cardinality, classification, aliases_json, validation_json,
  ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json,
  created_at, updated_at
)
SELECT ${idSql}, ${tenantSql}, ${versionIdSql}, ${stableFieldIdSql}, ${namespaceSql}, ${pathSql},
       'canonical', ${valueTypeSql}, ${cardinalitySql}, ${classificationSql}, ${aliasesSql},
       ${validationSql}, ${groupKeySql}, ${groupLabelSql}, ${entry.groupOrder}, ${entry.fieldOrder},
       ${examplesSql}, ${nowSql}, ${nowSql}
WHERE NOT EXISTS (
  SELECT 1 FROM field_catalog_entries
  WHERE tenant_id = ${tenantSql}
    AND catalog_version_id = ${versionIdSql}
    AND stable_field_id = ${stableFieldIdSql}
);`.trim();
  }).join('\n\n');

  return `${catalogSql}\n\n${entrySql}`;
}

export async function seedDefaultCanonicalCatalog(
  env: string,
  config: AuthrimConfig,
  onProgress?: (message: string) => void,
  options: { databaseIdentifier?: string } = {}
): Promise<DefaultCanonicalCatalogSeedResult> {
  const dbName = options.databaseIdentifier?.trim() || getD1DatabaseName(env, 'admin-db');
  const sql = buildDefaultCanonicalCatalogSeedSql(config);

  try {
    onProgress?.(`🔧 Seeding default canonical field catalog into ${dbName}...`);
    const { stdout, stderr } = await executeD1Command(dbName, sql, { onProgress });

    const combined = (stdout + '\n' + stderr).toLowerCase();
    if (combined.includes('[error]') || combined.includes('✘ [error]')) {
      const errorDetail = stderr || stdout;
      onProgress?.(`  ❌ Default canonical field catalog seed failed: ${errorDetail}`);
      return { success: false, seededCount: 0, error: errorDetail };
    }

    onProgress?.(
      `  ✅ Default canonical field catalog ready (${DEFAULT_CANONICAL_CATALOG_ENTRIES.length} fields)`
    );
    return { success: true, seededCount: DEFAULT_CANONICAL_CATALOG_ENTRIES.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.(`  ❌ Default canonical field catalog seed failed: ${message}`);
    return { success: false, seededCount: 0, error: message };
  }
}

export async function seedRuntimeProfiles(
  env: string,
  config: AuthrimConfig,
  onProgress?: (message: string) => void,
  options: { databaseIdentifier?: string } = {}
): Promise<RuntimeProfileSeedResult> {
  const seeded = collectSeededRuntimeProfiles(config);
  if (seeded.length === 0) {
    return {
      success: true,
      seededCount: 0,
      backend: config.profiles?.registry?.backend ?? 'kv',
    };
  }

  const backend = config.profiles?.registry?.backend ?? 'kv';

  try {
    if (backend === 'database') {
      const dbName = options.databaseIdentifier?.trim() || getD1DatabaseName(env, 'core-db');
      const sql = buildRuntimeProfileSeedSql(config);
      if (!sql) {
        return { success: true, seededCount: 0, backend };
      }

      onProgress?.(`🔧 Seeding ${seeded.length} runtime profile(s) into ${dbName}...`);
      const { stdout, stderr } = await executeD1Command(dbName, sql, { onProgress });

      const combined = (stdout + '\n' + stderr).toLowerCase();
      if (combined.includes('[error]') || combined.includes('✘ [error]')) {
        const errorDetail = stderr || stdout;
        onProgress?.(`  ❌ Runtime profile seed failed: ${errorDetail}`);
        return { success: false, seededCount: 0, backend, error: errorDetail };
      }

      onProgress?.(`  ✅ Seeded ${seeded.length} runtime profile(s)`);
      return { success: true, seededCount: seeded.length, backend };
    }

    onProgress?.(`🔧 Seeding ${seeded.length} runtime profile(s) into AUTHRIM_CONFIG KV...`);
    const oauthRefresh: WranglerOAuthRefreshState = { attempted: false };
    for (const profile of seeded) {
      const key = `profile-registry:${profile.kind}:${profile.id}`;
      let written = false;
      for (let attempt = 1; attempt <= D1_MIGRATION_AUTH_MAX_ATTEMPTS; attempt++) {
        try {
          await wrangler([
            'kv',
            'key',
            'put',
            key,
            JSON.stringify(profile.payload),
            '--env',
            env,
            '--binding',
            'AUTHRIM_CONFIG',
          ]);
          written = true;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const maxAttempts = isD1AuthenticationError(message)
            ? D1_MIGRATION_AUTH_MAX_ATTEMPTS
            : D1_MIGRATION_MAX_ATTEMPTS;
          if (attempt >= maxAttempts || !isTransientD1MigrationError(message)) throw error;
          await refreshWranglerOAuthAfterCode10000(message, oauthRefresh);
          const delayMs = d1MigrationRetryDelayMs(attempt);
          onProgress?.(
            `  ⚠️ Transient runtime-profile KV write failure for ${key} ` +
              `(attempt ${attempt}/${maxAttempts}); retrying in ${Math.round(delayMs / 1000)}s`
          );
          if (delayMs > 0) await sleep(delayMs);
        }
      }
      if (!written) throw new Error(`runtime_profile_kv_write_retry_exhausted:${key}`);
    }

    onProgress?.(`  ✅ Seeded ${seeded.length} runtime profile(s)`);
    return { success: true, seededCount: seeded.length, backend };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.(`  ❌ Runtime profile seed failed: ${message}`);
    return { success: false, seededCount: 0, backend, error: message };
  }
}

/**
 * Locate the migrations root used by setup commands.
 *
 * Priority: local project > authrim subdir > cwd. Setup mutation flows must enable
 * `strictRoot` so a checkout missing migrations cannot silently borrow them from another cwd.
 */
export async function findMigrationsRoot(
  rootDir: string,
  onProgress?: (message: string) => void,
  options: { strictRoot?: boolean } = {}
): Promise<{ path: string | null; searchPaths: string[] }> {
  const { existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const rootedSearchPaths = [
    resolve(rootDir, 'migrations'),
    resolve(rootDir, 'authrim', 'migrations'),
  ];
  const searchPaths = [
    ...new Set(
      options.strictRoot
        ? rootedSearchPaths
        : [
            ...rootedSearchPaths,
            resolve(process.cwd(), 'migrations'),
            resolve(process.cwd(), 'authrim', 'migrations'),
          ]
    ),
  ];

  for (const searchPath of searchPaths) {
    onProgress?.(`  Checking for migrations at: ${searchPath}`);
    if (existsSync(searchPath)) {
      onProgress?.(`  ✓ Found migrations directory: ${searchPath}`);
      return { path: searchPath, searchPaths };
    }
  }

  return { path: null, searchPaths };
}

/**
 * Run migrations for an Authrim environment
 *
 * Searches for migrations directory in source-code locations:
 * 1. {rootDir}/migrations
 * 2. {rootDir}/authrim/migrations
 * 3. process.cwd()/migrations
 * 4. process.cwd()/authrim/migrations
 *
 * @param env - Environment name
 * @param rootDir - Root directory to search for migrations
 * @param onProgress - Progress callback
 */
export async function runMigrationsForEnvironment(
  env: string,
  rootDir: string,
  onProgress?: (message: string) => void,
  release?: EnvironmentReleaseMigrationOptions
): Promise<{
  success: boolean;
  core: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
  pii: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
  admin: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
}> {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');

  // Database names for this environment
  const coreDbName = getD1DatabaseName(env, 'core-db');
  const piiDbName = getD1DatabaseName(env, 'pii-db');
  const adminDbName = getD1DatabaseName(env, 'admin-db');
  const coreDbIdentifier = resolveEnvironmentMigrationDatabaseIdentifier({
    env,
    role: 'core',
    release,
  });
  const piiDbIdentifier = resolveEnvironmentMigrationDatabaseIdentifier({
    env,
    role: 'pii',
    release,
  });
  const adminDbIdentifier = resolveEnvironmentMigrationDatabaseIdentifier({
    env,
    role: 'admin',
    release,
  });

  const migrationSearch = await findMigrationsRoot(rootDir, onProgress, {
    strictRoot: release?.strictMigrationsRoot === true,
  });
  const migrationsRoot = migrationSearch.path;

  if (!migrationsRoot) {
    const errorMsg = `Migrations directory not found. Searched:\n${migrationSearch.searchPaths.map((p) => `    - ${p}`).join('\n')}`;
    onProgress?.(`  ❌ ${errorMsg}`);
    return {
      success: false,
      core: { success: false, appliedCount: 0, skippedCount: 0, error: errorMsg },
      pii: { success: false, appliedCount: 0, skippedCount: 0, error: errorMsg },
      admin: { success: false, appliedCount: 0, skippedCount: 0, error: errorMsg },
    };
  }

  let releaseManifest: { manifest: ReleaseMigrationManifest; draft: boolean } | undefined;
  if (release) {
    try {
      releaseManifest = loadTargetReleaseMigrationManifest({
        migrationsRoot,
        productVersion: release.productVersion,
        allowDraft: release.allowDraft === true,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      onProgress?.(`  ❌ ${errorMsg}`);
      return {
        success: false,
        core: { success: false, appliedCount: 0, skippedCount: 0, error: errorMsg },
        pii: { success: false, appliedCount: 0, skippedCount: 0, error: errorMsg },
        admin: { success: false, appliedCount: 0, skippedCount: 0, error: errorMsg },
      };
    }
  }

  const releaseOptionsFor = (streamId: string): RunD1MigrationOptions => {
    if (!releaseManifest || !release) return {};
    const stream = releaseManifest.manifest.streams.find((candidate) => candidate.id === streamId);
    if (!stream) {
      throw new Error(`release_migration_stream_not_found:${streamId}`);
    }
    return {
      manifestFiles: stream.files,
      releaseVersion: release.productVersion,
      backfillLegacyChecksums: release.backfillLegacyChecksums ?? releaseManifest.draft === false,
    };
  };

  // Run core database migrations
  onProgress?.(`📜 Running migrations for ${coreDbName}...`);
  const coreResult = await runD1Migrations(coreDbIdentifier, migrationsRoot, onProgress, {
    ...releaseOptionsFor('d1-core'),
    excludeTopLevelDirectories: CORE_DB_EXCLUDED_MIGRATION_DIRS,
  });
  if (!coreResult.success) {
    onProgress?.(`  ❌ Core migration failed: ${coreResult.error}`);
  } else {
    onProgress?.(
      `  ✅ Applied ${coreResult.appliedCount} core migrations (${coreResult.skippedCount} skipped)`
    );
  }

  // Run PII database migrations
  const piiMigrationsDir = join(migrationsRoot, 'pii');
  onProgress?.(`📜 Running migrations for ${piiDbName}...`);

  let piiResult: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
  if (!existsSync(piiMigrationsDir)) {
    onProgress?.(`  ⚠️ PII migrations directory not found: ${piiMigrationsDir}`);
    piiResult = { success: true, appliedCount: 0, skippedCount: 0 };
  } else {
    piiResult = await runD1Migrations(piiDbIdentifier, piiMigrationsDir, onProgress, {
      ...releaseOptionsFor('d1-pii'),
    });
    if (!piiResult.success) {
      onProgress?.(`  ❌ PII migration failed: ${piiResult.error}`);
    } else {
      onProgress?.(
        `  ✅ Applied ${piiResult.appliedCount} PII migrations (${piiResult.skippedCount} skipped)`
      );
    }
  }

  // Run Admin database migrations
  const adminMigrationsDir = join(migrationsRoot, 'admin');
  onProgress?.(`📜 Running migrations for ${adminDbName}...`);

  let adminResult: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
  if (!existsSync(adminMigrationsDir)) {
    onProgress?.(`  ⚠️ Admin migrations directory not found: ${adminMigrationsDir}`);
    adminResult = { success: true, appliedCount: 0, skippedCount: 0 };
  } else {
    adminResult = await runD1Migrations(adminDbIdentifier, adminMigrationsDir, onProgress, {
      ...releaseOptionsFor('d1-admin'),
    });
    if (!adminResult.success) {
      onProgress?.(`  ❌ Admin migration failed: ${adminResult.error}`);
    } else {
      onProgress?.(
        `  ✅ Applied ${adminResult.appliedCount} admin migrations (${adminResult.skippedCount} skipped)`
      );
    }
  }

  return {
    success: coreResult.success && piiResult.success && adminResult.success,
    core: coreResult,
    pii: piiResult,
    admin: adminResult,
  };
}

async function resolveMigrationRootOrError(
  rootDir: string,
  onProgress?: (message: string) => void,
  options: { strictRoot?: boolean } = {}
): Promise<{ success: true; migrationsRoot: string } | { success: false; error: string }> {
  const migrationSearch = await findMigrationsRoot(rootDir, onProgress, options);
  if (!migrationSearch.path) {
    return {
      success: false,
      error: `Migrations directory not found. Searched:\n${migrationSearch.searchPaths.map((p) => `    - ${p}`).join('\n')}`,
    };
  }
  return { success: true, migrationsRoot: migrationSearch.path };
}

export async function getD1MigrationStatusForEnvironment(
  env: string,
  rootDir: string,
  onProgress?: (message: string) => void,
  release?: EnvironmentReleaseMigrationOptions
): Promise<D1MigrationEnvironmentStatus> {
  const { join } = await import('node:path');
  const root = await resolveMigrationRootOrError(rootDir, onProgress, {
    strictRoot: release?.strictMigrationsRoot === true,
  });
  if (!root.success) {
    return { env, success: false, databases: [] };
  }
  const manifest = release
    ? loadTargetReleaseMigrationManifest({
        migrationsRoot: root.migrationsRoot,
        productVersion: release.productVersion,
        allowDraft: release.allowDraft === true,
      }).manifest
    : undefined;
  const manifestFilesFor = (streamId: string) => {
    const stream = manifest?.streams.find((candidate) => candidate.id === streamId);
    if (manifest && !stream) throw new Error(`release_migration_stream_not_found:${streamId}`);
    return stream?.files;
  };

  const coreDbName = getD1DatabaseName(env, 'core-db');
  const piiDbName = getD1DatabaseName(env, 'pii-db');
  const adminDbName = getD1DatabaseName(env, 'admin-db');
  const databaseInputs = [
    {
      role: 'core' as const,
      name: coreDbName,
      identifier: resolveEnvironmentMigrationDatabaseIdentifier({ env, role: 'core', release }),
      migrationsDir: root.migrationsRoot,
      options: {
        excludeTopLevelDirectories: CORE_DB_EXCLUDED_MIGRATION_DIRS,
        materializeSuperseded: true,
        manifestFiles: manifestFilesFor('d1-core'),
      },
    },
    {
      role: 'pii' as const,
      name: piiDbName,
      identifier: resolveEnvironmentMigrationDatabaseIdentifier({ env, role: 'pii', release }),
      migrationsDir: join(root.migrationsRoot, 'pii'),
      options: {
        materializeSuperseded: true,
        manifestFiles: manifestFilesFor('d1-pii'),
      },
    },
    {
      role: 'admin' as const,
      name: adminDbName,
      identifier: resolveEnvironmentMigrationDatabaseIdentifier({ env, role: 'admin', release }),
      migrationsDir: join(root.migrationsRoot, 'admin'),
      options: {
        materializeSuperseded: true,
        manifestFiles: manifestFilesFor('d1-admin'),
      },
    },
  ];
  const databases = await Promise.all(
    databaseInputs.map(async (database) => ({
      ...(await getD1MigrationStatus(
        database.identifier,
        database.migrationsDir,
        database.role,
        database.options
      )),
      // Preserve the stable operator-facing database name while all provider reads use the
      // immutable identifier pinned by the environment lock.
      dbName: database.name,
    }))
  );

  return {
    env,
    success: databases.every((database) => database.success),
    databases,
  };
}

export async function runD1MigrationsForEnvironmentSelection(input: {
  env: string;
  rootDir: string;
  role?: D1MigrationDatabaseRole;
  filenames?: string[];
  onProgress?: (message: string) => void;
  release?: EnvironmentReleaseMigrationOptions;
}): Promise<{
  success: boolean;
  core?: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
  pii?: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
  admin?: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
  error?: string;
}> {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const onlyFiles = input.filenames?.length ? new Set(input.filenames) : undefined;

  if (!input.role && !onlyFiles) {
    return runMigrationsForEnvironment(input.env, input.rootDir, input.onProgress, input.release);
  }

  const root = await resolveMigrationRootOrError(input.rootDir, input.onProgress, {
    strictRoot: input.release?.strictMigrationsRoot === true,
  });
  if (!root.success) {
    return { success: false, error: root.error };
  }

  const roles: D1MigrationDatabaseRole[] = input.role ? [input.role] : ['core', 'pii', 'admin'];
  let exactManifest: ReleaseMigrationManifest | undefined;
  let exactManifestIsDraft = false;
  if (input.release) {
    const target = loadTargetReleaseMigrationManifest({
      migrationsRoot: root.migrationsRoot,
      productVersion: input.release.productVersion,
      allowDraft: input.release.allowDraft === true,
    });
    exactManifest = target.manifest;
    exactManifestIsDraft = target.draft;
  }
  const results: {
    core?: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
    pii?: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
    admin?: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
  } = {};

  for (const role of roles) {
    const dbName = getD1DatabaseName(input.env, `${role}-db`);
    const databaseIdentifier = resolveEnvironmentMigrationDatabaseIdentifier({
      env: input.env,
      role,
      release: input.release,
    });
    const migrationsDir = role === 'core' ? root.migrationsRoot : join(root.migrationsRoot, role);
    const options: RunD1MigrationOptions = {
      onlyFiles,
      ...(role === 'core' ? { excludeTopLevelDirectories: CORE_DB_EXCLUDED_MIGRATION_DIRS } : {}),
    };
    if (exactManifest && input.release) {
      const streamId = role === 'core' ? 'd1-core' : role === 'pii' ? 'd1-pii' : 'd1-admin';
      const stream = exactManifest.streams.find((candidate) => candidate.id === streamId);
      if (!stream) {
        return { success: false, error: `release_migration_stream_not_found:${streamId}` };
      }
      options.manifestFiles = stream.files;
      options.releaseVersion = input.release.productVersion;
      options.backfillLegacyChecksums =
        input.release.backfillLegacyChecksums ?? !exactManifestIsDraft;
    }

    if (!existsSync(migrationsDir)) {
      results[role] = { success: true, appliedCount: 0, skippedCount: 0 };
      continue;
    }

    input.onProgress?.(`📜 Running ${role} migrations for ${dbName}...`);
    results[role] = await runD1Migrations(
      databaseIdentifier,
      migrationsDir,
      input.onProgress,
      options
    );
  }

  return {
    success: Object.values(results).every((result) => result?.success),
    ...results,
  };
}

// =============================================================================
// KV Namespace Operations
// =============================================================================

type KVNamespaceListRow = { title: string; id: string };

function normalizeKVNamespaceRows(rows: unknown): KVNamespaceListRow[] {
  if (!Array.isArray(rows)) {
    throw new TypeError('KV namespace list was not an array');
  }

  return rows.map((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new TypeError(`KV namespace list row ${index} was not an object`);
    }

    const { title, id } = row as { title?: unknown; id?: unknown };
    if (
      typeof title !== 'string' ||
      title.trim().length === 0 ||
      typeof id !== 'string' ||
      id.trim().length === 0
    ) {
      throw new TypeError(`KV namespace list row ${index} did not contain a title and ID`);
    }

    return { title: title.trim(), id: id.trim() };
  });
}

export function parseKVNamespaceListOutput(stdout: string): KVNamespaceListRow[] {
  return assertUniqueNamedResourceInventory({
    rows: parseValidatedJsonOutput(
      stdout,
      normalizeKVNamespaceRows,
      'Wrangler output did not contain a valid KV namespace list'
    ),
    label: 'Wrangler KV namespace inventory',
    name: (row) => row.title,
    id: (row) => row.id,
  });
}

async function listKVNamespacesViaApi(): Promise<KVNamespaceListRow[] | null> {
  return listCloudflarePaginatedResourcesViaApi({
    path: 'storage/kv/namespaces',
    label: 'KV namespace list',
    normalizeRows: normalizeKVNamespaceRows,
    identityKey: (row) => row.id,
  });
}

/**
 * List all KV namespaces
 * @throws Error if wrangler command fails (caller should handle)
 */
export async function listKVNamespaces(): Promise<Array<{ title: string; id: string }>> {
  let apiError: unknown;
  try {
    const apiNamespaces = await listKVNamespacesViaApi();
    if (apiNamespaces) {
      return assertUniqueNamedResourceInventory({
        rows: apiNamespaces,
        label: 'Cloudflare API KV namespace inventory',
        name: (row) => row.title,
        id: (row) => row.id,
      });
    }
  } catch (error) {
    apiError = error;
  }

  try {
    const { stdout, stderr } = await wrangler(['kv', 'namespace', 'list']);

    // Check for auth errors
    if (stderr && stderr.includes('not logged in')) {
      throw new Error('Not logged in to Cloudflare. Run: wrangler login');
    }

    return parseKVNamespaceListOutput(stdout);
  } catch (error) {
    if (apiError) {
      const apiMessage = describeInventoryError(apiError, 'unknown API error');
      const wranglerMessage = describeInventoryError(error, 'unknown Wrangler error');
      throw new Error(
        `Failed to list KV namespaces via the Cloudflare API (${apiMessage}) and Wrangler (${wranglerMessage})`
      );
    }
    if (error instanceof SyntaxError) {
      throw new Error('Failed to parse KV namespace list - wrangler output was not valid JSON');
    }
    throw error;
  }
}

/**
 * Check if a KV namespace exists
 */
export async function kvNamespaceExists(title: string): Promise<{ exists: boolean; id?: string }> {
  const namespaces = await listKVNamespaces();
  const ns = namespaces.find((n) => n.title === title);
  return { exists: !!ns, id: ns?.id };
}

/**
 * Check if admin setup is completed for an environment
 * Uses the KV namespace ID to read the setup:completed flag directly
 */
export async function checkAdminSetupStatus(
  kvNamespaceId: string
): Promise<{ completed: boolean; error?: string }> {
  try {
    const { stdout } = await wrangler([
      'kv',
      'key',
      'get',
      'setup:completed',
      '--namespace-id',
      kvNamespaceId,
      '--remote',
    ]);

    return { completed: stdout.trim() === 'true' };
  } catch (error) {
    // Key not found or other error - assume not completed
    const message = error instanceof Error ? error.message : String(error);
    // "key not found" is expected when setup hasn't been completed
    if (message.includes('key') && message.includes('not found')) {
      return { completed: false };
    }
    return { completed: false, error: message };
  }
}

/**
 * Generate and store a setup token directly to KV namespace
 * Returns the token for constructing the setup URL
 */
export async function generateAndStoreSetupToken(
  kvNamespaceId: string,
  ttlSeconds: number = 3600
): Promise<{ success: boolean; token?: string; expiresAt?: string; error?: string }> {
  try {
    // Generate URL-safe token (32 bytes = 43 characters in base64url)
    const { randomBytes } = await import('node:crypto');
    const token = randomBytes(32).toString('base64url');

    // Calculate expiration time
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    // Store token in KV with TTL
    await withPrivateTemporaryTextFile(token, (tokenPath) =>
      wrangler([
        'kv',
        'key',
        'put',
        'setup:token',
        '--path',
        tokenPath,
        '--namespace-id',
        kvNamespaceId,
        '--ttl',
        ttlSeconds.toString(),
        '--remote',
      ])
    );

    return { success: true, token, expiresAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Create a KV namespace
 */
export async function createKVNamespace(
  name: string,
  preview: boolean = false,
  behavior: ProvisioningCreateBehavior = {}
): Promise<{ id: string; name: string }> {
  const findExisting = async (): Promise<{ id: string; name: string } | null> => {
    const namespaces = await listKVNamespaces();
    const candidateNames = preview ? [`${name}_preview`, name] : [name];
    const existing = namespaces.find((namespace) => candidateNames.includes(namespace.title));
    return existing ? { id: existing.id, name: existing.title } : null;
  };

  const existing = await findExisting();
  if (existing) {
    if (behavior.allowExisting === false) {
      throw new Error(`KV namespace ${name} already exists outside this provisioning attempt`);
    }
    if (behavior.expectedExistingId && behavior.expectedExistingId !== existing.id) {
      throw new Error(`KV namespace ${name} does not match the recorded provisioning resource`);
    }
    return existing;
  }
  if (behavior.recordedState === 'created') {
    throw new Error(`KV namespace ${name} recorded by provisioning is missing`);
  }
  if (behavior.recordedState === 'identified') {
    if (!behavior.expectedExistingId) {
      throw new Error(`KV namespace ${name} identified checkpoint omitted its immutable ID`);
    }
    return waitForProviderResourceVisible({
      resourceDescription: `KV namespace ${name}`,
      expectedId: behavior.expectedExistingId,
      findExisting,
    });
  }
  if (behavior.recordedState === 'create_issued') {
    throw new Error(
      `KV namespace ${name} has an interrupted create_issued checkpoint without immutable ` +
        'provider evidence. Setup will not reissue the create; inspect Cloudflare and recover explicitly.'
    );
  }

  const args = ['kv', 'namespace', 'create', name];
  if (preview) {
    args.push('--preview');
  }

  await behavior.onCreateIssued?.();

  let stdout: string;
  try {
    ({ stdout } = await wranglerCreateWithDefiniteRejectionRetry(args));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isAmbiguousCloudflareMutationFailure(message)) {
      return throwDefiniteProvisioningCreateFailure(behavior, error, `KV namespace ${name}`);
    }
    const responseId = message.match(
      /"(?:id|namespace_id|preview_id)"\s*:\s*"([a-f0-9]{32})"/iu
    )?.[1];
    if (!responseId) {
      throw new Error(
        `KV namespace ${name} creation outcome is ambiguous and Cloudflare returned no immutable ` +
          'namespace ID. Setup will not adopt a same-name namespace; inspect or delete it before retrying.',
        { cause: error }
      );
    }
    await behavior.onProviderIdentityIdentified?.({ id: responseId });
    return waitForProviderResourceVisible({
      resourceDescription: `KV namespace ${name}`,
      createError: error,
      expectedId: responseId,
      findExisting,
    });
  }

  // Extract ID from output
  // Format: "id": "abc123..." or "preview_id": "abc123..."
  const idKey = preview ? 'preview_id' : 'id';
  const createdId = stdout.match(new RegExp(`"${idKey}"\\s*:\\s*"([a-f0-9]{32})"`, 'i'))?.[1];
  if (!createdId) {
    throw new Error(
      `KV namespace ${name} create succeeded but returned no immutable namespace ID. ` +
        'Setup will not adopt a same-name namespace; inspect the provider inventory before retrying.'
    );
  }
  await behavior.onProviderIdentityIdentified?.({ id: createdId });
  return waitForProviderResourceVisible({
    resourceDescription: `KV namespace ${name}`,
    expectedId: createdId,
    findExisting,
  });
}

async function deleteKVNamespaceWithResult(
  namespaceId: string,
  credentials?: CloudflareDeletionCredentials
): Promise<ExactResourceDeleteResult> {
  let resolved = credentials;
  try {
    resolved ??= (await resolveCloudflareInventoryCredentials()) ?? undefined;
  } catch (error) {
    return { status: 'failed', error: sanitizeError(error) };
  }
  if (!resolved) {
    return { status: 'failed', error: 'Cloudflare KV API credentials are unavailable' };
  }
  return deleteCloudflareAccountResourceById({
    credentials: resolved,
    resourcePath: 'storage/kv/namespaces',
    resourceId: namespaceId,
    label: 'Cloudflare KV namespace delete',
  });
}

/** Delete a KV namespace by its immutable Cloudflare namespace ID. */
export async function deleteKVNamespace(namespaceId: string): Promise<boolean> {
  const result = await deleteKVNamespaceWithResult(namespaceId);
  return result.status !== 'failed';
}

/**
 * Put a value in KV
 *
 * NOTE: Values are written via a temporary file using --path instead of being
 * passed as a positional CLI argument. This avoids a wrangler parsing bug where
 * values starting with '-' (valid in base64url tokens) are misinterpreted as flags.
 */
export async function kvPut(
  namespaceId: string,
  key: string,
  value: string,
  options: { expirationTtl?: number } = {}
): Promise<boolean> {
  try {
    await withPrivateTemporaryTextFile(value, async (valuePath) => {
      const args = [
        'kv',
        'key',
        'put',
        key,
        '--path',
        valuePath,
        '--namespace-id',
        namespaceId,
        '--remote',
      ];
      if (options.expirationTtl) {
        args.push('--expiration-ttl', options.expirationTtl.toString());
      }
      await wranglerCreateWithDefiniteRejectionRetry(args);
    });
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Queue Operations
// =============================================================================

async function createQueueViaApi(name: string): Promise<{ id: string; name: string } | null> {
  let credentials = await resolveCloudflareInventoryCredentials();
  if (!credentials) {
    // Unit tests without a Cloudflare credential exercise the legacy Wrangler parser. A real
    // provisioning run must use REST create so queue_id is part of the create response.
    if (process.env.NODE_ENV === 'test') return null;
    throw new Error('Cloudflare Queue API credentials are unavailable');
  }

  for (let attempt = 1; attempt <= D1_MIGRATION_AUTH_MAX_ATTEMPTS; attempt++) {
    const { response, data } = await requestCloudflareApiJson<{
      success?: boolean;
      result?: { queue_id?: unknown; queue_name?: unknown };
      errors?: CloudflareApiMessage[];
    }>(
      `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/queues`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ queue_name: name }),
      },
      { label: 'Cloudflare Queue create', retryMode: 'non_idempotent_mutation' }
    );
    const queueId = typeof data.result?.queue_id === 'string' ? data.result.queue_id.trim() : '';
    const queueName =
      typeof data.result?.queue_name === 'string' ? data.result.queue_name.trim() : '';
    if (response.ok && data.success !== false) {
      if (!queueId || queueName !== name) {
        throw new Error(
          `Queue ${name} create succeeded but the Cloudflare API omitted its exact queue_id`
        );
      }
      return { id: queueId, name: queueName };
    }

    const detail = (data.errors ?? [])
      .map((entry) => `${entry.message ?? 'Cloudflare error'} [code: ${entry.code ?? 'unknown'}]`)
      .join('; ');
    const message = `HTTP status ${response.status}: ${detail || 'Queue create failed'}`;
    const errorCodes = (data.errors ?? []).flatMap((error) =>
      typeof error.code === 'number' ? [error.code] : []
    );
    if (
      shouldRefreshCloudflareOAuthCredential({
        status: response.status,
        errorCodes,
        source: credentials.source,
        attempt,
      })
    ) {
      const refreshed = await refreshPinnedCloudflareOAuthToken(credentials.accountId);
      if (refreshed) {
        credentials = refreshed;
        continue;
      }
    }
    const definitelyRejected = isD1AuthenticationError(message) || isD1RateLimitError(message);
    if (definitelyRejected && attempt < D1_MIGRATION_AUTH_MAX_ATTEMPTS) {
      const delayMs = d1MigrationRetryDelayMs(attempt);
      if (delayMs > 0) await sleep(delayMs);
      continue;
    }
    throw new Error(message);
  }
  throw new Error(`Queue ${name} API create retry loop exited unexpectedly`);
}

/**
 * Create a Queue
 */
export async function createQueue(
  name: string,
  behavior: ProvisioningCreateBehavior = {}
): Promise<{ id: string; name: string; providerId?: string }> {
  const findExisting = async (): Promise<{ id?: string; name: string } | null> => {
    const existing = (
      await listQueues({
        strictOutput: true,
        requireIds: true,
      })
    ).find((queue) => queue.name === name);
    return existing ? { id: existing.id, name: existing.name } : null;
  };
  const acceptExisting = (
    existing: { id?: string; name: string },
    createdId?: string
  ): { id: string; name: string; providerId?: string } => {
    const providerId = existing.id ?? createdId;
    if (!providerId) {
      throw new Error(`Queue ${name} immutable provider ID could not be verified`);
    }
    if (behavior.expectedExistingId && providerId && behavior.expectedExistingId !== providerId) {
      throw new Error(`Queue ${name} does not match the recorded provisioning resource`);
    }
    return {
      id: providerId,
      name: existing.name,
      providerId,
    };
  };

  const existing = await findExisting();
  if (existing) {
    if (behavior.allowExisting === false) {
      throw new Error(`Queue ${name} already exists outside this provisioning attempt`);
    }
    return acceptExisting(existing);
  }
  if (behavior.recordedState === 'created') {
    throw new Error(`Queue ${name} recorded by provisioning is missing`);
  }
  if (behavior.recordedState === 'identified') {
    if (!behavior.expectedExistingId) {
      throw new Error(`Queue ${name} identified checkpoint omitted its immutable provider ID`);
    }
    return waitForProviderResourceVisible({
      resourceDescription: `Queue ${name}`,
      expectedId: behavior.expectedExistingId,
      findExisting: async () => {
        const reconciled = await findExisting();
        return reconciled ? acceptExisting(reconciled, behavior.expectedExistingId) : null;
      },
    });
  }
  if (behavior.recordedState === 'create_issued') {
    throw new Error(
      `Queue ${name} has an interrupted create_issued checkpoint without immutable provider ` +
        'evidence. Setup will not reissue the create; inspect Cloudflare and recover explicitly.'
    );
  }

  await behavior.onCreateIssued?.();

  let createdId: string | undefined;
  let usedWranglerFallback = false;
  try {
    const apiCreated = await createQueueViaApi(name);
    if (apiCreated) {
      createdId = apiCreated.id;
    } else {
      usedWranglerFallback = true;
      const { stdout } = await wranglerCreateWithDefiniteRejectionRetry(['queues', 'create', name]);
      createdId = stdout.match(/"id"\s*:\s*"([^"]+)"/)?.[1];
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isAmbiguousCloudflareMutationFailure(message)) {
      return throwDefiniteProvisioningCreateFailure(behavior, error, `Queue ${name}`);
    }
    // The production REST response identifies this resource specifically as queue_id. Never treat
    // a generic request/ray `id` as provider identity, and never adopt identity text found in the
    // credential-free Wrangler test fallback's stderr.
    const responseId = usedWranglerFallback
      ? undefined
      : message.match(/"queue_id"\s*:\s*"([A-Za-z0-9_-]{1,128})"/u)?.[1];
    if (!responseId) {
      throw new Error(
        `Queue ${name} creation outcome is ambiguous and Cloudflare returned no immutable queue ` +
          'ID. Setup will not adopt a same-name Queue; inspect or delete it before retrying.',
        { cause: error }
      );
    }
    await behavior.onProviderIdentityIdentified?.({ id: responseId });
    return waitForProviderResourceVisible({
      resourceDescription: `Queue ${name}`,
      createError: error,
      expectedId: responseId,
      findExisting: async () => {
        const reconciled = await findExisting();
        return reconciled ? acceptExisting(reconciled, responseId) : null;
      },
    });
  }

  if (createdId) {
    await behavior.onProviderIdentityIdentified?.({ id: createdId });
  }

  // The production REST path supplies queue_id. Wrangler 4.x does not; its path above exists only
  // for credential-free unit tests and must never become a production name-adoption fallback.
  const visibilityAttempts = process.env.NODE_ENV === 'test' ? 2 : 5;
  for (let attempt = 1; attempt <= visibilityAttempts; attempt++) {
    const reconciled = await findExisting();
    if (reconciled) {
      return acceptExisting(reconciled, createdId);
    }
    if (attempt < visibilityAttempts) {
      await sleep(Math.min(500 * 2 ** (attempt - 1), 4_000));
    }
  }
  throw new Error(`Queue ${name} was not visible after creation`);
}

export function getQueueConsumerWorkerNamesForDeletion(
  env: string,
  workers: Array<{ name: string }>
): string[] {
  return Array.from(
    new Set(
      workers
        .map((worker) => worker.name)
        // setup/wrangler.ts configures ar-management as the consumer for every Authrim Queue.
        // Producer-only Workers must not receive consumer removal requests.
        .filter((workerName) => workerName === `${env}-ar-management`)
    )
  ).sort();
}

export async function deleteQueueConsumer(queueName: string, workerName: string): Promise<boolean> {
  const result = await deleteQueueConsumerWithResult(queueName, workerName);
  return result.status === 'detached' || result.status === 'already_absent';
}

type QueueConsumerDetachResult =
  | { status: 'detached' }
  | { status: 'already_absent'; error: string }
  | { status: 'failed'; error: string };

type QueueConsumerRestoreResult = { status: 'attached' } | { status: 'failed'; error: string };

function isQueueConsumerAlreadyAbsentError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    isCloudflareResourceAlreadyAbsent(error) ||
    /(?:not attached|already removed|consumer[^\n]*(?:not found|does not exist)|does not have[^\n]*consumer|no such consumer)/iu.test(
      detail
    )
  );
}

async function deleteQueueConsumerWithResult(
  queueName: string,
  workerName: string
): Promise<QueueConsumerDetachResult> {
  try {
    await wrangler(['queues', 'consumer', 'worker', 'remove', queueName, workerName]);
    return { status: 'detached' };
  } catch (error) {
    const detail = sanitizeError(error);
    return isQueueConsumerAlreadyAbsentError(error)
      ? { status: 'already_absent', error: detail }
      : { status: 'failed', error: detail };
  }
}

export interface QueueConsumerDetachSummary {
  removed: Array<{ queueName: string; workerName: string }>;
  errors: string[];
}

interface ExactQueueWorkerConsumerSnapshot {
  queueId: string;
  queueName: string;
  consumerId: string;
  workerName: string;
  restorePayload: {
    type: 'worker';
    script_name: string;
    dead_letter_queue?: string;
    settings?: Record<string, unknown>;
  };
}

async function listExactQueueWorkerConsumers(input: {
  queues: readonly DeletionResourceIdentity[];
  workerNames: readonly string[];
  credentials: CloudflareDeletionCredentials;
}): Promise<ExactQueueWorkerConsumerSnapshot[]> {
  const targets = new Set(input.workerNames);
  const snapshots: ExactQueueWorkerConsumerSnapshot[] = [];
  const consumerIds = new Set<string>();
  for (const queue of input.queues) {
    const queueId = normalizeDeletionResourceId(queue.id, 'Cloudflare Queue consumer inventory');
    const { response, data } = await requestCloudflareApiJson<{
      success?: boolean;
      errors?: CloudflareApiMessage[];
      messages?: CloudflareApiMessage[];
      result?: Array<{
        consumer_id?: unknown;
        type?: unknown;
        script_name?: unknown;
        dead_letter_queue?: unknown;
        settings?: unknown;
      }>;
      result_info?: { page?: unknown; total_pages?: unknown };
    }>(
      `https://api.cloudflare.com/client/v4/accounts/${input.credentials.accountId}/queues/${encodeURIComponent(queueId)}/consumers`,
      { headers: { Authorization: `Bearer ${input.credentials.token}` } },
      {
        label: `Cloudflare Queue consumer inventory for ${queue.name}`,
        retryMode: 'read',
      }
    );
    if (!response.ok || data.success === false || !Array.isArray(data.result)) {
      const detail = formatCloudflareApiMessages(data);
      throw new Error(
        `Cloudflare Queue consumer inventory failed for ${queue.name} (${response.status})${detail ? `: ${detail}` : ''}`
      );
    }
    if (
      (data.result_info?.page !== undefined && data.result_info.page !== 1) ||
      (data.result_info?.total_pages !== undefined && data.result_info.total_pages !== 1)
    ) {
      throw new Error(`Cloudflare Queue consumer inventory was incomplete for ${queue.name}`);
    }
    if (data.result.length > CLOUDFLARE_INVENTORY_MAX_RESOURCES) {
      throw new Error(`Cloudflare Queue consumer inventory exceeded the safety limit`);
    }
    const workersSeen = new Set<string>();
    for (const [index, consumer] of data.result.entries()) {
      if (consumer.type !== 'worker') continue;
      const consumerId =
        typeof consumer.consumer_id === 'string' ? consumer.consumer_id.trim() : '';
      const workerName =
        typeof consumer.script_name === 'string' ? consumer.script_name.trim() : '';
      if (!consumerId || !workerName || consumerId.length > 256 || workerName.length > 256) {
        throw new Error(
          `Cloudflare Queue consumer inventory row ${index} was invalid for ${queue.name}`
        );
      }
      const scopedConsumerId = `${queueId}:${consumerId}`;
      if (consumerIds.has(scopedConsumerId)) {
        throw new Error(`Cloudflare Queue consumer inventory contained duplicate immutable IDs`);
      }
      consumerIds.add(scopedConsumerId);
      if (!targets.has(workerName)) continue;
      if (workersSeen.has(workerName)) {
        throw new Error(
          `Cloudflare Queue consumer inventory was ambiguous for ${queue.name} -> ${workerName}`
        );
      }
      workersSeen.add(workerName);
      const deadLetterQueue =
        typeof consumer.dead_letter_queue === 'string' && consumer.dead_letter_queue.length > 0
          ? consumer.dead_letter_queue
          : undefined;
      const settings =
        consumer.settings &&
        typeof consumer.settings === 'object' &&
        !Array.isArray(consumer.settings)
          ? (consumer.settings as Record<string, unknown>)
          : undefined;
      snapshots.push({
        queueId,
        queueName: queue.name,
        consumerId,
        workerName,
        restorePayload: {
          type: 'worker',
          script_name: workerName,
          ...(deadLetterQueue ? { dead_letter_queue: deadLetterQueue } : {}),
          ...(settings ? { settings } : {}),
        },
      });
    }
  }
  return snapshots;
}

async function deleteExactQueueWorkerConsumer(
  consumer: ExactQueueWorkerConsumerSnapshot,
  credentials: CloudflareDeletionCredentials
): Promise<ExactResourceDeleteResult> {
  return deleteCloudflareAccountResourceById({
    credentials,
    resourcePath: `queues/${encodeURIComponent(consumer.queueId)}/consumers`,
    resourceId: consumer.consumerId,
    label: `Cloudflare Queue consumer delete for ${consumer.queueName}`,
  });
}

async function restoreExactQueueWorkerConsumer(
  consumer: ExactQueueWorkerConsumerSnapshot,
  credentials: CloudflareDeletionCredentials
): Promise<QueueConsumerRestoreResult> {
  try {
    const { response, data } = await requestCloudflareApiJson<{
      success?: boolean;
      errors?: CloudflareApiMessage[];
      messages?: CloudflareApiMessage[];
    }>(
      `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/queues/${encodeURIComponent(consumer.queueId)}/consumers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(consumer.restorePayload),
      },
      {
        label: `Cloudflare Queue consumer restore for ${consumer.queueName}`,
        retryMode: 'non_idempotent_mutation',
        maxAttempts: 1,
      }
    );
    if (response.ok && data.success !== false) return { status: 'attached' };
    const detail = formatCloudflareApiMessages(data);
    return {
      status: 'failed',
      error: `Cloudflare Queue consumer restore failed (${response.status})${detail ? `: ${detail}` : ''}`,
    };
  } catch (error) {
    return { status: 'failed', error: sanitizeError(error) };
  }
}

async function deleteExactQueueConsumers(
  consumers: readonly ExactQueueWorkerConsumerSnapshot[],
  credentials: CloudflareDeletionCredentials,
  onProgress?: (message: string) => void
): Promise<{ removed: ExactQueueWorkerConsumerSnapshot[]; errors: string[] }> {
  const removed: ExactQueueWorkerConsumerSnapshot[] = [];
  const errors: string[] = [];
  for (const consumer of consumers) {
    onProgress?.(`  ⏳ Detaching ${consumer.workerName} from ${consumer.queueName}...`);
    const result = await deleteExactQueueWorkerConsumer(consumer, credentials);
    if (result.status === 'deleted') {
      removed.push(consumer);
      onProgress?.(`  ✅ ${consumer.queueName} -> ${consumer.workerName}`);
    } else if (result.status === 'already_absent') {
      onProgress?.(
        `  ⚠️ ${consumer.queueName} -> ${consumer.workerName} (not attached or already removed)`
      );
    } else {
      errors.push(
        `Failed to detach Queue consumer: ${consumer.queueName} -> ${consumer.workerName} (${result.error})`
      );
      onProgress?.(`  ❌ ${consumer.queueName} -> ${consumer.workerName} - ${result.error}`);
    }
  }
  return { removed, errors };
}

async function restoreExactQueueConsumers(
  consumers: readonly ExactQueueWorkerConsumerSnapshot[],
  credentials: CloudflareDeletionCredentials,
  onProgress?: (message: string) => void
): Promise<string[]> {
  const errors: string[] = [];
  for (const consumer of consumers) {
    onProgress?.(`  ⏳ Restoring ${consumer.workerName} on ${consumer.queueName}...`);
    const result = await restoreExactQueueWorkerConsumer(consumer, credentials);
    if (result.status === 'attached') {
      onProgress?.(`  ✅ Restored ${consumer.queueName} -> ${consumer.workerName}`);
    } else {
      errors.push(
        `Failed to restore Queue consumer: ${consumer.queueName} -> ${consumer.workerName} (${result.error})`
      );
      onProgress?.(
        `  ❌ Could not restore ${consumer.queueName} -> ${consumer.workerName} - ${result.error}`
      );
    }
  }
  return errors;
}

export async function deleteQueueConsumersForWorkers(
  queues: Array<{ name: string }>,
  workerNames: string[],
  onProgress?: (message: string) => void
): Promise<QueueConsumerDetachSummary> {
  const removed: Array<{ queueName: string; workerName: string }> = [];
  const errors: string[] = [];
  for (const workerName of workerNames) {
    for (const queue of queues) {
      onProgress?.(`  ⏳ Detaching ${workerName} from ${queue.name}...`);
      const result = await deleteQueueConsumerWithResult(queue.name, workerName);
      if (result.status === 'detached') {
        removed.push({ queueName: queue.name, workerName });
        onProgress?.(`  ✅ ${queue.name} -> ${workerName}`);
      } else if (result.status === 'already_absent') {
        onProgress?.(`  ⚠️ ${queue.name} -> ${workerName} (not attached or already removed)`);
      } else {
        const message =
          `Failed to detach Queue consumer: ${queue.name} -> ${workerName} ` + `(${result.error})`;
        errors.push(message);
        onProgress?.(`  ❌ ${queue.name} -> ${workerName} - ${result.error}`);
      }
    }
  }
  return { removed, errors };
}

// =============================================================================
// R2 Bucket Operations
// =============================================================================

const R2_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export interface R2ManualCleanupTarget {
  bucketName: string;
  objectCount: number;
  dashboardUrl: string | null;
}

export type R2BucketDeleteResult =
  | { status: 'deleted' }
  | { status: 'manual_cleanup_required'; target: R2ManualCleanupTarget }
  | { status: 'failed'; error: string };

export function getR2BucketDashboardUrl(
  accountId: string | null | undefined,
  bucketName: string | null | undefined
): string | null {
  if (
    !accountId ||
    !/^[a-f0-9]{32}$/u.test(accountId) ||
    !bucketName ||
    !R2_BUCKET_NAME_PATTERN.test(bucketName)
  ) {
    return null;
  }

  return `https://dash.cloudflare.com/${accountId}/r2/default/buckets/${encodeURIComponent(bucketName)}`;
}

function assertSafeR2ObjectKey(key: string): void {
  const segments = key.split('/');
  if (
    key.length === 0 ||
    key.length > 1024 ||
    key.startsWith('/') ||
    key.endsWith('/') ||
    key.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    Array.from(key).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new Error('invalid_r2_object_key');
  }
}

async function wranglerR2ObjectWithOAuthRefresh(
  args: string[],
  options: { timeout: number }
): Promise<{ stdout: string; stderr: string }> {
  const oauthRefresh: WranglerOAuthRefreshState = { attempted: false };
  try {
    return await wrangler(args, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const oauthAuthenticationRejected =
      !process.env.CLOUDFLARE_API_TOKEN?.trim() &&
      (isD1AuthenticationError(message) || /\b(?:http(?: status)?\s*)?401\b/iu.test(message));
    if (!oauthAuthenticationRejected) throw error;
    // Authentication rejection is known not to have committed. Refresh the Wrangler OAuth
    // credential once, then safely retry the same object-key operation.
    if (!(await refreshWranglerOAuthSession(message, oauthRefresh))) throw error;
    return wrangler(args, options);
  }
}

export async function putR2Object(input: {
  bucketName: string;
  objectKey: string;
  bytes: Uint8Array;
  contentType: 'application/json' | 'application/sql';
}): Promise<void> {
  if (!R2_BUCKET_NAME_PATTERN.test(input.bucketName)) throw new Error('invalid_r2_bucket_name');
  assertSafeR2ObjectKey(input.objectKey);
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > 16 * 1024 * 1024) {
    throw new Error('invalid_r2_object_size');
  }
  await withPrivateTemporaryBinaryFile(
    input.bytes,
    async (temporaryPath) => {
      await wranglerR2ObjectWithOAuthRefresh(
        [
          'r2',
          'object',
          'put',
          `${input.bucketName}/${input.objectKey}`,
          '--remote',
          '--file',
          temporaryPath,
          '--content-type',
          input.contentType,
        ],
        { timeout: 180_000 }
      );
    },
    { directoryPrefix: 'authrim-r2-put-', filename: 'artifact.bin' }
  );
}

export async function getR2ObjectBytes(input: {
  bucketName: string;
  objectKey: string;
  maxBytes?: number;
}): Promise<Uint8Array | null> {
  if (!R2_BUCKET_NAME_PATTERN.test(input.bucketName)) throw new Error('invalid_r2_bucket_name');
  assertSafeR2ObjectKey(input.objectKey);
  const maxBytes = input.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) {
    throw new Error('invalid_r2_object_size_limit');
  }
  return withPrivateTemporaryOutputFile(
    async (temporaryPath, access) => {
      try {
        await wranglerR2ObjectWithOAuthRefresh(
          [
            'r2',
            'object',
            'get',
            `${input.bucketName}/${input.objectKey}`,
            '--remote',
            '--file',
            temporaryPath,
          ],
          { timeout: 180_000 }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not found|10007|404/iu.test(message)) return null;
        throw error;
      }
      return access.readBytes(maxBytes, 'r2_object_size_limit_exceeded');
    },
    { directoryPrefix: 'authrim-r2-get-', filename: 'artifact.bin' }
  );
}

const R2_OWNERSHIP_MARKER_PREFIX = '__authrim_setup__/ownership-v1-';

export function buildR2OwnershipMarkerKey(ownershipId: string): string {
  if (!/^[a-f0-9-]{36}$/u.test(ownershipId)) throw new Error('invalid_r2_ownership_id');
  return `${R2_OWNERSHIP_MARKER_PREFIX}${ownershipId}.json`;
}

function encodeR2ObjectKeyPath(objectKey: string): string {
  // Cloudflare requires '/' inside R2 keys to remain literal. Dot-only segments are encoded
  // explicitly so URL normalization cannot redirect a request outside the intended object path.
  return objectKey
    .split('/')
    .map((segment) =>
      segment === '.' ? '%2E' : segment === '..' ? '%2E%2E' : encodeURIComponent(segment)
    )
    .join('/');
}

function buildR2OwnershipMarkerPayload(input: {
  environment: string;
  binding: string;
  bucketName: string;
  ownershipId: string;
}): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({
      version: 1,
      environment: input.environment,
      binding: input.binding,
      bucketName: input.bucketName,
      ownershipId: input.ownershipId,
    })}\n`
  );
}

export async function assertR2OwnershipMarker(input: {
  bucketName: string;
  markerKey: string;
  ownershipId: string;
  environment?: string;
  binding?: string;
}): Promise<void> {
  if (input.markerKey !== buildR2OwnershipMarkerKey(input.ownershipId)) {
    throw new Error(`R2 ownership marker identity is invalid for ${input.bucketName}`);
  }

  const credentials = await getR2ApiCredentials();
  let marker: Uint8Array | null;
  if (credentials) {
    const rows = await listR2ObjectRowsViaApi({
      bucketName: input.bucketName,
      credentials,
      prefix: input.markerKey,
    });
    if (!rows.some((row) => row.key === input.markerKey)) {
      throw new Error(`R2 ownership marker is missing for ${input.bucketName}`);
    }
    marker = await getR2ObjectBytesViaApi({
      bucketName: input.bucketName,
      objectKey: input.markerKey,
      credentials,
      maxBytes: 4 * 1024,
    });
  } else {
    marker = await getR2ObjectBytes({
      bucketName: input.bucketName,
      objectKey: input.markerKey,
      maxBytes: 4 * 1024,
    });
  }
  if (!marker) throw new Error(`R2 ownership marker is missing for ${input.bucketName}`);
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(marker));
  } catch {
    throw new Error(`R2 ownership marker is invalid for ${input.bucketName}`);
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    (payload as { version?: unknown }).version !== 1 ||
    (payload as { ownershipId?: unknown }).ownershipId !== input.ownershipId ||
    (payload as { bucketName?: unknown }).bucketName !== input.bucketName ||
    (input.environment !== undefined &&
      (payload as { environment?: unknown }).environment !== input.environment) ||
    (input.binding !== undefined && (payload as { binding?: unknown }).binding !== input.binding)
  ) {
    throw new Error(`R2 ownership marker does not match ${input.bucketName}`);
  }
}

export async function writeAndVerifyR2OwnershipMarker(input: {
  environment: string;
  binding: string;
  bucketName: string;
  markerKey: string;
  ownershipId: string;
}): Promise<void> {
  try {
    await putR2Object({
      bucketName: input.bucketName,
      objectKey: input.markerKey,
      bytes: buildR2OwnershipMarkerPayload(input),
      contentType: 'application/json',
    });
  } catch (error) {
    // A lost Wrangler response may still follow a committed object PUT. Exact readback is the
    // only safe authority to continue; otherwise preserve the bucket for explicit recovery.
    await assertR2OwnershipMarker(input).catch(() => {
      throw error;
    });
  }
  await assertR2OwnershipMarker(input);
}

async function restoreR2OwnershipMarkerAfterAmbiguousDelete(
  identity: ExactDeletionR2Identity
): Promise<void> {
  await putR2Object({
    bucketName: identity.name,
    objectKey: identity.ownershipMarkerKey,
    bytes: new TextEncoder().encode(
      `${JSON.stringify({
        version: 1,
        bucketName: identity.name,
        ownershipId: identity.ownershipId,
        ...(identity.environment ? { environment: identity.environment } : {}),
        ...(identity.binding ? { binding: identity.binding } : {}),
        restoredAfterAmbiguousDelete: true,
      })}\n`
    ),
    contentType: 'application/json',
  });
  await assertR2OwnershipMarker({
    bucketName: identity.name,
    markerKey: identity.ownershipMarkerKey,
    ownershipId: identity.ownershipId,
  });
}

/**
 * Create an R2 bucket
 */
export async function createR2Bucket(
  name: string,
  behavior: { allowExisting?: boolean } = {}
): Promise<{ name: string }> {
  try {
    await wranglerCreateWithDefiniteRejectionRetry(['r2', 'bucket', 'create', name]);
    return { name };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isAlreadyExistsError(message)) {
      throw error;
    }
    if (behavior.allowExisting === false) throw error;
    return { name };
  }
}

function isAlreadyExistsError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('already exists') ||
    normalized.includes('already in use') ||
    normalized.includes('conflict') ||
    normalized.includes('409')
  );
}

export interface R2BucketProviderIdentity {
  name: string;
  creationDate?: string;
}

function normalizeCloudflareTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} was not a valid timestamp`);
  }
  return new Date(value).toISOString();
}

export function parseR2BucketRows(stdout: string): R2BucketProviderIdentity[] {
  try {
    const parsed = JSON.parse(stdout) as
      | Array<{ name?: unknown; creation_date?: unknown; creationDate?: unknown }>
      | {
          buckets?: Array<{ name?: unknown; creation_date?: unknown; creationDate?: unknown }>;
          result?: Array<{ name?: unknown; creation_date?: unknown; creationDate?: unknown }>;
        };
    const rows = Array.isArray(parsed) ? parsed : (parsed.buckets ?? parsed.result ?? []);
    return rows
      .map((row) => ({
        name: typeof row.name === 'string' ? row.name.trim() : '',
        creationDate: normalizeCloudflareTimestamp(
          row.creation_date ?? row.creationDate,
          'R2 bucket creation_date'
        ),
      }))
      .filter((row) => row.name.length > 0);
  } catch {
    // Wrangler has emitted plain text in older versions. Keep a conservative fallback.
  }

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const nameMatch = line.match(/^name:\s+(.+)$/i);
      if (nameMatch?.[1]) {
        return [{ name: nameMatch[1].trim() }];
      }
      if (/^[a-z0-9][a-z0-9-]*$/i.test(line)) {
        return [{ name: line }];
      }
      return [];
    });
}

function normalizeR2BucketRows(rows: unknown): R2BucketProviderIdentity[] {
  if (!Array.isArray(rows)) {
    throw new TypeError('R2 bucket list was not an array');
  }
  return rows.map((row, index) => {
    const name =
      row && typeof row === 'object' && 'name' in row
        ? (row as { name?: unknown }).name
        : undefined;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TypeError(`R2 bucket list row ${index} did not contain a name`);
    }
    const value = row as { creation_date?: unknown; creationDate?: unknown };
    const creationDate = normalizeCloudflareTimestamp(
      value.creation_date ?? value.creationDate,
      `R2 bucket list row ${index} creation_date`
    );
    return { name: name.trim(), ...(creationDate ? { creationDate } : {}) };
  });
}

function extractR2BucketRowsFromApiPayload(payload: unknown): R2BucketProviderIdentity[] {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('Cloudflare R2 bucket list returned an invalid response');
  }

  const data = payload as {
    success?: unknown;
    result?: unknown;
    buckets?: unknown;
  };
  if (data.success === false) {
    throw new Error('Cloudflare R2 bucket list returned an unsuccessful response');
  }
  if (data.result && typeof data.result === 'object' && !Array.isArray(data.result)) {
    const result = data.result as { buckets?: unknown };
    return normalizeR2BucketRows(result.buckets);
  }
  return normalizeR2BucketRows(data.result ?? data.buckets);
}

function extractR2BucketCursorFromApiPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('Cloudflare R2 bucket list returned an invalid response');
  }

  const resultInfo = (payload as { result_info?: unknown }).result_info;
  if (resultInfo === undefined) return undefined;
  if (!resultInfo || typeof resultInfo !== 'object' || Array.isArray(resultInfo)) {
    throw new TypeError('Cloudflare R2 bucket list returned invalid pagination metadata');
  }

  const { cursor, per_page: perPage } = resultInfo as {
    cursor?: unknown;
    per_page?: unknown;
  };
  if (
    perPage !== undefined &&
    (typeof perPage !== 'number' ||
      !Number.isInteger(perPage) ||
      perPage < 1 ||
      perPage > R2_BUCKET_LIST_PER_PAGE)
  ) {
    throw new TypeError('Cloudflare R2 bucket list returned an invalid page size');
  }
  if (cursor === undefined || cursor === null || cursor === '') return undefined;
  if (typeof cursor !== 'string' || cursor.trim().length === 0 || cursor.length > 8_192) {
    throw new TypeError('Cloudflare R2 bucket list returned an invalid pagination cursor');
  }
  return cursor.trim();
}

function isRecognizedR2BucketListOutput(stdout: string): boolean {
  const trimmed = stripAnsiSequences(stdout).trim();
  if (trimmed.length === 0 || /no\s+(?:r2\s+)?buckets?\s+(?:found|exist)/iu.test(trimmed)) {
    return true;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return true;
    if (parsed && typeof parsed === 'object') {
      const value = parsed as { buckets?: unknown; result?: unknown };
      return Array.isArray(value.buckets) || Array.isArray(value.result);
    }
  } catch {
    // Continue with the documented legacy plain-text forms.
  }
  return parseR2BucketRows(trimmed).length > 0;
}

async function listR2BucketsViaApi(): Promise<R2BucketProviderIdentity[] | null> {
  if (
    process.env.NODE_ENV === 'test' &&
    (!process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || !process.env.CLOUDFLARE_API_TOKEN?.trim())
  ) {
    return null;
  }

  const credentials = await resolveCloudflareInventoryCredentials();
  if (!credentials) return null;

  const buckets: R2BucketProviderIdentity[] = [];
  const bucketNames = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 1; page <= R2_BUCKET_LIST_MAX_PAGES; page++) {
    const params = new URLSearchParams({ per_page: String(R2_BUCKET_LIST_PER_PAGE) });
    if (cursor) params.set('cursor', cursor);
    const { data } = await requestR2Api<CloudflareR2BucketListResponse>(
      `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/r2/buckets?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${credentials.token}`,
        },
      },
      'Cloudflare R2 bucket list',
      false,
      credentials.source
    );
    const rows = extractR2BucketRowsFromApiPayload(data);
    for (const row of rows) {
      if (bucketNames.has(row.name)) {
        throw new Error('Cloudflare R2 bucket list returned a duplicate bucket name');
      }
      bucketNames.add(row.name);
      buckets.push(row);
    }

    const nextCursor = extractR2BucketCursorFromApiPayload(data);
    if (!nextCursor) return buckets;
    if (rows.length === 0) {
      throw new Error('Cloudflare R2 bucket list returned a cursor after an empty page');
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error('Cloudflare R2 bucket list returned a repeated pagination cursor');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error(
    `Cloudflare R2 bucket list exceeded the ${R2_BUCKET_LIST_MAX_PAGES}-page safety limit`
  );
}

function assertR2BucketIdentityComplete(
  bucket: R2BucketProviderIdentity
): asserts bucket is R2BucketProviderIdentity & { creationDate: string } {
  if (!bucket.creationDate) {
    throw new Error(`Cloudflare R2 bucket ${bucket.name} omitted provider creation_date`);
  }
}

async function listR2BucketIdentitiesStrict(): Promise<
  Array<R2BucketProviderIdentity & { creationDate: string }>
> {
  const buckets = await listR2Buckets({ throwOnError: true, requireIdentity: true });
  buckets.forEach(assertR2BucketIdentityComplete);
  return buckets.map((bucket) => ({ name: bucket.name, creationDate: bucket.creationDate! }));
}

async function waitForR2BucketVisible(
  name: string,
  createError?: unknown
): Promise<R2BucketProviderIdentity & { creationDate: string }> {
  const maxAttempts = provisioningVisibilityMaxAttempts();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const bucket = (await listR2BucketIdentitiesStrict()).find((row) => row.name === name);
      if (bucket) return bucket;
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxAttempts) {
      const delayMs = provisioningVisibilityRetryDelayMs(attempt);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  const visibilityError = new Error(
    `R2 bucket ${name} was not visible after creation (${maxAttempts} readback attempts)`
  );
  const causes = [createError, lastError, visibilityError].filter(
    (cause): cause is NonNullable<typeof cause> => cause !== undefined
  );
  if (causes.length > 1) {
    const createErrorDetail = createError instanceof Error ? `: ${createError.message}` : '';
    throw new AggregateError(
      causes,
      `R2 bucket ${name} creation outcome could not be verified${createErrorDetail}`
    );
  }
  throw visibilityError;
}

export async function provisionR2Buckets(
  env: string,
  options: {
    existing?: Record<
      string,
      {
        name: string;
        creationDate?: string;
        ownershipMarkerKey?: string;
        ownershipId?: string;
      }
    > | null;
    includeFeatureBuckets?: boolean;
    onProgress?: (message: string) => void;
    onResourceProvisioned?: (resource: ProvisioningResourceCheckpoint) => Promise<void>;
    onResourceIdentified?: (resource: ProvisioningResourceCheckpoint) => Promise<void>;
    allowExisting?: boolean;
    provisioningIntentResources?: Readonly<Record<string, ProvisioningResourceCheckpoint>>;
    onResourceCreateIssued?: (resource: ProvisioningResourceIdentity) => Promise<void>;
    onResourceCreateRejected?: (resource: ProvisioningResourceIdentity) => Promise<void>;
  } = {}
): Promise<R2BucketInfo[]> {
  const onProgress = options.onProgress ?? (() => undefined);
  const existing = options.existing ?? {};
  const provisioned: R2BucketInfo[] = [];
  const bucketsByName = new Map(
    (await listR2BucketIdentitiesStrict()).map((candidate) => [candidate.name, candidate])
  );

  for (const bucket of getRequiredR2Buckets(env, {
    includeFeatureBuckets: options.includeFeatureBuckets,
  })) {
    const lockedBucket = existing[bucket.binding];
    const bucketName = lockedBucket?.name ?? bucket.name;
    const checkpoint = options.provisioningIntentResources?.[`r2:${bucket.binding}`];
    const ownershipId =
      checkpoint?.ownershipId ?? lockedBucket?.ownershipId ?? randomUUID().toLowerCase();
    const ownershipMarkerKey =
      checkpoint?.ownershipMarkerKey ??
      lockedBucket?.ownershipMarkerKey ??
      buildR2OwnershipMarkerKey(ownershipId);
    const identity: ProvisioningResourceIdentity = {
      kind: 'r2',
      binding: bucket.binding,
      name: bucketName,
      ownershipMarkerKey,
      ownershipId,
    };
    const behavior =
      options.provisioningIntentResources &&
      options.onResourceCreateIssued &&
      options.onResourceCreateRejected
        ? getProvisioningCreateBehavior(
            {
              provisioningIntentResources: options.provisioningIntentResources,
              onResourceCreateIssued: options.onResourceCreateIssued,
              onResourceCreateRejected: options.onResourceCreateRejected,
              onResourceIdentified: options.onResourceIdentified ?? (async () => undefined),
            },
            identity
          )
        : { allowExisting: options.allowExisting };
    const liveBucket = bucketsByName.get(bucketName);
    if (liveBucket) {
      const legacyRecordedBinding =
        (checkpoint?.state === 'created' &&
          !checkpoint.creationDate &&
          !checkpoint.ownershipMarkerKey &&
          !checkpoint.ownershipId) ||
        (Boolean(lockedBucket) &&
          !lockedBucket?.creationDate &&
          !lockedBucket?.ownershipMarkerKey &&
          !lockedBucket?.ownershipId);
      if (legacyRecordedBinding) {
        // A pre-fix lock/checkpoint remains usable as a non-destructive Worker binding so an
        // interrupted 0.4.0 setup can finish. It does not gain deletion authority and is never
        // silently upgraded to a marker-owned bucket.
        provisioned.push({ binding: bucket.binding, name: bucketName });
        onProgress(`  ✓ Existing legacy binding (name-only): ${bucketName}`);
        continue;
      }
      const expectedCreationDate = behavior.expectedCreationDate ?? lockedBucket?.creationDate;
      if (expectedCreationDate && liveBucket.creationDate !== expectedCreationDate) {
        throw new Error(
          `R2 bucket ${bucketName} was replaced after Setup recorded its provider creation_date`
        );
      }
      try {
        await assertR2OwnershipMarker({
          bucketName,
          markerKey: ownershipMarkerKey,
          ownershipId,
          environment: env,
          binding: bucket.binding,
        });
      } catch (error) {
        const interrupted = behavior.recordedState === 'create_issued';
        throw new Error(
          interrupted
            ? `R2 bucket ${bucketName} exists after an interrupted create but has no matching ` +
                'Setup ownership marker. Delete or adopt it explicitly before retrying.'
            : `R2 bucket ${bucketName} already exists without exact Setup ownership evidence`,
          { cause: error }
        );
      }
      const postMarkerIdentity = (await listR2BucketIdentitiesStrict()).find(
        (candidate) => candidate.name === bucketName
      );
      if (!postMarkerIdentity || postMarkerIdentity.creationDate !== liveBucket.creationDate) {
        throw new Error(
          `R2 bucket ${bucketName} changed while Setup verified its ownership marker`
        );
      }
      const creationDate = expectedCreationDate ?? liveBucket.creationDate;
      provisioned.push({
        binding: bucket.binding,
        name: bucketName,
        creationDate,
        ownershipMarkerKey,
        ownershipId,
      });
      await options.onResourceIdentified?.({
        ...identity,
        state: 'identified',
        creationDate,
      });
      await options.onResourceProvisioned?.({
        ...identity,
        state: 'created',
        creationDate,
      });
      onProgress(`  ✓ Existing: ${bucketName}`);
      continue;
    }

    if (behavior.recordedState === 'identified' || behavior.recordedState === 'created') {
      throw new Error(`R2 bucket ${bucketName} recorded by provisioning is missing`);
    }
    if (behavior.recordedState === 'create_issued') {
      throw new Error(
        `R2 bucket ${bucketName} has an interrupted create_issued checkpoint and is not ` +
          'currently visible. Setup will not reissue the create; inspect Cloudflare and recover explicitly.'
      );
    }

    onProgress(`  ⏳ Creating: ${bucketName}...`);
    await behavior.onCreateIssued?.();
    let result: { name: string };
    try {
      result = await createR2Bucket(bucketName, { allowExisting: behavior.allowExisting });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isAmbiguousCloudflareMutationFailure(message)) {
        return throwDefiniteProvisioningCreateFailure(behavior, error, `R2 bucket ${bucketName}`);
      }
      await waitForR2BucketVisible(bucketName, error);
      // R2 create has neither an idempotency key nor an immutable bucket ID. A same-name bucket
      // observed after a lost create response cannot safely be attributed to this attempt because
      // the marker write occurs only after this boundary.
      throw new Error(
        `R2 bucket ${bucketName} became visible after an ambiguous create response, but Setup ` +
          'cannot prove ownership. Delete or adopt it explicitly before retrying.',
        { cause: error }
      );
    }
    const providerIdentity = await waitForR2BucketVisible(result.name);
    await writeAndVerifyR2OwnershipMarker({
      environment: env,
      binding: bucket.binding,
      bucketName: result.name,
      markerKey: ownershipMarkerKey,
      ownershipId,
    });
    const postMarkerIdentity = await waitForR2BucketVisible(result.name);
    if (postMarkerIdentity.creationDate !== providerIdentity.creationDate) {
      throw new Error(
        `R2 bucket ${result.name} was replaced while Setup established its ownership marker`
      );
    }
    await options.onResourceIdentified?.({
      ...identity,
      name: result.name,
      state: 'identified',
      creationDate: providerIdentity.creationDate,
    });
    provisioned.push({
      binding: bucket.binding,
      name: result.name,
      creationDate: providerIdentity.creationDate,
      ownershipMarkerKey,
      ownershipId,
    });
    await options.onResourceProvisioned?.({
      ...identity,
      name: result.name,
      state: 'created',
      creationDate: providerIdentity.creationDate,
    });
    onProgress(`  ✅ ${bucketName} created`);
  }

  return provisioned;
}

// =============================================================================
// Secrets Operations
// =============================================================================

/**
 * Upload a secret to Cloudflare
 */
export async function uploadSecret(
  workerName: string,
  secretName: string,
  secretValue: string,
  env?: string
): Promise<boolean> {
  try {
    const args = ['secret', 'put', secretName, '--name', workerName];
    if (env) {
      args.push('--env', env);
    }

    // Use stdin to pass the secret value
    // Use npx to ensure wrangler is found regardless of Volta/npm/pnpm environment
    await execa('npx', ['wrangler', ...args], {
      input: secretValue,
    });
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validate environment name to prevent injection attacks
 */
function validateEnvName(env: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(env)) {
    throw new Error(
      'Invalid environment name: must start with lowercase letter and contain only lowercase alphanumeric and hyphens'
    );
  }
  if (env.length > 32) {
    throw new Error('Invalid environment name: must be 32 characters or less');
  }
}

/**
 * Sanitize error message to prevent path/secret exposure
 */
function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Remove potential file paths
  return message
    .replace(/\/[^\s:]+/g, '[path]')
    .replace(/\\[^\s:]+/g, '[path]')
    .replace(/[a-f0-9]{32,}/gi, '[id]'); // Obscure long hex strings that might be IDs/secrets
}

// =============================================================================
// Provisioning
// =============================================================================

/**
 * Provision all required Cloudflare resources for an environment
 */
export async function provisionResources(options: ProvisionOptions): Promise<ProvisionedResources> {
  const { env, onProgress = console.log } = options;

  // Security: Validate environment name
  validateEnvName(env);
  const resources: ProvisionedResources = {
    d1: [],
    kv: [],
    queues: [],
    r2: [],
  };

  // Calculate totals for progress tracking
  const d1Count = D1_DATABASES.length;
  const kvCount = KV_NAMESPACES.length;
  const totalResources = d1Count + kvCount;
  let _completedResources = 0;

  onProgress(`📦 Provisioning ${totalResources} resources...`);
  onProgress('');

  // Provision D1 databases
  if (options.createD1 !== false) {
    onProgress(`📊 D1 Databases (0/${d1Count})`);
    for (const db of D1_DATABASES) {
      const dbName = getD1DatabaseName(env, db.dbType);
      const identity: ProvisioningResourceIdentity = {
        kind: 'd1',
        binding: db.binding,
        name: dbName,
      };
      onProgress(`  ⏳ Creating: ${dbName}...`);

      const dbOptions = options.databaseConfig?.[db.locationProfile];

      try {
        const result = await createD1Database(
          dbName,
          dbOptions,
          getProvisioningCreateBehavior(options, identity)
        );
        resources.d1.push({
          binding: db.binding,
          name: result.name,
          id: result.id,
        });
        await options.onResourceProvisioned?.({
          ...identity,
          name: result.name,
          state: 'created',
          id: result.id,
        });
        _completedResources++;

        // Show location info if specified
        let locationInfo = '';
        if (dbOptions?.jurisdiction && dbOptions.jurisdiction !== 'none') {
          locationInfo = ` [jurisdiction: ${dbOptions.jurisdiction}]`;
        } else if (dbOptions?.location && dbOptions.location !== 'auto') {
          locationInfo = ` [location: ${dbOptions.location}]`;
        }
        onProgress(`  ✅ ${dbName} (ID: ${result.id.substring(0, 8)}...)${locationInfo}`);
      } catch (error) {
        onProgress(`  ❌ Failed: ${dbName} - ${sanitizeError(error)}`);
        throw new Error(`Failed to create D1 database ${dbName}`, { cause: error });
      }
    }
    onProgress(`📊 D1 Databases (${d1Count}/${d1Count}) ✓`);
    onProgress('');
  }

  // Provision KV namespaces
  if (options.createKV !== false) {
    onProgress(`🗄️ KV Namespaces (0/${kvCount})`);
    for (const kvName of KV_NAMESPACES) {
      const nsName = getKVNamespaceName(env, kvName);
      const identity: ProvisioningResourceIdentity = {
        kind: 'kv',
        binding: kvName,
        name: nsName,
      };
      onProgress(`  ⏳ Creating: ${nsName}...`);

      try {
        const result = await createKVNamespace(
          nsName,
          false,
          getProvisioningCreateBehavior(options, identity)
        );
        // Preview namespaces are auto-created by wrangler dev when needed
        // const previewResult = await createKVNamespace(nsName, true);

        resources.kv.push({
          binding: kvName,
          name: result.name,
          id: result.id,
          // previewId: previewResult.id,
        });
        await options.onResourceProvisioned?.({
          ...identity,
          name: result.name,
          state: 'created',
          id: result.id,
        });
        _completedResources++;
        onProgress(`  ✅ ${nsName} (ID: ${result.id.substring(0, 8)}...)`);
      } catch (error) {
        onProgress(`  ❌ Failed: ${nsName} - ${sanitizeError(error)}`);
        throw new Error(`Failed to create KV namespace ${nsName}`, { cause: error });
      }
    }
    onProgress(`🗄️ KV Namespaces (${kvCount}/${kvCount}) ✓`);
    onProgress('');
  }

  // Provision Queues (optional)
  if (options.createQueues) {
    onProgress('📨 Queues');
    for (const definition of QUEUE_PROVISIONING_DEFINITIONS) {
      const queueName = getQueueName(env, definition.nameSuffix);
      const identity: ProvisioningResourceIdentity = {
        kind: 'queue',
        binding: definition.binding,
        name: queueName,
      };
      onProgress(`  ⏳ Creating: ${queueName}...`);

      try {
        const result = await createQueue(
          queueName,
          getProvisioningCreateBehavior(options, identity)
        );
        resources.queues.push({
          binding: definition.binding,
          name: result.name,
          id: result.id,
        });
        await options.onResourceProvisioned?.({
          ...identity,
          name: result.name,
          state: 'created',
          id: result.providerId,
        });
        onProgress(`  ✅ ${queueName} created`);
      } catch (error) {
        onProgress(`  ❌ Failed: ${queueName} - ${sanitizeError(error)}`);
        throw new Error(`Failed to create Queue ${queueName}`, { cause: error });
      }
    }
    onProgress('');
  }

  // The migration release bucket is baseline infrastructure. A normal setup provisions every
  // product bucket; only an explicit R2 opt-out limits provisioning to the baseline bucket.
  onProgress('📁 R2 Buckets');
  try {
    resources.r2.push(
      ...(await provisionR2Buckets(env, {
        onProgress,
        includeFeatureBuckets: options.createR2 !== false,
        onResourceProvisioned: options.onResourceProvisioned,
        onResourceIdentified: options.onResourceIdentified,
        provisioningIntentResources: options.provisioningIntentResources,
        onResourceCreateIssued: options.onResourceCreateIssued,
        onResourceCreateRejected: options.onResourceCreateRejected,
      }))
    );
  } catch (error) {
    onProgress(`  ❌ R2 provisioning failed: ${sanitizeError(error)}`);
    throw new Error('Failed to provision baseline R2 migration release bucket', { cause: error });
  }
  onProgress('');

  // Summary
  onProgress('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  onProgress('✅ Provisioning complete!');
  onProgress(
    `   D1: ${resources.d1.length}, KV: ${resources.kv.length}, Queues: ${resources.queues.length}, R2: ${resources.r2.length}`
  );

  return resources;
}

/**
 * Convert provisioned resources to ResourceIds format for wrangler.ts
 */
export function toResourceIds(resources: ProvisionedResources): {
  d1: Record<string, { id: string; name: string }>;
  kv: Record<string, { id: string; name: string }>;
  queues?: Record<string, { id: string; name: string }>;
  r2?: Record<
    string,
    {
      name: string;
      creationDate?: string;
      ownershipMarkerKey?: string;
      ownershipId?: string;
    }
  >;
} {
  const result: ReturnType<typeof toResourceIds> = {
    d1: {},
    kv: {},
  };

  for (const db of resources.d1) {
    result.d1[db.binding] = { id: db.id, name: db.name };
  }

  for (const kv of resources.kv) {
    result.kv[kv.binding] = { id: kv.id, name: kv.name };
  }

  if (resources.queues.length > 0) {
    result.queues = {};
    for (const q of resources.queues) {
      result.queues[q.binding] = { id: q.id, name: q.name };
    }
  }

  if (resources.r2.length > 0) {
    result.r2 = {};
    for (const r of resources.r2) {
      result.r2[r.binding] = {
        name: r.name,
        ...(r.creationDate ? { creationDate: r.creationDate } : {}),
        ...(r.ownershipMarkerKey ? { ownershipMarkerKey: r.ownershipMarkerKey } : {}),
        ...(r.ownershipId ? { ownershipId: r.ownershipId } : {}),
      };
    }
  }

  return result;
}

// =============================================================================
// Environment Detection & Deletion
// =============================================================================

/**
 * Pattern to detect Authrim resources by name
 */
const AUTHRIM_PATTERNS = {
  worker:
    /^([a-z][a-z0-9-]*)-ar-(auth|token|userinfo|discovery|control|plugin-runner|management|agent-access|router|async|saml|bridge|vc|lib-core|policy|admin-ui|login-ui)$/,
  d1: /^([a-z][a-z0-9-]*)-authrim-(core|pii|admin|control|lookup|plugin-runner)-db$/,
  // KV can have either lowercase or uppercase env prefix (e.g., conformance-CLIENTS_CACHE or TESTENV-CLIENTS_CACHE)
  kv: /^([a-zA-Z][a-zA-Z0-9-]*)-(?:CLIENTS_CACHE|INITIAL_ACCESS_TOKENS|SETTINGS|REBAC_CACHE|USER_CACHE|AUTHRIM_CONFIG|TENANT_RUNTIME_REGISTRY|STATE_STORE|CONSENT_CACHE)(?:_preview)?$/i,
  queue:
    /^([a-z][a-z0-9-]*)-(audit-queue|logging-delivery-critical-queue|logging-delivery-queue|logging-delivery-bulk-queue)$/,
  // Keep the retired authrim-avatars suffix discoverable so environment deletion can clean up
  // buckets created by pre-consolidation installations.
  r2: /^([a-z][a-z0-9-]*)-(migration-releases|plugin-bundles|public-assets|authrim-avatars|diagnostic-logs|audit-archive|import-artifacts|export-artifacts|sensitive-details)$/,
  // Legacy Pages projects kept only for cleanup of older installations.
  pages: /^([a-z][a-z0-9-]*)-(ar-admin-ui|ar-login-ui)$/,
};

export interface EnvironmentInfo {
  env: string;
  workers: Array<{ name: string; id?: string }>;
  d1: Array<{ name: string; id: string }>;
  kv: Array<{ name: string; id: string }>;
  queues: Array<{ name: string; id?: string }>;
  r2: R2BucketProviderIdentity[];
  pages: PagesProjectProviderIdentity[];
}

export interface DeletionResourceIdentity {
  name: string;
  id: string;
}

export interface DeletionWorkerIdentity {
  name: string;
  cloudflareScriptTag?: string;
  cloudflareVersionId?: string;
  /** Uploaded checkpoints are verified against version inventory, not active deployments. */
  cloudflareVersionState?: 'active' | 'uploaded';
}

export interface DeletionR2Identity {
  name: string;
  creationDate?: string;
  ownershipMarkerKey?: string;
  ownershipId?: string;
  environment?: string;
  binding?: string;
}

export type ExactDeletionR2Identity = DeletionR2Identity &
  Required<
    Pick<DeletionR2Identity, 'name' | 'creationDate' | 'ownershipMarkerKey' | 'ownershipId'>
  >;

export interface DeletionPagesIdentity {
  name: string;
  id: string;
  createdOn: string;
}

export interface DeleteOptions {
  env: string;
  /** The environment still has a local operation lock even if remote inventory is already empty. */
  environmentKnownLocally?: boolean;
  /**
   * Complete environment deletion after every current resource type is verified, even when an
   * unobserved legacy Pages project was not selected. A lock-recorded Pages identity must still be
   * selected and verified by the caller.
   */
  finalizeEnvironment?: boolean;
  deleteWorkers?: boolean;
  deleteD1?: boolean;
  deleteKV?: boolean;
  deleteQueues?: boolean;
  deleteR2?: boolean;
  deletePages?: boolean;
  /** @deprecated Name-only recovery cannot prove Worker script ownership. */
  knownWorkerNames?: string[];
  /** @deprecated Name-only recovery cannot prove ownership. Pass knownD1Resources instead. */
  knownD1Names?: string[];
  /** @deprecated Name-only recovery cannot prove ownership. Pass knownQueueResources instead. */
  knownQueueNames?: string[];
  /** Exact immutable identities pinned in the environment lock. */
  knownD1Resources?: DeletionResourceIdentity[];
  /** Exact immutable identities pinned in the environment lock. */
  knownKVResources?: DeletionResourceIdentity[];
  /** Exact immutable identities pinned in the environment lock. */
  knownQueueResources?: DeletionResourceIdentity[];
  /** Exact R2 provider generation and Setup ownership marker pinned in the environment lock. */
  knownR2Resources?: DeletionR2Identity[];
  /** Exact retired Pages provider identities pinned in the environment lock. */
  knownPagesResources?: DeletionPagesIdentity[];
  /** Final Worker identities pinned in the environment lock. */
  knownWorkerResources?: DeletionWorkerIdentity[];
  /** Persist a verified legacy Worker tag before any destructive provider mutation. */
  onWorkerIdentityBackfill?: (resources: readonly DeletionWorkerIdentity[]) => Promise<void>;
  knownDnsOwnership?: Partial<Record<DnsOwnershipRole, DnsOwnershipEntry>>;
  /** Multi-tenant configuration proves DNS cleanup is required even for a legacy lock. */
  dnsCleanupRequired?: boolean;
  requiredDnsRoles?: DnsOwnershipRole[];
  queueConsumerDetachPropagationDelayMs?: number;
  workerDeletePropagationDelayMs?: number;
  /** Bounded strict Cloudflare inventory reads before declaring the environment empty. */
  postDeleteVerificationAttempts?: number;
  /** Delay between post-delete inventory reads; primarily configurable for deterministic tests. */
  postDeleteVerificationDelayMs?: number;
  /** Durable exact-ID Control child-token cleanup, invoked after Workers/R2 and before any D1. */
  beforeD1Deletion?: (context: {
    observedD1Resources: readonly DeletionResourceIdentity[];
  }) => Promise<void>;
  onProgress?: (message: string) => void;
  /** Idempotent no-op and raw diagnostic messages for detailed logs only. */
  onDetail?: (message: string) => void;
  onResourceProgress?: (progress: { current: number; total: number }) => void;
}

export const ENVIRONMENT_INVENTORY_UNAVAILABLE_ERROR_CODE =
  'environment_inventory_unavailable' as const;

export class EnvironmentInventoryUnavailableError extends Error {
  readonly code = ENVIRONMENT_INVENTORY_UNAVAILABLE_ERROR_CODE;

  constructor(resourceType: string, error: unknown) {
    const detail = sanitizeError(error);
    super(
      `Cloudflare ${resourceType} inventory could not be verified. No resources were deleted. ` +
        `Check your Cloudflare connection and sign-in, then retry. Details: ${detail}`,
      { cause: error }
    );
    this.name = 'EnvironmentInventoryUnavailableError';
  }
}

const CONTROL_FIXED_D1_SUFFIX = /^(?:core|pii|admin|control|lookup|plugin-runner)-db$/u;
const CONTROL_SHARD_D1_SUFFIX =
  /^(?:(?:tenant-core-default|tenant-core-users|tenant-pii|tenant-lookup)-[a-z0-9-]+-db-[a-f0-9]{8}|(?:core-default|core-users|pii|lookup)-[a-z0-9-]+(?:-db)?-[a-f0-9]{8})$/u;
const CONTROL_BOOTSTRAP_D1_SUFFIX = /^tenant-(?:default|users|pii)-bootstrap-db$/u;
const CONTROL_PLUGIN_D1_SUFFIX = /^[a-f0-9]{32}-d1$/u;
const CONTROL_PLUGIN_KV_SUFFIX = /^[a-f0-9]{32}-kv$/u;
const CONTROL_PLUGIN_R2_SUFFIX = /^[a-f0-9]{32}-r2$/u;

function controlManagedSuffix(env: string, name: string): string | null {
  const prefixes = [`${env}-authrim-`, `authrim-${env}-`];
  const prefix = prefixes.find((candidate) => name.startsWith(candidate));
  return prefix ? name.slice(prefix.length) : null;
}

function isControlManagedD1NameForEnvironment(env: string, name: string): boolean {
  const suffix = controlManagedSuffix(env, name);
  return (
    suffix !== null &&
    (CONTROL_FIXED_D1_SUFFIX.test(suffix) ||
      CONTROL_SHARD_D1_SUFFIX.test(suffix) ||
      CONTROL_BOOTSTRAP_D1_SUFFIX.test(suffix) ||
      CONTROL_PLUGIN_D1_SUFFIX.test(suffix))
  );
}

function isControlManagedKVNameForEnvironment(env: string, name: string): boolean {
  const suffix = controlManagedSuffix(env, name);
  return suffix !== null && CONTROL_PLUGIN_KV_SUFFIX.test(suffix);
}

function isControlManagedR2NameForEnvironment(env: string, name: string): boolean {
  const suffix = controlManagedSuffix(env, name);
  return suffix !== null && CONTROL_PLUGIN_R2_SUFFIX.test(suffix);
}

function isFixedD1NameForEnvironment(env: string, name: string): boolean {
  const match = name.match(AUTHRIM_PATTERNS.d1);
  return match?.[1]?.toLowerCase() === env.toLowerCase();
}

function isKVNameForEnvironment(env: string, name: string): boolean {
  const match = name.match(AUTHRIM_PATTERNS.kv);
  return match?.[1]?.toLowerCase() === env.toLowerCase();
}

function isQueueNameForEnvironment(env: string, name: string): boolean {
  const match = name.match(AUTHRIM_PATTERNS.queue);
  return match?.[1]?.toLowerCase() === env.toLowerCase();
}

function isR2NameForEnvironment(env: string, name: string): boolean {
  const match = name.match(AUTHRIM_PATTERNS.r2);
  return (
    match?.[1]?.toLowerCase() === env.toLowerCase() ||
    isControlManagedR2NameForEnvironment(env, name)
  );
}

function isPagesNameForEnvironment(env: string, name: string): boolean {
  const match = name.match(AUTHRIM_PATTERNS.pages);
  return match?.[1]?.toLowerCase() === env.toLowerCase();
}

function normalizeKnownR2DeletionIdentities(
  env: string,
  resources: readonly DeletionR2Identity[]
): DeletionR2Identity[] {
  const names = new Set<string>();
  return resources.map((resource, index) => {
    const name = resource.name?.trim();
    if (!name || name !== resource.name || !isR2NameForEnvironment(env, name)) {
      throw new Error(`R2 deletion identity ${index} is invalid or outside environment '${env}'`);
    }
    if (names.has(name)) throw new Error('R2 deletion identities contain a duplicate name');
    names.add(name);
    return { ...resource, name };
  });
}

async function reconcileR2DeletionIdentities(input: {
  pinned: readonly DeletionR2Identity[];
  remote: readonly (R2BucketProviderIdentity & { creationDate: string })[];
}): Promise<{
  targets: DeletionR2Identity[];
  mismatches: string[];
  liveNames: Set<string>;
}> {
  const remoteByName = new Map(input.remote.map((resource) => [resource.name, resource]));
  const pinnedByName = new Map(input.pinned.map((resource) => [resource.name, resource]));
  const mismatches: string[] = [];
  const targets: DeletionR2Identity[] = [];

  for (const remote of input.remote) {
    if (!pinnedByName.has(remote.name)) {
      mismatches.push(
        `R2 ownership for ${remote.name} is not recorded in lock.json. No resources were deleted. ` +
          `Delete that bucket manually in Cloudflare, or use an explicit ownership-adoption workflow.`
      );
    }
  }

  for (const pinned of input.pinned) {
    const complete = pinned.creationDate && pinned.ownershipMarkerKey && pinned.ownershipId;
    if (!complete) {
      mismatches.push(
        `R2 ownership for ${pinned.name} is name-only legacy state. No resources were deleted. ` +
          `Delete that bucket manually in Cloudflare, or use an explicit ownership-adoption workflow.`
      );
      continue;
    }
    const remote = remoteByName.get(pinned.name);
    if (!remote) {
      targets.push(pinned);
      continue;
    }
    if (remote.creationDate !== pinned.creationDate) {
      mismatches.push(
        `R2 ownership mismatch for ${pinned.name}: provider creation_date changed. ` +
          'The same-name replacement was preserved.'
      );
      continue;
    }
    try {
      await assertR2OwnershipMarker({
        bucketName: pinned.name,
        markerKey: pinned.ownershipMarkerKey!,
        ownershipId: pinned.ownershipId!,
        environment: pinned.environment,
        binding: pinned.binding,
      });
      targets.push(pinned);
    } catch {
      mismatches.push(
        `R2 ownership mismatch for ${pinned.name}: the Setup ownership marker is missing or ` +
          'invalid. The bucket was preserved.'
      );
    }
  }

  return { targets, mismatches, liveNames: new Set(input.remote.map((row) => row.name)) };
}

function normalizeKnownPagesDeletionIdentities(
  env: string,
  resources: readonly DeletionPagesIdentity[]
): DeletionPagesIdentity[] {
  const names = new Set<string>();
  const ids = new Set<string>();
  return resources.map((resource, index) => {
    const name = resource.name?.trim();
    const id = resource.id?.trim();
    const createdOn = normalizeCloudflareTimestamp(
      resource.createdOn,
      `Pages deletion identity ${index} created_on`
    );
    if (!name || !id || !createdOn || !isPagesNameForEnvironment(env, name)) {
      throw new Error(
        `Pages deletion identity ${index} is invalid or outside environment '${env}'`
      );
    }
    if (names.has(name) || ids.has(id)) {
      throw new Error('Pages deletion identities contain a duplicate name or ID');
    }
    names.add(name);
    ids.add(id);
    return { name, id, createdOn };
  });
}

function reconcilePagesDeletionIdentities(input: {
  pinned: readonly DeletionPagesIdentity[];
  remote: readonly PagesProjectProviderIdentity[];
}): { targets: DeletionPagesIdentity[]; mismatches: string[]; liveIds: Set<string> } {
  const remoteByName = new Map(input.remote.map((resource) => [resource.name, resource]));
  const pinnedByName = new Map(input.pinned.map((resource) => [resource.name, resource]));
  const mismatches: string[] = [];
  const targets: DeletionPagesIdentity[] = [];

  for (const remote of input.remote) {
    if (!pinnedByName.has(remote.name)) {
      mismatches.push(
        `Legacy Pages ownership for ${remote.name} is not recorded with provider ID and ` +
          'created_on. No resources were deleted. Delete it manually in Cloudflare.'
      );
    }
  }
  for (const pinned of input.pinned) {
    const remote = remoteByName.get(pinned.name);
    if (!remote) {
      targets.push(pinned);
      continue;
    }
    if (remote.id !== pinned.id || remote.createdOn !== pinned.createdOn) {
      mismatches.push(
        `Legacy Pages ownership mismatch for ${pinned.name}: provider ID or created_on changed. ` +
          'The same-name replacement was preserved.'
      );
      continue;
    }
    targets.push(pinned);
  }
  return {
    targets,
    mismatches,
    liveIds: new Set(input.remote.flatMap((row) => (row.id ? [row.id] : []))),
  };
}

function normalizeKnownDeletionResourceIdentities(input: {
  env: string;
  kind: 'D1 database' | 'KV namespace' | 'Queue';
  resources: readonly DeletionResourceIdentity[];
  acceptsName: (name: string) => boolean;
}): DeletionResourceIdentity[] {
  const names = new Set<string>();
  const ids = new Set<string>();
  return input.resources.map((resource, index) => {
    const name = resource.name?.trim();
    const id = resource.id?.trim();
    if (!name || !id || name !== resource.name || id !== resource.id || id.length > 256) {
      throw new Error(`${input.kind} deletion identity ${index} is invalid`);
    }
    if (!input.acceptsName(name)) {
      throw new Error(`${input.kind} deletion identity is outside environment '${input.env}'`);
    }
    if (names.has(name) || ids.has(id)) {
      throw new Error(`${input.kind} deletion identities contain a duplicate name or ID`);
    }
    names.add(name);
    ids.add(id);
    return { name, id };
  });
}

function reconcilePinnedDeletionIdentities(input: {
  label: string;
  pinned: readonly DeletionResourceIdentity[];
  remote: readonly DeletionResourceIdentity[];
}): { targets: DeletionResourceIdentity[]; mismatches: string[]; liveIds: Set<string> } {
  const remoteByName = new Map(input.remote.map((resource) => [resource.name, resource]));
  const remoteById = new Map(input.remote.map((resource) => [resource.id, resource]));
  const targets = [...input.remote];
  const targetNames = new Set(targets.map((resource) => resource.name));
  const liveIds = new Set(input.remote.map((resource) => resource.id));
  const mismatches: string[] = [];

  for (const pinned of input.pinned) {
    const sameName = remoteByName.get(pinned.name);
    const sameId = remoteById.get(pinned.id);
    if (sameName && sameName.id !== pinned.id) {
      mismatches.push(
        `${input.label} ownership mismatch for ${pinned.name}: the immutable ID changed`
      );
      continue;
    }
    if (sameId && sameId.name !== pinned.name) {
      mismatches.push(
        `${input.label} ownership mismatch for ${pinned.name}: the immutable ID belongs to ${sameId.name}`
      );
      continue;
    }
    // A missing exact ID is an idempotent deletion retry. Keep the pinned row in the target list
    // so callers can reconcile the local lock without issuing a name-based provider mutation.
    if (!sameName && !sameId && !targetNames.has(pinned.name)) {
      targets.push(pinned);
      targetNames.add(pinned.name);
    }
  }

  return { targets, mismatches, liveIds };
}

interface WorkerDeletionTarget {
  name: string;
  cloudflareScriptTag?: string;
  live: boolean;
}

function normalizeKnownWorkerDeletionIdentities(
  env: string,
  resources: readonly DeletionWorkerIdentity[]
): DeletionWorkerIdentity[] {
  const names = new Set<string>();
  const tags = new Set<string>();
  return resources.map((resource, index) => {
    const name = resource.name?.trim();
    const tag = resource.cloudflareScriptTag?.trim();
    const versionId = resource.cloudflareVersionId?.trim();
    const versionState = resource.cloudflareVersionState;
    if (!name || name !== resource.name || name.length > 256) {
      throw new Error(`Worker deletion identity ${index} has an invalid name`);
    }
    if (!filterKnownWorkerNamesForEnvironment(env, [name]).includes(name)) {
      throw new Error(`Worker deletion identity is outside environment '${env}'`);
    }
    if (
      (resource.cloudflareScriptTag !== undefined &&
        (!tag || tag !== resource.cloudflareScriptTag || tag.length > 256)) ||
      (resource.cloudflareVersionId !== undefined &&
        (!versionId || versionId !== resource.cloudflareVersionId || versionId.length > 256)) ||
      (versionState !== undefined && versionState !== 'active' && versionState !== 'uploaded') ||
      (versionState !== undefined && !versionId)
    ) {
      throw new Error(`Worker deletion identity ${index} is invalid`);
    }
    if (names.has(name) || (tag !== undefined && tags.has(tag))) {
      throw new Error('Worker deletion identities contain a duplicate name or immutable tag');
    }
    names.add(name);
    if (tag) tags.add(tag);
    return {
      name,
      ...(tag ? { cloudflareScriptTag: tag } : {}),
      ...(versionId ? { cloudflareVersionId: versionId } : {}),
      ...(versionState ? { cloudflareVersionState: versionState } : {}),
    };
  });
}

async function reconcileWorkerDeletionIdentities(input: {
  env: string;
  pinned: readonly DeletionWorkerIdentity[];
  remoteInventory: ReadonlyArray<{ name: string; tag?: string }>;
}): Promise<{
  targets: WorkerDeletionTarget[];
  mismatches: string[];
  backfills: DeletionWorkerIdentity[];
}> {
  const remoteByName = new Map(input.remoteInventory.map((worker) => [worker.name, worker]));
  const remoteByTag = new Map(
    input.remoteInventory
      .filter((worker): worker is { name: string; tag: string } => Boolean(worker.tag))
      .map((worker) => [worker.tag, worker])
  );
  const targets: WorkerDeletionTarget[] = [];
  const targetNames = new Set<string>();
  const mismatches: string[] = [];
  const backfills: DeletionWorkerIdentity[] = [];

  for (const pinned of input.pinned) {
    const live = remoteByName.get(pinned.name);
    const tagOwner = pinned.cloudflareScriptTag
      ? remoteByTag.get(pinned.cloudflareScriptTag)
      : undefined;
    if (!live) {
      if (tagOwner && tagOwner.name !== pinned.name) {
        mismatches.push(
          `Worker ownership mismatch for ${pinned.name}: its immutable tag belongs to ${tagOwner.name}`
        );
        continue;
      }
      targets.push({ name: pinned.name, live: false });
      targetNames.add(pinned.name);
      continue;
    }
    const liveTag = live.tag?.trim();
    if (!liveTag) {
      mismatches.push(`Worker ownership for ${pinned.name} has no immutable script tag`);
      continue;
    }
    if (pinned.cloudflareScriptTag) {
      if (pinned.cloudflareScriptTag !== liveTag) {
        mismatches.push(
          `Worker ownership mismatch for ${pinned.name}: the immutable script tag changed`
        );
        continue;
      }
      targets.push({ name: pinned.name, cloudflareScriptTag: liveTag, live: true });
      targetNames.add(pinned.name);
      continue;
    }
    if (!pinned.cloudflareVersionId) {
      mismatches.push(
        `Worker ownership for ${pinned.name} has neither an immutable script tag nor a pinned active Version ID`
      );
      continue;
    }
    try {
      if (pinned.cloudflareVersionState === 'uploaded') {
        const version = await getWorkerVersion(pinned.name, pinned.cloudflareVersionId);
        if (!version.exists || version.versionId !== pinned.cloudflareVersionId) {
          mismatches.push(
            `Worker ownership mismatch for ${pinned.name}: the uploaded Version ID does not match the pending checkpoint`
          );
          continue;
        }
      } else {
        const deployment = await getWorkerDeployments(pinned.name);
        if (
          !deployment.exists ||
          !deployment.versionId ||
          deployment.versionId !== pinned.cloudflareVersionId
        ) {
          mismatches.push(
            `Worker ownership mismatch for ${pinned.name}: the active Version ID does not match the legacy lock`
          );
          continue;
        }
      }
    } catch (error) {
      mismatches.push(
        `Worker ownership for ${pinned.name} could not verify its ${pinned.cloudflareVersionState === 'uploaded' ? 'uploaded' : 'legacy'} Version ID: ${sanitizeError(error)}`
      );
      continue;
    }
    const backfill: DeletionWorkerIdentity = {
      name: pinned.name,
      cloudflareVersionId: pinned.cloudflareVersionId,
      cloudflareScriptTag: liveTag,
    };
    backfills.push(backfill);
    targets.push({ name: pinned.name, cloudflareScriptTag: liveTag, live: true });
    targetNames.add(pinned.name);
  }

  for (const remote of input.remoteInventory) {
    if (!filterKnownWorkerNamesForEnvironment(input.env, [remote.name]).includes(remote.name)) {
      continue;
    }
    if (targetNames.has(remote.name)) continue;
    const liveTag = remote.tag?.trim();
    if (!liveTag) {
      mismatches.push(`Worker ownership for ${remote.name} has no immutable script tag`);
      continue;
    }
    targets.push({ name: remote.name, cloudflareScriptTag: liveTag, live: true });
    targetNames.add(remote.name);
  }

  return { targets, mismatches, backfills };
}

export function filterKnownD1NamesForEnvironment(env: string, names: string[]): string[] {
  validateEnvName(env);
  return Array.from(
    new Set(names.filter((name) => isControlManagedD1NameForEnvironment(env, name)))
  );
}

export function filterKnownQueueNamesForEnvironment(env: string, names: string[]): string[] {
  return Array.from(
    new Set(
      names.filter((name) =>
        [
          `${env}-audit-queue`,
          `${env}-logging-delivery-critical-queue`,
          `${env}-logging-delivery-queue`,
          `${env}-logging-delivery-bulk-queue`,
        ].includes(name)
      )
    )
  );
}

export function filterKnownWorkerNamesForEnvironment(env: string, names: string[]): string[] {
  validateEnvName(env);
  return Array.from(
    new Set(
      names.filter((name) => {
        const match = name.match(AUTHRIM_PATTERNS.worker);
        return match?.[1]?.toLowerCase() === env.toLowerCase();
      })
    )
  ).sort();
}

export function filterControlManagedD1ForEnvironment(
  env: string,
  databases: Array<{ name: string; uuid: string }>
): Array<{ name: string; uuid: string }> {
  validateEnvName(env);
  return databases.filter((database) => isControlManagedD1NameForEnvironment(env, database.name));
}

export function filterControlManagedKVForEnvironment(
  env: string,
  namespaces: Array<{ title: string; id: string }>
): Array<{ title: string; id: string }> {
  validateEnvName(env);
  return namespaces.filter((namespace) =>
    isControlManagedKVNameForEnvironment(env, namespace.title)
  );
}

export function filterControlManagedR2ForEnvironment(
  env: string,
  buckets: Array<{ name: string }>
): Array<{ name: string }> {
  validateEnvName(env);
  return buckets.filter((bucket) => isControlManagedR2NameForEnvironment(env, bucket.name));
}

export async function hasControlManagedResourcesForEnvironment(
  env: string,
  options: { d1?: boolean; kv?: boolean; r2?: boolean } = {}
): Promise<boolean> {
  validateEnvName(env);
  const { d1 = true, kv = true, r2 = true } = options;
  const [databases, namespaces, buckets] = await Promise.all([
    d1 ? listD1Databases() : [],
    kv ? listKVNamespaces() : [],
    r2 ? listR2Buckets({ throwOnError: true }) : [],
  ]);
  return (
    filterControlManagedD1ForEnvironment(env, databases).length > 0 ||
    filterControlManagedKVForEnvironment(env, namespaces).length > 0 ||
    filterControlManagedR2ForEnvironment(env, buckets).length > 0
  );
}

/**
 * List all Workers. Inventory failure is never represented as an empty account; callers decide
 * whether a failed scan is advisory or must stop the operation.
 */
export async function listWorkers(
  options: {
    onRetry?: (message: string) => void;
  } = {}
): Promise<Array<{ name: string; id: string; tag?: string }>> {
  let lastError: unknown = new Error('Worker inventory was not requested');

  for (let attempt = 1; attempt <= WORKER_INVENTORY_MAX_ATTEMPTS; attempt++) {
    let retryDelayMs = WORKER_INVENTORY_RETRY_DELAY_MS * attempt;
    try {
      const accountId = await getAccountId();
      if (!accountId) {
        throw new Error('Cloudflare account ID is unavailable');
      }
      const tokenInfo = await getCloudflareApiToken();
      if (!tokenInfo) {
        throw new Error('Cloudflare API authentication is unavailable');
      }

      const { response, data } = await requestCloudflareApiJson<{
        success?: boolean;
        result?: Array<{ id?: unknown; tag?: unknown }>;
        result_info?: {
          page?: unknown;
          total_pages?: unknown;
        };
      }>(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
        {
          headers: { Authorization: `Bearer ${tokenInfo.token}` },
        },
        {
          label: 'Cloudflare Worker inventory',
          retryMode: 'read',
          timeoutMs: WORKER_INVENTORY_REQUEST_TIMEOUT_MS,
          maxAttempts: 1,
        }
      );
      if (!response.ok) {
        if (isRetryableCloudflareHttpStatus(response.status)) {
          retryDelayMs = getCloudflareRetryDelayMs(response, attempt);
        }
        throw new Error(`Cloudflare API returned HTTP ${response.status}`);
      }

      if (data.success === false || !Array.isArray(data.result)) {
        throw new Error('Cloudflare API returned an invalid Worker inventory response');
      }
      // The Workers Scripts endpoint is documented as a SinglePage endpoint. Fail closed if the
      // provider ever reports a multi-page response rather than silently treating page one as a
      // complete ownership inventory.
      if (
        data.result_info?.page !== undefined &&
        (!Number.isInteger(data.result_info.page) || data.result_info.page !== 1)
      ) {
        throw new Error('Cloudflare Worker inventory returned an invalid single-page marker');
      }
      if (
        data.result_info?.total_pages !== undefined &&
        (!Number.isInteger(data.result_info.total_pages) || data.result_info.total_pages !== 1)
      ) {
        throw new Error('Cloudflare Worker inventory unexpectedly requires pagination');
      }
      if (data.result.length > CLOUDFLARE_INVENTORY_MAX_RESOURCES) {
        throw new Error('Cloudflare Worker inventory exceeded the resource safety limit');
      }

      const names = new Set<string>();
      const tags = new Set<string>();
      return data.result.map((worker, index) => {
        if (typeof worker.id !== 'string' || worker.id.trim().length === 0) {
          throw new Error(`Worker inventory row ${index} did not contain a script name`);
        }
        const name = worker.id.trim();
        if (names.has(name)) {
          throw new Error(`Worker inventory contained duplicate script name: ${name}`);
        }
        names.add(name);

        let tag: string | undefined;
        if (worker.tag !== undefined && worker.tag !== null) {
          if (typeof worker.tag !== 'string' || worker.tag.trim().length === 0) {
            throw new Error(`Worker inventory row ${index} contained an invalid immutable tag`);
          }
          tag = worker.tag.trim();
          if (tags.has(tag)) {
            throw new Error(`Worker inventory contained duplicate immutable tag: ${tag}`);
          }
          tags.add(tag);
        }
        return { name, id: name, ...(tag ? { tag } : {}) };
      });
    } catch (error) {
      lastError = error;
      if (attempt < WORKER_INVENTORY_MAX_ATTEMPTS) {
        options.onRetry?.(
          `Worker inventory check failed; retrying (${attempt + 1}/${WORKER_INVENTORY_MAX_ATTEMPTS})...`
        );
        if (process.env.NODE_ENV !== 'test') {
          await sleep(retryDelayMs);
        }
      }
    }
  }

  throw lastError;
}

/**
 * List R2 buckets
 */
export async function listR2Buckets(
  options: { throwOnError?: boolean; requireIdentity?: boolean } = {}
): Promise<R2BucketProviderIdentity[]> {
  let apiError: unknown;
  try {
    const apiBuckets = await listR2BucketsViaApi();
    if (apiBuckets) {
      if (options.requireIdentity) apiBuckets.forEach(assertR2BucketIdentityComplete);
      return apiBuckets;
    }
  } catch (error) {
    apiError = error;
  }

  try {
    const { stdout } = await wrangler(['r2', 'bucket', 'list']);
    if (options.throwOnError && !isRecognizedR2BucketListOutput(stdout)) {
      throw new Error('Wrangler output did not contain a recognizable R2 bucket list');
    }
    const parsed = parseR2BucketRows(stdout);
    if (!options.requireIdentity) return parsed;

    const complete: Array<R2BucketProviderIdentity & { creationDate: string }> = [];
    for (const bucket of parsed) {
      if (bucket.creationDate) {
        complete.push({ name: bucket.name, creationDate: bucket.creationDate });
        continue;
      }
      const { stdout: infoOutput } = await wrangler([
        'r2',
        'bucket',
        'info',
        bucket.name,
        '--json',
      ]);
      const info = parseR2BucketRows(infoOutput);
      const exact = info.find((candidate) => candidate.name === bucket.name);
      if (!exact) {
        // Wrangler's info command returns a single object rather than the list shape.
        const raw = JSON.parse(stripAnsiSequences(infoOutput)) as {
          name?: unknown;
          creation_date?: unknown;
        };
        const creationDate = normalizeCloudflareTimestamp(
          raw.creation_date,
          `R2 bucket ${bucket.name} creation_date`
        );
        if (raw.name !== bucket.name || !creationDate) {
          throw new Error(`Wrangler omitted exact identity for R2 bucket ${bucket.name}`);
        }
        complete.push({ name: bucket.name, creationDate });
        continue;
      }
      assertR2BucketIdentityComplete(exact);
      complete.push(exact);
    }
    return complete;
  } catch (error) {
    if (options.throwOnError) {
      if (apiError) {
        throw new AggregateError(
          [apiError, error],
          'R2 bucket inventory failed through both the Cloudflare API and Wrangler'
        );
      }
      throw error;
    }
    return [];
  }
}

/**
 * List Queues
 */
type QueueListRow = { name: string; id?: string };

function normalizeQueueRows(rows: unknown): QueueListRow[] {
  if (!Array.isArray(rows)) {
    throw new TypeError('Queue list was not an array');
  }

  return rows.map((row, index): QueueListRow => {
    if (!row || typeof row !== 'object') {
      throw new TypeError(`Queue list row ${index} was not an object`);
    }
    const value = row as {
      name?: unknown;
      id?: unknown;
      queue_name?: unknown;
      queue_id?: unknown;
    };
    const name =
      typeof value.queue_name === 'string'
        ? value.queue_name
        : typeof value.name === 'string'
          ? value.name
          : '';
    const id =
      typeof value.queue_id === 'string'
        ? value.queue_id.trim() || undefined
        : typeof value.id === 'string'
          ? value.id.trim() || undefined
          : undefined;
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      throw new TypeError(`Queue list row ${index} did not contain a name`);
    }
    return { name: normalizedName, id };
  });
}

function assertQueueInventoryHasUniqueIds(
  queues: QueueListRow[],
  source: 'Wrangler' | 'Cloudflare API'
): void {
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const queue of queues) {
    const id = queue.id?.trim();
    if (!id) {
      throw new Error(`${source} Queue inventory omitted immutable Queue IDs`);
    }
    if (names.has(queue.name)) {
      throw new Error(`${source} Queue inventory contained a duplicate Queue name`);
    }
    if (ids.has(id)) {
      throw new Error(`${source} Queue inventory contained a duplicate immutable Queue ID`);
    }
    names.add(queue.name);
    ids.add(id);
  }
}

export function parseQueueRows(stdout: string): QueueListRow[] {
  try {
    return parseValidatedJsonOutput(
      stdout,
      normalizeQueueRows,
      'Wrangler output did not contain a valid Queue list'
    );
  } catch {
    const lines = stripAnsiSequences(stdout).split('\n');
    const tableLines = lines.filter((line) => line.includes('│'));
    const headerLine = tableLines.find((line) =>
      /(?:^|│)\s*(?:name|queue(?:[_ ]?name)?)\s*(?:│|$)/iu.test(line)
    );
    if (!headerLine) return [];

    const headerCells = headerLine.split('│').map((cell) => cell.trim().toLowerCase());
    const nameIndex = headerCells.findIndex((cell) => /^(?:name|queue(?:[_ ]?name)?)$/u.test(cell));
    if (nameIndex < 0) return [];

    return tableLines
      .filter((line) => line !== headerLine && !/^[\s├┼┤┌┐└┘─]+$/u.test(line))
      .map((line) => line.split('│').map((cell) => cell.trim())[nameIndex] ?? '')
      .filter((name) => name.length > 0 && !/^name$/iu.test(name))
      .map((name) => ({ name }));
  }
}

function isRecognizedQueueListOutput(stdout: string): boolean {
  const normalized = stripAnsiSequences(stdout);
  if (normalized.trim().length === 0 || /no\s+queues?\s+(?:found|exist)/iu.test(normalized)) {
    return true;
  }
  try {
    parseValidatedJsonOutput(
      normalized,
      normalizeQueueRows,
      'Wrangler output did not contain a valid Queue list'
    );
    return true;
  } catch {
    return /(?:^|│)\s*(?:name|queue(?:[_ ]?name)?)\s*(?:│|$)/imu.test(normalized);
  }
}

async function listQueuesViaApi(): Promise<QueueListRow[] | null> {
  return listCloudflarePaginatedResourcesViaApi({
    path: 'queues',
    label: 'Queue list',
    normalizeRows: normalizeQueueRows,
    identityKey: (row) => `${row.name}\u0000${row.id ?? ''}`,
  });
}

export async function listQueues(
  options: { strictOutput?: boolean; requireIds?: boolean } = {}
): Promise<Array<{ name: string; id?: string }>> {
  let apiError: unknown;
  try {
    // Wrangler's Queue command exposes one page at a time. Prefer the REST inventory because it
    // carries stable pagination metadata and is therefore the authoritative complete snapshot.
    const apiQueues = await listQueuesViaApi();
    if (apiQueues) {
      if (options.requireIds) assertQueueInventoryHasUniqueIds(apiQueues, 'Cloudflare API');
      return apiQueues;
    }
  } catch (error) {
    apiError = error;
  }

  let wranglerError: unknown;
  try {
    const queues: QueueListRow[] = [];
    const seen = new Set<string>();
    // The current Cloudflare Queues endpoint used by Wrangler defaults to 20 rows per page.
    // Continue whenever a page is full; API-first operation above remains the preferred path.
    const wranglerPageSize = 20;
    for (let page = 1; page <= CLOUDFLARE_INVENTORY_MAX_PAGES; page++) {
      const { stdout } = await wrangler(
        page === 1 ? ['queues', 'list'] : ['queues', 'list', '--page', String(page)]
      );
      if (options.strictOutput && !isRecognizedQueueListOutput(stdout)) {
        throw new Error('Wrangler output did not contain a recognizable Queue list');
      }
      const pageRows = parseQueueRows(stdout);
      for (const queue of pageRows) {
        const identity = `${queue.name}\u0000${queue.id ?? ''}`;
        if (seen.has(identity)) {
          throw new Error('Wrangler Queue inventory repeated a page or resource identity');
        }
        seen.add(identity);
      }
      queues.push(...pageRows);
      if (queues.length > CLOUDFLARE_INVENTORY_MAX_RESOURCES) {
        throw new Error('Wrangler Queue inventory exceeded the resource limit');
      }
      if (pageRows.length < wranglerPageSize) {
        if (options.requireIds) assertQueueInventoryHasUniqueIds(queues, 'Wrangler');
        return queues;
      }
    }
    throw new Error('Wrangler Queue inventory exceeded the pagination limit');
  } catch (error) {
    wranglerError = error;
  }

  throw new Error(
    `Failed to list Queues via the Cloudflare API (${describeInventoryError(
      apiError,
      'credentials unavailable'
    )}) and Wrangler (${describeInventoryError(wranglerError, 'unknown Wrangler error')})`
  );
}

/**
 * List legacy Pages projects
 */
export interface PagesProjectProviderIdentity {
  name: string;
  id?: string;
  createdOn?: string;
  domains?: string[];
}

function normalizePagesProjectRows(rows: unknown): PagesProjectProviderIdentity[] {
  if (!Array.isArray(rows)) throw new TypeError('Pages project list was not an array');
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new TypeError(`Pages project list row ${index} was not an object`);
    }
    const value = row as {
      name?: unknown;
      id?: unknown;
      created_on?: unknown;
      domains?: unknown;
    };
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const createdOn = normalizeCloudflareTimestamp(
      value.created_on,
      `Pages project list row ${index} created_on`
    );
    if (!name || !/^[a-z0-9][a-z0-9-]*$/u.test(name) || !id || !createdOn) {
      throw new TypeError(`Pages project list row ${index} omitted exact provider identity`);
    }
    if (
      value.domains !== undefined &&
      (!Array.isArray(value.domains) ||
        value.domains.some((domain) => typeof domain !== 'string' || !domain.trim()))
    ) {
      throw new TypeError(`Pages project list row ${index} contained invalid domains`);
    }
    return {
      name,
      id,
      createdOn,
      ...(Array.isArray(value.domains) ? { domains: [...value.domains] as string[] } : {}),
    };
  });
}

function parsePagesProjectListOutput(stdout: string): {
  projects: PagesProjectProviderIdentity[];
  recognized: boolean;
} {
  const normalized = stripAnsiSequences(stdout);
  const trimmed = normalized.trim();
  if (trimmed.length === 0 || /no\s+(?:pages\s+)?projects?\s+(?:found|exist)/iu.test(trimmed)) {
    return { projects: [], recognized: true };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && 'result' in parsed
        ? (parsed as { result?: unknown }).result
        : undefined;
    if (Array.isArray(rows)) {
      const projects = rows.map((row, index) => {
        const name =
          row && typeof row === 'object' && 'name' in row
            ? (row as { name?: unknown }).name
            : undefined;
        if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/iu.test(name.trim())) {
          throw new TypeError(`Pages project list row ${index} did not contain a valid name`);
        }
        return { name: name.trim() };
      });
      return { projects, recognized: true };
    }
  } catch {
    // Continue with the Wrangler table and legacy plain-text formats.
  }

  const lines = normalized.split('\n').filter((line) => line.trim());
  const projects: Array<{ name: string }> = [];
  let recognizedTable = false;

  for (const line of lines) {
    // Skip header lines and empty lines
    if (
      line.startsWith('│') ||
      line.startsWith('┌') ||
      line.startsWith('└') ||
      line.startsWith('├')
    ) {
      if (/\b(?:project\s+)?name\b/iu.test(line)) recognizedTable = true;
      // Table format - extract project name from table row
      const cells = line
        .split('│')
        .map((s) => s.trim())
        .filter(Boolean);
      if (
        cells.length > 0 &&
        cells[0] &&
        !cells[0].includes('Name') &&
        !cells[0].includes('─') &&
        /^[a-z0-9][a-z0-9-]*$/iu.test(cells[0])
      ) {
        projects.push({ name: cells[0] });
      }
    } else if (/^[a-z0-9][a-z0-9-]*$/iu.test(line.trim())) {
      // Plain text format
      projects.push({ name: line.trim() });
    }
  }
  return {
    projects: Array.from(new Map(projects.map((project) => [project.name, project])).values()),
    recognized: recognizedTable || projects.length > 0,
  };
}

async function listPagesProjectsViaApi(): Promise<PagesProjectProviderIdentity[] | null> {
  return listCloudflarePaginatedResourcesViaApi({
    path: 'pages/projects',
    label: 'Pages project list',
    normalizeRows: normalizePagesProjectRows,
    identityKey: (row) => `${row.name}\u0000${row.id}\u0000${row.createdOn}`,
    perPage: 100,
  });
}

export async function listPagesProjects(
  options: { strictOutput?: boolean; requireIdentity?: boolean } = {}
): Promise<PagesProjectProviderIdentity[]> {
  let apiError: unknown;
  try {
    const projects = await listPagesProjectsViaApi();
    if (projects) return projects;
  } catch (error) {
    apiError = error;
  }

  try {
    const { stdout } = await wrangler(['pages', 'project', 'list']);
    const parsed = parsePagesProjectListOutput(stdout);
    if (options.strictOutput && !parsed.recognized) {
      throw new Error('Wrangler output did not contain a recognizable Pages project list');
    }
    if (options.requireIdentity && parsed.projects.length > 0) {
      throw new Error(
        'Cloudflare Pages inventory omitted provider ID/created_on; name-only cleanup is blocked',
        { cause: apiError }
      );
    }
    return parsed.projects;
  } catch (error) {
    if (apiError) {
      throw new AggregateError(
        [apiError, error],
        'Pages project inventory failed through both the Cloudflare API and Wrangler'
      );
    }
    throw error;
  }
}

/**
 * Delete a legacy Pages project
 */
async function getPagesProjectViaApi(input: {
  name: string;
  credentials: CloudflareDeletionCredentials;
}): Promise<PagesProjectProviderIdentity | null> {
  const { response, data } = await requestCloudflareApiJson<{
    success?: boolean;
    result?: unknown;
    errors?: CloudflareApiMessage[];
    messages?: CloudflareApiMessage[];
  }>(
    `https://api.cloudflare.com/client/v4/accounts/${input.credentials.accountId}/pages/projects/${encodeURIComponent(input.name)}`,
    { headers: { Authorization: `Bearer ${input.credentials.token}` } },
    { label: 'Cloudflare Pages project lookup', retryMode: 'read' }
  );
  if (response.status === 404) return null;
  if (!response.ok || data.success === false) {
    throw new Error(`Cloudflare Pages project lookup failed (${response.status})`);
  }
  const [project] = normalizePagesProjectRows([data.result]);
  return project;
}

function assertPagesProjectIdentity(
  live: PagesProjectProviderIdentity,
  expected: DeletionPagesIdentity
): void {
  if (
    live.name !== expected.name ||
    live.id !== expected.id ||
    live.createdOn !== expected.createdOn
  ) {
    throw new Error(`Pages project ${expected.name} provider identity changed`);
  }
}

export async function deletePagesProject(identity: DeletionPagesIdentity): Promise<boolean> {
  try {
    const credentials = await resolveCloudflareInventoryCredentials();
    if (!credentials) throw new Error('Cloudflare Pages API credentials are unavailable');
    let live = await getPagesProjectViaApi({ name: identity.name, credentials });
    if (!live) return true;
    assertPagesProjectIdentity(live, identity);

    for (const domain of live.domains ?? []) {
      if (domain.endsWith('.pages.dev')) continue;
      live = await getPagesProjectViaApi({ name: identity.name, credentials });
      if (!live) return true;
      assertPagesProjectIdentity(live, identity);
      const { response, data } = await requestCloudflareApiJson<{
        success?: boolean;
        errors?: CloudflareApiMessage[];
      }>(
        `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/pages/projects/${encodeURIComponent(identity.name)}/domains/${encodeURIComponent(domain)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${credentials.token}` },
        },
        { label: 'Cloudflare Pages custom-domain delete', retryMode: 'non_idempotent_mutation' }
      );
      if (response.status !== 404 && (!response.ok || data.success === false)) {
        throw new Error(`Cloudflare Pages custom-domain delete failed (${response.status})`);
      }
    }

    live = await getPagesProjectViaApi({ name: identity.name, credentials });
    if (!live) return true;
    assertPagesProjectIdentity(live, identity);
    try {
      const { response, data } = await requestCloudflareApiJson<{
        success?: boolean;
        errors?: CloudflareApiMessage[];
      }>(
        `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/pages/projects/${encodeURIComponent(identity.name)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${credentials.token}` },
        },
        { label: 'Cloudflare Pages project delete', retryMode: 'non_idempotent_mutation' }
      );
      if (response.status === 404) return true;
      return response.ok && data.success !== false;
    } catch {
      // A transport failure may follow a committed name-only DELETE. Reconcile by exact provider
      // identity and never retry against a same-name replacement.
      const after = await getPagesProjectViaApi({ name: identity.name, credentials });
      if (!after) return true;
      assertPagesProjectIdentity(after, identity);
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Detect all Authrim environments from existing resources
 */
export type EnvironmentInventoryResource =
  | 'Workers'
  | 'D1 databases'
  | 'KV namespaces'
  | 'Queues'
  | 'R2 buckets'
  | 'Pages projects';

export interface DeletionResourceSelection {
  deleteWorkers: boolean;
  deleteD1: boolean;
  deleteKV: boolean;
  deleteQueues: boolean;
  deleteR2: boolean;
  deletePages: boolean;
}

export function getRequiredDeletionInventoryResources(
  selection: DeletionResourceSelection
): EnvironmentInventoryResource[] {
  const resources: EnvironmentInventoryResource[] = [];
  if (selection.deleteWorkers) resources.push('Workers');
  if (selection.deleteD1) resources.push('D1 databases');
  if (selection.deleteKV) resources.push('KV namespaces');
  // Worker deletion can require Queue-consumer detachments even when the Queue itself is retained.
  // Queue inventory is therefore a required ownership boundary for both operations.
  if (selection.deleteQueues || selection.deleteWorkers) resources.push('Queues');
  if (selection.deleteR2) resources.push('R2 buckets');
  if (selection.deletePages) resources.push('Pages projects');
  return resources;
}

export async function detectEnvironments(
  onProgress?: (message: string) => void,
  options: {
    requiredResources?: readonly EnvironmentInventoryResource[];
    /** Include dynamic Control-managed storage for this exact environment in the same scan. */
    includeControlManagedResourcesForEnvironment?: string;
  } = {}
): Promise<EnvironmentInfo[]> {
  const environments = new Map<string, EnvironmentInfo>();

  const progress = onProgress || (() => {});
  const requiredResources = new Set(options.requiredResources ?? []);
  const controlManagedEnvironment = options.includeControlManagedResourcesForEnvironment;
  if (controlManagedEnvironment) validateEnvName(controlManagedEnvironment);
  const handleScanError = (resourceType: EnvironmentInventoryResource, error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    progress(`  ⚠️ Could not scan ${resourceType}: ${detail}`);
    if (requiredResources.has(resourceType)) {
      throw new EnvironmentInventoryUnavailableError(resourceType, error);
    }
  };

  // Scan Workers first — environments are only valid if Workers or D1 exist
  progress('Scanning Workers...');
  const workerEnvs = new Set<string>();
  try {
    const workers = await listWorkers({
      onRetry: progress,
    });
    for (const w of workers) {
      const match = w.name.match(AUTHRIM_PATTERNS.worker);
      if (match) {
        const env = match[1].toLowerCase();
        workerEnvs.add(env);
        if (!environments.has(env)) {
          environments.set(env, {
            env,
            workers: [],
            d1: [],
            kv: [],
            queues: [],
            r2: [],
            pages: [],
          });
        }
        environments.get(env)!.workers.push({ name: w.name });
      }
    }
  } catch (error) {
    handleScanError('Workers', error);
  }

  progress('Scanning D1 databases...');
  const d1Envs = new Set<string>();
  try {
    const databases = await listD1Databases();
    for (const db of databases) {
      const match = db.name.match(AUTHRIM_PATTERNS.d1);
      const matchedEnvironment = match
        ? (match[1] ?? match[3]).toLowerCase()
        : controlManagedEnvironment &&
            isControlManagedD1NameForEnvironment(controlManagedEnvironment, db.name)
          ? controlManagedEnvironment
          : null;
      if (matchedEnvironment) {
        const env = matchedEnvironment;
        d1Envs.add(env);
        if (!environments.has(env)) {
          environments.set(env, {
            env,
            workers: [],
            d1: [],
            kv: [],
            queues: [],
            r2: [],
            pages: [],
          });
        }
        environments.get(env)!.d1.push({ name: db.name, id: db.uuid });
      }
    }
  } catch (error) {
    handleScanError('D1 databases', error);
  }

  progress('Scanning KV namespaces...');
  try {
    const namespaces = await listKVNamespaces();
    for (const ns of namespaces) {
      const match = ns.title.match(AUTHRIM_PATTERNS.kv);
      const matchedEnvironment = match
        ? match[1].toLowerCase()
        : controlManagedEnvironment &&
            isControlManagedKVNameForEnvironment(controlManagedEnvironment, ns.title)
          ? controlManagedEnvironment
          : null;
      if (matchedEnvironment) {
        const env = matchedEnvironment;
        // Keep KV-only environments visible. An interrupted provision/delete or manual cleanup
        // can leave the deterministic namespace after every Worker and D1 is gone; hiding it here
        // would let a later fresh attempt mutate D1 before discovering the KV name collision.
        if (!environments.has(env)) {
          environments.set(env, {
            env,
            workers: [],
            d1: [],
            kv: [],
            queues: [],
            r2: [],
            pages: [],
          });
        }
        environments.get(env)!.kv.push({ name: ns.title, id: ns.id });
      }
    }
  } catch (error) {
    handleScanError('KV namespaces', error);
  }

  progress('Scanning Queues...');
  try {
    const queuesRequired = requiredResources.has('Queues');
    const queues = await listQueues({
      strictOutput: queuesRequired,
      requireIds: queuesRequired,
    });
    for (const q of queues) {
      const match = q.name.match(AUTHRIM_PATTERNS.queue);
      if (match) {
        const env = match[1].toLowerCase();
        if (!environments.has(env)) {
          environments.set(env, {
            env,
            workers: [],
            d1: [],
            kv: [],
            queues: [],
            r2: [],
            pages: [],
          });
        }
        environments.get(env)!.queues.push({ name: q.name, id: q.id });
      }
    }
  } catch (error) {
    handleScanError('Queues', error);
  }

  progress('Scanning R2 buckets...');
  try {
    const r2Required = requiredResources.has('R2 buckets');
    const buckets = await listR2Buckets({
      throwOnError: r2Required,
      requireIdentity: r2Required,
    });
    for (const bucket of buckets) {
      const match = bucket.name.match(AUTHRIM_PATTERNS.r2);
      const matchedEnvironment = match
        ? match[1].toLowerCase()
        : controlManagedEnvironment &&
            isControlManagedR2NameForEnvironment(controlManagedEnvironment, bucket.name)
          ? controlManagedEnvironment
          : null;
      if (matchedEnvironment) {
        const env = matchedEnvironment;
        if (!environments.has(env)) {
          environments.set(env, {
            env,
            workers: [],
            d1: [],
            kv: [],
            queues: [],
            r2: [],
            pages: [],
          });
        }
        environments.get(env)!.r2.push(bucket);
      }
    }
  } catch (error) {
    handleScanError('R2 buckets', error);
  }

  progress('Scanning legacy Pages projects...');
  try {
    const pagesProjects = await listPagesProjects({
      strictOutput: requiredResources.has('Pages projects'),
      requireIdentity: requiredResources.has('Pages projects'),
    });
    for (const project of pagesProjects) {
      const match = project.name.match(AUTHRIM_PATTERNS.pages);
      if (match) {
        const env = match[1].toLowerCase();
        // Keep Pages-only legacy environments visible. Older installs can leave Pages projects
        // after every Worker and storage resource is gone; hiding those projects makes the
        // environment impossible to finish deleting through Setup.
        if (!environments.has(env)) {
          environments.set(env, {
            env,
            workers: [],
            d1: [],
            kv: [],
            queues: [],
            r2: [],
            pages: [],
          });
        }
        environments.get(env)!.pages.push(project);
      }
    }
  } catch (error) {
    handleScanError('Pages projects', error);
  }

  // Keep independently listed KV, Queues, R2, and legacy Pages resources so interrupted operations are
  // discoverable and fresh provisioning can reject deterministic-name collisions up front.
  for (const [env, info] of environments) {
    if (
      info.workers.length === 0 &&
      info.d1.length === 0 &&
      info.kv.length === 0 &&
      info.queues.length === 0 &&
      info.r2.length === 0 &&
      info.pages.length === 0
    ) {
      environments.delete(env);
    }
  }

  progress(`Found ${environments.size} environment(s)`);

  return Array.from(environments.values()).sort((a, b) => a.env.localeCompare(b.env));
}

export async function confirmEnvironmentObservedForDeletion(
  env: string,
  selection: DeletionResourceSelection,
  onProgress?: (message: string) => void
): Promise<boolean> {
  const environments = await detectEnvironments(onProgress, {
    requiredResources: getRequiredDeletionInventoryResources(selection),
  });
  if (environments.some((candidate) => candidate.env === env)) return true;

  if (!selection.deleteD1 && !selection.deleteKV && !selection.deleteR2) return false;
  try {
    return await hasControlManagedResourcesForEnvironment(env, {
      d1: selection.deleteD1,
      kv: selection.deleteKV,
      r2: selection.deleteR2,
    });
  } catch (error) {
    throw new EnvironmentInventoryUnavailableError('Control-managed resources', error);
  }
}

type PostDeleteVerificationStatus =
  | 'not_required'
  | 'verified_empty'
  | 'resources_remaining'
  | 'inventory_unavailable';

interface PostDeleteVerificationResult {
  status: Exclude<PostDeleteVerificationStatus, 'not_required'>;
  attempts: number;
  error?: string;
}

async function verifyEnvironmentAbsentAfterDeletion(options: {
  env: string;
  selection: DeletionResourceSelection;
  attempts: number;
  retryDelayMs: number;
  onProgress: (message: string) => void;
  onDetail?: (message: string) => void;
}): Promise<PostDeleteVerificationResult> {
  const attempts = Math.max(1, Math.min(Math.trunc(options.attempts), 10));
  const retryDelayMs = Math.max(0, Math.min(Math.trunc(options.retryDelayMs), 30_000));
  let lastStatus: PostDeleteVerificationResult['status'] = 'resources_remaining';
  let lastError: unknown;

  options.onProgress('🔎 Verifying Cloudflare inventory after deletion...');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resourceRemains = await confirmEnvironmentObservedForDeletion(
        options.env,
        options.selection,
        options.onDetail
      );
      if (!resourceRemains) {
        options.onProgress(`  ✅ Cloudflare inventory is empty (attempt ${attempt}/${attempts})`);
        return { status: 'verified_empty', attempts: attempt };
      }
      lastStatus = 'resources_remaining';
      lastError = undefined;
      options.onProgress(
        `  ⏳ Cloudflare still reports environment resources (attempt ${attempt}/${attempts})`
      );
    } catch (error) {
      lastStatus = 'inventory_unavailable';
      lastError = error;
      options.onProgress(
        `  ⚠️ Cloudflare inventory readback failed (attempt ${attempt}/${attempts}): ${sanitizeError(
          error instanceof EnvironmentInventoryUnavailableError && error.cause !== undefined
            ? error.cause
            : error
        )}`
      );
    }

    if (attempt < attempts && retryDelayMs > 0 && process.env.NODE_ENV !== 'test') {
      await sleep(retryDelayMs * attempt);
    }
  }

  return {
    status: lastStatus,
    attempts,
    error:
      lastError === undefined
        ? undefined
        : sanitizeError(
            lastError instanceof EnvironmentInventoryUnavailableError &&
              lastError.cause !== undefined
              ? lastError.cause
              : lastError
          ),
  };
}

/**
 * Delete a Worker
 */
type WorkerDeleteResult =
  | { status: 'deleted' }
  | { status: 'already_absent'; error: string }
  | { status: 'failed'; error: string };

function isWorkerAlreadyAbsentError(error: string): boolean {
  return /(not found|does not exist|could not find|no such script|10007)/iu.test(error);
}

async function assertWorkerDeletionIdentity(
  target: WorkerDeletionTarget,
  onRetry?: (message: string) => void
): Promise<'owned' | 'already_absent'> {
  const inventory = await listWorkers({ onRetry });
  const byName = new Map(inventory.map((worker) => [worker.name, worker]));
  const live = byName.get(target.name);
  if (!target.cloudflareScriptTag) {
    if (live) {
      throw new Error(
        `Worker ownership mismatch for ${target.name}: a script appeared after absence was recorded`
      );
    }
    return 'already_absent';
  }
  const tagOwner = inventory.find((worker) => worker.tag === target.cloudflareScriptTag);
  if (!live) {
    if (tagOwner && tagOwner.name !== target.name) {
      throw new Error(
        `Worker ownership mismatch for ${target.name}: its immutable tag belongs to ${tagOwner.name}`
      );
    }
    return 'already_absent';
  }
  if (!live.tag || live.tag !== target.cloudflareScriptTag) {
    throw new Error(
      `Worker ownership mismatch for ${target.name}: the immutable script tag changed`
    );
  }
  return 'owned';
}

async function deleteWorkerWithResult(
  name: string,
  onProgress?: (message: string) => void,
  beforeAttempt?: () => Promise<'owned' | 'already_absent'>
): Promise<WorkerDeleteResult> {
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= WORKER_DELETE_MAX_ATTEMPTS; attempt++) {
    try {
      if ((await beforeAttempt?.()) === 'already_absent') {
        return { status: 'already_absent', error: 'Worker is already absent' };
      }
      await wrangler(['delete', '--name', name, '--force']);
      return { status: 'deleted' };
    } catch (error) {
      lastError = sanitizeError(error);
      if (isWorkerAlreadyAbsentError(lastError)) {
        return { status: 'already_absent', error: lastError };
      }
      if (attempt < WORKER_DELETE_MAX_ATTEMPTS) {
        onProgress?.(
          `  ⏳ Retrying Worker deletion for ${name} (${attempt + 1}/${WORKER_DELETE_MAX_ATTEMPTS})...`
        );
        if (process.env.NODE_ENV !== 'test') {
          await sleep(WORKER_DELETE_RETRY_DELAY_MS * attempt);
        }
      }
    }
  }

  return { status: 'failed', error: lastError };
}

export async function deleteWorker(name: string): Promise<boolean> {
  const result = await deleteWorkerWithResult(name);
  return result.status === 'deleted';
}

/**
 * Get Worker deployment info (last deployed, author, version)
 */
export interface WorkerDeploymentInfo {
  name: string;
  exists: boolean;
  lastDeployedAt: string | null;
  author: string | null;
  versionId: string | null;
  source?: string | null;
}

export interface WorkerVersionInfo {
  name: string;
  exists: boolean;
  versionId: string | null;
}

function isWorkerInventoryNotFoundError(message: string): boolean {
  return (
    /does not exist|\b10007\b/iu.test(message) ||
    /(?:worker\s+)?version[^\n]*not found|could not find[^\n]*(?:worker\s+)?version|no such (?:worker\s+)?version/iu.test(
      message
    )
  );
}

function isRetryableWorkerInventoryError(message: string): boolean {
  return (
    isD1RateLimitError(message) ||
    /authentication error\s*\[code:\s*10000\]/iu.test(message) ||
    /\b5\d{2}\b|service unavailable|internal server error|fetch failed|network error|econnreset|etimedout|timed out/iu.test(
      message
    )
  );
}

function parseLatestWorkerDeployment(stdout: string): {
  createdAt: string | null;
  author: string | null;
  versionId: string | null;
  source: string | null;
} {
  const deploymentStarts = Array.from(
    stdout.matchAll(/^Created:\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s*$/gm)
  );

  let latest: {
    createdAt: string;
    index: number;
    nextIndex: number;
  } | null = null;

  for (let index = 0; index < deploymentStarts.length; index++) {
    const match = deploymentStarts[index];
    const createdAt = match[1];
    if (!createdAt || match.index === undefined) {
      continue;
    }
    const parsed = Date.parse(createdAt);
    const latestParsed = latest ? Date.parse(latest.createdAt) : Number.NEGATIVE_INFINITY;
    if (!latest || parsed > latestParsed) {
      latest = {
        createdAt,
        index: match.index,
        nextIndex: deploymentStarts[index + 1]?.index ?? stdout.length,
      };
    }
  }

  if (!latest) {
    return {
      createdAt: null,
      author: null,
      versionId: null,
      source: null,
    };
  }

  const block = stdout.slice(latest.index, latest.nextIndex);
  const authorMatch = block.match(/^Author:\s+(\S+)/m);
  const sourceMatch = block.match(/^Source:\s+(.+)$/m);
  const versionMatch = block.match(/^Version\(s\):\s+\(\d+%\)\s+([a-f0-9-]+)/m);
  return {
    createdAt: latest.createdAt,
    author: authorMatch?.[1] || null,
    versionId: versionMatch?.[1] || null,
    source: sourceMatch?.[1]?.trim() || null,
  };
}

export async function getWorkerDeployments(name: string): Promise<WorkerDeploymentInfo> {
  const maxAttempts = process.env.NODE_ENV === 'test' ? 2 : 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { stdout, stderr } = await wrangler(['deployments', 'list', '--name', name]);

      // Check if worker doesn't exist
      if (isWorkerInventoryNotFoundError(stderr)) {
        return {
          name,
          exists: false,
          lastDeployedAt: null,
          author: null,
          versionId: null,
          source: null,
        };
      }

      // Wrangler does not guarantee newest-first output here; secret changes can appear before
      // the upload deployment. Use the max top-level Created timestamp instead of the first one.
      const deployment = parseLatestWorkerDeployment(stdout);
      if (!deployment.createdAt) {
        throw new Error('wrangler_worker_deployment_output_unparseable');
      }

      return {
        name,
        exists: true,
        lastDeployedAt: deployment.createdAt,
        author: deployment.author,
        versionId: deployment.versionId,
        source: deployment.source,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isWorkerInventoryNotFoundError(message)) {
        return {
          name,
          exists: false,
          lastDeployedAt: null,
          author: null,
          versionId: null,
          source: null,
        };
      }
      const retryable = isRetryableWorkerInventoryError(message);
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`Worker deployment inventory unavailable for ${name}: ${message}`, {
          cause: error,
        });
      }
      if (process.env.NODE_ENV !== 'test') {
        await sleep(Math.min(1_000 * 2 ** (attempt - 1), 5_000));
      }
    }
  }
  throw new Error(`Worker deployment inventory retry loop exited unexpectedly for ${name}`);
}

/** Verify that a specific uploaded Worker Version still belongs to the named script. */
export async function getWorkerVersion(
  name: string,
  versionId: string
): Promise<WorkerVersionInfo> {
  const maxAttempts = process.env.NODE_ENV === 'test' ? 2 : 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { stdout } = await wrangler(['versions', 'view', versionId, '--name', name, '--json'], {
        env: { WRANGLER_LOG: 'log' },
      });
      const parsed = JSON.parse(stdout) as { id?: unknown };
      if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') {
        throw new Error('wrangler_worker_version_output_unparseable');
      }
      if (parsed.id !== versionId) {
        throw new Error(`wrangler_worker_version_id_mismatch:${versionId}:${parsed.id}`);
      }
      return { name, exists: true, versionId: parsed.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isWorkerInventoryNotFoundError(message)) {
        return { name, exists: false, versionId: null };
      }
      if (!isRetryableWorkerInventoryError(message) || attempt === maxAttempts) {
        throw new Error(`Worker version inventory unavailable for ${name}: ${message}`, {
          cause: error,
        });
      }
      if (process.env.NODE_ENV !== 'test') {
        await sleep(Math.min(1_000 * 2 ** (attempt - 1), 5_000));
      }
    }
  }
  throw new Error(`Worker version inventory retry loop exited unexpectedly for ${name}`);
}

/**
 * Delete a Queue
 */
async function deleteQueueWithResult(
  queueId: string,
  credentials?: CloudflareDeletionCredentials
): Promise<ExactResourceDeleteResult> {
  let resolved = credentials;
  try {
    resolved ??= (await resolveCloudflareInventoryCredentials()) ?? undefined;
  } catch (error) {
    return { status: 'failed', error: sanitizeError(error) };
  }
  if (!resolved) {
    return { status: 'failed', error: 'Cloudflare Queue API credentials are unavailable' };
  }
  return deleteCloudflareAccountResourceById({
    credentials: resolved,
    resourcePath: 'queues',
    resourceId: queueId,
    label: 'Cloudflare Queue delete',
  });
}

/** Delete a Queue by its immutable Cloudflare Queue ID. */
export async function deleteQueue(queueId: string): Promise<boolean> {
  const result = await deleteQueueWithResult(queueId);
  return result.status !== 'failed';
}

const OBJECT_CATALOG_R2_BUCKET_SUFFIX_BY_BINDING: Record<string, string> = Object.fromEntries(
  R2_BUCKETS.map((bucket) => [bucket.binding, bucket.suffix])
);

interface ObjectCatalogR2Row {
  bucket_binding?: unknown;
  object_key?: unknown;
}

export function getObjectCatalogR2BucketName(env: string, bucketBinding: string): string | null {
  const suffix = OBJECT_CATALOG_R2_BUCKET_SUFFIX_BY_BINDING[bucketBinding];
  return suffix ? `${env}-${suffix}` : null;
}

export function parseObjectCatalogR2RowsFromWranglerJson(
  stdout: string
): Array<{ bucketBinding: string; objectKey: string }> {
  const payload = JSON.parse(stdout) as Array<{ results?: ObjectCatalogR2Row[] }>;
  const rows = payload?.[0]?.results ?? [];
  return rows.flatMap((row) => {
    if (typeof row.bucket_binding !== 'string' || typeof row.object_key !== 'string') {
      return [];
    }
    return [{ bucketBinding: row.bucket_binding, objectKey: row.object_key }];
  });
}

function formatCloudflareApiMessages(payload: {
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
}): string {
  const entries = [...(payload.errors ?? []), ...(payload.messages ?? [])];
  return entries
    .map((entry) => [entry.code, entry.message].filter(Boolean).join(': '))
    .filter(Boolean)
    .join('; ');
}

async function queryObjectCatalogR2Objects(
  dbName: string
): Promise<Array<{ bucketBinding: string; objectKey: string }>> {
  const { stdout } = await wrangler([
    'd1',
    'execute',
    dbName,
    '--remote',
    '--yes',
    '--command',
    'SELECT bucket_binding, object_key FROM object_catalog_objects WHERE deleted_at IS NULL;',
    '--json',
  ]);
  return parseObjectCatalogR2RowsFromWranglerJson(stdout);
}

async function collectKnownR2ObjectsByBucket(
  env: string,
  buckets: Array<{ name: string }>,
  onProgress?: (message: string) => void
): Promise<Map<string, string[]>> {
  const targetBuckets = new Set(buckets.map((bucket) => bucket.name));
  const objectsByBucket = new Map<string, Set<string>>();
  const dbNames = [getD1DatabaseName(env, 'core-db'), getD1DatabaseName(env, 'admin-db')];

  for (const dbName of dbNames) {
    try {
      const rows = await queryObjectCatalogR2Objects(dbName);
      for (const row of rows) {
        const bucketName = getObjectCatalogR2BucketName(env, row.bucketBinding);
        if (!bucketName || !targetBuckets.has(bucketName)) {
          continue;
        }
        const keys = objectsByBucket.get(bucketName) ?? new Set<string>();
        keys.add(row.objectKey);
        objectsByBucket.set(bucketName, keys);
      }
    } catch (error) {
      onProgress?.(`  ⚠️ Could not read object catalog from ${dbName}: ${sanitizeError(error)}`);
    }
  }

  return new Map(
    [...objectsByBucket.entries()].map(([bucketName, keys]) => [bucketName, [...keys]])
  );
}

async function removeKnownR2Objects(
  bucketName: string,
  objectKeys: string[],
  onProgress?: (message: string) => void,
  verifyOwnership?: () => Promise<void>
): Promise<void> {
  if (objectKeys.length === 0) {
    return;
  }

  onProgress?.(`  🧹 Emptying known R2 objects: ${bucketName} (${objectKeys.length})...`);
  const concurrency = 5;
  let removed = 0;
  let completed = 0;
  for (let offset = 0; offset < objectKeys.length; offset += concurrency) {
    await verifyOwnership?.();
    const batch = objectKeys.slice(offset, offset + concurrency);
    await Promise.all(
      batch.map(async (objectKey) => {
        await wrangler(['r2', 'object', 'delete', `${bucketName}/${objectKey}`, '--remote']);
        removed += 1;
        completed += 1;
        if (completed % 50 === 0 || completed === objectKeys.length) {
          onProgress?.(
            `  R2 object cleanup progress for ${bucketName}: ${completed}/${objectKeys.length}`
          );
        }
      })
    );
  }
  onProgress?.(`  R2 objects removed for ${bucketName}: ${removed}/${objectKeys.length}`);
}

export async function resolveR2ApiCredentials(input: {
  configuredAccountId?: string;
  resolveAccountId: () => Promise<string | null>;
  readToken: () => Promise<CloudflareApiToken | null>;
  inferSingleAccountId: (token: string) => Promise<string | null>;
}): Promise<{ accountId: string; token: string; source: CloudflareApiToken['source'] } | null> {
  let tokenInfo = await input.readToken();
  if (!tokenInfo?.token) {
    return null;
  }

  let oauthAccountId: string | null = null;
  if (tokenInfo.source === 'oauth') {
    // A pinned account is routing authority, not proof that the cached OAuth token is fresh.
    oauthAccountId = await input.resolveAccountId();
    const refreshed = await input.readToken();
    if (!refreshed || refreshed.source !== 'oauth') return null;
    tokenInfo = refreshed;
  }

  if (input.configuredAccountId && oauthAccountId && input.configuredAccountId !== oauthAccountId) {
    throw new Error('cloudflare_oauth_account_id_mismatch');
  }

  const accountId =
    input.configuredAccountId ||
    oauthAccountId ||
    (await input.resolveAccountId()) ||
    (await input.inferSingleAccountId(tokenInfo.token));
  if (!accountId) {
    return null;
  }

  return { accountId, token: tokenInfo.token, source: tokenInfo.source };
}

async function getR2ApiCredentials(): Promise<{
  accountId: string;
  token: string;
  source: CloudflareApiToken['source'];
} | null> {
  return resolveR2ApiCredentials({
    configuredAccountId: process.env.CLOUDFLARE_ACCOUNT_ID?.trim(),
    resolveAccountId: getAccountId,
    readToken: getCloudflareApiToken,
    inferSingleAccountId: getSingleAccountIdViaApi,
  });
}

export interface R2ObjectMetadata {
  key: string;
  size: number | null;
  lastModified: string | null;
  etag: string | null;
}

type CloudflareR2ObjectRow = NonNullable<CloudflareR2ObjectListResponse['result']>[number];

function parseR2ObjectListCursor(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > R2_OBJECT_LIST_MAX_CURSOR_LENGTH ||
    value.trim() !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error('cloudflare_r2_object_list_cursor_invalid');
  }
  return value;
}

async function listR2ObjectRowsViaApi(input: {
  bucketName: string;
  credentials: {
    accountId: string;
    token: string;
    source?: CloudflareApiToken['source'];
  };
  prefix?: string;
}): Promise<CloudflareR2ObjectRow[]> {
  const objects: CloudflareR2ObjectRow[] = [];
  const seenKeys = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 1; page <= R2_OBJECT_LIST_MAX_PAGES; page++) {
    const pageLimit = 1000;
    const params = new URLSearchParams({ per_page: String(pageLimit) });
    if (input.prefix) params.set('prefix', input.prefix);
    if (cursor) params.set('cursor', cursor);
    const { data } = await requestR2Api<CloudflareR2ObjectListResponse>(
      `https://api.cloudflare.com/client/v4/accounts/${input.credentials.accountId}/r2/buckets/${encodeURIComponent(input.bucketName)}/objects?${params.toString()}`,
      { headers: { Authorization: `Bearer ${input.credentials.token}` } },
      'Cloudflare R2 object list',
      false,
      input.credentials.source ?? 'env'
    );
    if (!Array.isArray(data.result)) {
      throw new Error('cloudflare_r2_object_list_response_invalid');
    }
    if (
      data.result_info !== undefined &&
      (!data.result_info || typeof data.result_info !== 'object' || Array.isArray(data.result_info))
    ) {
      throw new Error('cloudflare_r2_object_list_response_invalid');
    }
    const rawTruncated = data.result_info?.is_truncated;
    if (rawTruncated !== undefined && typeof rawTruncated !== 'boolean') {
      throw new Error('cloudflare_r2_object_list_response_invalid');
    }
    const rawCursor = data.result_info?.cursor;

    for (const object of data.result) {
      if (
        !object ||
        typeof object !== 'object' ||
        typeof object.key !== 'string' ||
        object.key.length === 0
      ) {
        throw new Error('cloudflare_r2_object_list_row_invalid');
      }
      if (seenKeys.has(object.key)) {
        throw new Error('cloudflare_r2_object_list_duplicate_key');
      }
      seenKeys.add(object.key);
      objects.push(object);
      if (objects.length > R2_OBJECT_LIST_MAX_KEYS) {
        throw new Error('cloudflare_r2_object_list_key_limit_exceeded');
      }
    }

    // Cloudflare's current List Objects schema marks result_info and all of its fields optional,
    // and the live API omits result_info for a complete prefix lookup. Accept that documented
    // terminal form only when the page is below the requested limit. A full page without explicit
    // pagination evidence is ambiguous and must fail closed so cleanup cannot silently skip keys.
    if (rawTruncated === false) {
      if (rawCursor !== undefined && rawCursor !== null && rawCursor !== '') {
        throw new Error('cloudflare_r2_object_list_pagination_conflict');
      }
      return objects;
    }
    if (
      rawTruncated === undefined &&
      (rawCursor === undefined || rawCursor === null || rawCursor === '')
    ) {
      if (data.result.length >= pageLimit) {
        throw new Error('cloudflare_r2_object_list_pagination_metadata_missing');
      }
      return objects;
    }
    if (data.result.length === 0) {
      throw new Error('cloudflare_r2_object_list_truncated_empty_page');
    }
    const nextCursor = parseR2ObjectListCursor(rawCursor);
    if (seenCursors.has(nextCursor)) {
      throw new Error('cloudflare_r2_object_list_cursor_cycle');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error('cloudflare_r2_object_list_page_limit_exceeded');
}

/**
 * List R2 objects through Cloudflare's REST API. Wrangler does not expose an object-list command,
 * while the REST API provides cursor pagination and prefix filtering.
 */
export async function listR2Objects(input: {
  bucketName: string;
  prefix?: string;
}): Promise<R2ObjectMetadata[]> {
  if (!R2_BUCKET_NAME_PATTERN.test(input.bucketName)) throw new Error('invalid_r2_bucket_name');
  if (input.prefix && (input.prefix.startsWith('/') || input.prefix.includes('\\'))) {
    throw new Error('invalid_r2_object_prefix');
  }
  const credentials = await getR2ApiCredentials();
  if (!credentials) throw new Error('cloudflare_r2_api_credentials_unavailable');

  return (
    await listR2ObjectRowsViaApi({
      bucketName: input.bucketName,
      credentials,
      ...(input.prefix ? { prefix: input.prefix } : {}),
    })
  ).map((object) => ({
    key: object.key!,
    size: typeof object.size === 'number' && Number.isFinite(object.size) ? object.size : null,
    lastModified: typeof object.last_modified === 'string' ? object.last_modified : null,
    etag: typeof object.etag === 'string' ? object.etag : null,
  }));
}

async function getSingleAccountIdViaApi(token: string): Promise<string | null> {
  try {
    const { response, data } = await requestCloudflareApiJson<CloudflareAccountsResponse>(
      'https://api.cloudflare.com/client/v4/accounts?per_page=2',
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      { label: 'Cloudflare account lookup', retryMode: 'read' }
    );
    if (!response.ok || data.success === false) {
      return null;
    }

    const accounts = (data.result ?? []).flatMap((account) =>
      typeof account.id === 'string' ? [account.id] : []
    );
    return accounts.length === 1 ? accounts[0] : null;
  } catch {
    return null;
  }
}

async function listAllR2ObjectKeysViaApi(
  bucketName: string,
  credentials: {
    accountId: string;
    token: string;
    source?: CloudflareApiToken['source'];
  }
): Promise<string[]> {
  return (await listR2ObjectRowsViaApi({ bucketName, credentials })).map((object) => object.key!);
}

async function requestR2Api<
  T extends {
    success?: boolean;
    errors?: CloudflareApiMessage[];
    messages?: CloudflareApiMessage[];
  },
>(
  url: string,
  init: NonNullable<Parameters<typeof fetch>[1]>,
  label: string,
  acceptNotFound = false,
  credentialSource: CloudflareApiToken['source'] = 'env'
): Promise<{ data: T; notFound: boolean }> {
  const method = (init.method ?? 'GET').toUpperCase();
  const retryMode: CloudflareApiRetryMode =
    method === 'GET' || method === 'HEAD' ? 'read' : 'non_idempotent_mutation';
  let requestInit = init;
  for (let authAttempt = 1; authAttempt <= 2; authAttempt++) {
    const { response, data } = await requestCloudflareApiJson<T>(url, requestInit, {
      label,
      retryMode,
      maxAttempts: 7,
      isRetryableResponse: (_response, payload) => {
        const errors =
          payload && typeof payload === 'object' && Array.isArray(payload.errors)
            ? payload.errors
            : [];
        return errors.some(
          (error) => error.code === 971 || /throttl|too many requests/iu.test(error.message ?? '')
        );
      },
    });
    if (!data || typeof data !== 'object') {
      throw new Error(`${label} returned an invalid response`);
    }
    const errorCodes = (data.errors ?? []).flatMap((error) =>
      typeof error.code === 'number' ? [error.code] : []
    );
    if (
      shouldRefreshCloudflareOAuthCredential({
        status: response.status,
        errorCodes,
        source: credentialSource,
        attempt: authAttempt,
      })
    ) {
      const accountId = new URL(url).pathname.match(/\/accounts\/([^/]+)/u)?.[1];
      const refreshed = accountId
        ? await refreshPinnedCloudflareOAuthToken(decodeURIComponent(accountId))
        : null;
      if (refreshed) {
        const headers = new Headers(requestInit.headers);
        headers.set('Authorization', `Bearer ${refreshed.token}`);
        requestInit = { ...requestInit, headers };
        continue;
      }
    }
    if (acceptNotFound && response.status === 404) return { data, notFound: true };
    if (response.ok && data.success !== false) return { data, notFound: false };
    const detail = formatCloudflareApiMessages(data);
    throw new Error(`${label} failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  throw new Error(`${label} OAuth refresh retry loop exited unexpectedly`);
}

async function getR2ObjectBytesViaApi(input: {
  bucketName: string;
  objectKey: string;
  credentials: {
    accountId: string;
    token: string;
    source?: CloudflareApiToken['source'];
  };
  maxBytes: number;
}): Promise<Uint8Array | null> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${input.credentials.accountId}/r2/buckets/` +
    `${encodeURIComponent(input.bucketName)}/objects/${encodeR2ObjectKeyPath(input.objectKey)}`;
  let lastError: unknown;
  let credentials = input.credentials;
  let authRefreshAttempted = false;
  for (let attempt = 1; attempt <= CLOUDFLARE_API_READ_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CLOUDFLARE_API_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${credentials.token}` },
        signal: controller.signal,
      });
      if (response.status === 404) return null;
      let errorCodes: number[] = [];
      if (!response.ok && typeof response.json === 'function') {
        try {
          const payload = (await response.json()) as { errors?: CloudflareApiMessage[] };
          errorCodes = (payload.errors ?? []).flatMap((error) =>
            typeof error.code === 'number' ? [error.code] : []
          );
        } catch {
          // The status alone is sufficient for a 401 refresh decision.
        }
      }
      if (
        !authRefreshAttempted &&
        shouldRefreshCloudflareOAuthCredential({
          status: response.status,
          errorCodes,
          source: credentials.source ?? 'env',
          attempt: 1,
        })
      ) {
        authRefreshAttempted = true;
        const refreshed = await refreshPinnedCloudflareOAuthToken(credentials.accountId);
        if (refreshed) {
          credentials = refreshed;
          continue;
        }
      }
      if (isRetryableCloudflareHttpStatus(response.status)) {
        throw new Error(`Cloudflare R2 ownership marker read failed (${response.status})`);
      }
      if (!response.ok) {
        throw new Error(`Cloudflare R2 ownership marker read failed (${response.status})`);
      }
      const declaredSize = Number(response.headers?.get?.('content-length') ?? '');
      if (Number.isFinite(declaredSize) && declaredSize > input.maxBytes) {
        throw new Error('r2_ownership_marker_size_limit_exceeded');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > input.maxBytes) {
        throw new Error('r2_ownership_marker_size_limit_exceeded');
      }
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt >= CLOUDFLARE_API_READ_MAX_ATTEMPTS) break;
      if (process.env.NODE_ENV !== 'test') {
        await sleep(Math.min(500 * 2 ** (attempt - 1), CLOUDFLARE_API_MAX_RETRY_DELAY_MS));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw new Error('Cloudflare R2 ownership marker read failed after bounded retries', {
    cause: lastError,
  });
}

async function deleteR2ObjectViaApi(
  bucketName: string,
  objectKey: string,
  credentials: {
    accountId: string;
    token: string;
    source?: CloudflareApiToken['source'];
  }
): Promise<void> {
  const encodedObjectKey = encodeR2ObjectKeyPath(objectKey);
  const result = await requestR2Api(
    `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodedObjectKey}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${credentials.token}`,
      },
    },
    'Cloudflare R2 object delete',
    true,
    credentials.source ?? 'env'
  );
  if (result.notFound) return;
}

async function deleteR2BucketViaApi(
  bucketName: string,
  credentials: {
    accountId: string;
    token: string;
    source?: CloudflareApiToken['source'];
  }
): Promise<void> {
  const result = await requestR2Api(
    `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/r2/buckets/${encodeURIComponent(bucketName)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${credentials.token}`,
      },
    },
    'Cloudflare R2 bucket delete',
    true,
    credentials.source ?? 'env'
  );
  if (result.notFound) return;
}

async function removeAllR2ObjectsViaApi(
  bucketName: string,
  credentials: {
    accountId: string;
    token: string;
    source?: CloudflareApiToken['source'];
  },
  ownershipMarkerKey: string,
  onProgress?: (message: string) => void,
  verifyOwnership?: () => Promise<void>
): Promise<R2ManualCleanupTarget | null> {
  const objectKeys = (await listAllR2ObjectKeysViaApi(bucketName, credentials)).filter(
    (key) => key !== ownershipMarkerKey
  );
  if (objectKeys.length === 0) {
    return null;
  }

  if (objectKeys.length >= R2_MANUAL_CLEANUP_THRESHOLD) {
    const target: R2ManualCleanupTarget = {
      bucketName,
      objectCount: objectKeys.length,
      dashboardUrl: getR2BucketDashboardUrl(credentials.accountId, bucketName),
    };
    onProgress?.(
      `  ⚠️ Skipping R2 cleanup for ${bucketName}: ${objectKeys.length} objects require manual Dashboard cleanup`
    );
    return target;
  }

  onProgress?.(`  🧹 Emptying all R2 objects: ${bucketName} (${objectKeys.length})...`);
  let completed = 0;
  let removed = 0;
  for (let offset = 0; offset < objectKeys.length; offset += R2_OBJECT_DELETE_CONCURRENCY) {
    await verifyOwnership?.();
    const batch = objectKeys.slice(offset, offset + R2_OBJECT_DELETE_CONCURRENCY);
    await Promise.all(
      batch.map(async (objectKey) => {
        await deleteR2ObjectViaApi(bucketName, objectKey, credentials);
        removed += 1;
        completed += 1;
        if (completed % 50 === 0 || completed === objectKeys.length) {
          onProgress?.(
            `  R2 full object cleanup progress for ${bucketName}: ${completed}/${objectKeys.length}`
          );
        }
      })
    );
  }
  onProgress?.(
    `  R2 full object cleanup removed for ${bucketName}: ${removed}/${objectKeys.length}`
  );
  return null;
}

async function assertLiveR2DeletionIdentity(
  identity: ExactDeletionR2Identity,
  options: { requireMarker: boolean }
): Promise<'present' | 'absent'> {
  const live = (await listR2BucketIdentitiesStrict()).find(
    (bucket) => bucket.name === identity.name
  );
  if (!live) return 'absent';
  if (live.creationDate !== identity.creationDate) {
    throw new Error(
      `R2 bucket ${identity.name} provider creation_date changed; same-name replacement preserved`
    );
  }
  if (options.requireMarker) {
    await assertR2OwnershipMarker({
      bucketName: identity.name,
      markerKey: identity.ownershipMarkerKey,
      ownershipId: identity.ownershipId,
      environment: identity.environment,
      binding: identity.binding,
    });
  }
  return 'present';
}

function requireCompleteR2DeletionIdentity(
  name: string,
  identity: DeletionR2Identity | undefined
): ExactDeletionR2Identity {
  if (
    !identity ||
    identity.name !== name ||
    !identity.creationDate ||
    !identity.ownershipMarkerKey ||
    !identity.ownershipId
  ) {
    throw new Error(
      `R2 bucket ${name} has no exact creation_date and ownership marker; automatic deletion is blocked`
    );
  }
  return identity as ExactDeletionR2Identity;
}

/** Verify an owned R2 binding before a non-destructive update; legacy name-only bindings skip it. */
export async function assertR2BucketOwnershipIdentity(identity: DeletionR2Identity): Promise<void> {
  if (!identity.creationDate && !identity.ownershipMarkerKey && !identity.ownershipId) return;
  const exact = requireCompleteR2DeletionIdentity(identity.name, identity);
  if ((await assertLiveR2DeletionIdentity(exact, { requireMarker: true })) === 'absent') {
    throw new Error(`R2 bucket ${identity.name} recorded in lock.json is missing`);
  }
}

/**
 * Require exact Setup ownership before reading executable artifacts from, or writing objects to,
 * an R2 bucket. Unlike binding-only verification, legacy name-only locks are intentionally denied:
 * a same-name replacement could otherwise supply untrusted migration SQL or receive plugin code.
 */
export async function assertR2BucketOwnershipForUse(identity: DeletionR2Identity): Promise<void> {
  const exact = requireCompleteR2DeletionIdentity(identity.name, identity);
  if ((await assertLiveR2DeletionIdentity(exact, { requireMarker: true })) === 'absent') {
    throw new Error(`R2 bucket ${identity.name} recorded in lock.json is missing`);
  }
  const afterMarker = (await listR2BucketIdentitiesStrict()).find(
    (bucket) => bucket.name === exact.name
  );
  if (!afterMarker || afterMarker.creationDate !== exact.creationDate) {
    throw new Error(`R2 bucket ${identity.name} changed while Setup verified its ownership marker`);
  }
}

/**
 * Explicitly claim an existing deterministic-name bucket for a locked Authrim environment.
 * `onPrepared` is called before the marker PUT so a crash/response loss retains the exact random
 * marker identity and provider creation_date needed to resume without generating another claim.
 */
export async function adoptR2BucketOwnership(input: {
  environment: string;
  binding: string;
  name: string;
  prepared?: DeletionR2Identity;
  onPrepared: (identity: ExactDeletionR2Identity) => Promise<void>;
}): Promise<ExactDeletionR2Identity> {
  const initial = (await listR2BucketIdentitiesStrict()).find(
    (bucket) => bucket.name === input.name
  );
  if (!initial?.creationDate) {
    throw new Error(`R2 bucket ${input.name} is missing or has no provider creation_date`);
  }

  const preparedHasAnyEvidence = Boolean(
    input.prepared?.creationDate ||
    input.prepared?.ownershipMarkerKey ||
    input.prepared?.ownershipId
  );
  const ownershipId = preparedHasAnyEvidence
    ? requireCompleteR2DeletionIdentity(input.name, input.prepared).ownershipId
    : randomUUID().toLowerCase();
  const markerKey = preparedHasAnyEvidence
    ? requireCompleteR2DeletionIdentity(input.name, input.prepared).ownershipMarkerKey
    : buildR2OwnershipMarkerKey(ownershipId);
  const creationDate = preparedHasAnyEvidence
    ? requireCompleteR2DeletionIdentity(input.name, input.prepared).creationDate
    : initial.creationDate;
  if (creationDate !== initial.creationDate) {
    throw new Error(`R2 bucket ${input.name} changed after its ownership adoption was prepared`);
  }

  const prepared: ExactDeletionR2Identity = {
    name: input.name,
    creationDate,
    ownershipMarkerKey: markerKey,
    ownershipId,
    environment: input.environment,
    binding: input.binding,
  };
  await input.onPrepared(prepared);
  await writeAndVerifyR2OwnershipMarker({
    environment: input.environment,
    binding: input.binding,
    bucketName: input.name,
    markerKey,
    ownershipId,
  });
  const postMarker = (await listR2BucketIdentitiesStrict()).find(
    (bucket) => bucket.name === input.name
  );
  if (!postMarker || postMarker.creationDate !== creationDate) {
    throw new Error(`R2 bucket ${input.name} changed while Setup adopted its ownership`);
  }
  await assertR2BucketOwnershipForUse(prepared);
  return prepared;
}

/**
 * Delete an R2 bucket
 */
export async function deleteR2Bucket(
  name: string,
  options: {
    objectKeys?: string[];
    onProgress?: (message: string) => void;
    /** Omitted source is treated conservatively as an explicit, non-refreshable credential. */
    apiCredentials?: {
      accountId: string;
      token: string;
      source?: CloudflareApiToken['source'];
    } | null;
    ownership?: DeletionR2Identity;
  } = {}
): Promise<R2BucketDeleteResult> {
  try {
    const ownership = requireCompleteR2DeletionIdentity(name, options.ownership);
    if ((await assertLiveR2DeletionIdentity(ownership, { requireMarker: true })) === 'absent') {
      return { status: 'deleted' };
    }
    const credentials =
      options.apiCredentials === undefined ? await getR2ApiCredentials() : options.apiCredentials;
    if (credentials) {
      const manualCleanupTarget = await removeAllR2ObjectsViaApi(
        name,
        credentials,
        ownership.ownershipMarkerKey,
        options.onProgress,
        async () => {
          if (
            (await assertLiveR2DeletionIdentity(ownership, { requireMarker: true })) === 'absent'
          ) {
            throw new Error(`R2 bucket ${name} disappeared during guarded object cleanup`);
          }
        }
      );
      if (manualCleanupTarget) {
        return { status: 'manual_cleanup_required', target: manualCleanupTarget };
      }
      if ((await assertLiveR2DeletionIdentity(ownership, { requireMarker: true })) === 'absent') {
        return { status: 'deleted' };
      }
      await deleteR2ObjectViaApi(name, ownership.ownershipMarkerKey, credentials);
      // The provider exposes only a name-addressed DELETE, with no generation precondition. Keep
      // the marker until the final stage, then minimize (but cannot eliminate) the last GET/DELETE
      // TOCTOU window by re-reading creation_date immediately before the one-shot bucket DELETE.
      if ((await assertLiveR2DeletionIdentity(ownership, { requireMarker: false })) === 'absent') {
        return { status: 'deleted' };
      }
      try {
        await deleteR2BucketViaApi(name, credentials);
      } catch (error) {
        const state = await assertLiveR2DeletionIdentity(ownership, { requireMarker: false });
        if (state === 'absent') return { status: 'deleted' };
        await restoreR2OwnershipMarkerAfterAmbiguousDelete(ownership);
        throw error;
      }
    } else {
      await removeKnownR2Objects(
        name,
        (options.objectKeys ?? []).filter((key) => key !== ownership.ownershipMarkerKey),
        options.onProgress,
        async () => {
          if (
            (await assertLiveR2DeletionIdentity(ownership, { requireMarker: true })) === 'absent'
          ) {
            throw new Error(`R2 bucket ${name} disappeared during guarded object cleanup`);
          }
        }
      );
      if ((await assertLiveR2DeletionIdentity(ownership, { requireMarker: true })) === 'absent') {
        return { status: 'deleted' };
      }
      await wrangler([
        'r2',
        'object',
        'delete',
        `${name}/${ownership.ownershipMarkerKey}`,
        '--remote',
      ]);
      if ((await assertLiveR2DeletionIdentity(ownership, { requireMarker: false })) === 'absent') {
        return { status: 'deleted' };
      }
      try {
        await wrangler(['r2', 'bucket', 'delete', name]);
      } catch (error) {
        const state = await assertLiveR2DeletionIdentity(ownership, { requireMarker: false });
        if (state === 'absent') return { status: 'deleted' };
        await restoreR2OwnershipMarkerAfterAmbiguousDelete(ownership);
        throw error;
      }
    }
    return { status: 'deleted' };
  } catch (error) {
    const detail = sanitizeError(error);
    options.onProgress?.(`  ⚠️ R2 bucket delete failed for ${name}: ${detail}`);
    return { status: 'failed', error: detail };
  }
}

/**
 * Delete an environment and its resources
 */
export async function deleteEnvironment(options: DeleteOptions): Promise<{
  success: boolean;
  completion: 'complete' | 'manual_action_required' | 'failed';
  /** True only when the verified inventory contains no Authrim resources after this operation. */
  environmentEmpty: boolean;
  /** True when retrying the same deletion is the safe recovery action. */
  retryable: boolean;
  postDeleteVerification: PostDeleteVerificationStatus;
  deleted: {
    workers: string[];
    d1: string[];
    kv: string[];
    queues: string[];
    r2: string[];
    pages: string[];
    dns: string[];
  };
  manualR2: R2ManualCleanupTarget[];
  manualDns: ManagedDnsCleanupIssue[];
  errors: string[];
}> {
  const {
    env,
    environmentKnownLocally = false,
    finalizeEnvironment = false,
    deleteWorkers = true,
    deleteD1 = true,
    deleteKV = true,
    deleteQueues = true,
    deleteR2 = true,
    deletePages = true,
    knownWorkerNames = [],
    knownWorkerResources = [],
    knownD1Names = [],
    knownQueueNames = [],
    knownD1Resources = [],
    knownKVResources = [],
    knownQueueResources = [],
    knownR2Resources = [],
    knownPagesResources = [],
    onWorkerIdentityBackfill,
    knownDnsOwnership,
    dnsCleanupRequired = false,
    requiredDnsRoles = [],
    queueConsumerDetachPropagationDelayMs = QUEUE_CONSUMER_DETACH_PROPAGATION_DELAY_MS,
    workerDeletePropagationDelayMs = WORKER_DELETE_PROPAGATION_DELAY_MS,
    postDeleteVerificationAttempts = ENVIRONMENT_DELETE_VERIFY_MAX_ATTEMPTS,
    postDeleteVerificationDelayMs = ENVIRONMENT_DELETE_VERIFY_RETRY_DELAY_MS,
    beforeD1Deletion,
    onProgress = console.log,
    onDetail,
    onResourceProgress,
  } = options;
  validateEnvName(env);
  if (finalizeEnvironment && !deletePages && knownPagesResources.length > 0) {
    throw new Error(
      'Lock-recorded Pages projects must remain selected during final environment deletion'
    );
  }

  const deleted = {
    workers: [] as string[],
    d1: [] as string[],
    kv: [] as string[],
    queues: [] as string[],
    r2: [] as string[],
    pages: [] as string[],
    dns: [] as string[],
  };
  const manualR2: R2ManualCleanupTarget[] = [];
  const manualDns: ManagedDnsCleanupIssue[] = [];
  const errors: string[] = [];
  let dependentDeletionBlocked = false;
  let dependentDeletionReason:
    | 'resource_identity'
    | 'queue_consumer_detach'
    | 'worker_delete'
    | 'dns_cleanup'
    | 'r2_delete'
    | 'control_token_cleanup'
    | null = null;
  let detachedQueueConsumers: ExactQueueWorkerConsumerSnapshot[] = [];
  let queueConsumerSnapshots: ExactQueueWorkerConsumerSnapshot[] = [];

  // Inventory verification is a safety boundary. Every selected resource type must be confirmed
  // before the first destructive request so a transient list failure cannot be mistaken for an
  // empty account and cause resources to be deleted out of dependency order.
  const requiredResources = getRequiredDeletionInventoryResources({
    deleteWorkers,
    deleteD1,
    deleteKV,
    deleteQueues,
    deleteR2,
    deletePages,
  });
  const envs = await detectEnvironments(onProgress, { requiredResources });
  let envInfo = envs.find((e) => e.env === env);
  const safeKnownWorkerNames = filterKnownWorkerNamesForEnvironment(env, knownWorkerNames);
  const safeKnownD1Names = filterKnownD1NamesForEnvironment(env, knownD1Names);
  const safeKnownQueueNames = filterKnownQueueNamesForEnvironment(env, knownQueueNames);
  const pinnedD1 = normalizeKnownDeletionResourceIdentities({
    env,
    kind: 'D1 database',
    resources: knownD1Resources,
    acceptsName: (name) =>
      isFixedD1NameForEnvironment(env, name) || isControlManagedD1NameForEnvironment(env, name),
  });
  const pinnedKV = normalizeKnownDeletionResourceIdentities({
    env,
    kind: 'KV namespace',
    resources: knownKVResources,
    acceptsName: (name) =>
      isKVNameForEnvironment(env, name) || isControlManagedKVNameForEnvironment(env, name),
  });
  const pinnedQueues = normalizeKnownDeletionResourceIdentities({
    env,
    kind: 'Queue',
    resources: knownQueueResources,
    acceptsName: (name) => isQueueNameForEnvironment(env, name),
  });
  const pinnedR2 = normalizeKnownR2DeletionIdentities(env, knownR2Resources);
  const pinnedPages = normalizeKnownPagesDeletionIdentities(env, knownPagesResources);
  const pinnedWorkers = normalizeKnownWorkerDeletionIdentities(env, knownWorkerResources);
  const requireInventory = async <T>(
    resourceType: EnvironmentInventoryResource,
    operation: () => Promise<T>
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      throw new EnvironmentInventoryUnavailableError(resourceType, error);
    }
  };
  const [workerInventory, d1Inventory, kvInventory, queueInventory, r2Inventory] =
    await Promise.all([
      deleteWorkers ? requireInventory('Workers', () => listWorkers({ onRetry: onProgress })) : [],
      deleteD1 ? requireInventory('D1 databases', () => listD1Databases()) : [],
      deleteKV ? requireInventory('KV namespaces', () => listKVNamespaces()) : [],
      deleteQueues || deleteWorkers
        ? requireInventory('Queues', () => listQueues({ strictOutput: true, requireIds: true }))
        : [],
      deleteR2
        ? requireInventory('R2 buckets', () =>
            listR2Buckets({ throwOnError: true, requireIdentity: true }).then((buckets) =>
              buckets.filter((bucket) => isR2NameForEnvironment(env, bucket.name))
            )
          )
        : [],
    ]);
  r2Inventory.forEach(assertR2BucketIdentityComplete);
  const remoteR2 = r2Inventory.map((bucket) => ({
    name: bucket.name,
    creationDate: bucket.creationDate!,
  }));
  const remoteD1 = d1Inventory
    .filter(
      (database) =>
        isFixedD1NameForEnvironment(env, database.name) ||
        isControlManagedD1NameForEnvironment(env, database.name)
    )
    .map((database) => ({ name: database.name, id: database.uuid }));
  const remoteKV = kvInventory
    .filter(
      (namespace) =>
        isKVNameForEnvironment(env, namespace.title) ||
        isControlManagedKVNameForEnvironment(env, namespace.title)
    )
    .map((namespace) => ({ name: namespace.title, id: namespace.id }));
  const remoteQueues = queueInventory
    .filter((queue) => isQueueNameForEnvironment(env, queue.name))
    .map((queue) => ({ name: queue.name, id: queue.id! }));
  const workerPreflight = await reconcileWorkerDeletionIdentities({
    env,
    pinned: pinnedWorkers,
    remoteInventory: workerInventory,
  });
  const d1Preflight = reconcilePinnedDeletionIdentities({
    label: 'D1 database',
    pinned: pinnedD1,
    remote: remoteD1,
  });
  const kvPreflight = reconcilePinnedDeletionIdentities({
    label: 'KV namespace',
    pinned: pinnedKV,
    remote: remoteKV,
  });
  const queuePreflight = reconcilePinnedDeletionIdentities({
    label: 'Queue',
    pinned: pinnedQueues,
    remote: remoteQueues,
  });
  const r2Preflight = deleteR2
    ? await reconcileR2DeletionIdentities({ pinned: pinnedR2, remote: remoteR2 })
    : {
        targets: [] as DeletionR2Identity[],
        mismatches: [] as string[],
        liveNames: new Set<string>(),
      };
  const remotePages = (deletePages ? (envInfo?.pages ?? []) : []).map((project) => {
    if (!project.id || !project.createdOn) {
      throw new EnvironmentInventoryUnavailableError(
        'Pages projects',
        new Error(`Pages project ${project.name} omitted provider ID/created_on`)
      );
    }
    return { name: project.name, id: project.id, createdOn: project.createdOn };
  });
  const pagesPreflight = deletePages
    ? reconcilePagesDeletionIdentities({ pinned: pinnedPages, remote: remotePages })
    : {
        targets: [] as DeletionPagesIdentity[],
        mismatches: [] as string[],
        liveIds: new Set<string>(),
      };
  const resourceIdentityMismatches = [
    ...workerPreflight.mismatches,
    ...d1Preflight.mismatches,
    ...kvPreflight.mismatches,
    ...queuePreflight.mismatches,
    ...r2Preflight.mismatches,
    ...pagesPreflight.mismatches,
  ];
  const pinnedD1Names = new Set(pinnedD1.map((resource) => resource.name));
  const pinnedQueueNames = new Set(pinnedQueues.map((resource) => resource.name));
  const pinnedWorkerNames = new Set(pinnedWorkers.map((resource) => resource.name));
  for (const name of safeKnownWorkerNames) {
    if (!pinnedWorkerNames.has(name)) {
      resourceIdentityMismatches.push(
        `Worker ownership for ${name} has no immutable identity; name-only deletion is not allowed`
      );
    }
  }
  for (const name of safeKnownD1Names) {
    if (!pinnedD1Names.has(name)) {
      resourceIdentityMismatches.push(
        `D1 database ownership for ${name} has no immutable ID; name-only deletion is not allowed`
      );
    }
  }
  for (const name of safeKnownQueueNames) {
    if (!pinnedQueueNames.has(name)) {
      resourceIdentityMismatches.push(
        `Queue ownership for ${name} has no immutable ID; name-only deletion is not allowed`
      );
    }
  }
  // Preserve strict remote inventory separately from lock-recorded recovery names. The token
  // cleanup gate uses this evidence to distinguish a still-queryable Control D1 from one that was
  // already removed during a previously interrupted deletion.
  const observedD1Resources = [...remoteD1].sort((left, right) => left.id.localeCompare(right.id));

  if (
    !envInfo &&
    !environmentKnownLocally &&
    safeKnownWorkerNames.length === 0 &&
    safeKnownD1Names.length === 0 &&
    safeKnownQueueNames.length === 0 &&
    pinnedD1.length === 0 &&
    pinnedKV.length === 0 &&
    pinnedQueues.length === 0 &&
    pinnedR2.length === 0 &&
    pinnedPages.length === 0 &&
    pinnedWorkers.length === 0 &&
    remoteD1.length === 0 &&
    remoteKV.length === 0 &&
    remoteQueues.length === 0 &&
    r2Inventory.length === 0 &&
    remotePages.length === 0
  ) {
    return {
      success: false,
      completion: 'failed',
      environmentEmpty: false,
      retryable: false,
      postDeleteVerification: 'not_required',
      deleted,
      manualR2,
      manualDns,
      errors: [`Environment '${env}' not found`],
    };
  }
  if (!envInfo) {
    envInfo = {
      env,
      workers: [],
      d1: [],
      kv: [],
      queues: [],
      r2: [],
      pages: [],
    };
  }

  if (deleteWorkers) {
    envInfo.workers = workerPreflight.targets.map((worker) => ({ name: worker.name }));
  }
  const workerDeletionTargetsByName = new Map(
    workerPreflight.targets.map((worker) => [worker.name, worker])
  );

  // Replace the storage rows from the broad environment scan with the final strict ownership
  // snapshot. Pinned-but-absent rows remain so the local lock can be reconciled without issuing a
  // provider mutation by deterministic name.
  if (deleteD1) envInfo.d1 = d1Preflight.targets;
  if (deleteKV) envInfo.kv = kvPreflight.targets;
  if (deleteQueues || deleteWorkers) envInfo.queues = queuePreflight.targets;
  if (deleteR2) envInfo.r2 = r2Preflight.targets;
  if (deletePages) envInfo.pages = pagesPreflight.targets;
  const queuesForConsumerDetach =
    deleteWorkers && envInfo.workers.length > 0
      ? Array.from(
          new Map(
            envInfo.queues
              .filter((queue): queue is { name: string; id: string } =>
                Boolean(queue.id && queuePreflight.liveIds.has(queue.id))
              )
              .map((queue) => [queue.name, queue])
          ).values()
        )
      : envInfo.queues.filter((queue): queue is { name: string; id: string } =>
          Boolean(queue.id && queuePreflight.liveIds.has(queue.id))
        );
  const queueConsumerWorkerNamesForDeletion = deleteWorkers
    ? getQueueConsumerWorkerNamesForDeletion(env, envInfo.workers)
    : [];
  const allCurrentResourceTypesSelected =
    deleteWorkers && deleteD1 && deleteKV && deleteQueues && deleteR2;
  const fullDeletionRequested =
    allCurrentResourceTypesSelected && (deletePages || finalizeEnvironment);

  const totalResources =
    (deleteWorkers ? envInfo.workers.length : 0) +
    (deleteD1 ? envInfo.d1.length : 0) +
    (deleteKV ? envInfo.kv.length : 0) +
    (deleteQueues ? envInfo.queues.length : 0) +
    (deleteR2 ? envInfo.r2.length : 0) +
    (deletePages ? envInfo.pages.length : 0) +
    (fullDeletionRequested ? Object.keys(knownDnsOwnership ?? {}).length : 0);
  let processedResources = 0;
  const reportResourceProcessed = () => {
    processedResources += 1;
    onResourceProgress?.({ current: processedResources, total: totalResources });
  };
  onResourceProgress?.({ current: 0, total: totalResources });

  onProgress(`🗑️ Deleting environment: ${env}`);
  onProgress('');

  let d1DeletionCredentials: CloudflareDeletionCredentials | undefined;
  let generalDeletionCredentials: CloudflareDeletionCredentials | undefined;
  if (resourceIdentityMismatches.length > 0) {
    errors.push(...resourceIdentityMismatches);
    dependentDeletionBlocked = true;
    dependentDeletionReason = 'resource_identity';
    onProgress(
      '⚠️ Immutable resource ownership preflight failed. No Cloudflare resource was modified.'
    );
    for (const mismatch of resourceIdentityMismatches) onProgress(`  ❌ ${mismatch}`);
    onProgress('');
  } else {
    if (workerPreflight.backfills.length > 0) {
      if (!onWorkerIdentityBackfill) {
        errors.push(
          'Verified legacy Worker identities could not be durably backfilled before deletion'
        );
      } else {
        try {
          await onWorkerIdentityBackfill(workerPreflight.backfills);
        } catch (error) {
          errors.push(`Worker identity backfill failed: ${sanitizeError(error)}`);
        }
      }
    }
    // Resolve every credential required by the selected live storage snapshot before Queue
    // consumers or any other resource is modified. A missing REST credential cannot therefore
    // strand the environment halfway through deletion.
    const needsD1Credentials = deleteD1 && d1Preflight.liveIds.size > 0;
    const needsGeneralCredentials =
      (deleteKV && kvPreflight.liveIds.size > 0) ||
      (deleteQueues && queuePreflight.liveIds.size > 0) ||
      (deleteWorkers &&
        queuesForConsumerDetach.length > 0 &&
        queueConsumerWorkerNamesForDeletion.length > 0);
    let resolvedD1: Awaited<ReturnType<typeof resolveCloudflareD1Credentials>> | undefined;
    let resolvedGeneral:
      | Awaited<ReturnType<typeof resolveCloudflareInventoryCredentials>>
      | undefined;
    let credentialResolutionFailed = false;
    try {
      [resolvedD1, resolvedGeneral] = await Promise.all([
        needsD1Credentials ? resolveCloudflareD1Credentials() : undefined,
        needsGeneralCredentials ? resolveCloudflareInventoryCredentials() : undefined,
      ]);
    } catch (error) {
      credentialResolutionFailed = true;
      errors.push(
        `Cloudflare exact-ID deletion credential preflight failed: ${sanitizeError(error)}`
      );
    }
    if (resolvedD1) {
      d1DeletionCredentials = resolvedD1;
    } else if (needsD1Credentials && !credentialResolutionFailed) {
      errors.push('Cloudflare D1 API credentials are unavailable for exact-ID deletion');
    }
    if (resolvedGeneral) {
      generalDeletionCredentials = resolvedGeneral;
    } else if (needsGeneralCredentials && !credentialResolutionFailed) {
      errors.push('Cloudflare API credentials are unavailable for exact-ID KV/Queue deletion');
    }
    if (
      errors.length === 0 &&
      deleteWorkers &&
      queuesForConsumerDetach.length > 0 &&
      queueConsumerWorkerNamesForDeletion.length > 0
    ) {
      try {
        queueConsumerSnapshots = await listExactQueueWorkerConsumers({
          queues: queuesForConsumerDetach,
          workerNames: queueConsumerWorkerNamesForDeletion,
          credentials: generalDeletionCredentials!,
        });
      } catch (error) {
        errors.push(`Cloudflare exact Queue consumer preflight failed: ${sanitizeError(error)}`);
      }
    }
    if (errors.length > 0) {
      dependentDeletionBlocked = true;
      dependentDeletionReason = 'resource_identity';
      onProgress(
        '⚠️ Exact-ID deletion credentials could not be established. No Cloudflare resource was modified.'
      );
      for (const error of errors) onProgress(`  ❌ ${error}`);
      onProgress('');
    }
  }

  // Prove DNS ownership before the first destructive operation. A missing lock entry, changed
  // immutable ID, or changed value must not be discovered only after Workers have been removed.
  if (!dependentDeletionBlocked && fullDeletionRequested) {
    const dnsPreflight = await cleanupManagedDnsRecords({
      entries: knownDnsOwnership,
      required: dnsCleanupRequired,
      requiredRoles: requiredDnsRoles,
      preflightOnly: true,
    });
    if (dnsPreflight.issues.length > 0) {
      manualDns.push(...dnsPreflight.issues);
      dependentDeletionBlocked = true;
      dependentDeletionReason = 'dns_cleanup';
      onProgress(
        '⚠️ DNS ownership preflight failed. No Cloudflare environment resource was deleted.'
      );
      for (const issue of dnsPreflight.issues) {
        onProgress(`  ❌ ${issue.name} - ${issue.reason}`);
      }
      onProgress('');
    }
  }

  // Queue consumers must be detached before Cloudflare allows the Worker script to be deleted.
  if (
    !dependentDeletionBlocked &&
    deleteWorkers &&
    envInfo.workers.length > 0 &&
    queuesForConsumerDetach.length > 0
  ) {
    if (queueConsumerWorkerNamesForDeletion.length > 0) {
      onProgress(`📨 Detaching Queue Consumers (${queuesForConsumerDetach.length})...`);
      const detachSummary = await deleteExactQueueConsumers(
        queueConsumerSnapshots,
        generalDeletionCredentials!,
        (message) => {
          if (message.includes('(not attached or already removed)')) {
            onDetail?.(message);
            return;
          }
          onProgress(message);
        }
      );
      detachedQueueConsumers = detachSummary.removed;
      if (detachSummary.errors.length > 0) {
        errors.push(...detachSummary.errors);
        const restoreErrors = await restoreExactQueueConsumers(
          detachedQueueConsumers,
          generalDeletionCredentials!,
          onProgress
        );
        errors.push(...restoreErrors);
        detachedQueueConsumers = [];
        dependentDeletionBlocked = true;
        dependentDeletionReason = 'queue_consumer_detach';
      } else if (queueConsumerDetachPropagationDelayMs > 0) {
        onProgress(
          `  ⏳ Waiting ${Math.ceil(
            queueConsumerDetachPropagationDelayMs / 1000
          )}s for Queue detachments to propagate...`
        );
        await sleep(queueConsumerDetachPropagationDelayMs);
      }
      onProgress('');
    }
  }

  // Delete Workers before D1/KV because they reference runtime bindings.
  if (!dependentDeletionBlocked && deleteWorkers && envInfo.workers.length > 0) {
    const queueConsumerWorkerNameSet = new Set(queueConsumerWorkerNamesForDeletion);
    const workersForDeletion = [...envInfo.workers].sort((left, right) => {
      const leftIsConsumer = queueConsumerWorkerNameSet.has(left.name);
      const rightIsConsumer = queueConsumerWorkerNameSet.has(right.name);
      return Number(leftIsConsumer) - Number(rightIsConsumer);
    });
    const deletedWorkerNames = new Set<string>();
    onProgress(`🔧 Deleting Workers (${envInfo.workers.length})...`);
    for (const worker of workersForDeletion) {
      onProgress(`  ⏳ Deleting: ${worker.name}...`);
      const target = workerDeletionTargetsByName.get(worker.name);
      let workerResult: WorkerDeleteResult;
      try {
        if (!target) {
          throw new Error(`Worker ownership evidence is missing for ${worker.name}`);
        }
        workerResult = await deleteWorkerWithResult(worker.name, onProgress, () =>
          assertWorkerDeletionIdentity(target, onProgress)
        );
      } catch (error) {
        workerResult = { status: 'failed', error: sanitizeError(error) };
      }
      if (workerResult.status === 'deleted') {
        deleted.workers.push(worker.name);
        deletedWorkerNames.add(worker.name);
        onProgress(`  ✅ ${worker.name}`);
      } else if (workerResult.status === 'already_absent') {
        deleted.workers.push(worker.name);
        deletedWorkerNames.add(worker.name);
        onProgress(`  ⚠️ ${worker.name} (already absent)`);
      } else {
        errors.push(`Failed to delete Worker: ${worker.name} (${workerResult.error})`);
        dependentDeletionBlocked = true;
        dependentDeletionReason = 'worker_delete';
        onProgress(`  ❌ ${worker.name} - ${workerResult.error}`);
      }
      reportResourceProcessed();
      if (dependentDeletionBlocked) break;
    }
    if (
      !dependentDeletionBlocked &&
      queuesForConsumerDetach.length > 0 &&
      workerDeletePropagationDelayMs > 0
    ) {
      onProgress(
        `  ⏳ Waiting ${Math.ceil(
          workerDeletePropagationDelayMs / 1000
        )}s for Worker deletions to propagate before deleting Queues...`
      );
      await sleep(workerDeletePropagationDelayMs);
    }
    const consumersToRestore = detachedQueueConsumers.filter(
      (consumer) => !deletedWorkerNames.has(consumer.workerName)
    );
    if (consumersToRestore.length > 0) {
      onProgress('  ⚠️ Restoring Queue consumers for Workers that could not be deleted...');
      errors.push(
        ...(await restoreExactQueueConsumers(
          consumersToRestore,
          generalDeletionCredentials!,
          onProgress
        ))
      );
    }
    onProgress('');
  }

  if (dependentDeletionReason === 'queue_consumer_detach') {
    onProgress(
      '  ⚠️ Stopping before deleting Workers because Queue consumers could not be detached safely.'
    );
    onProgress('  ⚠️ Successfully detached consumers were restored; retry the deletion.');
    onProgress('');
  } else if (dependentDeletionReason === 'worker_delete') {
    onProgress(
      '  ⚠️ Stopping before deleting bound storage and Queues because Worker deletion is incomplete.'
    );
    onProgress('  ⚠️ Resolve the Worker error, then retry the environment deletion.');
    onProgress('');
  }

  if (!dependentDeletionBlocked && fullDeletionRequested) {
    onProgress('🌐 Reconciling Setup-managed DNS records...');
    const dnsCleanup = await cleanupManagedDnsRecords({
      entries: knownDnsOwnership,
      required: dnsCleanupRequired,
      requiredRoles: requiredDnsRoles,
      onProgress,
    });
    deleted.dns.push(...dnsCleanup.completedNames);
    manualDns.push(...dnsCleanup.issues);
    for (let index = 0; index < Object.keys(knownDnsOwnership ?? {}).length; index++) {
      reportResourceProcessed();
    }
    if (dnsCleanup.issues.length > 0) {
      dependentDeletionBlocked = true;
      dependentDeletionReason = 'dns_cleanup';
      onProgress(
        '  ⚠️ Setup cannot safely delete or restore DNS without exact ownership evidence. No bound storage was deleted.'
      );
    }
    onProgress('');
  }

  // Delete R2 buckets before D1 so object_catalog_objects can still identify stored objects.
  if (!dependentDeletionBlocked && deleteR2 && envInfo.r2.length > 0) {
    const r2ApiCredentials = await getR2ApiCredentials();
    const knownR2ObjectsByBucket = r2ApiCredentials
      ? new Map<string, string[]>()
      : await collectKnownR2ObjectsByBucket(env, envInfo.r2, onProgress);
    onProgress(`📁 Deleting R2 Buckets (${envInfo.r2.length})...`);
    for (const bucket of envInfo.r2) {
      onProgress(`  ⏳ Deleting: ${bucket.name}...`);
      const r2Result = await deleteR2Bucket(bucket.name, {
        objectKeys: knownR2ObjectsByBucket.get(bucket.name) ?? [],
        onProgress,
        apiCredentials: r2ApiCredentials,
        ownership: bucket,
      });
      if (r2Result.status === 'deleted') {
        deleted.r2.push(bucket.name);
        onProgress(`  ✅ ${bucket.name}`);
      } else if (r2Result.status === 'manual_cleanup_required') {
        manualR2.push(r2Result.target);
        onProgress(`  ⚠️ ${bucket.name} requires manual Dashboard cleanup`);
      } else {
        errors.push(`Failed to delete R2: ${bucket.name} (${r2Result.error})`);
        dependentDeletionBlocked = true;
        dependentDeletionReason = 'r2_delete';
        onProgress(`  ❌ ${bucket.name} - ${r2Result.error}`);
      }
      reportResourceProcessed();
    }
    onProgress('');
    if (dependentDeletionReason === 'r2_delete') {
      onProgress(
        '  ⚠️ Stopping before deleting D1 and other resources because R2 deletion is incomplete.'
      );
      onProgress('  ⚠️ The R2 object catalog was preserved so the deletion can be retried safely.');
      onProgress('');
    }
  }

  if (!dependentDeletionBlocked && deleteD1 && beforeD1Deletion) {
    onProgress('🔐 Revoking setup-managed Control API tokens...');
    try {
      await beforeD1Deletion({ observedD1Resources });
      onProgress('  ✅ Control API token cleanup evidence verified');
    } catch (error) {
      const detail = sanitizeError(error);
      errors.push(`Failed to revoke setup-managed Control API tokens: ${detail}`);
      dependentDeletionBlocked = true;
      dependentDeletionReason = 'control_token_cleanup';
      onProgress(`  ❌ Control API token cleanup blocked D1 deletion: ${detail}`);
    }
    onProgress('');
  }

  // Delete D1 databases
  if (!dependentDeletionBlocked && deleteD1 && envInfo.d1.length > 0) {
    onProgress(`📊 Deleting D1 Databases (${envInfo.d1.length})...`);
    for (const db of envInfo.d1) {
      onProgress(`  ⏳ Deleting: ${db.name}...`);
      const result = d1Preflight.liveIds.has(db.id)
        ? await deleteD1DatabaseWithResult(db.id, d1DeletionCredentials)
        : ({ status: 'already_absent' } as const);
      if (result.status === 'deleted') {
        deleted.d1.push(db.name);
        onProgress(`  ✅ ${db.name}`);
      } else if (result.status === 'already_absent') {
        deleted.d1.push(db.name);
        onProgress(`  ⚠️ ${db.name} (already absent)`);
      } else {
        errors.push(`Failed to delete D1: ${db.name} (${result.error})`);
        onProgress(`  ❌ ${db.name} - ${result.error}`);
      }
      reportResourceProcessed();
    }
    onProgress('');
  }

  // Delete KV namespaces
  if (!dependentDeletionBlocked && deleteKV && envInfo.kv.length > 0) {
    onProgress(`🗄️ Deleting KV Namespaces (${envInfo.kv.length})...`);
    for (const kv of envInfo.kv) {
      onProgress(`  ⏳ Deleting: ${kv.name}...`);
      const result = kvPreflight.liveIds.has(kv.id)
        ? await deleteKVNamespaceWithResult(kv.id, generalDeletionCredentials)
        : ({ status: 'already_absent' } as const);
      if (result.status === 'deleted') {
        deleted.kv.push(kv.name);
        onProgress(`  ✅ ${kv.name}`);
      } else if (result.status === 'already_absent') {
        deleted.kv.push(kv.name);
        onProgress(`  ⚠️ ${kv.name} (already absent)`);
      } else {
        errors.push(`Failed to delete KV: ${kv.name} (${result.error})`);
        onProgress(`  ❌ ${kv.name} - ${result.error}`);
      }
      reportResourceProcessed();
    }
    onProgress('');
  }

  // Delete legacy Pages projects
  if (!dependentDeletionBlocked && deletePages && envInfo.pages.length > 0) {
    onProgress(`📄 Deleting legacy Pages Projects (${envInfo.pages.length})...`);
    for (const project of envInfo.pages) {
      onProgress(`  ⏳ Deleting: ${project.name}...`);
      const success = await deletePagesProject({
        name: project.name,
        id: project.id!,
        createdOn: project.createdOn!,
      });
      if (success) {
        deleted.pages.push(project.name);
        onProgress(`  ✅ ${project.name}`);
      } else {
        errors.push(`Failed to delete legacy Pages project: ${project.name}`);
        onProgress(`  ❌ ${project.name}`);
      }
      reportResourceProcessed();
    }
    onProgress('');
  }

  // Delete Queues last. Cloudflare can keep transient Worker/Queue references briefly after detach
  // and script deletion, so Queue removal is intentionally delayed until all Worker work is complete.
  if (!dependentDeletionBlocked && deleteQueues && envInfo.queues.length > 0) {
    onProgress(`📨 Deleting Queues (${envInfo.queues.length})...`);
    for (const queue of envInfo.queues) {
      onProgress(`  ⏳ Deleting: ${queue.name}...`);
      const queueResult =
        queue.id && queuePreflight.liveIds.has(queue.id)
          ? await deleteQueueWithResult(queue.id, generalDeletionCredentials)
          : ({ status: 'already_absent' } as const);
      if (queueResult.status === 'deleted') {
        deleted.queues.push(queue.name);
        onProgress(`  ✅ ${queue.name}`);
      } else if (queueResult.status === 'already_absent') {
        deleted.queues.push(queue.name);
        onProgress(`  ⚠️ ${queue.name} (already absent)`);
      } else {
        errors.push(`Failed to delete Queue: ${queue.name} (${queueResult.error})`);
        onProgress(`  ❌ ${queue.name} - ${queueResult.error}`);
      }
      reportResourceProcessed();
    }
    onProgress('');
  }

  // Summary
  const totalDeleted =
    deleted.workers.length +
    deleted.d1.length +
    deleted.kv.length +
    deleted.queues.length +
    deleted.r2.length +
    deleted.pages.length +
    deleted.dns.length;
  // A partial deletion deliberately preserves the environment even when the selected inventory
  // happens to be empty. Unselected inventory may be unavailable, so it cannot prove that the
  // remote environment is empty or justify deleting the local recovery state.
  let environmentEmpty = false;
  let retryable = false;
  let postDeleteVerification: PostDeleteVerificationStatus = 'not_required';
  if (
    fullDeletionRequested &&
    errors.length === 0 &&
    manualR2.length === 0 &&
    manualDns.length === 0
  ) {
    const verification = await verifyEnvironmentAbsentAfterDeletion({
      env,
      selection: {
        deleteWorkers,
        deleteD1,
        deleteKV,
        deleteQueues,
        deleteR2,
        deletePages,
      },
      attempts: postDeleteVerificationAttempts,
      retryDelayMs: postDeleteVerificationDelayMs,
      onProgress,
      onDetail,
    });
    postDeleteVerification = verification.status;
    if (verification.status === 'verified_empty') {
      environmentEmpty = true;
    } else {
      retryable = true;
      if (verification.status === 'resources_remaining') {
        errors.push(
          `Post-delete verification still found Cloudflare resources for environment '${env}' ` +
            `after ${verification.attempts} attempt(s). Local recovery state was preserved; retry deletion.`
        );
      } else {
        errors.push(
          `Post-delete Cloudflare inventory verification was unavailable after ` +
            `${verification.attempts} attempt(s). Local recovery state was preserved; retry deletion. ` +
            `Details: ${verification.error ?? 'unknown inventory error'}`
        );
      }
    }
  }

  onProgress('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (errors.length > 0) {
    onProgress(`❌ Environment '${env}' deletion encountered ${errors.length} error(s)`);
  } else if (manualR2.length > 0 || manualDns.length > 0) {
    onProgress(
      `⚠️ Environment '${env}' deletion requires ${manualR2.length + manualDns.length} manual action(s)`
    );
  } else if (environmentEmpty) {
    onProgress(`✅ Environment '${env}' deleted successfully!`);
  } else {
    onProgress(`✅ Selected resources for '${env}' deleted; remaining environment preserved`);
  }
  onProgress(`   Deleted: ${totalDeleted} resources`);
  if (manualR2.length > 0 || manualDns.length > 0) {
    onProgress(`   Manual actions: ${manualR2.length + manualDns.length}`);
  }
  if (errors.length > 0) {
    onProgress(`   Errors: ${errors.length}`);
  }

  return {
    success: errors.length === 0,
    completion:
      errors.length > 0
        ? 'failed'
        : manualR2.length > 0 || manualDns.length > 0
          ? 'manual_action_required'
          : 'complete',
    environmentEmpty,
    retryable,
    postDeleteVerification,
    deleted,
    manualR2,
    manualDns,
    errors,
  };
}
