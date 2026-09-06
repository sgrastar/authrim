import { pluginResourceHostBindingRef } from '@authrim/ar-lib-core/control-plane';
import { queryD1Rows } from './cloudflare.js';

const SAFE_ENVIRONMENT = /^[a-z][a-z0-9-]{0,62}$/u;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_ACTIVE_PLUGIN_RESOURCES = 128;

export interface ActivePluginRunnerResourceBinding {
  binding: string;
  kind: 'd1' | 'kv_namespace' | 'r2_bucket';
  providerResourceId: string;
  providerName: string;
}

interface ActivePluginResourceRow extends Record<string, unknown> {
  resource_kind: string;
  lifecycle_mode: string;
  provider_resource_id: string | null;
  provider_name: string | null;
  provider_create_state: string;
  provider_creation_date: string | null;
  provider_ownership_marker_key: string | null;
  provider_ownership_id: string | null;
  provider_identity_checkpointed_at: number | null;
  ownership_fingerprint: string | null;
}

export async function loadPluginRunnerResourceBindingsForDeployment(input: {
  controlDatabaseName: string;
  environmentId: string;
  query?: typeof queryD1Rows;
}): Promise<ActivePluginRunnerResourceBinding[]> {
  if (!input.controlDatabaseName.trim()) throw new Error('control_database_name_required');
  if (!SAFE_ENVIRONMENT.test(input.environmentId)) {
    throw new Error('plugin_resource_projection_environment_invalid');
  }
  const query = input.query ?? queryD1Rows;
  const schema = await query<{ name: string }>(
    input.controlDatabaseName,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'control_plugin_desired_resources'"
  );
  if (schema.length === 0) return [];
  if (schema.length !== 1 || schema[0]?.name !== 'control_plugin_desired_resources') {
    throw new Error('plugin_resource_projection_schema_invalid');
  }
  const rows = await query<ActivePluginResourceRow>(
    input.controlDatabaseName,
    `SELECT resource_kind, lifecycle_mode, provider_resource_id, provider_name,
            provider_create_state, provider_creation_date,
            provider_ownership_marker_key, provider_ownership_id,
            provider_identity_checkpointed_at,
            json_extract(desired_spec_json, '$.ownershipFingerprint') AS ownership_fingerprint
       FROM control_plugin_desired_resources
      WHERE environment_id = '${input.environmentId}' AND status IN ('ready', 'active')
      ORDER BY plugin_resource_id
      LIMIT ${MAX_ACTIVE_PLUGIN_RESOURCES + 1}`
  );
  if (rows.length > MAX_ACTIVE_PLUGIN_RESOURCES) {
    throw new Error('plugin_resource_projection_limit_exceeded');
  }
  const bindings = rows.map((row): ActivePluginRunnerResourceBinding => {
    if (
      !['d1', 'kv_namespace', 'r2_bucket'].includes(row.resource_kind) ||
      !['managed', 'existing'].includes(row.lifecycle_mode) ||
      !row.provider_resource_id ||
      !SAFE_PROVIDER_ID.test(row.provider_resource_id) ||
      !row.provider_name ||
      !SAFE_PROVIDER_NAME.test(row.provider_name) ||
      !row.ownership_fingerprint ||
      !SHA256.test(row.ownership_fingerprint) ||
      (row.resource_kind === 'r2_bucket' && row.provider_resource_id !== row.provider_name) ||
      (row.lifecycle_mode === 'managed' &&
        (row.provider_create_state !== 'identified' ||
          !Number.isSafeInteger(row.provider_identity_checkpointed_at) ||
          Number(row.provider_identity_checkpointed_at) < 1 ||
          (row.resource_kind === 'r2_bucket' &&
            (!row.provider_creation_date ||
              !row.provider_ownership_marker_key ||
              !row.provider_ownership_id))))
    ) {
      throw new Error('plugin_resource_projection_row_invalid');
    }
    const kind = row.resource_kind as ActivePluginRunnerResourceBinding['kind'];
    return {
      binding: pluginResourceHostBindingRef(kind, row.ownership_fingerprint),
      kind,
      providerResourceId: row.provider_resource_id,
      providerName: row.provider_name,
    };
  });
  if (new Set(bindings.map((binding) => binding.binding)).size !== bindings.length) {
    throw new Error('plugin_resource_projection_binding_duplicate');
  }
  return bindings.sort((left, right) => left.binding.localeCompare(right.binding));
}
