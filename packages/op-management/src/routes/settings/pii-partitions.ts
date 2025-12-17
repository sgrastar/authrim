/**
 * PII Partitions Admin API
 *
 * Manages PII partition routing configuration for database separation.
 * Supports flexible partitioning: geographic (GDPR), tenant-specific, plan-based, attribute-based.
 *
 * Endpoints:
 * - GET /api/admin/settings/pii-partitions: Get current configuration
 * - PUT /api/admin/settings/pii-partitions: Update configuration
 * - POST /api/admin/settings/pii-partitions/test: Test partition routing
 * - GET /api/admin/settings/pii-partitions/stats: Get partition statistics
 * - DELETE /api/admin/settings/pii-partitions: Reset to default configuration
 *
 * @see docs/architecture/pii-separation.md
 */

import type { Context } from 'hono';
import {
  type PartitionSettings,
  type PartitionRule,
  type UserPartitionAttributes,
  type CfGeoProperties,
  type PartitionResolution,
  validatePartitionSettings,
  getDefaultPartitionSettings,
  buildPartitionSettingsKvKey,
  DEFAULT_PARTITION,
} from '@authrim/shared';

/**
 * Request body for PUT /api/admin/settings/pii-partitions
 */
interface UpdatePartitionSettingsRequest {
  /** Default partition for new users */
  defaultPartition?: string;
  /** Whether IP-based routing is enabled */
  ipRoutingEnabled?: boolean;
  /** Tenant-specific partition overrides */
  tenantPartitions?: Record<string, string>;
  /** Custom partition rules */
  partitionRules?: PartitionRule[];
}

/**
 * Request body for POST /api/admin/settings/pii-partitions/test
 */
interface TestPartitionRoutingRequest {
  /** Tenant ID */
  tenantId: string;
  /** User attributes for rule evaluation */
  attributes?: UserPartitionAttributes;
  /** Simulated CF geo properties */
  cfData?: CfGeoProperties;
}

/**
 * Default tenant ID (single-tenant mode)
 */
const DEFAULT_TENANT_ID = 'default';

/**
 * Available partitions (initially only default)
 * This will be dynamically populated when additional DB bindings are configured
 */
function getAvailablePartitions(env: Record<string, unknown>): string[] {
  const partitions = [DEFAULT_PARTITION];

  // Check for additional PII DB bindings
  // These would be configured in wrangler.toml
  if (env.DB_PII_EU) partitions.push('eu');
  if (env.DB_PII_APAC) partitions.push('apac');
  if (env.DB_PII_US) partitions.push('us');

  // Check for Hyperdrive bindings (external Postgres)
  // Pattern: HYPERDRIVE_PII_{PARTITION}
  for (const key of Object.keys(env)) {
    if (key.startsWith('HYPERDRIVE_PII_') && key !== 'HYPERDRIVE_PII_DEFAULT') {
      const partition = key.replace('HYPERDRIVE_PII_', '').toLowerCase();
      if (!partitions.includes(partition)) {
        partitions.push(partition);
      }
    }
  }

  return partitions;
}

/**
 * GET /api/admin/settings/pii-partitions
 *
 * Get current PII partition configuration.
 *
 * Response:
 * - defaultPartition: Default partition for new users
 * - ipRoutingEnabled: Whether IP-based routing is enabled
 * - availablePartitions: List of available partition keys
 * - tenantPartitions: Tenant-specific partition overrides
 * - partitionRules: Custom partition rules
 * - updatedAt: Last update timestamp
 */
export async function getPartitionSettings(c: Context) {
  const kv = c.env.AUTHRIM_CONFIG;
  const availablePartitions = getAvailablePartitions(c.env as Record<string, unknown>);

  let settings: PartitionSettings | null = null;

  if (kv) {
    const kvKey = buildPartitionSettingsKvKey(DEFAULT_TENANT_ID);
    const raw = await kv.get(kvKey);
    if (raw) {
      try {
        settings = JSON.parse(raw) as PartitionSettings;
      } catch {
        // Invalid JSON, use defaults
      }
    }
  }

  // Use defaults if not configured
  if (!settings) {
    settings = getDefaultPartitionSettings(availablePartitions);
  }

  return c.json({
    defaultPartition: settings.defaultPartition,
    ipRoutingEnabled: settings.ipRoutingEnabled,
    availablePartitions,
    tenantPartitions: settings.tenantPartitions,
    partitionRules: settings.partitionRules,
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
    note: 'IP routing is low trust and should only be used as fallback. Prefer tenant policies or user-declared residence.',
  });
}

/**
 * PUT /api/admin/settings/pii-partitions
 *
 * Update PII partition configuration.
 *
 * Request Body:
 * - defaultPartition: string (optional)
 * - ipRoutingEnabled: boolean (optional)
 * - tenantPartitions: Record<string, string> (optional)
 * - partitionRules: PartitionRule[] (optional)
 *
 * Validation:
 * - All referenced partitions must be available
 * - Rule names must be unique
 */
export async function updatePartitionSettings(c: Context) {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return c.json({ error: 'AUTHRIM_CONFIG KV binding not available' }, 500);
  }

  let body: UpdatePartitionSettingsRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const availablePartitions = getAvailablePartitions(c.env as Record<string, unknown>);

  // Get current settings
  const kvKey = buildPartitionSettingsKvKey(DEFAULT_TENANT_ID);
  let currentSettings: PartitionSettings | null = null;
  const rawSettings = await kv.get(kvKey);
  if (rawSettings) {
    try {
      currentSettings = JSON.parse(rawSettings) as PartitionSettings;
    } catch {
      // Invalid JSON, use defaults
    }
  }
  if (!currentSettings) {
    currentSettings = getDefaultPartitionSettings(availablePartitions);
  }

  // Merge updates
  const newSettings: PartitionSettings = {
    defaultPartition: body.defaultPartition ?? currentSettings.defaultPartition,
    ipRoutingEnabled: body.ipRoutingEnabled ?? currentSettings.ipRoutingEnabled,
    availablePartitions,
    tenantPartitions: body.tenantPartitions ?? currentSettings.tenantPartitions,
    partitionRules: body.partitionRules ?? currentSettings.partitionRules,
    updatedAt: Date.now(),
    updatedBy: 'admin-api',
  };

  // Validate settings
  const validation = validatePartitionSettings(newSettings, availablePartitions);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  // Save to KV
  await kv.put(kvKey, JSON.stringify(newSettings));

  return c.json({
    success: true,
    defaultPartition: newSettings.defaultPartition,
    ipRoutingEnabled: newSettings.ipRoutingEnabled,
    availablePartitions,
    tenantPartitions: newSettings.tenantPartitions,
    partitionRulesCount: newSettings.partitionRules.length,
    updatedAt: newSettings.updatedAt,
  });
}

/**
 * POST /api/admin/settings/pii-partitions/test
 *
 * Test partition routing for a hypothetical user.
 * Does not create any data, just returns the resolved partition.
 *
 * Request Body:
 * - tenantId: string (required)
 * - attributes: UserPartitionAttributes (optional)
 * - cfData: CfGeoProperties (optional)
 *
 * Response:
 * - partition: Resolved partition key
 * - method: How the partition was determined
 * - ruleName: Rule name if resolved by custom rule
 */
export async function testPartitionRouting(c: Context) {
  let body: TestPartitionRoutingRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.tenantId) {
    return c.json({ error: 'tenantId is required' }, 400);
  }

  const kv = c.env.AUTHRIM_CONFIG;
  const availablePartitions = getAvailablePartitions(c.env as Record<string, unknown>);

  // Get settings
  let settings: PartitionSettings | null = null;
  if (kv) {
    const kvKey = buildPartitionSettingsKvKey(DEFAULT_TENANT_ID);
    const raw = await kv.get(kvKey);
    if (raw) {
      try {
        settings = JSON.parse(raw) as PartitionSettings;
      } catch {
        // Invalid JSON, use defaults
      }
    }
  }
  if (!settings) {
    settings = getDefaultPartitionSettings(availablePartitions);
  }

  // Simulate partition resolution
  const resolution = resolvePartitionForTest(
    body.tenantId,
    body.attributes ?? {},
    body.cfData,
    settings,
    availablePartitions
  );

  return c.json({
    tenantId: body.tenantId,
    attributes: body.attributes ?? {},
    cfData: body.cfData,
    resolution: {
      partition: resolution.partition,
      method: resolution.method,
      ruleName: resolution.ruleName,
    },
    availablePartitions,
    settings: {
      defaultPartition: settings.defaultPartition,
      ipRoutingEnabled: settings.ipRoutingEnabled,
      tenantPartitions: settings.tenantPartitions,
      partitionRulesCount: settings.partitionRules.length,
    },
  });
}

/**
 * GET /api/admin/settings/pii-partitions/stats
 *
 * Get user statistics per partition.
 *
 * Query Parameters:
 * - tenant_id: Filter by tenant (optional)
 *
 * Response:
 * - total: Total user count
 * - byPartition: Map of partition → user count
 */
export async function getPartitionStats(c: Context) {
  const db = c.env.DB;
  if (!db) {
    return c.json({ error: 'DB binding not available' }, 500);
  }

  const tenantId = c.req.query('tenant_id');
  const availablePartitions = getAvailablePartitions(c.env as Record<string, unknown>);

  // Query partition statistics
  const sql = tenantId
    ? 'SELECT pii_partition, COUNT(*) as count FROM users_core WHERE tenant_id = ? AND is_active = 1 GROUP BY pii_partition'
    : 'SELECT pii_partition, COUNT(*) as count FROM users_core WHERE is_active = 1 GROUP BY pii_partition';

  const params = tenantId ? [tenantId] : [];

  try {
    const result = await db
      .prepare(sql)
      .bind(...params)
      .all();

    const byPartition: Record<string, number> = {};
    let total = 0;

    for (const row of result.results as { pii_partition: string; count: number }[]) {
      byPartition[row.pii_partition] = row.count;
      total += row.count;
    }

    // Include zero counts for available partitions not in results
    for (const partition of availablePartitions) {
      if (!(partition in byPartition)) {
        byPartition[partition] = 0;
      }
    }

    return c.json({
      total,
      byPartition,
      availablePartitions,
      tenantId: tenantId ?? 'all',
    });
  } catch (error) {
    // Table may not exist yet (before migration)
    return c.json({
      total: 0,
      byPartition: {},
      availablePartitions,
      tenantId: tenantId ?? 'all',
      note: 'users_core table may not exist yet. Run migrations first.',
    });
  }
}

/**
 * DELETE /api/admin/settings/pii-partitions
 *
 * Reset PII partition configuration to defaults.
 */
export async function deletePartitionSettings(c: Context) {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return c.json({ error: 'AUTHRIM_CONFIG KV binding not available' }, 500);
  }

  const kvKey = buildPartitionSettingsKvKey(DEFAULT_TENANT_ID);
  await kv.delete(kvKey);

  const availablePartitions = getAvailablePartitions(c.env as Record<string, unknown>);
  const defaults = getDefaultPartitionSettings(availablePartitions);

  return c.json({
    success: true,
    message: 'PII partition configuration deleted. System will use defaults.',
    defaults: {
      defaultPartition: defaults.defaultPartition,
      ipRoutingEnabled: defaults.ipRoutingEnabled,
      availablePartitions,
    },
  });
}

// =============================================================================
// Internal Helper Functions
// =============================================================================

/**
 * Country to partition mapping for IP-based routing (duplicated for test endpoint)
 */
const COUNTRY_TO_PARTITION: Record<string, string> = {
  // EU countries
  DE: 'eu',
  FR: 'eu',
  IT: 'eu',
  ES: 'eu',
  NL: 'eu',
  BE: 'eu',
  AT: 'eu',
  PL: 'eu',
  SE: 'eu',
  FI: 'eu',
  GB: 'eu',
  // US
  US: 'us',
  // APAC
  JP: 'apac',
  KR: 'apac',
  AU: 'apac',
  SG: 'apac',
};

/**
 * Resolve partition for test endpoint (mimics PIIPartitionRouter logic)
 */
function resolvePartitionForTest(
  tenantId: string,
  attributes: UserPartitionAttributes,
  cfData: CfGeoProperties | undefined,
  settings: PartitionSettings,
  availablePartitions: string[]
): PartitionResolution {
  // 1. Tenant-specific partition
  const tenantPartition = settings.tenantPartitions[tenantId];
  if (tenantPartition && availablePartitions.includes(tenantPartition)) {
    return {
      partition: tenantPartition,
      method: 'tenant_policy',
    };
  }

  // 2. User-declared residence
  const declaredResidence = attributes.declared_residence;
  if (declaredResidence && availablePartitions.includes(declaredResidence)) {
    return {
      partition: declaredResidence,
      method: 'declared_residence',
    };
  }

  // 3. Custom rules
  const sortedRules = [...settings.partitionRules]
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.priority - b.priority);

  for (const rule of sortedRules) {
    if (evaluateRule(rule, attributes) && availablePartitions.includes(rule.targetPartition)) {
      return {
        partition: rule.targetPartition,
        method: 'custom_rule',
        ruleName: rule.name,
      };
    }
  }

  // 4. IP routing (low trust)
  if (settings.ipRoutingEnabled && cfData?.country) {
    const geoPartition = COUNTRY_TO_PARTITION[cfData.country] ?? DEFAULT_PARTITION;
    if (geoPartition !== DEFAULT_PARTITION && availablePartitions.includes(geoPartition)) {
      return {
        partition: geoPartition,
        method: 'ip_routing',
      };
    }
  }

  // 5. Default
  return {
    partition: settings.defaultPartition,
    method: 'default',
  };
}

/**
 * Evaluate a partition rule
 */
function evaluateRule(rule: PartitionRule, attributes: UserPartitionAttributes): boolean {
  const { condition } = rule;
  const value = attributes[condition.attribute];

  switch (condition.operator) {
    case 'eq':
      return value === condition.value;
    case 'ne':
      return value !== condition.value;
    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(value);
    case 'not_in':
      return Array.isArray(condition.value) && !condition.value.includes(value);
    case 'gt':
      return typeof value === 'number' && typeof condition.value === 'number'
        ? value > condition.value
        : false;
    case 'lt':
      return typeof value === 'number' && typeof condition.value === 'number'
        ? value < condition.value
        : false;
    case 'gte':
      return typeof value === 'number' && typeof condition.value === 'number'
        ? value >= condition.value
        : false;
    case 'lte':
      return typeof value === 'number' && typeof condition.value === 'number'
        ? value <= condition.value
        : false;
    default:
      return false;
  }
}
