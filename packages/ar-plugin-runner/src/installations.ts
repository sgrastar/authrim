import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import type {
  PluginInstallationResolver,
  PluginInstallationTarget,
} from './dynamic-worker-backend';
import type { PluginHookPolicyResolver } from './outbox';
import type { PluginDispatchPolicy } from './dispatch-limiter';
import { parsePluginHostInterfaceBindings } from '@authrim/ar-lib-core/services/plugin-host-interface-contract';
import {
  parsePluginManifestResources,
  type PluginResourceAccess,
  type PluginResourceBindingDescriptor,
  type PluginResourceKind,
} from './resource-bindings';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_CAPABILITY = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const SAFE_SCRIPT = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SAFE_HOST_BINDING = /^PRES_(?:D1|KV|R2)_[A-F0-9]{24}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RESOURCES = 16;

interface TargetRow {
  plugin_id: string;
  script_name: string;
  code_object_key: string;
  code_sha256: string;
  timeout_ms: number | string;
  policy_json: string;
}

interface ResourceRow {
  plugin_id: string;
  logical_resource_id: string;
  logical_binding_name: string;
  host_binding_ref: string;
  resource_kind: PluginResourceKind;
  access_mode: PluginResourceAccess;
  ownership_fingerprint: string;
}

interface PolicyRow {
  plugin_id: string;
  max_attempts: number | string;
  async_retry_budget_seconds: number | string;
  failure_policy: string;
  platform_concurrency_cap: number | string;
  platform_rate_per_minute: number | string;
}

interface BackendRow {
  plugin_id: string;
  backend_kind: string;
  timeout_ms: number | string;
}

function capabilityDefaults(capability: string): {
  concurrencyCap: number;
  ratePerMinute: number;
  maxAttempts: number;
  retryBudgetSeconds: number;
} {
  if (capability.startsWith('notifier.')) {
    return { concurrencyCap: 8, ratePerMinute: 120, maxAttempts: 12, retryBudgetSeconds: 604800 };
  }
  if (capability.startsWith('webhook.')) {
    return { concurrencyCap: 4, ratePerMinute: 60, maxAttempts: 10, retryBudgetSeconds: 259200 };
  }
  return { concurrencyCap: 2, ratePerMinute: 30, maxAttempts: 8, retryBudgetSeconds: 86400 };
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('plugin_runner_installation_d1_session_required');
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

export class D1PluginInstallationResolver
  implements PluginInstallationResolver, PluginHookPolicyResolver
{
  constructor(private readonly db: D1Database) {}

  async resolveBackend(input: {
    tenantId: string;
    pluginInstallationId: string;
    capability: string;
  }): Promise<{
    pluginId: string;
    backendKind: 'dynamic_worker' | 'in_process';
    timeoutMs: number;
  } | null> {
    if (
      !SAFE_ID.test(input.tenantId) ||
      !SAFE_ID.test(input.pluginInstallationId) ||
      !SAFE_CAPABILITY.test(input.capability)
    ) {
      throw new Error('plugin_installation_lookup_invalid');
    }
    const session = primary(this.db);
    const row = await session
      .prepare(
        `SELECT installation.plugin_id, installation.backend_kind,
                COALESCE(dynamic_policy.timeout_ms, builtin_policy.timeout_ms) AS timeout_ms
           FROM plugin_runner_installations installation
           LEFT JOIN plugin_runner_dynamic_worker_artifacts artifact
             ON artifact.installation_id = installation.installation_id
            AND artifact.plugin_id = installation.plugin_id AND artifact.state = 'active'
           LEFT JOIN plugin_runner_dynamic_worker_hook_policies dynamic_policy
             ON dynamic_policy.plugin_id = installation.plugin_id
            AND dynamic_policy.version_digest = artifact.version_digest
            AND dynamic_policy.capability = ?
           LEFT JOIN plugin_runner_hook_policies builtin_policy
             ON builtin_policy.plugin_id = installation.plugin_id
            AND builtin_policy.capability = ?
          WHERE installation.installation_id = ? AND installation.tenant_id = ?
            AND installation.state = 'enabled'
            AND ((installation.backend_kind = 'dynamic_worker' AND dynamic_policy.capability IS NOT NULL)
              OR (installation.backend_kind = 'in_process' AND builtin_policy.capability IS NOT NULL))`
      )
      .bind(input.capability, input.capability, input.pluginInstallationId, input.tenantId)
      .first<BackendRow>();
    if (
      !row ||
      !SAFE_PLUGIN_ID.test(row.plugin_id) ||
      (row.backend_kind !== 'dynamic_worker' && row.backend_kind !== 'in_process')
    ) {
      return null;
    }
    return {
      pluginId: row.plugin_id,
      backendKind: row.backend_kind,
      timeoutMs: boundedInteger(row.timeout_ms, 1, 30_000, 'plugin_installation_timeout_invalid'),
    };
  }

  async resolve(input: {
    tenantId: string;
    pluginInstallationId: string;
    capability: string;
  }): Promise<PluginInstallationTarget | null> {
    if (
      !SAFE_ID.test(input.tenantId) ||
      !SAFE_ID.test(input.pluginInstallationId) ||
      !SAFE_CAPABILITY.test(input.capability)
    ) {
      throw new Error('plugin_installation_lookup_invalid');
    }
    const session = primary(this.db);
    const row = await session
      .prepare(
        `SELECT installation.plugin_id, installation.script_name,
                release.code_object_key, release.code_sha256, release.policy_json,
                policy.timeout_ms
           FROM plugin_runner_installations installation
           JOIN plugin_runner_dynamic_worker_artifacts artifact
             ON artifact.installation_id = installation.installation_id
            AND artifact.plugin_id = installation.plugin_id
            AND artifact.state = 'active'
           JOIN plugin_runner_dynamic_worker_manifests manifest
             ON manifest.plugin_id = installation.plugin_id
            AND manifest.state = 'active'
           JOIN plugin_runner_dynamic_worker_releases release
             ON release.plugin_id = artifact.plugin_id
            AND release.version_digest = artifact.version_digest
            AND release.state = 'published'
           JOIN plugin_runner_dynamic_worker_hook_policies policy
             ON policy.plugin_id = installation.plugin_id
            AND policy.version_digest = artifact.version_digest
            AND policy.capability = ?
          WHERE installation.installation_id = ? AND installation.tenant_id = ?
            AND installation.state = 'enabled'
            AND installation.backend_kind = 'dynamic_worker'`
      )
      .bind(input.capability, input.pluginInstallationId, input.tenantId)
      .first<TargetRow>();
    if (!row) return null;
    if (
      !SAFE_PLUGIN_ID.test(row.plugin_id) ||
      !SAFE_SCRIPT.test(row.script_name) ||
      typeof row.code_object_key !== 'string' ||
      typeof row.code_sha256 !== 'string'
    ) {
      throw new Error('plugin_installation_script_invalid');
    }
    let policy: unknown;
    try {
      policy = JSON.parse(row.policy_json);
    } catch {
      throw new Error('plugin_installation_host_interface_invalid');
    }
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new Error('plugin_installation_host_interface_invalid');
    }
    const hostInterfaces = parsePluginHostInterfaceBindings(
      (policy as Record<string, unknown>).hostInterfaces,
      'plugin_installation_host_interface_invalid'
    );
    const expectedResources = parsePluginManifestResources(row.policy_json);
    const resourceRows = await session
      .prepare(
        `SELECT plugin_id, logical_resource_id, logical_binding_name, host_binding_ref,
                resource_kind, access_mode, ownership_fingerprint
           FROM plugin_runner_dynamic_worker_resources
          WHERE installation_id = ? AND tenant_id = ? AND state = 'active'
          ORDER BY logical_resource_id
          LIMIT 17`
      )
      .bind(input.pluginInstallationId, input.tenantId)
      .all<ResourceRow>();
    if (
      resourceRows.results.length !== expectedResources.size ||
      resourceRows.results.length > MAX_RESOURCES
    ) {
      throw new Error('plugin_installation_resource_invalid');
    }
    const seenBindings = new Set<string>();
    const seenHostBindings = new Set<string>();
    const resources: PluginResourceBindingDescriptor[] = resourceRows.results.map((resource) => {
      const expected = expectedResources.get(resource.logical_resource_id);
      const prefix =
        resource.resource_kind === 'd1'
          ? 'PRES_D1_'
          : resource.resource_kind === 'kv_namespace'
            ? 'PRES_KV_'
            : resource.resource_kind === 'r2_bucket'
              ? 'PRES_R2_'
              : null;
      if (
        resource.plugin_id !== row.plugin_id ||
        !expected ||
        expected.binding !== resource.logical_binding_name ||
        expected.kind !== resource.resource_kind ||
        expected.access !== resource.access_mode ||
        !SAFE_BINDING.test(resource.logical_binding_name) ||
        !SAFE_HOST_BINDING.test(resource.host_binding_ref) ||
        !prefix ||
        !resource.host_binding_ref.startsWith(prefix) ||
        !SHA256.test(resource.ownership_fingerprint) ||
        seenBindings.has(resource.logical_binding_name) ||
        seenHostBindings.has(resource.host_binding_ref)
      ) {
        throw new Error('plugin_installation_resource_invalid');
      }
      seenBindings.add(resource.logical_binding_name);
      seenHostBindings.add(resource.host_binding_ref);
      return {
        logicalResourceId: resource.logical_resource_id,
        binding: resource.logical_binding_name,
        hostBindingRef: resource.host_binding_ref,
        kind: resource.resource_kind,
        access: resource.access_mode,
        ownershipFingerprint: resource.ownership_fingerprint,
      };
    });
    return {
      pluginId: row.plugin_id,
      scriptName: row.script_name,
      codeObjectKey: row.code_object_key,
      codeSha256: row.code_sha256,
      timeoutMs: boundedInteger(row.timeout_ms, 1, 30_000, 'plugin_installation_timeout_invalid'),
      hostInterfaces,
      resources,
    };
  }

  async resolveDispatchPolicy(input: {
    tenantId: string;
    pluginInstallationId: string;
    capability: string;
  }): Promise<PluginDispatchPolicy> {
    if (
      !SAFE_ID.test(input.tenantId) ||
      !SAFE_ID.test(input.pluginInstallationId) ||
      !SAFE_CAPABILITY.test(input.capability)
    ) {
      throw new Error('plugin_policy_lookup_invalid');
    }
    const row = await primary(this.db)
      .prepare(
        `SELECT installation.plugin_id,
                COALESCE(dynamic_policy.max_attempts, builtin_policy.max_attempts) AS max_attempts,
                COALESCE(dynamic_policy.async_retry_budget_seconds,
                         builtin_policy.async_retry_budget_seconds) AS async_retry_budget_seconds,
                COALESCE(dynamic_policy.failure_policy,
                         builtin_policy.failure_policy) AS failure_policy,
                installation.platform_concurrency_cap, installation.platform_rate_per_minute
           FROM plugin_runner_installations installation
           LEFT JOIN plugin_runner_dynamic_worker_artifacts artifact
             ON artifact.installation_id = installation.installation_id
            AND artifact.plugin_id = installation.plugin_id AND artifact.state = 'active'
           LEFT JOIN plugin_runner_dynamic_worker_hook_policies dynamic_policy
             ON dynamic_policy.plugin_id = installation.plugin_id
            AND dynamic_policy.version_digest = artifact.version_digest
            AND dynamic_policy.capability = ?
           LEFT JOIN plugin_runner_hook_policies builtin_policy
             ON builtin_policy.plugin_id = installation.plugin_id
            AND builtin_policy.capability = ?
          WHERE installation.installation_id = ? AND installation.tenant_id = ?
            AND installation.state = 'enabled'
            AND ((installation.backend_kind = 'dynamic_worker'
                  AND dynamic_policy.capability IS NOT NULL)
              OR (installation.backend_kind = 'in_process' AND builtin_policy.capability IS NOT NULL))`
      )
      .bind(input.capability, input.capability, input.pluginInstallationId, input.tenantId)
      .first<PolicyRow>();
    if (!row || !SAFE_ID.test(row.plugin_id) || row.failure_policy !== 'retry_async') {
      throw new Error('plugin_policy_unavailable');
    }
    const defaults = capabilityDefaults(input.capability);
    return {
      pluginId: row.plugin_id,
      maxAttempts: Math.min(
        defaults.maxAttempts,
        boundedInteger(row.max_attempts, 1, 100, 'plugin_policy_max_attempts_invalid')
      ),
      retryBudgetSeconds: Math.min(
        defaults.retryBudgetSeconds,
        boundedInteger(
          row.async_retry_budget_seconds,
          60,
          604_800,
          'plugin_policy_retry_budget_invalid'
        )
      ),
      concurrencyCap: Math.min(
        defaults.concurrencyCap,
        boundedInteger(row.platform_concurrency_cap, 1, 32, 'plugin_policy_concurrency_invalid')
      ),
      ratePerMinute: Math.min(
        defaults.ratePerMinute,
        boundedInteger(row.platform_rate_per_minute, 1, 10_000, 'plugin_policy_rate_invalid')
      ),
    };
  }
}
