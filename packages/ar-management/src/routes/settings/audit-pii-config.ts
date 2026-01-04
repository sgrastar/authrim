/**
 * Audit PII Configuration Settings API
 *
 * Manages per-tenant PII (Personally Identifiable Information) configuration
 * for audit logging. Determines which fields are considered PII, encryption
 * settings, and retention periods.
 *
 * KV Keys:
 * - pii_config:{tenantId}: JSON-encoded TenantPIIConfig
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import type { TenantPIIConfig } from '@authrim/ar-lib-core';
import { DEFAULT_PII_CONFIG } from '@authrim/ar-lib-core';

// KV key prefix
const KV_KEY_PII_CONFIG_PREFIX = 'pii_config:';

// Validation constraints
const MIN_RETENTION_DAYS = 1;
const MAX_EVENT_LOG_RETENTION_DAYS = 730; // 2 years
const MAX_PII_LOG_RETENTION_DAYS = 2555; // 7 years (legal requirements)
const MAX_OPERATIONAL_LOG_RETENTION_DAYS = 365; // 1 year max for operational logs

/**
 * GET /api/admin/tenants/:tenantId/audit/pii-config
 * Get PII configuration for a tenant
 */
export async function getTenantPIIConfig(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId');

  if (!tenantId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'tenantId is required',
      },
      400
    );
  }

  let config: TenantPIIConfig = { ...DEFAULT_PII_CONFIG };
  let source: 'kv' | 'default' = 'default';

  if (c.env.AUTHRIM_CONFIG) {
    try {
      const kvValue = await c.env.AUTHRIM_CONFIG.get(`${KV_KEY_PII_CONFIG_PREFIX}${tenantId}`);
      if (kvValue) {
        config = JSON.parse(kvValue) as TenantPIIConfig;
        source = 'kv';
      }
    } catch {
      // KV read error or parse error - use default
    }
  }

  return c.json({
    tenant_id: tenantId,
    config,
    source,
    defaults: DEFAULT_PII_CONFIG,
    kv_key: `${KV_KEY_PII_CONFIG_PREFIX}${tenantId}`,
    field_descriptions: {
      piiFields: {
        email: 'Email addresses',
        name: 'User names (first, last, display name)',
        phone: 'Phone numbers',
        ipAddress: 'IP addresses (GDPR considers this PII in some contexts)',
        userAgent: 'Browser/client user agent strings',
        deviceFingerprint: 'Device fingerprints for fraud detection',
        address: 'Physical addresses',
        birthdate: 'Date of birth',
        governmentId: 'Government-issued IDs (SSN, passport, etc.)',
      },
      eventLogDetailLevel: {
        minimal: 'Only event type and result (smallest footprint)',
        standard: 'Standard details without performance metrics',
        detailed: 'Full details including performance metrics',
      },
    },
    retention_constraints: {
      event_log: {
        min_days: MIN_RETENTION_DAYS,
        max_days: MAX_EVENT_LOG_RETENTION_DAYS,
        description: 'Event logs (non-PII) retention period',
      },
      pii_log: {
        min_days: MIN_RETENTION_DAYS,
        max_days: MAX_PII_LOG_RETENTION_DAYS,
        description: 'PII logs (encrypted personal data) retention period',
      },
      operational_log: {
        min_days: MIN_RETENTION_DAYS,
        max_days: MAX_OPERATIONAL_LOG_RETENTION_DAYS,
        description: 'Operational logs (reason_detail, encrypted) retention period',
      },
    },
    gdpr_note:
      'Under GDPR, certain data like IP addresses may be considered PII. ' +
      'Enable ipAddress=true for GDPR compliance.',
  });
}

/**
 * PUT /api/admin/tenants/:tenantId/audit/pii-config
 * Update PII configuration for a tenant
 */
export async function updateTenantPIIConfig(c: Context<{ Bindings: Env }>) {
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

  const tenantId = c.req.param('tenantId');

  if (!tenantId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'tenantId is required',
      },
      400
    );
  }

  const body = await c.req.json<Partial<TenantPIIConfig>>();
  const errors: string[] = [];

  // Get existing config or default
  let existingConfig: TenantPIIConfig = { ...DEFAULT_PII_CONFIG };
  try {
    const kvValue = await c.env.AUTHRIM_CONFIG.get(`${KV_KEY_PII_CONFIG_PREFIX}${tenantId}`);
    if (kvValue) {
      existingConfig = JSON.parse(kvValue) as TenantPIIConfig;
    }
  } catch {
    // Use default
  }

  // Merge and validate piiFields
  if (body.piiFields) {
    const validFields = Object.keys(DEFAULT_PII_CONFIG.piiFields);
    const providedFields = Object.keys(body.piiFields);
    const invalidFields = providedFields.filter((f) => !validFields.includes(f));

    if (invalidFields.length > 0) {
      errors.push(
        `Invalid piiFields: ${invalidFields.join(', ')}. Valid fields: ${validFields.join(', ')}`
      );
    } else {
      // Validate all values are booleans
      for (const [field, value] of Object.entries(body.piiFields)) {
        if (typeof value !== 'boolean') {
          errors.push(`piiFields.${field} must be a boolean`);
        }
      }

      if (errors.length === 0) {
        existingConfig.piiFields = {
          ...existingConfig.piiFields,
          ...body.piiFields,
        };
      }
    }
  }

  // Validate eventLogDetailLevel
  if (body.eventLogDetailLevel !== undefined) {
    const validLevels = ['minimal', 'standard', 'detailed'];
    if (!validLevels.includes(body.eventLogDetailLevel)) {
      errors.push(`Invalid eventLogDetailLevel. Valid values: ${validLevels.join(', ')}`);
    } else {
      existingConfig.eventLogDetailLevel = body.eventLogDetailLevel;
    }
  }

  // Validate eventLogRetentionDays
  if (body.eventLogRetentionDays !== undefined) {
    if (typeof body.eventLogRetentionDays !== 'number') {
      errors.push('eventLogRetentionDays must be a number');
    } else if (body.eventLogRetentionDays < MIN_RETENTION_DAYS) {
      errors.push(`eventLogRetentionDays must be at least ${MIN_RETENTION_DAYS}`);
    } else if (body.eventLogRetentionDays > MAX_EVENT_LOG_RETENTION_DAYS) {
      errors.push(`eventLogRetentionDays cannot exceed ${MAX_EVENT_LOG_RETENTION_DAYS}`);
    } else {
      existingConfig.eventLogRetentionDays = body.eventLogRetentionDays;
    }
  }

  // Validate piiLogRetentionDays
  if (body.piiLogRetentionDays !== undefined) {
    if (typeof body.piiLogRetentionDays !== 'number') {
      errors.push('piiLogRetentionDays must be a number');
    } else if (body.piiLogRetentionDays < MIN_RETENTION_DAYS) {
      errors.push(`piiLogRetentionDays must be at least ${MIN_RETENTION_DAYS}`);
    } else if (body.piiLogRetentionDays > MAX_PII_LOG_RETENTION_DAYS) {
      errors.push(`piiLogRetentionDays cannot exceed ${MAX_PII_LOG_RETENTION_DAYS}`);
    } else {
      existingConfig.piiLogRetentionDays = body.piiLogRetentionDays;
    }
  }

  // Validate operationalLogRetentionDays (for reason_detail storage)
  if (body.operationalLogRetentionDays !== undefined) {
    if (typeof body.operationalLogRetentionDays !== 'number') {
      errors.push('operationalLogRetentionDays must be a number');
    } else if (body.operationalLogRetentionDays < MIN_RETENTION_DAYS) {
      errors.push(`operationalLogRetentionDays must be at least ${MIN_RETENTION_DAYS}`);
    } else if (body.operationalLogRetentionDays > MAX_OPERATIONAL_LOG_RETENTION_DAYS) {
      errors.push(
        `operationalLogRetentionDays cannot exceed ${MAX_OPERATIONAL_LOG_RETENTION_DAYS}`
      );
    } else {
      existingConfig.operationalLogRetentionDays = body.operationalLogRetentionDays;
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
  const kvKey = `${KV_KEY_PII_CONFIG_PREFIX}${tenantId}`;
  await c.env.AUTHRIM_CONFIG.put(kvKey, JSON.stringify(existingConfig));

  return c.json({
    success: true,
    tenant_id: tenantId,
    config: existingConfig,
    kv_key: kvKey,
    note: 'PII configuration updated. Changes will take effect within 3 minutes (config cache TTL).',
  });
}

/**
 * DELETE /api/admin/tenants/:tenantId/audit/pii-config
 * Reset PII configuration to defaults for a tenant
 */
export async function resetTenantPIIConfig(c: Context<{ Bindings: Env }>) {
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

  const tenantId = c.req.param('tenantId');

  if (!tenantId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'tenantId is required',
      },
      400
    );
  }

  const kvKey = `${KV_KEY_PII_CONFIG_PREFIX}${tenantId}`;
  await c.env.AUTHRIM_CONFIG.delete(kvKey);

  return c.json({
    success: true,
    tenant_id: tenantId,
    reset_to_defaults: DEFAULT_PII_CONFIG,
    note: 'PII configuration reset to defaults.',
  });
}

// ============================================
// GDPR Presets
// ============================================

/**
 * POST /api/admin/tenants/:tenantId/audit/pii-config/preset/gdpr
 * Apply GDPR-compliant PII preset
 */
export async function applyGDPRPreset(c: Context<{ Bindings: Env }>) {
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

  const tenantId = c.req.param('tenantId');

  if (!tenantId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'tenantId is required',
      },
      400
    );
  }

  // GDPR-compliant preset
  const gdprConfig: TenantPIIConfig = {
    piiFields: {
      email: true,
      name: true,
      phone: true,
      ipAddress: true, // GDPR considers IP addresses as PII
      userAgent: true, // Can be used for fingerprinting
      deviceFingerprint: true,
      address: true,
      birthdate: true,
      governmentId: true,
    },
    eventLogDetailLevel: 'standard',
    eventLogRetentionDays: 90, // Minimum reasonable for security
    piiLogRetentionDays: 365, // 1 year default, can be extended if needed
  };

  const kvKey = `${KV_KEY_PII_CONFIG_PREFIX}${tenantId}`;
  await c.env.AUTHRIM_CONFIG.put(kvKey, JSON.stringify(gdprConfig));

  return c.json({
    success: true,
    tenant_id: tenantId,
    preset: 'gdpr',
    config: gdprConfig,
    kv_key: kvKey,
    gdpr_notes: [
      'IP addresses are now treated as PII (GDPR Article 4)',
      'User agents are treated as PII to prevent fingerprinting',
      'PII logs are encrypted with AES-256-GCM',
      'Consider implementing data subject access requests (DSAR)',
      'Review and adjust retention periods based on your legal requirements',
    ],
  });
}

/**
 * POST /api/admin/tenants/:tenantId/audit/pii-config/preset/minimal
 * Apply minimal PII preset (for non-EU contexts)
 */
export async function applyMinimalPreset(c: Context<{ Bindings: Env }>) {
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

  const tenantId = c.req.param('tenantId');

  if (!tenantId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'tenantId is required',
      },
      400
    );
  }

  // Minimal PII preset
  const minimalConfig: TenantPIIConfig = {
    piiFields: {
      email: true,
      name: true,
      phone: true,
      ipAddress: false, // Not treated as PII
      userAgent: false,
      deviceFingerprint: false,
      address: true,
      birthdate: true,
      governmentId: true,
    },
    eventLogDetailLevel: 'detailed', // More details allowed
    eventLogRetentionDays: 180, // 6 months
    piiLogRetentionDays: 730, // 2 years
  };

  const kvKey = `${KV_KEY_PII_CONFIG_PREFIX}${tenantId}`;
  await c.env.AUTHRIM_CONFIG.put(kvKey, JSON.stringify(minimalConfig));

  return c.json({
    success: true,
    tenant_id: tenantId,
    preset: 'minimal',
    config: minimalConfig,
    kv_key: kvKey,
    note: 'Minimal PII preset applied. This is NOT GDPR compliant.',
  });
}

// ============================================
// Bulk Operations
// ============================================

/**
 * GET /api/admin/settings/audit/pii-config
 * List all tenant PII configurations
 */
export async function listAllTenantPIIConfigs(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json({
      tenants: [],
      note: 'AUTHRIM_CONFIG KV namespace is not configured',
    });
  }

  try {
    const list = await c.env.AUTHRIM_CONFIG.list({ prefix: KV_KEY_PII_CONFIG_PREFIX });

    const configs = await Promise.all(
      list.keys.map(async (key) => {
        const tenantId = key.name.replace(KV_KEY_PII_CONFIG_PREFIX, '');
        const value = await c.env.AUTHRIM_CONFIG!.get(key.name);
        let config: TenantPIIConfig | null = null;

        if (value) {
          try {
            config = JSON.parse(value) as TenantPIIConfig;
          } catch {
            // Parse error
          }
        }

        return {
          tenant_id: tenantId,
          config: config ?? DEFAULT_PII_CONFIG,
          has_custom_config: config !== null,
        };
      })
    );

    return c.json({
      tenants: configs,
      count: configs.length,
      default_config: DEFAULT_PII_CONFIG,
    });
  } catch {
    return c.json({
      tenants: [],
      error: 'Failed to list tenant PII configurations',
    });
  }
}
