import { managedPluginResourceName } from '@authrim/ar-lib-core/control-plane';
import type { D1Database } from '@cloudflare/workers-types';
import type {
  ControlD1ApiClient,
  ControlKvApiClient,
  ControlR2ApiClient,
} from './control-api-clients';

const SHA256 = /^[a-f0-9]{64}$/u;
const LEASE_SECONDS = 60;

interface ResourceRow {
  plugin_resource_id: string;
  environment_id: string;
  operation_id: string;
  plugin_installation_id: string;
  tenant_id: string;
  resource_kind: 'd1' | 'kv_namespace' | 'r2_bucket';
  logical_resource_id: string;
  lifecycle_mode: 'managed' | 'existing';
  provider_resource_id: string | null;
  provider_name: string | null;
  desired_spec_json: string;
  status: 'pending' | 'provisioning';
  operation_status: 'queued' | 'running' | 'waiting_retry';
  next_attempt_at: number | null;
}

interface ClaimedOperation {
  fencing_token: number;
  attempt_count: number;
}

interface DesiredSpec {
  ownershipFingerprint: string;
  ownership: 'authrim_managed' | 'external_reference';
  deleteProviderResource: boolean;
}

interface ProviderIdentity {
  id: string;
  name: string;
}

export interface PluginResourceReconcilerClients {
  d1: ControlD1ApiClient;
  kv: ControlKvApiClient;
  r2: ControlR2ApiClient;
}

function parseDesiredSpec(row: ResourceRow): DesiredSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.desired_spec_json);
  } catch {
    throw new Error('plugin_resource_desired_spec_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('plugin_resource_desired_spec_invalid');
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.ownershipFingerprint !== 'string' ||
    !SHA256.test(value.ownershipFingerprint) ||
    !['authrim_managed', 'external_reference'].includes(String(value.ownership)) ||
    typeof value.deleteProviderResource !== 'boolean' ||
    (row.lifecycle_mode === 'managed') !== (value.ownership === 'authrim_managed') ||
    (row.lifecycle_mode === 'managed') !== value.deleteProviderResource
  ) {
    throw new Error('plugin_resource_desired_spec_invalid');
  }
  return value as unknown as DesiredSpec;
}

export { managedPluginResourceName } from '@authrim/ar-lib-core/control-plane';

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const status = (error as { status?: unknown }).status;
  return Number.isSafeInteger(status) ? (status as number) : null;
}

function failure(error: unknown): { code: string; permanent: boolean } {
  const message = error instanceof Error ? error.message : '';
  const status = errorStatus(error);
  if (
    status === 401 ||
    status === 403 ||
    (message.startsWith('cloudflare_') && message.includes('_token_required_for:'))
  ) {
    return { code: 'operator_action_required', permanent: true };
  }
  if (
    message.startsWith('plugin_resource_') ||
    (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429)
  ) {
    return {
      code: message.startsWith('plugin_resource_')
        ? message
        : 'plugin_resource_provider_request_rejected',
      permanent: true,
    };
  }
  return { code: 'plugin_resource_provider_request_failed', permanent: false };
}

function retryDelay(attemptCount: number): number {
  return Math.min(900, 30 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 5));
}

export class PluginResourceReconciler {
  constructor(
    private readonly database: D1Database,
    private readonly clients: PluginResourceReconcilerClients,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000)
  ) {}

  async reconcile(limit = 10): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(25, Math.floor(limit)));
    const now = this.now();
    const candidates = await this.database
      .prepare(
        `SELECT resource.plugin_resource_id, resource.environment_id, resource.operation_id,
                resource.plugin_installation_id, resource.tenant_id, resource.resource_kind,
                resource.logical_resource_id, resource.lifecycle_mode,
                resource.provider_resource_id, resource.provider_name,
                resource.desired_spec_json, resource.status,
                operation.status AS operation_status, operation.next_attempt_at
           FROM control_plugin_desired_resources AS resource
           JOIN control_operations AS operation
             ON operation.operation_id = resource.operation_id
            AND operation.environment_id = resource.environment_id
          WHERE resource.status IN ('pending', 'provisioning')
            AND operation.status IN ('queued', 'running', 'waiting_retry')
            AND (operation.next_attempt_at IS NULL OR operation.next_attempt_at <= ?)
          ORDER BY operation.created_at, resource.plugin_resource_id
          LIMIT ?`
      )
      .bind(now, boundedLimit)
      .all<ResourceRow>();
    let processed = 0;
    for (const row of candidates.results) {
      if (!(await this.reconcileOne(row))) continue;
      processed += 1;
    }
    return processed;
  }

  private async reconcileOne(row: ResourceRow): Promise<boolean> {
    const now = this.now();
    const claimed = await this.database
      .prepare(
        `UPDATE control_operations
            SET status = 'running', lock_owner = 'plugin-resource-reconciler',
                lock_expires_at = ?, fencing_token = fencing_token + 1,
                attempt_count = attempt_count + 1, next_attempt_at = NULL,
                started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE operation_id = ? AND environment_id = ?
            AND status IN ('queued', 'running', 'waiting_retry')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND (lock_owner IS NULL OR lock_expires_at IS NULL OR lock_expires_at <= ?)
          RETURNING fencing_token, attempt_count`
      )
      .bind(now + LEASE_SECONDS, now, now, row.operation_id, row.environment_id, now, now)
      .first<ClaimedOperation>();
    if (!claimed) return false;

    const current = await this.database
      .prepare(
        `SELECT status FROM control_plugin_desired_resources
          WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?`
      )
      .bind(row.plugin_resource_id, row.environment_id, row.operation_id)
      .first<{ status: string }>();
    if (!current || (current.status !== 'pending' && current.status !== 'provisioning')) {
      await this.database
        .prepare(
          `UPDATE control_operations
              SET lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND lock_owner = 'plugin-resource-reconciler' AND fencing_token = ?`
        )
        .bind(now, row.operation_id, row.environment_id, claimed.fencing_token)
        .run();
      return false;
    }

    let desired: DesiredSpec;
    try {
      desired = parseDesiredSpec(row);
    } catch (error) {
      await this.recordFailure(row, claimed, error);
      return true;
    }
    const stepKey = `plugin_resource_${desired.ownershipFingerprint.slice(0, 20)}_provider`;
    await this.database
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'running', attempt_count = attempt_count + 1,
                started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE operation_id = ? AND step_key = ? AND status IN ('queued', 'waiting_retry')`
      )
      .bind(now, now, row.operation_id, stepKey)
      .run();

    try {
      const identity = await this.ensureProviderResource(row, desired);
      await this.assertUnclaimed(row, identity);
      await this.recordSuccess(row, claimed, stepKey, identity);
    } catch (error) {
      await this.recordFailure(row, claimed, error, stepKey);
    }
    return true;
  }

  private async ensureProviderResource(
    row: ResourceRow,
    desired: DesiredSpec
  ): Promise<ProviderIdentity> {
    if (row.lifecycle_mode === 'existing') return this.verifyExisting(row);
    const name = managedPluginResourceName(
      row.environment_id,
      desired.ownershipFingerprint,
      row.resource_kind
    );
    if (row.resource_kind === 'd1') {
      const listed = await this.clients.d1.listD1Databases();
      let created = listed.find((candidate) => candidate.name === name);
      if (!created) {
        try {
          created = await this.clients.d1.createD1Database({ name });
        } catch (error) {
          created = (await this.clients.d1.listD1Databases()).find(
            (candidate) => candidate.name === name
          );
          if (!created) throw error;
        }
      }
      if (!created.uuid || created.name !== name) {
        throw new Error('plugin_resource_provider_reflection_mismatch');
      }
      if (created.read_replication?.mode !== 'disabled') {
        await this.clients.d1.updateD1Database(created.uuid, {
          read_replication: { mode: 'disabled' },
        });
      }
      const reflected = await this.clients.d1.getD1Database(created.uuid);
      if (reflected.uuid !== created.uuid || reflected.name !== name) {
        throw new Error('plugin_resource_provider_reflection_mismatch');
      }
      return { id: reflected.uuid, name: reflected.name };
    }
    if (row.resource_kind === 'kv_namespace') {
      const listed = await this.clients.kv.listKvNamespaces();
      let created = listed.find((candidate) => candidate.title === name);
      if (!created) {
        try {
          created = await this.clients.kv.createKvNamespace(name);
        } catch (error) {
          created = (await this.clients.kv.listKvNamespaces()).find(
            (candidate) => candidate.title === name
          );
          if (!created) throw error;
        }
      }
      const reflected = (await this.clients.kv.listKvNamespaces()).find(
        (candidate) => candidate.id === created.id && candidate.title === name
      );
      if (!reflected) throw new Error('plugin_resource_provider_reflection_mismatch');
      return { id: reflected.id, name: reflected.title };
    }
    const listed = await this.clients.r2.listR2Buckets();
    let created = listed.find((candidate) => candidate.name === name);
    if (!created) {
      try {
        created = await this.clients.r2.createR2Bucket(name);
      } catch (error) {
        created = (await this.clients.r2.listR2Buckets()).find(
          (candidate) => candidate.name === name
        );
        if (!created) throw error;
      }
    }
    const reflected = (await this.clients.r2.listR2Buckets()).find(
      (candidate) => candidate.name === created.name && candidate.name === name
    );
    if (!reflected) throw new Error('plugin_resource_provider_reflection_mismatch');
    return { id: reflected.name, name: reflected.name };
  }

  private async verifyExisting(row: ResourceRow): Promise<ProviderIdentity> {
    if (!row.provider_resource_id || !row.provider_name) {
      throw new Error('plugin_resource_existing_identity_missing');
    }
    if (row.resource_kind === 'd1') {
      const database = await this.clients.d1.getD1Database(row.provider_resource_id);
      if (database.uuid !== row.provider_resource_id || database.name !== row.provider_name) {
        throw new Error('plugin_resource_existing_identity_mismatch');
      }
      return { id: database.uuid, name: database.name };
    }
    if (row.resource_kind === 'kv_namespace') {
      const namespace = (await this.clients.kv.listKvNamespaces()).find(
        (candidate) => candidate.id === row.provider_resource_id
      );
      if (!namespace || namespace.title !== row.provider_name) {
        throw new Error('plugin_resource_existing_identity_mismatch');
      }
      return { id: namespace.id, name: namespace.title };
    }
    if (row.provider_resource_id !== row.provider_name) {
      throw new Error('plugin_resource_existing_identity_mismatch');
    }
    const bucket = (await this.clients.r2.listR2Buckets()).find(
      (candidate) => candidate.name === row.provider_name
    );
    if (!bucket) throw new Error('plugin_resource_existing_identity_mismatch');
    return { id: bucket.name, name: bucket.name };
  }

  private async assertUnclaimed(row: ResourceRow, identity: ProviderIdentity): Promise<void> {
    const collision = await this.database
      .prepare(
        `SELECT plugin_resource_id FROM control_plugin_desired_resources
          WHERE environment_id = ? AND resource_kind = ? AND status <> 'deleted'
            AND plugin_resource_id <> ?
            AND (provider_resource_id = ? OR provider_name = ?)
          LIMIT 1`
      )
      .bind(
        row.environment_id,
        row.resource_kind,
        row.plugin_resource_id,
        identity.id,
        identity.name
      )
      .first<{ plugin_resource_id: string }>();
    if (collision) throw new Error('plugin_resource_provider_already_claimed');
  }

  private async recordSuccess(
    row: ResourceRow,
    claim: ClaimedOperation,
    stepKey: string,
    identity: ProviderIdentity
  ): Promise<void> {
    const now = this.now();
    const nextStatus = 'ready';
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE control_plugin_desired_resources
              SET provider_resource_id = ?, provider_name = ?, status = ?, updated_at = ?
            WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?
              AND EXISTS (
                SELECT 1 FROM control_operations
                 WHERE operation_id = ? AND environment_id = ?
                   AND lock_owner = 'plugin-resource-reconciler' AND fencing_token = ?
              )`
        )
        .bind(
          identity.id,
          identity.name,
          nextStatus,
          now,
          row.plugin_resource_id,
          row.environment_id,
          row.operation_id,
          row.operation_id,
          row.environment_id,
          claim.fencing_token
        ),
      this.database
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'succeeded', observed_resource_id = ?, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND step_key = ? AND status = 'running'
              AND EXISTS (
                SELECT 1 FROM control_operations
                 WHERE operation_id = ? AND environment_id = ?
                   AND lock_owner = 'plugin-resource-reconciler' AND fencing_token = ?
              )`
        )
        .bind(
          identity.id,
          now,
          now,
          row.operation_id,
          stepKey,
          row.operation_id,
          row.environment_id,
          claim.fencing_token
        ),
      this.database
        .prepare(
          `UPDATE control_operations
              SET lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND lock_owner = 'plugin-resource-reconciler' AND fencing_token = ?`
        )
        .bind(now, row.operation_id, row.environment_id, claim.fencing_token),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'plugin.resource.provider.ready', 'worker',
             'ar-control', 'plugin_resource', ?, 'succeeded', ?, ?)`
        )
        .bind(
          `audit_plugin_provider_${row.plugin_resource_id.slice(-32)}_${claim.fencing_token}`,
          row.environment_id,
          row.operation_id,
          row.plugin_resource_id,
          JSON.stringify({
            kind: row.resource_kind,
            lifecycleMode: row.lifecycle_mode,
          }),
          now
        ),
    ]);
  }

  private async recordFailure(
    row: ResourceRow,
    claim: ClaimedOperation,
    error: unknown,
    stepKey?: string
  ): Promise<void> {
    const now = this.now();
    const result = failure(error);
    const operationStatus = result.permanent ? 'blocked' : 'waiting_retry';
    const resourceStatus = result.permanent ? 'failed' : 'pending';
    const stepStatus = result.permanent ? 'blocked' : 'waiting_retry';
    const nextAttemptAt = result.permanent ? null : now + retryDelay(claim.attempt_count);
    const desired = (() => {
      try {
        return parseDesiredSpec(row);
      } catch {
        return null;
      }
    })();
    const resolvedStepKey =
      stepKey ??
      (desired ? `plugin_resource_${desired.ownershipFingerprint.slice(0, 20)}_provider` : null);
    const statements = [
      this.database
        .prepare(
          `UPDATE control_plugin_desired_resources
              SET status = ?, updated_at = ?
            WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?`
        )
        .bind(resourceStatus, now, row.plugin_resource_id, row.environment_id, row.operation_id),
      this.database
        .prepare(
          `UPDATE control_operations
              SET status = ?, next_attempt_at = ?, last_error_code = ?,
                  last_error_redacted = ?, lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND lock_owner = 'plugin-resource-reconciler' AND fencing_token = ?`
        )
        .bind(
          operationStatus,
          nextAttemptAt,
          result.code,
          result.code,
          now,
          row.operation_id,
          row.environment_id,
          claim.fencing_token
        ),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'plugin.resource.provider.failed', 'worker',
             'ar-control', 'plugin_resource', ?, ?, ?, ?)`
        )
        .bind(
          `audit_plugin_provider_${row.plugin_resource_id.slice(-32)}_${claim.fencing_token}`,
          row.environment_id,
          row.operation_id,
          row.plugin_resource_id,
          result.permanent ? 'blocked' : 'failed',
          JSON.stringify({ code: result.code, kind: row.resource_kind }),
          now
        ),
    ];
    if (resolvedStepKey) {
      statements.push(
        this.database
          .prepare(
            `UPDATE control_operation_steps
                SET status = ?, next_attempt_at = ?, last_error_code = ?,
                    last_error_redacted = ?, updated_at = ?
              WHERE operation_id = ? AND step_key = ? AND status = 'running'`
          )
          .bind(
            stepStatus,
            nextAttemptAt,
            result.code,
            result.code,
            now,
            row.operation_id,
            resolvedStepKey
          )
      );
    }
    await this.database.batch(statements);
  }
}
