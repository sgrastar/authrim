import { WorkerEntrypoint } from 'cloudflare:workers';
import { derivePluginInstallationId, type RuntimeSmokeEntrypointProps } from '@authrim/ar-lib-core';
import { splitMigrationSql } from '@authrim/ar-lib-core/control-plane';
import type {
  D1Database,
  D1DatabaseSession,
  KVNamespace,
  R2Bucket,
} from '@cloudflare/workers-types';
import type { PluginRunnerEnv } from './types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_LOGICAL_RESOURCE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SAFE_HOST_BINDING = /^PRES_(?:D1|KV|R2)_[A-F0-9]{24}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RESOURCES = 16;
const MAX_SQL_BYTES = 64 * 1024;
const MAX_PARAMS = 100;
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;

export type PluginResourceKind = 'd1' | 'kv_namespace' | 'r2_bucket';
export type PluginResourceAccess = 'read_only' | 'read_write';

export interface PluginResourceBindingDescriptor {
  logicalResourceId: string;
  binding: string;
  hostBindingRef: string;
  kind: PluginResourceKind;
  access: PluginResourceAccess;
  ownershipFingerprint: string;
}

export interface PluginResourceBindingProps extends PluginResourceBindingDescriptor {
  tenantId: string;
  pluginId: string;
  installationId: string;
}

interface ResourceRow {
  installation_id: string;
  tenant_id: string;
  plugin_id: string;
  logical_resource_id: string;
  logical_binding_name: string;
  host_binding_ref: string;
  resource_kind: PluginResourceKind;
  access_mode: PluginResourceAccess;
  ownership_fingerprint: string;
  control_operation_id: string;
  state: 'active' | 'disabled';
}

interface ManifestPolicyRow {
  policy_json: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: string
): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(code);
  }
  return value;
}

function boundedString(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(code);
  return value;
}

function resourceDescriptor(value: unknown): PluginResourceBindingDescriptor {
  const record = exactRecord(
    value,
    ['logicalResourceId', 'binding', 'hostBindingRef', 'kind', 'access', 'ownershipFingerprint'],
    'plugin_dynamic_resource_input_invalid'
  );
  const kind = record.kind;
  const access = record.access;
  if (
    (kind !== 'd1' && kind !== 'kv_namespace' && kind !== 'r2_bucket') ||
    (access !== 'read_only' && access !== 'read_write')
  ) {
    throw new Error('plugin_dynamic_resource_input_invalid');
  }
  const hostBindingRef = boundedString(
    record.hostBindingRef,
    SAFE_HOST_BINDING,
    'plugin_dynamic_resource_input_invalid'
  );
  const expectedPrefix =
    kind === 'd1' ? 'PRES_D1_' : kind === 'kv_namespace' ? 'PRES_KV_' : 'PRES_R2_';
  if (!hostBindingRef.startsWith(expectedPrefix)) {
    throw new Error('plugin_dynamic_resource_input_invalid');
  }
  return {
    logicalResourceId: boundedString(
      record.logicalResourceId,
      SAFE_LOGICAL_RESOURCE,
      'plugin_dynamic_resource_input_invalid'
    ),
    binding: boundedString(record.binding, SAFE_BINDING, 'plugin_dynamic_resource_input_invalid'),
    hostBindingRef,
    kind,
    access,
    ownershipFingerprint: boundedString(
      record.ownershipFingerprint,
      SHA256,
      'plugin_dynamic_resource_input_invalid'
    ),
  };
}

function resourceProps(value: unknown): PluginResourceBindingProps {
  const record = exactRecord(
    value,
    [
      'tenantId',
      'pluginId',
      'installationId',
      'logicalResourceId',
      'binding',
      'hostBindingRef',
      'kind',
      'access',
      'ownershipFingerprint',
    ],
    'plugin_dynamic_resource_props_invalid'
  );
  return {
    tenantId: boundedString(record.tenantId, SAFE_ID, 'plugin_dynamic_resource_props_invalid'),
    pluginId: boundedString(
      record.pluginId,
      SAFE_PLUGIN_ID,
      'plugin_dynamic_resource_props_invalid'
    ),
    installationId: boundedString(
      record.installationId,
      SAFE_ID,
      'plugin_dynamic_resource_props_invalid'
    ),
    ...resourceDescriptor({
      logicalResourceId: record.logicalResourceId,
      binding: record.binding,
      hostBindingRef: record.hostBindingRef,
      kind: record.kind,
      access: record.access,
      ownershipFingerprint: record.ownershipFingerprint,
    }),
  };
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('plugin_dynamic_resource_state_unavailable');
  }
  return db.withSession('first-primary');
}

function byteLength(value: string | Uint8Array): number {
  return typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.byteLength;
}

function boundedResult<T>(value: T): T {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('plugin_dynamic_resource_result_invalid');
  }
  if (byteLength(serialized) > MAX_RESULT_BYTES) {
    throw new Error('plugin_dynamic_resource_result_too_large');
  }
  return value;
}

function sqlStatement(value: unknown, mode: 'read' | 'write'): string {
  if (typeof value !== 'string' || byteLength(value) > MAX_SQL_BYTES) {
    throw new Error('plugin_dynamic_resource_sql_invalid');
  }
  let statements: string[];
  try {
    statements = splitMigrationSql(value, {
      maxMigrationBytes: MAX_SQL_BYTES,
      maxStatementBytes: MAX_SQL_BYTES,
      maxStatements: 1,
    });
  } catch {
    throw new Error('plugin_dynamic_resource_sql_invalid');
  }
  const statement = statements.length === 1 ? statements[0] : null;
  if (!statement) throw new Error('plugin_dynamic_resource_sql_invalid');
  const firstToken = statement
    .replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/gu, '')
    .match(/^[A-Za-z]+/u)?.[0]
    ?.toUpperCase();
  const allowed = mode === 'read' ? ['SELECT'] : ['INSERT', 'UPDATE', 'DELETE', 'REPLACE'];
  if (!firstToken || !allowed.includes(firstToken)) {
    throw new Error('plugin_dynamic_resource_sql_denied');
  }
  return statement;
}

function sqlParams(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PARAMS) {
    throw new Error('plugin_dynamic_resource_params_invalid');
  }
  let total = 0;
  return value.map((entry: unknown): unknown => {
    if (
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean' &&
      entry !== null &&
      !(entry instanceof Uint8Array)
    ) {
      throw new Error('plugin_dynamic_resource_params_invalid');
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) {
      throw new Error('plugin_dynamic_resource_params_invalid');
    }
    total +=
      typeof entry === 'string' || entry instanceof Uint8Array
        ? byteLength(entry)
        : JSON.stringify(entry).length;
    if (total > MAX_VALUE_BYTES) throw new Error('plugin_dynamic_resource_params_invalid');
    return entry;
  });
}

function key(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1024 ||
    value.includes('\0')
  ) {
    throw new Error('plugin_dynamic_resource_key_invalid');
  }
  return value;
}

function listInput(value: unknown): { prefix?: string; cursor?: string; limit: number } {
  const record = exactRecord(
    value,
    ['prefix', 'cursor', 'limit'],
    'plugin_dynamic_resource_list_input_invalid'
  );
  if (
    (record.prefix !== null &&
      (typeof record.prefix !== 'string' || record.prefix.length > 1024)) ||
    (record.cursor !== null &&
      (typeof record.cursor !== 'string' || record.cursor.length > 4096)) ||
    !Number.isSafeInteger(record.limit) ||
    (record.limit as number) < 1 ||
    (record.limit as number) > 100
  ) {
    throw new Error('plugin_dynamic_resource_list_input_invalid');
  }
  return {
    ...(record.prefix === null ? {} : { prefix: record.prefix }),
    ...(record.cursor === null ? {} : { cursor: record.cursor }),
    limit: record.limit as number,
  };
}

function asD1(value: unknown): D1Database {
  if (
    !isRecord(value) ||
    typeof value.prepare !== 'function' ||
    typeof value.withSession !== 'function'
  ) {
    throw new Error('plugin_dynamic_resource_binding_unavailable');
  }
  return value as unknown as D1Database;
}

function asKv(value: unknown): KVNamespace {
  if (
    !isRecord(value) ||
    typeof value.get !== 'function' ||
    typeof value.put !== 'function' ||
    typeof value.delete !== 'function' ||
    typeof value.list !== 'function'
  ) {
    throw new Error('plugin_dynamic_resource_binding_unavailable');
  }
  return value as unknown as KVNamespace;
}

function asR2(value: unknown): R2Bucket {
  if (
    !isRecord(value) ||
    typeof value.get !== 'function' ||
    typeof value.head !== 'function' ||
    typeof value.put !== 'function' ||
    typeof value.delete !== 'function' ||
    typeof value.list !== 'function'
  ) {
    throw new Error('plugin_dynamic_resource_binding_unavailable');
  }
  return value as unknown as R2Bucket;
}

async function authorizeResource(
  env: PluginRunnerEnv,
  input: unknown,
  expectedKind?: PluginResourceKind
): Promise<PluginResourceBindingProps> {
  const props = resourceProps(input);
  if (expectedKind && props.kind !== expectedKind) {
    throw new Error('plugin_dynamic_resource_kind_denied');
  }
  const row = await primary(env.PLUGIN_RUNNER_DB)
    .prepare(
      `SELECT installation_id, tenant_id, plugin_id, logical_resource_id,
              logical_binding_name, host_binding_ref, resource_kind, access_mode,
              ownership_fingerprint, control_operation_id, state
         FROM plugin_runner_dynamic_worker_resources
        WHERE installation_id = ? AND tenant_id = ? AND plugin_id = ?
          AND logical_resource_id = ? AND state = 'active'`
    )
    .bind(props.installationId, props.tenantId, props.pluginId, props.logicalResourceId)
    .first<ResourceRow>();
  if (
    !row ||
    row.installation_id !== props.installationId ||
    row.tenant_id !== props.tenantId ||
    row.plugin_id !== props.pluginId ||
    row.logical_resource_id !== props.logicalResourceId ||
    row.logical_binding_name !== props.binding ||
    row.host_binding_ref !== props.hostBindingRef ||
    row.resource_kind !== props.kind ||
    row.access_mode !== props.access ||
    row.ownership_fingerprint !== props.ownershipFingerprint ||
    row.state !== 'active'
  ) {
    throw new Error('plugin_dynamic_resource_scope_denied');
  }
  return props;
}

function assertWriteAccess(props: PluginResourceBindingProps): void {
  if (props.access !== 'read_write') throw new Error('plugin_dynamic_resource_write_denied');
}

export class PluginD1ResourceAccess extends WorkerEntrypoint<
  PluginRunnerEnv,
  PluginResourceBindingProps
> {
  async all(sql: unknown, params?: unknown): Promise<{ results: unknown[] }> {
    const props = await authorizeResource(this.env, this.ctx.props, 'd1');
    const statement = primary(asD1(this.env[props.hostBindingRef])).prepare(
      sqlStatement(sql, 'read')
    );
    const result = await statement.bind(...sqlParams(params)).all();
    if (result.success !== true || !Array.isArray(result.results)) {
      throw new Error('plugin_dynamic_resource_query_failed');
    }
    return boundedResult({ results: result.results });
  }

  async run(sql: unknown, params?: unknown): Promise<{ changes: number }> {
    const props = await authorizeResource(this.env, this.ctx.props, 'd1');
    assertWriteAccess(props);
    const statement = primary(asD1(this.env[props.hostBindingRef])).prepare(
      sqlStatement(sql, 'write')
    );
    const result = await statement.bind(...sqlParams(params)).run();
    const changes = Number(result.meta?.changes ?? 0);
    if (result.success !== true || !Number.isSafeInteger(changes) || changes < 0) {
      throw new Error('plugin_dynamic_resource_query_failed');
    }
    return { changes };
  }
}

export class PluginKvResourceAccess extends WorkerEntrypoint<
  PluginRunnerEnv,
  PluginResourceBindingProps
> {
  async get(input: unknown): Promise<string | null> {
    const props = await authorizeResource(this.env, this.ctx.props, 'kv_namespace');
    const result = await asKv(this.env[props.hostBindingRef]).get(key(input), 'text');
    if (result !== null && byteLength(result) > MAX_VALUE_BYTES) {
      throw new Error('plugin_dynamic_resource_result_too_large');
    }
    return result;
  }

  async put(inputKey: unknown, inputValue: unknown): Promise<void> {
    const props = await authorizeResource(this.env, this.ctx.props, 'kv_namespace');
    assertWriteAccess(props);
    if (typeof inputValue !== 'string' || byteLength(inputValue) > MAX_VALUE_BYTES) {
      throw new Error('plugin_dynamic_resource_value_invalid');
    }
    await asKv(this.env[props.hostBindingRef]).put(key(inputKey), inputValue);
  }

  async delete(input: unknown): Promise<void> {
    const props = await authorizeResource(this.env, this.ctx.props, 'kv_namespace');
    assertWriteAccess(props);
    await asKv(this.env[props.hostBindingRef]).delete(key(input));
  }

  async list(input: unknown) {
    const props = await authorizeResource(this.env, this.ctx.props, 'kv_namespace');
    const result = await asKv(this.env[props.hostBindingRef]).list(listInput(input));
    return boundedResult({
      keys: result.keys.map((entry) => ({
        name: entry.name,
        expiration: entry.expiration ?? null,
      })),
      listComplete: result.list_complete,
      cursor: result.list_complete ? null : result.cursor,
    });
  }
}

export class PluginR2ResourceAccess extends WorkerEntrypoint<
  PluginRunnerEnv,
  PluginResourceBindingProps
> {
  async head(input: unknown) {
    const props = await authorizeResource(this.env, this.ctx.props, 'r2_bucket');
    const object = await asR2(this.env[props.hostBindingRef]).head(key(input));
    return object
      ? { size: object.size, etag: object.etag, uploaded: object.uploaded.toISOString() }
      : null;
  }

  async get(input: unknown): Promise<Uint8Array | null> {
    const props = await authorizeResource(this.env, this.ctx.props, 'r2_bucket');
    const object = await asR2(this.env[props.hostBindingRef]).get(key(input));
    if (!object) return null;
    if (object.size > MAX_VALUE_BYTES) {
      await object.body.cancel();
      throw new Error('plugin_dynamic_resource_result_too_large');
    }
    return new Uint8Array(await object.arrayBuffer());
  }

  async put(inputKey: unknown, inputValue: unknown): Promise<{ etag: string }> {
    const props = await authorizeResource(this.env, this.ctx.props, 'r2_bucket');
    assertWriteAccess(props);
    if (
      (typeof inputValue !== 'string' && !(inputValue instanceof Uint8Array)) ||
      byteLength(inputValue) > MAX_VALUE_BYTES
    ) {
      throw new Error('plugin_dynamic_resource_value_invalid');
    }
    const object = await asR2(this.env[props.hostBindingRef]).put(key(inputKey), inputValue);
    if (!object) throw new Error('plugin_dynamic_resource_write_failed');
    return { etag: object.etag };
  }

  async delete(input: unknown): Promise<void> {
    const props = await authorizeResource(this.env, this.ctx.props, 'r2_bucket');
    assertWriteAccess(props);
    await asR2(this.env[props.hostBindingRef]).delete(key(input));
  }

  async list(input: unknown) {
    const props = await authorizeResource(this.env, this.ctx.props, 'r2_bucket');
    const result = await asR2(this.env[props.hostBindingRef]).list(listInput(input));
    return boundedResult({
      objects: result.objects.map((object) => ({
        key: object.key,
        size: object.size,
        etag: object.etag,
        uploaded: object.uploaded.toISOString(),
      })),
      truncated: result.truncated,
      cursor: result.truncated ? (result.cursor ?? null) : null,
    });
  }
}

function authorizedControl(env: PluginRunnerEnv, props: RuntimeSmokeEntrypointProps): void {
  if (
    props?.caller !== 'ar-control' ||
    props.audience !== 'authrim-runtime-smoke-v1' ||
    !SAFE_ID.test(props.environmentId) ||
    !SAFE_ID.test(props.targetWorker ?? '') ||
    env.AUTHRIM_ENVIRONMENT_NAME !== props.environmentId ||
    env.AUTHRIM_WORKER_SCRIPT_NAME !== props.targetWorker
  ) {
    throw new Error('plugin_dynamic_resource_caller_unauthorized');
  }
}

export function parsePluginManifestResources(
  policyJson: string
): Map<string, Omit<PluginResourceBindingDescriptor, 'hostBindingRef' | 'ownershipFingerprint'>> {
  let policy: unknown;
  try {
    policy = JSON.parse(policyJson);
  } catch {
    throw new Error('plugin_dynamic_resource_manifest_invalid');
  }
  if (
    !isRecord(policy) ||
    !Array.isArray(policy.resources) ||
    policy.resources.length > MAX_RESOURCES
  ) {
    throw new Error('plugin_dynamic_resource_manifest_invalid');
  }
  const resources = new Map<
    string,
    Omit<PluginResourceBindingDescriptor, 'hostBindingRef' | 'ownershipFingerprint'>
  >();
  const bindings = new Set<string>();
  for (const entry of policy.resources) {
    if (!isRecord(entry)) throw new Error('plugin_dynamic_resource_manifest_invalid');
    const logicalResourceId = boundedString(
      entry.logicalResourceId,
      SAFE_LOGICAL_RESOURCE,
      'plugin_dynamic_resource_manifest_invalid'
    );
    if (
      resources.has(logicalResourceId) ||
      !SAFE_BINDING.test(String(entry.binding)) ||
      bindings.has(String(entry.binding)) ||
      (entry.kind !== 'd1' && entry.kind !== 'kv_namespace' && entry.kind !== 'r2_bucket') ||
      (entry.access !== 'read_only' && entry.access !== 'read_write')
    ) {
      throw new Error('plugin_dynamic_resource_manifest_invalid');
    }
    resources.set(logicalResourceId, {
      logicalResourceId,
      binding: entry.binding as string,
      kind: entry.kind,
      access: entry.access,
    });
    bindings.add(entry.binding as string);
  }
  return resources;
}

async function smokeBinding(
  env: PluginRunnerEnv,
  resource: PluginResourceBindingDescriptor
): Promise<void> {
  const binding = env[resource.hostBindingRef];
  if (resource.kind === 'd1') {
    const result = await primary(asD1(binding)).prepare('SELECT 1 AS ok').first<{ ok: number }>();
    if (Number(result?.ok) !== 1) throw new Error('plugin_dynamic_resource_smoke_failed');
    return;
  }
  const smokeKey = `__authrim_resource_smoke__/${resource.ownershipFingerprint}`;
  if (resource.kind === 'kv_namespace') {
    await asKv(binding).get(smokeKey, 'text');
    return;
  }
  await asR2(binding).head(smokeKey);
}

export class PluginResourceControlService {
  constructor(
    private readonly env: PluginRunnerEnv,
    private readonly props: RuntimeSmokeEntrypointProps,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)
  ) {}

  async reflectAndSmoke(input: unknown): Promise<{
    operationId: string;
    installationId: string;
    observedVersionId: string;
    resourceCount: number;
  }> {
    authorizedControl(this.env, this.props);
    const record = exactRecord(
      input,
      ['operationId', 'tenantId', 'pluginId', 'installationId', 'expectedVersionId', 'resources'],
      'plugin_dynamic_resource_control_input_invalid'
    );
    const operationId = boundedString(
      record.operationId,
      SAFE_ID,
      'plugin_dynamic_resource_control_input_invalid'
    );
    const tenantId = boundedString(
      record.tenantId,
      SAFE_ID,
      'plugin_dynamic_resource_control_input_invalid'
    );
    const pluginId = boundedString(
      record.pluginId,
      SAFE_PLUGIN_ID,
      'plugin_dynamic_resource_control_input_invalid'
    );
    const installationId = boundedString(
      record.installationId,
      SAFE_ID,
      'plugin_dynamic_resource_control_input_invalid'
    );
    const expectedVersionId = boundedString(
      record.expectedVersionId,
      SAFE_ID,
      'plugin_dynamic_resource_control_input_invalid'
    );
    if (
      !Array.isArray(record.resources) ||
      record.resources.length < 1 ||
      record.resources.length > MAX_RESOURCES ||
      (await derivePluginInstallationId({
        environmentId: this.env.AUTHRIM_ENVIRONMENT_NAME,
        tenantId,
        pluginId,
        purpose: 'dynamic-plugin',
      })) !== installationId
    ) {
      throw new Error('plugin_dynamic_resource_control_input_invalid');
    }
    const version = this.env.CONTROL_SMOKE_VERSION;
    if (!version || version.id !== expectedVersionId) {
      throw new Error('plugin_dynamic_resource_version_mismatch');
    }
    const resources = record.resources
      .map(resourceDescriptor)
      .sort((left, right) => left.logicalResourceId.localeCompare(right.logicalResourceId));
    if (
      new Set(resources.map((resource) => resource.logicalResourceId)).size !== resources.length ||
      new Set(resources.map((resource) => resource.binding)).size !== resources.length ||
      new Set(resources.map((resource) => resource.hostBindingRef)).size !== resources.length
    ) {
      throw new Error('plugin_dynamic_resource_control_input_invalid');
    }
    const manifest = await primary(this.env.PLUGIN_RUNNER_DB)
      .prepare(
        `SELECT release.policy_json
           FROM plugin_runner_dynamic_worker_manifests manifest
           JOIN plugin_runner_dynamic_worker_releases release
             ON release.plugin_id = manifest.plugin_id
            AND release.version_digest = manifest.active_version_digest
            AND release.state = 'published'
          WHERE manifest.plugin_id = ? AND manifest.state = 'active'`
      )
      .bind(pluginId)
      .first<ManifestPolicyRow>();
    if (!manifest) throw new Error('plugin_dynamic_resource_manifest_unavailable');
    const expected = parsePluginManifestResources(manifest.policy_json);
    if (expected.size !== resources.length) {
      throw new Error('plugin_dynamic_resource_manifest_mismatch');
    }
    for (const resource of resources) {
      const manifestResource = expected.get(resource.logicalResourceId);
      if (
        !manifestResource ||
        manifestResource.binding !== resource.binding ||
        manifestResource.kind !== resource.kind ||
        manifestResource.access !== resource.access
      ) {
        throw new Error('plugin_dynamic_resource_manifest_mismatch');
      }
      await smokeBinding(this.env, resource);
    }

    const now = this.now();
    const session = primary(this.env.PLUGIN_RUNNER_DB);
    const statements = resources.map((resource) =>
      session
        .prepare(
          `INSERT INTO plugin_runner_dynamic_worker_resources (
             installation_id, tenant_id, plugin_id, logical_resource_id,
             logical_binding_name, host_binding_ref, resource_kind, access_mode,
             ownership_fingerprint, control_operation_id, state, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
           ON CONFLICT(installation_id, logical_resource_id) DO UPDATE SET
             control_operation_id = excluded.control_operation_id,
             state = 'active', updated_at = excluded.updated_at
           WHERE plugin_runner_dynamic_worker_resources.tenant_id = excluded.tenant_id
             AND plugin_runner_dynamic_worker_resources.plugin_id = excluded.plugin_id
             AND plugin_runner_dynamic_worker_resources.logical_binding_name =
               excluded.logical_binding_name
             AND plugin_runner_dynamic_worker_resources.host_binding_ref = excluded.host_binding_ref
             AND plugin_runner_dynamic_worker_resources.resource_kind = excluded.resource_kind
             AND plugin_runner_dynamic_worker_resources.access_mode = excluded.access_mode
             AND plugin_runner_dynamic_worker_resources.ownership_fingerprint =
               excluded.ownership_fingerprint
             AND (
               plugin_runner_dynamic_worker_resources.control_operation_id =
                 excluded.control_operation_id
               OR plugin_runner_dynamic_worker_resources.state = 'disabled'
             )`
        )
        .bind(
          installationId,
          tenantId,
          pluginId,
          resource.logicalResourceId,
          resource.binding,
          resource.hostBindingRef,
          resource.kind,
          resource.access,
          resource.ownershipFingerprint,
          operationId,
          now
        )
    );
    const results = await session.batch(statements);
    if (
      results.length !== statements.length ||
      results.some((result) => result.success !== true || (result.meta.changes ?? 0) !== 1)
    ) {
      throw new Error('plugin_dynamic_resource_reflection_conflict');
    }
    const reflected = await session
      .prepare(
        `SELECT installation_id, tenant_id, plugin_id, logical_resource_id,
                logical_binding_name, host_binding_ref, resource_kind, access_mode,
                ownership_fingerprint, control_operation_id, state
           FROM plugin_runner_dynamic_worker_resources
          WHERE installation_id = ? AND tenant_id = ? AND state = 'active'
          ORDER BY logical_resource_id LIMIT 17`
      )
      .bind(installationId, tenantId)
      .all<ResourceRow>();
    if (
      reflected.results.length !== resources.length ||
      reflected.results.some((row, index) => {
        const resource = resources[index];
        return (
          !resource ||
          row.plugin_id !== pluginId ||
          row.logical_resource_id !== resource.logicalResourceId ||
          row.logical_binding_name !== resource.binding ||
          row.host_binding_ref !== resource.hostBindingRef ||
          row.resource_kind !== resource.kind ||
          row.access_mode !== resource.access ||
          row.ownership_fingerprint !== resource.ownershipFingerprint ||
          row.control_operation_id !== operationId
        );
      })
    ) {
      throw new Error('plugin_dynamic_resource_reflection_mismatch');
    }
    return {
      operationId,
      installationId,
      observedVersionId: expectedVersionId,
      resourceCount: resources.length,
    };
  }
}
