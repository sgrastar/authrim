/**
 * Feature Flags for Policy System
 *
 * Hybrid approach:
 * - Environment variables provide defaults (requires deploy to change)
 * - KV storage provides dynamic overrides (changes without deploy)
 *
 * Priority: KV override > Environment variable > Default value
 */

/**
 * Available feature flags for the policy system
 */
export interface PolicyFeatureFlags {
  /** Enable ABAC (Attribute-Based Access Control) evaluation */
  ENABLE_ABAC: boolean;

  /** Enable ReBAC (Relationship-Based Access Control) evaluation */
  ENABLE_REBAC: boolean;

  /** Enable detailed policy evaluation logging */
  ENABLE_POLICY_LOGGING: boolean;

  /** Enable verified attributes checking (requires verified_attributes table) */
  ENABLE_VERIFIED_ATTRIBUTES: boolean;

  /** Enable custom policy rules (beyond default rules) */
  ENABLE_CUSTOM_RULES: boolean;
}

/**
 * Default values for feature flags
 * Minimal configuration: RBAC only (admin/user roles)
 */
export const DEFAULT_FLAGS: PolicyFeatureFlags = {
  ENABLE_ABAC: false,
  ENABLE_REBAC: false,
  ENABLE_POLICY_LOGGING: false,
  ENABLE_VERIFIED_ATTRIBUTES: false,
  ENABLE_CUSTOM_RULES: true,
};

/**
 * KV key prefix for feature flags
 */
const KV_PREFIX = 'policy:flags:';

/**
 * Feature flag names as array for iteration
 */
export const FLAG_NAMES = [
  'ENABLE_ABAC',
  'ENABLE_REBAC',
  'ENABLE_POLICY_LOGGING',
  'ENABLE_VERIFIED_ATTRIBUTES',
  'ENABLE_CUSTOM_RULES',
] as const;

export type FlagName = (typeof FLAG_NAMES)[number];

/**
 * Parse boolean from string (for environment variables)
 */
function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Get feature flags from environment variables only
 * Use this when KV is not available
 */
export function getFlagsFromEnv(env: Record<string, string | undefined>): PolicyFeatureFlags {
  return {
    ENABLE_ABAC: parseBool(env.ENABLE_ABAC, DEFAULT_FLAGS.ENABLE_ABAC),
    ENABLE_REBAC: parseBool(env.ENABLE_REBAC, DEFAULT_FLAGS.ENABLE_REBAC),
    ENABLE_POLICY_LOGGING: parseBool(
      env.ENABLE_POLICY_LOGGING,
      DEFAULT_FLAGS.ENABLE_POLICY_LOGGING
    ),
    ENABLE_VERIFIED_ATTRIBUTES: parseBool(
      env.ENABLE_VERIFIED_ATTRIBUTES,
      DEFAULT_FLAGS.ENABLE_VERIFIED_ATTRIBUTES
    ),
    ENABLE_CUSTOM_RULES: parseBool(env.ENABLE_CUSTOM_RULES, DEFAULT_FLAGS.ENABLE_CUSTOM_RULES),
  };
}

/**
 * KV namespace interface (subset of Cloudflare KV)
 */
export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Feature Flags Manager
 *
 * Provides hybrid flag resolution with caching
 */
export class FeatureFlagsManager {
  private envFlags: PolicyFeatureFlags;
  private kv: KVNamespace | null;
  private cache: Map<FlagName, { value: boolean; expiresAt: number }> = new Map();
  private cacheTTL: number;

  /**
   * @param env Environment variables
   * @param kv KV namespace for dynamic overrides (optional)
   * @param cacheTTL Cache TTL in milliseconds (default: 60 seconds)
   */
  constructor(
    env: Record<string, string | undefined>,
    kv: KVNamespace | null = null,
    cacheTTL: number = 60000
  ) {
    this.envFlags = getFlagsFromEnv(env);
    this.kv = kv;
    this.cacheTTL = cacheTTL;
  }

  /**
   * Get a single flag value
   * Priority: Cache > KV > Environment > Default
   */
  async getFlag(name: FlagName): Promise<boolean> {
    // Check cache first
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // Try KV override
    if (this.kv) {
      try {
        const kvValue = await this.kv.get(`${KV_PREFIX}${name}`);
        if (kvValue !== null) {
          const value = kvValue.toLowerCase() === 'true' || kvValue === '1';
          this.cache.set(name, { value, expiresAt: Date.now() + this.cacheTTL });
          return value;
        }
      } catch (error) {
        console.warn(`Failed to read flag ${name} from KV:`, error);
        // Fall through to env value
      }
    }

    // Use environment value
    const value = this.envFlags[name];
    this.cache.set(name, { value, expiresAt: Date.now() + this.cacheTTL });
    return value;
  }

  /**
   * Get all flags
   */
  async getAllFlags(): Promise<PolicyFeatureFlags> {
    const flags: Partial<PolicyFeatureFlags> = {};
    for (const name of FLAG_NAMES) {
      flags[name] = await this.getFlag(name);
    }
    return flags as PolicyFeatureFlags;
  }

  /**
   * Get flags synchronously from cache/env only (no KV lookup)
   * Use this for performance-critical paths
   */
  getFlagsSync(): PolicyFeatureFlags {
    const flags: Partial<PolicyFeatureFlags> = {};
    for (const name of FLAG_NAMES) {
      const cached = this.cache.get(name);
      flags[name] = cached && cached.expiresAt > Date.now() ? cached.value : this.envFlags[name];
    }
    return flags as PolicyFeatureFlags;
  }

  /**
   * Set a flag override in KV
   * Requires KV to be configured
   */
  async setFlag(name: FlagName, value: boolean): Promise<void> {
    if (!this.kv) {
      throw new Error('KV not configured - cannot set dynamic flag override');
    }
    await this.kv.put(`${KV_PREFIX}${name}`, value.toString());
    // Update cache immediately
    this.cache.set(name, { value, expiresAt: Date.now() + this.cacheTTL });
  }

  /**
   * Remove a flag override from KV (revert to env/default)
   */
  async clearFlag(name: FlagName): Promise<void> {
    if (!this.kv) {
      throw new Error('KV not configured - cannot clear flag override');
    }
    await this.kv.delete(`${KV_PREFIX}${name}`);
    // Clear from cache so next read uses env value
    this.cache.delete(name);
  }

  /**
   * Clear all flag overrides from KV
   */
  async clearAllFlags(): Promise<void> {
    if (!this.kv) {
      throw new Error('KV not configured - cannot clear flags');
    }
    for (const name of FLAG_NAMES) {
      await this.kv.delete(`${KV_PREFIX}${name}`);
      this.cache.delete(name);
    }
  }

  /**
   * Get flag sources (for debugging/admin UI)
   */
  async getFlagSources(): Promise<
    Record<FlagName, { value: boolean; source: 'kv' | 'env' | 'default' }>
  > {
    const result: Record<string, { value: boolean; source: 'kv' | 'env' | 'default' }> = {};

    for (const name of FLAG_NAMES) {
      let source: 'kv' | 'env' | 'default' = 'default';
      let value = DEFAULT_FLAGS[name];

      // Check if env has explicit value
      const envKey = name as keyof typeof this.envFlags;
      if (this.envFlags[envKey] !== DEFAULT_FLAGS[name]) {
        source = 'env';
        value = this.envFlags[envKey];
      }

      // Check KV override
      if (this.kv) {
        try {
          const kvValue = await this.kv.get(`${KV_PREFIX}${name}`);
          if (kvValue !== null) {
            source = 'kv';
            value = kvValue.toLowerCase() === 'true' || kvValue === '1';
          }
        } catch {
          // Ignore KV errors
        }
      }

      result[name] = { value, source };
    }

    return result as Record<FlagName, { value: boolean; source: 'kv' | 'env' | 'default' }>;
  }

  /**
   * Check if ABAC is enabled
   */
  async isAbacEnabled(): Promise<boolean> {
    return this.getFlag('ENABLE_ABAC');
  }

  /**
   * Check if ReBAC is enabled
   */
  async isRebacEnabled(): Promise<boolean> {
    return this.getFlag('ENABLE_REBAC');
  }

  /**
   * Check if policy logging is enabled
   */
  async isLoggingEnabled(): Promise<boolean> {
    return this.getFlag('ENABLE_POLICY_LOGGING');
  }

  /**
   * Clear cache (force re-read from KV on next access)
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Create a feature flags manager
 */
export function createFeatureFlagsManager(
  env: Record<string, string | undefined>,
  kv?: KVNamespace | null,
  cacheTTL?: number
): FeatureFlagsManager {
  return new FeatureFlagsManager(env, kv ?? null, cacheTTL);
}
