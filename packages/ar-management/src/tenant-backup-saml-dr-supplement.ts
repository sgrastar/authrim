import type { Env } from '@authrim/ar-lib-core';
import type { AccountRouteProjection } from '@authrim/ar-lib-core/services/control-plane/control-plane-contracts';
import {
  SAML_DR_RUNTIME_STATE_DATASET,
  type SamlDrAccountAuthState,
  type SamlDrFrozenSourceCapture,
  type SamlDrPasskeyCounter,
  type SamlDrPersistentNameId,
  type SamlDrSnapshotPayload,
} from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-snapshot';
import { tenantBackupBoundaryId } from '@authrim/ar-lib-core/services/tenant-portability/snapshot-boundary-step';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type {
  AdapterContext,
  TenantBackupInstalledExportAdapter,
} from './tenant-backup-export-dispatcher';
import { loadTenantBackupExportExecution } from './tenant-backup-execution';
import { tenantBackupRecordSnapshotId } from './tenant-backup-phase5-adapter';
import {
  createEncryptedTenantBackupRecordSnapshotPort,
  type EncryptedTenantBackupRecordSnapshotPort,
} from './tenant-backup-record-snapshot-port';

const RESOURCE_ID = 'saml-runtime-state:tenant';
const PAGE_SIZE = 128;
const MAX_PAGES = 4096;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

type SourceIdentity = SamlDrFrozenSourceCapture['source'];
type RuntimeSettings = Pick<
  SamlDrSnapshotPayload,
  'sourceFlowRuntimeEnabled' | 'consentIpSalt' | 'sourcePairwiseFallbackSecret'
>;

/** Each collection is read from a source snapshot, never from current live state. */
export interface SamlDrSourceCollections {
  loginUiConfiguration:
    | { mode: 'disabled' }
    | { mode: 'registered'; clientId: string; origin: string };
  loginUiClients: PortableSqliteRow;
  loginUiOrigins: PortableSqliteRow;
  platformDestinationProfiles: PortableSqliteRow;
  platformDestinationProfileVersions: PortableSqliteRow;
  accountAuthStates: SamlDrAccountAuthState;
  passkeyCounters: SamlDrPasskeyCounter;
  persistentNameIds: SamlDrPersistentNameId;
  accountRoutes: { accountId: string; route: AccountRouteProjection };
  platformSettings: { category: string; documentJson: string; version: string };
  runtimeSettings: RuntimeSettings;
}

/**
 * Installed source adapters own real writer coverage and immutable snapshots. Neither a request
 * flag nor caller-provided completeness booleans can replace these operations. In particular,
 * an unversioned legacy KV NameID listing must fail rather than report a complete empty registry.
 */
export interface SamlDrSnapshotSources {
  /** The dispatcher supplies the complete sealed participant set before any source starts. */
  bindParticipants?(
    this: void,
    context: AdapterContext,
    participants: readonly { resourceId: string; snapshotId: string }[]
  ): Promise<void>;
  assertReady(this: void, context: AdapterContext): Promise<void>;
  prepare(this: void, context: AdapterContext): Promise<void>;
  start(
    this: void,
    context: AdapterContext,
    snapshotId: string,
    identity: SourceIdentity,
    assertHeld: () => Promise<void>
  ): Promise<void>;
  assertFrozen(
    this: void,
    context: AdapterContext,
    snapshotId: string,
    identity: SourceIdentity
  ): Promise<void>;
  assertBoundaryReleased(
    this: void,
    context: AdapterContext,
    identity: SourceIdentity
  ): Promise<void>;
  readPage<Collection extends keyof SamlDrSourceCollections>(
    this: void,
    context: AdapterContext,
    snapshotId: string,
    identity: SourceIdentity,
    collection: Collection,
    cursor: string | null,
    limit: number
  ): Promise<{
    source: SourceIdentity;
    items: readonly SamlDrSourceCollections[Collection][];
    nextCursor: string | null;
  }>;
  release(this: void, context: AdapterContext, snapshotId: string): Promise<void>;
  assertReleased(this: void, context: AdapterContext, snapshotId: string): Promise<void>;
}

type SamlDrEnv = Env & { ENABLE_SAML_DR_EXPORT?: string };

function invalid(): never {
  throw new Error('saml_dr_source_capture_invalid');
}

/** Canonical JSON is shared by the containing row, source comparisons, and the AWS collector. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') invalid();
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function text(row: PortableSqliteRow, name: string): string {
  const value = row[name];
  if (!value || value[0] !== 'text' || typeof value[1] !== 'string' || !value[1]) invalid();
  return value[1];
}

async function sourceIdentity(
  env: SamlDrEnv,
  context: AdapterContext,
  now: () => number
): Promise<SourceIdentity> {
  const boundaryUnixMs = context.boundaryUnixMs;
  if (!Number.isSafeInteger(boundaryUnixMs) || (boundaryUnixMs ?? -1) < 0) invalid();
  const head = await context.inventory.headForLease(context.context.lease);
  if (head.state !== 'sealed' || !/^[a-f0-9]{64}$/.test(head.chain_digest)) invalid();
  const loaded = await loadTenantBackupExportExecution(env, context.context, now);
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId || loaded.intent.source.tenantId !== context.context.lease.tenantId) invalid();
  const identity = {
    bundleId: Array.from(loaded.key.envelope.subarray(1, 17), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join(''),
    snapshotId: await tenantBackupBoundaryId({
      environmentId,
      tenantId: context.context.lease.tenantId,
      operationId: context.context.lease.operationId,
      inventoryDigest: head.chain_digest,
    }),
    boundaryUnixMs: boundaryUnixMs as number,
    inventoryDigestSha256: head.chain_digest,
    source: structuredClone(loaded.intent.source),
  };
  if (!/^[a-f0-9]{32}$/.test(identity.bundleId)) invalid();
  return identity;
}

/** Completeness is emitted only after every independently identified collection reaches its end. */
export async function captureSamlDrFrozenSource(input: {
  context: AdapterContext;
  snapshotId: string;
  identity: SourceIdentity;
  sources: SamlDrSnapshotSources;
}): Promise<SamlDrFrozenSourceCapture> {
  const { context, snapshotId, identity, sources } = input;
  const expectedSource = canonical(identity);
  const tenantId = context.context.lease.tenantId;
  if (identity.source.tenantId !== tenantId || identity.boundaryUnixMs !== context.boundaryUnixMs)
    invalid();
  let totalBytes = 0;
  async function read<Collection extends keyof SamlDrSourceCollections>(collection: Collection) {
    const items: SamlDrSourceCollections[Collection][] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      context.context.signal.throwIfAborted();
      await sources.assertFrozen(context, snapshotId, identity);
      const page: {
        source: SourceIdentity;
        items: readonly SamlDrSourceCollections[Collection][];
        nextCursor: string | null;
      } = await sources.readPage(context, snapshotId, identity, collection, cursor, PAGE_SIZE);
      if (
        canonical(page.source) !== expectedSource ||
        !Array.isArray(page.items) ||
        page.items.length > PAGE_SIZE ||
        (page.nextCursor !== null &&
          (typeof page.nextCursor !== 'string' ||
            !page.nextCursor ||
            page.nextCursor.length > 4096 ||
            seen.has(page.nextCursor) ||
            page.items.length === 0))
      )
        invalid();
      totalBytes += new TextEncoder().encode(canonical(page.items)).length;
      if (totalBytes > MAX_CAPTURE_BYTES) invalid();
      const typedItems = page.items as readonly SamlDrSourceCollections[Collection][];
      items.push(...structuredClone(typedItems));
      if (page.nextCursor === null) return items;
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return invalid();
  }
  await sources.assertBoundaryReleased(context, identity);
  const configuration = await read('loginUiConfiguration');
  const clients = await read('loginUiClients');
  const origins = await read('loginUiOrigins');
  if (configuration.length !== 1) invalid();
  let sourceLoginUi: SamlDrSnapshotPayload['sourceLoginUi'];
  const selected = configuration[0];
  if (selected.mode === 'disabled') {
    if (Object.keys(selected).length !== 1 || clients.length || origins.length) invalid();
    sourceLoginUi = { mode: 'disabled' };
  } else {
    if (
      selected.mode !== 'registered' ||
      Object.keys(selected).length !== 3 ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(selected.clientId)
    )
      invalid();
    const url = new URL(selected.origin);
    if (url.protocol !== 'https:' || url.origin !== selected.origin) invalid();
    if (
      clients.length !== 1 ||
      text(clients[0], 'tenant_id') !== tenantId ||
      text(clients[0], 'client_id') !== selected.clientId ||
      origins.length !== 1 ||
      text(origins[0], 'tenant_id') !== tenantId ||
      text(origins[0], 'client_id') !== selected.clientId ||
      text(origins[0], 'origin') !== selected.origin
    )
      invalid();
    sourceLoginUi = { client: clients[0], origins };
  }
  const profiles = await read('platformDestinationProfiles');
  const versions = await read('platformDestinationProfileVersions');
  const accounts = await read('accountAuthStates');
  const counters = await read('passkeyCounters');
  const nameIds = await read('persistentNameIds');
  for (const rows of [accounts, counters, nameIds]) {
    if (rows.some((row) => row.tenantId !== tenantId)) invalid();
  }
  if (
    new Set(accounts.map((row) => row.accountId)).size !== accounts.length ||
    new Set(counters.map((row) => row.passkeyId)).size !== counters.length ||
    new Set(nameIds.map((row) => row.registryKey)).size !== nameIds.length
  )
    invalid();
  const accountRoutes: Record<string, AccountRouteProjection> = Object.create(null) as Record<
    string,
    AccountRouteProjection
  >;
  for (const entry of await read('accountRoutes')) {
    if (!entry.accountId || Object.hasOwn(accountRoutes, entry.accountId)) invalid();
    accountRoutes[entry.accountId] = entry.route;
  }
  const platformSettings: Record<string, { documentJson: string; version: string }> = Object.create(
    null
  ) as Record<string, { documentJson: string; version: string }>;
  for (const entry of await read('platformSettings')) {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(entry.category) ||
      Object.hasOwn(platformSettings, entry.category)
    )
      invalid();
    platformSettings[entry.category] = { documentJson: entry.documentJson, version: entry.version };
  }
  const runtime = await read('runtimeSettings');
  if (
    runtime.length !== 1 ||
    typeof runtime[0].sourceFlowRuntimeEnabled !== 'boolean' ||
    typeof runtime[0].consentIpSalt !== 'string' ||
    runtime[0].consentIpSalt.length < 32 ||
    (runtime[0].sourcePairwiseFallbackSecret !== undefined &&
      (typeof runtime[0].sourcePairwiseFallbackSecret !== 'string' ||
        runtime[0].sourcePairwiseFallbackSecret.length < 32))
  )
    invalid();
  await sources.assertFrozen(context, snapshotId, identity);
  await sources.assertBoundaryReleased(context, identity);
  context.context.signal.throwIfAborted();
  return {
    formatVersion: 1,
    source: structuredClone(identity),
    completeness: {
      accountAuthStates: true,
      passkeyCounters: true,
      persistentNameIds: true,
      sourceLoginUi: true,
      platformDestinationProfiles: true,
      accountRoutes: true,
      platformSettings: true,
      sourceRuntimeSettings: true,
    },
    payload: {
      sourceLoginUi,
      platformDestinationProfiles: { profiles, versions },
      state: {
        accountAuthStates: accounts,
        passkeyCounters: counters,
        persistentNameIdsComplete: true,
        persistentNameIds: nameIds,
      },
      accountRoutes,
      platformSettings,
      ...runtime[0],
    },
  };
}

export function createTenantBackupSamlDrSupplementPort(input: {
  env: SamlDrEnv;
  sources: SamlDrSnapshotSources;
  now?: () => number;
}): EncryptedTenantBackupRecordSnapshotPort & {
  prepare(context: AdapterContext): Promise<void>;
  bindParticipants(
    context: AdapterContext,
    participants: readonly { resourceId: string; snapshotId: string }[]
  ): Promise<void>;
} {
  const now = input.now ?? Date.now;
  const assertReady = async (context: AdapterContext) => {
    context.context.signal.throwIfAborted();
    if (
      input.env.ENABLE_SAML_DR_EXPORT !== 'true' ||
      !context.selection.settings ||
      !context.selection.users
    )
      invalid();
    await input.sources.assertReady(context);
  };
  const materialized = createEncryptedTenantBackupRecordSnapshotPort({
    env: input.env,
    resourceId: RESOURCE_ID,
    assertSource: assertReady,
    async *capture(context) {
      const identity = await sourceIdentity(input.env, context, now);
      const snapshotId = await tenantBackupRecordSnapshotId(context, RESOURCE_ID);
      const capture = await captureSamlDrFrozenSource({
        context,
        snapshotId,
        identity,
        sources: input.sources,
      });
      const captureJson = canonical(capture);
      if (new TextEncoder().encode(captureJson).length > MAX_CAPTURE_BYTES) invalid();
      yield new TextEncoder().encode(
        `${JSON.stringify({
          tenant_id: ['text', context.context.lease.tenantId],
          capture_json: ['text', captureJson],
        })}\n`
      );
    },
  });
  const materialize = async (context: AdapterContext, snapshotId: string) => {
    await assertReady(context);
    const expectedSnapshotId = await tenantBackupRecordSnapshotId(context, RESOURCE_ID);
    if (snapshotId !== expectedSnapshotId) invalid();
    const identity = await sourceIdentity(input.env, context, now);
    const assertImmutable = async () => {
      context.context.signal.throwIfAborted();
      await input.sources.assertFrozen(context, snapshotId, identity);
      await input.sources.assertBoundaryReleased(context, identity);
    };
    // This port reads immutable source snapshots after release. The supplied assertion proves
    // immutability; it does not pretend that the live writer hold remains active during R2 writes.
    await materialized.start(context, snapshotId, assertImmutable, identity.boundaryUnixMs);
  };
  return {
    resourceId: RESOURCE_ID,
    assertSource: assertReady,
    async bindParticipants(context, participants) {
      await input.sources.bindParticipants?.(context, participants);
    },
    async prepare(context) {
      await assertReady(context);
      await input.sources.prepare(context);
    },
    async start(context, snapshotId, assertHeld, boundaryUnixMs) {
      const frozenContext = { ...context, boundaryUnixMs };
      await assertReady(frozenContext);
      const expectedSnapshotId = await tenantBackupRecordSnapshotId(context, RESOURCE_ID);
      if (snapshotId !== expectedSnapshotId) invalid();
      const identity = await sourceIdentity(input.env, frozenContext, now);
      await assertHeld();
      await input.sources.start(frozenContext, snapshotId, identity, assertHeld);
      await input.sources.assertFrozen(frozenContext, snapshotId, identity);
      await assertHeld();
    },
    async readNext(context, snapshotId, cursor, signal) {
      signal.throwIfAborted();
      await materialize(context, snapshotId);
      return materialized.readNext(context, snapshotId, cursor, signal);
    },
    async readSummaries(context, snapshotId, boundaryUnixMs, visit) {
      const frozenContext = { ...context, boundaryUnixMs };
      await materialize(frozenContext, snapshotId);
      return materialized.readSummaries(frozenContext, snapshotId, boundaryUnixMs, visit);
    },
    async release(context, snapshotId) {
      await materialized.release(context, snapshotId);
      await input.sources.release(context, snapshotId);
    },
    async assertReleased(context, snapshotId) {
      await materialized.assertReleased(context, snapshotId);
      await input.sources.assertReleased(context, snapshotId);
    },
  };
}

/** An explicitly installed extension; absent sources leave every existing export unchanged. */
export function withSamlDrSupplementExport(
  base: TenantBackupInstalledExportAdapter,
  port: ReturnType<typeof createTenantBackupSamlDrSupplementPort> | undefined
): TenantBackupInstalledExportAdapter {
  if (!port) return base;
  return {
    ...base,
    datasets(selection) {
      if (!selection.settings || !selection.users) invalid();
      return [...base.datasets(selection), structuredClone(SAML_DR_RUNTIME_STATE_DATASET)];
    },
    async prepareSources(context) {
      const result = await base.prepareSources(context);
      if (result.done) await port.prepare(context);
      return result;
    },
    async assertSources(context) {
      await base.assertSources(context);
      await port.assertSource(context);
    },
    async assertBoundaryReady(context) {
      await base.assertBoundaryReady(context);
      await port.assertSource(context);
    },
    async additionalParticipants(context) {
      const participants = await base.additionalParticipants(context);
      const snapshotId = await tenantBackupRecordSnapshotId(context, port.resourceId);
      if (participants.some((entry) => entry.resourceId === port.resourceId)) invalid();
      return [
        ...participants,
        {
          resourceId: port.resourceId,
          snapshotId,
          start: (assertHeld, boundaryUnixMs) =>
            port.start(context, snapshotId, assertHeld, boundaryUnixMs),
        },
      ];
    },
    async assertCoverage(context) {
      const matching = context.participants.filter((entry) => entry.resourceId === port.resourceId);
      if (
        matching.length !== 1 ||
        matching[0].snapshotId !== (await tenantBackupRecordSnapshotId(context, port.resourceId))
      )
        invalid();
      await port.bindParticipants(context, context.participants);
      await base.assertCoverage({
        ...context,
        participants: context.participants.filter((entry) => entry.resourceId !== port.resourceId),
      });
    },
    readNext(context) {
      if (context.datasetId !== SAML_DR_RUNTIME_STATE_DATASET.id) return base.readNext(context);
      return tenantBackupRecordSnapshotId(context, port.resourceId).then((snapshotId) =>
        port.readNext(context, snapshotId, context.cursor, context.signal)
      );
    },
    async releaseAdditionalResources(context) {
      const result = await base.releaseAdditionalResources(context);
      if (!result.done) return result;
      await port.release(context, await tenantBackupRecordSnapshotId(context, port.resourceId));
      return { done: true };
    },
    async assertPublishable(context) {
      await base.assertPublishable(context);
      await port.assertReleased(
        context,
        await tenantBackupRecordSnapshotId(context, port.resourceId)
      );
    },
  };
}
