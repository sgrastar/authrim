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
  provider_create_state: 'not_started' | 'issued' | 'identified' | 'legacy_unverified';
  provider_creation_date: string | null;
  provider_ownership_marker_key: string | null;
  provider_ownership_id: string | null;
  provider_identity_checkpointed_at: number | null;
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
    message === 'operator_action_required' ||
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
                resource.provider_create_state, resource.provider_creation_date,
                resource.provider_ownership_marker_key, resource.provider_ownership_id,
                resource.provider_identity_checkpointed_at,
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
      const identity = await this.ensureProviderResource(row, desired, claimed);
      await this.assertUnclaimed(row, identity);
      await this.recordSuccess(row, claimed, stepKey, identity);
    } catch (error) {
      await this.recordFailure(row, claimed, error, stepKey);
    }
    return true;
  }

  private async ensureProviderResource(
    row: ResourceRow,
    desired: DesiredSpec,
    claim: ClaimedOperation
  ): Promise<ProviderIdentity> {
    if (row.lifecycle_mode === 'existing') return this.verifyExisting(row);
    const name = managedPluginResourceName(
      row.environment_id,
      desired.ownershipFingerprint,
      row.resource_kind
    );
    if (row.resource_kind === 'r2_bucket') {
      // Runtime Control has only the account bearer API and cannot establish the object-level
      // ownership marker required for a safe R2 identity. Setup owns this provider mutation.
      throw new Error('operator_action_required');
    }
    return row.resource_kind === 'd1'
      ? this.ensureManagedD1(row, claim, name)
      : this.ensureManagedKv(row, claim, name);
  }

  private isDefiniteCreateRejection(error: unknown): boolean {
    const status = errorStatus(error);
    return (
      status === 401 ||
      status === 403 ||
      status === 429 ||
      (status !== null && status >= 400 && status < 500 && status !== 408)
    );
  }

  private async ensureManagedD1(
    row: ResourceRow,
    claim: ClaimedOperation,
    expectedName: string
  ): Promise<ProviderIdentity> {
    if (row.provider_create_state === 'legacy_unverified') {
      throw new Error('plugin_resource_provider_checkpoint_invalid');
    }
    let database;
    if (row.provider_create_state === 'identified') {
      if (
        !row.provider_resource_id ||
        row.provider_name !== expectedName ||
        row.provider_identity_checkpointed_at === null
      ) {
        throw new Error('plugin_resource_provider_checkpoint_invalid');
      }
      database = await this.clients.d1.getD1Database(row.provider_resource_id);
    } else if (row.provider_create_state === 'issued') {
      throw new Error('plugin_resource_create_outcome_ambiguous');
    } else if (row.provider_resource_id && row.provider_name) {
      // The old coordinator can write an exact UUID between expand migration and coordinator
      // cutover. Verify that UUID, then upgrade the row without using its mutable name as evidence.
      database = await this.clients.d1.getD1Database(row.provider_resource_id);
      if (database.uuid !== row.provider_resource_id || database.name !== row.provider_name) {
        throw new Error('plugin_resource_provider_reflection_mismatch');
      }
      await this.checkpointProviderIdentity(row, claim, {
        id: database.uuid,
        name: database.name,
      });
    } else {
      if (
        (await this.clients.d1.listD1Databases()).some(
          (candidate) => candidate.name === expectedName
        )
      ) {
        throw new Error('plugin_resource_provider_name_conflict');
      }
      await this.markCreateIssued(row, claim);
      try {
        database = await this.clients.d1.createD1Database({ name: expectedName });
      } catch (error) {
        if (this.isDefiniteCreateRejection(error)) {
          await this.markCreateDefinitelyRejected(row, claim);
          throw error;
        }
        throw new Error('plugin_resource_create_outcome_ambiguous');
      }
      if (!database.uuid) throw new Error('plugin_resource_create_outcome_ambiguous');
      await this.checkpointProviderIdentity(row, claim, {
        id: database.uuid,
        name: database.name,
      });
    }
    if (
      !database.uuid ||
      (row.provider_resource_id !== null && database.uuid !== row.provider_resource_id) ||
      database.name !== expectedName
    ) {
      throw new Error('plugin_resource_provider_reflection_mismatch');
    }
    if (database.read_replication?.mode !== 'disabled') {
      await this.clients.d1.updateD1Database(database.uuid, {
        read_replication: { mode: 'disabled' },
      });
    }
    const reflected = await this.clients.d1.getD1Database(database.uuid);
    if (reflected.uuid !== database.uuid || reflected.name !== expectedName) {
      throw new Error('plugin_resource_provider_reflection_mismatch');
    }
    return { id: reflected.uuid, name: reflected.name };
  }

  private async ensureManagedKv(
    row: ResourceRow,
    claim: ClaimedOperation,
    expectedName: string
  ): Promise<ProviderIdentity> {
    if (row.provider_create_state === 'legacy_unverified') {
      throw new Error('plugin_resource_provider_checkpoint_invalid');
    }
    let namespace;
    if (row.provider_create_state === 'identified') {
      if (
        !row.provider_resource_id ||
        row.provider_name !== expectedName ||
        row.provider_identity_checkpointed_at === null
      ) {
        throw new Error('plugin_resource_provider_checkpoint_invalid');
      }
      namespace = (await this.clients.kv.listKvNamespaces()).find(
        (candidate) => candidate.id === row.provider_resource_id
      );
      if (!namespace) throw new Error('plugin_resource_provider_reflection_mismatch');
    } else if (row.provider_create_state === 'issued') {
      throw new Error('plugin_resource_create_outcome_ambiguous');
    } else if (row.provider_resource_id && row.provider_name) {
      namespace = (await this.clients.kv.listKvNamespaces()).find(
        (candidate) => candidate.id === row.provider_resource_id
      );
      if (!namespace || namespace.title !== row.provider_name) {
        throw new Error('plugin_resource_provider_reflection_mismatch');
      }
      await this.checkpointProviderIdentity(row, claim, {
        id: namespace.id,
        name: namespace.title,
      });
    } else {
      if (
        (await this.clients.kv.listKvNamespaces()).some(
          (candidate) => candidate.title === expectedName
        )
      ) {
        throw new Error('plugin_resource_provider_name_conflict');
      }
      await this.markCreateIssued(row, claim);
      try {
        namespace = await this.clients.kv.createKvNamespace(expectedName);
      } catch (error) {
        if (this.isDefiniteCreateRejection(error)) {
          await this.markCreateDefinitelyRejected(row, claim);
          throw error;
        }
        throw new Error('plugin_resource_create_outcome_ambiguous');
      }
      if (!namespace.id) throw new Error('plugin_resource_create_outcome_ambiguous');
      await this.checkpointProviderIdentity(row, claim, {
        id: namespace.id,
        name: namespace.title,
      });
    }
    if (
      !namespace ||
      (row.provider_resource_id !== null && namespace.id !== row.provider_resource_id) ||
      namespace.title !== expectedName
    ) {
      throw new Error('plugin_resource_provider_reflection_mismatch');
    }
    const reflected = (await this.clients.kv.listKvNamespaces()).find(
      (candidate) => candidate.id === namespace.id
    );
    if (!reflected || reflected.title !== expectedName) {
      throw new Error('plugin_resource_provider_reflection_mismatch');
    }
    return { id: reflected.id, name: reflected.title };
  }

  private async markCreateIssued(row: ResourceRow, claim: ClaimedOperation): Promise<void> {
    const result = await this.database
      .prepare(
        `UPDATE control_plugin_desired_resources
            SET provider_create_state = 'issued', status = 'provisioning', updated_at = ?
          WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?
            AND lifecycle_mode = 'managed' AND provider_create_state = 'not_started'
            AND provider_resource_id IS NULL AND provider_name IS NULL
            AND EXISTS (
              SELECT 1 FROM control_operations operation
               WHERE operation.operation_id = ? AND operation.environment_id = ?
                 AND operation.lock_owner = 'plugin-resource-reconciler'
                 AND operation.fencing_token = ? AND operation.status = 'running'
            )`
      )
      .bind(
        this.now(),
        row.plugin_resource_id,
        row.environment_id,
        row.operation_id,
        row.operation_id,
        row.environment_id,
        claim.fencing_token
      )
      .run();
    if (Number(result.meta.changes ?? 0) !== 1) {
      throw new Error('plugin_resource_create_issue_checkpoint_failed');
    }
  }

  private async markCreateDefinitelyRejected(
    row: ResourceRow,
    claim: ClaimedOperation
  ): Promise<void> {
    const result = await this.database
      .prepare(
        `UPDATE control_plugin_desired_resources
            SET provider_create_state = 'not_started', status = 'pending', updated_at = ?
          WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?
            AND lifecycle_mode = 'managed' AND provider_create_state = 'issued'
            AND provider_resource_id IS NULL AND provider_name IS NULL
            AND EXISTS (
              SELECT 1 FROM control_operations operation
               WHERE operation.operation_id = ? AND operation.environment_id = ?
                 AND operation.lock_owner = 'plugin-resource-reconciler'
                 AND operation.fencing_token = ? AND operation.status = 'running'
            )`
      )
      .bind(
        this.now(),
        row.plugin_resource_id,
        row.environment_id,
        row.operation_id,
        row.operation_id,
        row.environment_id,
        claim.fencing_token
      )
      .run();
    if (Number(result.meta.changes ?? 0) !== 1) {
      throw new Error('plugin_resource_create_rejection_checkpoint_failed');
    }
  }

  private async checkpointProviderIdentity(
    row: ResourceRow,
    claim: ClaimedOperation,
    identity: ProviderIdentity
  ): Promise<void> {
    if (!identity.id || !identity.name) {
      throw new Error('plugin_resource_create_outcome_ambiguous');
    }
    const now = this.now();
    const result = await this.database
      .prepare(
        `UPDATE control_plugin_desired_resources
            SET provider_create_state = 'identified', provider_resource_id = ?, provider_name = ?,
                provider_identity_checkpointed_at = COALESCE(provider_identity_checkpointed_at, ?),
                updated_at = ?
          WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?
            AND lifecycle_mode = 'managed'
            AND (provider_create_state = 'issued' OR
                 (provider_create_state = 'not_started' AND provider_resource_id = ?
                  AND provider_name = ?) OR
                 (provider_create_state = 'identified' AND provider_resource_id = ?
                  AND provider_name = ?))
            AND EXISTS (
              SELECT 1 FROM control_operations operation
               WHERE operation.operation_id = ? AND operation.environment_id = ?
                 AND operation.lock_owner = 'plugin-resource-reconciler'
                 AND operation.fencing_token = ? AND operation.status = 'running'
            )`
      )
      .bind(
        identity.id,
        identity.name,
        now,
        now,
        row.plugin_resource_id,
        row.environment_id,
        row.operation_id,
        identity.id,
        identity.name,
        identity.id,
        identity.name,
        row.operation_id,
        row.environment_id,
        claim.fencing_token
      )
      .run();
    if (Number(result.meta.changes ?? 0) !== 1) {
      throw new Error('plugin_resource_provider_identity_checkpoint_failed');
    }
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
    const assertionId = `plugin-provider-success:${row.plugin_resource_id}:${claim.fencing_token}`;
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE control_plugin_desired_resources
              SET provider_resource_id = ?, provider_name = ?, status = ?, updated_at = ?
            WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?
              AND (lifecycle_mode = 'existing' OR
                   (provider_create_state = 'identified' AND provider_resource_id = ?
                    AND provider_name = ? AND provider_identity_checkpointed_at IS NOT NULL))
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
          identity.id,
          identity.name,
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
          `INSERT INTO control_plugin_provider_projection_assertions (
             assertion_id, environment_id, plugin_resource_id, valid, created_at
           ) VALUES (?, ?, ?, CASE WHEN
             EXISTS (
               SELECT 1 FROM control_plugin_desired_resources resource
                WHERE resource.plugin_resource_id = ? AND resource.environment_id = ?
                  AND resource.operation_id = ? AND resource.provider_resource_id = ?
                  AND resource.provider_name = ? AND resource.status = 'ready'
                  AND (
                    resource.lifecycle_mode = 'existing' OR (
                      resource.lifecycle_mode = 'managed'
                      AND resource.provider_create_state = 'identified'
                      AND resource.provider_identity_checkpointed_at IS NOT NULL
                    )
                  )
             ) AND EXISTS (
               SELECT 1 FROM control_operation_steps step
                WHERE step.operation_id = ? AND step.step_key = ?
                  AND step.status = 'succeeded' AND step.observed_resource_id = ?
                  AND step.completed_at = ?
             ) AND EXISTS (
               SELECT 1 FROM control_operations operation
                WHERE operation.operation_id = ? AND operation.environment_id = ?
                  AND operation.status = 'running' AND operation.lock_owner IS NULL
                  AND operation.lock_expires_at IS NULL AND operation.fencing_token = ?
             ) THEN 1 ELSE 0 END, ?)`
        )
        .bind(
          assertionId,
          row.environment_id,
          row.plugin_resource_id,
          row.plugin_resource_id,
          row.environment_id,
          row.operation_id,
          identity.id,
          identity.name,
          row.operation_id,
          stepKey,
          identity.id,
          now,
          row.operation_id,
          row.environment_id,
          claim.fencing_token,
          now
        ),
      this.database
        .prepare(
          `DELETE FROM control_plugin_provider_projection_assertions
            WHERE assertion_id = ? AND environment_id = ? AND plugin_resource_id = ?`
        )
        .bind(assertionId, row.environment_id, row.plugin_resource_id),
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
    const assertionId = `plugin-provider-failure:${row.plugin_resource_id}:${claim.fencing_token}`;
    const statements = [
      this.database
        .prepare(
          `UPDATE control_plugin_desired_resources
              SET status = ?, updated_at = ?
            WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?
              AND EXISTS (
                SELECT 1 FROM control_operations operation
                 WHERE operation.operation_id = ? AND operation.environment_id = ?
                   AND operation.status = 'running'
                   AND operation.lock_owner = 'plugin-resource-reconciler'
                   AND operation.fencing_token = ?
              )`
        )
        .bind(
          resourceStatus,
          now,
          row.plugin_resource_id,
          row.environment_id,
          row.operation_id,
          row.operation_id,
          row.environment_id,
          claim.fencing_token
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
    statements.push(
      this.database
        .prepare(
          `UPDATE control_operations
              SET status = ?, next_attempt_at = ?, last_error_code = ?,
                  last_error_redacted = ?, lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status = 'running'
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
          `INSERT INTO control_plugin_provider_projection_assertions (
             assertion_id, environment_id, plugin_resource_id, valid, created_at
           ) VALUES (?, ?, ?, CASE WHEN
             EXISTS (
               SELECT 1 FROM control_plugin_desired_resources resource
                WHERE resource.plugin_resource_id = ? AND resource.environment_id = ?
                  AND resource.operation_id = ? AND resource.status = ?
             )
             ${
               resolvedStepKey
                 ? `AND EXISTS (
                      SELECT 1 FROM control_operation_steps step
                       WHERE step.operation_id = ? AND step.step_key = ? AND step.status = ?
                         AND step.next_attempt_at IS ? AND step.last_error_code = ?
                    )`
                 : ''
             }
             AND EXISTS (
               SELECT 1 FROM control_operations operation
                WHERE operation.operation_id = ? AND operation.environment_id = ?
                  AND operation.status = ? AND operation.next_attempt_at IS ?
                  AND operation.last_error_code = ? AND operation.lock_owner IS NULL
                  AND operation.lock_expires_at IS NULL AND operation.fencing_token = ?
             ) THEN 1 ELSE 0 END, ?)`
        )
        .bind(
          assertionId,
          row.environment_id,
          row.plugin_resource_id,
          row.plugin_resource_id,
          row.environment_id,
          row.operation_id,
          resourceStatus,
          ...(resolvedStepKey
            ? [row.operation_id, resolvedStepKey, stepStatus, nextAttemptAt, result.code]
            : []),
          row.operation_id,
          row.environment_id,
          operationStatus,
          nextAttemptAt,
          result.code,
          claim.fencing_token,
          now
        ),
      this.database
        .prepare(
          `DELETE FROM control_plugin_provider_projection_assertions
            WHERE assertion_id = ? AND environment_id = ? AND plugin_resource_id = ?`
        )
        .bind(assertionId, row.environment_id, row.plugin_resource_id),
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
        )
    );
    await this.database.batch(statements);
  }
}
