/**
 * Audit PII Configuration Settings API
 *
 * Manages per-tenant PII (Personally Identifiable Information) configuration
 * for audit logging. Determines which fields are considered PII, encryption
 * settings, and retention periods.
 *
 * Stored as the tenant's `audit-pii` settings document (D1 is the source, written only against
 * the version that was judged; SETTINGS KV is the projection runtime reads). The older
 * `pii_config:{tenantId}` value in AUTHRIM_CONFIG is adopted into the document on first read.
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import type { TenantPIIConfig } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  AUDIT_PII_CATEGORY,
  AUDIT_PII_CONFIG_KEY,
  ConflictError,
  DEFAULT_PII_CONFIG,
  auditPIIProjectionKey,
  createErrorResponse,
  isValidAuditSettingsTenantId,
  listTenantPIIConfigs,
  loadPIIConfigState,
  syncLegacyPIIConfig,
  type PIIConfigState,
} from '@authrim/ar-lib-core';
import { requireAdminStepUp } from '../../admin-step-up-gate';

// Validation constraints
const MIN_RETENTION_DAYS = 1;
const MAX_EVENT_LOG_RETENTION_DAYS = 730; // 2 years
const MAX_PII_LOG_RETENTION_DAYS = 2555; // 7 years (legal requirements)
const MAX_OPERATIONAL_LOG_RETENTION_DAYS = 365; // 1 year max for operational logs

const RETENTION_FIELDS = [
  'eventLogRetentionDays',
  'piiLogRetentionDays',
  'operationalLogRetentionDays',
] as const;

/** One strict canonical read of the tenant's document, or the response that refuses the request. */
async function loadState(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<PIIConfigState | Response> {
  if (!isValidAuditSettingsTenantId(tenantId)) {
    return c.json({ error: 'invalid_request', error_description: 'tenantId is invalid' }, 400);
  }
  try {
    return await loadPIIConfigState(c.env, tenantId);
  } catch {
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'The PII configuration could not be read.',
      },
      503
    );
  }
}
/**
 * Save (or, with `after` null, clear) the tenant's configuration against the version it was read
 * at: dry run, the step-up gate (spent only after nothing else can refuse the request), then the
 * save, which fails with a conflict if the document changed since. Null on success.
 */
async function savePIIConfig(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  state: PIIConfigState,
  kind: string,
  after: TenantPIIConfig | null
): Promise<Response | null> {
  const scope = { type: 'tenant', id: tenantId } as const;
  const request =
    after === null
      ? { ifMatch: state.version, clear: [AUDIT_PII_CONFIG_KEY] }
      : { ifMatch: state.version, set: { [AUDIT_PII_CONFIG_KEY]: after } };
  try {
    // Validate without saving anything; the version judged is the one read in `state`.
    if (after !== null) {
      const validation = state.manager.validate(AUDIT_PII_CATEGORY, {
        [AUDIT_PII_CONFIG_KEY]: after,
      });
      if (!validation.valid) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: validation.errors.map((e) => e.reason).join('; '),
          },
          400
        );
      }
    }
    const refused = await gatePIIRetention(
      c,
      tenantId,
      kind,
      state.stored ?? { ...DEFAULT_PII_CONFIG },
      after ?? { ...DEFAULT_PII_CONFIG }
    );
    if (refused) return refused;
    // First use after an upgrade: the document is created from what was in effect only now,
    // after the gate (the save then fails its version check if it was created otherwise).
    await state.adopt?.();
    await state.manager.patch(AUDIT_PII_CATEGORY, scope, request, 'audit-pii-config');
    // Runtime falls back to the legacy key while the projection is missing: keep it current.
    await syncLegacyPIIConfig(c.env, tenantId);
    return null;
  } catch (error) {
    if (error instanceof ConflictError) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT, {
        variables: {
          resource: 'audit_pii_config',
          reason:
            'The PII configuration changed while this request was being decided; repeat the step-up and retry',
        },
      });
    }
    throw error;
  }
}

/**
 * The step-up for a write that shortens a retention this config holds (the event and PII days a
 * write falls back to, and how long reason details are kept); null when it may go ahead. Spent
 * just before the write.
 */
async function gatePIIRetention(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  kind: string,
  before: TenantPIIConfig,
  after: TenantPIIConfig
): Promise<Response | null> {
  const value = (config: TenantPIIConfig, field: (typeof RETENTION_FIELDS)[number]) =>
    config[field] ?? DEFAULT_PII_CONFIG[field];
  const shortens = RETENTION_FIELDS.some((field) => {
    const was = value(before, field);
    const now = value(after, field);
    return typeof was === 'number' && (typeof now !== 'number' || now < was);
  });
  if (!shortens) return null;
  return requireAdminStepUp(c as unknown as Parameters<typeof requireAdminStepUp>[0], {
    operation: 'audit.retention.shorten',
    targetTenantId: tenantId,
    params: {
      kind,
      retention_days: Object.fromEntries(
        RETENTION_FIELDS.map((field) => [field, value(after, field) ?? null])
      ),
    },
  });
}

/**
 * GET /api/admin/tenants/:tenantId/audit/pii-config
 * Get PII configuration for a tenant
 */
export async function getTenantPIIConfig(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;

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

  if (isValidAuditSettingsTenantId(tenantId)) {
    try {
      const state = await loadPIIConfigState(c.env, tenantId);
      if (state.stored) {
        config = state.stored;
        source = 'kv';
      }
    } catch {
      // read error - use default
    }
  }

  return c.json({
    tenant_id: tenantId,
    config,
    source,
    defaults: DEFAULT_PII_CONFIG,
    kv_key: isValidAuditSettingsTenantId(tenantId) ? auditPIIProjectionKey(tenantId) : null,
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
  const tenantId = c.req.param('tenantId')!;

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

  // Get existing config or default (one strict read; the save is made against its version)
  const state = await loadState(c, tenantId);
  if (state instanceof Response) return state;
  const existingConfig: TenantPIIConfig = { ...(state.stored ?? DEFAULT_PII_CONFIG) };

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
    if (
      typeof body.eventLogRetentionDays !== 'number' ||
      !Number.isSafeInteger(body.eventLogRetentionDays)
    ) {
      errors.push('eventLogRetentionDays must be a whole number of days');
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
    if (
      typeof body.piiLogRetentionDays !== 'number' ||
      !Number.isSafeInteger(body.piiLogRetentionDays)
    ) {
      errors.push('piiLogRetentionDays must be a whole number of days');
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

  const refused = await savePIIConfig(c, tenantId, state, 'pii_config.update', existingConfig);
  if (refused) return refused;

  return c.json({
    success: true,
    tenant_id: tenantId,
    config: existingConfig,
    kv_key: auditPIIProjectionKey(tenantId),
    note: 'PII configuration updated. Changes will take effect within 3 minutes (config cache TTL).',
  });
}

/**
 * DELETE /api/admin/tenants/:tenantId/audit/pii-config
 * Reset PII configuration to defaults for a tenant
 */
export async function resetTenantPIIConfig(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.param('tenantId')!;

  if (!tenantId) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'tenantId is required',
      },
      400
    );
  }

  const state = await loadState(c, tenantId);
  if (state instanceof Response) return state;
  const refused = await savePIIConfig(c, tenantId, state, 'pii_config.reset', null);
  if (refused) return refused;

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
  const tenantId = c.req.param('tenantId')!;

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

  const state = await loadState(c, tenantId);
  if (state instanceof Response) return state;
  const refused = await savePIIConfig(c, tenantId, state, 'pii_config.preset.gdpr', gdprConfig);
  if (refused) return refused;

  return c.json({
    success: true,
    tenant_id: tenantId,
    preset: 'gdpr',
    config: gdprConfig,
    kv_key: auditPIIProjectionKey(tenantId),
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
  const tenantId = c.req.param('tenantId')!;

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

  const state = await loadState(c, tenantId);
  if (state instanceof Response) return state;
  const refused = await savePIIConfig(
    c,
    tenantId,
    state,
    'pii_config.preset.minimal',
    minimalConfig
  );
  if (refused) return refused;

  return c.json({
    success: true,
    tenant_id: tenantId,
    preset: 'minimal',
    config: minimalConfig,
    kv_key: auditPIIProjectionKey(tenantId),
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
  try {
    const listed = await listTenantPIIConfigs(c.env);
    const configs = listed.map(({ tenantId, config }) => ({
      tenant_id: tenantId,
      config,
      has_custom_config: true,
    }));
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
