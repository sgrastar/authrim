/**
 * OAuth/OIDC Configuration Manager
 *
 * Hybrid approach for managing OAuth configuration:
 * - Environment variables provide defaults (requires deploy to change)
 * - KV storage provides dynamic overrides (changes without deploy)
 *
 * Priority: Cache > KV > Environment variable > Default value
 *
 * Supported configurations:
 * - TOKEN_EXPIRY: Access token TTL in seconds (default: 3600 = 1 hour)
 * - AUTH_CODE_TTL: Authorization code TTL in seconds (default: 60)
 * - STATE_EXPIRY: OAuth state parameter TTL in seconds (default: 300 = 5 min)
 * - NONCE_EXPIRY: OIDC nonce TTL in seconds (default: 300 = 5 min)
 * - REFRESH_TOKEN_EXPIRY: Refresh token TTL in seconds (default: 7776000 = 90 days)
 * - REFRESH_TOKEN_ROTATION_ENABLED: Enable refresh token rotation (default: true)
 * - MAX_CODES_PER_USER: Max auth codes per user for DDoS protection (default: 100)
 * - CODE_SHARDS: Number of auth code DO shards (default: 64)
 */

import type { Env } from '../types/env';

/**
 * OAuth configuration values
 */
export interface OAuthConfig {
  /** Access token TTL in seconds */
  TOKEN_EXPIRY: number;

  /** Authorization code TTL in seconds */
  AUTH_CODE_TTL: number;

  /** OAuth state parameter TTL in seconds */
  STATE_EXPIRY: number;

  /** OIDC nonce TTL in seconds */
  NONCE_EXPIRY: number;

  /** Refresh token TTL in seconds */
  REFRESH_TOKEN_EXPIRY: number;

  /** Enable refresh token rotation (security best practice) */
  REFRESH_TOKEN_ROTATION_ENABLED: boolean;

  /** Max authorization codes per user (DDoS protection) */
  MAX_CODES_PER_USER: number;

  /** Number of auth code DO shards for load distribution */
  CODE_SHARDS: number;
}

/**
 * Default values for OAuth configuration
 * Based on OAuth 2.0 Security BCP and common practices
 */
export const DEFAULT_CONFIG: OAuthConfig = {
  TOKEN_EXPIRY: 3600, // 1 hour (RFC 6749 recommendation)
  AUTH_CODE_TTL: 60, // 60 seconds (OAuth 2.0 Security BCP)
  STATE_EXPIRY: 300, // 5 minutes
  NONCE_EXPIRY: 300, // 5 minutes
  REFRESH_TOKEN_EXPIRY: 7776000, // 90 days (industry standard)
  REFRESH_TOKEN_ROTATION_ENABLED: true, // Security best practice
  MAX_CODES_PER_USER: 100, // DDoS protection
  CODE_SHARDS: 64, // Default shard count
};

/**
 * KV key prefix for OAuth configuration
 */
const KV_PREFIX = 'oauth:config:';

/**
 * Configuration key names
 */
export const CONFIG_NAMES = [
  'TOKEN_EXPIRY',
  'AUTH_CODE_TTL',
  'STATE_EXPIRY',
  'NONCE_EXPIRY',
  'REFRESH_TOKEN_EXPIRY',
  'REFRESH_TOKEN_ROTATION_ENABLED',
  'MAX_CODES_PER_USER',
  'CODE_SHARDS',
] as const;

export type ConfigName = (typeof CONFIG_NAMES)[number];

/**
 * Configuration metadata for Admin UI
 */
export const CONFIG_METADATA: Record<
  ConfigName,
  {
    type: 'number' | 'boolean';
    label: string;
    description: string;
    min?: number;
    max?: number;
    unit?: string;
  }
> = {
  TOKEN_EXPIRY: {
    type: 'number',
    label: 'Access Token TTL',
    description: 'Access token lifetime in seconds',
    min: 60,
    max: 86400,
    unit: 'seconds',
  },
  AUTH_CODE_TTL: {
    type: 'number',
    label: 'Authorization Code TTL',
    description: 'Authorization code lifetime in seconds (OAuth 2.0 BCP: 60s)',
    min: 10,
    max: 86400,
    unit: 'seconds',
  },
  STATE_EXPIRY: {
    type: 'number',
    label: 'State Parameter TTL',
    description: 'OAuth state parameter lifetime in seconds',
    min: 60,
    max: 3600,
    unit: 'seconds',
  },
  NONCE_EXPIRY: {
    type: 'number',
    label: 'Nonce TTL',
    description: 'OIDC nonce lifetime in seconds',
    min: 60,
    max: 3600,
    unit: 'seconds',
  },
  REFRESH_TOKEN_EXPIRY: {
    type: 'number',
    label: 'Refresh Token TTL',
    description: 'Refresh token lifetime in seconds',
    min: 3600,
    max: 31536000,
    unit: 'seconds',
  },
  REFRESH_TOKEN_ROTATION_ENABLED: {
    type: 'boolean',
    label: 'Refresh Token Rotation',
    description: 'Enable refresh token rotation (security best practice)',
  },
  MAX_CODES_PER_USER: {
    type: 'number',
    label: 'Max Codes Per User',
    description: 'Maximum authorization codes per user (DDoS protection)',
    min: 10,
    max: 1000000,
  },
  CODE_SHARDS: {
    type: 'number',
    label: 'Auth Code Shards',
    description: 'Number of Durable Object shards for auth codes',
    min: 1,
    max: 256,
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
  // "false" or "0" → false, everything else → true
  return value.toLowerCase() !== 'false' && value !== '0';
}

/**
 * Get OAuth config from environment variables only
 * Use this when KV is not available
 */
export function getConfigFromEnv(env: Partial<Env>): OAuthConfig {
  return {
    TOKEN_EXPIRY: parseNumber(env.TOKEN_EXPIRY, DEFAULT_CONFIG.TOKEN_EXPIRY),
    AUTH_CODE_TTL: parseNumber(env.AUTH_CODE_TTL, DEFAULT_CONFIG.AUTH_CODE_TTL),
    STATE_EXPIRY: parseNumber(env.STATE_EXPIRY, DEFAULT_CONFIG.STATE_EXPIRY),
    NONCE_EXPIRY: parseNumber(env.NONCE_EXPIRY, DEFAULT_CONFIG.NONCE_EXPIRY),
    REFRESH_TOKEN_EXPIRY: parseNumber(
      env.REFRESH_TOKEN_EXPIRY,
      DEFAULT_CONFIG.REFRESH_TOKEN_EXPIRY
    ),
    REFRESH_TOKEN_ROTATION_ENABLED: parseBool(
      env.REFRESH_TOKEN_ROTATION_ENABLED,
      DEFAULT_CONFIG.REFRESH_TOKEN_ROTATION_ENABLED
    ),
    MAX_CODES_PER_USER: parseNumber(env.MAX_CODES_PER_USER, DEFAULT_CONFIG.MAX_CODES_PER_USER),
    CODE_SHARDS: parseNumber(env.AUTHRIM_CODE_SHARDS, DEFAULT_CONFIG.CODE_SHARDS),
  };
}

/**
 * Cached configuration value
 */
interface CachedValue<T> {
  value: T;
  expiresAt: number;
}

/**
 * OAuth Configuration Manager
 *
 * Provides hybrid config resolution with caching
 */
export class OAuthConfigManager {
  private envConfig: OAuthConfig;
  private kv: KVNamespace | null;
  private cache: Map<ConfigName, CachedValue<number | boolean>> = new Map();
  private cacheTTL: number;

  /**
   * @param env Environment variables
   * @param kv KV namespace for dynamic overrides (AUTHRIM_CONFIG)
   * @param cacheTTL Cache TTL in milliseconds (default: 10 seconds)
   */
  constructor(env: Partial<Env>, kv: KVNamespace | null = null, cacheTTL: number = 10000) {
    this.envConfig = getConfigFromEnv(env);
    this.kv = kv;
    this.cacheTTL = cacheTTL;
  }

  /**
   * Get a numeric configuration value
   * Priority: Cache > KV > Environment > Default
   */
  async getNumber(name: ConfigName): Promise<number> {
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
        console.warn(`Failed to read config ${name} from KV:`, error);
        // Fall through to env value
      }
    }

    // Use environment value
    const value = this.envConfig[name] as number;
    this.cache.set(name, { value, expiresAt: Date.now() + this.cacheTTL });
    return value;
  }

  /**
   * Get a boolean configuration value
   * Priority: Cache > KV > Environment > Default
   */
  async getBoolean(name: ConfigName): Promise<boolean> {
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
        console.warn(`Failed to read config ${name} from KV:`, error);
        // Fall through to env value
      }
    }

    // Use environment value
    const value = this.envConfig[name] as boolean;
    this.cache.set(name, { value, expiresAt: Date.now() + this.cacheTTL });
    return value;
  }

  /**
   * Get all configuration values
   */
  async getAllConfig(): Promise<OAuthConfig> {
    return {
      TOKEN_EXPIRY: await this.getNumber('TOKEN_EXPIRY'),
      AUTH_CODE_TTL: await this.getNumber('AUTH_CODE_TTL'),
      STATE_EXPIRY: await this.getNumber('STATE_EXPIRY'),
      NONCE_EXPIRY: await this.getNumber('NONCE_EXPIRY'),
      REFRESH_TOKEN_EXPIRY: await this.getNumber('REFRESH_TOKEN_EXPIRY'),
      REFRESH_TOKEN_ROTATION_ENABLED: await this.getBoolean('REFRESH_TOKEN_ROTATION_ENABLED'),
      MAX_CODES_PER_USER: await this.getNumber('MAX_CODES_PER_USER'),
      CODE_SHARDS: await this.getNumber('CODE_SHARDS'),
    };
  }

  /**
   * Get config synchronously from cache/env only (no KV lookup)
   * Use this for performance-critical paths after initial warm-up
   */
  getConfigSync(): OAuthConfig {
    const config: Partial<OAuthConfig> = {};
    for (const name of CONFIG_NAMES) {
      const cached = this.cache.get(name);
      config[name] = (
        cached && cached.expiresAt > Date.now() ? cached.value : this.envConfig[name]
      ) as never;
    }
    return config as OAuthConfig;
  }

  /**
   * Set a configuration override in KV
   * Requires KV to be configured
   */
  async setConfig(name: ConfigName, value: number | boolean): Promise<void> {
    if (!this.kv) {
      throw new Error('KV not configured - cannot set dynamic config override');
    }

    // Validate value based on metadata
    const meta = CONFIG_METADATA[name];
    if (meta.type === 'number' && typeof value === 'number') {
      if (meta.min !== undefined && value < meta.min) {
        throw new Error(`${name} must be >= ${meta.min}`);
      }
      if (meta.max !== undefined && value > meta.max) {
        throw new Error(`${name} must be <= ${meta.max}`);
      }
    }

    await this.kv.put(`${KV_PREFIX}${name}`, value.toString());
    // Update cache immediately
    this.cache.set(name, { value, expiresAt: Date.now() + this.cacheTTL });
  }

  /**
   * Remove a configuration override from KV (revert to env/default)
   */
  async clearConfig(name: ConfigName): Promise<void> {
    if (!this.kv) {
      throw new Error('KV not configured - cannot clear config override');
    }
    await this.kv.delete(`${KV_PREFIX}${name}`);
    // Clear from cache so next read uses env value
    this.cache.delete(name);
  }

  /**
   * Clear all configuration overrides from KV
   */
  async clearAllConfig(): Promise<void> {
    if (!this.kv) {
      throw new Error('KV not configured - cannot clear config');
    }
    for (const name of CONFIG_NAMES) {
      await this.kv.delete(`${KV_PREFIX}${name}`);
      this.cache.delete(name);
    }
  }

  /**
   * Get configuration sources (for debugging/admin UI)
   */
  async getConfigSources(): Promise<
    Record<ConfigName, { value: number | boolean; source: 'kv' | 'env' | 'default' }>
  > {
    const result: Record<string, { value: number | boolean; source: 'kv' | 'env' | 'default' }> =
      {};

    for (const name of CONFIG_NAMES) {
      let source: 'kv' | 'env' | 'default' = 'default';
      let value: number | boolean = DEFAULT_CONFIG[name];

      // Check if env has explicit value (different from default)
      const envValue = this.envConfig[name];
      if (envValue !== DEFAULT_CONFIG[name]) {
        source = 'env';
        value = envValue;
      }

      // Check KV override
      if (this.kv) {
        try {
          const kvValue = await this.kv.get(`${KV_PREFIX}${name}`);
          if (kvValue !== null) {
            source = 'kv';
            const meta = CONFIG_METADATA[name];
            if (meta.type === 'boolean') {
              value = kvValue.toLowerCase() === 'true' || kvValue === '1';
            } else {
              const parsed = parseInt(kvValue, 10);
              if (!isNaN(parsed)) {
                value = parsed;
              }
            }
          }
        } catch {
          // Ignore KV errors
        }
      }

      result[name] = { value, source };
    }

    return result as Record<
      ConfigName,
      { value: number | boolean; source: 'kv' | 'env' | 'default' }
    >;
  }

  // Convenience methods for common config values

  /** Get access token expiry in seconds */
  async getTokenExpiry(): Promise<number> {
    return this.getNumber('TOKEN_EXPIRY');
  }

  /** Get authorization code TTL in seconds */
  async getAuthCodeTTL(): Promise<number> {
    return this.getNumber('AUTH_CODE_TTL');
  }

  /** Get state parameter expiry in seconds */
  async getStateExpiry(): Promise<number> {
    return this.getNumber('STATE_EXPIRY');
  }

  /** Get nonce expiry in seconds */
  async getNonceExpiry(): Promise<number> {
    return this.getNumber('NONCE_EXPIRY');
  }

  /** Get refresh token expiry in seconds */
  async getRefreshTokenExpiry(): Promise<number> {
    return this.getNumber('REFRESH_TOKEN_EXPIRY');
  }

  /** Check if refresh token rotation is enabled */
  async isRefreshTokenRotationEnabled(): Promise<boolean> {
    return this.getBoolean('REFRESH_TOKEN_ROTATION_ENABLED');
  }

  /** Get max codes per user limit */
  async getMaxCodesPerUser(): Promise<number> {
    return this.getNumber('MAX_CODES_PER_USER');
  }

  /** Get auth code shard count */
  async getCodeShards(): Promise<number> {
    return this.getNumber('CODE_SHARDS');
  }

  /**
   * Clear cache (force re-read from KV on next access)
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Create an OAuth config manager
 */
export function createOAuthConfigManager(env: Partial<Env>, cacheTTL?: number): OAuthConfigManager {
  const kv = env.AUTHRIM_CONFIG ?? null;
  return new OAuthConfigManager(env, kv, cacheTTL);
}

/**
 * Global config manager instance (singleton pattern for Workers)
 * Re-created per request with the env binding
 */
let globalConfigManager: OAuthConfigManager | null = null;

/**
 * Get or create the global OAuth config manager
 * Call this at the start of each request with the env binding
 */
export function getOAuthConfigManager(env: Partial<Env>): OAuthConfigManager {
  // For now, create a new manager per request (env may differ between requests in edge cases)
  // The internal cache will still help reduce KV calls within a request
  globalConfigManager = createOAuthConfigManager(env);
  return globalConfigManager;
}
