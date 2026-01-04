/**
 * Audit Storage Configuration Settings API
 *
 * Manages audit log storage configuration including:
 * - Backend selection (D1, R2, Hyperdrive)
 * - Routing rules for directing logs to specific backends
 * - Retention policies
 * - Archive settings
 *
 * KV Keys:
 * - audit_storage_config: JSON-encoded AuditStorageConfig
 * - audit_retention_config: JSON-encoded AuditRetentionConfig
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import type {
  AuditStorageConfig,
  AuditRetentionConfig,
  AuditStorageRoutingRule,
} from '@authrim/ar-lib-core';
import { DEFAULT_AUDIT_STORAGE_CONFIG } from '@authrim/ar-lib-core';

// KV key constants
const KV_KEY_STORAGE_CONFIG = 'audit_storage_config';
const KV_KEY_RETENTION_CONFIG = 'audit_retention_config';
const KV_KEY_ROUTING_RULES = 'audit_routing_rules';

// Default retention config
const DEFAULT_RETENTION_CONFIG: AuditRetentionConfig = {
  eventLogRetentionDays: 90,
  piiLogRetentionDays: 365,
  archiveBeforeDelete: false,
};

/**
 * GET /api/admin/settings/audit-storage
 * Get audit storage configuration
 */
export async function getAuditStorageConfig(c: Context<{ Bindings: Env }>) {
  let storageConfig: AuditStorageConfig = { ...DEFAULT_AUDIT_STORAGE_CONFIG };
  let retentionConfig: AuditRetentionConfig = { ...DEFAULT_RETENTION_CONFIG };
  let routingRules: AuditStorageRoutingRule[] = [];
  let storageSource: 'kv' | 'default' = 'default';
  let retentionSource: 'kv' | 'default' = 'default';

  if (c.env.AUTHRIM_CONFIG) {
    try {
      const [storageValue, retentionValue, routingValue] = await Promise.all([
        c.env.AUTHRIM_CONFIG.get(KV_KEY_STORAGE_CONFIG),
        c.env.AUTHRIM_CONFIG.get(KV_KEY_RETENTION_CONFIG),
        c.env.AUTHRIM_CONFIG.get(KV_KEY_ROUTING_RULES),
      ]);

      if (storageValue) {
        storageConfig = JSON.parse(storageValue) as AuditStorageConfig;
        storageSource = 'kv';
      }

      if (retentionValue) {
        retentionConfig = JSON.parse(retentionValue) as AuditRetentionConfig;
        retentionSource = 'kv';
      }

      if (routingValue) {
        routingRules = JSON.parse(routingValue) as AuditStorageRoutingRule[];
      }
    } catch {
      // KV read error - use defaults
    }
  }

  return c.json({
    storage: {
      config: storageConfig,
      source: storageSource,
      kv_key: KV_KEY_STORAGE_CONFIG,
    },
    retention: {
      config: retentionConfig,
      source: retentionSource,
      kv_key: KV_KEY_RETENTION_CONFIG,
      constraints: {
        min_event_log_retention_days: 1,
        max_event_log_retention_days: 730,
        min_pii_log_retention_days: 1,
        max_pii_log_retention_days: 2555,
      },
    },
    routing_rules: {
      rules: routingRules,
      kv_key: KV_KEY_ROUTING_RULES,
    },
    defaults: {
      storage: DEFAULT_AUDIT_STORAGE_CONFIG,
      retention: DEFAULT_RETENTION_CONFIG,
    },
    backend_types: {
      D1: 'Cloudflare D1 (SQLite) - Hot data, fast queries',
      R2: 'Cloudflare R2 (Object Storage) - Archive, cost-efficient',
      HYPERDRIVE: 'External PostgreSQL - Enterprise, external compliance',
    },
    note: 'Changes take effect within 10 seconds (cache TTL)',
  });
}

/**
 * PUT /api/admin/settings/audit-storage
 * Update audit storage configuration
 */
export async function updateAuditStorageConfig(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  const body = await c.req.json<Partial<AuditStorageConfig>>();
  const errors: string[] = [];

  // Get existing config or default
  let existingConfig: AuditStorageConfig = { ...DEFAULT_AUDIT_STORAGE_CONFIG };
  try {
    const kvValue = await c.env.AUTHRIM_CONFIG.get(KV_KEY_STORAGE_CONFIG);
    if (kvValue) {
      existingConfig = JSON.parse(kvValue) as AuditStorageConfig;
    }
  } catch {
    // Use default
  }

  // Validate and merge defaultEventBackend
  if (body.defaultEventBackend !== undefined) {
    const validBackends = existingConfig.backends.map((b) => b.id);
    if (!validBackends.includes(body.defaultEventBackend)) {
      errors.push(`Invalid defaultEventBackend. Valid backends: ${validBackends.join(', ')}`);
    } else {
      existingConfig.defaultEventBackend = body.defaultEventBackend;
    }
  }

  // Validate and merge defaultPiiBackend
  if (body.defaultPiiBackend !== undefined) {
    const validBackends = existingConfig.backends.map((b) => b.id);
    if (!validBackends.includes(body.defaultPiiBackend)) {
      errors.push(`Invalid defaultPiiBackend. Valid backends: ${validBackends.join(', ')}`);
    } else {
      existingConfig.defaultPiiBackend = body.defaultPiiBackend;
    }
  }

  // Validate and merge batchConfig
  if (body.batchConfig) {
    if (body.batchConfig.maxBufferSize !== undefined) {
      if (body.batchConfig.maxBufferSize < 1 || body.batchConfig.maxBufferSize > 1000) {
        errors.push('batchConfig.maxBufferSize must be between 1 and 1000');
      } else {
        existingConfig.batchConfig.maxBufferSize = body.batchConfig.maxBufferSize;
      }
    }

    if (body.batchConfig.flushIntervalMs !== undefined) {
      if (body.batchConfig.flushIntervalMs < 100 || body.batchConfig.flushIntervalMs > 60000) {
        errors.push('batchConfig.flushIntervalMs must be between 100 and 60000');
      } else {
        existingConfig.batchConfig.flushIntervalMs = body.batchConfig.flushIntervalMs;
      }
    }

    if (body.batchConfig.maxBatchSize !== undefined) {
      if (body.batchConfig.maxBatchSize < 1 || body.batchConfig.maxBatchSize > 500) {
        errors.push('batchConfig.maxBatchSize must be between 1 and 500');
      } else {
        existingConfig.batchConfig.maxBatchSize = body.batchConfig.maxBatchSize;
      }
    }
  }

  if (errors.length > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: errors.join('; '),
      },
      400
    );
  }

  // Save updated config
  await c.env.AUTHRIM_CONFIG.put(KV_KEY_STORAGE_CONFIG, JSON.stringify(existingConfig));

  return c.json({
    success: true,
    config: existingConfig,
    kv_key: KV_KEY_STORAGE_CONFIG,
    note: 'Storage configuration updated. Changes will take effect within 10 seconds.',
  });
}

// ============================================
// Retention Configuration
// ============================================

/**
 * GET /api/admin/settings/audit-storage/retention
 * Get retention configuration
 */
export async function getRetentionConfig(c: Context<{ Bindings: Env }>) {
  let config: AuditRetentionConfig = { ...DEFAULT_RETENTION_CONFIG };
  let source: 'kv' | 'default' = 'default';

  if (c.env.AUTHRIM_CONFIG) {
    try {
      const kvValue = await c.env.AUTHRIM_CONFIG.get(KV_KEY_RETENTION_CONFIG);
      if (kvValue) {
        config = JSON.parse(kvValue) as AuditRetentionConfig;
        source = 'kv';
      }
    } catch {
      // Use default
    }
  }

  return c.json({
    config,
    source,
    default: DEFAULT_RETENTION_CONFIG,
    kv_key: KV_KEY_RETENTION_CONFIG,
    constraints: {
      event_log: {
        min_days: 1,
        max_days: 730,
        description: 'Event logs (non-PII) retention period',
      },
      pii_log: {
        min_days: 1,
        max_days: 2555,
        description: 'PII logs retention period (may be required by regulations)',
      },
    },
    archive_note:
      'When archiveBeforeDelete is enabled, logs are copied to R2 before deletion ' +
      'for compliance and recovery purposes.',
  });
}

/**
 * PUT /api/admin/settings/audit-storage/retention
 * Update retention configuration
 */
export async function updateRetentionConfig(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  const body = await c.req.json<Partial<AuditRetentionConfig>>();
  const errors: string[] = [];

  // Get existing config
  let existingConfig: AuditRetentionConfig = { ...DEFAULT_RETENTION_CONFIG };
  try {
    const kvValue = await c.env.AUTHRIM_CONFIG.get(KV_KEY_RETENTION_CONFIG);
    if (kvValue) {
      existingConfig = JSON.parse(kvValue) as AuditRetentionConfig;
    }
  } catch {
    // Use default
  }

  // Validate eventLogRetentionDays
  if (body.eventLogRetentionDays !== undefined) {
    if (body.eventLogRetentionDays < 1 || body.eventLogRetentionDays > 730) {
      errors.push('eventLogRetentionDays must be between 1 and 730');
    } else {
      existingConfig.eventLogRetentionDays = body.eventLogRetentionDays;
    }
  }

  // Validate piiLogRetentionDays
  if (body.piiLogRetentionDays !== undefined) {
    if (body.piiLogRetentionDays < 1 || body.piiLogRetentionDays > 2555) {
      errors.push('piiLogRetentionDays must be between 1 and 2555');
    } else {
      existingConfig.piiLogRetentionDays = body.piiLogRetentionDays;
    }
  }

  // Validate archiveBeforeDelete
  if (body.archiveBeforeDelete !== undefined) {
    if (typeof body.archiveBeforeDelete !== 'boolean') {
      errors.push('archiveBeforeDelete must be a boolean');
    } else {
      existingConfig.archiveBeforeDelete = body.archiveBeforeDelete;
    }
  }

  // Validate minimumRetentionDays
  if (body.minimumRetentionDays !== undefined) {
    if (body.minimumRetentionDays < 1 || body.minimumRetentionDays > 2555) {
      errors.push('minimumRetentionDays must be between 1 and 2555');
    } else {
      existingConfig.minimumRetentionDays = body.minimumRetentionDays;
    }
  }

  if (errors.length > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: errors.join('; '),
      },
      400
    );
  }

  await c.env.AUTHRIM_CONFIG.put(KV_KEY_RETENTION_CONFIG, JSON.stringify(existingConfig));

  return c.json({
    success: true,
    config: existingConfig,
    kv_key: KV_KEY_RETENTION_CONFIG,
    note: 'Retention configuration updated.',
  });
}

// ============================================
// Routing Rules
// ============================================

/**
 * GET /api/admin/settings/audit-storage/routing-rules
 * Get all routing rules
 */
export async function getRoutingRules(c: Context<{ Bindings: Env }>) {
  let rules: AuditStorageRoutingRule[] = [];

  if (c.env.AUTHRIM_CONFIG) {
    try {
      const kvValue = await c.env.AUTHRIM_CONFIG.get(KV_KEY_ROUTING_RULES);
      if (kvValue) {
        rules = JSON.parse(kvValue) as AuditStorageRoutingRule[];
      }
    } catch {
      // No rules
    }
  }

  return c.json({
    rules,
    count: rules.length,
    kv_key: KV_KEY_ROUTING_RULES,
    example_rule: {
      name: 'eu-tenant-routing',
      priority: 10,
      enabled: true,
      conditions: {
        tenantId: ['tenant-eu-1', 'tenant-eu-2'],
        logType: '*',
        region: 'EU',
      },
      backend: 'hyperdrive-eu',
      retention: {
        piiLogRetentionDays: 365,
      },
    },
    description:
      'Routing rules direct audit logs to specific backends based on conditions. ' +
      'Lower priority numbers are evaluated first.',
  });
}

/**
 * PUT /api/admin/settings/audit-storage/routing-rules
 * Update all routing rules (replace)
 */
export async function updateRoutingRules(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  const body = await c.req.json<{ rules: AuditStorageRoutingRule[] }>();
  const { rules } = body;

  if (!Array.isArray(rules)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'rules must be an array',
      },
      400
    );
  }

  const errors: string[] = [];

  // Validate each rule
  rules.forEach((rule, index) => {
    if (!rule.name) {
      errors.push(`Rule ${index}: name is required`);
    }
    if (typeof rule.priority !== 'number') {
      errors.push(`Rule ${index}: priority must be a number`);
    }
    if (typeof rule.enabled !== 'boolean') {
      errors.push(`Rule ${index}: enabled must be a boolean`);
    }
    if (!rule.backend) {
      errors.push(`Rule ${index}: backend is required`);
    }
    if (!rule.conditions) {
      errors.push(`Rule ${index}: conditions is required`);
    }
  });

  if (errors.length > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: errors.join('; '),
      },
      400
    );
  }

  // Sort by priority
  const sortedRules = [...rules].sort((a, b) => a.priority - b.priority);

  await c.env.AUTHRIM_CONFIG.put(KV_KEY_ROUTING_RULES, JSON.stringify(sortedRules));

  return c.json({
    success: true,
    rules: sortedRules,
    count: sortedRules.length,
    kv_key: KV_KEY_ROUTING_RULES,
    note: 'Routing rules updated and sorted by priority.',
  });
}

/**
 * POST /api/admin/settings/audit-storage/routing-rules
 * Add a new routing rule
 */
export async function addRoutingRule(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  const newRule = await c.req.json<AuditStorageRoutingRule>();

  // Validate rule
  const errors: string[] = [];
  if (!newRule.name) errors.push('name is required');
  if (typeof newRule.priority !== 'number') errors.push('priority must be a number');
  if (typeof newRule.enabled !== 'boolean') errors.push('enabled must be a boolean');
  if (!newRule.backend) errors.push('backend is required');
  if (!newRule.conditions) errors.push('conditions is required');

  if (errors.length > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: errors.join('; '),
      },
      400
    );
  }

  // Get existing rules
  let rules: AuditStorageRoutingRule[] = [];
  try {
    const kvValue = await c.env.AUTHRIM_CONFIG.get(KV_KEY_ROUTING_RULES);
    if (kvValue) {
      rules = JSON.parse(kvValue) as AuditStorageRoutingRule[];
    }
  } catch {
    // No existing rules
  }

  // Check for duplicate name
  if (rules.some((r) => r.name === newRule.name)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Rule with name "${newRule.name}" already exists`,
      },
      400
    );
  }

  // Add and sort
  rules.push(newRule);
  rules.sort((a, b) => a.priority - b.priority);

  await c.env.AUTHRIM_CONFIG.put(KV_KEY_ROUTING_RULES, JSON.stringify(rules));

  return c.json({
    success: true,
    rule: newRule,
    total_rules: rules.length,
    note: 'Routing rule added.',
  });
}

/**
 * DELETE /api/admin/settings/audit-storage/routing-rules/:name
 * Delete a routing rule by name
 */
export async function deleteRoutingRule(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
        error_code: 'AR100001',
      },
      500
    );
  }

  const ruleName = c.req.param('name');

  if (!ruleName) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Rule name is required',
      },
      400
    );
  }

  // Get existing rules
  let rules: AuditStorageRoutingRule[] = [];
  try {
    const kvValue = await c.env.AUTHRIM_CONFIG.get(KV_KEY_ROUTING_RULES);
    if (kvValue) {
      rules = JSON.parse(kvValue) as AuditStorageRoutingRule[];
    }
  } catch {
    // No existing rules
  }

  const originalLength = rules.length;
  rules = rules.filter((r) => r.name !== ruleName);

  if (rules.length === originalLength) {
    return c.json(
      {
        error: 'not_found',
        error_description: `Rule with name "${ruleName}" not found`,
      },
      404
    );
  }

  await c.env.AUTHRIM_CONFIG.put(KV_KEY_ROUTING_RULES, JSON.stringify(rules));

  return c.json({
    success: true,
    deleted_rule: ruleName,
    remaining_rules: rules.length,
    note: 'Routing rule deleted.',
  });
}

// ============================================
// Maintenance Operations
// ============================================

/**
 * POST /api/admin/settings/audit-storage/cleanup
 * Trigger retention cleanup (manual)
 */
export async function triggerRetentionCleanup(c: Context<{ Bindings: Env }>) {
  // This would typically be handled by a scheduled task,
  // but we provide a manual trigger for admin use

  return c.json({
    success: true,
    note:
      'Retention cleanup is typically handled by scheduled tasks. ' +
      'For manual cleanup, use the Queue Consumer functions directly.',
    scheduled_cleanup: {
      event_log: 'Daily at 02:00 UTC',
      pii_log: 'Daily at 03:00 UTC',
    },
    functions: {
      event_log: 'cleanupExpiredEventLogs(db, tenantId?, batchSize?)',
      pii_log: 'cleanupExpiredPIILogs(db, tenantId?, batchSize?)',
    },
  });
}

/**
 * GET /api/admin/settings/audit-storage/stats
 * Get storage statistics (placeholder - would need actual backend queries)
 */
export async function getStorageStats(c: Context<{ Bindings: Env }>) {
  // This is a placeholder - actual implementation would query backends

  return c.json({
    note:
      'Storage statistics require backend queries. ' +
      'This endpoint provides configuration status only.',
    backends: {
      d1_core: {
        status: 'configured',
        binding: 'DB',
        type: 'event_log',
      },
      d1_pii: {
        status: 'configured',
        binding: 'DB_PII',
        type: 'pii_log',
      },
      r2_archive: {
        status: c.env.AUDIT_ARCHIVE ? 'configured' : 'not_configured',
        binding: 'AUDIT_ARCHIVE',
        type: 'archive',
      },
    },
    queue: {
      audit_queue: {
        status: c.env.AUDIT_QUEUE ? 'configured' : 'not_configured',
        binding: 'AUDIT_QUEUE',
      },
    },
  });
}
