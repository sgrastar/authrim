import type { Context } from 'hono';
import {
  createAuditLog,
  createAuthContextFromHono,
  createLogger,
  recordDirectoryConnectorHeartbeat,
  type Env,
} from '@authrim/ar-lib-core';

const HEARTBEAT_HMAC_ALGORITHM = 'AUTHRIM-WORDWARDEN-HEARTBEAT-HMAC-SHA256';
const WORDWARDEN_CONNECTOR_ID_PATTERN = /^wwcon_[a-zA-Z0-9]{16}$/;
const WORDWARDEN_INSTANCE_ID_PATTERN = /^wwi_[a-zA-Z0-9_-]{22,64}$/;
const ALLOWED_CONNECTOR_SECRET_ENV_PREFIXES = ['AUTHRIM_WORDWARDEN_', 'WORDWARDEN_'];
const MAX_HEARTBEAT_BODY_BYTES = 32 * 1024;
const HEARTBEAT_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const MAX_HEARTBEAT_CATEGORIES = 32;

interface DirectoryConnectorSettingsRecord {
  connectors?: unknown;
}

interface DirectoryConnectorSettingsItem {
  id: string;
  connector_id: string;
  heartbeat: {
    key_id?: string;
    secret_ref?: string;
    previous_key_id?: string;
    previous_secret_ref?: string;
  };
}

interface HeartbeatPayload {
  instance_id: string;
  display_name?: string;
  transport: 'relay' | 'direct' | 'tunnel';
  version: string;
  release_channel?: string;
  started_at: string;
  health_status: 'healthy' | 'degraded' | 'unhealthy';
  health_summary?: Record<string, unknown>;
  config_fingerprint: string;
  config_categories?: string[];
  drift_severity?: 'none' | 'warning' | 'critical';
}

interface ResolvedHeartbeatSecret {
  keyId: string;
  secret: string;
}

const log = createLogger().module('directory-connector-heartbeat');

export async function directoryConnectorHeartbeatHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;
  const connectorId = c.req.param('connectorId')!;
  if (!tenantId || !WORDWARDEN_CONNECTOR_ID_PATTERN.test(connectorId)) {
    return c.json({ error: 'invalid_request' }, 400);
  }

  const bodyText = await readRequestTextWithLimit(c.req.raw, MAX_HEARTBEAT_BODY_BYTES);
  if (bodyText === 'too_large') {
    await auditHeartbeatFailure(c, tenantId, connectorId, 'payload_too_large');
    return c.json({ error: 'invalid_heartbeat' }, 413);
  }
  if (bodyText === null) {
    await auditHeartbeatFailure(c, tenantId, connectorId, 'invalid_payload');
    return c.json({ error: 'invalid_heartbeat' }, 400);
  }

  const payload = parseHeartbeatPayload(bodyText);
  if (!payload) {
    await auditHeartbeatFailure(c, tenantId, connectorId, 'invalid_payload');
    return c.json({ error: 'invalid_heartbeat' }, 400);
  }

  const connector = await resolveDirectoryConnectorSettings(c.env, tenantId, connectorId);
  if (!connector) {
    await auditHeartbeatFailure(c, tenantId, connectorId, 'connector_not_configured');
    return c.json({ error: 'invalid_heartbeat' }, 404);
  }

  const keyId = c.req.header('X-Authrim-Heartbeat-Key-Id')?.trim();
  const timestamp = c.req.header('X-Authrim-Heartbeat-Timestamp')?.trim();
  const signature = normalizeSignature(c.req.header('X-Authrim-Heartbeat-Signature'));
  if (!keyId || !timestamp || !signature || !timestampFresh(timestamp)) {
    await auditHeartbeatFailure(c, tenantId, connectorId, 'invalid_signature_context', {
      instance_id: payload.instance_id,
      key_id: keyId,
    });
    return c.json({ error: 'invalid_heartbeat' }, 401);
  }

  const resolvedSecret = resolveHeartbeatSecret(c.env, connector, keyId);
  if (!resolvedSecret) {
    await auditHeartbeatFailure(c, tenantId, connectorId, 'unknown_heartbeat_key', {
      instance_id: payload.instance_id,
      key_id: keyId,
    });
    return c.json({ error: 'invalid_heartbeat' }, 401);
  }

  const canonical = await buildHeartbeatCanonicalRequest({
    tenantId,
    connectorId,
    instanceId: payload.instance_id,
    keyId,
    timestamp,
    bodyText,
  });
  const expectedSignature = await signHeartbeatCanonicalRequest(canonical, resolvedSecret.secret);
  if (!constantTimeHexEqual(signature, expectedSignature)) {
    await auditHeartbeatFailure(c, tenantId, connectorId, 'signature_mismatch', {
      instance_id: payload.instance_id,
      key_id: keyId,
    });
    return c.json({ error: 'invalid_heartbeat' }, 401);
  }

  const authContext = createAuthContextFromHono(c, tenantId);
  const result = await recordDirectoryConnectorHeartbeat(authContext.coreAdapter, {
    tenantId,
    connectorId,
    instanceId: payload.instance_id,
    displayName: payload.display_name,
    transport: payload.transport,
    version: payload.version,
    releaseChannel: payload.release_channel,
    startedAt: payload.started_at,
    healthStatus: payload.health_status,
    healthSummary: payload.health_summary,
    configFingerprint: payload.config_fingerprint,
    configCategories: payload.config_categories,
    driftSeverity: payload.drift_severity,
  });
  if (!result.accepted) {
    await auditHeartbeatFailure(c, tenantId, connectorId, result.reason ?? 'heartbeat_rejected', {
      instance_id: payload.instance_id,
      key_id: keyId,
    });
    return c.json({ error: 'invalid_heartbeat' }, 403);
  }

  return c.json({
    ok: true,
    status: result.status,
    instance_id: payload.instance_id,
    connector_id: connectorId,
  });
}

export async function buildHeartbeatCanonicalRequest(input: {
  tenantId: string;
  connectorId: string;
  instanceId: string;
  keyId: string;
  timestamp: string;
  bodyText: string;
}): Promise<string> {
  return [
    HEARTBEAT_HMAC_ALGORITHM,
    input.tenantId,
    input.connectorId,
    input.instanceId,
    input.keyId,
    input.timestamp,
    await sha256Hex(input.bodyText),
  ].join('\n');
}

export async function signHeartbeatCanonicalRequest(
  canonical: string,
  secret: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
  return bytesToHex(new Uint8Array(signature));
}

function parseHeartbeatPayload(bodyText: string): HeartbeatPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const instanceId = stringValue(record.instance_id);
  const version = stringValue(record.version);
  const startedAt = stringValue(record.started_at);
  const configFingerprint = stringValue(record.config_fingerprint);
  const transport = stringValue(record.transport);
  const healthStatus = stringValue(record.health_status);
  if (
    !instanceId ||
    !WORDWARDEN_INSTANCE_ID_PATTERN.test(instanceId) ||
    !version ||
    version.length > 64 ||
    !startedAt ||
    !validIsoDate(startedAt) ||
    !configFingerprint ||
    !/^sha256:[a-f0-9]{64}$/.test(configFingerprint) ||
    (transport !== 'relay' && transport !== 'direct' && transport !== 'tunnel') ||
    (healthStatus !== 'healthy' && healthStatus !== 'degraded' && healthStatus !== 'unhealthy')
  ) {
    return null;
  }
  const displayName = stringValue(record.display_name);
  const releaseChannel = stringValue(record.release_channel) || 'stable';
  const categories = stringArray(record.config_categories);
  const driftSeverity = stringValue(record.drift_severity) || 'none';
  if (
    !/^[a-zA-Z0-9_.-]{1,32}$/.test(releaseChannel) ||
    (driftSeverity !== 'none' && driftSeverity !== 'warning' && driftSeverity !== 'critical')
  ) {
    return null;
  }
  return {
    instance_id: instanceId,
    ...(displayName && displayName.length <= 128 ? { display_name: displayName } : {}),
    transport,
    version,
    release_channel: releaseChannel,
    started_at: startedAt,
    health_status: healthStatus,
    health_summary: plainRecord(record.health_summary) ?? {},
    config_fingerprint: configFingerprint,
    config_categories: categories,
    drift_severity: driftSeverity,
  };
}

async function resolveDirectoryConnectorSettings(
  env: Env,
  tenantId: string,
  connectorId: string
): Promise<DirectoryConnectorSettingsItem | null> {
  const raw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:directory-connectors`).catch(
    () => null
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DirectoryConnectorSettingsRecord;
    if (!Array.isArray(parsed.connectors)) return null;
    for (const value of parsed.connectors) {
      const connector = normalizeDirectoryConnector(value);
      if (connector?.connector_id === connectorId) return connector;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeDirectoryConnector(value: unknown): DirectoryConnectorSettingsItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = stringValue(record.id);
  const connectorId = stringValue(record.connector_id);
  const heartbeat =
    record.heartbeat && typeof record.heartbeat === 'object' && !Array.isArray(record.heartbeat)
      ? (record.heartbeat as Record<string, unknown>)
      : {};
  if (!id || !connectorId || !WORDWARDEN_CONNECTOR_ID_PATTERN.test(connectorId)) return null;
  return {
    id,
    connector_id: connectorId,
    heartbeat: {
      key_id: stringValue(heartbeat.key_id),
      secret_ref: stringValue(heartbeat.secret_ref),
      previous_key_id: stringValue(heartbeat.previous_key_id),
      previous_secret_ref: stringValue(heartbeat.previous_secret_ref),
    },
  };
}

function resolveHeartbeatSecret(
  env: Env,
  connector: DirectoryConnectorSettingsItem,
  keyId: string
): ResolvedHeartbeatSecret | null {
  const activeKeyId = connector.heartbeat.key_id;
  const activeSecretRef = connector.heartbeat.secret_ref;
  if (activeKeyId === keyId && activeSecretRef) {
    const secret = resolveEnvConnectorSecret(env, activeSecretRef);
    if (secret) return { keyId, secret };
  }
  const previousKeyId = connector.heartbeat.previous_key_id;
  const previousSecretRef = connector.heartbeat.previous_secret_ref;
  if (previousKeyId === keyId && previousSecretRef) {
    const secret = resolveEnvConnectorSecret(env, previousSecretRef);
    if (secret) return { keyId, secret };
  }
  return null;
}

function resolveEnvConnectorSecret(env: Env, secretRef: string): string | undefined {
  if (!secretRef.startsWith('env:')) return undefined;
  const envName = secretRef.slice('env:'.length);
  if (!isAllowedConnectorSecretEnvName(envName)) return undefined;
  const value = (env as unknown as Record<string, unknown>)[envName];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isAllowedConnectorSecretEnvName(key: string): boolean {
  return (
    /^[A-Z0-9_]+$/.test(key) &&
    ALLOWED_CONNECTOR_SECRET_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

async function auditHeartbeatFailure(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  connectorId: string,
  reason: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const metadata = JSON.stringify({
    connector_id: connectorId,
    reason,
    ...extra,
  });
  const auditPromise = createAuditLog(c.env, {
    tenantId,
    userId: 'system',
    action: 'directory_connector_heartbeat.failed',
    resource: 'directory_connector_instance',
    resourceId: typeof extra.instance_id === 'string' ? extra.instance_id : connectorId,
    ipAddress: requestIpAddress(c),
    userAgent: c.req.header('User-Agent') || 'unknown',
    metadata,
    severity: 'warning',
  }).catch((error) => {
    log.error('Failed to create audit log for directory connector heartbeat failure', {
      action: 'audit_log',
      reason,
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
  });
  c.executionCtx?.waitUntil(auditPromise);
}

function normalizeSignature(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const signature = raw.startsWith('sha256=') ? raw.slice('sha256='.length) : raw;
  return /^[a-f0-9]{64}$/i.test(signature) ? signature.toLowerCase() : null;
}

function timestampFresh(value: string): boolean {
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return Math.abs(Date.now() - parsed) <= HEARTBEAT_TIMESTAMP_SKEW_MS;
}

function validIsoDate(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

async function readRequestTextWithLimit(
  request: Request,
  maxBytes: number
): Promise<string | 'too_large' | null> {
  const reader = request.body?.getReader();
  if (!reader) return '';

  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return 'too_large';
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 64 || result.includes(trimmed)) continue;
    result.push(trimmed);
    if (result.length >= MAX_HEARTBEAT_CATEGORIES) break;
  }
  return result;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(hash));
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requestIpAddress(c: Context<{ Bindings: Env }>): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}
