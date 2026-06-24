import type { DatabaseAdapter } from '../db/adapter';

export type DirectoryConnectorFleetStatus =
  | 'connected'
  | 'disconnected'
  | 'stale'
  | 'version_mismatch'
  | 'unhealthy'
  | 'deactivated';

export type DirectoryConnectorDriftSeverity = 'none' | 'warning' | 'critical';

export interface DirectoryConnectorHeartbeatInput {
  tenantId: string;
  connectorId: string;
  instanceId: string;
  displayName?: string | null;
  transport: 'relay' | 'direct' | 'tunnel';
  version: string;
  startedAt: string;
  healthStatus: 'healthy' | 'degraded' | 'unhealthy';
  healthSummary?: Record<string, unknown>;
  configFingerprint: string;
  configCategories?: string[];
  driftSeverity?: DirectoryConnectorDriftSeverity;
  now?: number;
}

export interface DirectoryConnectorInstanceRow {
  id: string;
  tenant_id: string;
  connector_id: string;
  instance_id: string;
  display_name: string | null;
  transport: string;
  version: string;
  started_at: string;
  first_seen_at: number;
  last_seen_at: number;
  status: DirectoryConnectorFleetStatus;
  health_status: string;
  health_summary_json: string;
  config_fingerprint: string;
  config_categories_json: string;
  drift_severity: DirectoryConnectorDriftSeverity;
  deactivated_at: number | null;
  deactivated_by: string | null;
  deactivation_reason: string | null;
  updated_at: number;
}

export interface DirectoryConnectorStatusEpisodeRow {
  id: string;
  tenant_id: string;
  connector_id: string;
  instance_id: string;
  status: DirectoryConnectorFleetStatus;
  started_at: number;
  ended_at: number | null;
  last_seen_at: number;
  reason: string | null;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface DirectoryConnectorFleetRecordInput {
  tenantId: string;
  connectorId: string;
  instanceId: string;
  status: DirectoryConnectorFleetStatus;
  reason?: string | null;
  actorId?: string | null;
  now?: number;
}

const MAX_JSON_BYTES = 16 * 1024;

export async function recordDirectoryConnectorHeartbeat(
  adapter: DatabaseAdapter,
  input: DirectoryConnectorHeartbeatInput
): Promise<{ accepted: boolean; status: DirectoryConnectorFleetStatus; reason?: string }> {
  const now = input.now ?? Date.now();
  const existing = await getDirectoryConnectorInstance(
    adapter,
    input.tenantId,
    input.connectorId,
    input.instanceId
  );
  if (existing?.deactivated_at) {
    await ensureDirectoryConnectorEpisode(adapter, {
      tenantId: input.tenantId,
      connectorId: input.connectorId,
      instanceId: input.instanceId,
      status: 'deactivated',
      reason: 'instance_deactivated',
      now,
    });
    return { accepted: false, status: 'deactivated', reason: 'instance_deactivated' };
  }

  const status: DirectoryConnectorFleetStatus =
    input.healthStatus === 'unhealthy' || input.healthStatus === 'degraded'
      ? 'unhealthy'
      : 'connected';
  const instanceId = `dcinst_${crypto.randomUUID()}`;
  const firstSeenAt = existing?.first_seen_at ?? now;
  await adapter.execute(
    `INSERT INTO directory_connector_instances (
       id, tenant_id, connector_id, instance_id, display_name, transport, version,
       started_at, first_seen_at, last_seen_at, status, health_status,
       health_summary_json, config_fingerprint, config_categories_json, drift_severity,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, connector_id, instance_id) DO UPDATE SET
       display_name = excluded.display_name,
       transport = excluded.transport,
       version = excluded.version,
       started_at = excluded.started_at,
       last_seen_at = excluded.last_seen_at,
       status = excluded.status,
       health_status = excluded.health_status,
       health_summary_json = excluded.health_summary_json,
       config_fingerprint = excluded.config_fingerprint,
       config_categories_json = excluded.config_categories_json,
       drift_severity = excluded.drift_severity,
       updated_at = excluded.updated_at`,
    [
      instanceId,
      input.tenantId,
      input.connectorId,
      input.instanceId,
      input.displayName?.trim() || null,
      input.transport,
      input.version,
      input.startedAt,
      firstSeenAt,
      now,
      status,
      input.healthStatus,
      boundedJson(input.healthSummary ?? {}),
      input.configFingerprint,
      boundedJson(input.configCategories ?? []),
      input.driftSeverity ?? 'none',
      now,
    ]
  );
  await ensureDirectoryConnectorEpisode(adapter, {
    tenantId: input.tenantId,
    connectorId: input.connectorId,
    instanceId: input.instanceId,
    status,
    reason: input.healthStatus === 'healthy' ? null : input.healthStatus,
    now,
  });
  return { accepted: true, status };
}

export async function markDirectoryConnectorInstanceStatus(
  adapter: DatabaseAdapter,
  input: DirectoryConnectorFleetRecordInput
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const result = await adapter.execute(
    `UPDATE directory_connector_instances
        SET status = ?,
            last_seen_at = ?,
            updated_at = ?,
            deactivated_at = CASE WHEN ? = 'deactivated' THEN ? ELSE deactivated_at END,
            deactivated_by = CASE WHEN ? = 'deactivated' THEN ? ELSE deactivated_by END,
            deactivation_reason = CASE WHEN ? = 'deactivated' THEN ? ELSE deactivation_reason END
      WHERE tenant_id = ? AND connector_id = ? AND instance_id = ?`,
    [
      input.status,
      now,
      now,
      input.status,
      now,
      input.status,
      input.actorId ?? null,
      input.status,
      input.reason ?? null,
      input.tenantId,
      input.connectorId,
      input.instanceId,
    ]
  );
  if (result.rowsAffected !== 1) return false;
  await ensureDirectoryConnectorEpisode(adapter, { ...input, now });
  return true;
}

export async function reactivateDirectoryConnectorInstance(
  adapter: DatabaseAdapter,
  input: Omit<DirectoryConnectorFleetRecordInput, 'status'>
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const result = await adapter.execute(
    `UPDATE directory_connector_instances
        SET status = 'disconnected',
            deactivated_at = NULL,
            deactivated_by = NULL,
            deactivation_reason = NULL,
            updated_at = ?
      WHERE tenant_id = ? AND connector_id = ? AND instance_id = ?`,
    [now, input.tenantId, input.connectorId, input.instanceId]
  );
  if (result.rowsAffected !== 1) return false;
  await ensureDirectoryConnectorEpisode(adapter, {
    ...input,
    status: 'disconnected',
    reason: input.reason ?? 'reactivated',
    now,
  });
  return true;
}

export async function acknowledgeDirectoryConnectorEpisode(
  adapter: DatabaseAdapter,
  input: Omit<DirectoryConnectorFleetRecordInput, 'status'>
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const result = await adapter.execute(
    `UPDATE directory_connector_status_episodes
        SET acknowledged_at = ?,
            acknowledged_by = ?,
            updated_at = ?
      WHERE tenant_id = ? AND connector_id = ? AND instance_id = ? AND ended_at IS NULL`,
    [now, input.actorId ?? null, now, input.tenantId, input.connectorId, input.instanceId]
  );
  return result.rowsAffected === 1;
}

export async function listDirectoryConnectorInstances(
  adapter: DatabaseAdapter,
  tenantId: string,
  connectorId?: string
): Promise<DirectoryConnectorInstanceRow[]> {
  const params: unknown[] = [tenantId];
  const connectorClause = connectorId ? 'AND connector_id = ?' : '';
  if (connectorId) params.push(connectorId);
  return adapter.query<DirectoryConnectorInstanceRow>(
    `SELECT id, tenant_id, connector_id, instance_id, display_name, transport, version,
            started_at, first_seen_at, last_seen_at, status, health_status,
            health_summary_json, config_fingerprint, config_categories_json, drift_severity,
            deactivated_at, deactivated_by, deactivation_reason, updated_at
       FROM directory_connector_instances
      WHERE tenant_id = ?
        ${connectorClause}
      ORDER BY connector_id ASC, last_seen_at DESC`,
    params
  );
}

export async function listDirectoryConnectorEpisodes(
  adapter: DatabaseAdapter,
  tenantId: string,
  connectorId?: string,
  options: { limit?: number; retentionDays?: number; now?: number } = {}
): Promise<DirectoryConnectorStatusEpisodeRow[]> {
  const params: unknown[] = [tenantId];
  const connectorClause = connectorId ? 'AND connector_id = ?' : '';
  if (connectorId) params.push(connectorId);
  const retentionDays = Math.max(1, Math.min(options.retentionDays ?? 14, 90));
  const cutoff = (options.now ?? Date.now()) - retentionDays * 24 * 60 * 60 * 1000;
  params.push(cutoff);
  params.push(options.limit ?? 100);
  return adapter.query<DirectoryConnectorStatusEpisodeRow>(
    `SELECT id, tenant_id, connector_id, instance_id, status, started_at, ended_at,
            last_seen_at, reason, acknowledged_at, acknowledged_by, created_at, updated_at
       FROM directory_connector_status_episodes
      WHERE tenant_id = ?
        ${connectorClause}
        AND started_at >= ?
      ORDER BY started_at DESC
      LIMIT ?`,
    params
  );
}

async function getDirectoryConnectorInstance(
  adapter: DatabaseAdapter,
  tenantId: string,
  connectorId: string,
  instanceId: string
): Promise<DirectoryConnectorInstanceRow | null> {
  return adapter.queryOne<DirectoryConnectorInstanceRow>(
    `SELECT id, tenant_id, connector_id, instance_id, display_name, transport, version,
            started_at, first_seen_at, last_seen_at, status, health_status,
            health_summary_json, config_fingerprint, config_categories_json, drift_severity,
            deactivated_at, deactivated_by, deactivation_reason, updated_at
       FROM directory_connector_instances
      WHERE tenant_id = ? AND connector_id = ? AND instance_id = ?`,
    [tenantId, connectorId, instanceId]
  );
}

async function ensureDirectoryConnectorEpisode(
  adapter: DatabaseAdapter,
  input: DirectoryConnectorFleetRecordInput
): Promise<void> {
  const now = input.now ?? Date.now();
  const current = await adapter.queryOne<DirectoryConnectorStatusEpisodeRow>(
    `SELECT id, tenant_id, connector_id, instance_id, status, started_at, ended_at,
            last_seen_at, reason, acknowledged_at, acknowledged_by, created_at, updated_at
       FROM directory_connector_status_episodes
      WHERE tenant_id = ? AND connector_id = ? AND instance_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1`,
    [input.tenantId, input.connectorId, input.instanceId]
  );
  if (current?.status === input.status) {
    await adapter.execute(
      `UPDATE directory_connector_status_episodes
          SET last_seen_at = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
      [now, now, input.tenantId, current.id]
    );
    return;
  }
  if (current) {
    await adapter.execute(
      `UPDATE directory_connector_status_episodes
          SET ended_at = ?, last_seen_at = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
      [now, now, now, input.tenantId, current.id]
    );
  }
  await adapter.execute(
    `INSERT INTO directory_connector_status_episodes (
       id, tenant_id, connector_id, instance_id, status, started_at, ended_at,
       last_seen_at, reason, acknowledged_at, acknowledged_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?)`,
    [
      `dcepi_${crypto.randomUUID()}`,
      input.tenantId,
      input.connectorId,
      input.instanceId,
      input.status,
      now,
      now,
      input.reason ?? null,
      now,
      now,
    ]
  );
}

function boundedJson(value: unknown): string {
  const json = JSON.stringify(value);
  return new TextEncoder().encode(json).byteLength <= MAX_JSON_BYTES ? json : '{}';
}
