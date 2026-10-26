import { LEGACY_IMPORT_CONTRACT, type Env } from '@authrim/ar-lib-core';
import { generateVersion } from '@authrim/ar-lib-core/utils/settings-manager';
import { resolveAccountRouteForSamlDrSnapshot } from '@authrim/ar-lib-core/services/runtime-data-context';
import { assertSamlDrWriterCoverage } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer';
import { readSamlDrRuntimeSettings } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-runtime-settings';
import type { SamlDrWriterInventoryReceipt } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer-contract';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import type { SamlDrFrozenSourceCapture } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-snapshot';
import {
  decryptObjectArtifact,
  encryptObjectArtifact,
  type EncryptedObjectArtifactEnvelope,
} from '@authrim/ar-lib-core/services/object-artifact-crypto';
import type { AdapterContext } from './tenant-backup-export-dispatcher';
import { createSamlDrAccountSnapshotSource } from './tenant-backup-saml-dr-account-source';
import type {
  SamlDrSnapshotSources,
  SamlDrSourceCollections,
} from './tenant-backup-saml-dr-supplement';
import { getTenantBackupBoundaryClient } from './tenant-backup-services';
import { tenantBackupRecordSnapshotId } from './tenant-backup-phase5-adapter';
import {
  assertSamlDrSqlInventoryFrozen,
  canonicalSamlDrSource,
  invalidSamlDrSqlSource,
  readBoundedSamlDrSqlRows,
  readFrozenSamlDrSqlRows,
  readLiveSamlDrSqlInventory,
  samlDrAccountInventory,
  samlDrInteger,
  samlDrText,
  SAML_DR_SOURCE_MAX_BYTES,
  type SamlDrSqlInventory,
} from './tenant-backup-saml-dr-sql-source';

type Identity = SamlDrFrozenSourceCapture['source'];
type Participant = { resourceId: string; snapshotId: string };
type Collections = { [Key in keyof SamlDrSourceCollections]: SamlDrSourceCollections[Key][] };
interface SourcePlan {
  version: 1;
  operationId: string;
  recordSnapshotId: string;
  identity: Identity;
  participants: Participant[];
  writerCoverage: SamlDrWriterInventoryReceipt;
  sql: SamlDrSqlInventory;
  platformDestinationProfiles: Collections['platformDestinationProfiles'];
  platformDestinationProfileVersions: Collections['platformDestinationProfileVersions'];
  platformSettings: Collections['platformSettings'];
  accountRoutes: Collections['accountRoutes'];
  runtimeSettings: Collections['runtimeSettings'];
}
function invalid(): never {
  return invalidSamlDrSqlSource();
}
const canonical = canonicalSamlDrSource;

function boundary(plan: SourcePlan) {
  return {
    tenantId: plan.identity.source.tenantId,
    snapshotId: plan.recordSnapshotId,
    boundaryUnixMs: plan.identity.boundaryUnixMs,
  };
}
function prefix(context: AdapterContext, snapshotId: string) {
  const { tenantId, operationId } = context.context.lease;
  if ([tenantId, operationId, snapshotId].some((id) => !/^[A-Za-z0-9_.:-]{1,256}$/u.test(id)))
    invalid();
  return `tenant-backup-saml-dr/${tenantId}/${operationId}/${snapshotId}/`;
}
function adminDatabase(context: AdapterContext) {
  const matches = context.databases.fixed.filter((resource) => resource.binding === 'DB_ADMIN');
  if (matches.length !== 1) invalid();
  return matches[0].database;
}
async function hash(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Production source assembly. All live reads happen under the admitted environment boundary;
 * SQL is independently reconciled against that operation's existing COW snapshots after release.
 * No legacy KV values, generated secrets, or synthetic completeness enter this source.
 */
export function createProductionSamlDrSnapshotSources(input: {
  env: Env;
  loadPlanned: () => Promise<readonly PlannedInstalledSqliteDataset[]>;
  now?: () => number;
}): SamlDrSnapshotSources {
  const { env } = input;
  const now = input.now ?? Date.now;
  let participants: Participant[] | undefined;
  let preparedCoverage: Promise<SamlDrWriterInventoryReceipt> | undefined;
  const verifiedReadSessions = new WeakMap<object, Promise<SamlDrWriterInventoryReceipt>>();
  const cache = new Map<string, Promise<Collections>>();
  const storage = () => {
    if (
      !env.EXPORT_ARTIFACTS ||
      !/^[a-fA-F0-9]{64}$/u.test(env.OBJECT_ENCRYPTION_ROOT_KEY ?? '') ||
      !/^[1-9][0-9]{0,8}$/u.test(env.OBJECT_ENCRYPTION_KEY_VERSION ?? '1')
    )
      invalid();
    return {
      bucket: env.EXPORT_ARTIFACTS,
      rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY as string,
      keyVersion: Number(env.OBJECT_ENCRYPTION_KEY_VERSION ?? '1'),
    };
  };
  const read = async (
    context: AdapterContext,
    snapshotId: string,
    name: string
  ): Promise<string | null> => {
    context.context.signal.throwIfAborted();
    const { bucket, rootKeyHex } = storage();
    const key = `${prefix(context, snapshotId)}${name}`;
    const object = await bucket.get(key);
    if (!object) return null;
    if (object.size > SAML_DR_SOURCE_MAX_BYTES * 2) invalid();
    const envelope = JSON.parse(await object.text()) as EncryptedObjectArtifactEnvelope;
    if (
      envelope.plane !== 'EXPORT_ARTIFACTS' ||
      envelope.objectClass !== 'dr_bundle' ||
      envelope.contentType !== 'application/json'
    )
      invalid();
    const value = await decryptObjectArtifact(envelope, {
      rootKeyHex,
      context: {
        tenantId: context.context.lease.tenantId,
        objectKey: key,
        objectClass: 'dr_bundle',
      },
    });
    if (new TextEncoder().encode(value).length > SAML_DR_SOURCE_MAX_BYTES) invalid();
    return value;
  };
  const write = async (
    context: AdapterContext,
    snapshotId: string,
    name: string,
    value: unknown
  ) => {
    const plaintext = canonical(value);
    if (new TextEncoder().encode(plaintext).length > SAML_DR_SOURCE_MAX_BYTES) invalid();
    const { bucket, rootKeyHex, keyVersion } = storage();
    const key = `${prefix(context, snapshotId)}${name}`;
    const envelope = await encryptObjectArtifact(plaintext, {
      rootKeyHex,
      keyVersion,
      plane: 'EXPORT_ARTIFACTS',
      contentType: 'application/json',
      context: {
        tenantId: context.context.lease.tenantId,
        objectKey: key,
        objectClass: 'dr_bundle',
      },
    });
    await bucket.put(key, JSON.stringify(envelope), {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
    });
    if ((await read(context, snapshotId, name)) !== plaintext) invalid();
  };
  const load = async (context: AdapterContext, snapshotId: string, identity?: Identity) => {
    const raw = await read(context, snapshotId, 'plan.json');
    if (raw === null) return null;
    const plan = JSON.parse(raw) as SourcePlan;
    if (
      plan.version !== 1 ||
      plan.operationId !== context.context.lease.operationId ||
      plan.recordSnapshotId !== snapshotId ||
      !plan.writerCoverage ||
      plan.identity.source.tenantId !== context.context.lease.tenantId ||
      (identity && canonical(plan.identity) !== canonical(identity)) ||
      canonical(plan) !== raw ||
      !Array.isArray(plan.participants) ||
      !plan.participants.length ||
      plan.participants.length > 64
    )
      invalid();
    // Revalidate the exact Core inventory even during cancellation; it is never replaced by live rows.
    samlDrAccountInventory(context.context.lease.tenantId, plan.sql);
    return plan;
  };
  const frozen = async (context: AdapterContext, snapshotId: string, identity: Identity) => {
    const plan = await load(context, snapshotId, identity);
    if (
      !plan ||
      (await read(context, snapshotId, 'ready.json')) !==
        canonical({ sha256: await hash(canonical(plan)) })
    )
      invalid();
    return plan;
  };
  const assertReleasedBoundary = async (context: AdapterContext, plan: SourcePlan) => {
    const identity = {
      environmentId: env.AUTHRIM_ENVIRONMENT_NAME ?? '',
      tenantId: context.context.lease.tenantId,
      operationId: context.context.lease.operationId,
      inventoryDigest: plan.identity.inventoryDigestSha256,
      boundaryId: plan.identity.snapshotId,
    };
    const released = await getTenantBackupBoundaryClient(env, identity).receipts.readReleased(
      identity,
      plan.participants,
      now()
    );
    if (!released || released.held_at !== plan.identity.boundaryUnixMs) invalid();
    let verification = context.readSession
      ? verifiedReadSessions.get(context.readSession)
      : undefined;
    if (!verification) {
      verification = assertSamlDrWriterCoverage(
        env,
        context.context.lease.tenantId,
        context.context.signal,
        plan.writerCoverage
      );
      if (context.readSession) verifiedReadSessions.set(context.readSession, verification);
    }
    await verification;
  };
  const ready = async (context: AdapterContext) => {
    context.context.signal.throwIfAborted();
    if (env.ENABLE_SAML_DR_EXPORT !== 'true' || env.AUTH_RUNTIME_PORTS) invalid();
    // Provider inspection happens before hold admission, never in the bounded start callback.
    if (context.boundaryUnixMs === undefined) {
      preparedCoverage ??= assertSamlDrWriterCoverage(
        env,
        context.context.lease.tenantId,
        context.context.signal
      );
      await preparedCoverage;
    }
    storage();
    await input.loadPlanned();
  };
  const capturePlan = async (
    context: AdapterContext,
    snapshotId: string,
    identity: Identity,
    assertHeld: () => Promise<void>
  ): Promise<SourcePlan> => {
    if (!participants || !preparedCoverage) invalid();
    const installed = await input.loadPlanned();
    const sql = await readLiveSamlDrSqlInventory(context, installed, assertHeld);
    const accounts = samlDrAccountInventory(context.context.lease.tenantId, sql);
    // Validate identifiers/counters before persisting the cleanup plan; a malformed inventory
    // must not leave a plan that the cleanup helper itself cannot consume.
    createSamlDrAccountSnapshotSource(env, accounts);
    const admin = adminDatabase(context);
    await assertHeld();
    const legacy = await admin.queryOne<{ state_json: string }>(
      'SELECT state_json FROM settings_legacy_import_state WHERE id=1'
    );
    const migration = legacy ? (JSON.parse(legacy.state_json) as Record<string, unknown>) : null;
    if (
      migration?.status !== 'completed' ||
      migration.contract !== LEGACY_IMPORT_CONTRACT ||
      migration.rejectedCount !== 0
    )
      throw new Error('saml_dr_settings_authority_unavailable');
    const settings = await admin.query<{
      category: string;
      document_json: string;
      version: string;
      projection_state: string;
    }>(
      'SELECT category,document_json,version,projection_state FROM platform_settings_documents ORDER BY category LIMIT 129'
    );
    if (
      settings.length > 128 ||
      settings.some(
        (row) =>
          row.projection_state !== 'applied' ||
          generateVersion(JSON.parse(row.document_json) as Record<string, unknown>) !== row.version
      )
    )
      invalid();
    const platformRows = async (table: 'destination_profiles' | 'destination_profile_versions') => {
      const entry = installed.find((item) => item.dataset.id === `admin.${table}`);
      if (!entry) invalid();
      return readBoundedSamlDrSqlRows(
        admin,
        table,
        entry.capture.columns,
        table === 'destination_profiles'
          ? "owner_scope_type='platform' AND destination_type='saml'"
          : "profile_id IN (SELECT id FROM destination_profiles WHERE owner_scope_type='platform' AND destination_type='saml')",
        [],
        256
      );
    };
    const profiles = await platformRows('destination_profiles');
    const versions = await platformRows('destination_profile_versions');
    await assertHeld();
    const runtime = await readSamlDrRuntimeSettings(env, context.context.lease.tenantId);
    const accountRoutes: Collections['accountRoutes'] = [];
    for (const account of accounts) {
      await assertHeld();
      const row =
        sql['core.identity_accounts'].find(
          (item) => samlDrText(item, 'id') === account.accountId
        ) ?? invalid();
      const generation = Number(samlDrInteger(row, 'account_route_generation'));
      const route = await resolveAccountRouteForSamlDrSnapshot(env, {
        tenantId: account.tenantId,
        accountId: account.accountId,
        accountRouteGeneration: generation,
        nowMs: identity.boundaryUnixMs,
      });
      if (
        route.targets.length !== 2 ||
        new Set(route.targets.map((target) => target.dataRole)).size !== 2 ||
        route.targets.some(
          (target) =>
            !['tenant_core/users', 'tenant_pii'].includes(target.dataRole) ||
            !context.databases.tenant.some((resource) =>
              resource.assignments.some(
                (assignment) =>
                  assignment.dataRole === target.dataRole &&
                  assignment.bindingRef === target.bindingRef &&
                  assignment.shardId === target.shardId &&
                  assignment.residencyPartition === target.residencyPartition &&
                  assignment.bindingRouteGeneration === target.requiredBindingRouteGeneration
              )
            )
        )
      )
        invalid();
      accountRoutes.push({ accountId: account.accountId, route });
    }
    await assertHeld();
    return {
      version: 1,
      operationId: context.context.lease.operationId,
      recordSnapshotId: snapshotId,
      identity,
      participants: structuredClone(participants),
      writerCoverage: structuredClone(await preparedCoverage),
      sql,
      platformDestinationProfiles: profiles,
      platformDestinationProfileVersions: versions,
      platformSettings: settings.map((row) => ({
        category: row.category,
        documentJson: row.document_json,
        version: row.version,
      })),
      accountRoutes,
      runtimeSettings: [runtime],
    };
  };
  const collections = async (context: AdapterContext, plan: SourcePlan): Promise<Collections> => {
    await assertReleasedBoundary(context, plan);
    const installed = await input.loadPlanned();
    await assertSamlDrSqlInventoryFrozen(context, installed, plan.sql);
    const accounts = await createSamlDrAccountSnapshotSource(
      env,
      samlDrAccountInventory(context.context.lease.tenantId, plan.sql)
    ).read(boundary(plan));
    for (const state of accounts.accountAuthStates) {
      const row = plan.sql['core.identity_accounts'].find(
        (item) => samlDrText(item, 'id') === state.accountId
      );
      if (!row || samlDrText(row, 'lifecycle_state') !== state.lifecycle) invalid();
    }
    const clients = await readFrozenSamlDrSqlRows(context, installed, 'core.oauth_clients');
    const origins = await readFrozenSamlDrSqlRows(context, installed, 'core.web_origin_registry');
    return {
      loginUiClients: clients.filter((row) => samlDrText(row, 'client_id') === 'login-ui'),
      loginUiOrigins: origins.filter((row) => samlDrText(row, 'client_id') === 'login-ui'),
      ...accounts,
      platformDestinationProfiles: plan.platformDestinationProfiles,
      platformDestinationProfileVersions: plan.platformDestinationProfileVersions,
      accountRoutes: plan.accountRoutes,
      platformSettings: plan.platformSettings,
      runtimeSettings: plan.runtimeSettings,
    };
  };
  return {
    assertReady: ready,
    prepare: ready,
    async bindParticipants(context, values) {
      await ready(context);
      context.context.signal.throwIfAborted();
      if (
        !values.length ||
        values.length > 64 ||
        new Set(values.map((value) => value.resourceId)).size !== values.length ||
        values.some((value) =>
          [value.resourceId, value.snapshotId].some((id) => !/^[A-Za-z0-9_.:-]{1,256}$/u.test(id))
        )
      )
        invalid();
      const next = structuredClone([...values]).sort((a, b) =>
        a.resourceId.localeCompare(b.resourceId)
      );
      if (participants && canonical(participants) !== canonical(next)) invalid();
      participants = next;
    },
    async start(context, snapshotId, identity, assertHeld) {
      if (!preparedCoverage) throw new Error('saml_dr_writer_receipt_unprepared');
      await ready(context);
      await assertHeld();
      let plan = await load(context, snapshotId, identity);
      if (plan && participants && canonical(plan.participants) !== canonical(participants))
        invalid();
      if (plan && canonical(plan.writerCoverage) !== canonical(await preparedCoverage))
        throw new Error('saml_dr_writer_inventory_changed');
      if (!plan) {
        plan = await capturePlan(context, snapshotId, identity, assertHeld);
        // Durable cleanup inventory is saved BEFORE the first account DO snapshot can start.
        await write(context, snapshotId, 'plan.json', plan);
      }
      await assertHeld();
      await createSamlDrAccountSnapshotSource(
        env,
        samlDrAccountInventory(context.context.lease.tenantId, plan.sql)
      ).start(boundary(plan), assertHeld);
      await assertHeld();
      await write(context, snapshotId, 'ready.json', { sha256: await hash(canonical(plan)) });
      await assertHeld();
    },
    async assertFrozen(context, snapshotId, identity) {
      await frozen(context, snapshotId, identity);
    },
    async assertBoundaryReleased(context, identity) {
      // Source identity is the common boundary; the record snapshot ID comes from its actual plan.
      const own = participants?.find((value) => value.resourceId === 'saml-runtime-state:tenant');
      const snapshotId =
        own?.snapshotId ??
        (await tenantBackupRecordSnapshotId(context, 'saml-runtime-state:tenant'));
      const plan = await frozen(context, snapshotId, identity);
      await assertReleasedBoundary(context, plan);
    },
    async readPage(context, snapshotId, identity, collection, cursor, limit) {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 128 ||
        (cursor !== null && !/^(0|[1-9][0-9]*)$/u.test(cursor))
      )
        invalid();
      const plan = await frozen(context, snapshotId, identity);
      await assertReleasedBoundary(context, plan);
      let pending = cache.get(snapshotId);
      if (!pending) {
        pending = collections(context, plan);
        cache.set(snapshotId, pending);
      }
      const rows = (await pending)[collection];
      const from = cursor === null ? 0 : Number(cursor);
      if (!Number.isSafeInteger(from) || from > rows.length) invalid();
      const end = Math.min(rows.length, from + limit);
      return {
        source: structuredClone(identity),
        items: structuredClone(rows.slice(from, end)),
        nextCursor: end < rows.length ? String(end) : null,
      };
    },
    async release(context, snapshotId) {
      const plan = await load(context, snapshotId);
      if (!plan && (await read(context, snapshotId, 'ready.json')) !== null) invalid();
      if (plan) {
        const source = createSamlDrAccountSnapshotSource(
          env,
          samlDrAccountInventory(context.context.lease.tenantId, plan.sql)
        );
        await source.release(boundary(plan));
        await source.assertReleased(boundary(plan));
      }
      // If no plan exists no account snapshot could have started. Do not enumerate live accounts.
      // Remove the marker first. An interrupted delete always leaves the cleanup inventory.
      await storage().bucket.delete(`${prefix(context, snapshotId)}ready.json`);
      await storage().bucket.delete(`${prefix(context, snapshotId)}plan.json`);
      cache.delete(snapshotId);
    },
    async assertReleased(context, snapshotId) {
      const page = await storage().bucket.list({ prefix: prefix(context, snapshotId), limit: 1 });
      if (page.objects.length || page.truncated) invalid();
    },
  };
}
