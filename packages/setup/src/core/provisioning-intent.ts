import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, rm, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readPrivateFileSecurely, writePrivateFileAtomically } from './atomic-file.js';
import { getEnvironmentPaths } from './paths.js';

const MAX_PROVISIONING_INTENT_BYTES = 1024 * 1024;

type JsonPrimitive = string | number | boolean | null;
export type ProvisioningResourceSpec =
  | JsonPrimitive
  | readonly ProvisioningResourceSpec[]
  | { readonly [key: string]: ProvisioningResourceSpec | undefined };

export interface ProvisioningIntent {
  version: 1;
  id: string;
  environment: string;
  accountId: string;
  resourceSpec: ProvisioningResourceSpec;
  resourceSpecDigest: string;
  createdAt: string;
  updatedAt: string;
  keyId?: string;
  resources: Record<string, ProvisioningResourceCheckpoint>;
}

export type ProvisioningResourceKind = 'd1' | 'kv' | 'queue' | 'r2';

export type ProvisioningResourceState =
  | 'create_issued'
  | 'create_rejected'
  | 'identified'
  | 'created';

export interface ProvisioningResourceCheckpoint {
  kind: ProvisioningResourceKind;
  binding: string;
  name: string;
  state: ProvisioningResourceState;
  id?: string;
  /** Cloudflare's provider-assigned R2 bucket generation timestamp. */
  creationDate?: string;
  /** Unpredictable object key written by Setup before an R2 bucket is adopted. */
  ownershipMarkerKey?: string;
  /** Identifier encoded in the ownership marker payload and retained for exact readback. */
  ownershipId?: string;
}

/**
 * Prove that a provisioning checkpoint, the durable lock, and the current Cloudflare inventory
 * all describe the same resource. R2 buckets have no immutable identifier in the API response;
 * every other resource kind must retain the exact identifier across crash recovery.
 */
export function hasExactProvisioningResourceIdentity(input: {
  kind: ProvisioningResourceKind;
  binding: string;
  expectedName: string;
  lock?: {
    name: string;
    id?: string;
    creationDate?: string;
    ownershipMarkerKey?: string;
    ownershipId?: string;
  };
  checkpoint?: ProvisioningResourceCheckpoint;
  requireCheckpoint?: boolean;
  remote?: { name: string; id?: string; creationDate?: string };
}): boolean {
  if (!input.lock || input.lock.name !== input.expectedName) return false;
  if (input.requireCheckpoint) {
    if (
      !input.checkpoint ||
      input.checkpoint.kind !== input.kind ||
      input.checkpoint.binding !== input.binding ||
      input.checkpoint.name !== input.expectedName ||
      input.checkpoint.state !== 'created'
    ) {
      return false;
    }
  }
  if (input.remote?.name !== undefined && input.remote.name !== input.expectedName) return false;
  if (input.kind === 'r2') {
    const creationDate = input.lock.creationDate?.trim();
    const ownershipMarkerKey = input.lock.ownershipMarkerKey?.trim();
    const ownershipId = input.lock.ownershipId?.trim();
    if (!creationDate || !ownershipMarkerKey || !ownershipId) return false;
    if (
      input.requireCheckpoint &&
      (input.checkpoint?.creationDate !== creationDate ||
        input.checkpoint?.ownershipMarkerKey !== ownershipMarkerKey ||
        input.checkpoint?.ownershipId !== ownershipId)
    ) {
      return false;
    }
    if (input.remote && input.remote.creationDate?.trim() !== creationDate) return false;
    return true;
  }

  const lockedId = input.lock.id?.trim();
  if (!lockedId) return false;
  if (input.requireCheckpoint && input.checkpoint?.id !== lockedId) return false;
  if (input.remote && input.remote.id?.trim() !== lockedId) return false;
  return true;
}

export type ProvisioningResourceIdentity = Omit<ProvisioningResourceCheckpoint, 'state' | 'id'>;

export interface BeginProvisioningIntentInput {
  baseDir: string;
  environment: string;
  accountId: string;
  resourceSpec: ProvisioningResourceSpec;
}

function assertEnvironmentName(environment: string): void {
  if (!/^[a-z][a-z0-9-]*$/u.test(environment)) {
    throw new Error('invalid_provisioning_intent_environment');
  }
}

function canonicalize(value: ProvisioningResourceSpec | undefined): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(',')}}`;
}

export function calculateProvisioningResourceSpecDigest(
  resourceSpec: ProvisioningResourceSpec
): string {
  return createHash('sha256').update(canonicalize(resourceSpec)).digest('hex');
}

function parseProvisioningIntent(raw: unknown, expectedEnvironment: string): ProvisioningIntent {
  if (!raw || typeof raw !== 'object') throw new Error('invalid_provisioning_intent');
  const candidate = raw as Partial<ProvisioningIntent>;
  if (
    candidate.version !== 1 ||
    typeof candidate.id !== 'string' ||
    !/^[0-9a-f-]{36}$/iu.test(candidate.id) ||
    candidate.environment !== expectedEnvironment ||
    typeof candidate.accountId !== 'string' ||
    candidate.accountId.length === 0 ||
    candidate.resourceSpec === undefined ||
    typeof candidate.resourceSpecDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(candidate.resourceSpecDigest) ||
    typeof candidate.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    typeof candidate.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.updatedAt)) ||
    !candidate.resources ||
    typeof candidate.resources !== 'object' ||
    Array.isArray(candidate.resources)
  ) {
    throw new Error('invalid_provisioning_intent');
  }
  if (candidate.keyId !== undefined && (typeof candidate.keyId !== 'string' || !candidate.keyId)) {
    throw new Error('invalid_provisioning_intent');
  }
  for (const [checkpointKey, value] of Object.entries(candidate.resources)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid_provisioning_intent');
    }
    const checkpoint = value as Partial<ProvisioningResourceCheckpoint>;
    const hasR2OwnershipField =
      checkpoint.creationDate !== undefined ||
      checkpoint.ownershipMarkerKey !== undefined ||
      checkpoint.ownershipId !== undefined;
    if (
      !['d1', 'kv', 'queue', 'r2'].includes(checkpoint.kind ?? '') ||
      typeof checkpoint.binding !== 'string' ||
      !checkpoint.binding ||
      typeof checkpoint.name !== 'string' ||
      !checkpoint.name ||
      !['create_issued', 'create_rejected', 'identified', 'created'].includes(
        checkpoint.state ?? ''
      ) ||
      (checkpoint.id !== undefined && (typeof checkpoint.id !== 'string' || !checkpoint.id)) ||
      (checkpoint.creationDate !== undefined &&
        (typeof checkpoint.creationDate !== 'string' ||
          !Number.isFinite(Date.parse(checkpoint.creationDate)))) ||
      (checkpoint.ownershipMarkerKey !== undefined &&
        (typeof checkpoint.ownershipMarkerKey !== 'string' ||
          !/^__authrim_setup__\/ownership-v1-[a-f0-9-]{36}\.json$/u.test(
            checkpoint.ownershipMarkerKey
          ))) ||
      (checkpoint.ownershipId !== undefined &&
        (typeof checkpoint.ownershipId !== 'string' ||
          !/^[a-f0-9-]{36}$/u.test(checkpoint.ownershipId))) ||
      (checkpoint.kind !== 'r2' && hasR2OwnershipField) ||
      (checkpoint.kind === 'r2' &&
        ['identified', 'created'].includes(checkpoint.state ?? '') &&
        (!checkpoint.creationDate || !checkpoint.ownershipMarkerKey || !checkpoint.ownershipId)) ||
      (checkpoint.kind === 'r2' &&
        ['create_issued', 'create_rejected'].includes(checkpoint.state ?? '') &&
        checkpoint.creationDate !== undefined) ||
      (checkpoint.ownershipMarkerKey === undefined) !== (checkpoint.ownershipId === undefined) ||
      (!['identified', 'created'].includes(checkpoint.state ?? '') &&
        checkpoint.id !== undefined) ||
      (checkpoint.kind !== 'r2' &&
        ['identified', 'created'].includes(checkpoint.state ?? '') &&
        !checkpoint.id) ||
      (checkpoint.kind === 'r2' && checkpoint.id !== undefined) ||
      (checkpoint.kind === 'r2' &&
        checkpoint.state === 'identified' &&
        (!checkpoint.creationDate || !checkpoint.ownershipMarkerKey || !checkpoint.ownershipId)) ||
      checkpointKey !== `${checkpoint.kind}:${checkpoint.binding}`
    ) {
      throw new Error('invalid_provisioning_intent');
    }
  }
  if (
    calculateProvisioningResourceSpecDigest(candidate.resourceSpec) !== candidate.resourceSpecDigest
  ) {
    throw new Error('provisioning_intent_digest_mismatch');
  }
  return candidate as ProvisioningIntent;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function loadProvisioningIntent(input: {
  baseDir: string;
  environment: string;
}): Promise<ProvisioningIntent | null> {
  assertEnvironmentName(input.environment);
  const path = getEnvironmentPaths({
    baseDir: input.baseDir,
    env: input.environment,
  }).provisioningIntent;
  const content = await readPrivateFileSecurely(path, {
    maxBytes: MAX_PROVISIONING_INTENT_BYTES,
    invalidError: 'invalid_provisioning_intent',
    permissionsError: 'provisioning_intent_permissions_invalid',
  });
  if (content === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new Error('invalid_provisioning_intent', { cause: error });
  }
  return parseProvisioningIntent(raw, input.environment);
}

function assertMatchingIntent(
  intent: ProvisioningIntent,
  input: BeginProvisioningIntentInput
): void {
  const requestedDigest = calculateProvisioningResourceSpecDigest(input.resourceSpec);
  if (intent.accountId !== input.accountId) {
    throw new Error('provisioning_intent_account_mismatch');
  }
  if (intent.resourceSpecDigest !== requestedDigest) {
    throw new Error('provisioning_intent_resource_spec_mismatch');
  }
}

export async function beginOrResumeProvisioningIntent(
  input: BeginProvisioningIntentInput
): Promise<{ intent: ProvisioningIntent; resumed: boolean }> {
  assertEnvironmentName(input.environment);
  if (!input.accountId.trim()) throw new Error('provisioning_intent_account_required');

  const paths = getEnvironmentPaths({ baseDir: input.baseDir, env: input.environment });
  const existing = await loadProvisioningIntent(input);
  if (existing) {
    assertMatchingIntent(existing, input);
    return { intent: existing, resumed: true };
  }

  const intent: ProvisioningIntent = {
    version: 1,
    id: randomUUID(),
    environment: input.environment,
    accountId: input.accountId,
    resourceSpec: input.resourceSpec,
    resourceSpecDigest: calculateProvisioningResourceSpecDigest(input.resourceSpec),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resources: {},
  };
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const temporaryPath = `${paths.provisioningIntent}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(intent, null, 2)}\n`, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      // Hard-link publication is atomic and never overwrites a competing intent.
      await link(temporaryPath, paths.provisioningIntent);
      await syncDirectory(paths.root);
      return { intent, resumed: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = await loadProvisioningIntent(input);
      if (!raced) throw new Error('provisioning_intent_race_lost', { cause: error });
      assertMatchingIntent(raced, input);
      return { intent: raced, resumed: true };
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function updateProvisioningIntent(
  input: { baseDir: string; environment: string; expectedIntentId: string },
  update: (intent: ProvisioningIntent) => ProvisioningIntent
): Promise<ProvisioningIntent> {
  const paths = getEnvironmentPaths({ baseDir: input.baseDir, env: input.environment });
  const current = await loadProvisioningIntent(input);
  if (!current || current.id !== input.expectedIntentId) {
    throw new Error('provisioning_intent_changed_before_checkpoint');
  }
  const next = update(current);
  const persisted = { ...next, updatedAt: new Date().toISOString() };
  await writePrivateFileAtomically(
    paths.provisioningIntent,
    `${JSON.stringify(persisted, null, 2)}\n`
  );
  return persisted;
}

export async function recordProvisioningKeyId(input: {
  baseDir: string;
  environment: string;
  expectedIntentId: string;
  keyId: string;
}): Promise<void> {
  if (!input.keyId.trim()) throw new Error('provisioning_key_id_required');
  await updateProvisioningIntent(input, (intent) => {
    if (intent.keyId && intent.keyId !== input.keyId) {
      throw new Error('provisioning_key_id_changed');
    }
    return { ...intent, keyId: input.keyId };
  });
}

function normalizeProvisioningResourceIdentity(
  resource: ProvisioningResourceIdentity
): ProvisioningResourceIdentity {
  return {
    kind: resource.kind,
    binding: resource.binding,
    name: resource.name,
    ...(resource.creationDate ? { creationDate: resource.creationDate } : {}),
    ...(resource.ownershipMarkerKey ? { ownershipMarkerKey: resource.ownershipMarkerKey } : {}),
    ...(resource.ownershipId ? { ownershipId: resource.ownershipId } : {}),
  };
}

function assertValidProvisioningResourceIdentity(resource: ProvisioningResourceIdentity): void {
  if (!['d1', 'kv', 'queue', 'r2'].includes(resource.kind) || !resource.binding || !resource.name) {
    throw new Error('invalid_provisioning_resource_checkpoint');
  }
  const hasOwnershipMarker = Boolean(resource.ownershipMarkerKey || resource.ownershipId);
  if (
    (resource.kind !== 'r2' && (hasOwnershipMarker || resource.creationDate)) ||
    (resource.ownershipMarkerKey === undefined) !== (resource.ownershipId === undefined) ||
    (resource.creationDate !== undefined && !Number.isFinite(Date.parse(resource.creationDate)))
  ) {
    throw new Error('invalid_provisioning_resource_checkpoint');
  }
}

function assertMatchingProvisioningResourceIdentity(
  existing: ProvisioningResourceCheckpoint,
  resource: ProvisioningResourceIdentity,
  checkpointKey: string
): void {
  if (
    existing.kind !== resource.kind ||
    existing.binding !== resource.binding ||
    existing.name !== resource.name ||
    (existing.ownershipMarkerKey !== undefined &&
      existing.ownershipMarkerKey !== resource.ownershipMarkerKey) ||
    (existing.ownershipId !== undefined && existing.ownershipId !== resource.ownershipId) ||
    (existing.creationDate !== undefined && existing.creationDate !== resource.creationDate)
  ) {
    throw new Error(`provisioning_resource_identity_changed:${checkpointKey}`);
  }
}

/**
 * Persist the exact resource mutation boundary before contacting Cloudflare. The provider call is
 * only allowed after this write resolves, so a later resume never treats the journal's existence
 * alone as authority to adopt an independently-created deterministic name.
 */
export async function recordProvisioningResourceCreateIssued(input: {
  baseDir: string;
  environment: string;
  expectedIntentId: string;
  resource: ProvisioningResourceIdentity;
}): Promise<void> {
  const resource = normalizeProvisioningResourceIdentity(input.resource);
  assertValidProvisioningResourceIdentity(resource);
  const checkpointKey = `${resource.kind}:${resource.binding}`;
  await updateProvisioningIntent(input, (intent) => {
    const existing = intent.resources[checkpointKey];
    if (existing) {
      assertMatchingProvisioningResourceIdentity(existing, resource, checkpointKey);
      // A provider-identified resource must never move backwards to create_issued.
      if (existing.state === 'identified' || existing.state === 'created') return intent;
    }
    return {
      ...intent,
      resources: {
        ...intent.resources,
        [checkpointKey]: {
          ...resource,
          state: 'create_issued',
        },
      },
    };
  });
}

/**
 * Mark a provider failure that definitively did not authorize adoption (for example, a 409 race or
 * a 4xx permission failure). A retry must re-check strict absence before moving back to
 * create_issued; merely finding the deterministic name is still a collision.
 */
export async function recordProvisioningResourceCreateRejected(input: {
  baseDir: string;
  environment: string;
  expectedIntentId: string;
  resource: ProvisioningResourceIdentity;
}): Promise<void> {
  const resource = normalizeProvisioningResourceIdentity(input.resource);
  assertValidProvisioningResourceIdentity(resource);
  const checkpointKey = `${resource.kind}:${resource.binding}`;
  await updateProvisioningIntent(input, (intent) => {
    const existing = intent.resources[checkpointKey];
    if (!existing) {
      throw new Error(`provisioning_resource_create_not_issued:${checkpointKey}`);
    }
    assertMatchingProvisioningResourceIdentity(existing, resource, checkpointKey);
    if (existing.state === 'identified' || existing.state === 'created') {
      throw new Error(`provisioning_resource_already_created:${checkpointKey}`);
    }
    return {
      ...intent,
      resources: {
        ...intent.resources,
        [checkpointKey]: {
          ...resource,
          state: 'create_rejected',
        },
      },
    };
  });
}

/**
 * Persist the immutable provider identity immediately after the create response (or an exact R2
 * marker readback), before waiting for list propagation or performing any later setup work.
 * Recovery may reconcile this exact identity but must never issue another create.
 */
export async function recordProvisioningResourceIdentified(input: {
  baseDir: string;
  environment: string;
  expectedIntentId: string;
  resource: ProvisioningResourceCheckpoint;
}): Promise<void> {
  const resource = input.resource;
  const r2IdentityComplete = Boolean(
    resource.creationDate && resource.ownershipMarkerKey && resource.ownershipId
  );
  if (
    !['d1', 'kv', 'queue', 'r2'].includes(resource.kind) ||
    !resource.binding ||
    !resource.name ||
    resource.state !== 'identified' ||
    (resource.kind === 'r2' ? !r2IdentityComplete || resource.id !== undefined : !resource.id)
  ) {
    throw new Error('invalid_provisioning_resource_checkpoint');
  }
  const checkpointKey = `${resource.kind}:${resource.binding}`;
  await updateProvisioningIntent(input, (intent) => {
    const existing = intent.resources[checkpointKey];
    if (!existing) {
      throw new Error(`provisioning_resource_create_not_issued:${checkpointKey}`);
    }
    assertMatchingProvisioningResourceIdentity(existing, resource, checkpointKey);
    if (existing.state === 'create_rejected') {
      throw new Error(`provisioning_resource_create_rejected:${checkpointKey}`);
    }
    if (existing.id !== undefined && resource.id !== undefined && existing.id !== resource.id) {
      throw new Error(`provisioning_resource_identity_changed:${checkpointKey}`);
    }
    if (existing.state === 'created') return intent;
    return {
      ...intent,
      resources: {
        ...intent.resources,
        [checkpointKey]: {
          ...existing,
          ...resource,
          state: 'identified',
        },
      },
    };
  });
}

export async function recordProvisionedResource(input: {
  baseDir: string;
  environment: string;
  expectedIntentId: string;
  resource: ProvisioningResourceCheckpoint;
}): Promise<void> {
  // D1, KV, and Queue names are deterministic and reusable, so none is a durable provider
  // identity. R2 also requires the provider creation timestamp plus Setup's durable marker.
  const resource = input.resource;
  if (
    !['d1', 'kv', 'queue', 'r2'].includes(resource.kind) ||
    !resource.binding ||
    !resource.name ||
    (resource.id !== undefined && !resource.id) ||
    (resource.kind !== 'r2' && !resource.id) ||
    (resource.kind === 'r2' &&
      (!resource.creationDate || !resource.ownershipMarkerKey || !resource.ownershipId)) ||
    resource.state !== 'created'
  ) {
    throw new Error('invalid_provisioning_resource_checkpoint');
  }
  const checkpointKey = `${resource.kind}:${resource.binding}`;
  await updateProvisioningIntent(input, (intent) => {
    const existing = intent.resources[checkpointKey];
    if (!existing) {
      throw new Error(`provisioning_resource_create_not_issued:${checkpointKey}`);
    }
    assertMatchingProvisioningResourceIdentity(existing, resource, checkpointKey);
    if (existing.state !== 'identified' && existing.state !== 'created') {
      throw new Error(`provisioning_resource_not_identified:${checkpointKey}`);
    }
    if (existing.id !== undefined && resource.id !== undefined && existing.id !== resource.id) {
      throw new Error(`provisioning_resource_identity_changed:${checkpointKey}`);
    }
    return {
      ...intent,
      resources: {
        ...intent.resources,
        [checkpointKey]: {
          ...existing,
          ...resource,
          state: 'created',
          id: existing?.id ?? resource.id,
        },
      },
    };
  });
}

export async function completeProvisioningIntent(input: {
  baseDir: string;
  environment: string;
  expectedIntentId?: string;
}): Promise<void> {
  const paths = getEnvironmentPaths({ baseDir: input.baseDir, env: input.environment });
  const existing = await loadProvisioningIntent(input);
  if (!existing) return;
  if (input.expectedIntentId && existing.id !== input.expectedIntentId) {
    throw new Error('provisioning_intent_changed_before_completion');
  }
  await unlink(paths.provisioningIntent);
  await syncDirectory(dirname(paths.provisioningIntent));
}
