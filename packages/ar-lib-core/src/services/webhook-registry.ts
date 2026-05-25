/**
 * Webhook Registry Service
 *
 * Manages webhook configuration CRUD operations with:
 * - Tenant + Client scope support (Tenant-level and Client-level webhooks)
 * - SSRF protection via validateWebhookUrl()
 * - Event pattern validation for ReDoS protection
 * - DatabaseAdapter abstraction (no direct D1)
 * - Secret encryption (AES-256-GCM)
 *
 * Security features:
 * - SSRF: Blocks private IPs, metadata endpoints, internal hostnames
 * - ReDoS: Validates event patterns to prevent regex bomb attacks
 * - Secrets: Stored encrypted, never returned in plaintext
 *
 * @packageDocumentation
 */

import type { DatabaseAdapter } from '../db/adapter';
import type {
  WebhookConfig,
  WebhookRegistry as IWebhookRegistry,
  CreateWebhookInput,
  UpdateWebhookInput,
  DEFAULT_WEBHOOK_RETRY_POLICY,
  WebhookRetryPolicy,
} from '../types/events/webhook';
import { validateWebhookUrl } from '../utils/ssrf-protection';
import { matchEventPattern } from '../types/events/unified-event';

// =============================================================================
// Types
// =============================================================================

/**
 * Webhook scope.
 * - 'tenant': Webhook receives all events for the tenant
 * - 'client': Webhook receives only events for a specific client
 */
export type WebhookScope = 'tenant' | 'client';

/**
 * Extended webhook config with client scope support.
 */
export interface WebhookConfigWithScope extends WebhookConfig {
  /** Client ID (null for tenant-level webhooks) */
  clientId?: string;
  /** Webhook scope */
  scope: WebhookScope;
}

/**
 * Extended create input with client scope.
 */
export interface CreateWebhookWithScopeInput extends CreateWebhookInput {
  /** Client ID (null for tenant-level webhooks) */
  clientId?: string;
}

/**
 * Database row type for webhook_configs table.
 */
interface WebhookConfigRow {
  id: string;
  tenant_id: string;
  client_id: string | null;
  scope: string;
  name: string;
  url: string;
  events: string; // JSON array
  secret_encrypted: string | null;
  headers: string | null; // JSON
  retry_policy: string; // JSON
  timeout_ms: number;
  active: number; // SQLite boolean
  created_at: string;
  updated_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
}

/**
 * Options for listing webhooks.
 */
export interface ListWebhooksOptions {
  /** Only return active webhooks */
  activeOnly?: boolean;
  /** Filter by scope */
  scope?: WebhookScope;
  /** Filter by client ID (for client-scoped webhooks) */
  clientId?: string;
  /** Pagination limit */
  limit?: number;
  /** Pagination offset */
  offset?: number;
}

/**
 * Function to encrypt webhook secrets.
 */
export type SecretEncryptor = (plaintext: string) => Promise<string>;

/**
 * Configuration for creating a WebhookRegistry.
 */
export interface WebhookRegistryConfig {
  /** Database adapter for persistence */
  adapter: DatabaseAdapter;
  /** Secret encryption function */
  encryptSecret?: SecretEncryptor;
  /** Allow localhost HTTP in development */
  allowLocalhostHttp?: boolean;
  /** Maximum event patterns per webhook */
  maxEventPatterns?: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Default timeout for webhook requests (10 seconds) */
const DEFAULT_TIMEOUT_MS = 10000;

/** Maximum characters for event pattern */
const MAX_PATTERN_LENGTH = 256;

/** Maximum segments in event pattern */
const MAX_PATTERN_SEGMENTS = 10;

/** Maximum event patterns per webhook */
const DEFAULT_MAX_EVENT_PATTERNS = 50;

/** Valid pattern characters regex */
const VALID_PATTERN_CHARS = /^[a-zA-Z0-9.*_-]+$/;

/** Default retry policy */
const DEFAULT_RETRY_POLICY: WebhookRetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 60000,
};

function normalizePaginationValue(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return Math.min(value, max);
}

// =============================================================================
// Event Pattern Validation
// =============================================================================

/**
 * Validation result for event patterns.
 */
export interface PatternValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate an event pattern for ReDoS protection.
 *
 * Prevents:
 * - Overly long patterns
 * - Invalid characters
 * - Too many segments
 *
 * @param pattern - Event pattern to validate
 * @returns Validation result
 */
export function validateEventPattern(pattern: string): PatternValidationResult {
  // Check length
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { valid: false, error: `Pattern too long (max ${MAX_PATTERN_LENGTH} chars)` };
  }

  // Check for empty pattern
  if (!pattern || pattern.trim() === '') {
    return { valid: false, error: 'Pattern cannot be empty' };
  }

  // Check valid characters (alphanumeric, ., *, _, -)
  if (!VALID_PATTERN_CHARS.test(pattern)) {
    return { valid: false, error: 'Pattern contains invalid characters' };
  }

  // Check segment count
  const segments = pattern.split('.');
  if (segments.length > MAX_PATTERN_SEGMENTS) {
    return { valid: false, error: `Too many segments (max ${MAX_PATTERN_SEGMENTS})` };
  }

  // Check for empty segments
  if (segments.some((s) => s === '')) {
    return { valid: false, error: 'Pattern contains empty segments' };
  }

  return { valid: true };
}

// =============================================================================
// WebhookRegistry Implementation
// =============================================================================

/**
 * Webhook Registry implementation.
 *
 * Provides CRUD operations for webhook configurations with:
 * - Tenant + Client scope support
 * - SSRF protection
 * - Event pattern validation
 *
 * @example
 * ```typescript
 * const registry = createWebhookRegistry({
 *   adapter: createDatabaseAdapter(env.CORE_DB),
 *   encryptSecret: async (s) => encrypt(s, key),
 * });
 *
 * // Register tenant-level webhook
 * const id = await registry.register('tenant_123', {
 *   name: 'Audit Logger',
 *   url: 'https://example.com/audit',
 *   events: ['auth.*', 'token.*'],
 * });
 *
 * // Register client-level webhook
 * const clientId = await registry.register('tenant_123', {
 *   name: 'Client Webhook',
 *   url: 'https://client.example.com/webhook',
 *   events: ['auth.login.*'],
 *   clientId: 'client_456',
 * });
 * ```
 */
export class WebhookRegistryImpl implements IWebhookRegistry {
  private readonly adapter: DatabaseAdapter;
  private readonly encryptSecret?: SecretEncryptor;
  private readonly allowLocalhostHttp: boolean;
  private readonly maxEventPatterns: number;

  constructor(config: WebhookRegistryConfig) {
    this.adapter = config.adapter;
    this.encryptSecret = config.encryptSecret;
    this.allowLocalhostHttp = config.allowLocalhostHttp ?? false;
    this.maxEventPatterns = config.maxEventPatterns ?? DEFAULT_MAX_EVENT_PATTERNS;
  }

  // ===========================================================================
  // CRUD Operations
  // ===========================================================================

  /**
   * Register a new webhook.
   *
   * @param tenantId - Tenant ID
   * @param input - Webhook configuration
   * @returns Generated webhook ID
   * @throws Error if URL is invalid or events are malformed
   */
  async register(tenantId: string, input: CreateWebhookInput): Promise<string>;
  async register(tenantId: string, input: CreateWebhookWithScopeInput): Promise<string>;
  async register(tenantId: string, input: CreateWebhookWithScopeInput): Promise<string> {
    // Validate URL (SSRF protection)
    const urlValidation = validateWebhookUrl(input.url, this.allowLocalhostHttp);
    if (!urlValidation.valid) {
      throw new Error(`Invalid webhook URL: ${urlValidation.error}`);
    }

    // Validate event patterns
    this.validateEventPatterns(input.events);

    // Generate ID
    const id = `wh_${crypto.randomUUID().replace(/-/g, '')}`;
    const now = new Date().toISOString();

    // Determine scope
    const scope: WebhookScope = input.clientId ? 'client' : 'tenant';

    // Encrypt secret if provided
    let secretEncrypted: string | null = null;
    if (input.secret && this.encryptSecret) {
      secretEncrypted = await this.encryptSecret(input.secret);
    }

    // Build retry policy
    const retryPolicy: WebhookRetryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      ...input.retryPolicy,
    };

    // Insert into database
    await this.adapter.execute(
      `INSERT INTO webhook_configs (
        id, tenant_id, client_id, scope, name, url, events,
        secret_encrypted, headers, retry_policy, timeout_ms,
        active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        input.clientId ?? null,
        scope,
        input.name,
        input.url,
        JSON.stringify(input.events),
        secretEncrypted,
        input.headers ? JSON.stringify(input.headers) : null,
        JSON.stringify(retryPolicy),
        input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        1, // active = true
        now,
        now,
      ]
    );

    return id;
  }

  /**
   * Update an existing webhook.
   *
   * @param tenantId - Tenant ID
   * @param id - Webhook ID
   * @param input - Fields to update
   * @throws Error if webhook not found or validation fails
   */
  async update(tenantId: string, id: string, input: UpdateWebhookInput): Promise<void> {
    // Verify webhook exists and belongs to tenant
    const existing = await this.get(tenantId, id);
    if (!existing) {
      throw new Error('Webhook not found');
    }

    // Validate URL if provided
    if (input.url) {
      const urlValidation = validateWebhookUrl(input.url, this.allowLocalhostHttp);
      if (!urlValidation.valid) {
        throw new Error(`Invalid webhook URL: ${urlValidation.error}`);
      }
    }

    // Validate event patterns if provided
    if (input.events) {
      this.validateEventPatterns(input.events);
    }

    // Build update fields
    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) {
      updates.push('name = ?');
      params.push(input.name);
    }

    if (input.url !== undefined) {
      updates.push('url = ?');
      params.push(input.url);
    }

    if (input.events !== undefined) {
      updates.push('events = ?');
      params.push(JSON.stringify(input.events));
    }

    if (input.secret !== undefined && this.encryptSecret) {
      updates.push('secret_encrypted = ?');
      params.push(await this.encryptSecret(input.secret));
    }

    if (input.headers !== undefined) {
      updates.push('headers = ?');
      params.push(input.headers ? JSON.stringify(input.headers) : null);
    }

    if (input.retryPolicy !== undefined) {
      const retryPolicy = {
        ...DEFAULT_RETRY_POLICY,
        ...existing.retryPolicy,
        ...input.retryPolicy,
      };
      updates.push('retry_policy = ?');
      params.push(JSON.stringify(retryPolicy));
    }

    if (input.timeoutMs !== undefined) {
      updates.push('timeout_ms = ?');
      params.push(input.timeoutMs);
    }

    if (input.active !== undefined) {
      updates.push('active = ?');
      params.push(input.active ? 1 : 0);
    }

    if (updates.length === 0) {
      return; // Nothing to update
    }

    // Add updated_at
    updates.push('updated_at = ?');
    params.push(new Date().toISOString());

    // Add WHERE clause params
    params.push(id, tenantId);

    await this.adapter.execute(
      `UPDATE webhook_configs SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`,
      params
    );
  }

  /**
   * Remove a webhook.
   *
   * @param tenantId - Tenant ID
   * @param id - Webhook ID
   */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.adapter.execute('DELETE FROM webhook_configs WHERE id = ? AND tenant_id = ?', [
      id,
      tenantId,
    ]);
  }

  /**
   * Get a webhook by ID.
   *
   * @param tenantId - Tenant ID
   * @param id - Webhook ID
   * @returns Webhook config or null if not found
   */
  async get(tenantId: string, id: string): Promise<WebhookConfigWithScope | null> {
    const row = await this.adapter.queryOne<WebhookConfigRow>(
      'SELECT * FROM webhook_configs WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (!row) {
      return null;
    }

    return this.rowToConfig(row);
  }

  /**
   * List all webhooks for a tenant.
   *
   * @param tenantId - Tenant ID
   * @param options - Filter options
   * @returns List of webhook configs
   */
  async list(tenantId: string, options?: ListWebhooksOptions): Promise<WebhookConfigWithScope[]> {
    const conditions: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];

    if (options?.activeOnly) {
      conditions.push('active = 1');
    }

    if (options?.scope) {
      conditions.push('scope = ?');
      params.push(options.scope);
    }

    if (options?.clientId) {
      conditions.push('client_id = ?');
      params.push(options.clientId);
    }

    let sql = `SELECT * FROM webhook_configs WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`;

    const limit = normalizePaginationValue(options?.limit, 1000);
    if (limit && limit > 0) {
      sql += ' LIMIT ?';
      params.push(limit);

      const offset = normalizePaginationValue(options?.offset, Number.MAX_SAFE_INTEGER);
      if (offset && offset > 0) {
        sql += ' OFFSET ?';
        params.push(offset);
      }
    }

    const rows = await this.adapter.query<WebhookConfigRow>(sql, params);
    return rows.map((row) => this.rowToConfig(row));
  }

  /**
   * Find webhooks that match an event type.
   *
   * Returns both:
   * - Tenant-level webhooks matching the event
   * - Client-level webhooks matching the event (if clientId provided)
   *
   * @param tenantId - Tenant ID
   * @param eventType - Event type to match
   * @param clientId - Optional client ID to include client-scoped webhooks
   * @returns List of matching webhook configs
   */
  async findByEventType(
    tenantId: string,
    eventType: string,
    clientId?: string
  ): Promise<WebhookConfigWithScope[]> {
    // Get all active webhooks for this tenant
    const conditions: string[] = ['tenant_id = ?', 'active = 1'];
    const params: unknown[] = [tenantId];

    // Include tenant-level webhooks + optionally client-level webhooks
    if (clientId) {
      conditions.push('(scope = ? OR (scope = ? AND client_id = ?))');
      params.push('tenant', 'client', clientId);
    } else {
      conditions.push('scope = ?');
      params.push('tenant');
    }

    const rows = await this.adapter.query<WebhookConfigRow>(
      `SELECT * FROM webhook_configs WHERE ${conditions.join(' AND ')}`,
      params
    );

    // Filter by event pattern matching
    const matching: WebhookConfigWithScope[] = [];
    for (const row of rows) {
      const config = this.rowToConfig(row);
      const matchesEvent = config.events.some((pattern) => matchEventPattern(eventType, pattern));
      if (matchesEvent) {
        matching.push(config);
      }
    }

    return matching;
  }

  // ===========================================================================
  // Delivery Status Updates
  // ===========================================================================

  /**
   * Record successful delivery.
   *
   * @param id - Webhook ID
   * @param tenantId - Tenant ID
   */
  async recordSuccess(id: string, tenantId: string): Promise<void> {
    await this.adapter.execute(
      'UPDATE webhook_configs SET last_success_at = ? WHERE id = ? AND tenant_id = ?',
      [new Date().toISOString(), id, tenantId]
    );
  }

  /**
   * Record failed delivery.
   *
   * @param id - Webhook ID
   * @param tenantId - Tenant ID
   */
  async recordFailure(id: string, tenantId: string): Promise<void> {
    await this.adapter.execute(
      'UPDATE webhook_configs SET last_failure_at = ? WHERE id = ? AND tenant_id = ?',
      [new Date().toISOString(), id, tenantId]
    );
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Validate event patterns.
   */
  private validateEventPatterns(events: string[]): void {
    if (!events || events.length === 0) {
      throw new Error('At least one event pattern is required');
    }

    if (events.length > this.maxEventPatterns) {
      throw new Error(`Too many event patterns (max ${this.maxEventPatterns})`);
    }

    for (const pattern of events) {
      const result = validateEventPattern(pattern);
      if (!result.valid) {
        throw new Error(`Invalid event pattern '${pattern}': ${result.error}`);
      }
    }
  }

  /**
   * Convert database row to WebhookConfig.
   */
  private rowToConfig(row: WebhookConfigRow): WebhookConfigWithScope {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      clientId: row.client_id ?? undefined,
      scope: row.scope as WebhookScope,
      name: row.name,
      url: row.url,
      events: JSON.parse(row.events),
      secretEncrypted: row.secret_encrypted ?? undefined,
      headers: row.headers ? JSON.parse(row.headers) : undefined,
      retryPolicy: JSON.parse(row.retry_policy),
      timeoutMs: row.timeout_ms,
      active: row.active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastSuccessAt: row.last_success_at ?? undefined,
      lastFailureAt: row.last_failure_at ?? undefined,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new webhook registry.
 *
 * @param config - Registry configuration
 * @returns Webhook registry instance
 *
 * @example
 * ```typescript
 * const registry = createWebhookRegistry({
 *   adapter: createDatabaseAdapter(env.CORE_DB),
 *   encryptSecret: async (plaintext) => {
 *     return await encryptAES256GCM(plaintext, env.ENCRYPTION_KEY);
 *   },
 *   allowLocalhostHttp: env.ENVIRONMENT === 'development',
 * });
 *
 * // Register a webhook
 * const id = await registry.register('tenant_default', {
 *   name: 'Event Logger',
 *   url: 'https://example.com/events',
 *   events: ['auth.*', 'token.*'],
 *   secret: 'my-webhook-secret',
 * });
 * ```
 */
export function createWebhookRegistry(config: WebhookRegistryConfig): WebhookRegistryImpl {
  return new WebhookRegistryImpl(config);
}
