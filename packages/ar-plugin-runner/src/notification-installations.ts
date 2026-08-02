import type { D1Database, D1DatabaseSession, D1Result } from '@cloudflare/workers-types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_SCRIPT = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const BUILTIN_PLUGINS = new Set(['notifier-resend', 'notifier-cloudflare']);

export interface ConfigureNotificationInstallationInput {
  installationId: string;
  tenantId: string;
  pluginId: string;
  backendKind: 'in_process' | 'dynamic_worker';
  scriptName?: string;
  enabled: boolean;
}

export interface ConfigureNotificationInstallationResult {
  installationId: string;
  tenantId: string;
  pluginId: string;
  state: 'enabled' | 'disabled';
  configVersion: number;
}

interface InstallationRow {
  installation_id: string;
  tenant_id: string;
  plugin_id: string;
  backend_kind: string;
  script_name: string | null;
  state: string;
  config_version: number | string;
}

interface PolicyRow {
  timeout_ms: number | string;
  failure_policy: string;
  max_attempts: number | string;
  async_retry_budget_seconds: number | string;
  circuit_breaker_threshold: number | string;
  circuit_breaker_cooldown_seconds: number | string;
}

interface EgressRow {
  match_kind: string;
  host_pattern: string;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('plugin_notification_installation_d1_session_required');
  }
  return db.withSession('first-primary');
}

function validate(input: unknown): asserts input is ConfigureNotificationInstallationInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_notification_installation_input_invalid');
  }
  const value = input as Partial<ConfigureNotificationInstallationInput>;
  const expectedKeys = [
    'backendKind',
    'enabled',
    'installationId',
    'pluginId',
    ...(value.scriptName === undefined ? [] : ['scriptName']),
    'tenantId',
  ].sort();
  if (
    Object.keys(input).sort().join(',') !== expectedKeys.join(',') ||
    typeof value.installationId !== 'string' ||
    !SAFE_ID.test(value.installationId) ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    typeof value.pluginId !== 'string' ||
    !SAFE_ID.test(value.pluginId) ||
    typeof value.enabled !== 'boolean' ||
    (value.backendKind !== 'in_process' && value.backendKind !== 'dynamic_worker') ||
    (BUILTIN_PLUGINS.has(value.pluginId) && value.backendKind !== 'in_process') ||
    (!BUILTIN_PLUGINS.has(value.pluginId) && value.backendKind !== 'dynamic_worker') ||
    (value.backendKind === 'in_process' && value.scriptName !== undefined) ||
    (value.backendKind === 'dynamic_worker' &&
      (typeof value.scriptName !== 'string' || !SAFE_SCRIPT.test(value.scriptName)))
  ) {
    throw new Error('plugin_notification_installation_input_invalid');
  }
}

function integer(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('plugin_notification_installation_reflection_invalid');
  }
  return parsed;
}

function assertBatch(results: D1Result<unknown>[], expected: number): void {
  if (
    results.length !== expected ||
    results.some(
      (result) =>
        result.success !== true || result.error !== undefined || (result.meta.changes ?? 0) !== 1
    )
  ) {
    throw new Error('plugin_notification_installation_batch_failed');
  }
}

export class D1NotificationInstallationStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000)
  ) {}

  async configure(input: unknown): Promise<ConfigureNotificationInstallationResult> {
    validate(input);
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 1) {
      throw new Error('plugin_notification_installation_now_invalid');
    }
    const session = primary(this.db);
    const state = input.enabled ? 'enabled' : 'disabled';
    const statements = [
      session
        .prepare(
          `INSERT INTO plugin_runner_installations (
             installation_id, tenant_id, plugin_id, backend_kind, script_name,
             state, config_version, platform_concurrency_cap,
             platform_rate_per_minute, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 1, 8, 120, ?, ?)
           ON CONFLICT(installation_id) DO UPDATE SET
             backend_kind = excluded.backend_kind,
             script_name = excluded.script_name,
             state = excluded.state,
             platform_concurrency_cap = excluded.platform_concurrency_cap,
             platform_rate_per_minute = excluded.platform_rate_per_minute,
             updated_at = excluded.updated_at
           WHERE plugin_runner_installations.tenant_id = excluded.tenant_id
             AND plugin_runner_installations.plugin_id = excluded.plugin_id`
        )
        .bind(
          input.installationId,
          input.tenantId,
          input.pluginId,
          input.backendKind,
          input.scriptName ?? null,
          state,
          now,
          now
        ),
      session
        .prepare(
          `INSERT INTO plugin_runner_hook_policies (
             plugin_id, capability, timeout_ms, failure_policy, max_attempts,
             async_retry_budget_seconds, circuit_breaker_threshold,
             circuit_breaker_cooldown_seconds, updated_at
           ) SELECT ?, 'notifier.send', 30000, 'retry_async', 12, 604800, 5, 60, ?
            WHERE EXISTS (
              SELECT 1 FROM plugin_runner_installations
               WHERE installation_id = ? AND tenant_id = ? AND plugin_id = ?
            )
           ON CONFLICT(plugin_id, capability) DO UPDATE SET
             timeout_ms = excluded.timeout_ms,
             failure_policy = excluded.failure_policy,
             max_attempts = excluded.max_attempts,
             async_retry_budget_seconds = excluded.async_retry_budget_seconds,
             circuit_breaker_threshold = excluded.circuit_breaker_threshold,
             circuit_breaker_cooldown_seconds = excluded.circuit_breaker_cooldown_seconds,
             updated_at = excluded.updated_at`
        )
        .bind(input.pluginId, now, input.installationId, input.tenantId, input.pluginId),
    ];
    if (input.pluginId === 'notifier-resend') {
      statements.push(
        session
          .prepare(
            `INSERT INTO plugin_runner_egress_allowed_hosts (
               plugin_id, rule_id, match_kind, host_pattern, created_at
             ) SELECT 'notifier-resend', 'resend-api', 'exact', 'api.resend.com', ?
              WHERE EXISTS (
                SELECT 1 FROM plugin_runner_installations
                 WHERE installation_id = ? AND tenant_id = ? AND plugin_id = 'notifier-resend'
              )
             ON CONFLICT(plugin_id, rule_id) DO UPDATE SET
               match_kind = excluded.match_kind,
               host_pattern = excluded.host_pattern`
          )
          .bind(now, input.installationId, input.tenantId)
      );
    }
    let batchError: unknown;
    try {
      assertBatch(await session.batch(statements), statements.length);
    } catch (error) {
      batchError = error;
    }
    const [reflected, policy, egress] = await Promise.all([
      session
        .prepare(
          `SELECT installation_id, tenant_id, plugin_id, backend_kind, script_name,
                  state, config_version
             FROM plugin_runner_installations
            WHERE installation_id = ? AND tenant_id = ? AND plugin_id = ?`
        )
        .bind(input.installationId, input.tenantId, input.pluginId)
        .first<InstallationRow>(),
      session
        .prepare(
          `SELECT timeout_ms, failure_policy, max_attempts, async_retry_budget_seconds,
                  circuit_breaker_threshold, circuit_breaker_cooldown_seconds
             FROM plugin_runner_hook_policies
            WHERE plugin_id = ? AND capability = 'notifier.send'`
        )
        .bind(input.pluginId)
        .first<PolicyRow>(),
      input.pluginId === 'notifier-resend'
        ? session
            .prepare(
              `SELECT match_kind, host_pattern
                 FROM plugin_runner_egress_allowed_hosts
                WHERE plugin_id = 'notifier-resend' AND rule_id = 'resend-api'`
            )
            .bind()
            .first<EgressRow>()
        : Promise.resolve(null),
    ]);
    if (
      !reflected ||
      reflected.backend_kind !== input.backendKind ||
      reflected.script_name !== (input.scriptName ?? null) ||
      reflected.state !== state ||
      !policy ||
      integer(policy.timeout_ms) !== 30_000 ||
      policy.failure_policy !== 'retry_async' ||
      integer(policy.max_attempts) !== 12 ||
      integer(policy.async_retry_budget_seconds) !== 604_800 ||
      integer(policy.circuit_breaker_threshold) !== 5 ||
      integer(policy.circuit_breaker_cooldown_seconds) !== 60 ||
      (input.pluginId === 'notifier-resend' &&
        (!egress || egress.match_kind !== 'exact' || egress.host_pattern !== 'api.resend.com'))
    ) {
      if (batchError instanceof Error) throw batchError;
      if (batchError !== undefined) {
        throw new Error('plugin_notification_installation_batch_failed');
      }
      throw new Error('plugin_notification_installation_reflection_invalid');
    }
    return {
      installationId: reflected.installation_id,
      tenantId: reflected.tenant_id,
      pluginId: reflected.plugin_id,
      state,
      configVersion: integer(reflected.config_version),
    };
  }
}
