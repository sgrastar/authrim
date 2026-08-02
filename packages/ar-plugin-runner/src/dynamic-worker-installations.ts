import type { D1Database, D1DatabaseSession, D1Result } from '@cloudflare/workers-types';
import { derivePluginInstallationId } from '@authrim/ar-lib-core';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAX_ROLLOUT_BATCH_SIZE = 25;
const ROLLOUT_LEASE_SECONDS = 120;

export interface ConfigureDynamicPluginInstallationInput {
  tenantId: string;
  pluginId: string;
  enabled: boolean;
  activationRequestId?: string;
}

export interface StageDynamicPluginActivationInput {
  tenantId: string;
  pluginId: string;
  activationRequestId: string;
}

export interface StageDynamicPluginActivationResult {
  installationId: string;
  tenantId: string;
  pluginId: string;
  activationRequestId: string;
  state: 'pending';
}

export interface DynamicPluginInstallationResult {
  installationId: string;
  tenantId: string;
  pluginId: string;
  state: 'enabled' | 'disabled';
  configVersion: number;
  pinnedVersionDigest: string | null;
}

export interface ApprovedDynamicPlugin {
  pluginId: string;
  capabilityManifestDigest: string;
  activeVersionDigest: string;
  visibility: 'tenant' | 'platform';
  capabilities: string[];
  credentials: Array<{ configKey: string; required: boolean }>;
  resources: Array<{
    logicalResourceId: string;
    binding: string;
    kind: 'd1' | 'kv_namespace' | 'r2_bucket';
    access: 'read_only' | 'read_write';
    allowExisting: boolean;
  }>;
  updatedAt: number;
}

export interface DynamicPluginInstallationStatus {
  installationId: string;
  tenantId: string;
  pluginId: string;
  state: 'absent' | 'enabled' | 'disabled' | 'blocked';
  configVersion: number;
  configuredKeys: string[];
  missingRequiredFields: string[];
  pinnedVersionDigest: string | null;
}

export interface DynamicPluginRolloutBatchInput {
  operationId: string;
  pluginId: string;
  batchSize: number;
}

export interface DynamicPluginRolloutBatchResult {
  operationId: string;
  pluginId: string;
  targetVersionDigest: string;
  state: 'running' | 'completed' | 'completed_with_errors' | 'blocked';
  cursorInstallationId: string | null;
  processedThisBatch: number;
  succeededCount: number;
  blockedCount: number;
  failedCount: number;
  hasMore: boolean;
  lastErrorCode: string | null;
}

interface ManifestRow {
  active_version_digest: string;
  code_sha256: string;
  code_object_key: string;
  state: string;
  release_state: string;
}

interface InstallationRow {
  installation_id: string;
  tenant_id: string;
  plugin_id: string;
  backend_kind: string;
  script_name: string | null;
  state: string;
  config_version: number | string;
  pending_activation_request_id: string | null;
}

interface ArtifactRow {
  artifact_id: string;
  version_digest: string;
  code_sha256: string;
  code_object_key: string;
  state: string;
  release_state: string;
}

interface ManifestCatalogRow {
  plugin_id: string;
  capability_manifest_digest: string;
  active_version_digest: string;
  policy_json: string;
  updated_at: number | string;
}

interface CredentialSlotRow {
  config_key: string;
  required: number | string;
  destination_host: string;
  injection_kind: string;
  injection_name: string;
}

interface RolloutOperationRow {
  operation_id: string;
  plugin_id: string;
  target_version_digest: string;
  state: string;
  cursor_installation_id: string | null;
  succeeded_count: number | string;
  blocked_count: number | string;
  failed_count: number | string;
  lease_owner: string | null;
  lease_fence: number | string;
  lease_until: number | string | null;
  last_error_code: string | null;
}

interface RolloutCandidateRow {
  installation_id: string;
  tenant_id: string;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('plugin_dynamic_installation_d1_session_required');
  }
  return db.withSession('first-primary');
}

function validate(input: unknown): asserts input is ConfigureDynamicPluginInstallationInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_dynamic_installation_input_invalid');
  }
  const value = input as Partial<ConfigureDynamicPluginInstallationInput>;
  const keys = Object.keys(input).sort().join(',');
  if (
    (keys !== 'enabled,pluginId,tenantId' &&
      keys !== 'activationRequestId,enabled,pluginId,tenantId') ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    typeof value.pluginId !== 'string' ||
    !SAFE_PLUGIN_ID.test(value.pluginId) ||
    typeof value.enabled !== 'boolean' ||
    (value.activationRequestId !== undefined &&
      (value.enabled !== true || !SAFE_ID.test(value.activationRequestId)))
  ) {
    throw new Error('plugin_dynamic_installation_input_invalid');
  }
}

function validateStage(input: unknown): asserts input is StageDynamicPluginActivationInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_dynamic_activation_stage_input_invalid');
  }
  const value = input as Partial<StageDynamicPluginActivationInput>;
  if (
    Object.keys(input).sort().join(',') !== 'activationRequestId,pluginId,tenantId' ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    typeof value.pluginId !== 'string' ||
    !SAFE_PLUGIN_ID.test(value.pluginId) ||
    typeof value.activationRequestId !== 'string' ||
    !SAFE_ID.test(value.activationRequestId)
  ) {
    throw new Error('plugin_dynamic_activation_stage_input_invalid');
  }
}

function validateRolloutBatch(input: unknown): asserts input is DynamicPluginRolloutBatchInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_dynamic_rollout_batch_input_invalid');
  }
  const value = input as Partial<DynamicPluginRolloutBatchInput>;
  if (
    Object.keys(input).sort().join(',') !== 'batchSize,operationId,pluginId' ||
    typeof value.operationId !== 'string' ||
    !SAFE_ID.test(value.operationId) ||
    typeof value.pluginId !== 'string' ||
    !SAFE_PLUGIN_ID.test(value.pluginId) ||
    !Number.isSafeInteger(value.batchSize) ||
    (value.batchSize ?? 0) < 1 ||
    (value.batchSize ?? 0) > MAX_ROLLOUT_BATCH_SIZE
  ) {
    throw new Error('plugin_dynamic_rollout_batch_input_invalid');
  }
}

function integer(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('plugin_dynamic_installation_reflection_invalid');
  }
  return parsed;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertBatch(results: D1Result<unknown>[], expected: number): void {
  if (
    results.length !== expected ||
    results.some(
      (result) =>
        result.success !== true || result.error !== undefined || (result.meta.changes ?? 0) !== 1
    )
  ) {
    throw new Error('plugin_dynamic_installation_batch_failed');
  }
}

export class D1DynamicPluginInstallationStore {
  constructor(
    private readonly db: D1Database,
    private readonly environmentId: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000)
  ) {
    if (!SAFE_ID.test(environmentId)) {
      throw new Error('plugin_dynamic_installation_environment_invalid');
    }
  }

  async stageActivation(input: unknown): Promise<StageDynamicPluginActivationResult> {
    validateStage(input);
    const installationId = await derivePluginInstallationId({
      environmentId: this.environmentId,
      tenantId: input.tenantId,
      pluginId: input.pluginId,
      purpose: 'dynamic-plugin',
    });
    const session = primary(this.db);
    const manifest = await this.activeManifest(session, input.pluginId);
    if (!manifest || manifest.state !== 'active' || manifest.release_state !== 'published') {
      throw new Error('plugin_dynamic_installation_version_unavailable');
    }
    const now = this.timestamp();
    let mutationError: unknown;
    try {
      await session
        .prepare(
          `INSERT INTO plugin_runner_installations (
             installation_id, tenant_id, plugin_id, backend_kind, script_name,
             state, config_version, platform_concurrency_cap,
             platform_rate_per_minute, pending_activation_request_id, created_at, updated_at
           ) VALUES (?, ?, ?, 'dynamic_worker', ?, 'disabled', 1, 4, 60, ?, ?, ?)
           ON CONFLICT(installation_id) DO UPDATE SET
             pending_activation_request_id = excluded.pending_activation_request_id,
             updated_at = excluded.updated_at
           WHERE plugin_runner_installations.tenant_id = excluded.tenant_id
             AND plugin_runner_installations.plugin_id = excluded.plugin_id
             AND plugin_runner_installations.backend_kind = 'dynamic_worker'
             AND plugin_runner_installations.script_name = excluded.script_name
             AND plugin_runner_installations.state = 'disabled'
             AND (plugin_runner_installations.pending_activation_request_id IS NULL OR
                  plugin_runner_installations.pending_activation_request_id =
                    excluded.pending_activation_request_id)`
        )
        .bind(
          installationId,
          input.tenantId,
          input.pluginId,
          input.pluginId,
          input.activationRequestId,
          now,
          now
        )
        .run();
    } catch (error) {
      mutationError = error;
    }
    const reflected = await this.installation(session, input.tenantId, input.pluginId);
    if (
      !reflected ||
      !this.matches(reflected, installationId, { ...input, enabled: false }) ||
      reflected.state !== 'disabled' ||
      reflected.pending_activation_request_id !== input.activationRequestId
    ) {
      if (mutationError instanceof Error) throw mutationError;
      throw new Error('plugin_dynamic_activation_stage_conflict');
    }
    return {
      installationId,
      tenantId: input.tenantId,
      pluginId: input.pluginId,
      activationRequestId: input.activationRequestId,
      state: 'pending',
    };
  }

  async configure(input: unknown): Promise<DynamicPluginInstallationResult> {
    validate(input);
    const installationId = await derivePluginInstallationId({
      environmentId: this.environmentId,
      tenantId: input.tenantId,
      pluginId: input.pluginId,
      purpose: 'dynamic-plugin',
    });
    const session = primary(this.db);
    const existing = await this.installation(session, input.tenantId, input.pluginId);
    if (existing && !this.matches(existing, installationId, input)) {
      throw new Error('plugin_dynamic_installation_identity_conflict');
    }
    if (!input.enabled) {
      if (!existing) {
        const manifest = await this.activeManifest(session, input.pluginId);
        if (!manifest || manifest.state !== 'active' || manifest.release_state !== 'published') {
          throw new Error('plugin_dynamic_installation_version_unavailable');
        }
        const now = this.timestamp();
        await session
          .prepare(
            `INSERT INTO plugin_runner_installations (
               installation_id, tenant_id, plugin_id, backend_kind, script_name,
               state, config_version, platform_concurrency_cap,
               platform_rate_per_minute, pending_activation_request_id, created_at, updated_at
             ) VALUES (?, ?, ?, 'dynamic_worker', ?, 'disabled', 1, 4, 60, NULL, ?, ?)`
          )
          .bind(installationId, input.tenantId, input.pluginId, input.pluginId, now, now)
          .run();
        return this.reflectedResult(session, input, installationId, 'disabled');
      }
      const now = this.timestamp();
      await session.batch([
        session
          .prepare(
            `UPDATE plugin_runner_installations
                  SET state = 'disabled', pending_activation_request_id = NULL, updated_at = ?
                WHERE installation_id = ? AND tenant_id = ? AND plugin_id = ?
                  AND backend_kind = 'dynamic_worker'`
          )
          .bind(now, installationId, input.tenantId, input.pluginId),
        session
          .prepare(
            `UPDATE plugin_runner_dynamic_worker_resources
                  SET state = 'disabled', updated_at = ?
                WHERE installation_id = ? AND tenant_id = ? AND plugin_id = ?
                  AND state = 'active'`
          )
          .bind(now, installationId, input.tenantId, input.pluginId),
      ]);
      const activeResources = await session
        .prepare(
          `SELECT COUNT(*) AS count FROM plugin_runner_dynamic_worker_resources
            WHERE installation_id = ? AND tenant_id = ? AND plugin_id = ? AND state = 'active'`
        )
        .bind(installationId, input.tenantId, input.pluginId)
        .first<{ count: number }>();
      if (Number(activeResources?.count ?? -1) !== 0) {
        throw new Error('plugin_dynamic_installation_resource_disable_failed');
      }
      return this.reflectedResult(session, input, installationId, 'disabled');
    }

    if (
      (input.activationRequestId !== undefined &&
        (!existing || existing.pending_activation_request_id !== input.activationRequestId)) ||
      (input.activationRequestId === undefined &&
        existing !== null &&
        existing.pending_activation_request_id !== null)
    ) {
      throw new Error('plugin_dynamic_activation_request_mismatch');
    }

    const manifest = await this.activeManifest(session, input.pluginId);
    if (!manifest || manifest.state !== 'active' || manifest.release_state !== 'published') {
      throw new Error('plugin_dynamic_installation_version_unavailable');
    }
    const activeArtifact = existing ? await this.activeArtifact(session, installationId) : null;
    if (activeArtifact && activeArtifact.release_state !== 'published') {
      throw new Error('plugin_dynamic_installation_pinned_version_revoked');
    }
    if (existing) {
      await this.assertRequiredCredentials(
        session,
        existing,
        activeArtifact?.version_digest ?? manifest.active_version_digest
      );
    } else if (
      (await this.requiredCredentialCount(
        session,
        input.pluginId,
        manifest.active_version_digest
      )) > 0
    ) {
      throw new Error('plugin_dynamic_installation_credentials_missing');
    }

    const now = this.timestamp();
    const statements = [
      session
        .prepare(
          `INSERT INTO plugin_runner_installations (
             installation_id, tenant_id, plugin_id, backend_kind, script_name,
             state, config_version, platform_concurrency_cap,
             platform_rate_per_minute, pending_activation_request_id, created_at, updated_at
           ) VALUES (?, ?, ?, 'dynamic_worker', ?, 'enabled', 1, 4, 60, NULL, ?, ?)
           ON CONFLICT(installation_id) DO UPDATE SET
             state = 'enabled', pending_activation_request_id = NULL,
             updated_at = excluded.updated_at
           WHERE plugin_runner_installations.tenant_id = excluded.tenant_id
             AND plugin_runner_installations.plugin_id = excluded.plugin_id
             AND plugin_runner_installations.backend_kind = 'dynamic_worker'
             AND plugin_runner_installations.script_name = excluded.script_name
             AND ((? IS NULL AND plugin_runner_installations.pending_activation_request_id IS NULL)
               OR plugin_runner_installations.pending_activation_request_id = ?)`
        )
        .bind(
          installationId,
          input.tenantId,
          input.pluginId,
          input.pluginId,
          now,
          now,
          input.activationRequestId ?? null,
          input.activationRequestId ?? null
        ),
    ];
    if (!activeArtifact) {
      const artifactId = `plugin-artifact-v1-${await sha256(
        JSON.stringify([installationId, manifest.active_version_digest])
      )}`;
      statements.push(
        session
          .prepare(
            `INSERT INTO plugin_runner_dynamic_worker_artifacts (
               artifact_id, installation_id, plugin_id, version_digest,
               state, activated_at, updated_at
             ) VALUES (?, ?, ?, ?, 'active', ?, ?)`
          )
          .bind(
            artifactId,
            installationId,
            input.pluginId,
            manifest.active_version_digest,
            now,
            now
          )
      );
    }
    let batchError: unknown;
    try {
      assertBatch(await session.batch(statements), statements.length);
    } catch (error) {
      batchError = error;
    }
    try {
      return await this.reflectedResult(session, input, installationId, 'enabled');
    } catch (reflectionError) {
      if (batchError instanceof Error) throw batchError;
      if (batchError !== undefined) throw new Error('plugin_dynamic_installation_batch_failed');
      throw reflectionError;
    }
  }

  async listApproved(): Promise<ApprovedDynamicPlugin[]> {
    const rows = await primary(this.db)
      .prepare(
        `SELECT manifest.plugin_id, release.capability_manifest_digest,
                manifest.active_version_digest, release.policy_json, manifest.updated_at
           FROM plugin_runner_dynamic_worker_manifests manifest
           JOIN plugin_runner_dynamic_worker_releases release
             ON release.plugin_id = manifest.plugin_id
            AND release.version_digest = manifest.active_version_digest
            AND release.state = 'published'
          WHERE manifest.state = 'active'
          ORDER BY manifest.plugin_id LIMIT 101`
      )
      .bind()
      .all<ManifestCatalogRow>();
    if (rows.results.length > 100) throw new Error('plugin_dynamic_catalog_limit_exceeded');
    return rows.results.map((row) => this.catalogEntry(row));
  }

  async status(input: unknown): Promise<DynamicPluginInstallationStatus> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('plugin_dynamic_status_input_invalid');
    }
    const value = input as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'pluginId,tenantId') {
      throw new Error('plugin_dynamic_status_input_invalid');
    }
    validate({ tenantId: value.tenantId, pluginId: value.pluginId, enabled: false });
    const tenantId = value.tenantId as string;
    const pluginId = value.pluginId as string;
    const installationId = await derivePluginInstallationId({
      environmentId: this.environmentId,
      tenantId,
      pluginId,
      purpose: 'dynamic-plugin',
    });
    const session = primary(this.db);
    const installation = await this.installation(session, tenantId, pluginId);
    const artifact = installation ? await this.activeArtifact(session, installationId) : null;
    const manifest = await this.activeManifest(session, pluginId);
    const versionDigest =
      installation?.state === 'enabled'
        ? artifact?.version_digest
        : manifest?.active_version_digest;
    const slots = versionDigest ? await this.credentialSlots(session, pluginId, versionDigest) : [];
    if (
      installation &&
      !this.matches(installation, installationId, { tenantId, pluginId, enabled: false })
    ) {
      throw new Error('plugin_dynamic_installation_identity_conflict');
    }
    const configVersion = installation ? integer(installation.config_version) : 1;
    const configuredRows = installation
      ? await session
          .prepare(
            `SELECT config_key FROM plugin_runner_encrypted_configs
              WHERE installation_id = ? AND config_version = ? ORDER BY config_key LIMIT 17`
          )
          .bind(installationId, configVersion)
          .all<{ config_key: string }>()
      : { results: [] };
    if (configuredRows.results.length > 16) {
      throw new Error('plugin_dynamic_status_config_invalid');
    }
    const configuredKeys = configuredRows.results.map((row) => row.config_key);
    const configured = new Set(configuredKeys);
    const state = installation?.state;
    if (state && !['enabled', 'disabled', 'blocked'].includes(state)) {
      throw new Error('plugin_dynamic_status_state_invalid');
    }
    return {
      installationId,
      tenantId,
      pluginId,
      state: (state as 'enabled' | 'disabled' | 'blocked' | undefined) ?? 'absent',
      configVersion,
      configuredKeys,
      missingRequiredFields: slots
        .filter((slot) => Number(slot.required) === 1 && !configured.has(slot.config_key))
        .map((slot) => slot.config_key),
      pinnedVersionDigest: artifact?.version_digest ?? null,
    };
  }

  async credentialInputs(input: unknown): Promise<{
    tenantId: string;
    pluginId: string;
    values: Array<{
      configKey: string;
      destinationHost: string;
      injectionKind: 'header' | 'bearer';
      injectionName: string;
      value: string;
    }>;
  }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('plugin_dynamic_credentials_input_invalid');
    }
    const raw = input as Record<string, unknown>;
    if (
      Object.keys(raw).sort().join(',') !== 'credentials,pluginId,tenantId' ||
      typeof raw.credentials !== 'object' ||
      raw.credentials === null ||
      Array.isArray(raw.credentials)
    ) {
      throw new Error('plugin_dynamic_credentials_input_invalid');
    }
    validate({ tenantId: raw.tenantId, pluginId: raw.pluginId, enabled: false });
    const tenantId = raw.tenantId as string;
    const pluginId = raw.pluginId as string;
    const entries = Object.entries(raw.credentials as Record<string, unknown>);
    if (
      entries.length > 16 ||
      entries.some(
        ([key, value]) =>
          !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(key) ||
          typeof value !== 'string' ||
          value.length < 1 ||
          value.length > 8_192
      )
    ) {
      throw new Error('plugin_dynamic_credentials_input_invalid');
    }
    const session = primary(this.db);
    const installation = await this.installation(session, tenantId, pluginId);
    const artifact = installation
      ? await this.activeArtifact(session, installation.installation_id)
      : null;
    const manifest = await this.activeManifest(session, pluginId);
    const versionDigest =
      installation?.state === 'enabled'
        ? artifact?.version_digest
        : manifest?.active_version_digest;
    if (!versionDigest) throw new Error('plugin_dynamic_credentials_policy_mismatch');
    const slots = await this.credentialSlots(session, pluginId, versionDigest);
    const byKey = new Map(slots.map((slot) => [slot.config_key, slot]));
    const supplied = new Set(entries.map(([key]) => key));
    if (
      entries.some(([key]) => !byKey.has(key)) ||
      slots.some((slot) => Number(slot.required) === 1 && !supplied.has(slot.config_key))
    ) {
      throw new Error('plugin_dynamic_credentials_policy_mismatch');
    }
    return {
      tenantId,
      pluginId,
      values: entries.map(([configKey, value]) => {
        const slot = byKey.get(configKey);
        if (!slot || (slot.injection_kind !== 'header' && slot.injection_kind !== 'bearer')) {
          throw new Error('plugin_dynamic_credentials_policy_mismatch');
        }
        return {
          configKey,
          destinationHost: slot.destination_host,
          injectionKind: slot.injection_kind,
          injectionName: slot.injection_name,
          value: value as string,
        };
      }),
    };
  }

  async rollout(input: unknown): Promise<DynamicPluginInstallationResult> {
    validate(input);
    if (!input.enabled) throw new Error('plugin_dynamic_rollout_input_invalid');
    const installationId = await derivePluginInstallationId({
      environmentId: this.environmentId,
      tenantId: input.tenantId,
      pluginId: input.pluginId,
      purpose: 'dynamic-plugin',
    });
    const session = primary(this.db);
    const [installation, manifest, active] = await Promise.all([
      this.installation(session, input.tenantId, input.pluginId),
      this.activeManifest(session, input.pluginId),
      this.activeArtifact(session, installationId),
    ]);
    if (
      !installation ||
      !this.matches(installation, installationId, input) ||
      (installation.state !== 'enabled' && installation.state !== 'disabled') ||
      !manifest ||
      manifest.state !== 'active' ||
      manifest.release_state !== 'published' ||
      !active
    ) {
      throw new Error('plugin_dynamic_rollout_unavailable');
    }
    if (active.version_digest === manifest.active_version_digest) {
      return this.reflectedResult(session, input, installationId, 'enabled');
    }
    await this.assertRolloutCredentials(session, installation, manifest.active_version_digest);
    const now = this.timestamp();
    const artifactId = `plugin-artifact-v1-${await sha256(
      JSON.stringify([installationId, manifest.active_version_digest])
    )}`;
    const statements = [
      session
        .prepare(
          `UPDATE plugin_runner_dynamic_worker_artifacts
              SET state = 'retired', activated_at = NULL, updated_at = ?
            WHERE artifact_id = ? AND installation_id = ? AND state = 'active'`
        )
        .bind(now, active.artifact_id, installationId),
      session
        .prepare(
          `INSERT INTO plugin_runner_dynamic_worker_artifacts (
             artifact_id, installation_id, plugin_id, version_digest,
             state, activated_at, updated_at
           ) VALUES (?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(artifact_id) DO UPDATE SET
             state = 'active', activated_at = excluded.activated_at,
             updated_at = excluded.updated_at`
        )
        .bind(artifactId, installationId, input.pluginId, manifest.active_version_digest, now, now),
      session
        .prepare(
          `UPDATE plugin_runner_installations SET state = 'enabled', updated_at = ?
            WHERE installation_id = ? AND tenant_id = ? AND plugin_id = ?
              AND state IN ('enabled', 'disabled')`
        )
        .bind(now, installationId, input.tenantId, input.pluginId),
    ];
    let batchError: unknown;
    try {
      assertBatch(await session.batch(statements), statements.length);
    } catch (error) {
      batchError = error;
    }
    try {
      const reflected = await this.reflectedResult(session, input, installationId, 'enabled');
      if (reflected.pinnedVersionDigest !== manifest.active_version_digest) {
        throw new Error('plugin_dynamic_rollout_reflection_invalid');
      }
      return reflected;
    } catch (reflectionError) {
      if (batchError instanceof Error) throw batchError;
      if (batchError !== undefined) throw new Error('plugin_dynamic_rollout_batch_failed');
      throw reflectionError;
    }
  }

  async rolloutBatch(input: unknown): Promise<DynamicPluginRolloutBatchResult> {
    validateRolloutBatch(input);
    const session = primary(this.db);
    let operation = await this.rolloutOperation(session, input.operationId);
    if (!operation) {
      const manifest = await this.activeManifest(session, input.pluginId);
      if (!manifest || manifest.state !== 'active' || manifest.release_state !== 'published') {
        throw new Error('plugin_dynamic_rollout_version_unavailable');
      }
      const createdAt = this.timestamp();
      try {
        await session
          .prepare(
            `INSERT OR IGNORE INTO plugin_runner_dynamic_worker_rollouts (
               operation_id, plugin_id, target_version_digest, state,
               created_at, updated_at
             ) VALUES (?, ?, ?, 'running', ?, ?)`
          )
          .bind(
            input.operationId,
            input.pluginId,
            manifest.active_version_digest,
            createdAt,
            createdAt
          )
          .run();
      } catch {
        throw new Error('plugin_dynamic_rollout_in_progress');
      }
      operation = await this.rolloutOperation(session, input.operationId);
      if (!operation) throw new Error('plugin_dynamic_rollout_in_progress');
    }
    if (operation.plugin_id !== input.pluginId) {
      throw new Error('plugin_dynamic_rollout_idempotency_conflict');
    }
    if (operation.state !== 'running') {
      return this.rolloutBatchResult(operation, 0, false);
    }
    const manifest = await this.activeManifest(session, input.pluginId);
    if (
      !manifest ||
      manifest.state !== 'active' ||
      manifest.release_state !== 'published' ||
      operation.target_version_digest !== manifest.active_version_digest
    ) {
      await session
        .prepare(
          `UPDATE plugin_runner_dynamic_worker_rollouts
              SET state = 'blocked', last_error_code = 'plugin_dynamic_rollout_target_changed',
                  lease_owner = NULL, lease_until = NULL, updated_at = ?
            WHERE operation_id = ? AND state = 'running'
              AND (lease_until IS NULL OR lease_until <= ?)`
        )
        .bind(this.timestamp(), input.operationId, this.timestamp())
        .run();
      throw new Error('plugin_dynamic_rollout_target_changed');
    }

    const now = this.timestamp();
    const leaseOwner = `rollout-${crypto.randomUUID()}`;
    const lease = await session
      .prepare(
        `UPDATE plugin_runner_dynamic_worker_rollouts
            SET lease_owner = ?, lease_until = ?, lease_fence = lease_fence + 1,
                updated_at = ?
          WHERE operation_id = ? AND state = 'running'
            AND (lease_until IS NULL OR lease_until <= ?)`
      )
      .bind(leaseOwner, now + ROLLOUT_LEASE_SECONDS, now, input.operationId, now)
      .run();
    if ((lease.meta.changes ?? 0) !== 1) {
      throw new Error('plugin_dynamic_rollout_in_progress');
    }
    operation = await this.rolloutOperation(session, input.operationId);
    if (!operation || operation.lease_owner !== leaseOwner) {
      throw new Error('plugin_dynamic_rollout_lease_lost');
    }
    const leaseFence = Number(operation.lease_fence);
    if (!Number.isSafeInteger(leaseFence) || leaseFence < 1) {
      throw new Error('plugin_dynamic_rollout_lease_lost');
    }

    let processedThisBatch = 0;
    try {
      const candidates = await session
        .prepare(
          `SELECT installation.installation_id, installation.tenant_id
             FROM plugin_runner_installations installation
             JOIN plugin_runner_dynamic_worker_artifacts artifact
               ON artifact.installation_id = installation.installation_id
              AND artifact.plugin_id = installation.plugin_id AND artifact.state = 'active'
            WHERE installation.plugin_id = ?
              AND installation.backend_kind = 'dynamic_worker'
              AND installation.state = 'enabled'
              AND artifact.version_digest <> ?
              AND (? IS NULL OR installation.installation_id > ?)
            ORDER BY installation.installation_id
            LIMIT ?`
        )
        .bind(
          input.pluginId,
          operation.target_version_digest,
          operation.cursor_installation_id,
          operation.cursor_installation_id,
          input.batchSize + 1
        )
        .all<RolloutCandidateRow>();
      const selected = candidates.results.slice(0, input.batchSize);
      for (const candidate of selected) {
        const currentManifest = await this.activeManifest(session, input.pluginId);
        if (
          !currentManifest ||
          currentManifest.state !== 'active' ||
          currentManifest.release_state !== 'published' ||
          currentManifest.active_version_digest !== operation.target_version_digest
        ) {
          throw new Error('plugin_dynamic_rollout_target_changed');
        }
        let outcome: 'succeeded' | 'blocked' | 'failed' = 'succeeded';
        let errorCode: string | null = null;
        try {
          const result = await this.rollout({
            tenantId: candidate.tenant_id,
            pluginId: input.pluginId,
            enabled: true,
          });
          if (result.pinnedVersionDigest !== operation.target_version_digest) {
            throw new Error('plugin_dynamic_rollout_target_changed');
          }
        } catch (error) {
          const code =
            error instanceof Error && /^plugin_dynamic_[a-z0-9_]+$/u.test(error.message)
              ? error.message
              : 'plugin_dynamic_rollout_failed';
          if (code === 'plugin_dynamic_rollout_target_changed') throw error;
          outcome = code === 'plugin_dynamic_rollout_credentials_required' ? 'blocked' : 'failed';
          errorCode = code;
        }
        const counter =
          outcome === 'succeeded'
            ? 'succeeded_count'
            : outcome === 'blocked'
              ? 'blocked_count'
              : 'failed_count';
        const results = await session.batch([
          session
            .prepare(
              `INSERT INTO plugin_runner_dynamic_worker_rollout_results (
                 operation_id, installation_id, tenant_id, state, error_code, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?)`
            )
            .bind(
              input.operationId,
              candidate.installation_id,
              candidate.tenant_id,
              outcome,
              errorCode,
              this.timestamp()
            ),
          session
            .prepare(
              `UPDATE plugin_runner_dynamic_worker_rollouts
                  SET cursor_installation_id = ?, ${counter} = ${counter} + 1, updated_at = ?
                WHERE operation_id = ? AND state = 'running'
                  AND lease_owner = ? AND lease_fence = ?`
            )
            .bind(
              candidate.installation_id,
              this.timestamp(),
              input.operationId,
              leaseOwner,
              leaseFence
            ),
        ]);
        assertBatch(results, 2);
        processedThisBatch += 1;
      }
      const hasMore = candidates.results.length > input.batchSize;
      operation = await this.rolloutOperation(session, input.operationId);
      if (!operation || operation.lease_owner !== leaseOwner) {
        throw new Error('plugin_dynamic_rollout_lease_lost');
      }
      const terminalState =
        Number(operation.blocked_count) + Number(operation.failed_count) > 0
          ? 'completed_with_errors'
          : 'completed';
      const finish = await session
        .prepare(
          `UPDATE plugin_runner_dynamic_worker_rollouts
              SET state = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
            WHERE operation_id = ? AND state = 'running'
              AND lease_owner = ? AND lease_fence = ?`
        )
        .bind(
          hasMore ? 'running' : terminalState,
          this.timestamp(),
          input.operationId,
          leaseOwner,
          leaseFence
        )
        .run();
      if ((finish.meta.changes ?? 0) !== 1) {
        throw new Error('plugin_dynamic_rollout_lease_lost');
      }
      const reflected = await this.rolloutOperation(session, input.operationId);
      if (!reflected) throw new Error('plugin_dynamic_rollout_reflection_invalid');
      return this.rolloutBatchResult(reflected, processedThisBatch, hasMore);
    } catch (error) {
      const errorCode =
        error instanceof Error && /^plugin_dynamic_[a-z0-9_]+$/u.test(error.message)
          ? error.message
          : 'plugin_dynamic_rollout_failed';
      await session
        .prepare(
          `UPDATE plugin_runner_dynamic_worker_rollouts
              SET state = CASE WHEN ? = 'plugin_dynamic_rollout_target_changed'
                               THEN 'blocked' ELSE state END,
                  lease_owner = NULL, lease_until = NULL, last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND state = 'running'
              AND lease_owner = ? AND lease_fence = ?`
        )
        .bind(errorCode, errorCode, this.timestamp(), input.operationId, leaseOwner, leaseFence)
        .run();
      throw error;
    }
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error('plugin_dynamic_installation_now_invalid');
    }
    return value;
  }

  private rolloutOperation(session: D1DatabaseSession, operationId: string) {
    return session
      .prepare(
        `SELECT operation_id, plugin_id, target_version_digest, state,
                cursor_installation_id, succeeded_count, blocked_count, failed_count,
                lease_owner, lease_fence, lease_until, last_error_code
           FROM plugin_runner_dynamic_worker_rollouts
          WHERE operation_id = ?`
      )
      .bind(operationId)
      .first<RolloutOperationRow>();
  }

  private rolloutBatchResult(
    row: RolloutOperationRow,
    processedThisBatch: number,
    hasMore: boolean
  ): DynamicPluginRolloutBatchResult {
    if (!['running', 'completed', 'completed_with_errors', 'blocked'].includes(row.state)) {
      throw new Error('plugin_dynamic_rollout_reflection_invalid');
    }
    const succeededCount = Number(row.succeeded_count);
    const blockedCount = Number(row.blocked_count);
    const failedCount = Number(row.failed_count);
    if (
      ![succeededCount, blockedCount, failedCount].every(
        (value) => Number.isSafeInteger(value) && value >= 0
      ) ||
      !/^[a-f0-9]{64}$/u.test(row.target_version_digest) ||
      (row.last_error_code !== null && !/^plugin_dynamic_[a-z0-9_]+$/u.test(row.last_error_code))
    ) {
      throw new Error('plugin_dynamic_rollout_reflection_invalid');
    }
    return {
      operationId: row.operation_id,
      pluginId: row.plugin_id,
      targetVersionDigest: row.target_version_digest,
      state: row.state as DynamicPluginRolloutBatchResult['state'],
      cursorInstallationId: row.cursor_installation_id,
      processedThisBatch,
      succeededCount,
      blockedCount,
      failedCount,
      hasMore,
      lastErrorCode: row.last_error_code,
    };
  }

  private installation(session: D1DatabaseSession, tenantId: string, pluginId: string) {
    return session
      .prepare(
        `SELECT installation_id, tenant_id, plugin_id, backend_kind, script_name,
                state, config_version, pending_activation_request_id
           FROM plugin_runner_installations
          WHERE tenant_id = ? AND plugin_id = ?`
      )
      .bind(tenantId, pluginId)
      .first<InstallationRow>();
  }

  private activeManifest(session: D1DatabaseSession, pluginId: string) {
    return session
      .prepare(
        `SELECT manifest.active_version_digest, release.code_sha256,
                release.code_object_key, manifest.state, release.state AS release_state
           FROM plugin_runner_dynamic_worker_manifests manifest
           JOIN plugin_runner_dynamic_worker_releases release
             ON release.plugin_id = manifest.plugin_id
            AND release.version_digest = manifest.active_version_digest
          WHERE manifest.plugin_id = ?`
      )
      .bind(pluginId)
      .first<ManifestRow>();
  }

  private activeArtifact(session: D1DatabaseSession, installationId: string) {
    return session
      .prepare(
        `SELECT artifact.artifact_id, artifact.version_digest, release.code_sha256,
                release.code_object_key, artifact.state, release.state AS release_state
           FROM plugin_runner_dynamic_worker_artifacts artifact
           JOIN plugin_runner_dynamic_worker_releases release
             ON release.plugin_id = artifact.plugin_id
            AND release.version_digest = artifact.version_digest
          WHERE artifact.installation_id = ? AND artifact.state = 'active'`
      )
      .bind(installationId)
      .first<ArtifactRow>();
  }

  private async credentialSlots(
    session: D1DatabaseSession,
    pluginId: string,
    versionDigest: string
  ): Promise<CredentialSlotRow[]> {
    const rows = await session
      .prepare(
        `SELECT config_key, required, destination_host, injection_kind, injection_name
           FROM plugin_runner_dynamic_worker_credential_slots
          WHERE plugin_id = ? AND version_digest = ? ORDER BY config_key LIMIT 17`
      )
      .bind(pluginId, versionDigest)
      .all<CredentialSlotRow>();
    if (rows.results.length > 16) {
      throw new Error('plugin_dynamic_credential_policy_invalid');
    }
    return rows.results;
  }

  private catalogEntry(row: ManifestCatalogRow): ApprovedDynamicPlugin {
    let policy: unknown;
    try {
      policy = JSON.parse(row.policy_json);
    } catch {
      throw new Error('plugin_dynamic_catalog_policy_invalid');
    }
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new Error('plugin_dynamic_catalog_policy_invalid');
    }
    const value = policy as Record<string, unknown>;
    if (
      value.backend !== 'dynamic_worker' ||
      value.resourceScope !== 'tenant' ||
      (value.visibility !== 'tenant' && value.visibility !== 'platform') ||
      !Array.isArray(value.capabilities) ||
      !Array.isArray(value.credentials) ||
      !Array.isArray(value.resources) ||
      value.resources.length > 16
    ) {
      throw new Error('plugin_dynamic_catalog_policy_invalid');
    }
    const capabilities = value.capabilities.map((entry) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as Record<string, unknown>).name !== 'string'
      ) {
        throw new Error('plugin_dynamic_catalog_policy_invalid');
      }
      return (entry as { name: string }).name;
    });
    const credentials = value.credentials.map((entry) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as Record<string, unknown>).configKey !== 'string' ||
        typeof (entry as Record<string, unknown>).required !== 'boolean'
      ) {
        throw new Error('plugin_dynamic_catalog_policy_invalid');
      }
      return {
        configKey: (entry as { configKey: string }).configKey,
        required: (entry as { required: boolean }).required,
      };
    });
    const resourceIds = new Set<string>();
    const resources = value.resources.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('plugin_dynamic_catalog_policy_invalid');
      }
      const resource = entry as Record<string, unknown>;
      const provisioning = resource.provisioning;
      if (
        typeof resource.logicalResourceId !== 'string' ||
        !SAFE_PLUGIN_ID.test(resource.logicalResourceId) ||
        resourceIds.has(resource.logicalResourceId) ||
        typeof resource.binding !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,127}$/u.test(resource.binding) ||
        !['d1', 'kv_namespace', 'r2_bucket'].includes(String(resource.kind)) ||
        !['read_only', 'read_write'].includes(String(resource.access)) ||
        !provisioning ||
        typeof provisioning !== 'object' ||
        Array.isArray(provisioning) ||
        (provisioning as Record<string, unknown>).defaultMode !== 'managed' ||
        typeof (provisioning as Record<string, unknown>).allowExisting !== 'boolean'
      ) {
        throw new Error('plugin_dynamic_catalog_policy_invalid');
      }
      resourceIds.add(resource.logicalResourceId);
      return {
        logicalResourceId: resource.logicalResourceId,
        binding: resource.binding,
        kind: resource.kind as 'd1' | 'kv_namespace' | 'r2_bucket',
        access: resource.access as 'read_only' | 'read_write',
        allowExisting: (provisioning as Record<string, unknown>).allowExisting as boolean,
      };
    });
    const updatedAt = Number(row.updated_at);
    if (
      !SAFE_PLUGIN_ID.test(row.plugin_id) ||
      !/^[a-f0-9]{64}$/u.test(row.capability_manifest_digest) ||
      !/^[a-f0-9]{64}$/u.test(row.active_version_digest) ||
      !Number.isSafeInteger(updatedAt) ||
      updatedAt < 1
    ) {
      throw new Error('plugin_dynamic_catalog_policy_invalid');
    }
    return {
      pluginId: row.plugin_id,
      capabilityManifestDigest: row.capability_manifest_digest,
      activeVersionDigest: row.active_version_digest,
      visibility: value.visibility,
      capabilities,
      credentials,
      resources,
      updatedAt,
    };
  }

  private matches(
    row: InstallationRow,
    installationId: string,
    input: ConfigureDynamicPluginInstallationInput
  ): boolean {
    return (
      row.installation_id === installationId &&
      row.tenant_id === input.tenantId &&
      row.plugin_id === input.pluginId &&
      row.backend_kind === 'dynamic_worker' &&
      row.script_name === input.pluginId
    );
  }

  private async assertRequiredCredentials(
    session: D1DatabaseSession,
    installation: InstallationRow,
    versionDigest: string
  ): Promise<void> {
    const row = await session
      .prepare(
        `SELECT COUNT(*) AS missing_count
          FROM plugin_runner_dynamic_worker_credential_slots slot
          WHERE slot.plugin_id = ? AND slot.version_digest = ? AND slot.required = 1
            AND NOT EXISTS (
              SELECT 1 FROM plugin_runner_encrypted_configs config
               WHERE config.installation_id = ?
                 AND config.config_key = slot.config_key
                 AND config.config_version = ?
                 AND config.destination_host = slot.destination_host
                 AND config.injection_kind = slot.injection_kind
                 AND lower(config.injection_name) = lower(slot.injection_name)
            )`
      )
      .bind(
        installation.plugin_id,
        versionDigest,
        installation.installation_id,
        integer(installation.config_version)
      )
      .first<{ missing_count: number | string }>();
    if (!row || Number(row.missing_count) !== 0) {
      throw new Error('plugin_dynamic_installation_credentials_missing');
    }
  }

  private async assertRolloutCredentials(
    session: D1DatabaseSession,
    installation: InstallationRow,
    targetVersionDigest: string
  ): Promise<void> {
    const row = await session
      .prepare(
        `SELECT COUNT(*) AS mismatch_count
           FROM plugin_runner_dynamic_worker_credential_slots slot
           LEFT JOIN plugin_runner_encrypted_configs config
             ON config.installation_id = ?
            AND config.config_version = ?
            AND config.config_key = slot.config_key
          WHERE slot.plugin_id = ? AND slot.version_digest = ?
            AND (
              (slot.required = 1 AND config.config_key IS NULL)
              OR (config.config_key IS NOT NULL AND (
                config.destination_host <> slot.destination_host
                OR config.injection_kind <> slot.injection_kind
                OR lower(config.injection_name) <> lower(slot.injection_name)
              ))
            )`
      )
      .bind(
        installation.installation_id,
        integer(installation.config_version),
        installation.plugin_id,
        targetVersionDigest
      )
      .first<{ mismatch_count: number | string }>();
    const count = Number(row?.mismatch_count);
    if (!Number.isSafeInteger(count) || count !== 0) {
      throw new Error('plugin_dynamic_rollout_credentials_required');
    }
  }

  private async requiredCredentialCount(
    session: D1DatabaseSession,
    pluginId: string,
    versionDigest: string
  ): Promise<number> {
    const row = await session
      .prepare(
        `SELECT COUNT(*) AS required_count
           FROM plugin_runner_dynamic_worker_credential_slots
          WHERE plugin_id = ? AND version_digest = ? AND required = 1`
      )
      .bind(pluginId, versionDigest)
      .first<{ required_count: number | string }>();
    const count = Number(row?.required_count);
    if (!Number.isSafeInteger(count) || count < 0 || count > 16) {
      throw new Error('plugin_dynamic_installation_credential_policy_invalid');
    }
    return count;
  }

  private async reflectedResult(
    session: D1DatabaseSession,
    input: ConfigureDynamicPluginInstallationInput,
    installationId: string,
    state: 'enabled' | 'disabled'
  ): Promise<DynamicPluginInstallationResult> {
    const [installation, artifact] = await Promise.all([
      this.installation(session, input.tenantId, input.pluginId),
      this.activeArtifact(session, installationId),
    ]);
    if (
      !installation ||
      !this.matches(installation, installationId, input) ||
      installation.state !== state ||
      installation.pending_activation_request_id !== null
    ) {
      throw new Error('plugin_dynamic_installation_reflection_invalid');
    }
    if (state === 'enabled' && (!artifact || artifact.release_state !== 'published')) {
      throw new Error('plugin_dynamic_installation_reflection_invalid');
    }
    return {
      installationId,
      tenantId: input.tenantId,
      pluginId: input.pluginId,
      state,
      configVersion: integer(installation.config_version),
      pinnedVersionDigest: artifact?.version_digest ?? null,
    };
  }
}
