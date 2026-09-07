import { z } from 'zod';
import type { Context } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  acknowledgeDirectoryConnectorEpisode,
  applyDirectoryConnectorFleetPolicy,
  createAuthContextFromHono,
  createAuditLogFromContext,
  createErrorResponse,
  listDirectoryConnectorEpisodes,
  listDirectoryConnectorInstances,
  markDirectoryConnectorInstanceStatus,
  refreshDirectoryConnectorDerivedStatuses,
  readResponseTextWithLimit,
  reactivateDirectoryConnectorInstance,
  safeFetch,
  getLogger,
  bumpAuthenticationMethodsCacheRevision,
  directoryIdentityLookupSubject,
  ensureDatabaseAdapter,
  resolveAccountDataContext,
  type DirectoryConnectorInstanceRow,
  type DirectoryConnectorStatusEpisodeRow,
} from '@authrim/ar-lib-core';
import { requireTenantResourceAccess } from '../admin-tenant-access';
import { publishAccountExternalSubjectAddition } from '../account-identifier-addition';

const CATEGORY = 'directory-connectors';
const CONNECTOR_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const WORDWARDEN_CONNECTOR_ID_PATTERN = /^wwcon_[a-zA-Z0-9]{16}$/;
const SECRET_REF_PATTERN =
  /^(env:(AUTHRIM_WORDWARDEN_|WORDWARDEN_)[A-Z0-9_]+|managed:[a-zA-Z0-9_-]{1,64})$/;
const HEARTBEAT_SECRET_REF_PATTERN = /^env:(AUTHRIM_WORDWARDEN_|WORDWARDEN_)[A-Z0-9_]+$/;
const DEFAULT_REQUEST_TIMEOUT_MS = 2500;
const MAX_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_RELAY_VERIFY_TIMEOUT_MS = 5000;
const DEFAULT_RELAY_CHALLENGE_TTL_MS = 30000;
const DEFAULT_RELAY_MAX_PENDING_REQUESTS = 16;
const DEFAULT_RELAY_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE = 10;
const DEFAULT_RELAY_AUTH_FAILURE_BLOCK_MS = 5 * 60 * 1000;
const DEFAULT_RELAY_SECRET_ROTATION_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_STALE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_HEARTBEAT_RETENTION_DAYS = 14;
const MAX_ATTRIBUTE_NAMES = 32;
const MAX_CONNECTORS = 20;
const MAX_PENDING_LIMIT = 100;

const RelayConnectorSettingsSchema = z
  .object({
    verify_timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(MAX_REQUEST_TIMEOUT_MS)
      .default(DEFAULT_RELAY_VERIFY_TIMEOUT_MS),
    max_pending_requests: z
      .number()
      .int()
      .min(1)
      .max(256)
      .default(DEFAULT_RELAY_MAX_PENDING_REQUESTS),
    challenge_ttl_ms: z
      .number()
      .int()
      .min(5000)
      .max(300000)
      .default(DEFAULT_RELAY_CHALLENGE_TTL_MS),
    auth_failure_rate_limit_per_minute: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(DEFAULT_RELAY_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE),
    auth_failure_block_ms: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .default(DEFAULT_RELAY_AUTH_FAILURE_BLOCK_MS),
    secret_rotation_grace_ms: z
      .number()
      .int()
      .min(0)
      .max(86400000)
      .default(DEFAULT_RELAY_SECRET_ROTATION_GRACE_MS),
  })
  .default({
    verify_timeout_ms: DEFAULT_RELAY_VERIFY_TIMEOUT_MS,
    max_pending_requests: DEFAULT_RELAY_MAX_PENDING_REQUESTS,
    challenge_ttl_ms: DEFAULT_RELAY_CHALLENGE_TTL_MS,
    auth_failure_rate_limit_per_minute: DEFAULT_RELAY_AUTH_FAILURE_RATE_LIMIT_PER_MINUTE,
    auth_failure_block_ms: DEFAULT_RELAY_AUTH_FAILURE_BLOCK_MS,
    secret_rotation_grace_ms: DEFAULT_RELAY_SECRET_ROTATION_GRACE_MS,
  });

const OptionalHeartbeatSecretRefSchema = z.union([
  z.literal(''),
  z.string().regex(HEARTBEAT_SECRET_REF_PATTERN),
]);

const HeartbeatConnectorSettingsSchema = z
  .object({
    key_id: z.string().max(128).default(''),
    secret_ref: OptionalHeartbeatSecretRefSchema.default(''),
    previous_key_id: z.string().max(128).default(''),
    previous_secret_ref: OptionalHeartbeatSecretRefSchema.default(''),
    interval_ms: z.number().int().min(30000).max(86400000).default(DEFAULT_HEARTBEAT_INTERVAL_MS),
    stale_after_ms: z
      .number()
      .int()
      .min(60000)
      .max(7 * 86400000)
      .default(DEFAULT_HEARTBEAT_STALE_AFTER_MS),
    retention_days: z.number().int().min(1).max(90).default(DEFAULT_HEARTBEAT_RETENTION_DAYS),
    version_mismatch_policy: z.enum(['warn', 'block']).default('warn'),
    expected_version: z.string().max(64).default(''),
    minimum_version: z.string().max(64).default(''),
    unhealthy_threshold: z.number().int().min(1).max(10).default(1),
    stale_detection_grace_ms: z.number().int().min(0).max(86400000).default(0),
  })
  .default({
    key_id: '',
    secret_ref: '',
    previous_key_id: '',
    previous_secret_ref: '',
    interval_ms: DEFAULT_HEARTBEAT_INTERVAL_MS,
    stale_after_ms: DEFAULT_HEARTBEAT_STALE_AFTER_MS,
    retention_days: DEFAULT_HEARTBEAT_RETENTION_DAYS,
    version_mismatch_policy: 'warn',
    expected_version: '',
    minimum_version: '',
    unhealthy_threshold: 1,
    stale_detection_grace_ms: 0,
  });

const DirectoryConnectorSchema = z.object({
  id: z.string().regex(CONNECTOR_KEY_PATTERN),
  transport: z.enum(['direct', 'relay']).default('direct'),
  endpoint_url: z.string().max(2048).optional().default(''),
  auth_mode: z.literal('hmac').default('hmac'),
  connector_id: z.string().regex(WORDWARDEN_CONNECTOR_ID_PATTERN),
  key_id: z.string().min(1).max(128),
  secret_ref: z.string().regex(SECRET_REF_PATTERN),
  timeouts: z
    .object({
      request_ms: z
        .number()
        .int()
        .min(100)
        .max(MAX_REQUEST_TIMEOUT_MS)
        .default(DEFAULT_REQUEST_TIMEOUT_MS),
    })
    .default({ request_ms: DEFAULT_REQUEST_TIMEOUT_MS }),
  relay: RelayConnectorSettingsSchema,
  heartbeat: HeartbeatConnectorSettingsSchema,
  attribute_names: z.array(z.string().min(1).max(128)).max(MAX_ATTRIBUTE_NAMES).default([]),
});

const DirectoryConnectorsStoredConfigSchema = z.object({
  enabled: z.boolean().default(false),
  default_connector_id: z.string().regex(CONNECTOR_KEY_PATTERN).default('campus'),
  auto_provision: z.boolean().default(false),
  connectors: z.array(DirectoryConnectorSchema).max(MAX_CONNECTORS).default([]),
});

const DirectoryConnectorsUpdateSchema = z.object({
  enabled: z.boolean(),
  default_connector_id: z.string().regex(CONNECTOR_KEY_PATTERN),
  auto_provision: z.boolean(),
  connectors: z.array(DirectoryConnectorSchema).max(MAX_CONNECTORS),
});

const DirectoryPendingActionSchema = z.object({
  action: z.enum(['approve', 'reject', 'link']),
  user_id: z.string().min(1).max(256).optional(),
  reason: z.string().max(1000).optional(),
});

const DirectoryFleetActionSchema = z.object({
  action: z.enum(['acknowledge', 'deactivate', 'reactivate']),
  connector_id: z.string().regex(WORDWARDEN_CONNECTOR_ID_PATTERN),
  reason: z.string().max(1000).optional(),
});

type DirectoryConnectorConfig = z.infer<typeof DirectoryConnectorSchema>;
type DirectoryConnectorsConfig = z.infer<typeof DirectoryConnectorsStoredConfigSchema>;

interface DirectoryConnectorManagedSecretVersion {
  keyId: string;
  secret: string;
  createdAt: string;
}

interface DirectoryConnectorManagedPreviousSecretVersion extends DirectoryConnectorManagedSecretVersion {
  retireAfter: string;
}

interface DirectoryConnectorManagedSecretRecord {
  active: DirectoryConnectorManagedSecretVersion;
  previous?: DirectoryConnectorManagedPreviousSecretVersion;
}

interface DirectoryPendingUserRow {
  id: string;
  tenant_id: string;
  connector_id: string;
  directory_subject: string;
  login_identifier: string;
  status: 'pending' | 'approved' | 'rejected' | 'linked';
  directory_facts_json: string;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
  decided_by: string | null;
  decision_reason: string | null;
  linked_user_id: string | null;
}

const DEFAULT_CONFIG: DirectoryConnectorsConfig = {
  enabled: false,
  default_connector_id: 'campus',
  auto_provision: false,
  connectors: [],
};

function configKey(tenantId: string): string {
  return `settings:tenant:${tenantId}:${CATEGORY}`;
}

function managedSecretKey(tenantId: string, connectorId: string): string {
  return `settings:tenant:${tenantId}:directory-connector-secret:${connectorId}`;
}

function managedSecretRef(connectorId: string): string {
  return `managed:${connectorId}`;
}

function storage(env: Env): KVNamespace | null {
  return env.SETTINGS ?? null;
}

async function invalidateAuthenticationMethodsCacheForDirectoryConnectors(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  reason: string
): Promise<void> {
  try {
    await bumpAuthenticationMethodsCacheRevision(c.env, tenantId);
  } catch (error) {
    getLogger(c)
      .module('DIRECTORY-CONNECTORS')
      .warn('Failed to bump authentication methods cache revision', {
        tenantId,
        reason,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
  }
}

function coreAdapter(c: Context<{ Bindings: Env }>, tenantId: string): DatabaseAdapter {
  return createAuthContextFromHono(c, tenantId).coreAdapter;
}

function adminActorId(c: Context<{ Bindings: Env }>): string {
  const adminAuth = c.get('adminAuth' as never) as { userId?: string } | undefined;
  return adminAuth?.userId ?? 'unknown';
}

function clampPendingLimit(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : 25;
  if (!Number.isFinite(parsed)) return 25;
  return Math.max(1, Math.min(MAX_PENDING_LIMIT, parsed));
}

function safeParseDirectoryFacts(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function serializePendingUser(row: DirectoryPendingUserRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    connector_id: row.connector_id,
    directory_subject: row.directory_subject,
    login_identifier: row.login_identifier,
    status: row.status,
    directory_facts: safeParseDirectoryFacts(row.directory_facts_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    decision_reason: row.decision_reason,
    linked_user_id: row.linked_user_id,
  };
}

function parseJsonField(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw);
    return parsed === null ? null : parsed;
  } catch {
    return null;
  }
}

function serializeFleetInstance(row: DirectoryConnectorInstanceRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    connector_id: row.connector_id,
    instance_id: row.instance_id,
    display_name: row.display_name,
    transport: row.transport,
    version: row.version,
    release_channel: row.release_channel,
    started_at: row.started_at,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    status: row.status,
    health_status: row.health_status,
    health_summary: parseJsonField(row.health_summary_json) ?? {},
    config_fingerprint: row.config_fingerprint,
    config_categories: parseJsonField(row.config_categories_json) ?? [],
    drift_severity: row.drift_severity,
    deactivated_at: row.deactivated_at,
    deactivated_by: row.deactivated_by,
    deactivation_reason: row.deactivation_reason,
    updated_at: row.updated_at,
  };
}

function serializeFleetEpisode(row: DirectoryConnectorStatusEpisodeRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    connector_id: row.connector_id,
    instance_id: row.instance_id,
    status: row.status,
    started_at: row.started_at,
    ended_at: row.ended_at,
    last_seen_at: row.last_seen_at,
    reason: row.reason,
    acknowledged_at: row.acknowledged_at,
    acknowledged_by: row.acknowledged_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeAttributeNames(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeConfig(config: DirectoryConnectorsConfig): DirectoryConnectorsConfig {
  return {
    enabled: config.enabled,
    default_connector_id: config.default_connector_id.trim(),
    auto_provision: config.auto_provision,
    connectors: config.connectors.map((connector) => ({
      ...connector,
      endpoint_url: connector.endpoint_url.trim(),
      auth_mode: 'hmac',
      attribute_names: normalizeAttributeNames(connector.attribute_names),
    })),
  };
}

function validateUniqueConnectorIds(connectors: DirectoryConnectorConfig[]): string | null {
  const ids = new Set<string>();
  const wordwardenConnectorIds = new Set<string>();
  for (const connector of connectors) {
    if (ids.has(connector.id)) {
      return connector.id;
    }
    ids.add(connector.id);
    if (wordwardenConnectorIds.has(connector.connector_id)) {
      return connector.connector_id;
    }
    wordwardenConnectorIds.add(connector.connector_id);
  }
  return null;
}

function isLocalhostHostname(hostname: string): boolean {
  return hostname === 'localhost';
}

function allowsLocalhostHTTP(rawURL: string): boolean {
  try {
    const parsed = new URL(rawURL);
    return parsed.protocol === 'http:' && isLocalhostHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function validateEndpointURL(rawURL: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawURL);
  } catch {
    return 'endpoint_url must be a valid URL';
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && isLocalhostHostname(parsed.hostname)) return null;
  return 'endpoint_url must use https:// except http://localhost for local development';
}

function validateConnectors(config: DirectoryConnectorsConfig): string | null {
  const duplicateId = validateUniqueConnectorIds(config.connectors);
  if (duplicateId) {
    return `duplicate connector id: ${duplicateId}`;
  }
  const connectorIds = new Set(config.connectors.map((connector) => connector.id));
  if (config.enabled && config.connectors.length === 0) {
    return 'at least one connector is required when directory password login is enabled';
  }
  if (config.enabled && !connectorIds.has(config.default_connector_id)) {
    return `default connector does not exist: ${config.default_connector_id}`;
  }
  for (const connector of config.connectors) {
    if (connector.transport === 'direct') {
      const endpointError = validateEndpointURL(connector.endpoint_url);
      if (endpointError) {
        return `${connector.id}: ${endpointError}`;
      }
    }
  }
  return null;
}

async function readConfig(env: Env, tenantId: string): Promise<DirectoryConnectorsConfig> {
  const kv = storage(env);
  if (!kv) return DEFAULT_CONFIG;

  const raw = await kv.get(configKey(tenantId));
  if (!raw) return DEFAULT_CONFIG;

  try {
    const parsed = DirectoryConnectorsStoredConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return DEFAULT_CONFIG;
    return normalizeConfig(parsed.data);
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function writeConfig(
  env: Env,
  tenantId: string,
  config: DirectoryConnectorsConfig
): Promise<void> {
  const kv = storage(env);
  if (!kv) {
    throw new Error('settings storage is not configured');
  }
  await kv.put(configKey(tenantId), JSON.stringify(normalizeConfig(config)));
}

function redactForAudit(config: DirectoryConnectorsConfig) {
  return {
    enabled: config.enabled,
    default_connector_id: config.default_connector_id,
    auto_provision: config.auto_provision,
    connectors: config.connectors.map((connector) => ({
      id: connector.id,
      transport: connector.transport,
      endpoint_url_present: Boolean(connector.endpoint_url),
      auth_mode: connector.auth_mode,
      connector_id: connector.connector_id,
      key_id: connector.key_id,
      secret_ref_present: Boolean(connector.secret_ref),
      timeouts: connector.timeouts,
      relay: connector.relay,
      heartbeat: {
        key_id: connector.heartbeat.key_id,
        secret_ref_present: Boolean(connector.heartbeat.secret_ref),
        previous_key_id: connector.heartbeat.previous_key_id,
        previous_secret_ref_present: Boolean(connector.heartbeat.previous_secret_ref),
        interval_ms: connector.heartbeat.interval_ms,
        stale_after_ms: connector.heartbeat.stale_after_ms,
        retention_days: connector.heartbeat.retention_days,
        version_mismatch_policy: connector.heartbeat.version_mismatch_policy,
        expected_version: connector.heartbeat.expected_version,
        minimum_version: connector.heartbeat.minimum_version,
        unhealthy_threshold: connector.heartbeat.unhealthy_threshold,
        stale_detection_grace_ms: connector.heartbeat.stale_detection_grace_ms,
      },
      attribute_names: connector.attribute_names,
    })),
  };
}

function parseHealthBody(bodyText: string): unknown {
  if (!bodyText) return null;
  try {
    return JSON.parse(bodyText);
  } catch {
    return { raw: bodyText };
  }
}

function directoryRelayInstanceName(tenantId: string, connectorId: string): string {
  return `${encodeURIComponent(tenantId)}:${encodeURIComponent(connectorId)}`;
}

function findConnector(
  config: DirectoryConnectorsConfig,
  connectorId: string
): DirectoryConnectorConfig | null {
  return config.connectors.find((connector) => connector.id === connectorId) ?? null;
}

function replaceConnector(
  config: DirectoryConnectorsConfig,
  connectorId: string,
  nextConnector: DirectoryConnectorConfig
): DirectoryConnectorsConfig {
  return {
    ...config,
    connectors: config.connectors.map((connector) =>
      connector.id === connectorId ? nextConnector : connector
    ),
  };
}

function generateRelaySecret(): string {
  return `wwsec_${base64urlRandom(32)}`;
}

function generateRelayKeyId(): string {
  return `kid_${base64urlRandom(12)}`;
}

function base64urlRandom(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function readManagedSecret(
  env: Env,
  tenantId: string,
  connectorId: string
): Promise<DirectoryConnectorManagedSecretRecord | null> {
  const raw = await storage(env)?.get(managedSecretKey(tenantId, connectorId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DirectoryConnectorManagedSecretRecord;
    return parsed?.active?.keyId && parsed.active.secret ? parsed : null;
  } catch {
    return null;
  }
}

async function writeManagedSecret(
  env: Env,
  tenantId: string,
  connectorId: string,
  secret: DirectoryConnectorManagedSecretRecord
): Promise<void> {
  const kv = storage(env);
  if (!kv) throw new Error('settings storage is not configured');
  await kv.put(managedSecretKey(tenantId, connectorId), JSON.stringify(secret));
}

export async function getDirectoryConnectorsHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantResourceAccess(c, tenantId);
  if (accessError) return accessError;

  const config = await readConfig(c.env, tenantId);
  return c.json({
    tenantId,
    ...config,
  });
}

export async function updateDirectoryConnectorsHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantResourceAccess(c, tenantId);
  if (accessError) return accessError;

  const body = await c.req.json().catch(() => null);
  const parsed = DirectoryConnectorsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const config = normalizeConfig(parsed.data);
  const configError = validateConnectors(config);
  if (configError) {
    return c.json(
      {
        error: 'invalid_directory_connector_config',
        error_description: configError,
      },
      400
    );
  }

  try {
    await writeConfig(c.env, tenantId, config);
    await invalidateAuthenticationMethodsCacheForDirectoryConnectors(
      c,
      tenantId,
      'directory-connectors:update'
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  try {
    await createAuditLogFromContext(
      c as unknown as Parameters<typeof createAuditLogFromContext>[0],
      'directory_connector.updated',
      'directory_connector',
      tenantId,
      {
        tenant_id: tenantId,
        config: redactForAudit(config),
      }
    );
  } catch {
    // Settings were saved successfully. Audit mirroring is best effort here.
  }

  return c.json({
    tenantId,
    ...config,
  });
}

export async function listDirectoryPendingUsersHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantResourceAccess(c, tenantId);
  if (accessError) return accessError;

  const status = c.req.query('status') || 'pending';
  if (!['pending', 'approved', 'rejected', 'linked'].includes(status)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const limit = clampPendingLimit(c.req.query('limit'));
  const connectorId = c.req.query('connector_id');
  if (connectorId && !WORDWARDEN_CONNECTOR_ID_PATTERN.test(connectorId)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const adapter = coreAdapter(c, tenantId);
  const params: unknown[] = [tenantId, status];
  let connectorClause = '';
  if (connectorId) {
    connectorClause = 'AND connector_id = ?';
    params.push(connectorId);
  }
  params.push(limit);

  const rows = await adapter.query<DirectoryPendingUserRow>(
    `SELECT id, tenant_id, connector_id, directory_subject, login_identifier, status,
            directory_facts_json, created_at, updated_at, decided_at, decided_by,
            decision_reason, linked_user_id
       FROM directory_jit_pending_users
      WHERE tenant_id = ? AND status = ?
        ${connectorClause}
      ORDER BY updated_at DESC
      LIMIT ?`,
    params
  );

  return c.json({
    tenantId,
    items: rows.map(serializePendingUser),
  });
}

export async function updateDirectoryPendingUserHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const pendingId = c.req.param('pendingId')!;
  const accessError = await requireTenantResourceAccess(c, tenantId);
  if (accessError) return accessError;

  const body = await c.req.json().catch(() => null);
  const parsed = DirectoryPendingActionSchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const adapter = coreAdapter(c, tenantId);
  const pending = await adapter.queryOne<DirectoryPendingUserRow>(
    `SELECT id, tenant_id, connector_id, directory_subject, login_identifier, status,
            directory_facts_json, created_at, updated_at, decided_at, decided_by,
            decision_reason, linked_user_id
       FROM directory_jit_pending_users
      WHERE tenant_id = ? AND id = ?`,
    [tenantId, pendingId]
  );
  if (!pending) {
    return c.json({ error: 'directory_pending_user_not_found' }, 404);
  }
  if (pending.status !== 'pending') {
    return c.json(
      {
        error: 'directory_pending_user_not_pending',
        error_description: 'Only pending directory users can be updated',
      },
      409
    );
  }

  const now = Date.now();
  const actor = adminActorId(c);
  const reason = parsed.data.reason?.trim() || null;

  if (parsed.data.action === 'reject') {
    const result = await adapter.execute(
      `UPDATE directory_jit_pending_users
          SET status = 'rejected',
              updated_at = ?,
              decided_at = ?,
              decided_by = ?,
              decision_reason = ?
        WHERE tenant_id = ? AND id = ? AND status = 'pending'`,
      [now, now, actor, reason, tenantId, pendingId]
    );
    if (result.rowsAffected !== 1) {
      return c.json(
        {
          error: 'directory_pending_user_not_pending',
          error_description: 'Only pending directory users can be updated',
        },
        409
      );
    }
    await createAuditLogFromContext(
      c as unknown as Parameters<typeof createAuditLogFromContext>[0],
      'directory_jit_pending_user.rejected',
      'directory_jit_pending_user',
      pendingId,
      {
        tenant_id: tenantId,
        connector_id: pending.connector_id,
      }
    ).catch(() => undefined);
    return c.json({ ok: true, id: pendingId, status: 'rejected' });
  }

  if (parsed.data.action === 'approve') {
    const result = await adapter.execute(
      `UPDATE directory_jit_pending_users
          SET status = 'approved',
              updated_at = ?,
              decided_at = ?,
              decided_by = ?,
              decision_reason = ?
        WHERE tenant_id = ? AND id = ? AND status = 'pending'`,
      [now, now, actor, reason, tenantId, pendingId]
    );
    if (result.rowsAffected !== 1) {
      return c.json(
        {
          error: 'directory_pending_user_not_pending',
          error_description: 'Only pending directory users can be updated',
        },
        409
      );
    }
    await createAuditLogFromContext(
      c as unknown as Parameters<typeof createAuditLogFromContext>[0],
      'directory_jit_pending_user.approved',
      'directory_jit_pending_user',
      pendingId,
      {
        tenant_id: tenantId,
        connector_id: pending.connector_id,
      }
    ).catch(() => undefined);
    return c.json({ ok: true, id: pendingId, status: 'approved' });
  }

  const userId = parsed.data.user_id?.trim();
  if (!userId) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  let account;
  try {
    account = await resolveAccountDataContext(c.env, {
      tenantId,
      accountId: `account:${userId}`,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'account_data_route_not_found') {
      return c.json({ error: 'directory_pending_link_user_not_found' }, 404);
    }
    throw error;
  }
  if (account.legacyUserId !== userId) {
    return c.json({ error: 'directory_pending_link_user_not_found' }, 404);
  }
  const accountAdapter = ensureDatabaseAdapter(
    account.coreDb,
    'directory-pending-link-account-core'
  );
  const existingLink = await accountAdapter.queryOne<{ user_id: string }>(
    `SELECT user_id
       FROM directory_identity_links
      WHERE tenant_id = ? AND connector_id = ? AND directory_subject = ?`,
    [tenantId, pending.connector_id, pending.directory_subject]
  );
  if (existingLink && existingLink.user_id !== userId) {
    return c.json(
      {
        error: 'directory_identity_link_conflict',
        error_description: 'Directory subject is already linked to an Authrim user',
      },
      409
    );
  }

  try {
    if (!existingLink) {
      const inserted = await accountAdapter.execute(
        `INSERT INTO directory_identity_links (
       id, tenant_id, connector_id, directory_subject, user_id,
       latest_facts_json, created_at, updated_at, last_login_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(tenant_id, connector_id, directory_subject) DO NOTHING`,
        [
          `dirlink_${crypto.randomUUID()}`,
          tenantId,
          pending.connector_id,
          pending.directory_subject,
          userId,
          pending.directory_facts_json,
          now,
          now,
        ]
      );
      if (inserted.rowsAffected !== 1) {
        throw new Error('directory_identity_link_conflict');
      }
    }

    if (!c.env.ACCOUNT_DIRECTORY) throw new Error('directory_account_directory_unavailable');
    await publishAccountExternalSubjectAddition(
      c.env,
      {
        operationId: `directory-link-route-${pendingId}`,
        idempotencyKey: `directory-link-route:${pendingId}`,
        tenantId,
        accountId: account.accountId,
        externalSubject: directoryIdentityLookupSubject({
          connectorId: pending.connector_id,
          directorySubject: pending.directory_subject,
        }),
        routeProjection: account.membership.routeProjection,
      },
      {
        tenantCoreUsers: accountAdapter,
        directory: c.env.ACCOUNT_DIRECTORY,
      }
    );

    const updated = await adapter.execute(
      `UPDATE directory_jit_pending_users
          SET status = 'linked',
              linked_user_id = ?,
              updated_at = ?,
              decided_at = ?,
              decided_by = ?,
              decision_reason = ?
        WHERE tenant_id = ? AND id = ? AND status = 'pending'`,
      [userId, now, now, actor, reason, tenantId, pendingId]
    );
    if (updated.rowsAffected !== 1) {
      throw new Error('directory_pending_user_not_pending');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'directory_identity_link_conflict') {
      return c.json(
        {
          error: 'directory_identity_link_conflict',
          error_description: 'Directory subject is already linked to an Authrim user',
        },
        409
      );
    }
    if (error instanceof Error && error.message === 'directory_pending_user_not_pending') {
      return c.json(
        {
          error: 'directory_pending_user_not_pending',
          error_description: 'Only pending directory users can be updated',
        },
        409
      );
    }
    throw error;
  }

  await createAuditLogFromContext(
    c as unknown as Parameters<typeof createAuditLogFromContext>[0],
    'directory_jit_pending_user.linked',
    'directory_jit_pending_user',
    pendingId,
    {
      tenant_id: tenantId,
      connector_id: pending.connector_id,
      user_id: userId,
    }
  ).catch(() => undefined);

  return c.json({ ok: true, id: pendingId, status: 'linked', linked_user_id: userId });
}

export async function listDirectoryConnectorFleetHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const accessError = await requireTenantResourceAccess(c, tenantId);
  if (accessError) return accessError;

  const connectorId = c.req.query('connector_id');
  if (connectorId && !WORDWARDEN_CONNECTOR_ID_PATTERN.test(connectorId)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const limit = clampPendingLimit(c.req.query('limit'));
  const adapter = coreAdapter(c, tenantId);
  const config = await readConfig(c.env, tenantId);
  let instances = await listDirectoryConnectorInstances(adapter, tenantId, connectorId);
  const now = Date.now();
  const refreshed = await refreshDirectoryConnectorDerivedStatuses(
    adapter,
    instances,
    (instance) => fleetPolicyFor(config, instance),
    now
  );
  if (refreshed > 0) {
    instances = await listDirectoryConnectorInstances(adapter, tenantId, connectorId);
  }
  const episodes = await listFleetEpisodes(adapter, tenantId, connectorId, config, limit);

  return c.json({
    tenantId,
    items: instances.map((instance) =>
      serializeFleetInstance(
        applyDirectoryConnectorFleetPolicy(instance, fleetPolicyFor(config, instance) ?? {}, now)
      )
    ),
    episodes: episodes.map(serializeFleetEpisode),
  });
}

function fleetPolicyFor(
  config: DirectoryConnectorsConfig,
  instance: DirectoryConnectorInstanceRow
) {
  const connector = findConnector(config, instance.connector_id);
  if (!connector) return null;
  return {
    staleAfterMs: connector?.heartbeat.stale_after_ms,
    staleDetectionGraceMs: connector?.heartbeat.stale_detection_grace_ms,
    versionMismatchPolicy: connector?.heartbeat.version_mismatch_policy,
    expectedVersion: connector?.heartbeat.expected_version,
    minimumVersion: connector?.heartbeat.minimum_version,
  };
}

async function listFleetEpisodes(
  adapter: DatabaseAdapter,
  tenantId: string,
  connectorId: string | undefined,
  config: DirectoryConnectorsConfig,
  limit: number
): Promise<DirectoryConnectorStatusEpisodeRow[]> {
  if (connectorId) {
    return listDirectoryConnectorEpisodes(adapter, tenantId, connectorId, {
      limit,
      retentionDays:
        findConnector(config, connectorId)?.heartbeat.retention_days ??
        DEFAULT_HEARTBEAT_RETENTION_DAYS,
    });
  }
  if (config.connectors.length === 0) {
    return listDirectoryConnectorEpisodes(adapter, tenantId, undefined, {
      limit,
      retentionDays: DEFAULT_HEARTBEAT_RETENTION_DAYS,
    });
  }
  const perConnectorEpisodes = await Promise.all(
    config.connectors.map((connector) =>
      listDirectoryConnectorEpisodes(adapter, tenantId, connector.connector_id, {
        limit,
        retentionDays: connector.heartbeat.retention_days,
      })
    )
  );
  return perConnectorEpisodes
    .flat()
    .sort((left, right) => right.started_at - left.started_at)
    .slice(0, limit);
}

export async function updateDirectoryConnectorFleetInstanceHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const instanceId = c.req.param('instanceId')!;
  const accessError = await requireTenantResourceAccess(c, tenantId);
  if (accessError) return accessError;

  const body = await c.req.json().catch(() => null);
  const parsed = DirectoryFleetActionSchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const actor = adminActorId(c);
  const reason = parsed.data.reason?.trim() || null;
  const adapter = coreAdapter(c, tenantId);
  let updated = false;
  if (parsed.data.action === 'acknowledge') {
    updated = await acknowledgeDirectoryConnectorEpisode(adapter, {
      tenantId,
      connectorId: parsed.data.connector_id,
      instanceId,
      actorId: actor,
      reason,
    });
  } else if (parsed.data.action === 'deactivate') {
    updated = await markDirectoryConnectorInstanceStatus(adapter, {
      tenantId,
      connectorId: parsed.data.connector_id,
      instanceId,
      status: 'deactivated',
      actorId: actor,
      reason,
    });
  } else {
    updated = await reactivateDirectoryConnectorInstance(adapter, {
      tenantId,
      connectorId: parsed.data.connector_id,
      instanceId,
      actorId: actor,
      reason,
    });
  }
  if (!updated) {
    return c.json({ error: 'directory_connector_instance_not_found' }, 404);
  }

  await createAuditLogFromContext(
    c as unknown as Parameters<typeof createAuditLogFromContext>[0],
    `directory_connector_instance.${parsed.data.action}`,
    'directory_connector_instance',
    instanceId,
    {
      tenant_id: tenantId,
      connector_id: parsed.data.connector_id,
    }
  ).catch(() => undefined);

  return c.json({
    ok: true,
    instance_id: instanceId,
    connector_id: parsed.data.connector_id,
    action: parsed.data.action,
  });
}

export async function issueDirectoryConnectorSecretHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const connectorId = c.req.param('connectorId')!;
  const accessError = await requireTenantResourceAccess(c, tenantId);
  if (accessError) return accessError;

  const config = await readConfig(c.env, tenantId);
  const connector = findConnector(config, connectorId);
  if (!connector) {
    return c.json({ error: 'directory_connector_not_found' }, 404);
  }
  if (connector.transport !== 'relay') {
    return c.json(
      {
        error: 'invalid_directory_connector_config',
        error_description: 'Managed connector secrets are only supported for relay connectors',
      },
      400
    );
  }

  const now = new Date().toISOString();
  const keyId = generateRelayKeyId();
  const secret = generateRelaySecret();
  const nextConnector: DirectoryConnectorConfig = {
    ...connector,
    key_id: keyId,
    secret_ref: managedSecretRef(connector.id),
  };
  const nextConfig = replaceConnector(config, connector.id, nextConnector);

  try {
    await writeManagedSecret(c.env, tenantId, connector.id, {
      active: {
        keyId,
        secret,
        createdAt: now,
      },
    });
    await writeConfig(c.env, tenantId, nextConfig);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  try {
    await createAuditLogFromContext(
      c as unknown as Parameters<typeof createAuditLogFromContext>[0],
      'directory_connector.secret.issued',
      'directory_connector',
      connector.id,
      {
        tenant_id: tenantId,
        connector_id: connector.id,
        key_id: keyId,
      }
    );
  } catch {
    // Secret was issued successfully. Audit mirroring is best effort here.
  }

  return c.json({
    connector_id: connector.id,
    key_id: keyId,
    secret_ref: managedSecretRef(connector.id),
    secret,
    one_time_display: true,
  });
}

export async function rotateDirectoryConnectorSecretHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const connectorId = c.req.param('connectorId')!;
  const accessError = await requireTenantResourceAccess(c, tenantId);
  if (accessError) return accessError;

  const config = await readConfig(c.env, tenantId);
  const connector = findConnector(config, connectorId);
  if (!connector) {
    return c.json({ error: 'directory_connector_not_found' }, 404);
  }
  if (connector.transport !== 'relay') {
    return c.json(
      {
        error: 'invalid_directory_connector_config',
        error_description: 'Managed connector secrets are only supported for relay connectors',
      },
      400
    );
  }

  const current = await readManagedSecret(c.env, tenantId, connector.id);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const keyId = generateRelayKeyId();
  const secret = generateRelaySecret();
  const retireAfter = new Date(now + connector.relay.secret_rotation_grace_ms).toISOString();
  const nextRecord: DirectoryConnectorManagedSecretRecord = {
    active: {
      keyId,
      secret,
      createdAt: nowIso,
    },
    ...(current?.active
      ? {
          previous: {
            ...current.active,
            retireAfter,
          },
        }
      : {}),
  };
  const nextConnector: DirectoryConnectorConfig = {
    ...connector,
    key_id: keyId,
    secret_ref: managedSecretRef(connector.id),
  };
  const nextConfig = replaceConnector(config, connector.id, nextConnector);

  try {
    await writeManagedSecret(c.env, tenantId, connector.id, nextRecord);
    await writeConfig(c.env, tenantId, nextConfig);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  try {
    await createAuditLogFromContext(
      c as unknown as Parameters<typeof createAuditLogFromContext>[0],
      'directory_connector.secret.rotated',
      'directory_connector',
      connector.id,
      {
        tenant_id: tenantId,
        connector_id: connector.id,
        key_id: keyId,
        previous_retire_after: current?.active ? retireAfter : null,
      }
    );
  } catch {
    // Secret was rotated successfully. Audit mirroring is best effort here.
  }

  return c.json({
    connector_id: connector.id,
    key_id: keyId,
    secret_ref: managedSecretRef(connector.id),
    secret,
    previous_retire_after: current?.active ? retireAfter : null,
    one_time_display: true,
  });
}

export async function checkDirectoryConnectorHealthHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const connectorId = c.req.param('connectorId')!;
  const accessError = await requireTenantResourceAccess(c, tenantId);
  if (accessError) return accessError;

  const config = await readConfig(c.env, tenantId);
  const connector = findConnector(config, connectorId);
  if (!connector) {
    return c.json({ error: 'directory_connector_not_found' }, 404);
  }

  if (connector.transport === 'relay') {
    if (!c.env.DIRECTORY_CONNECTOR_RELAY) {
      return c.json(
        {
          ok: false,
          connector_id: connector.id,
          error: 'relay_status_unavailable',
          error_description: 'Directory connector relay binding is not configured',
        },
        503
      );
    }
    try {
      const stub = c.env.DIRECTORY_CONNECTOR_RELAY.get(
        c.env.DIRECTORY_CONNECTOR_RELAY.idFromName(
          directoryRelayInstanceName(tenantId, connector.connector_id)
        )
      );
      const statusURL = new URL('https://directory-relay.internal/status');
      statusURL.searchParams.set('tenant_id', tenantId);
      statusURL.searchParams.set('connector_id', connector.connector_id);
      const response = await stub.fetch(statusURL.toString());
      const bodyText = await readResponseTextWithLimit(response, 16 * 1024);
      return c.json({
        ok: response.ok,
        connector_id: connector.id,
        status: response.status,
        body: parseHealthBody(bodyText),
      });
    } catch (error) {
      return c.json(
        {
          ok: false,
          connector_id: connector.id,
          error: 'relay_status_failed',
          error_description: error instanceof Error ? error.message : 'Relay status failed',
        },
        502
      );
    }
  }

  const endpointError = validateEndpointURL(connector.endpoint_url);
  if (endpointError) {
    return c.json(
      {
        ok: false,
        connector_id: connector.id,
        error: 'invalid_endpoint_url',
        error_description: endpointError,
      },
      400
    );
  }

  try {
    const healthURL = new URL('/healthz', connector.endpoint_url).toString();
    const response = await safeFetch(healthURL, {
      method: 'GET',
      requireHttps: !allowsLocalhostHTTP(healthURL),
      allowLocalhost: allowsLocalhostHTTP(healthURL),
      timeoutMs: connector.timeouts.request_ms,
      maxResponseSize: 16 * 1024,
      headers: {
        Accept: 'application/json',
      },
    });
    const bodyText = await readResponseTextWithLimit(response, 16 * 1024);
    return c.json({
      ok: response.ok,
      connector_id: connector.id,
      status: response.status,
      body: parseHealthBody(bodyText),
    });
  } catch (error) {
    return c.json(
      {
        ok: false,
        connector_id: connector.id,
        error: 'health_check_failed',
        error_description: error instanceof Error ? error.message : 'Health check failed',
      },
      502
    );
  }
}

export async function listDirectoryConnectorRelayEventsHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const connectorId = c.req.param('connectorId')!;
  const accessError = await requireTenantResourceAccess(c, tenantId);
  if (accessError) return accessError;

  const config = await readConfig(c.env, tenantId);
  const connector = findConnector(config, connectorId);
  if (!connector) {
    return c.json({ error: 'directory_connector_not_found' }, 404);
  }
  if (connector.transport !== 'relay') {
    return c.json(
      {
        error: 'invalid_directory_connector_config',
        error_description: 'Relay events are only available for relay connectors',
      },
      400
    );
  }
  if (!c.env.DIRECTORY_CONNECTOR_RELAY) {
    return c.json(
      {
        error: 'relay_events_unavailable',
        error_description: 'Directory connector relay binding is not configured',
      },
      503
    );
  }

  try {
    const stub = c.env.DIRECTORY_CONNECTOR_RELAY.get(
      c.env.DIRECTORY_CONNECTOR_RELAY.idFromName(
        directoryRelayInstanceName(tenantId, connector.connector_id)
      )
    );
    const eventsURL = new URL('https://directory-relay.internal/events');
    eventsURL.searchParams.set('tenant_id', tenantId);
    eventsURL.searchParams.set('connector_id', connector.connector_id);
    const response = await stub.fetch(eventsURL.toString());
    const bodyText = await readResponseTextWithLimit(response, 64 * 1024);
    return c.json({
      ok: response.ok,
      connector_id: connector.id,
      status: response.status,
      body: parseHealthBody(bodyText),
    });
  } catch (error) {
    return c.json(
      {
        ok: false,
        connector_id: connector.id,
        error: 'relay_events_failed',
        error_description: error instanceof Error ? error.message : 'Relay events failed',
      },
      502
    );
  }
}
