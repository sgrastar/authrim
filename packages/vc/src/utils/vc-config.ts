/**
 * VC Configuration Manager
 *
 * Hybrid approach for managing VC/VP/VCI configuration:
 * - Environment variables provide defaults (requires deploy to change)
 * - KV storage provides dynamic overrides (changes without deploy)
 *
 * Priority: Cache > KV > Environment variable > Default value
 *
 * Security: Default values follow HAIP draft-06 (stricter settings)
 */

import type { Env } from '../types';

/**
 * VC configuration values
 */
export interface VCConfig {
  /** HAIP policy version */
  HAIP_POLICY_VERSION: 'draft-06' | 'final-1.0';

  /** VP request expiry in seconds */
  VP_REQUEST_EXPIRY_SECONDS: number;

  /** Nonce expiry in seconds (VP nonce) */
  NONCE_EXPIRY_SECONDS: number;

  /** c_nonce expiry in seconds (VCI) */
  C_NONCE_EXPIRY_SECONDS: number;

  /** Credential offer expiry in seconds (VCI) */
  CREDENTIAL_OFFER_EXPIRY_SECONDS: number;

  /** Proof of Possession validity period in seconds (VCI) */
  POP_VALIDITY_SECONDS: number;

  /** Proof of Possession clock skew tolerance in seconds */
  POP_CLOCK_SKEW_SECONDS: number;

  /** DID document cache TTL in seconds */
  DID_CACHE_TTL_SECONDS: number;

  /** Require holder binding (HAIP requirement) */
  REQUIRE_HOLDER_BINDING: boolean;

  /** Require issuer trust check (HAIP requirement) */
  REQUIRE_ISSUER_TRUST: boolean;

  /** Require credential status check (HAIP requirement) */
  REQUIRE_STATUS_CHECK: boolean;
}

/**
 * Default values for VC configuration
 * Security: Uses HAIP draft-06 compliant defaults (stricter settings)
 */
export const DEFAULT_VC_CONFIG: VCConfig = {
  HAIP_POLICY_VERSION: 'draft-06', // Current HAIP version
  VP_REQUEST_EXPIRY_SECONDS: 300, // 5 minutes (HAIP recommendation)
  NONCE_EXPIRY_SECONDS: 300, // 5 minutes
  C_NONCE_EXPIRY_SECONDS: 300, // 5 minutes (VCI spec)
  CREDENTIAL_OFFER_EXPIRY_SECONDS: 86400, // 24 hours
  POP_VALIDITY_SECONDS: 300, // 5 minutes (HAIP recommendation)
  POP_CLOCK_SKEW_SECONDS: 60, // 60 seconds clock skew tolerance
  DID_CACHE_TTL_SECONDS: 3600, // 1 hour
  REQUIRE_HOLDER_BINDING: true, // HAIP requires holder binding
  REQUIRE_ISSUER_TRUST: true, // HAIP requires trusted issuers
  REQUIRE_STATUS_CHECK: true, // HAIP requires status check
};

/**
 * KV key prefix for VC configuration
 */
const KV_PREFIX = 'vc:config:';

/**
 * Configuration key names
 */
export const VC_CONFIG_NAMES = [
  'HAIP_POLICY_VERSION',
  'VP_REQUEST_EXPIRY_SECONDS',
  'NONCE_EXPIRY_SECONDS',
  'C_NONCE_EXPIRY_SECONDS',
  'CREDENTIAL_OFFER_EXPIRY_SECONDS',
  'POP_VALIDITY_SECONDS',
  'POP_CLOCK_SKEW_SECONDS',
  'DID_CACHE_TTL_SECONDS',
  'REQUIRE_HOLDER_BINDING',
  'REQUIRE_ISSUER_TRUST',
  'REQUIRE_STATUS_CHECK',
] as const;

export type VCConfigName = (typeof VC_CONFIG_NAMES)[number];

/**
 * Configuration metadata for Admin UI
 */
export const VC_CONFIG_METADATA: Record<
  VCConfigName,
  {
    type: 'number' | 'boolean' | 'string';
    label: string;
    description: string;
    min?: number;
    max?: number;
    unit?: string;
    options?: string[];
  }
> = {
  HAIP_POLICY_VERSION: {
    type: 'string',
    label: 'HAIP Policy Version',
    description: 'HAIP specification version to follow (draft-06 or final-1.0)',
    options: ['draft-06', 'final-1.0'],
  },
  VP_REQUEST_EXPIRY_SECONDS: {
    type: 'number',
    label: 'VP Request Expiry',
    description: 'VP authorization request lifetime in seconds',
    min: 60,
    max: 3600,
    unit: 'seconds',
  },
  NONCE_EXPIRY_SECONDS: {
    type: 'number',
    label: 'Nonce Expiry',
    description: 'VP nonce lifetime in seconds',
    min: 60,
    max: 3600,
    unit: 'seconds',
  },
  C_NONCE_EXPIRY_SECONDS: {
    type: 'number',
    label: 'c_nonce Expiry',
    description: 'VCI credential nonce lifetime in seconds',
    min: 60,
    max: 3600,
    unit: 'seconds',
  },
  CREDENTIAL_OFFER_EXPIRY_SECONDS: {
    type: 'number',
    label: 'Credential Offer Expiry',
    description: 'VCI credential offer lifetime in seconds',
    min: 300,
    max: 604800,
    unit: 'seconds',
  },
  POP_VALIDITY_SECONDS: {
    type: 'number',
    label: 'PoP Validity Period',
    description: 'Proof of Possession JWT validity period in seconds',
    min: 60,
    max: 600,
    unit: 'seconds',
  },
  POP_CLOCK_SKEW_SECONDS: {
    type: 'number',
    label: 'PoP Clock Skew',
    description: 'Clock skew tolerance for PoP JWT validation in seconds',
    min: 0,
    max: 300,
    unit: 'seconds',
  },
  DID_CACHE_TTL_SECONDS: {
    type: 'number',
    label: 'DID Cache TTL',
    description: 'DID document cache lifetime in seconds',
    min: 60,
    max: 86400,
    unit: 'seconds',
  },
  REQUIRE_HOLDER_BINDING: {
    type: 'boolean',
    label: 'Require Holder Binding',
    description: 'Require Key Binding JWT for VP verification (HAIP requirement)',
  },
  REQUIRE_ISSUER_TRUST: {
    type: 'boolean',
    label: 'Require Issuer Trust',
    description: 'Require issuer to be in trusted registry (HAIP requirement)',
  },
  REQUIRE_STATUS_CHECK: {
    type: 'boolean',
    label: 'Require Status Check',
    description: 'Require credential status check (HAIP requirement)',
  },
};

/**
 * Parse numeric value from string
 */
function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse boolean from string
 */
function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value.toLowerCase() !== 'false' && value !== '0';
}

/**
 * Cached configuration value
 */
interface CachedValue<T> {
  value: T;
  expiresAt: number;
}

/**
 * VC Configuration Manager
 *
 * Provides hybrid config resolution with caching
 * Priority: Cache > KV > Environment > Default
 */
export class VCConfigManager {
  private kv: KVNamespace | null;
  private envValues: Partial<Env>;
  private cache: Map<VCConfigName, CachedValue<number | boolean | string>> = new Map();
  private cacheTTL: number;

  /**
   * @param env Environment variables
   * @param cacheTTL Cache TTL in milliseconds (default: 10 seconds)
   */
  constructor(env: Partial<Env>, cacheTTL: number = 10000) {
    this.kv = env.AUTHRIM_CONFIG ?? null;
    this.envValues = env;
    this.cacheTTL = cacheTTL;
  }

  /**
   * Get HAIP policy version
   * Priority: Cache > KV > Environment > Default
   */
  async getHaipPolicyVersion(): Promise<'draft-06' | 'final-1.0'> {
    const name = 'HAIP_POLICY_VERSION';

    // Check cache first
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as 'draft-06' | 'final-1.0';
    }

    // Try KV override
    if (this.kv) {
      try {
        const kvValue = await this.kv.get(`${KV_PREFIX}${name}`);
        if (kvValue === 'draft-06' || kvValue === 'final-1.0') {
          this.cache.set(name, { value: kvValue, expiresAt: Date.now() + this.cacheTTL });
          return kvValue;
        }
      } catch (error) {
        console.warn(
          `[VCConfigManager] Failed to read ${name} from KV:`,
          error instanceof Error ? error.name : 'Unknown error'
        );
      }
    }

    // Check environment variable
    const envValue = this.envValues.HAIP_POLICY_VERSION as string | undefined;
    if (envValue === 'draft-06' || envValue === 'final-1.0') {
      this.cache.set(name, { value: envValue, expiresAt: Date.now() + this.cacheTTL });
      return envValue;
    }

    // Use default
    const defaultValue = DEFAULT_VC_CONFIG.HAIP_POLICY_VERSION;
    this.cache.set(name, { value: defaultValue, expiresAt: Date.now() + this.cacheTTL });
    return defaultValue;
  }

  /**
   * Get a numeric configuration value
   * Priority: Cache > KV > Environment > Default
   */
  async getNumber(name: VCConfigName): Promise<number> {
    // Check cache first
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as number;
    }

    // Try KV override
    if (this.kv) {
      try {
        const kvValue = await this.kv.get(`${KV_PREFIX}${name}`);
        if (kvValue !== null) {
          const value = parseInt(kvValue, 10);
          if (!isNaN(value)) {
            this.cache.set(name, { value, expiresAt: Date.now() + this.cacheTTL });
            return value;
          }
        }
      } catch (error) {
        console.warn(
          `[VCConfigManager] Failed to read ${name} from KV:`,
          error instanceof Error ? error.name : 'Unknown error'
        );
      }
    }

    // Check environment variable (map config name to env var name)
    const envVarName = name as keyof Env;
    const envValue =
      this.envValues[envVarName] !== undefined
        ? parseNumber(this.envValues[envVarName] as string, DEFAULT_VC_CONFIG[name] as number)
        : (DEFAULT_VC_CONFIG[name] as number);

    this.cache.set(name, { value: envValue, expiresAt: Date.now() + this.cacheTTL });
    return envValue;
  }

  /**
   * Get a boolean configuration value
   * Priority: Cache > KV > Environment > Default
   */
  async getBoolean(name: VCConfigName): Promise<boolean> {
    // Check cache first
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as boolean;
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
        console.warn(
          `[VCConfigManager] Failed to read ${name} from KV:`,
          error instanceof Error ? error.name : 'Unknown error'
        );
      }
    }

    // Use default (boolean configs don't have env var mapping currently)
    const defaultValue = DEFAULT_VC_CONFIG[name] as boolean;
    this.cache.set(name, { value: defaultValue, expiresAt: Date.now() + this.cacheTTL });
    return defaultValue;
  }

  // Convenience methods

  /** Get VP request expiry in seconds */
  async getVPRequestExpiry(): Promise<number> {
    return this.getNumber('VP_REQUEST_EXPIRY_SECONDS');
  }

  /** Get nonce expiry in seconds */
  async getNonceExpiry(): Promise<number> {
    return this.getNumber('NONCE_EXPIRY_SECONDS');
  }

  /** Get c_nonce expiry in seconds */
  async getCNonceExpiry(): Promise<number> {
    return this.getNumber('C_NONCE_EXPIRY_SECONDS');
  }

  /** Get credential offer expiry in seconds */
  async getCredentialOfferExpiry(): Promise<number> {
    return this.getNumber('CREDENTIAL_OFFER_EXPIRY_SECONDS');
  }

  /** Get PoP validity period in seconds */
  async getPopValiditySeconds(): Promise<number> {
    return this.getNumber('POP_VALIDITY_SECONDS');
  }

  /** Get PoP clock skew tolerance in seconds */
  async getPopClockSkewSeconds(): Promise<number> {
    return this.getNumber('POP_CLOCK_SKEW_SECONDS');
  }

  /** Get DID cache TTL in seconds */
  async getDIDCacheTTL(): Promise<number> {
    return this.getNumber('DID_CACHE_TTL_SECONDS');
  }

  /** Check if holder binding is required */
  async isHolderBindingRequired(): Promise<boolean> {
    return this.getBoolean('REQUIRE_HOLDER_BINDING');
  }

  /** Check if issuer trust is required */
  async isIssuerTrustRequired(): Promise<boolean> {
    return this.getBoolean('REQUIRE_ISSUER_TRUST');
  }

  /** Check if status check is required */
  async isStatusCheckRequired(): Promise<boolean> {
    return this.getBoolean('REQUIRE_STATUS_CHECK');
  }

  /**
   * Set a configuration override in KV
   */
  async setConfig(name: VCConfigName, value: number | boolean | string): Promise<void> {
    if (!this.kv) {
      throw new Error('KV not configured - cannot set dynamic config override');
    }

    // Validate value based on metadata
    const meta = VC_CONFIG_METADATA[name];
    if (meta.type === 'number' && typeof value === 'number') {
      if (meta.min !== undefined && value < meta.min) {
        throw new Error(`${name} must be >= ${meta.min}`);
      }
      if (meta.max !== undefined && value > meta.max) {
        throw new Error(`${name} must be <= ${meta.max}`);
      }
    } else if (meta.type === 'string' && typeof value === 'string' && meta.options) {
      if (!meta.options.includes(value)) {
        throw new Error(`${name} must be one of: ${meta.options.join(', ')}`);
      }
    }

    await this.kv.put(`${KV_PREFIX}${name}`, value.toString());
    // Update cache immediately
    this.cache.set(name, { value, expiresAt: Date.now() + this.cacheTTL });
  }

  /**
   * Remove a configuration override from KV (revert to env/default)
   */
  async clearConfig(name: VCConfigName): Promise<void> {
    if (!this.kv) {
      throw new Error('KV not configured - cannot clear config override');
    }
    await this.kv.delete(`${KV_PREFIX}${name}`);
    this.cache.delete(name);
  }

  /**
   * Get configuration sources (for debugging/admin UI)
   */
  async getConfigSources(): Promise<
    Record<VCConfigName, { value: number | boolean | string; source: 'kv' | 'env' | 'default' }>
  > {
    const result: Record<
      string,
      { value: number | boolean | string; source: 'kv' | 'env' | 'default' }
    > = {};

    for (const name of VC_CONFIG_NAMES) {
      let source: 'kv' | 'env' | 'default' = 'default';
      let value: number | boolean | string = DEFAULT_VC_CONFIG[name];

      // Check KV override
      if (this.kv) {
        try {
          const kvValue = await this.kv.get(`${KV_PREFIX}${name}`);
          if (kvValue !== null) {
            source = 'kv';
            const meta = VC_CONFIG_METADATA[name];
            if (meta.type === 'boolean') {
              value = kvValue.toLowerCase() === 'true' || kvValue === '1';
            } else if (meta.type === 'number') {
              const parsed = parseInt(kvValue, 10);
              if (!isNaN(parsed)) {
                value = parsed;
              }
            } else {
              value = kvValue;
            }
          }
        } catch {
          // Ignore KV errors
        }
      }

      // Check environment (only if not from KV)
      if (source === 'default') {
        const envVarName = name as keyof Env;
        const envValue = this.envValues[envVarName];
        if (envValue !== undefined && envValue !== '') {
          source = 'env';
          const meta = VC_CONFIG_METADATA[name];
          if (meta.type === 'number') {
            value = parseNumber(envValue as string, DEFAULT_VC_CONFIG[name] as number);
          } else if (meta.type === 'boolean') {
            value = parseBool(envValue as string, DEFAULT_VC_CONFIG[name] as boolean);
          } else {
            value = envValue as string;
          }
        }
      }

      result[name] = { value, source };
    }

    return result as Record<
      VCConfigName,
      { value: number | boolean | string; source: 'kv' | 'env' | 'default' }
    >;
  }

  /**
   * Clear cache (force re-read from KV on next access)
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Create a VC config manager
 */
export function createVCConfigManager(env: Partial<Env>, cacheTTL?: number): VCConfigManager {
  return new VCConfigManager(env, cacheTTL);
}
