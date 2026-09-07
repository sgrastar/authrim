import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  type DecisionHookResult,
  type FlowHookInput,
  type FlowHookResult,
  type HumanVerificationHookInput,
  type PolicyDecisionHookInput,
  type SyncHookBackend,
  type SyncHookGroup,
  type SyncHookTarget,
} from './sync-hooks';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_CAPABILITY = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const SAFE_SCRIPT = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
// The probe fence must outlive the maximum backend timeout and its D1 state update.
const PROBE_LEASE_SECONDS = 60;

interface PolicyRow {
  plugin_id: string;
  backend_kind: string;
  script_name: string | null;
  timeout_ms: number | string;
  circuit_breaker_threshold: number | string;
  circuit_breaker_cooldown_seconds: number | string;
  failure_policy: string;
  breaker_state: string | null;
  retry_after: number | string | null;
  probe_until: number | string | null;
}

interface SyncPolicy {
  pluginId: string;
  target: SyncHookTarget;
  threshold: number;
  cooldownSeconds: number;
  probeToken: string | null;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('plugin_sync_d1_session_required');
  }
  return db.withSession('first-primary');
}

function boundedInteger(value: number | string, minimum: number, maximum: number, code: string) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(code);
  }
  return parsed;
}

export class SyncHookService {
  constructor(
    private readonly db: D1Database,
    private readonly backend: SyncHookBackend,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)
  ) {}

  async runHumanVerification(input: HumanVerificationHookInput): Promise<DecisionHookResult> {
    try {
      return await this.execute('human-verification', 'human_verification.verify', input);
    } catch {
      return { decision: 'deny', reasonCode: 'plugin_unavailable' };
    }
  }

  async runPolicyDecision(input: PolicyDecisionHookInput): Promise<DecisionHookResult> {
    try {
      return await this.execute('policy-decision', 'policy.decision', input);
    } catch {
      return { decision: 'deny', reasonCode: 'plugin_unavailable' };
    }
  }

  async runFlowHook(input: FlowHookInput): Promise<FlowHookResult> {
    try {
      return await this.execute('flow-hook', `flow.${input.hookName}`, input);
    } catch {
      return { decision: 'deny', reasonCode: 'plugin_unavailable' };
    }
  }

  private async execute<T extends DecisionHookResult | FlowHookResult>(
    group: SyncHookGroup,
    capability: string,
    input: HumanVerificationHookInput | PolicyDecisionHookInput | FlowHookInput
  ): Promise<T> {
    if (
      !SAFE_ID.test(input.tenantId) ||
      !SAFE_ID.test(input.pluginInstallationId) ||
      !SAFE_CAPABILITY.test(capability)
    ) {
      throw new Error('plugin_sync_input_invalid');
    }
    const now = this.now();
    const policy = await this.acquirePolicy(input, capability, now);
    let result: T;
    try {
      result = await this.backend.invoke<T>({ group, target: policy.target, payload: input });
    } catch {
      await this.recordFailure(input, capability, policy, now);
      throw new Error('plugin_sync_execution_failed');
    }
    try {
      await this.recordSuccess(input, capability, policy, now);
    } catch {
      throw new Error('plugin_sync_bookkeeping_failed');
    }
    return result;
  }

  private async acquirePolicy(
    input: { tenantId: string; pluginInstallationId: string },
    capability: string,
    now: number
  ): Promise<SyncPolicy> {
    const session = primary(this.db);
    const row = await session
      .prepare(
        `SELECT installation.plugin_id, installation.backend_kind, installation.script_name,
                COALESCE(dynamic_policy.timeout_ms, builtin_policy.timeout_ms) AS timeout_ms,
                COALESCE(dynamic_policy.circuit_breaker_threshold,
                         builtin_policy.circuit_breaker_threshold) AS circuit_breaker_threshold,
                COALESCE(dynamic_policy.circuit_breaker_cooldown_seconds,
                         builtin_policy.circuit_breaker_cooldown_seconds)
                  AS circuit_breaker_cooldown_seconds,
                COALESCE(dynamic_policy.failure_policy,
                         builtin_policy.failure_policy) AS failure_policy,
                breaker.state AS breaker_state, breaker.retry_after, breaker.probe_until
           FROM plugin_runner_installations installation
           LEFT JOIN plugin_runner_dynamic_worker_artifacts artifact
             ON artifact.installation_id = installation.installation_id
            AND artifact.plugin_id = installation.plugin_id AND artifact.state = 'active'
           LEFT JOIN plugin_runner_dynamic_worker_releases release
             ON release.plugin_id = artifact.plugin_id
            AND release.version_digest = artifact.version_digest AND release.state = 'published'
           LEFT JOIN plugin_runner_dynamic_worker_manifests manifest
             ON manifest.plugin_id = installation.plugin_id AND manifest.state = 'active'
           LEFT JOIN plugin_runner_dynamic_worker_hook_policies dynamic_policy
             ON dynamic_policy.plugin_id = installation.plugin_id
            AND dynamic_policy.version_digest = artifact.version_digest
            AND dynamic_policy.capability = ?
           LEFT JOIN plugin_runner_hook_policies builtin_policy
             ON builtin_policy.plugin_id = installation.plugin_id
            AND builtin_policy.capability = ?
           LEFT JOIN plugin_runner_circuit_breakers breaker
             ON breaker.plugin_id = installation.plugin_id
            AND breaker.tenant_id = installation.tenant_id
            AND breaker.capability = ?
          WHERE installation.installation_id = ? AND installation.tenant_id = ?
            AND installation.state = 'enabled'
            AND ((installation.backend_kind = 'dynamic_worker'
                  AND release.version_digest IS NOT NULL
                  AND manifest.plugin_id IS NOT NULL
                  AND dynamic_policy.capability IS NOT NULL)
              OR (installation.backend_kind = 'in_process'
                  AND builtin_policy.capability IS NOT NULL))`
      )
      .bind(capability, capability, capability, input.pluginInstallationId, input.tenantId)
      .first<PolicyRow>();
    if (
      !row ||
      !SAFE_ID.test(row.plugin_id) ||
      (row.backend_kind !== 'dynamic_worker' && row.backend_kind !== 'in_process') ||
      row.failure_policy !== 'fail_closed'
    ) {
      throw new Error('plugin_sync_policy_unavailable');
    }
    const timeoutMs = boundedInteger(row.timeout_ms, 1, 30_000, 'plugin_sync_timeout_invalid');
    let target: SyncHookTarget;
    if (row.backend_kind === 'dynamic_worker') {
      if (typeof row.script_name !== 'string' || !SAFE_SCRIPT.test(row.script_name)) {
        throw new Error('plugin_sync_policy_unavailable');
      }
      target = { backendKind: 'dynamic_worker', scriptName: row.script_name, timeoutMs };
    } else {
      if (row.script_name !== null) throw new Error('plugin_sync_policy_unavailable');
      target = { backendKind: 'in_process', pluginId: row.plugin_id, timeoutMs };
    }
    const policy: SyncPolicy = {
      pluginId: row.plugin_id,
      target,
      threshold: boundedInteger(
        row.circuit_breaker_threshold,
        1,
        1_000,
        'plugin_sync_breaker_threshold_invalid'
      ),
      cooldownSeconds: boundedInteger(
        row.circuit_breaker_cooldown_seconds,
        1,
        86_400,
        'plugin_sync_breaker_cooldown_invalid'
      ),
      probeToken: null,
    };
    if (row.breaker_state === null || row.breaker_state === 'closed') return policy;
    if (row.breaker_state !== 'open' && row.breaker_state !== 'half_open') {
      throw new Error('plugin_sync_breaker_state_invalid');
    }
    const retryAfter =
      row.retry_after === null
        ? 0
        : boundedInteger(row.retry_after, 0, Number.MAX_SAFE_INTEGER, 'plugin_sync_retry_invalid');
    const probeUntil =
      row.probe_until === null
        ? 0
        : boundedInteger(row.probe_until, 0, Number.MAX_SAFE_INTEGER, 'plugin_sync_probe_invalid');
    if (
      (row.breaker_state === 'open' && retryAfter > now) ||
      (row.breaker_state === 'half_open' && probeUntil > now)
    ) {
      throw new Error('plugin_sync_circuit_open');
    }
    const probeToken = `probe-${crypto.randomUUID()}`;
    const update = await session
      .prepare(
        `UPDATE plugin_runner_circuit_breakers
            SET state = 'half_open', probe_token = ?, probe_until = ?, updated_at = ?
          WHERE plugin_id = ? AND tenant_id = ? AND capability = ?
            AND ((state = 'open' AND retry_after <= ?)
              OR (state = 'half_open' AND probe_until <= ?))`
      )
      .bind(
        probeToken,
        now + PROBE_LEASE_SECONDS,
        now,
        policy.pluginId,
        input.tenantId,
        capability,
        now,
        now
      )
      .run();
    if ((update.meta.changes ?? 0) !== 1) throw new Error('plugin_sync_circuit_open');
    return { ...policy, probeToken };
  }

  private async recordSuccess(
    input: { tenantId: string },
    capability: string,
    policy: SyncPolicy,
    now: number
  ): Promise<void> {
    const result = await primary(this.db)
      .prepare(
        `INSERT INTO plugin_runner_circuit_breakers (
           plugin_id, tenant_id, capability, state, failure_count,
           opened_at, retry_after, updated_at, probe_token, probe_until
         ) VALUES (?, ?, ?, 'closed', 0, NULL, NULL, ?, NULL, NULL)
         ON CONFLICT(plugin_id, tenant_id, capability) DO UPDATE SET
           state = 'closed', failure_count = 0, opened_at = NULL, retry_after = NULL,
           updated_at = excluded.updated_at, probe_token = NULL, probe_until = NULL
         WHERE plugin_runner_circuit_breakers.state = 'closed'
            OR plugin_runner_circuit_breakers.probe_token = ?`
      )
      .bind(policy.pluginId, input.tenantId, capability, now, policy.probeToken)
      .run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error('plugin_sync_breaker_success_stale');
  }

  private async recordFailure(
    input: { tenantId: string },
    capability: string,
    policy: SyncPolicy,
    now: number
  ): Promise<void> {
    const result = await primary(this.db)
      .prepare(
        `INSERT INTO plugin_runner_circuit_breakers (
           plugin_id, tenant_id, capability, state, failure_count,
           opened_at, retry_after, updated_at, probe_token, probe_until
         ) VALUES (
           ?, ?, ?, CASE WHEN 1 >= ? THEN 'open' ELSE 'closed' END, 1,
           CASE WHEN 1 >= ? THEN ? ELSE NULL END,
           CASE WHEN 1 >= ? THEN ? ELSE NULL END, ?, NULL, NULL
         )
         ON CONFLICT(plugin_id, tenant_id, capability) DO UPDATE SET
           failure_count = plugin_runner_circuit_breakers.failure_count + 1,
           state = CASE
             WHEN plugin_runner_circuit_breakers.state = 'half_open'
               OR plugin_runner_circuit_breakers.failure_count + 1 >= ? THEN 'open'
             ELSE 'closed'
           END,
           opened_at = CASE
             WHEN plugin_runner_circuit_breakers.state = 'half_open'
               OR plugin_runner_circuit_breakers.failure_count + 1 >= ? THEN ?
             ELSE plugin_runner_circuit_breakers.opened_at
           END,
           retry_after = CASE
             WHEN plugin_runner_circuit_breakers.state = 'half_open'
               OR plugin_runner_circuit_breakers.failure_count + 1 >= ? THEN ?
             ELSE plugin_runner_circuit_breakers.retry_after
           END,
           updated_at = ?, probe_token = NULL, probe_until = NULL
         WHERE plugin_runner_circuit_breakers.state = 'closed'
            OR plugin_runner_circuit_breakers.probe_token = ?`
      )
      .bind(
        policy.pluginId,
        input.tenantId,
        capability,
        policy.threshold,
        policy.threshold,
        now,
        policy.threshold,
        now + policy.cooldownSeconds,
        now,
        policy.threshold,
        policy.threshold,
        now,
        policy.threshold,
        now + policy.cooldownSeconds,
        now,
        policy.probeToken
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error('plugin_sync_breaker_failure_stale');
  }
}
