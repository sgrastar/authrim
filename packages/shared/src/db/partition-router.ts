/**
 * PII Partition Router
 *
 * Routes PII data access to the correct database partition.
 * Supports flexible partitioning strategies: geographic (GDPR), tenant-specific,
 * plan-based, and attribute-based routing.
 *
 * Architecture:
 * - Each partition maps to a separate DatabaseAdapter (D1, Postgres via Hyperdrive, etc.)
 * - users_core.pii_partition column tracks which partition contains user's PII
 * - New user partition is determined by trust hierarchy:
 *   1. Tenant policy (high trust)
 *   2. User-declared residence (high trust)
 *   3. Custom rules (attribute-based)
 *   4. IP routing (low trust, fallback only)
 *   5. Default partition
 *
 * @see docs/architecture/pii-separation.md
 */

import type { DatabaseAdapter } from './adapter';

// =============================================================================
// Types
// =============================================================================

/**
 * Partition key types.
 * Flexible naming to support various partitioning strategies.
 *
 * Examples:
 * - Geographic: 'eu', 'apac', 'us'
 * - Tenant-specific: 'tenant-acme', 'tenant-contoso'
 * - Plan-based: 'premium', 'enterprise'
 * - Attribute-based: 'high-security'
 */
export type PartitionKey = string;

/**
 * Condition operator for partition rules.
 */
export type PartitionRuleOperator = 'eq' | 'ne' | 'in' | 'not_in' | 'gt' | 'lt' | 'gte' | 'lte';

/**
 * Condition for partition rule evaluation.
 */
export interface PartitionRuleCondition {
  /** Attribute name to evaluate */
  attribute: string;
  /** Comparison operator */
  operator: PartitionRuleOperator;
  /** Value to compare against */
  value: unknown;
}

/**
 * Custom partition routing rule.
 */
export interface PartitionRule {
  /** Rule name for identification */
  name: string;
  /** Priority (lower = higher priority) */
  priority: number;
  /** Condition to evaluate */
  condition: PartitionRuleCondition;
  /** Target partition if condition matches */
  targetPartition: PartitionKey;
  /** Whether this rule is active */
  enabled: boolean;
}

/**
 * Partition settings configuration.
 */
export interface PartitionSettings {
  /** Default partition for new users when no rules match */
  defaultPartition: PartitionKey;
  /** Whether IP-based routing is enabled (low trust, fallback only) */
  ipRoutingEnabled: boolean;
  /** List of available partition keys */
  availablePartitions: PartitionKey[];
  /** Tenant-specific partition overrides (high trust) */
  tenantPartitions: Record<string, PartitionKey>;
  /** Custom partition rules */
  partitionRules: PartitionRule[];
  /** Last update timestamp */
  updatedAt?: number;
  /** Who updated the settings */
  updatedBy?: string;
}

/**
 * Cloudflare request properties subset for geo-routing.
 */
export interface CfGeoProperties {
  country?: string;
  continent?: string;
  region?: string;
  city?: string;
}

/**
 * User attributes for partition resolution.
 */
export interface UserPartitionAttributes {
  /** User-declared residence (high trust) */
  declared_residence?: string;
  /** User's plan type */
  plan?: string;
  /** Custom attributes for rule evaluation */
  [key: string]: unknown;
}

/**
 * Partition resolution result.
 */
export interface PartitionResolution {
  /** Resolved partition key */
  partition: PartitionKey;
  /** How the partition was determined */
  method: PartitionResolutionMethod;
  /** Rule name if resolved by rule */
  ruleName?: string;
}

/**
 * How partition was determined.
 */
export type PartitionResolutionMethod =
  | 'tenant_policy'
  | 'declared_residence'
  | 'custom_rule'
  | 'ip_routing'
  | 'default';

// =============================================================================
// Constants
// =============================================================================

/** Default partition key */
export const DEFAULT_PARTITION = 'default';

/** KV key prefix for partition settings */
export const PARTITION_SETTINGS_KV_PREFIX = 'pii_partition_config';

/** Cache TTL for partition settings (10 seconds) */
export const PARTITION_SETTINGS_CACHE_TTL_MS = 10_000;

/** Probability of running cache cleanup on each read (10%) */
const CACHE_CLEANUP_PROBABILITY = 0.1;

/** Maximum cache entries before forced cleanup */
const MAX_CACHE_ENTRIES = 100;

/**
 * Country to partition mapping for IP-based routing.
 * Note: IP routing is LOW TRUST and should only be used as fallback.
 */
export const COUNTRY_TO_PARTITION: Record<string, PartitionKey> = {
  // EU countries → eu partition
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
  DK: 'eu',
  IE: 'eu',
  PT: 'eu',
  GR: 'eu',
  CZ: 'eu',
  RO: 'eu',
  HU: 'eu',
  SK: 'eu',
  BG: 'eu',
  HR: 'eu',
  SI: 'eu',
  LT: 'eu',
  LV: 'eu',
  EE: 'eu',
  LU: 'eu',
  MT: 'eu',
  CY: 'eu',
  // US → us partition
  US: 'us',
  // Asia-Pacific → apac partition
  JP: 'apac',
  KR: 'apac',
  AU: 'apac',
  NZ: 'apac',
  SG: 'apac',
  HK: 'apac',
  TW: 'apac',
  IN: 'apac',
  // UK (post-Brexit, may need separate)
  GB: 'eu',
  // Default for unlisted countries handled by defaultPartition
};

// =============================================================================
// In-Memory Caching
// =============================================================================

/**
 * Cached partition settings by tenant.
 */
const partitionSettingsCache = new Map<
  string,
  { settings: PartitionSettings; expiresAt: number }
>();

/**
 * Clear partition settings cache.
 * Useful for testing or after configuration changes.
 */
export function clearPartitionSettingsCache(): void {
  partitionSettingsCache.clear();
}

/**
 * Clean up expired cache entries.
 * Removes entries that have passed their expiration time.
 *
 * @returns Number of entries removed
 */
function cleanupExpiredCacheEntries(): number {
  const now = Date.now();
  let removed = 0;

  for (const [key, value] of partitionSettingsCache) {
    if (value.expiresAt < now) {
      partitionSettingsCache.delete(key);
      removed++;
    }
  }

  return removed;
}

/**
 * Probabilistically clean up cache to prevent memory leaks.
 * Called during cache reads to gradually remove expired entries.
 */
function maybeCleanupCache(): void {
  // Force cleanup if cache is too large
  if (partitionSettingsCache.size > MAX_CACHE_ENTRIES) {
    cleanupExpiredCacheEntries();
    return;
  }

  // Probabilistic cleanup (10% chance)
  if (Math.random() < CACHE_CLEANUP_PROBABILITY) {
    cleanupExpiredCacheEntries();
  }
}

// =============================================================================
// PIIPartitionRouter Class
// =============================================================================

/**
 * PII Partition Router
 *
 * Routes PII database access to the correct partition based on configuration.
 */
export class PIIPartitionRouter {
  /** Partition key → DatabaseAdapter mapping */
  private piiAdapters: Map<PartitionKey, DatabaseAdapter>;

  /** Core database adapter (for users_core lookups) */
  private coreAdapter: DatabaseAdapter;

  /** KV namespace for settings */
  private kvNamespace: KVNamespace | null;

  /**
   * Create a new PIIPartitionRouter.
   *
   * @param coreAdapter - Adapter for D1_CORE (users_core table)
   * @param defaultPiiAdapter - Default PII adapter (D1_PII)
   * @param kvNamespace - KV namespace for partition settings (optional)
   */
  constructor(
    coreAdapter: DatabaseAdapter,
    defaultPiiAdapter: DatabaseAdapter,
    kvNamespace?: KVNamespace
  ) {
    this.coreAdapter = coreAdapter;
    this.kvNamespace = kvNamespace ?? null;
    this.piiAdapters = new Map();

    // Always have a default partition
    this.piiAdapters.set(DEFAULT_PARTITION, defaultPiiAdapter);
  }

  /**
   * Register a PII adapter for a specific partition.
   *
   * @param partition - Partition key
   * @param adapter - DatabaseAdapter for this partition
   */
  registerPartition(partition: PartitionKey, adapter: DatabaseAdapter): void {
    this.piiAdapters.set(partition, adapter);
  }

  /**
   * Get all registered partition adapters.
   *
   * @returns Iterator of [partition, adapter] pairs
   */
  getAllAdapters(): IterableIterator<[PartitionKey, DatabaseAdapter]> {
    return this.piiAdapters.entries();
  }

  /**
   * Get available partition keys.
   *
   * @returns Array of registered partition keys
   */
  getAvailablePartitions(): PartitionKey[] {
    return Array.from(this.piiAdapters.keys());
  }

  /**
   * Check if a partition is registered.
   *
   * @param partition - Partition key to check
   * @returns True if partition is registered
   */
  hasPartition(partition: PartitionKey): boolean {
    return this.piiAdapters.has(partition);
  }

  /**
   * Get adapter for a specific partition.
   *
   * @param partition - Partition key
   * @returns DatabaseAdapter for the partition (falls back to default)
   */
  getAdapterForPartition(partition: PartitionKey): DatabaseAdapter {
    return this.piiAdapters.get(partition) ?? this.piiAdapters.get(DEFAULT_PARTITION)!;
  }

  /**
   * Resolve partition for an existing user.
   *
   * @param userId - User ID
   * @returns Partition key from users_core.pii_partition
   */
  async resolvePartitionForUser(userId: string): Promise<PartitionKey> {
    const user = await this.coreAdapter.queryOne<{ pii_partition: string }>(
      'SELECT pii_partition FROM users_core WHERE id = ?',
      [userId]
    );
    return user?.pii_partition ?? DEFAULT_PARTITION;
  }

  /**
   * Resolve partition for new user creation.
   *
   * Trust Level Hierarchy:
   * 1. Tenant policy (high trust) - tenant-specific partition override
   * 2. Declared residence (high trust) - user's self-declared residence
   * 3. Custom rules (medium trust) - attribute-based routing rules
   * 4. IP routing (low trust) - fallback based on request origin
   * 5. Default partition - last resort
   *
   * @param tenantId - Tenant ID
   * @param attributes - User attributes for rule evaluation
   * @param cfData - Cloudflare geo properties (optional)
   * @param settings - Partition settings (optional, fetched if not provided)
   * @returns Partition resolution result
   */
  async resolvePartitionForNewUser(
    tenantId: string,
    attributes: UserPartitionAttributes,
    cfData?: CfGeoProperties,
    settings?: PartitionSettings
  ): Promise<PartitionResolution> {
    // Get settings if not provided
    const config = settings ?? (await this.getPartitionSettings(tenantId));

    // 1. Tenant-specific partition (HIGH TRUST)
    const tenantPartition = config.tenantPartitions[tenantId];
    if (tenantPartition && this.hasPartition(tenantPartition)) {
      return {
        partition: tenantPartition,
        method: 'tenant_policy',
      };
    }

    // 2. User-declared residence (HIGH TRUST)
    const declaredResidence = attributes.declared_residence;
    if (declaredResidence && this.hasPartition(declaredResidence)) {
      return {
        partition: declaredResidence,
        method: 'declared_residence',
      };
    }

    // 3. Custom rules (MEDIUM TRUST)
    const sortedRules = [...config.partitionRules]
      .filter((rule) => rule.enabled)
      .sort((a, b) => a.priority - b.priority);

    for (const rule of sortedRules) {
      if (this.evaluateRule(rule, attributes) && this.hasPartition(rule.targetPartition)) {
        return {
          partition: rule.targetPartition,
          method: 'custom_rule',
          ruleName: rule.name,
        };
      }
    }

    // 4. IP routing (LOW TRUST - fallback only)
    // ⚠️ IP is unreliable due to VPN/Proxy/Warp/roaming.
    // It CANNOT be used as evidence for GDPR compliance.
    if (config.ipRoutingEnabled && cfData?.country) {
      const geoPartition = this.countryToPartition(cfData.country);
      if (geoPartition !== DEFAULT_PARTITION && this.hasPartition(geoPartition)) {
        return {
          partition: geoPartition,
          method: 'ip_routing',
        };
      }
    }

    // 5. Default partition
    return {
      partition: config.defaultPartition,
      method: 'default',
    };
  }

  /**
   * Evaluate a partition rule against user attributes.
   *
   * @param rule - Rule to evaluate
   * @param attributes - User attributes
   * @returns True if rule matches
   */
  private evaluateRule(rule: PartitionRule, attributes: UserPartitionAttributes): boolean {
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

  /**
   * Map country code to partition key.
   *
   * @param country - ISO 3166-1 alpha-2 country code
   * @returns Partition key
   */
  private countryToPartition(country: string): PartitionKey {
    return COUNTRY_TO_PARTITION[country] ?? DEFAULT_PARTITION;
  }

  /**
   * Get partition settings from KV with caching.
   *
   * @param tenantId - Tenant ID
   * @returns Partition settings
   */
  async getPartitionSettings(tenantId: string): Promise<PartitionSettings> {
    const cacheKey = `partition-settings:${tenantId}`;
    const now = Date.now();

    // Periodically clean up expired cache entries to prevent memory leak
    maybeCleanupCache();

    // Check cache
    const cached = partitionSettingsCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.settings;
    }

    let settings: PartitionSettings | null = null;

    // Try KV
    if (this.kvNamespace) {
      const kvKey = buildPartitionSettingsKvKey(tenantId);
      settings = await this.kvNamespace.get<PartitionSettings>(kvKey, { type: 'json' });
    }

    // Default settings if not found
    if (!settings) {
      settings = getDefaultPartitionSettings(this.getAvailablePartitions());
    }

    // Update cache
    partitionSettingsCache.set(cacheKey, {
      settings,
      expiresAt: now + PARTITION_SETTINGS_CACHE_TTL_MS,
    });

    return settings;
  }

  /**
   * Save partition settings to KV.
   *
   * @param tenantId - Tenant ID
   * @param settings - Settings to save
   */
  async savePartitionSettings(tenantId: string, settings: PartitionSettings): Promise<void> {
    if (!this.kvNamespace) {
      throw new Error('KV namespace not available');
    }

    const kvKey = buildPartitionSettingsKvKey(tenantId);
    await this.kvNamespace.put(kvKey, JSON.stringify(settings));

    // Invalidate cache
    const cacheKey = `partition-settings:${tenantId}`;
    partitionSettingsCache.delete(cacheKey);
  }

  /**
   * Get partition statistics (user counts per partition).
   *
   * @param tenantId - Optional tenant filter
   * @returns Map of partition → user count
   */
  async getPartitionStats(tenantId?: string): Promise<Map<PartitionKey, number>> {
    const sql = tenantId
      ? 'SELECT pii_partition, COUNT(*) as count FROM users_core WHERE tenant_id = ? AND is_active = 1 GROUP BY pii_partition'
      : 'SELECT pii_partition, COUNT(*) as count FROM users_core WHERE is_active = 1 GROUP BY pii_partition';

    const params = tenantId ? [tenantId] : [];
    const results = await this.coreAdapter.query<{ pii_partition: string; count: number }>(
      sql,
      params
    );

    const stats = new Map<PartitionKey, number>();
    for (const row of results) {
      stats.set(row.pii_partition, row.count);
    }
    return stats;
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Build KV key for partition settings.
 *
 * @param tenantId - Tenant ID
 * @returns KV key string
 */
export function buildPartitionSettingsKvKey(tenantId: string): string {
  return `${PARTITION_SETTINGS_KV_PREFIX}:${tenantId}`;
}

/**
 * Get default partition settings.
 *
 * @param availablePartitions - List of available partitions
 * @returns Default settings
 */
export function getDefaultPartitionSettings(
  availablePartitions: PartitionKey[] = [DEFAULT_PARTITION]
): PartitionSettings {
  return {
    defaultPartition: DEFAULT_PARTITION,
    ipRoutingEnabled: false, // Disabled by default (low trust)
    availablePartitions,
    tenantPartitions: {},
    partitionRules: [],
    updatedAt: Date.now(),
  };
}

/**
 * Validate partition settings.
 *
 * @param settings - Settings to validate
 * @param availablePartitions - List of available partitions
 * @returns Validation result
 */
export function validatePartitionSettings(
  settings: PartitionSettings,
  availablePartitions: PartitionKey[]
): { valid: boolean; error?: string } {
  // Check default partition exists
  if (!availablePartitions.includes(settings.defaultPartition)) {
    return {
      valid: false,
      error: `Default partition '${settings.defaultPartition}' is not available`,
    };
  }

  // Check tenant partitions exist
  for (const [tenant, partition] of Object.entries(settings.tenantPartitions)) {
    if (!availablePartitions.includes(partition)) {
      return {
        valid: false,
        error: `Tenant '${tenant}' partition '${partition}' is not available`,
      };
    }
  }

  // Check rule target partitions exist
  for (const rule of settings.partitionRules) {
    if (!availablePartitions.includes(rule.targetPartition)) {
      return {
        valid: false,
        error: `Rule '${rule.name}' target partition '${rule.targetPartition}' is not available`,
      };
    }
  }

  // Check for duplicate rule names
  const ruleNames = settings.partitionRules.map((r) => r.name);
  const duplicates = ruleNames.filter((name, i) => ruleNames.indexOf(name) !== i);
  if (duplicates.length > 0) {
    return {
      valid: false,
      error: `Duplicate rule names: ${duplicates.join(', ')}`,
    };
  }

  return { valid: true };
}

/**
 * Create a PIIPartitionRouter with standard configuration.
 *
 * This is a convenience factory function for common setups.
 *
 * @param coreAdapter - Adapter for D1_CORE
 * @param defaultPiiAdapter - Default adapter for D1_PII
 * @param additionalPartitions - Additional partition adapters
 * @param kvNamespace - KV namespace for settings
 * @returns Configured PIIPartitionRouter
 */
export function createPIIPartitionRouter(
  coreAdapter: DatabaseAdapter,
  defaultPiiAdapter: DatabaseAdapter,
  additionalPartitions?: Map<PartitionKey, DatabaseAdapter>,
  kvNamespace?: KVNamespace
): PIIPartitionRouter {
  const router = new PIIPartitionRouter(coreAdapter, defaultPiiAdapter, kvNamespace);

  // Register additional partitions
  if (additionalPartitions) {
    for (const [partition, adapter] of additionalPartitions) {
      router.registerPartition(partition, adapter);
    }
  }

  return router;
}
