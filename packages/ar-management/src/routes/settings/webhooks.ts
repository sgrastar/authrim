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
  D1Adapter,
  createWebhookRegistry,
  validateEventPattern,
  createAuditLogFromContext,
  getTenantIdFromContext,
  encryptValue,
  decryptValue,
  getLogger,
  type WebhookConfigWithScope,
  type Env,
} from '@authrim/ar-lib-core';

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

/**
 * Create WebhookRegistry from context
 */
function createRegistry(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('WebhookAPI');
  const adapter = new D1Adapter({ db: c.env.DB });
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
  const webhookId = c.req.param('id');

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
  const webhookId = c.req.param('id');

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
  const webhookId = c.req.param('id');

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
  const webhookId = c.req.param('id');

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
  const webhookId = c.req.param('id');

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
    const whereClauses: string[] = ['webhook_id = ?', 'tenant_id = ?'];
    const bindings: unknown[] = [webhookId, tenantId];

    // Apply cursor
    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const parsed = JSON.parse(decoded) as { id: string; created_at: number };
        if (parsed.id && typeof parsed.created_at === 'number') {
          whereClauses.push('(created_at < ? OR (created_at = ? AND id > ?))');
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
          whereClauses.push('status = ?');
          bindings.push(status);
        }
      }
    }

    // Apply date range filter
    if (from) {
      const fromTs = Math.floor(new Date(from).getTime() / 1000);
      if (!isNaN(fromTs)) {
        whereClauses.push('created_at >= ?');
        bindings.push(fromTs);
      }
    }
    if (to) {
      const toTs = Math.floor(new Date(to).getTime() / 1000);
      if (!isNaN(toTs)) {
        whereClauses.push('created_at <= ?');
        bindings.push(toTs);
      }
    }

    // Fetch data
    const adapter = new D1Adapter({ db: c.env.DB });
    const limitPlusOne = limit + 1;
    const sql = `
      SELECT id, webhook_id, tenant_id, event_type, event_id, status,
             status_code, request_headers, request_body, response_body,
             error_message, attempts, next_retry_at, created_at,
             completed_at, duration_ms
      FROM webhook_deliveries
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY created_at DESC, id ASC
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

    // Format response
    const formattedData = data.map((row) => {
      // Parse JSON fields safely
      let requestHeaders: Record<string, string> | null = null;
      if (row.request_headers) {
        try {
          requestHeaders = JSON.parse(row.request_headers) as Record<string, string>;
        } catch {
          // Invalid JSON
        }
      }

      return {
        delivery_id: row.id,
        webhook_id: row.webhook_id,
        event_type: row.event_type,
        event_id: row.event_id,
        status: row.status,
        status_code: row.status_code,
        request_headers: requestHeaders,
        // Truncate bodies for list view (full body available in detail endpoint if needed)
        request_body_preview: row.request_body ? row.request_body.slice(0, 200) : null,
        response_body_preview: row.response_body ? row.response_body.slice(0, 200) : null,
        error_message: row.error_message,
        attempts: row.attempts,
        next_retry_at: row.next_retry_at ? new Date(row.next_retry_at * 1000).toISOString() : null,
        created_at: new Date(
          row.created_at < 1e12 ? row.created_at * 1000 : row.created_at
        ).toISOString(),
        completed_at: row.completed_at
          ? new Date(
              row.completed_at < 1e12 ? row.completed_at * 1000 : row.completed_at
            ).toISOString()
          : null,
        duration_ms: row.duration_ms,
      };
    });

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
  const webhookId = c.req.param('id');

  if (!webhookId) {
    return c.json({ error: 'invalid_request', error_description: 'Webhook ID is required' }, 400);
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

    // Fetch the original delivery
    const adapter = new D1Adapter({ db: c.env.DB });
    const delivery = await adapter.queryOne<WebhookDeliveryRow>(
      `SELECT id, webhook_id, tenant_id, event_type, event_id, status,
              request_headers, request_body, attempts
       FROM webhook_deliveries
       WHERE id = ? AND webhook_id = ? AND tenant_id = ?`,
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

    // Parse the original request body
    let originalPayload: unknown;
    if (delivery.request_body) {
      try {
        originalPayload = JSON.parse(delivery.request_body);
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

      await adapter.execute(
        `INSERT INTO webhook_deliveries (
          id, webhook_id, tenant_id, event_type, event_id, status,
          request_headers, request_body, error_message, attempts,
          created_at, duration_ms
        ) VALUES (?, ?, ?, ?, ?, 'failed', ?, ?, ?, 1, ?, ?)`,
        [
          newDeliveryId,
          webhookId,
          tenantId,
          delivery.event_type,
          `${delivery.event_id}_replay`,
          JSON.stringify(headers),
          JSON.stringify(replayPayload),
          error,
          nowTs,
          endTime - startTime,
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

    await adapter.execute(
      `INSERT INTO webhook_deliveries (
        id, webhook_id, tenant_id, event_type, event_id, status,
        status_code, request_headers, request_body, response_body,
        attempts, created_at, completed_at, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        newDeliveryId,
        webhookId,
        tenantId,
        delivery.event_type,
        `${delivery.event_id}_replay`,
        isSuccess ? 'success' : 'failed',
        response.status,
        JSON.stringify(headers),
        JSON.stringify(replayPayload),
        responseBody,
        nowTs,
        nowTs,
        durationMs,
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
