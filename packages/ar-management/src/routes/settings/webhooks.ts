/**
 * Webhook Configuration Admin API
 *
 * POST   /api/admin/webhooks              - Register a new webhook
 * GET    /api/admin/webhooks              - List all webhooks
 * GET    /api/admin/webhooks/:id          - Get a specific webhook
 * PUT    /api/admin/webhooks/:id          - Update a webhook
 * DELETE /api/admin/webhooks/:id          - Delete a webhook
 * POST   /api/admin/webhooks/:id/test     - Send a test webhook
 * GET    /api/admin/webhooks/:id/deliveries - List delivery logs (Phase 2)
 * POST   /api/admin/webhooks/:id/replay   - Replay a failed delivery (Phase 3)
 *
 * Security:
 * - RBAC: tenant_admin or higher required
 * - Rate limit: lenient profile
 * - Audit logging for all mutations
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import {
  createWebhookRegistry,
  validateEventPattern,
  createAuditLogFromContext,
  createAuthContextFromHono,
  getTenantIdFromContext,
  encryptValue,
  decryptValue,
  getLogger,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  validateWebhookUrl,
  type WebhookConfigWithScope,
  type Env,
} from '@authrim/ar-lib-core';
import { loadCatalogObjectJson } from '@authrim/ar-lib-core/services/object-artifact-store';
import {
  createObjectCatalogEntry,
  getObjectCatalogObjectRecordByPublicArtifactId,
  type ObjectClass,
} from '@authrim/ar-lib-core/services/object-catalog';
import { encryptObjectArtifact } from '@authrim/ar-lib-core/services/object-artifact-crypto';
import {
  auditAdminSensitiveRead,
  requireAdminPermissionOrElevationGrant,
} from '../../admin-elevation-access';

/**
 * Webhook retry policy configuration (matching types/events/webhook.ts)
 *
 * Note: Defined locally to avoid conflict with types/contracts/events.ts
 * which uses different property names (backoffMs vs initialDelayMs).
 */
interface WebhookRetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}

/**
 * Input for creating a webhook (from ar-lib-core types)
 */
interface WebhookCreateInput {
  name: string;
  url: string;
  events: string[];
  secret?: string;
  headers?: Record<string, string>;
  retryPolicy?: WebhookRetryPolicy;
  timeoutMs?: number;
  clientId?: string;
}

/**
 * Input for updating a webhook (from ar-lib-core types)
 */
interface WebhookUpdateInput {
  name?: string;
  url?: string;
  events?: string[];
  secret?: string;
  headers?: Record<string, string>;
  retryPolicy?: Partial<WebhookRetryPolicy>;
  timeoutMs?: number;
  active?: boolean;
}

// =============================================================================
// Types
// =============================================================================

/**
 * Request body for creating a webhook
 */
interface CreateWebhookRequest {
  name: string;
  url: string;
  events: string[];
  secret?: string;
  headers?: Record<string, string>;
  retryPolicy?: {
    maxRetries?: number;
    initialDelayMs?: number;
    backoffMultiplier?: number;
    maxDelayMs?: number;
  };
  timeoutMs?: number;
  clientId?: string;
}

/**
 * Request body for updating a webhook
 */
interface UpdateWebhookRequest {
  name?: string;
  url?: string;
  events?: string[];
  secret?: string;
  headers?: Record<string, string>;
  retryPolicy?: {
    maxRetries?: number;
    initialDelayMs?: number;
    backoffMultiplier?: number;
    maxDelayMs?: number;
  };
  timeoutMs?: number;
  active?: boolean;
}

/**
 * Query parameters for listing webhooks
 */
interface ListWebhooksQuery {
  scope?: 'tenant' | 'client';
  clientId?: string;
  activeOnly?: string;
  limit?: string;
  offset?: string;
}

// =============================================================================
// Helpers
// =============================================================================

const ENCRYPTED_OBJECT_CONTENT_TYPE = 'application/vnd.authrim.object-envelope+json';
const WEBHOOK_DELIVERY_DETAIL_CONTENT_TYPE = 'application/json';
const DEFAULT_OBJECT_KEY_VERSION = 1;
const DELIVERY_BODY_PREVIEW_LIMIT = 200;
const DELIVERY_HEADER_VALUE_PREVIEW_LIMIT = 128;

interface WebhookDeliveryDetailPayload {
  requestHeaders: Record<string, string> | null;
  requestBody: string | null;
  responseBody: string | null;
}

function getCoreAdapter(c: Context<{ Bindings: Env }>) {
  return createAuthContextFromHono(c, getTenantIdFromContext(c)).coreAdapter;
}

async function requireWebhookPayloadReadAccess(
  c: Context<{ Bindings: Env }>,
  requirement?: {
    requestedAction?: 'detail_read' | 'artifact_read';
    resourceIds?: Array<string | null | undefined>;
    detailClass?: string | null;
  }
): Promise<Response | { grantedBy: 'permission' | 'grant'; grant: any | null }> {
  // adminAuth is attached by the global adminAuthMiddleware in index.ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call
  const authContext = (c as any).get('adminAuth') as { permissions?: string[] } | undefined;
  const permissions = authContext?.permissions || [];
  if (hasAdminPermission(permissions, ADMIN_PERMISSIONS.WEBHOOKS_PAYLOAD_READ)) {
    return {
      grantedBy: 'permission',
      grant: null,
    };
  }

  const access = await requireAdminPermissionOrElevationGrant(c as any, {
    directPermission: ADMIN_PERMISSIONS.WEBHOOKS_PAYLOAD_READ,
    requestSurface: 'webhook_payload',
    requestedAction: requirement?.requestedAction ?? 'detail_read',
    resourceClass: 'webhook_delivery_payload',
    resourceIds: requirement?.resourceIds,
    detailClass: requirement?.detailClass ?? 'request_response_payload',
    targetAudience: 'admin_api',
  });
  return access;
}

function requireWebhookPayloadReplayPermission(c: Context<{ Bindings: Env }>): Response | null {
  // adminAuth is attached by the global adminAuthMiddleware in index.ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call
  const authContext = (c as any).get('adminAuth') as { permissions?: string[] } | undefined;
  const permissions = authContext?.permissions || [];
  if (hasAdminPermission(permissions, ADMIN_PERMISSIONS.WEBHOOKS_PAYLOAD_READ)) {
    return null;
  }

  return c.json(
    {
      error: 'insufficient_permissions',
      error_description: 'You do not have permission to replay webhook payloads.',
    },
    403
  );
}

function normalizeTimestampMs(timestamp: number): number {
  return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

function formatTimestampIso(timestamp: number | null): string | null {
  if (!timestamp) {
    return null;
  }
  return new Date(normalizeTimestampMs(timestamp)).toISOString();
}

function getObjectEncryptionKeyVersion(env: Env): number {
  const parsed = Number.parseInt(env.OBJECT_ENCRYPTION_KEY_VERSION ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_OBJECT_KEY_VERSION;
}

function buildWebhookDeliveryObjectKey(
  tenantId: string,
  webhookId: string,
  deliveryId: string,
  createdAt: number
): string {
  const createdAtDate = new Date(normalizeTimestampMs(createdAt));
  const year = createdAtDate.getUTCFullYear();
  const month = String(createdAtDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(createdAtDate.getUTCDate()).padStart(2, '0');
  return `webhook-deliveries/${tenantId}/${webhookId}/${year}/${month}/${day}/${deliveryId}.json`;
}

function buildBodyPreview(body: string | null | undefined, maxLength = DELIVERY_BODY_PREVIEW_LIMIT) {
  if (!body) {
    return null;
  }
  return body.length > maxLength ? body.slice(0, maxLength) : body;
}

function buildHeaderPreview(
  headers: Record<string, string> | null | undefined
): Record<string, string> | null {
  if (!headers) {
    return null;
  }

  const preview: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === 'authorization' ||
      normalizedKey === 'cookie' ||
      normalizedKey === 'set-cookie' ||
      normalizedKey.startsWith('x-auth') ||
      normalizedKey === 'x-webhook-signature'
    ) {
      preview[key] = '***MASKED***';
      continue;
    }
    preview[key] =
      value.length > DELIVERY_HEADER_VALUE_PREVIEW_LIMIT
        ? `${value.slice(0, DELIVERY_HEADER_VALUE_PREVIEW_LIMIT)}...`
        : value;
  }
  return preview;
}

async function storeWebhookDeliveryPayload(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  webhookId: string,
  deliveryId: string,
  createdAt: number,
  detail: WebhookDeliveryDetailPayload
): Promise<string | null> {
  if (!c.env.SENSITIVE_DETAILS || !c.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return null;
  }

  const objectClass: ObjectClass = 'webhook_delivery_payload';
  const objectKey = buildWebhookDeliveryObjectKey(tenantId, webhookId, deliveryId, createdAt);
  const keyVersion = getObjectEncryptionKeyVersion(c.env);
  const plaintext = JSON.stringify(detail);
  const encrypted = await encryptObjectArtifact(plaintext, {
    rootKeyHex: c.env.OBJECT_ENCRYPTION_ROOT_KEY,
    plane: 'SENSITIVE_DETAILS',
    keyVersion,
    contentType: WEBHOOK_DELIVERY_DETAIL_CONTENT_TYPE,
    context: {
      tenantId,
      objectKey,
      objectClass,
    },
  });
  const body = JSON.stringify(encrypted);
  const bodyBytes = new TextEncoder().encode(body);
  const checksumBuffer = await crypto.subtle.digest('SHA-256', bodyBytes);
  const checksumSha256 = Array.from(new Uint8Array(checksumBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  await c.env.SENSITIVE_DETAILS.put(objectKey, body, {
    httpMetadata: { contentType: ENCRYPTED_OBJECT_CONTENT_TYPE },
  });

  const adapter = getCoreAdapter(c);
  const { catalogId } = await createObjectCatalogEntry(adapter, {
    tenantId,
    objectClass,
    createdAt: normalizeTimestampMs(createdAt),
    objects: [
      {
        representation: 'canonical_json',
        objectKind: 'single',
        bucketBinding: 'SENSITIVE_DETAILS',
        objectKey,
        keyVersion,
        checksumSha256,
        totalBytes: bodyBytes.byteLength,
      },
    ],
  });

  return catalogId;
}

async function loadWebhookDeliveryPayload(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  detailArtifactId: string | null | undefined,
  objectCatalogId?: string | null | undefined
): Promise<WebhookDeliveryDetailPayload | null> {
  if (!c.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return null;
  }

  const adapter = getCoreAdapter(c);
  const fallbackCatalogId =
    objectCatalogId ?? (detailArtifactId && !detailArtifactId.startsWith('oa_') ? detailArtifactId : null);
  const resolvedCatalogId = detailArtifactId
    ? (await getObjectCatalogObjectRecordByPublicArtifactId(
        adapter,
        detailArtifactId,
        'canonical_json',
        0
      ))?.logical.id ?? null
    : null;
  const effectiveCatalogId = resolvedCatalogId ?? fallbackCatalogId;
  const loaded = effectiveCatalogId
    ? await loadCatalogObjectJson<Partial<WebhookDeliveryDetailPayload>>(adapter, c.env, {
        tenantId,
        objectCatalogId: effectiveCatalogId,
        expectedClass: 'webhook_delivery_payload',
        expectedBucketBinding: 'SENSITIVE_DETAILS',
        allowPlaintextFallback: false,
      })
    : null;
  if (!loaded) {
    return null;
  }
  const parsed = loaded.value;
  return {
    requestHeaders:
      parsed.requestHeaders &&
      typeof parsed.requestHeaders === 'object' &&
      !Array.isArray(parsed.requestHeaders)
        ? (parsed.requestHeaders as Record<string, string>)
        : null,
    requestBody: typeof parsed.requestBody === 'string' ? parsed.requestBody : null,
    responseBody: typeof parsed.responseBody === 'string' ? parsed.responseBody : null,
  };
}

/**
 * Create WebhookRegistry from context
 */
function createRegistry(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('WebhookAPI');
  const adapter = getCoreAdapter(c);
  return createWebhookRegistry({
    adapter,
    encryptSecret: async (plaintext) => {
      const piiKey = c.env.PII_ENCRYPTION_KEY;
      if (piiKey) {
        const result = await encryptValue(plaintext, piiKey, 'AES-256-GCM', 1);
        return result.encrypted;
      }
      // Development fallback: base64 encoding (WARNING logged)
      log.warn('PII_ENCRYPTION_KEY not set, using base64 fallback', {});
      return Buffer.from(plaintext).toString('base64');
    },
    allowLocalhostHttp: c.env.ENVIRONMENT === 'development',
    maxEventPatterns: 50,
  });
}

function validateWebhookDispatchUrl(c: Context<{ Bindings: Env }>, url: string): boolean {
  return validateWebhookUrl(url, c.env.ENVIRONMENT === 'development').valid;
}

/**
 * Validate create webhook request
 */
function validateCreateRequest(body: CreateWebhookRequest): { valid: boolean; error?: string } {
  if (!body.name || typeof body.name !== 'string' || body.name.trim() === '') {
    return { valid: false, error: 'name is required and must be a non-empty string' };
  }

  if (!body.url || typeof body.url !== 'string') {
    return { valid: false, error: 'url is required and must be a string' };
  }

  if (!body.events || !Array.isArray(body.events) || body.events.length === 0) {
    return { valid: false, error: 'events is required and must be a non-empty array' };
  }

  // Validate each event pattern
  for (const pattern of body.events) {
    const result = validateEventPattern(pattern);
    if (!result.valid) {
      return { valid: false, error: `Invalid event pattern '${pattern}': ${result.error}` };
    }
  }

  // Validate optional fields
  if (body.timeoutMs !== undefined) {
    if (typeof body.timeoutMs !== 'number' || body.timeoutMs < 1000 || body.timeoutMs > 60000) {
      return { valid: false, error: 'timeoutMs must be a number between 1000 and 60000' };
    }
  }

  if (body.retryPolicy) {
    if (
      body.retryPolicy.maxRetries !== undefined &&
      (typeof body.retryPolicy.maxRetries !== 'number' ||
        body.retryPolicy.maxRetries < 0 ||
        body.retryPolicy.maxRetries > 10)
    ) {
      return { valid: false, error: 'retryPolicy.maxRetries must be between 0 and 10' };
    }
  }

  return { valid: true };
}

/**
 * Format webhook for API response (exclude encrypted secret)
 */
function formatWebhookResponse(webhook: WebhookConfigWithScope) {
  return {
    id: webhook.id,
    tenantId: webhook.tenantId,
    clientId: webhook.clientId,
    scope: webhook.scope,
    name: webhook.name,
    url: webhook.url,
    events: webhook.events,
    hasSecret: !!webhook.secretEncrypted,
    headers: webhook.headers,
    retryPolicy: webhook.retryPolicy,
    timeoutMs: webhook.timeoutMs,
    active: webhook.active,
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
    lastSuccessAt: webhook.lastSuccessAt,
    lastFailureAt: webhook.lastFailureAt,
  };
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * POST /api/admin/webhooks
 * Register a new webhook
 */
export async function createWebhook(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('WebhookAPI');
  const tenantId = getTenantIdFromContext(c);

  let body: CreateWebhookRequest;
  try {
    body = await c.req.json<CreateWebhookRequest>();
  } catch {
    return c.json({ error: 'invalid_request', error_description: 'Invalid JSON body' }, 400);
  }

  // Validate request
  const validation = validateCreateRequest(body);
  if (!validation.valid) {
    return c.json({ error: 'invalid_request', error_description: validation.error }, 400);
  }

  try {
    const registry = createRegistry(c);

    // Create input with proper retry policy mapping
    const input: WebhookCreateInput = {
      name: body.name,
      url: body.url,
      events: body.events,
      secret: body.secret,
      headers: body.headers,
      timeoutMs: body.timeoutMs,
      clientId: body.clientId,
    };

    // Map retryPolicy to the expected format
    if (body.retryPolicy) {
      input.retryPolicy = {
        maxRetries: body.retryPolicy.maxRetries ?? 3,
        initialDelayMs: body.retryPolicy.initialDelayMs ?? 1000,
        backoffMultiplier: body.retryPolicy.backoffMultiplier ?? 2,
        maxDelayMs: body.retryPolicy.maxDelayMs ?? 60000,
      };
    }

    const webhookId = await registry.register(tenantId, input);

    // Audit log
    await createAuditLogFromContext(c, 'webhook.created', 'webhook', webhookId, {
      name: body.name,
      url: body.url,
      events: body.events,
      scope: body.clientId ? 'client' : 'tenant',
    });

    // Fetch created webhook for response
    const webhook = await registry.get(tenantId, webhookId);

    return c.json(
      {
        success: true,
        webhook: webhook ? formatWebhookResponse(webhook) : { id: webhookId },
      },
      201
    );
  } catch (error) {
    log.error('Create error', {}, error as Error);
    const message = error instanceof Error ? error.message : 'Failed to create webhook';
    return c.json({ error: 'server_error', error_description: message }, 500);
  }
}

/**
 * GET /api/admin/webhooks
 * List all webhooks for tenant
 */
export async function listWebhooks(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('WebhookAPI');
  const tenantId = getTenantIdFromContext(c);
  const query = c.req.query() as ListWebhooksQuery;

  try {
    const registry = createRegistry(c);

    const webhooks = await registry.list(tenantId, {
      scope: query.scope,
      clientId: query.clientId,
      activeOnly: query.activeOnly === 'true',
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });

    return c.json({
      webhooks: webhooks.map(formatWebhookResponse),
      total: webhooks.length,
    });
  } catch (error) {
    log.error('List error', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to list webhooks' }, 500);
  }
}

/**
 * GET /api/admin/webhooks/:id
 * Get a specific webhook
 */
export async function getWebhook(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('WebhookAPI');
  const tenantId = getTenantIdFromContext(c);
  const webhookId = c.req.param('id')!;

  try {
    const registry = createRegistry(c);
    const webhook = await registry.get(tenantId, webhookId);

    if (!webhook) {
      return c.json({ error: 'not_found', error_description: 'Webhook not found' }, 404);
    }

    return c.json({ webhook: formatWebhookResponse(webhook) });
  } catch (error) {
    log.error('Get error', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to get webhook' }, 500);
  }
}

/**
 * PUT /api/admin/webhooks/:id
 * Update a webhook
 */
export async function updateWebhook(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('WebhookAPI');
  const tenantId = getTenantIdFromContext(c);
  const webhookId = c.req.param('id')!;

  let body: UpdateWebhookRequest;
  try {
    body = await c.req.json<UpdateWebhookRequest>();
  } catch {
    return c.json({ error: 'invalid_request', error_description: 'Invalid JSON body' }, 400);
  }

  // Validate event patterns if provided
  if (body.events) {
    for (const pattern of body.events) {
      const result = validateEventPattern(pattern);
      if (!result.valid) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid event pattern '${pattern}': ${result.error}`,
          },
          400
        );
      }
    }
  }

  try {
    const registry = createRegistry(c);

    // Check if exists
    const existing = await registry.get(tenantId, webhookId);
    if (!existing) {
      return c.json({ error: 'not_found', error_description: 'Webhook not found' }, 404);
    }

    // Map to WebhookUpdateInput
    const input: WebhookUpdateInput = {
      name: body.name,
      url: body.url,
      events: body.events,
      secret: body.secret,
      headers: body.headers,
      timeoutMs: body.timeoutMs,
      active: body.active,
    };

    if (body.retryPolicy) {
      input.retryPolicy = {
        maxRetries: body.retryPolicy.maxRetries,
        initialDelayMs: body.retryPolicy.initialDelayMs,
        backoffMultiplier: body.retryPolicy.backoffMultiplier,
        maxDelayMs: body.retryPolicy.maxDelayMs,
      };
    }

    await registry.update(tenantId, webhookId, input);

    // Audit log
    await createAuditLogFromContext(c, 'webhook.updated', 'webhook', webhookId, {
      updated_fields: Object.keys(body),
    });

    // Fetch updated webhook
    const webhook = await registry.get(tenantId, webhookId);

    return c.json({
      success: true,
      webhook: webhook ? formatWebhookResponse(webhook) : null,
    });
  } catch (error) {
    log.error('Update error', {}, error as Error);
    const message = error instanceof Error ? error.message : 'Failed to update webhook';
    return c.json({ error: 'server_error', error_description: message }, 500);
  }
}

/**
 * DELETE /api/admin/webhooks/:id
 * Delete a webhook
 */
export async function deleteWebhook(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('WebhookAPI');
  const tenantId = getTenantIdFromContext(c);
  const webhookId = c.req.param('id')!;

  try {
    const registry = createRegistry(c);

    // Check if exists
    const existing = await registry.get(tenantId, webhookId);
    if (!existing) {
      return c.json({ error: 'not_found', error_description: 'Webhook not found' }, 404);
    }

    await registry.remove(tenantId, webhookId);

    // Audit log (warning level for deletion)
    await createAuditLogFromContext(
      c,
      'webhook.deleted',
      'webhook',
      webhookId,
      {
        name: existing.name,
        url: existing.url,
      },
      'warning'
    );

    return c.json({ success: true, deleted: webhookId });
  } catch (error) {
    log.error('Delete error', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to delete webhook' }, 500);
  }
}

/**
 * POST /api/admin/webhooks/:id/test
 * Send a test webhook delivery
 *
 * Sends a test event to the webhook endpoint to verify connectivity.
 * Returns detailed information about the delivery attempt.
 */
export async function testWebhook(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('WebhookAPI');
  const tenantId = getTenantIdFromContext(c);
  const webhookId = c.req.param('id')!;

  if (!webhookId) {
    return c.json({ error: 'invalid_request', error_description: 'Webhook ID is required' }, 400);
  }

  try {
    const registry = createRegistry(c);

    // Check if webhook exists
    const webhook = await registry.get(tenantId, webhookId);
    if (!webhook) {
      return c.json({ error: 'not_found', error_description: 'Webhook not found' }, 404);
    }
    if (!validateWebhookDispatchUrl(c, webhook.url)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Configured webhook URL is not safe to call',
        },
        400
      );
    }

    // Build test payload
    const testPayload = {
      event: 'webhook.test',
      webhook_id: webhookId,
      tenant_id: tenantId,
      timestamp: new Date().toISOString(),
      test: true,
      data: {
        message: 'This is a test webhook delivery',
      },
    };

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Webhook-Event': 'webhook.test',
      'X-Webhook-ID': webhookId,
      'X-Webhook-Timestamp': testPayload.timestamp,
      ...(webhook.headers || {}),
    };

    // Generate signature if secret is configured
    if (webhook.secretEncrypted && c.env.PII_ENCRYPTION_KEY) {
      // Decrypt the secret for signing
      const decryptResult = await decryptValue(webhook.secretEncrypted, c.env.PII_ENCRYPTION_KEY);
      if (decryptResult.decrypted) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          'raw',
          encoder.encode(decryptResult.decrypted),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );
        const payloadBytes = encoder.encode(JSON.stringify(testPayload));
        const signatureBytes = await crypto.subtle.sign('HMAC', key, payloadBytes);
        const signature = Array.from(new Uint8Array(signatureBytes))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
      }
    }

    // Send test request
    const startTime = Date.now();
    let response: Response;
    let error: string | null = null;
    let responseBody: string | null = null;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), webhook.timeoutMs || 30000);

      response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(testPayload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Try to read response body (limited to first 1KB)
      try {
        const text = await response.text();
        responseBody = text.slice(0, 1024);
      } catch {
        responseBody = null;
      }
    } catch (err) {
      const endTime = Date.now();
      error = err instanceof Error ? err.message : 'Unknown error';

      // Audit log for failed test
      await createAuditLogFromContext(c, 'webhook.test_failed', 'webhook', webhookId, {
        error,
        duration_ms: endTime - startTime,
      });

      return c.json({
        success: false,
        webhook_id: webhookId,
        url: webhook.url,
        error,
        duration_ms: endTime - startTime,
        timestamp: testPayload.timestamp,
      });
    }

    const endTime = Date.now();
    const durationMs = endTime - startTime;
    const isSuccess = response.status >= 200 && response.status < 300;

    // Audit log
    await createAuditLogFromContext(c, 'webhook.test', 'webhook', webhookId, {
      status_code: response.status,
      duration_ms: durationMs,
      success: isSuccess,
    });

    return c.json({
      success: isSuccess,
      webhook_id: webhookId,
      url: webhook.url,
      status_code: response.status,
      response_body: responseBody,
      duration_ms: durationMs,
      timestamp: testPayload.timestamp,
      headers_sent: Object.keys(headers),
    });
  } catch (error) {
    log.error('Test error', {}, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to test webhook' }, 500);
  }
}

// =============================================================================
// Phase 2: Webhook Deliveries
// =============================================================================

/**
 * Webhook delivery database row
 */
interface WebhookDeliveryRow {
  id: string;
  webhook_id: string;
  tenant_id: string;
  event_type: string;
  event_id: string;
  status: 'pending' | 'success' | 'failed' | 'retrying';
  status_code: number | null;
  request_headers: string | null;
  request_body: string | null;
  response_body: string | null;
  error_message: string | null;
  attempts: number;
  next_retry_at: number | null;
  created_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  detail_object_catalog_id: string | null;
  detail_artifact_id?: string | null;
}

function parseRequestHeaders(
  requestHeaders: string | null
): Record<string, string> | null {
  if (!requestHeaders) {
    return null;
  }

  try {
    const parsed = JSON.parse(requestHeaders) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Ignore invalid JSON preview values.
  }

  return null;
}

function formatWebhookDeliverySummary(row: WebhookDeliveryRow) {
  return {
    delivery_id: row.id,
    webhook_id: row.webhook_id,
    event_type: row.event_type,
    event_id: row.event_id,
    status: row.status,
    status_code: row.status_code,
    request_headers: parseRequestHeaders(row.request_headers),
    request_body_preview: buildBodyPreview(row.request_body),
    response_body_preview: buildBodyPreview(row.response_body),
    error_message: row.error_message,
    attempts: row.attempts,
    next_retry_at: formatTimestampIso(row.next_retry_at),
    created_at: formatTimestampIso(row.created_at),
    completed_at: formatTimestampIso(row.completed_at),
    duration_ms: row.duration_ms,
    has_detail: !!row.detail_object_catalog_id,
    detail_artifact_id: row.detail_artifact_id ?? null,
  };
}

function formatWebhookDeliveryDetail(
  row: WebhookDeliveryRow,
  detail: WebhookDeliveryDetailPayload | null
) {
  return {
    delivery_id: row.id,
    webhook_id: row.webhook_id,
    event_type: row.event_type,
    event_id: row.event_id,
    status: row.status,
    status_code: row.status_code,
    request_headers: detail?.requestHeaders ?? parseRequestHeaders(row.request_headers),
    request_body: detail?.requestBody ?? row.request_body,
    response_body: detail?.responseBody ?? row.response_body,
    error_message: row.error_message,
    attempts: row.attempts,
    next_retry_at: formatTimestampIso(row.next_retry_at),
    created_at: formatTimestampIso(row.created_at),
    completed_at: formatTimestampIso(row.completed_at),
    duration_ms: row.duration_ms,
    has_detail: !!row.detail_object_catalog_id,
    detail_artifact_id: row.detail_artifact_id ?? null,
  };
}

/**
 * GET /api/admin/webhooks/:id/deliveries
 * List delivery logs for a specific webhook with cursor-based pagination
 *
 * Query parameters:
 * - limit: number (1-100, default 20)
 * - cursor: string (opaque pagination cursor)
 * - filter: string (status=success,status=failed)
 * - from: ISO 8601 datetime (filter by created_at >= from)
 * - to: ISO 8601 datetime (filter by created_at <= to)
 */
export async function listWebhookDeliveries(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('WebhookAPI');
  const tenantId = getTenantIdFromContext(c);
  const webhookId = c.req.param('id')!;

  if (!webhookId) {
    return c.json({ error: 'invalid_request', error_description: 'Webhook ID is required' }, 400);
  }

  // Reject page-based pagination
  const page = c.req.query('page');
  const pageSize = c.req.query('page_size');
  if (page || pageSize) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Use cursor-based pagination. page/page_size not supported.',
      },
      400
    );
  }

  try {
    const registry = createRegistry(c);

    // Check if webhook exists and belongs to tenant
    const webhook = await registry.get(tenantId, webhookId);
    if (!webhook) {
      return c.json({ error: 'not_found', error_description: 'Webhook not found' }, 404);
    }

    // Parse query parameters
    const limitParam = c.req.query('limit');
    const cursor = c.req.query('cursor');
    const filter = c.req.query('filter');
    const from = c.req.query('from');
    const to = c.req.query('to');

    const limit = Math.min(Math.max(parseInt(limitParam || '20', 10) || 20, 1), 100);

    // Build query
    const whereClauses: string[] = ['wd.webhook_id = ?', 'wd.tenant_id = ?'];
    const bindings: unknown[] = [webhookId, tenantId];

    // Apply cursor
    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const parsed = JSON.parse(decoded) as { id: string; created_at: number };
        if (parsed.id && typeof parsed.created_at === 'number') {
          whereClauses.push('(wd.created_at < ? OR (wd.created_at = ? AND wd.id > ?))');
          bindings.push(parsed.created_at, parsed.created_at, parsed.id);
        }
      } catch {
        return c.json(
          { error: 'invalid_request', error_description: 'Invalid cursor format' },
          400
        );
      }
    }

    // Apply status filter
    if (filter) {
      const statusMatch = filter.match(/status=(\w+)/);
      if (statusMatch) {
        const status = statusMatch[1];
        if (['pending', 'success', 'failed', 'retrying'].includes(status)) {
          whereClauses.push('wd.status = ?');
          bindings.push(status);
        }
      }
    }

    // Apply date range filter
    if (from) {
      const fromTs = Math.floor(new Date(from).getTime() / 1000);
      if (!isNaN(fromTs)) {
        whereClauses.push('wd.created_at >= ?');
        bindings.push(fromTs);
      }
    }
    if (to) {
      const toTs = Math.floor(new Date(to).getTime() / 1000);
      if (!isNaN(toTs)) {
        whereClauses.push('wd.created_at <= ?');
        bindings.push(toTs);
      }
    }

    // Fetch data
    const adapter = getCoreAdapter(c);
    const limitPlusOne = limit + 1;
    const sql = `
      SELECT wd.id, wd.webhook_id, wd.tenant_id, wd.event_type, wd.event_id, wd.status,
             wd.status_code, wd.request_headers, wd.request_body, wd.response_body,
             wd.error_message, wd.attempts, wd.next_retry_at, wd.created_at,
             wd.completed_at, wd.duration_ms, wd.detail_object_catalog_id,
             oc.public_artifact_id AS detail_artifact_id
      FROM webhook_deliveries wd
      LEFT JOIN object_catalog oc
        ON oc.id = wd.detail_object_catalog_id
       AND oc.deleted_at IS NULL
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY wd.created_at DESC, wd.id ASC
      LIMIT ?
    `;
    bindings.push(limitPlusOne);

    const rows = await adapter.query<WebhookDeliveryRow>(sql, bindings);

    // Pagination
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | undefined;
    if (hasMore && data.length > 0) {
      const lastRow = data[data.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({ id: lastRow.id, created_at: lastRow.created_at })
      ).toString('base64url');
    }

    const formattedData = data.map((row) => formatWebhookDeliverySummary(row));

    return c.json({
      data: formattedData,
      pagination: {
        has_more: hasMore,
        ...(nextCursor && { next_cursor: nextCursor }),
      },
      webhook: {
        id: webhookId,
        name: webhook.name,
        url: webhook.url,
      },
    });
  } catch (error) {
    log.error('List deliveries error', { webhookId }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to list webhook deliveries' },
      500
    );
  }
}

/**
 * GET /api/admin/webhooks/:id/deliveries/:deliveryId
 * Load a single delivery with full request/response payloads.
 */
export async function getWebhookDelivery(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('WebhookAPI');
  const tenantId = getTenantIdFromContext(c);
  const webhookId = c.req.param('id')!;
  const deliveryId = c.req.param('deliveryId')!;

  if (!webhookId || !deliveryId) {
    return c.json(
      { error: 'invalid_request', error_description: 'Webhook ID and delivery ID are required' },
      400
    );
  }

  try {
    const registry = createRegistry(c);
    const webhook = await registry.get(tenantId, webhookId);
    if (!webhook) {
      return c.json({ error: 'not_found', error_description: 'Webhook not found' }, 404);
    }

    const adapter = getCoreAdapter(c);
    const row = await adapter.queryOne<WebhookDeliveryRow>(
      `SELECT wd.id, wd.webhook_id, wd.tenant_id, wd.event_type, wd.event_id, wd.status,
              wd.status_code, wd.request_headers, wd.request_body, wd.response_body,
              wd.error_message, wd.attempts, wd.next_retry_at, wd.created_at,
              wd.completed_at, wd.duration_ms, wd.detail_object_catalog_id,
              oc.public_artifact_id AS detail_artifact_id
         FROM webhook_deliveries wd
         LEFT JOIN object_catalog oc
           ON oc.id = wd.detail_object_catalog_id
          AND oc.deleted_at IS NULL
        WHERE wd.id = ? AND wd.webhook_id = ? AND wd.tenant_id = ?`,
      [deliveryId, webhookId, tenantId]
    );

    if (!row) {
      return c.json({ error: 'not_found', error_description: 'Delivery not found' }, 404);
    }

    const access = await requireWebhookPayloadReadAccess(c, {
      resourceIds: [deliveryId, row.detail_artifact_id, row.detail_object_catalog_id],
    });
    if (access instanceof Response) {
      return access;
    }

    const detail = await loadWebhookDeliveryPayload(
      c,
      tenantId,
      row.detail_artifact_id,
      row.detail_object_catalog_id
    );

    await auditAdminSensitiveRead(c as any, access, {
      action: 'webhook.delivery.detail_read',
      resourceType: 'webhook_delivery',
      resourceId: deliveryId,
      metadata: {
        webhook_id: webhookId,
        event_type: row.event_type,
      },
    });

    return c.json({
      delivery: formatWebhookDeliveryDetail(row, detail),
      webhook: {
        id: webhookId,
        name: webhook.name,
        url: webhook.url,
      },
    });
  } catch (error) {
    log.error('Get delivery error', { webhookId, deliveryId }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to fetch webhook delivery' },
      500
    );
  }
}

// =============================================================================
// Phase 3: Webhook Replay
// =============================================================================

/**
 * POST /api/admin/webhooks/:id/replay
 * Replay a failed webhook delivery
 *
 * Request body:
 * - delivery_id: string - The delivery ID to replay
 *
 * This will fetch the original delivery, re-send it to the webhook URL,
 * and create a new delivery record.
 */
export async function replayWebhookDelivery(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('WebhookAPI');
  const tenantId = getTenantIdFromContext(c);
  const webhookId = c.req.param('id')!;

  if (!webhookId) {
    return c.json({ error: 'invalid_request', error_description: 'Webhook ID is required' }, 400);
  }

  const permissionError = requireWebhookPayloadReplayPermission(c);
  if (permissionError) {
    return permissionError;
  }

  // Parse request body
  let body: { delivery_id?: string };
  try {
    body = await c.req.json<{ delivery_id?: string }>();
  } catch {
    return c.json({ error: 'invalid_request', error_description: 'Invalid JSON body' }, 400);
  }

  const deliveryId = body.delivery_id;
  if (!deliveryId) {
    return c.json({ error: 'invalid_request', error_description: 'delivery_id is required' }, 400);
  }

  try {
    const registry = createRegistry(c);

    // Check if webhook exists and belongs to tenant
    const webhook = await registry.get(tenantId, webhookId);
    if (!webhook) {
      return c.json({ error: 'not_found', error_description: 'Webhook not found' }, 404);
    }
    if (!validateWebhookDispatchUrl(c, webhook.url)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Configured webhook URL is not safe to call',
        },
        400
      );
    }

    // Fetch the original delivery
    const adapter = getCoreAdapter(c);
    const delivery = await adapter.queryOne<WebhookDeliveryRow>(
      `SELECT wd.id, wd.webhook_id, wd.tenant_id, wd.event_type, wd.event_id, wd.status,
              wd.request_headers, wd.request_body, wd.response_body, wd.attempts,
              wd.detail_object_catalog_id, wd.created_at, wd.completed_at,
              wd.next_retry_at, wd.duration_ms, wd.status_code, wd.error_message,
              oc.public_artifact_id AS detail_artifact_id
       FROM webhook_deliveries wd
       LEFT JOIN object_catalog oc
         ON oc.id = wd.detail_object_catalog_id
        AND oc.deleted_at IS NULL
       WHERE wd.id = ? AND wd.webhook_id = ? AND wd.tenant_id = ?`,
      [deliveryId, webhookId, tenantId]
    );

    if (!delivery) {
      return c.json({ error: 'not_found', error_description: 'Delivery not found' }, 404);
    }

    // Only allow replay of failed or retrying deliveries
    if (!['failed', 'retrying'].includes(delivery.status)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `Cannot replay delivery with status '${delivery.status}'. Only 'failed' or 'retrying' deliveries can be replayed.`,
        },
        400
      );
    }

    const originalDetail = await loadWebhookDeliveryPayload(
      c,
      tenantId,
      delivery.detail_artifact_id,
      delivery.detail_object_catalog_id
    );

    // Parse the original request body
    let originalPayload: unknown;
    const originalRequestBody = originalDetail?.requestBody ?? delivery.request_body;
    if (originalRequestBody) {
      try {
        originalPayload = JSON.parse(originalRequestBody);
      } catch {
        return c.json(
          { error: 'server_error', error_description: 'Failed to parse original request body' },
          500
        );
      }
    } else {
      return c.json(
        { error: 'server_error', error_description: 'Original request body not available' },
        500
      );
    }

    // Build replay payload with replay metadata
    const replayPayload = {
      ...(originalPayload as Record<string, unknown>),
      replay: {
        original_delivery_id: deliveryId,
        replayed_at: new Date().toISOString(),
      },
    };

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Webhook-Event': delivery.event_type,
      'X-Webhook-ID': webhookId,
      'X-Webhook-Timestamp': new Date().toISOString(),
      'X-Webhook-Replay': 'true',
      'X-Webhook-Original-Delivery': deliveryId,
      ...(webhook.headers || {}),
    };

    // Generate signature if secret is configured
    if (webhook.secretEncrypted && c.env.PII_ENCRYPTION_KEY) {
      const decryptResult = await decryptValue(webhook.secretEncrypted, c.env.PII_ENCRYPTION_KEY);
      if (decryptResult.decrypted) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          'raw',
          encoder.encode(decryptResult.decrypted),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );
        const payloadBytes = encoder.encode(JSON.stringify(replayPayload));
        const signatureBytes = await crypto.subtle.sign('HMAC', key, payloadBytes);
        const signature = Array.from(new Uint8Array(signatureBytes))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
      }
    }

    // Send replay request
    const startTime = Date.now();
    let response: Response;
    let error: string | null = null;
    let responseBody: string | null = null;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), webhook.timeoutMs || 30000);

      response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(replayPayload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Read response body (limited)
      try {
        const text = await response.text();
        responseBody = text.slice(0, 1024);
      } catch {
        responseBody = null;
      }
    } catch (err) {
      const endTime = Date.now();
      error = err instanceof Error ? err.message : 'Unknown error';

      // Create new delivery record for failed replay
      const newDeliveryId = crypto.randomUUID();
      const nowTs = Math.floor(Date.now() / 1000);
      let detailObjectCatalogId: string | null = null;
      try {
        detailObjectCatalogId = await storeWebhookDeliveryPayload(
          c,
          tenantId,
          webhookId,
          newDeliveryId,
          nowTs,
          {
            requestHeaders: headers,
            requestBody: JSON.stringify(replayPayload),
            responseBody: null,
          }
        );
      } catch (_storageError) {
        log.warn('Failed to externalize failed replay payload; falling back to inline storage', {
          webhookId,
          deliveryId: newDeliveryId,
        });
      }
      const requestHeadersValue = detailObjectCatalogId
        ? JSON.stringify(buildHeaderPreview(headers))
        : JSON.stringify(headers);
      const requestBodyValue = detailObjectCatalogId
        ? buildBodyPreview(JSON.stringify(replayPayload))
        : JSON.stringify(replayPayload);

      await adapter.execute(
        `INSERT INTO webhook_deliveries (
          id, webhook_id, tenant_id, event_type, event_id, status,
          request_headers, request_body, error_message, attempts,
          created_at, duration_ms, detail_object_catalog_id
        ) VALUES (?, ?, ?, ?, ?, 'failed', ?, ?, ?, 1, ?, ?, ?)`,
        [
          newDeliveryId,
          webhookId,
          tenantId,
          delivery.event_type,
          `${delivery.event_id}_replay`,
          requestHeadersValue,
          requestBodyValue,
          error,
          nowTs,
          endTime - startTime,
          detailObjectCatalogId,
        ]
      );

      // Audit log for failed replay
      await createAuditLogFromContext(c, 'webhook.replay_failed', 'webhook', webhookId, {
        original_delivery_id: deliveryId,
        new_delivery_id: newDeliveryId,
        error,
        duration_ms: endTime - startTime,
      });

      return c.json({
        success: false,
        webhook_id: webhookId,
        original_delivery_id: deliveryId,
        new_delivery_id: newDeliveryId,
        error,
        duration_ms: endTime - startTime,
      });
    }

    const endTime = Date.now();
    const durationMs = endTime - startTime;
    const isSuccess = response.status >= 200 && response.status < 300;

    // Create new delivery record
    const newDeliveryId = crypto.randomUUID();
    const nowTs = Math.floor(Date.now() / 1000);
    let detailObjectCatalogId: string | null = null;
    try {
      detailObjectCatalogId = await storeWebhookDeliveryPayload(
        c,
        tenantId,
        webhookId,
        newDeliveryId,
        nowTs,
        {
          requestHeaders: headers,
          requestBody: JSON.stringify(replayPayload),
          responseBody,
        }
      );
    } catch (_storageError) {
      log.warn('Failed to externalize replay payload; falling back to inline storage', {
        webhookId,
        deliveryId: newDeliveryId,
      });
    }
    const requestHeadersValue = detailObjectCatalogId
      ? JSON.stringify(buildHeaderPreview(headers))
      : JSON.stringify(headers);
    const requestBodyValue = detailObjectCatalogId
      ? buildBodyPreview(JSON.stringify(replayPayload))
      : JSON.stringify(replayPayload);
    const responseBodyValue = detailObjectCatalogId ? buildBodyPreview(responseBody) : responseBody;

    await adapter.execute(
      `INSERT INTO webhook_deliveries (
        id, webhook_id, tenant_id, event_type, event_id, status,
        status_code, request_headers, request_body, response_body,
        attempts, created_at, completed_at, duration_ms, detail_object_catalog_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        newDeliveryId,
        webhookId,
        tenantId,
        delivery.event_type,
        `${delivery.event_id}_replay`,
        isSuccess ? 'success' : 'failed',
        response.status,
        requestHeadersValue,
        requestBodyValue,
        responseBodyValue,
        nowTs,
        nowTs,
        durationMs,
        detailObjectCatalogId,
      ]
    );

    // Audit log
    await createAuditLogFromContext(c, 'webhook.replay', 'webhook', webhookId, {
      original_delivery_id: deliveryId,
      new_delivery_id: newDeliveryId,
      status_code: response.status,
      success: isSuccess,
      duration_ms: durationMs,
    });

    return c.json({
      success: isSuccess,
      webhook_id: webhookId,
      original_delivery_id: deliveryId,
      new_delivery_id: newDeliveryId,
      status_code: response.status,
      response_body: responseBody,
      duration_ms: durationMs,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.error('Replay error', { webhookId, deliveryId }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to replay webhook' }, 500);
  }
}
