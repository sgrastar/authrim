import { z } from 'zod';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  createAuditLogFromContext,
  createErrorResponse,
  readResponseTextWithLimit,
  safeFetch,
} from '@authrim/ar-lib-core';
import { requireTenantResourceAccess } from '../admin-tenant-access';

const CATEGORY = 'directory-connectors';
const CONNECTOR_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SECRET_REF_PATTERN = /^env:(AUTHRIM_WORDWARDEN_|WORDWARDEN_)[A-Z0-9_]+$/;
const DEFAULT_REQUEST_TIMEOUT_MS = 2500;
const MAX_REQUEST_TIMEOUT_MS = 30000;
const MAX_ATTRIBUTE_NAMES = 32;
const MAX_CONNECTORS = 20;

const DirectoryConnectorSchema = z.object({
  id: z.string().regex(CONNECTOR_ID_PATTERN),
  endpoint_url: z.string().min(1).max(2048),
  auth_mode: z.literal('hmac').default('hmac'),
  connector_id: z.string().regex(CONNECTOR_ID_PATTERN),
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
  attribute_names: z.array(z.string().min(1).max(128)).max(MAX_ATTRIBUTE_NAMES).default([]),
});

const DirectoryConnectorsConfigSchema = z.object({
  connectors: z.array(DirectoryConnectorSchema).max(MAX_CONNECTORS).default([]),
});

const DirectoryConnectorsUpdateSchema = DirectoryConnectorsConfigSchema;

type DirectoryConnectorConfig = z.infer<typeof DirectoryConnectorSchema>;
type DirectoryConnectorsConfig = z.infer<typeof DirectoryConnectorsConfigSchema>;

function configKey(tenantId: string): string {
  return `settings:tenant:${tenantId}:${CATEGORY}`;
}

function storage(env: Env): KVNamespace | null {
  return env.SETTINGS ?? null;
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
    connectors: config.connectors.map((connector) => ({
      ...connector,
      auth_mode: 'hmac',
      attribute_names: normalizeAttributeNames(connector.attribute_names),
    })),
  };
}

function validateUniqueConnectorIds(connectors: DirectoryConnectorConfig[]): string | null {
  const ids = new Set<string>();
  for (const connector of connectors) {
    if (ids.has(connector.id)) {
      return connector.id;
    }
    ids.add(connector.id);
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
  for (const connector of config.connectors) {
    const endpointError = validateEndpointURL(connector.endpoint_url);
    if (endpointError) {
      return `${connector.id}: ${endpointError}`;
    }
  }
  return null;
}

async function readConfig(env: Env, tenantId: string): Promise<DirectoryConnectorsConfig> {
  const kv = storage(env);
  if (!kv) return { connectors: [] };

  const raw = await kv.get(configKey(tenantId));
  if (!raw) return { connectors: [] };

  try {
    const parsed = DirectoryConnectorsConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { connectors: [] };
    return normalizeConfig(parsed.data);
  } catch {
    return { connectors: [] };
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
    connectors: config.connectors.map((connector) => ({
      id: connector.id,
      endpoint_url: connector.endpoint_url,
      auth_mode: connector.auth_mode,
      connector_id: connector.connector_id,
      key_id: connector.key_id,
      secret_ref_present: Boolean(connector.secret_ref),
      timeouts: connector.timeouts,
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

function findConnector(
  config: DirectoryConnectorsConfig,
  connectorId: string
): DirectoryConnectorConfig | null {
  return config.connectors.find((connector) => connector.id === connectorId) ?? null;
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
