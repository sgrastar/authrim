import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { readBoundedRequestBody } from './bounded-response';
import { parsePluginExecutionContext } from './execution-context';
import type {
  PluginEgressContext,
  PluginRunnerEnv,
  WritePluginAccountMetadataInput,
  WritePluginAccountMetadataResult,
} from './types';

export const PLUGIN_ACCOUNT_METADATA_URL =
  'https://authrim.invalid/internal/authrim-data/account-metadata';

const MAX_REQUEST_BYTES = 20 * 1024;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 256;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_METADATA_KEY = /^[a-z][a-z0-9._-]{0,63}$/u;
const SAFE_OBJECT_KEY = /^[\x20-\x7e]{1,128}$/u;
const SAFE_BINDING = /^TDB_[A-Z0-9_]{1,120}$/u;
const FINGERPRINT_KEY_ID = 'mutation-v1';

interface AuthorizedInstallationRow {
  plugin_id: string;
}

interface ExistingMutationRow {
  plugin_id: string;
  account_id: string;
  metadata_key: string;
  request_fingerprint: string;
  fingerprint_key_id: string;
  result_version: number | string;
}

interface AccountRow {
  id: string;
}

interface MetadataRow {
  version: number | string;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('plugin_data_d1_session_required');
  }
  return db.withSession('first-primary');
}

function exactRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_data_input_invalid');
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error('plugin_data_input_invalid');
  }
  return value;
}

function safeId(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error('plugin_data_input_invalid');
  }
  return value;
}

function canonicalJson(
  value: unknown,
  state: { nodes: number; ancestors: Set<object> },
  depth = 0
): string {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new Error('plugin_data_input_invalid');
  }
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('plugin_data_input_invalid');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value !== 'object' || value === undefined) {
    throw new Error('plugin_data_input_invalid');
  }
  if (state.ancestors.has(value)) throw new Error('plugin_data_input_invalid');
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 64) throw new Error('plugin_data_input_invalid');
      return `[${value.map((entry) => canonicalJson(entry, state, depth + 1)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length > 64 || keys.some((key) => !SAFE_OBJECT_KEY.test(key))) {
      throw new Error('plugin_data_input_invalid');
    }
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], state, depth + 1)}`)
      .join(',')}}`;
  } finally {
    state.ancestors.delete(value);
  }
}

function inputValue(input: unknown): {
  parsed: WritePluginAccountMetadataInput;
  valueJson: string;
} {
  const value = exactRecord(input, [
    'operationId',
    'accountId',
    'metadataKey',
    'value',
    'expectedVersion',
  ]);
  if (
    typeof value.metadataKey !== 'string' ||
    !SAFE_METADATA_KEY.test(value.metadataKey) ||
    (value.expectedVersion !== null &&
      (!Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 1))
  ) {
    throw new Error('plugin_data_input_invalid');
  }
  const valueJson = canonicalJson(value.value, { nodes: 0, ancestors: new Set() });
  if (new TextEncoder().encode(valueJson).byteLength > MAX_VALUE_BYTES) {
    throw new Error('plugin_data_input_invalid');
  }
  return {
    parsed: {
      operationId: safeId(value.operationId),
      accountId: safeId(value.accountId),
      metadataKey: value.metadataKey,
      value: value.value,
      expectedVersion: value.expectedVersion as number | null,
    },
    valueJson,
  };
}

function integer(value: number | string, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function equalFingerprint(left: string, right: string): boolean {
  if (left.length !== 64 || right.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function tenantDatabase(env: PluginRunnerEnv, context: PluginEgressContext): D1Database {
  const scope = context.executionScope;
  if (!scope || scope.dataRole !== 'tenant_core/users' || !SAFE_BINDING.test(scope.bindingRef)) {
    throw new Error('plugin_data_scope_denied');
  }
  const candidate = env[scope.bindingRef] as Partial<D1Database> | undefined;
  if (
    !candidate ||
    typeof candidate.prepare !== 'function' ||
    typeof candidate.withSession !== 'function'
  ) {
    throw new Error('plugin_data_binding_unavailable');
  }
  return candidate as D1Database;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (request.method !== 'PUT') throw new Error('plugin_data_method_denied');
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim() !== 'application/json') {
    throw new Error('plugin_data_input_invalid');
  }
  const body = await readBoundedRequestBody(
    request,
    MAX_REQUEST_BYTES,
    'plugin_data_input_invalid'
  );
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)
    ) as unknown;
  } catch {
    throw new Error('plugin_data_input_invalid');
  }
}

export function isPluginAccountMetadataRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.href === PLUGIN_ACCOUNT_METADATA_URL;
}

export class PluginAccountMetadataService {
  private readonly fingerprintSecret: string;

  constructor(
    private readonly env: PluginRunnerEnv,
    fingerprintSecret: string = env.PLUGIN_MUTATION_HMAC_KEY,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly executionContext?: PluginEgressContext
  ) {
    if (typeof fingerprintSecret !== 'string' || fingerprintSecret.length < 32) {
      throw new Error('plugin_data_hmac_key_invalid');
    }
    this.fingerprintSecret = fingerprintSecret;
  }

  async handle(request: Request): Promise<Response> {
    const context = parsePluginExecutionContext(
      this.executionContext ?? this.env.AUTHRIM_PLUGIN_EGRESS_CONTEXT
    );
    const result = await this.write(context, await readBoundedJson(request));
    return Response.json(result, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  async write(
    contextInput: PluginEgressContext,
    input: unknown
  ): Promise<WritePluginAccountMetadataResult> {
    const context = parsePluginExecutionContext(contextInput);
    const scope = context.executionScope;
    if (!scope || scope.dataRole !== 'tenant_core/users') {
      throw new Error('plugin_data_scope_denied');
    }
    const { parsed, valueJson } = inputValue(input);
    if (parsed.accountId !== scope.accountId) {
      throw new Error('plugin_data_scope_denied');
    }
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 1) throw new Error('plugin_data_internal_error');

    const runnerSession = primary(this.env.PLUGIN_RUNNER_DB);
    const installation = await runnerSession
      .prepare(
        `SELECT installation.plugin_id
           FROM plugin_runner_installations AS installation
           JOIN plugin_runner_approved_mutation_scopes AS approved
             ON approved.plugin_id = installation.plugin_id
            AND approved.mutation_scope = 'account.metadata.write'
           JOIN plugin_runner_installation_mutation_scopes AS enabled_scope
             ON enabled_scope.installation_id = installation.installation_id
            AND enabled_scope.mutation_scope = approved.mutation_scope
            AND enabled_scope.state = 'enabled'
          WHERE installation.installation_id = ? AND installation.tenant_id = ?
            AND installation.state = 'enabled'`
      )
      .bind(context.pluginInstallationId, context.tenantId)
      .first<AuthorizedInstallationRow>();
    if (!installation || !SAFE_ID.test(installation.plugin_id)) {
      throw new Error('plugin_data_scope_denied');
    }

    const tenantSession = primary(tenantDatabase(this.env, context));
    const fingerprintPayload = canonicalJson(
      {
        tenantId: context.tenantId,
        installationId: context.pluginInstallationId,
        pluginId: installation.plugin_id,
        operationId: parsed.operationId,
        accountId: parsed.accountId,
        metadataKey: parsed.metadataKey,
        expectedVersion: parsed.expectedVersion,
        value: parsed.value,
      },
      { nodes: 0, ancestors: new Set() }
    );
    const existing = await this.findMutation(tenantSession, context, parsed.operationId);
    if (existing) {
      return this.adoptExisting(
        existing,
        context,
        parsed,
        installation.plugin_id,
        fingerprintPayload
      );
    }

    const account = await tenantSession
      .prepare(
        `SELECT id FROM identity_accounts
          WHERE id = ? AND tenant_id = ? AND lifecycle_state = 'active'`
      )
      .bind(parsed.accountId, context.tenantId)
      .first<AccountRow>();
    if (!account) throw new Error('plugin_data_account_unavailable');

    const current = await tenantSession
      .prepare(
        `SELECT version FROM plugin_account_metadata
          WHERE tenant_id = ? AND account_id = ? AND plugin_id = ? AND metadata_key = ?`
      )
      .bind(context.tenantId, parsed.accountId, installation.plugin_id, parsed.metadataKey)
      .first<MetadataRow>();
    const currentVersion = current ? integer(current.version, 'plugin_data_state_invalid') : null;
    if (
      (parsed.expectedVersion === null && currentVersion !== null) ||
      (parsed.expectedVersion !== null && currentVersion !== parsed.expectedVersion)
    ) {
      throw new Error('plugin_data_version_conflict');
    }
    const resultVersion = parsed.expectedVersion === null ? 1 : parsed.expectedVersion + 1;
    const fingerprint = await hmacHex(
      this.fingerprintSecret,
      `authrim-plugin-account-metadata-v1\0${fingerprintPayload}`
    );
    const mutation =
      parsed.expectedVersion === null
        ? tenantSession
            .prepare(
              `INSERT INTO plugin_account_metadata (
                 tenant_id, account_id, plugin_id, plugin_installation_id,
                 metadata_key, value_json, version, created_at, updated_at
               )
               SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?
                WHERE EXISTS (
                  SELECT 1 FROM identity_accounts
                   WHERE id = ? AND tenant_id = ? AND lifecycle_state = 'active'
                )
               ON CONFLICT(tenant_id, account_id, plugin_id, metadata_key) DO NOTHING`
            )
            .bind(
              context.tenantId,
              parsed.accountId,
              installation.plugin_id,
              context.pluginInstallationId,
              parsed.metadataKey,
              valueJson,
              now,
              now,
              parsed.accountId,
              context.tenantId
            )
        : tenantSession
            .prepare(
              `UPDATE plugin_account_metadata
                  SET plugin_installation_id = ?, value_json = ?, version = version + 1,
                      updated_at = ?
                WHERE tenant_id = ? AND account_id = ? AND plugin_id = ? AND metadata_key = ?
                  AND version = ?
                  AND EXISTS (
                    SELECT 1 FROM identity_accounts
                     WHERE id = ? AND tenant_id = ? AND lifecycle_state = 'active'
                  )`
            )
            .bind(
              context.pluginInstallationId,
              valueJson,
              now,
              context.tenantId,
              parsed.accountId,
              installation.plugin_id,
              parsed.metadataKey,
              parsed.expectedVersion,
              parsed.accountId,
              context.tenantId
            );
    const statements = [
      mutation,
      tenantSession
        .prepare(
          `INSERT INTO plugin_account_metadata_mutations (
             tenant_id, plugin_installation_id, operation_id, plugin_id, account_id,
             metadata_key, request_fingerprint, fingerprint_key_id, result_version,
             request_id, capability, data_role, residency_partition, applied_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tenant_core/users', ?, ?
            WHERE changes() = 1`
        )
        .bind(
          context.tenantId,
          context.pluginInstallationId,
          parsed.operationId,
          installation.plugin_id,
          parsed.accountId,
          parsed.metadataKey,
          fingerprint,
          FINGERPRINT_KEY_ID,
          resultVersion,
          context.requestId,
          context.capability,
          scope.residencyPartition,
          now
        ),
      tenantSession
        .prepare(
          `INSERT INTO plugin_account_metadata_audit (
             tenant_id, plugin_installation_id, operation_id, plugin_id, account_id,
             metadata_key, result_version, actor_type, request_id, capability,
             mutation_scope, data_role, residency_partition, created_at
           )
           SELECT tenant_id, plugin_installation_id, operation_id, plugin_id, account_id,
                  metadata_key, result_version, 'plugin', request_id, capability,
                  'account.metadata.write', data_role, residency_partition, ?
             FROM plugin_account_metadata_mutations
            WHERE tenant_id = ? AND plugin_installation_id = ? AND operation_id = ?`
        )
        .bind(now, context.tenantId, context.pluginInstallationId, parsed.operationId),
    ];
    try {
      await tenantSession.batch(statements);
    } catch {
      const adopted = await this.findMutation(tenantSession, context, parsed.operationId);
      if (adopted) {
        return this.adoptExisting(
          adopted,
          context,
          parsed,
          installation.plugin_id,
          fingerprintPayload
        );
      }
      throw new Error('plugin_data_write_failed');
    }
    const applied = await this.findMutation(tenantSession, context, parsed.operationId);
    if (!applied) throw new Error('plugin_data_version_conflict');
    return this.adoptExisting(applied, context, parsed, installation.plugin_id, fingerprintPayload);
  }

  private findMutation(
    session: D1DatabaseSession,
    context: PluginEgressContext,
    operationId: string
  ): Promise<ExistingMutationRow | null> {
    return session
      .prepare(
        `SELECT plugin_id, account_id, metadata_key, request_fingerprint,
                fingerprint_key_id, result_version
           FROM plugin_account_metadata_mutations
          WHERE tenant_id = ? AND plugin_installation_id = ? AND operation_id = ?`
      )
      .bind(context.tenantId, context.pluginInstallationId, operationId)
      .first<ExistingMutationRow>();
  }

  private async adoptExisting(
    existing: ExistingMutationRow,
    context: PluginEgressContext,
    input: WritePluginAccountMetadataInput,
    pluginId: string,
    fingerprintPayload: string
  ): Promise<WritePluginAccountMetadataResult> {
    if (existing.fingerprint_key_id !== FINGERPRINT_KEY_ID) {
      throw new Error('plugin_data_idempotency_key_unavailable');
    }
    const expectedFingerprint = await hmacHex(
      this.fingerprintSecret,
      `authrim-plugin-account-metadata-v1\0${fingerprintPayload}`
    );
    if (
      existing.plugin_id !== pluginId ||
      existing.account_id !== input.accountId ||
      existing.metadata_key !== input.metadataKey ||
      !equalFingerprint(existing.request_fingerprint, expectedFingerprint)
    ) {
      throw new Error('plugin_data_idempotency_conflict');
    }
    return {
      operationId: input.operationId,
      accountId: input.accountId,
      metadataKey: input.metadataKey,
      version: integer(existing.result_version, 'plugin_data_state_invalid'),
    };
  }
}
