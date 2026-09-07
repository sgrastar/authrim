import {
  ensureDatabaseAdapter,
  InternalNotificationEventRepository,
  isWithinTenantDatabaseProvisioningGracePeriod,
  readResponseTextWithLimit,
  reconcileTenantDatabaseDerivedBindings,
  safeFetch,
  TenantDatabaseRegistryRepository,
  type Env,
  type TenantDatabaseDerivedBindingManifestEntry,
  type TenantDatabaseReconciliationFinding,
  type TenantDatabaseReconciliationFindingType,
  type TenantDatabaseRegistryRow,
  type TenantDatabaseRole,
} from '@authrim/ar-lib-core';

export interface TenantDatabaseReconciliationRefreshSummary {
  checked: number;
  findings: number;
  critical: number;
  warning: number;
  resolved: number;
  skippedCloudflareApi: boolean;
}

export interface TenantDatabaseReconciliationJobSummary {
  scanned: number;
  completed: number;
  failed: number;
}

interface TenantDatabaseReconciliationLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export interface TenantDatabaseReconciliationRefreshOptions {
  roles?: TenantDatabaseRole[];
  tenantId?: string;
  limitPerRole?: number;
  now?: Date;
  cloudflareDatabaseIds?: Set<string>;
}

interface CloudflareD1ListResponse {
  success?: boolean;
  result?: Array<{ uuid?: string | null; id?: string | null }>;
  result_info?: {
    page?: number;
    total_pages?: number;
  };
  errors?: Array<{ message?: string }>;
}

const DEFAULT_RECONCILIATION_ROLES: TenantDatabaseRole[] = ['tenant_core', 'tenant_pii'];
const DEFAULT_RECONCILIATION_LIMIT_PER_ROLE = 500;
const DEFAULT_RECONCILIATION_JOB_LIMIT = 5;
const TENANT_DATABASE_RECONCILIATION_JOB_TYPE = 'tenant-database/reconciliation';
const D1_LIST_RESPONSE_LIMIT_BYTES = 256 * 1024;
const D1_LIST_PAGE_LIMIT = 20;
const RECONCILIATION_FINDING_TYPES: TenantDatabaseReconciliationFindingType[] = [
  'missing_binding',
  'database_id_not_found',
  'inactive_registry_row',
];

function getCloudflareAccountId(env: Env): string | null {
  return env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID || null;
}

function getCloudflareD1ApiToken(env: Env): string | null {
  return env.CLOUDFLARE_D1_API_TOKEN || env.CLOUDFLARE_API_TOKEN || null;
}

export async function fetchCloudflareD1DatabaseIds(env: Env): Promise<Set<string> | null> {
  const accountId = getCloudflareAccountId(env);
  const token = getCloudflareD1ApiToken(env);
  if (!accountId || !token) {
    return null;
  }

  const ids = new Set<string>();
  for (let page = 1; page <= D1_LIST_PAGE_LIMIT; page += 1) {
    const response = await safeFetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?per_page=100&page=${page}`,
      {
        method: 'GET',
        maxResponseSize: D1_LIST_RESPONSE_LIMIT_BYTES,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const body = (JSON.parse(
      await readResponseTextWithLimit(response, D1_LIST_RESPONSE_LIMIT_BYTES)
    ) ?? null) as CloudflareD1ListResponse | null;

    if (!response.ok || !body?.success) {
      const message = body?.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join('; ');
      throw new Error(message || `cloudflare_d1_list_failed:${response.status}`);
    }

    for (const database of body.result ?? []) {
      const id = database.uuid ?? database.id;
      if (id) ids.add(id);
    }

    const totalPages = body.result_info?.total_pages ?? page;
    if (page >= totalPages) break;
  }

  return ids;
}

async function listRowsForReconciliation(
  repository: TenantDatabaseRegistryRepository,
  roles: TenantDatabaseRole[],
  limitPerRole: number,
  tenantId?: string
): Promise<TenantDatabaseRegistryRow[]> {
  const rows: TenantDatabaseRegistryRow[] = [];
  for (const role of roles) {
    if (tenantId) {
      rows.push(...(await repository.listActiveRegistryRowsForTenantRole(tenantId, role)));
      continue;
    }

    for (let offset = 0; ; offset += limitPerRole) {
      const page = await repository.listActiveRegistryRowsForRole(role, limitPerRole, offset);
      rows.push(...page);
      if (page.length < limitPerRole) {
        break;
      }
    }
  }
  return rows;
}

function findingDeduplicationKey(finding: TenantDatabaseReconciliationFinding): string {
  return [
    'tenant_database_reconciliation',
    finding.type,
    finding.entry.tenantId,
    finding.entry.role,
    finding.entry.generation,
    finding.entry.shardGroup,
    finding.entry.shardIndex,
    finding.entry.bindingRef ?? '',
    finding.entry.databaseId ?? '',
  ].join(':');
}

function toManifestEntry(
  row: TenantDatabaseRegistryRow
): TenantDatabaseDerivedBindingManifestEntry {
  return {
    tenantId: row.tenant_id,
    role: row.role,
    generation: row.generation,
    shardGroup: row.shard_group,
    shardIndex: row.shard_index,
    bindingRef: row.binding_ref,
    databaseId: row.database_id,
    databaseName: row.database_name,
    workerShard: row.worker_shard,
    deploymentTarget: row.deployment_target,
    derivedFrom: 'tenant_database_registry',
  };
}

function findingIdentity(entry: TenantDatabaseDerivedBindingManifestEntry): string {
  return [entry.tenantId, entry.role, entry.generation, entry.shardGroup, entry.shardIndex].join(
    ':'
  );
}

function resolverMissingBindingDeduplicationKey(
  entry: TenantDatabaseDerivedBindingManifestEntry
): string {
  return [
    'tenant_database_resolver',
    'missing_binding',
    entry.tenantId,
    entry.role,
    entry.generation,
    entry.shardGroup,
    entry.shardIndex,
    entry.bindingRef ?? '',
    '',
  ].join(':');
}

function resolvedFindingDeduplicationKeys(input: {
  rows: TenantDatabaseRegistryRow[];
  findings: TenantDatabaseReconciliationFinding[];
  cloudflareDatabaseIdsAvailable: boolean;
}): string[] {
  const activeFindings = new Map<string, Set<TenantDatabaseReconciliationFindingType>>();
  for (const finding of input.findings) {
    const identity = findingIdentity(finding.entry);
    const types =
      activeFindings.get(identity) ?? new Set<TenantDatabaseReconciliationFindingType>();
    types.add(finding.type);
    activeFindings.set(identity, types);
  }

  const keys: string[] = [];
  for (const row of input.rows) {
    const entry = toManifestEntry(row);
    const activeTypes = activeFindings.get(findingIdentity(entry)) ?? new Set();
    for (const type of RECONCILIATION_FINDING_TYPES) {
      if (type === 'database_id_not_found' && !input.cloudflareDatabaseIdsAvailable) {
        continue;
      }
      if (activeTypes.has(type)) {
        continue;
      }
      keys.push(findingDeduplicationKey({ type, severity: 'warning', entry }));
      if (type === 'missing_binding') {
        keys.push(resolverMissingBindingDeduplicationKey(entry));
      }
    }
  }
  return keys;
}

async function enqueueFindingNotification(
  repository: InternalNotificationEventRepository,
  logger: TenantDatabaseReconciliationLogger,
  finding: TenantDatabaseReconciliationFinding,
  now: Date
): Promise<void> {
  try {
    await repository.enqueue({
      tenantId: finding.entry.tenantId,
      category: 'storage_registry_health',
      eventType: `tenant_database.reconciliation.${finding.type}`,
      severity: finding.severity === 'critical' ? 'critical' : 'medium',
      deduplicationKey: findingDeduplicationKey(finding),
      reopenSuppressed: true,
      payload: {
        finding_type: finding.type,
        severity: finding.severity,
        tenant_id: finding.entry.tenantId,
        role: finding.entry.role,
        generation: finding.entry.generation,
        shard_group: finding.entry.shardGroup,
        shard_index: finding.entry.shardIndex,
        binding_ref: finding.entry.bindingRef,
        database_id: finding.entry.databaseId,
        database_name: finding.entry.databaseName,
        worker_shard: finding.entry.workerShard,
        deployment_target: finding.entry.deploymentTarget,
        checked_at: now.toISOString(),
      },
      now,
    });
  } catch (error) {
    logger.warn('Tenant database reconciliation notification enqueue failed', {
      tenant_id: finding.entry.tenantId,
      finding_type: finding.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function refreshTenantDatabaseReconciliation(
  env: Env,
  logger: TenantDatabaseReconciliationLogger,
  options: TenantDatabaseReconciliationRefreshOptions = {}
): Promise<TenantDatabaseReconciliationRefreshSummary> {
  const summary: TenantDatabaseReconciliationRefreshSummary = {
    checked: 0,
    findings: 0,
    critical: 0,
    warning: 0,
    resolved: 0,
    skippedCloudflareApi: false,
  };
  if (!env.DB_ADMIN) {
    logger.warn('Tenant database reconciliation skipped because DB_ADMIN is not configured');
    return summary;
  }

  const controlAdapter = ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-database-reconciliation');
  const registryRepository = new TenantDatabaseRegistryRepository(controlAdapter);
  const notificationRepository = new InternalNotificationEventRepository(controlAdapter);
  const rows = await listRowsForReconciliation(
    registryRepository,
    options.roles ?? DEFAULT_RECONCILIATION_ROLES,
    options.limitPerRole ?? DEFAULT_RECONCILIATION_LIMIT_PER_ROLE,
    options.tenantId
  );

  let cloudflareDatabaseIds = options.cloudflareDatabaseIds;
  if (!cloudflareDatabaseIds) {
    try {
      cloudflareDatabaseIds = (await fetchCloudflareD1DatabaseIds(env)) ?? undefined;
    } catch (error) {
      summary.skippedCloudflareApi = true;
      logger.warn('Tenant database reconciliation Cloudflare D1 list skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!cloudflareDatabaseIds) {
    summary.skippedCloudflareApi = true;
  }

  const result = reconcileTenantDatabaseDerivedBindings({
    env: env as unknown as Record<string, unknown>,
    rows,
    cloudflareDatabaseIds,
  });
  result.findings = result.findings.filter((finding) => {
    if (finding.type !== 'missing_binding') return true;
    const row = rows.find(
      (candidate) => findingIdentity(toManifestEntry(candidate)) === findingIdentity(finding.entry)
    );
    return !isWithinTenantDatabaseProvisioningGracePeriod(row?.created_at, options.now);
  });
  summary.checked = result.checked;
  summary.findings = result.findings.length;
  summary.critical = result.findings.filter((finding) => finding.severity === 'critical').length;
  summary.warning = result.findings.length - summary.critical;

  const now = options.now ?? new Date();
  for (const finding of result.findings) {
    await enqueueFindingNotification(notificationRepository, logger, finding, now);
  }
  summary.resolved = await notificationRepository.suppressResolvedByDeduplicationKeys(
    resolvedFindingDeduplicationKeys({
      rows,
      findings: result.findings,
      cloudflareDatabaseIdsAvailable: Boolean(cloudflareDatabaseIds),
    }),
    now
  );

  if (result.findings.length > 0) {
    logger.warn('Tenant database reconciliation detected drift', { ...summary });
  } else {
    logger.info('Tenant database reconciliation completed', { ...summary });
  }

  return summary;
}

export async function processPendingTenantDatabaseReconciliationJobs(
  env: Env,
  logger: TenantDatabaseReconciliationLogger,
  options: { limit?: number; now?: number } = {}
): Promise<TenantDatabaseReconciliationJobSummary> {
  const summary: TenantDatabaseReconciliationJobSummary = {
    scanned: 0,
    completed: 0,
    failed: 0,
  };
  if (!env.DB_ADMIN) {
    logger.warn('Tenant database reconciliation jobs skipped because DB_ADMIN is not configured');
    return summary;
  }

  const adapter = ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-database-reconciliation-jobs');
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const jobs = await adapter.query<{
    id: string;
    tenant_id: string;
    status: string;
    config: string | null;
  }>(
    `SELECT id, tenant_id, status, config
       FROM admin_jobs
      WHERE job_type = ?
        AND status IN ('pending', 'processing')
        AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?`,
    [
      TENANT_DATABASE_RECONCILIATION_JOB_TYPE,
      now,
      options.limit ?? DEFAULT_RECONCILIATION_JOB_LIMIT,
    ]
  );
  summary.scanned = jobs.length;

  for (const job of jobs) {
    const startedAt = Math.floor(Date.now() / 1000);
    if (job.status === 'pending') {
      const claimed = await adapter.execute(
        "UPDATE admin_jobs SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
        [startedAt, startedAt, job.id, job.tenant_id]
      );
      if ((claimed.rowsAffected ?? 0) === 0) {
        continue;
      }
    }

    try {
      const result = await refreshTenantDatabaseReconciliation(env, logger, {
        tenantId: job.tenant_id,
      });
      await adapter.execute(
        "UPDATE admin_jobs SET status = 'completed', progress = ?, result = ?, completed_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
        [
          JSON.stringify({
            total: result.checked,
            processed: result.checked,
            succeeded: result.checked - result.critical,
            failed: result.critical,
            stage: 'completed',
          }),
          JSON.stringify(result),
          startedAt,
          startedAt,
          job.id,
          job.tenant_id,
        ]
      );
      summary.completed += 1;
    } catch (error) {
      await adapter.execute(
        "UPDATE admin_jobs SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
        [
          error instanceof Error ? error.message : String(error),
          startedAt,
          startedAt,
          job.id,
          job.tenant_id,
        ]
      );
      summary.failed += 1;
      logger.warn('Tenant database reconciliation job failed', {
        job_id: job.id,
        tenant_id: job.tenant_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (summary.scanned > 0) {
    logger.info('Tenant database reconciliation jobs completed', { ...summary });
  }
  return summary;
}
