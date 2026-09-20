import {
  requireDedicatedAdminDatabaseAdapter,
  type DatabaseAdapter,
  type Env,
  putTenantExistsCache,
} from '@authrim/ar-lib-core';
import { resolveBackupTenantDatabaseResources } from '@authrim/ar-lib-core/services/tenant-portability/database-resources';
import { resolveFixedBackupDatabaseResources } from '@authrim/ar-lib-core/services/tenant-portability/fixed-database-resources';
import { portableLinkedIdentityTokens } from '@authrim/ar-lib-core/services/tenant-portability/portable-linked-identity-tokens';
import { portableOperationalLogDetail } from '@authrim/ar-lib-core/services/tenant-portability/portable-operational-log-detail';
import { portablePiiLogValues } from '@authrim/ar-lib-core/services/tenant-portability/portable-pii-log-values';
import { portableTotpSecret } from '@authrim/ar-lib-core/services/tenant-portability/portable-totp-secret';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { TenantBackupExecutionInventory } from '@authrim/ar-lib-core/services/tenant-portability/execution-inventory';
import { resolveInstalledSqliteDatasets } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-modules';
import { phase8SqliteRestoreTargetRole } from '@authrim/ar-lib-core/services/tenant-portability/phase8-restore-targets';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { createTenantBackupDirectorySecretPorts } from './tenant-backup-directory-secrets-port';
import { createTenantBackupKeyManagerSnapshotPort } from './tenant-backup-key-manager-port';
import { createTenantBackupLogicalPlacementPorts } from './tenant-backup-logical-placement-port';
import {
  TENANT_BACKUP_KEY_MANAGER_RESOURCE_ID,
  tenantBackupRecordSnapshotIdForInventory,
  type Phase5RecordSnapshotPort,
} from './tenant-backup-phase5-adapter';
import {
  createPhase8TenantBackupInstalledAdapter,
  type Phase8InstalledAdapterPorts,
} from './tenant-backup-phase8-adapter';
import { loadPhase8InstalledSqlitePlan } from './tenant-backup-phase8-plan-loader';
import { createTenantBackupPiiLogTransformPort } from './tenant-backup-pii-log-port';
import { createTenantBackupPluginConfigurationPorts } from './tenant-backup-plugin-configuration-port';
import { createTenantBackupPublicAssetPorts } from './tenant-backup-public-assets-port';
import { createTenantBackupR2CatalogLister } from './tenant-backup-r2-catalog-lister';
import { createTenantBackupR2ObjectSnapshotPorts } from './tenant-backup-r2-object-snapshot-port';
import { createTenantBackupSamlPorts } from './tenant-backup-saml-port';
import type { TenantBackupInstalledOperationAdapter } from './tenant-backup-operation-dispatcher';
import { createProductionTenantBackupRestoreTargets } from './tenant-backup-production-restore-targets';
import { ensureDatabaseAdapter } from '@authrim/ar-lib-core';
import {
  activateProvisionedTenantLifecycle,
  resolveActiveTenantRuntimeRouteObservation,
} from './admin-tenants';

function unavailable(): never {
  throw new Error('backup_import_restore_target_unavailable');
}

const ENVIRONMENT_LOCAL_SYSTEM_CLIENT_DESCRIPTIONS = new Set([
  'System-managed public OAuth client used by the built-in Authrim Login UI.',
  'System-managed confidential client used by Authrim for downstream grant introspection.',
]);

function portableText(rowJson: string, column: string): string {
  const row = JSON.parse(rowJson) as Record<string, readonly [string, string | null]>;
  const value = row[column];
  if (value?.[0] !== 'text' || value[1] === null || !value[1])
    throw new Error('backup_system_client_row_invalid');
  return value[1];
}

function portableOptionalText(rowJson: string, column: string): string | null {
  const row = JSON.parse(rowJson) as Record<string, readonly [string, string | null]>;
  const value = row[column];
  if (!value || value[0] === 'null') return null;
  if (value[0] !== 'text') throw new Error('backup_system_client_row_invalid');
  return value[1];
}

/** Keep setup-owned clients local to the environment that generated their IDs and secrets. */
export async function isEnvironmentLocalSystemClientRow(
  database: Pick<DatabaseAdapter, 'queryOne'>,
  datasetId: string,
  rowJson: string
): Promise<boolean> {
  if (datasetId === 'core.oauth_clients')
    return ENVIRONMENT_LOCAL_SYSTEM_CLIENT_DESCRIPTIONS.has(
      portableOptionalText(rowJson, 'description') ?? ''
    );
  if (!['core.client_consent_overrides', 'core.web_origin_registry'].includes(datasetId))
    return false;
  const row = await database.queryOne<{ description: string }>(
    'SELECT description FROM oauth_clients WHERE tenant_id=? AND client_id=?',
    [portableText(rowJson, 'tenant_id'), portableText(rowJson, 'client_id')]
  );
  return ENVIRONMENT_LOCAL_SYSTEM_CLIENT_DESCRIPTIONS.has(row?.description ?? '');
}

async function resolveTenantKey(env: Env, context: TenantBackupStepContext): Promise<string> {
  const resources = await resolveBackupTenantDatabaseResources(env, {
    tenantId: context.lease.tenantId,
    roles: ['tenant_core'],
    signal: context.signal,
  });
  const canonical = resources.filter(({ assignments }) =>
    assignments.some(({ dataRole }) => dataRole === 'tenant_core/default')
  );
  if (canonical.length !== 1) throw new Error('backup_phase8_tenant_key');
  const rows = await canonical[0].database.query<{ tenant_key: string }>(
    'SELECT tenant_key FROM tenants WHERE id=?',
    [context.lease.tenantId]
  );
  const tenantKey = rows.length === 1 ? rows[0]?.tenant_key : null;
  if (!tenantKey || tenantKey.length > 256) throw new Error('backup_phase8_tenant_key');
  return tenantKey;
}

async function resolveRestoreTenantKey(
  env: Env,
  context: TenantBackupStepContext
): Promise<string> {
  const lifecycleStates =
    context.operation.state === 'cancelling'
      ? ['provisioning', 'active']
      : [context.operation.phase === 'verify_restore_activation' ? 'active' : 'provisioning'];
  const row = await ensureDatabaseAdapter(env.DB, 'tenant-backup-restore-platform').queryOne<{
    tenant_key: string;
  }>(
    `SELECT tenant_key FROM tenants WHERE id=? AND lifecycle_state IN (${lifecycleStates
      .map(() => '?')
      .join(',')})`,
    [context.lease.tenantId, ...lifecycleStates]
  );
  if (!row?.tenant_key || row.tenant_key.length > 256) throw new Error('backup_phase8_tenant_key');
  return row.tenant_key;
}

async function loadCancellationInventoryDigest(
  env: Env,
  context: TenantBackupStepContext,
  now: () => number
): Promise<string> {
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new Error('backup_production_export_clock');
  const database = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
  const row = await database.queryOne<{ chain_digest: string }>(
    `SELECT e.chain_digest FROM tenant_backup_execution_inventories e
     JOIN tenant_backup_operations o ON o.id=e.operation_id AND o.tenant_id=e.tenant_id
     WHERE o.id=? AND o.tenant_id=? AND o.kind=? AND o.state='cancelling'
     AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?
     AND e.state='sealed'`,
    [
      context.lease.operationId,
      context.lease.tenantId,
      context.operation.kind,
      context.lease.owner,
      context.lease.fencingToken,
      timestamp,
      timestamp,
    ]
  );
  if (!row || !/^[a-f0-9]{64}$/.test(row.chain_digest))
    throw new Error('backup_production_export_cleanup_fenced');
  return row.chain_digest;
}

function validatePhase8Envelope(datasetId: string, row: PortableSqliteRow): Promise<void> {
  if (datasetId === 'core.totp_credentials') portableTotpSecret(row);
  else if (datasetId === 'core.operational_logs') portableOperationalLogDetail(row);
  else if (datasetId === 'pii.linked_identities') portableLinkedIdentityTokens(row);
  else if (datasetId === 'pii.pii_log') portablePiiLogValues(row);
  return Promise.resolve();
}

async function resolveRecordedDatabase(
  env: Env,
  context: TenantBackupStepContext,
  resourceId: string
): Promise<{ resourceId: string; database: DatabaseAdapter }> {
  const tenant = await resolveBackupTenantDatabaseResources(env, {
    tenantId: context.lease.tenantId,
    roles: ['tenant_core', 'tenant_pii'],
    signal: context.signal,
  });
  const fixed = resolveFixedBackupDatabaseResources(env, ['DB_ADMIN']);
  const matches = [
    ...tenant.filter(({ databaseId }) => databaseId === resourceId).map(({ database }) => database),
    ...fixed.filter(({ databaseId }) => databaseId === resourceId).map(({ database }) => database),
  ];
  if (matches.length !== 1) throw new Error('backup_production_export_source_unavailable');
  return { resourceId, database: matches[0] };
}

/**
 * Install the complete Phase 8 export/import surface from deployed bindings and pinned resources.
 */
export async function createProductionTenantBackupExportAdapter(
  env: Env,
  context: TenantBackupStepContext,
  now: () => number = Date.now
): Promise<TenantBackupInstalledOperationAdapter> {
  let activeContext = context;
  const currentContext = () => activeContext;
  const importing = context.operation?.kind === 'import';
  const tenantKey = importing
    ? await resolveRestoreTenantKey(env, context)
    : await resolveTenantKey(env, context);
  const saml = createTenantBackupSamlPorts(env);
  const directory = createTenantBackupDirectorySecretPorts(env);
  const assets = createTenantBackupPublicAssetPorts(env);
  const plugins = createTenantBackupPluginConfigurationPorts(env);
  const placement = createTenantBackupLogicalPlacementPorts(env);
  const keyManager = createTenantBackupKeyManagerSnapshotPort(env);
  const r2Snapshots = createTenantBackupR2ObjectSnapshotPorts({
    env,
    assertSource: async () => {},
    list: createTenantBackupR2CatalogLister({ tenantKey }),
  });
  const records: Phase5RecordSnapshotPort[] = [
    saml.saml,
    directory.directorySecrets,
    assets.publicAssets,
    assets.userAvatars,
    plugins.pluginConfiguration,
    placement.logicalPlacement,
    r2Snapshots.artifactObjects,
    r2Snapshots.logArchiveObjects,
  ];
  // Reuse the immutable installed plan within one leased slice. Export policy comes from the
  // sealed, lease-bound inventory; import still inspects the newly provisioned target schemas.
  let planned: ReturnType<typeof loadPhase8InstalledSqlitePlan> | null = null;
  const plan = () =>
    (planned ??= importing
      ? loadPhase8InstalledSqlitePlan(env, currentContext(), now)
      : resolveInstalledSqliteDatasets({
          inventory: new TenantBackupExecutionInventory(
            requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup'),
            currentContext().lease,
            now
          ),
          lease: currentContext().lease,
          registrations: PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
        }));
  let sourceAssertion: Promise<void> | null = null;
  const assertSources = () =>
    (sourceAssertion ??= (async () => {
      if ((await resolveTenantKey(env, currentContext())) !== tenantKey)
        throw new Error('backup_phase8_tenant_key_changed');
      await plan();
    })());
  const piiLog = createTenantBackupPiiLogTransformPort(env, async () => unavailable());
  const restore = importing ? createProductionTenantBackupRestoreTargets({ env, tenantKey }) : null;
  let routedResources: ReturnType<typeof resolveBackupTenantDatabaseResources> | null = null;
  const loadRoutedResources = () =>
    (routedResources ??= resolveBackupTenantDatabaseResources(env, {
      tenantId: currentContext().lease.tenantId,
      roles: ['tenant_core', 'tenant_pii'],
      signal: currentContext().signal,
    }));
  const assertInstalled = async () => {
    await plan();
    if (importing) await restore?.databaseForRole(currentContext(), 'tenant_core/default');
    else if ((await resolveTenantKey(env, currentContext())) !== tenantKey)
      throw new Error('backup_phase8_tenant_key_changed');
  };
  const installed = createPhase8TenantBackupInstalledAdapter({
    env,
    loadPlanned: plan,
    now,
    ports: {
      tenantKey,
      async allowSqliteSource(rowInput) {
        if (importing) unavailable();
        const registration = PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.find(
          ({ dataset }) => dataset.id === rowInput.datasetId
        );
        if (!registration) throw new Error('backup_phase8_source_role_missing');
        const role = phase8SqliteRestoreTargetRole(registration.dataset);
        if (role === 'admin') {
          const [admin] = resolveFixedBackupDatabaseResources(env, ['DB_ADMIN']);
          return admin?.databaseId === rowInput.resourceId;
        }
        const resource = (await loadRoutedResources()).find(
          ({ databaseId }) => databaseId === rowInput.resourceId
        );
        if (!resource) throw new Error('backup_phase8_source_role_missing');
        if (!resource.assignments.some(({ dataRole }) => dataRole === role)) return false;
        return !(await isEnvironmentLocalSystemClientRow(
          resource.database,
          rowInput.datasetId,
          rowInput.rowJson
        ));
      },
      export: {
        async prepareSources() {
          await assertSources();
          return { cursor: null, done: true };
        },
        assertSources: async () => assertSources(),
        assertBoundaryReady: async () => assertSources(),
      },
      // The same scheduler handles both kinds. Each callback remains fail closed when invoked for
      // the wrong operation kind, so an export can never acquire a restore target.
      import: {
        assertSources: async () => (importing ? assertInstalled() : unavailable()),
        planRestoreTargets: async (restoreContext, datasets) =>
          restore ? restore.plan(restoreContext, datasets) : unavailable(),
        resolveRestoreTarget: async (restoreContext, resourceId, provisioningId) =>
          restore
            ? restore.resolveTarget(restoreContext, resourceId, provisioningId)
            : unavailable(),
        async prepareActivation(restoreContext) {
          if (!restore) unavailable();
          await restore.assertUnpublished(restoreContext);
          if (!env.CONTROL?.publishTenantBackupRuntimeState) unavailable();
          await env.CONTROL.publishTenantBackupRuntimeState();
          await restore.assertUnpublished(restoreContext);
        },
        async activate(restoreContext) {
          if (!restore) unavailable();
          await restore.assertUnpublished(restoreContext);
          await activateProvisionedTenantLifecycle({
            platformAdapter: restore.platform,
            tenantAdapter: await restore.databaseForRole(restoreContext, 'tenant_core/default'),
            tenantId: restoreContext.lease.tenantId,
            now: Math.floor(now() / 1000),
          });
          await putTenantExistsCache(env.AUTHRIM_CONFIG, restoreContext.lease.tenantId);
          await resolveActiveTenantRuntimeRouteObservation(env, restoreContext.lease.tenantId);
        },
        async verifyActivation(restoreContext) {
          if (!restore) unavailable();
          const [platformRow, tenantRow] = await Promise.all([
            restore.platform.queryOne<{ lifecycle_state: string }>(
              'SELECT lifecycle_state FROM tenants WHERE id=?',
              [restoreContext.lease.tenantId]
            ),
            restore
              .databaseForRole(restoreContext, 'tenant_core/default')
              .then((database) =>
                database.queryOne<{ lifecycle_state: string }>(
                  'SELECT lifecycle_state FROM tenants WHERE id=?',
                  [restoreContext.lease.tenantId]
                )
              ),
          ]);
          if (platformRow?.lifecycle_state !== 'active' || tenantRow?.lifecycle_state !== 'active')
            unavailable();
          await resolveActiveTenantRuntimeRouteObservation(env, restoreContext.lease.tenantId);
        },
        assertUnpublishedTarget: async (restoreContext) =>
          restore ? restore.assertUnpublished(restoreContext) : unavailable(),
      } as Phase8InstalledAdapterPorts['import'],
      otherStores: (importing
        ? {
            phase4: {
              importKeyManager: (value, snapshot) => keyManager.importKeyManager(value, snapshot),
              verifyKeyManager: (value, snapshot) => keyManager.verifyKeyManager(value, snapshot),
              validateSamlBundle: (bundle, tenantId) => saml.validateSamlBundle(bundle, tenantId),
              importSamlBundle: (value, bundle) => saml.importSamlBundle(value, bundle),
              verifySamlBundle: (value, bundle) => saml.verifySamlBundle(value, bundle),
              importDirectorySecret: (value, connectorId, secret) =>
                directory.importDirectorySecret(value, connectorId, secret),
              verifyDirectorySecret: (value, connectorId, secret) =>
                directory.verifyDirectorySecret(value, connectorId, secret),
            },
            importAsset: (value, asset) => assets.importAsset(value, asset),
            verifyAsset: (value, asset) => assets.verifyAsset(value, asset),
            importPlugin: (value, plugin) => plugins.importPlugin(value, plugin),
            verifyPlugin: (value, plugin) => plugins.verifyPlugin(value, plugin),
            prepareLogicalTarget: (value, targetPlan) =>
              placement.prepareLogicalTarget(value, targetPlan),
            verifyLogicalTarget: (value, targetPlan) =>
              placement.verifyLogicalTarget(value, targetPlan),
            restorePhase8Envelope: async () => unavailable(),
            verifyPhase8Envelope: async () => false,
          }
        : {}) as Phase8InstalledAdapterPorts['otherStores'],
      rowTransform: {
        loadExternalPiiLogValues: (input, reference) =>
          piiLog.loadExternalPiiLogValues(input, reference),
      },
      keyManagerSnapshot: keyManager,
      recordSnapshots: {
        validateSamlBundle: saml.validateSamlBundle,
        validatePhase8Envelope,
        assertPluginSupported: (configuration) => plugins.assertPluginSupported(configuration),
        saml: saml.saml,
        directorySecrets: directory.directorySecrets,
        publicAssets: assets.publicAssets,
        userAvatars: assets.userAvatars,
        pluginConfiguration: plugins.pluginConfiguration,
        logicalPlacement: placement.logicalPlacement,
      },
      cleanup: {
        resolveSnapshotSource: (resourceId) =>
          resolveRecordedDatabase(env, currentContext(), resourceId),
        async cleanupRestoreTarget() {
          unavailable();
        },
        async cleanupAdditionalPage(cleanupContext) {
          if (importing) return { done: true };
          const inventoryDigest = await loadCancellationInventoryDigest(env, cleanupContext, now);
          const adapterContext = { context: cleanupContext } as never;
          await keyManager.release(
            adapterContext,
            await tenantBackupRecordSnapshotIdForInventory(
              cleanupContext.lease.tenantId,
              cleanupContext.lease.operationId,
              inventoryDigest,
              TENANT_BACKUP_KEY_MANAGER_RESOURCE_ID
            )
          );
          for (const record of records)
            await record.release(
              adapterContext,
              await tenantBackupRecordSnapshotIdForInventory(
                cleanupContext.lease.tenantId,
                cleanupContext.lease.operationId,
                inventoryDigest,
                record.resourceId
              )
            );
          return { done: true };
        },
        async assertClean(cleanupContext) {
          if (importing) return;
          const inventoryDigest = await loadCancellationInventoryDigest(env, cleanupContext, now);
          const adapterContext = { context: cleanupContext } as never;
          await keyManager.assertReleased(
            adapterContext,
            await tenantBackupRecordSnapshotIdForInventory(
              cleanupContext.lease.tenantId,
              cleanupContext.lease.operationId,
              inventoryDigest,
              TENANT_BACKUP_KEY_MANAGER_RESOURCE_ID
            )
          );
          for (const record of records)
            await record.assertReleased(
              adapterContext,
              await tenantBackupRecordSnapshotIdForInventory(
                cleanupContext.lease.tenantId,
                cleanupContext.lease.operationId,
                inventoryDigest,
                record.resourceId
              )
            );
        },
      },
      resolveAdminRestoreDatabase: async (restoreContext) =>
        restore?.databaseForRole(restoreContext, 'admin') ?? unavailable(),
      resolveCoreRestoreDatabase: async (restoreContext) =>
        restore?.databaseForRole(restoreContext, 'tenant_core/default') ?? unavailable(),
      resolveAdminR2RestoreDatabase: async (restoreContext) =>
        restore?.databaseForRole(restoreContext, 'admin') ?? unavailable(),
      resolveCoreR2RestoreDatabase: async (restoreContext) =>
        restore?.databaseForRole(restoreContext, 'tenant_core/default') ?? unavailable(),
      loadExternalPrerequisites: async () => (importing ? [] : unavailable()),
      loadDeliverySafety: async () =>
        importing
          ? {
              version: 1,
              sourceEnvironment: 'stopped',
              historicalDelivery: 'hold',
              scheduledCatchup: 'disabled',
              activation: 'new_events_only',
            }
          : unavailable(),
    },
  });
  return {
    ...installed,
    bindContext(next) {
      if (
        next.operation.kind !== activeContext.operation.kind ||
        next.lease.operationId !== activeContext.lease.operationId ||
        next.lease.tenantId !== activeContext.lease.tenantId ||
        next.lease.owner !== activeContext.lease.owner ||
        next.lease.fencingToken !== activeContext.lease.fencingToken
      )
        throw new Error('backup_production_adapter_context_changed');
      activeContext = next;
    },
  };
}
