import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import type { PluginEncryptionKeyring } from './encryption-keyring';
import { D1PluginConfigStore } from './config-store';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const PROVIDERS = {
  'human-verification-cloudflare-turnstile': {
    provider: 'turnstile',
    host: 'challenges.cloudflare.com',
    injectionKind: 'json_field',
    defaultWidgetMode: 'managed',
    allowedWidgetModes: new Set(['managed']),
  },
  'human-verification-hcaptcha': {
    provider: 'hcaptcha',
    host: 'api.hcaptcha.com',
    injectionKind: 'form_field',
    defaultWidgetMode: 'checkbox',
    allowedWidgetModes: new Set(['checkbox', 'invisible']),
  },
  'human-verification-google-recaptcha': {
    provider: 'recaptcha',
    host: 'www.google.com',
    injectionKind: 'form_field',
    defaultWidgetMode: 'checkbox',
    allowedWidgetModes: new Set(['checkbox', 'invisible', 'score']),
  },
} as const;

type ProviderId = keyof typeof PROVIDERS;
type WidgetMode = 'managed' | 'checkbox' | 'invisible' | 'score';

export interface ConfigureHumanVerificationInstallationInput {
  operationId: string;
  installationId: string;
  tenantId: string;
  pluginId: string;
  enabled: boolean;
  config?: {
    siteKey: string;
    secretKey: string;
    expectedHostname?: string;
    widgetMode?: WidgetMode;
    scoreThreshold?: number;
  };
}

export interface ConfigureHumanVerificationInstallationResult {
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

interface ConfigRow {
  provider: string;
  site_key: string;
  expected_hostname: string | null;
  widget_mode: string;
  score_threshold: number | string;
  config_fingerprint: string;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('plugin_human_verification_d1_session_required');
  }
  return db.withSession('first-primary');
}

function integer(value: number | string, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

function validate(input: unknown): asserts input is ConfigureHumanVerificationInstallationInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_human_verification_input_invalid');
  }
  const value = input as Partial<ConfigureHumanVerificationInstallationInput>;
  const expected = [
    ...(value.config === undefined ? [] : ['config']),
    'enabled',
    'installationId',
    'operationId',
    'pluginId',
    'tenantId',
  ].sort();
  if (
    Object.keys(input).sort().join(',') !== expected.join(',') ||
    typeof value.operationId !== 'string' ||
    !SAFE_ID.test(value.operationId) ||
    typeof value.installationId !== 'string' ||
    !SAFE_ID.test(value.installationId) ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    typeof value.pluginId !== 'string' ||
    !(value.pluginId in PROVIDERS) ||
    typeof value.enabled !== 'boolean' ||
    (value.enabled && value.config === undefined)
  ) {
    throw new Error('plugin_human_verification_input_invalid');
  }
}

function normalizeConfig(input: ConfigureHumanVerificationInstallationInput) {
  const provider = PROVIDERS[input.pluginId as ProviderId];
  const config = input.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('plugin_human_verification_config_invalid');
  }
  const expected = [
    ...(config.expectedHostname === undefined ? [] : ['expectedHostname']),
    ...(config.scoreThreshold === undefined ? [] : ['scoreThreshold']),
    'secretKey',
    'siteKey',
    ...(config.widgetMode === undefined ? [] : ['widgetMode']),
  ].sort();
  const siteKey = typeof config.siteKey === 'string' ? config.siteKey.trim() : '';
  const secretKey = typeof config.secretKey === 'string' ? config.secretKey.trim() : '';
  const expectedHostname =
    typeof config.expectedHostname === 'string' && config.expectedHostname.trim()
      ? config.expectedHostname.trim().toLowerCase()
      : null;
  const widgetMode = config.widgetMode ?? provider.defaultWidgetMode;
  const scoreThreshold = config.scoreThreshold ?? 0.5;
  if (
    Object.keys(config).sort().join(',') !== expected.join(',') ||
    siteKey.length < 1 ||
    siteKey.length > 2_048 ||
    secretKey.length < 1 ||
    secretKey.length > 8_192 ||
    (expectedHostname !== null && !SAFE_HOST.test(expectedHostname)) ||
    !provider.allowedWidgetModes.has(widgetMode as never) ||
    typeof scoreThreshold !== 'number' ||
    !Number.isFinite(scoreThreshold) ||
    scoreThreshold < 0 ||
    scoreThreshold > 1
  ) {
    throw new Error('plugin_human_verification_config_invalid');
  }
  return { provider, siteKey, secretKey, expectedHostname, widgetMode, scoreThreshold };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class D1HumanVerificationInstallationStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryption: string | PluginEncryptionKeyring,
    private readonly mutationHmacKey: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000)
  ) {}

  async configure(input: unknown): Promise<ConfigureHumanVerificationInstallationResult> {
    validate(input);
    const provider = PROVIDERS[input.pluginId as ProviderId];
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 1) {
      throw new Error('plugin_human_verification_now_invalid');
    }
    const session = primary(this.db);
    await session.batch([
      session
        .prepare(
          `INSERT INTO plugin_runner_installations (
             installation_id, tenant_id, plugin_id, backend_kind, script_name,
             state, config_version, platform_concurrency_cap,
             platform_rate_per_minute, created_at, updated_at
           ) VALUES (?, ?, ?, 'in_process', NULL, 'disabled', 1, 8, 120, ?, ?)
           ON CONFLICT(installation_id) DO UPDATE SET updated_at = excluded.updated_at
           WHERE plugin_runner_installations.tenant_id = excluded.tenant_id
             AND plugin_runner_installations.plugin_id = excluded.plugin_id
             AND plugin_runner_installations.backend_kind = 'in_process'
             AND plugin_runner_installations.script_name IS NULL`
        )
        .bind(input.installationId, input.tenantId, input.pluginId, now, now),
      session
        .prepare(
          `INSERT INTO plugin_runner_hook_policies (
             plugin_id, capability, timeout_ms, failure_policy, max_attempts,
             async_retry_budget_seconds, circuit_breaker_threshold,
             circuit_breaker_cooldown_seconds, updated_at
           ) SELECT ?, 'human_verification.verify', 10000, 'fail_closed', 1, 60, 5, 60, ?
            WHERE EXISTS (
              SELECT 1 FROM plugin_runner_installations
               WHERE installation_id = ? AND tenant_id = ? AND plugin_id = ?
                 AND backend_kind = 'in_process' AND script_name IS NULL
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
      session
        .prepare(
          `INSERT INTO plugin_runner_egress_allowed_hosts (
             plugin_id, rule_id, match_kind, host_pattern, created_at
           ) SELECT ?, 'siteverify', 'exact', ?, ?
            WHERE EXISTS (
              SELECT 1 FROM plugin_runner_installations
               WHERE installation_id = ? AND tenant_id = ? AND plugin_id = ?
                 AND backend_kind = 'in_process' AND script_name IS NULL
            )
           ON CONFLICT(plugin_id, rule_id) DO UPDATE SET
             match_kind = excluded.match_kind,
             host_pattern = excluded.host_pattern`
        )
        .bind(
          input.pluginId,
          provider.host,
          now,
          input.installationId,
          input.tenantId,
          input.pluginId
        ),
    ]);
    let installation = await this.reflectInstallation(session, input);
    if (!input.enabled) {
      const disabled = await session
        .prepare(
          `UPDATE plugin_runner_installations SET state = 'disabled', updated_at = ?
            WHERE installation_id = ? AND tenant_id = ? AND plugin_id = ?`
        )
        .bind(now, input.installationId, input.tenantId, input.pluginId)
        .run();
      if ((disabled.meta.changes ?? 0) !== 1) {
        throw new Error('plugin_human_verification_reflection_invalid');
      }
      installation = await this.reflectInstallation(session, input);
      return this.result(installation);
    }

    const config = normalizeConfig(input);
    const priorMutation = await session
      .prepare(
        `SELECT target_config_version FROM plugin_runner_config_mutations
          WHERE operation_id = ? AND installation_id = ? AND tenant_id = ?`
      )
      .bind(input.operationId, input.installationId, input.tenantId)
      .first<{ target_config_version: number | string }>();
    const expectedVersion = priorMutation
      ? integer(priorMutation.target_config_version, 'plugin_human_verification_version_invalid') -
        1
      : integer(installation.config_version, 'plugin_human_verification_version_invalid');
    const targetVersion = expectedVersion + 1;
    if (expectedVersion < 1 || !Number.isSafeInteger(targetVersion)) {
      throw new Error('plugin_human_verification_version_invalid');
    }
    const fingerprint = await sha256(
      JSON.stringify([
        'authrim-human-verification-config-v1',
        input.tenantId,
        input.installationId,
        input.pluginId,
        targetVersion,
        config.provider.provider,
        config.siteKey,
        config.expectedHostname,
        config.widgetMode,
        config.scoreThreshold,
      ])
    );
    await session
      .prepare(
        `INSERT INTO plugin_runner_human_verification_configs (
           installation_id, config_version, provider, site_key, expected_hostname,
           widget_mode, score_threshold, config_fingerprint, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, config_version) DO NOTHING`
      )
      .bind(
        input.installationId,
        targetVersion,
        config.provider.provider,
        config.siteKey,
        config.expectedHostname,
        config.widgetMode,
        config.scoreThreshold,
        fingerprint,
        now,
        now
      )
      .run();
    const reflectedConfig = await session
      .prepare(
        `SELECT provider, site_key, expected_hostname, widget_mode, score_threshold,
                config_fingerprint
           FROM plugin_runner_human_verification_configs
          WHERE installation_id = ? AND config_version = ?`
      )
      .bind(input.installationId, targetVersion)
      .first<ConfigRow>();
    if (
      !reflectedConfig ||
      reflectedConfig.provider !== config.provider.provider ||
      reflectedConfig.site_key !== config.siteKey ||
      reflectedConfig.expected_hostname !== config.expectedHostname ||
      reflectedConfig.widget_mode !== config.widgetMode ||
      Number(reflectedConfig.score_threshold) !== config.scoreThreshold ||
      reflectedConfig.config_fingerprint !== fingerprint
    ) {
      throw new Error('plugin_human_verification_config_conflict');
    }

    const replaced = await new D1PluginConfigStore(
      this.db,
      this.encryption,
      this.mutationHmacKey,
      this.now
    ).replaceCredentials({
      operationId: input.operationId,
      tenantId: input.tenantId,
      installationId: input.installationId,
      expectedConfigVersion: expectedVersion,
      credentials: [
        {
          configKey: 'secretKey',
          destinationHost: config.provider.host,
          injectionKind: config.provider.injectionKind,
          injectionName: 'secret',
          value: config.secretKey,
        },
      ],
    });
    if (replaced.configVersion !== targetVersion || replaced.credentialCount !== 1) {
      throw new Error('plugin_human_verification_config_reflection_invalid');
    }
    const enabled = await session
      .prepare(
        `UPDATE plugin_runner_installations SET state = 'enabled', updated_at = ?
          WHERE installation_id = ? AND tenant_id = ? AND plugin_id = ?
            AND config_version = ?`
      )
      .bind(now, input.installationId, input.tenantId, input.pluginId, targetVersion)
      .run();
    if ((enabled.meta.changes ?? 0) !== 1) {
      throw new Error('plugin_human_verification_reflection_invalid');
    }
    installation = await this.reflectInstallation(session, input);
    return this.result(installation);
  }

  private async reflectInstallation(
    session: D1DatabaseSession,
    input: ConfigureHumanVerificationInstallationInput
  ): Promise<InstallationRow> {
    const row = await session
      .prepare(
        `SELECT installation_id, tenant_id, plugin_id, backend_kind, script_name,
                state, config_version
           FROM plugin_runner_installations
          WHERE installation_id = ? AND tenant_id = ? AND plugin_id = ?`
      )
      .bind(input.installationId, input.tenantId, input.pluginId)
      .first<InstallationRow>();
    if (
      !row ||
      row.backend_kind !== 'in_process' ||
      row.script_name !== null ||
      !['enabled', 'disabled'].includes(row.state)
    ) {
      throw new Error('plugin_human_verification_reflection_invalid');
    }
    return row;
  }

  private result(row: InstallationRow): ConfigureHumanVerificationInstallationResult {
    return {
      installationId: row.installation_id,
      tenantId: row.tenant_id,
      pluginId: row.plugin_id,
      state: row.state as 'enabled' | 'disabled',
      configVersion: integer(row.config_version, 'plugin_human_verification_version_invalid'),
    };
  }
}
