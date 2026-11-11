import type { D1Database } from '@cloudflare/workers-types';
import type {
  ControlServiceSiteBindingRequest,
  ControlServiceSiteBindingState,
  ControlServiceSiteBindingStatusView,
} from '@authrim/ar-lib-core/control-plane';

/**
 * Cloudflare Worker script names: lowercase letters, digits, dashes and underscores, at most 63
 * characters, starting and ending with a letter or digit.
 */
const SERVICE_SITE_WORKER_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/u;
const SAFE_IDEMPOTENCY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_ACTOR = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/u;
const ROUTER_PACKAGE_NAME = '@authrim/ar-router';
/** Binding name used until the reconciler resolves the router's SERVICE_SITE_BINDING variable. */
export const DEFAULT_SERVICE_SITE_BINDING_NAME = 'SERVICE_SITE';
export const SERVICE_SITE_OPERATION_KIND = 'service_site_binding';

/** States in which a request must wait for the running change. */
export const SERVICE_SITE_ACTIVE_STATES: readonly ControlServiceSiteBindingState[] = [
  'pending',
  'settings_patched',
  'rollback_required',
];

export interface ServiceSiteBindingRow {
  environment_id: string;
  router_worker_script_name: string;
  binding_name: string;
  desired_state: 'attached' | 'detached';
  desired_worker_name: string | null;
  attached_worker_name: string | null;
  generation: number;
  operation_id: string;
  requested_by_id: string | null;
  state: Exclude<ControlServiceSiteBindingState, 'none'>;
  expected_source_version_id: string | null;
  previous_deployment_id: string | null;
  patch_result_version_id: string | null;
  patch_result_deployment_id: string | null;
  previous_restore_settings_json: string | null;
  previous_binding_json: string | null;
  stabilization_not_before: number | null;
  next_attempt_at: number | null;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

/** Whether the name has the shape of a Cloudflare Worker script name. */
export function isServiceSiteWorkerName(value: unknown): value is string {
  return typeof value === 'string' && SERVICE_SITE_WORKER_NAME.test(value);
}

/**
 * Names that can never be a service site: Authrim's own Workers. The inventory is checked
 * separately; this catches Workers that are not (yet) registered but follow Authrim's naming.
 */
export function isAuthrimWorkerName(environmentName: string, workerName: string): boolean {
  return workerName.startsWith('ar-') || workerName.startsWith(`${environmentName}-ar-`);
}

export function serviceSiteStatusView(
  environmentId: string,
  row: ServiceSiteBindingRow | null
): ControlServiceSiteBindingStatusView {
  if (!row) {
    return {
      environmentId,
      bindingName: null,
      desiredState: 'detached',
      desiredWorkerName: null,
      attachedWorkerName: null,
      state: 'none',
      operationId: null,
      lastErrorCode: null,
      updatedAt: null,
    };
  }
  return {
    environmentId,
    bindingName: row.binding_name,
    desiredState: row.desired_state,
    desiredWorkerName: row.desired_worker_name,
    attachedWorkerName: row.attached_worker_name,
    state: row.state,
    operationId: row.operation_id,
    lastErrorCode: row.last_error_code,
    updatedAt: Number(row.updated_at),
  };
}

function validateRequest(input: ControlServiceSiteBindingRequest): void {
  const valid =
    input &&
    typeof input === 'object' &&
    (input.desiredState === 'attached' || input.desiredState === 'detached') &&
    typeof input.idempotencyKey === 'string' &&
    SAFE_IDEMPOTENCY_KEY.test(input.idempotencyKey) &&
    typeof input.requestedById === 'string' &&
    SAFE_ACTOR.test(input.requestedById) &&
    (input.desiredState === 'detached'
      ? input.workerName === null || input.workerName === undefined
      : isServiceSiteWorkerName(input.workerName));
  if (!valid) throw new Error('invalid_service_site_binding_request');
}

/**
 * Records the desired service site attachment of the router Worker. The Worker settings patch is
 * done by `ServiceSiteBindingReconciler`; this service only validates and persists the request.
 */
export class ServiceSiteBindingService {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number,
    private readonly randomId: () => string = () => crypto.randomUUID()
  ) {}

  async getStatus(environmentId: string): Promise<ControlServiceSiteBindingStatusView> {
    return serviceSiteStatusView(environmentId, await this.readRow(environmentId));
  }

  async request(
    environmentId: string,
    input: ControlServiceSiteBindingRequest
  ): Promise<ControlServiceSiteBindingStatusView> {
    validateRequest(input);
    const workerName = input.desiredState === 'attached' ? (input.workerName as string) : null;

    const replay = await this.db
      .prepare(
        `SELECT operation_id FROM control_operations
          WHERE environment_id = ? AND idempotency_key = ?`
      )
      .bind(environmentId, input.idempotencyKey)
      .first<{ operation_id: string }>();
    const existing = await this.readRow(environmentId);
    if (replay) {
      if (
        existing?.operation_id !== replay.operation_id ||
        existing.desired_state !== input.desiredState ||
        existing.desired_worker_name !== workerName
      ) {
        throw new Error('service_site_idempotency_conflict');
      }
      return serviceSiteStatusView(environmentId, existing);
    }

    const environment = await this.db
      .prepare(
        `SELECT environment_name, lifecycle_state FROM control_environments
          WHERE environment_id = ?`
      )
      .bind(environmentId)
      .first<{ environment_name: string; lifecycle_state: string }>();
    if (!environment || environment.lifecycle_state !== 'active') {
      throw new Error('service_site_environment_not_active');
    }
    const router = await this.db
      .prepare(
        `SELECT worker_script_name FROM control_desired_worker_inventory
          WHERE environment_id = ? AND package_name = ? AND status = 'active'
          ORDER BY worker_script_name LIMIT 2`
      )
      .bind(environmentId, ROUTER_PACKAGE_NAME)
      .all<{ worker_script_name: string }>();
    if (router.results.length !== 1 || !router.results[0]) {
      throw new Error('service_site_router_not_in_inventory');
    }
    const routerScriptName = router.results[0].worker_script_name;

    if (workerName !== null) {
      if (isAuthrimWorkerName(environment.environment_name, workerName)) {
        throw new Error('service_site_worker_reserved');
      }
      const registered = await this.db
        .prepare(
          `SELECT 1 AS found FROM control_desired_worker_inventory
            WHERE environment_id = ? AND worker_script_name = ?`
        )
        .bind(environmentId, workerName)
        .first<{ found: number }>();
      if (registered) throw new Error('service_site_worker_reserved');
    }

    if (existing && SERVICE_SITE_ACTIVE_STATES.includes(existing.state)) {
      throw new Error('service_site_change_in_progress');
    }
    // Asking for the state the router already has needs no change and no new operation.
    if (
      existing?.state === 'succeeded' &&
      existing.desired_state === input.desiredState &&
      existing.desired_worker_name === workerName
    ) {
      return serviceSiteStatusView(environmentId, existing);
    }

    const now = this.now();
    const operationId = `service-site:${this.randomId()}`;
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO control_operations (
             operation_id, environment_id, operation_kind, idempotency_key, status,
             requested_by_type, requested_by_id, attempt_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'queued', 'admin', ?, 0, ?, ?)`
        )
        .bind(
          operationId,
          environmentId,
          SERVICE_SITE_OPERATION_KIND,
          input.idempotencyKey,
          input.requestedById,
          now,
          now
        ),
      this.db
        .prepare(
          `INSERT INTO control_service_site_bindings (
             environment_id, router_worker_script_name, binding_name, desired_state,
             desired_worker_name, attached_worker_name, generation, operation_id,
             requested_by_id, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, 'pending', ?, ?)
           ON CONFLICT(environment_id) DO UPDATE SET
             router_worker_script_name = excluded.router_worker_script_name,
             desired_state = excluded.desired_state,
             desired_worker_name = excluded.desired_worker_name,
             generation = control_service_site_bindings.generation + 1,
             operation_id = excluded.operation_id,
             requested_by_id = excluded.requested_by_id,
             state = 'pending',
             expected_source_version_id = NULL,
             previous_deployment_id = NULL,
             patch_result_version_id = NULL,
             patch_result_deployment_id = NULL,
             previous_restore_settings_json = NULL,
             previous_binding_json = NULL,
             stabilization_not_before = NULL,
             next_attempt_at = NULL,
             last_error_code = NULL,
             completed_at = NULL,
             updated_at = excluded.updated_at
           WHERE control_service_site_bindings.state NOT IN
             ('pending', 'settings_patched', 'rollback_required')`
        )
        .bind(
          environmentId,
          routerScriptName,
          existing?.binding_name ?? DEFAULT_SERVICE_SITE_BINDING_NAME,
          input.desiredState,
          workerName,
          operationId,
          input.requestedById,
          now,
          now
        ),
    ]);
    if (Number(results[1]?.meta?.changes ?? 0) !== 1) {
      // A concurrent request won the row; do not leave this request's operation dangling.
      await this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'canceled', completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status = 'queued'`
        )
        .bind(now, now, operationId, environmentId)
        .run();
      throw new Error('service_site_change_in_progress');
    }
    return this.getStatus(environmentId);
  }

  private async readRow(environmentId: string): Promise<ServiceSiteBindingRow | null> {
    return this.db
      .prepare(`SELECT * FROM control_service_site_bindings WHERE environment_id = ?`)
      .bind(environmentId)
      .first<ServiceSiteBindingRow>();
  }
}
