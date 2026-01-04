/**
 * Settings Manager - Unified Configuration Management
 *
 * Provides a hybrid approach for managing settings:
 * - Environment variables provide enforced values (cannot be overridden)
 * - KV storage provides dynamic overrides (changes without deploy)
 * - Code defaults provide safe fallback values
 *
 * Priority: env > KV > default
 *
 * Design principles (from Settings API v2):
 * - Explicit scope ID in URL (tenantId/clientId)
 * - Separation of config and state
 * - Optimistic locking (version/ifMatch)
 * - Semantic distinction between clear and disable
 * - disable is a state, not a value ("__DISABLED__")
 */

import { createHash } from 'node:crypto';
import { createLogger } from './logger';

const log = createLogger().module('SETTINGS_MANAGER');

// ============================================================================
// Types
// ============================================================================

/**
 * Setting scope types
 */
export type SettingScope =
  | { type: 'platform' }
  | { type: 'tenant'; id: string }
  | { type: 'client'; id: string };

/**
 * Setting value source
 */
export type SettingSource = 'env' | 'kv' | 'default';

/**
 * Marker for disabled settings
 * Use this instead of null to explicitly disable a setting
 */
export const DISABLED_MARKER = '__DISABLED__';

/**
 * Dangerous keys that could be used for prototype pollution attacks
 */
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Sanitize object to prevent prototype pollution
 * Removes dangerous keys like __proto__, constructor, prototype
 */
function sanitizeObject(obj: unknown): Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!DANGEROUS_KEYS.includes(key)) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Setting metadata for validation and UI
 */
export interface SettingMeta {
  /** Key in dot.notation format */
  key: string;
  /** Value type */
  type: 'number' | 'boolean' | 'string' | 'duration' | 'enum';
  /** Default value (from code) */
  default: unknown;
  /** Environment variable key mapping */
  envKey?: string;
  /** Human-readable label */
  label: string;
  /** Description for admin UI */
  description: string;
  /** Minimum value (for number/duration) */
  min?: number;
  /** Maximum value (for number/duration) */
  max?: number;
  /** Unit (e.g., "seconds", "ms") */
  unit?: string;
  /** Allowed values (for enum type) */
  enum?: string[];
  /** Whether restart is required for changes to take effect */
  restartRequired?: boolean;
  /** Dependency on other settings */
  dependsOn?: Array<{ key: string; value: unknown }>;
  /** Visibility level */
  visibility?: 'public' | 'admin' | 'internal';
}

/**
 * Category metadata
 */
export interface CategoryMeta {
  /** Category name in kebab-case */
  category: string;
  /** Human-readable label */
  label: string;
  /** Description */
  description: string;
  /** Settings in this category */
  settings: Record<string, SettingMeta>;
}

/**
 * GET response structure
 */
export interface SettingsGetResult {
  /** Category name */
  category: string;
  /** Scope information */
  scope: SettingScope;
  /** Version hash for optimistic locking */
  version: string;
  /** Resolved setting values */
  values: Record<string, unknown>;
  /** Source of each value */
  sources: Record<string, SettingSource>;
}

/**
 * PATCH request structure
 */
export interface SettingsPatchRequest {
  /** Version for optimistic locking (required) */
  ifMatch: string;
  /** Values to set */
  set?: Record<string, unknown>;
  /** Keys to clear (revert to env/default) */
  clear?: string[];
  /** Keys to disable */
  disable?: string[];
}

/**
 * PATCH response structure
 */
export interface SettingsPatchResult {
  /** New version hash */
  version: string;
  /** Successfully applied keys */
  applied: string[];
  /** Successfully cleared keys */
  cleared: string[];
  /** Successfully disabled keys */
  disabled: string[];
  /** Rejected keys with reasons */
  rejected: Record<string, string>;
}

/**
 * Validation error for settings
 */
export interface SettingsValidationError {
  key: string;
  reason: string;
}

/**
 * Validation result for settings
 */
export interface SettingsValidationResult {
  valid: boolean;
  errors: SettingsValidationError[];
}

/**
 * Audit event for settings changes
 */
export interface SettingsAuditEvent {
  event: 'settings.updated';
  scope: 'platform' | 'tenant' | 'client';
  scopeId: string;
  category: string;
  diff: Record<string, { before: unknown; after: unknown }>;
  actor: string;
  timestamp: string;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate version hash from KV data
 * Uses canonical JSON (key sorted) for consistent hashing
 */
export function generateVersion(data: Record<string, unknown>): string {
  const sorted = Object.keys(data)
    .sort()
    .reduce(
      (acc, key) => {
        acc[key] = data[key];
        return acc;
      },
      {} as Record<string, unknown>
    );
  const json = JSON.stringify(sorted);
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 16);
  return `sha256:${hash}`;
}

/**
 * Parse value from environment variable string
 */
function parseEnvValue(value: string | undefined, type: SettingMeta['type']): unknown {
  if (value === undefined || value === '') {
    return undefined;
  }

  switch (type) {
    case 'number':
    case 'duration': {
      const parsed = parseInt(value, 10);
      return isNaN(parsed) ? undefined : parsed;
    }
    case 'boolean':
      return value.toLowerCase() === 'true' || value === '1';
    case 'string':
    case 'enum':
      return value;
    default:
      return value;
  }
}

/**
 * Check if a value is the disabled marker
 */
export function isDisabled(value: unknown): boolean {
  return value === DISABLED_MARKER;
}

/**
 * Validate and sanitize KV key component
 * Prevents injection attacks via malicious category or scope IDs
 */
function validateKVKeyPart(part: string, partName: string): string {
  // Only allow alphanumeric, hyphen, underscore (standard identifier characters)
  if (!/^[a-zA-Z0-9_-]+$/.test(part)) {
    throw new Error(
      `Invalid ${partName}: must contain only alphanumeric characters, hyphens, or underscores`
    );
  }
  // Limit length to prevent DoS via extremely long keys
  if (part.length > 128) {
    throw new Error(`Invalid ${partName}: exceeds maximum length of 128 characters`);
  }
  return part;
}

function getKVKey(category: string, scope: SettingScope): string {
  const safeCategory = validateKVKeyPart(category, 'category');

  switch (scope.type) {
    case 'platform':
      return `settings:platform:${safeCategory}`;
    case 'tenant':
      return `settings:tenant:${validateKVKeyPart(scope.id, 'tenantId')}:${safeCategory}`;
    case 'client':
      return `settings:client:${validateKVKeyPart(scope.id, 'clientId')}:${safeCategory}`;
  }
}

// ============================================================================
// Settings Manager
// ============================================================================

/**
 * Settings Manager
 *
 * Provides unified settings management with:
 * - Priority: env > KV > default
 * - Version-based optimistic locking
 * - Validation with metadata
 * - Audit logging
 */
export class SettingsManager {
  private env: Record<string, string | undefined>;
  private kv: KVNamespace | null;
  private categoryMeta: Map<string, CategoryMeta> = new Map();
  private auditCallback?: (event: SettingsAuditEvent) => Promise<void>;

  // In-memory cache for runtime performance
  private cache: Map<string, { data: Record<string, unknown>; expiresAt: number }> = new Map();
  private cacheTTL: number;

  constructor(options: {
    env: Record<string, string | undefined>;
    kv?: KVNamespace | null;
    cacheTTL?: number;
    auditCallback?: (event: SettingsAuditEvent) => Promise<void>;
  }) {
    this.env = options.env;
    this.kv = options.kv ?? null;
    this.cacheTTL = options.cacheTTL ?? 5000; // Default 5 seconds
    this.auditCallback = options.auditCallback;
  }

  /**
   * Register category metadata
   */
  registerCategory(meta: CategoryMeta): void {
    this.categoryMeta.set(meta.category, meta);
  }

  /**
   * Get category metadata
   */
  getMeta(category: string): CategoryMeta | undefined {
    return this.categoryMeta.get(category);
  }

  /**
   * Get all settings for a category
   */
  async getAll(category: string, scope: SettingScope): Promise<SettingsGetResult> {
    const meta = this.categoryMeta.get(category);
    if (!meta) {
      throw new Error(`Unknown category: ${category}`);
    }

    // Load KV data
    const kvData = await this.loadKVData(category, scope);

    // Resolve values with priority: env > KV > default
    const values: Record<string, unknown> = {};
    const sources: Record<string, SettingSource> = {};

    for (const [key, settingMeta] of Object.entries(meta.settings)) {
      const resolved = this.resolveValue(key, settingMeta, kvData);
      values[key] = resolved.value;
      sources[key] = resolved.source;
    }

    return {
      category,
      scope,
      version: generateVersion(kvData),
      values,
      sources,
    };
  }

  /**
   * Get a single setting value
   */
  async get(key: string, scope: SettingScope): Promise<unknown> {
    const [category] = key.split('.');
    const meta = this.categoryMeta.get(category);
    if (!meta) {
      throw new Error(`Unknown category: ${category}`);
    }

    const settingMeta = meta.settings[key];
    if (!settingMeta) {
      throw new Error(`Unknown setting: ${key}`);
    }

    const kvData = await this.loadKVData(category, scope);
    return this.resolveValue(key, settingMeta, kvData).value;
  }

  /**
   * Patch settings (partial update with optimistic locking)
   *
   * Rules:
   * - ifMatch is required and must match current version
   * - Partial success is OK (some keys may be rejected)
   * - Version updates if anything was applied
   * - validate() has no side effects - always reject, never auto-fix
   */
  async patch(
    category: string,
    scope: SettingScope,
    request: SettingsPatchRequest,
    actor: string
  ): Promise<SettingsPatchResult> {
    const meta = this.categoryMeta.get(category);
    if (!meta) {
      throw new Error(`Unknown category: ${category}`);
    }

    // Platform settings are read-only
    if (scope.type === 'platform') {
      throw new Error('Platform settings are read-only');
    }

    // Invalidate cache before loading to prevent TOCTOU race conditions
    // This ensures we read the latest KV data for version checking
    this.invalidateCache(category, scope);

    // Load current KV data
    const kvData = await this.loadKVData(category, scope);
    const currentVersion = generateVersion(kvData);

    // Check optimistic lock
    if (request.ifMatch !== currentVersion) {
      throw new ConflictError('Settings were updated by someone else. Please refresh.', {
        currentVersion,
      });
    }

    const applied: string[] = [];
    const cleared: string[] = [];
    const disabled: string[] = [];
    const rejected: Record<string, string> = {};
    const diff: Record<string, { before: unknown; after: unknown }> = {};

    // Process set operations
    if (request.set) {
      for (const [key, value] of Object.entries(request.set)) {
        const settingMeta = meta.settings[key];
        if (!settingMeta) {
          rejected[key] = 'Unknown setting key';
          continue;
        }

        // Check if env override exists (cannot be overridden)
        if (settingMeta.envKey && this.env[settingMeta.envKey] !== undefined) {
          rejected[key] = 'read-only (env override)';
          continue;
        }

        // Validate value
        const validation = this.validateSingleValue(key, value, settingMeta);
        if (!validation.valid) {
          rejected[key] = validation.errors[0]?.reason ?? 'Validation failed';
          continue;
        }

        // Check dependencies
        const depCheck = this.checkDependencies(key, settingMeta, kvData, request.set);
        if (!depCheck.valid) {
          rejected[key] = depCheck.reason;
          continue;
        }

        // Apply
        const before = kvData[key];
        kvData[key] = value;
        diff[key] = { before, after: value };
        applied.push(key);
      }
    }

    // Process clear operations
    if (request.clear) {
      for (const key of request.clear) {
        const settingMeta = meta.settings[key];
        if (!settingMeta) {
          rejected[key] = 'Unknown setting key';
          continue;
        }

        // Check if env override exists
        if (settingMeta.envKey && this.env[settingMeta.envKey] !== undefined) {
          rejected[key] = 'read-only (env override)';
          continue;
        }

        if (key in kvData) {
          const before = kvData[key];
          delete kvData[key];
          diff[key] = { before, after: settingMeta.default };
          cleared.push(key);
        }
      }
    }

    // Process disable operations
    if (request.disable) {
      for (const key of request.disable) {
        const settingMeta = meta.settings[key];
        if (!settingMeta) {
          rejected[key] = 'Unknown setting key';
          continue;
        }

        // Check if env override exists
        if (settingMeta.envKey && this.env[settingMeta.envKey] !== undefined) {
          rejected[key] = 'read-only (env override)';
          continue;
        }

        // Only boolean settings can be disabled
        if (settingMeta.type !== 'boolean') {
          rejected[key] = 'Only boolean settings can be disabled';
          continue;
        }

        const before = kvData[key];
        kvData[key] = DISABLED_MARKER;
        diff[key] = { before, after: DISABLED_MARKER };
        disabled.push(key);
      }
    }

    // Save if anything changed
    const hasChanges = applied.length > 0 || cleared.length > 0 || disabled.length > 0;
    if (hasChanges) {
      await this.saveKVData(category, scope, kvData);

      // Invalidate cache
      this.invalidateCache(category, scope);

      // Emit audit event
      if (this.auditCallback && Object.keys(diff).length > 0) {
        // At this point scope is guaranteed to be tenant or client (platform throws earlier)
        const scopeWithId = scope as { type: 'tenant' | 'client'; id: string };
        await this.auditCallback({
          event: 'settings.updated',
          scope: scopeWithId.type,
          scopeId: scopeWithId.id,
          category,
          diff,
          actor,
          timestamp: new Date().toISOString(),
        });
      }
    }

    return {
      version: generateVersion(kvData),
      applied,
      cleared,
      disabled,
      rejected,
    };
  }

  /**
   * Validate multiple values
   */
  validate(category: string, values: Record<string, unknown>): SettingsValidationResult {
    const meta = this.categoryMeta.get(category);
    if (!meta) {
      return { valid: false, errors: [{ key: category, reason: 'Unknown category' }] };
    }

    const errors: SettingsValidationError[] = [];

    for (const [key, value] of Object.entries(values)) {
      const settingMeta = meta.settings[key];
      if (!settingMeta) {
        errors.push({ key, reason: 'Unknown setting key' });
        continue;
      }

      const validation = this.validateSingleValue(key, value, settingMeta);
      errors.push(...validation.errors);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get version hash for a category
   */
  async getVersion(category: string, scope: SettingScope): Promise<string> {
    const kvData = await this.loadKVData(category, scope);
    return generateVersion(kvData);
  }

  /**
   * Get runtime view (resolved values only, no sources/version)
   * Uses short TTL cache for performance
   */
  async getRuntimeView(category: string, scope: SettingScope): Promise<Record<string, unknown>> {
    const cacheKey = getKVKey(category, scope);
    const cached = this.cache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      // Return resolved values from cache
      return this.resolveAllValues(category, cached.data);
    }

    // Load fresh
    const result = await this.getAll(category, scope);
    return result.values;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Load KV data for a category and scope
   */
  private async loadKVData(
    category: string,
    scope: SettingScope
  ): Promise<Record<string, unknown>> {
    if (!this.kv) {
      return {};
    }

    const cacheKey = getKVKey(category, scope);
    const cached = this.cache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    try {
      const key = getKVKey(category, scope);
      const json = await this.kv.get(key);

      // Parse and validate KV data
      let data: Record<string, unknown> = {};
      if (json) {
        const parsed = JSON.parse(json);
        // Validate parsed data is a plain object (not null, not array)
        // and sanitize to prevent prototype pollution
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          data = sanitizeObject(parsed);
        } else {
          log.warn(
            `Invalid KV data format for ${key}: expected object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
          );
        }
      }

      // Update cache
      this.cache.set(cacheKey, {
        data,
        expiresAt: Date.now() + this.cacheTTL,
      });

      return data;
    } catch (error) {
      log.warn('Failed to load settings from KV');
      return {};
    }
  }

  /**
   * Save KV data for a category and scope
   */
  private async saveKVData(
    category: string,
    scope: SettingScope,
    data: Record<string, unknown>
  ): Promise<void> {
    if (!this.kv) {
      throw new Error('KV not configured');
    }

    const key = getKVKey(category, scope);
    await this.kv.put(key, JSON.stringify(data));
  }

  /**
   * Invalidate cache for a category and scope
   */
  private invalidateCache(category: string, scope: SettingScope): void {
    const cacheKey = getKVKey(category, scope);
    this.cache.delete(cacheKey);
  }

  /**
   * Resolve a single value with priority: env > KV > default
   */
  private resolveValue(
    key: string,
    meta: SettingMeta,
    kvData: Record<string, unknown>
  ): { value: unknown; source: SettingSource } {
    // 1. Check env override (highest priority)
    if (meta.envKey) {
      const envValue = parseEnvValue(this.env[meta.envKey], meta.type);
      if (envValue !== undefined) {
        return { value: envValue, source: 'env' };
      }
    }

    // 2. Check KV value
    const kvValue = kvData[key];
    if (kvValue !== undefined) {
      // Handle disabled marker
      if (isDisabled(kvValue)) {
        return { value: false, source: 'kv' };
      }
      return { value: kvValue, source: 'kv' };
    }

    // 3. Use default
    return { value: meta.default, source: 'default' };
  }

  /**
   * Resolve all values for a category
   */
  private resolveAllValues(
    category: string,
    kvData: Record<string, unknown>
  ): Record<string, unknown> {
    const meta = this.categoryMeta.get(category);
    if (!meta) {
      return {};
    }

    const values: Record<string, unknown> = {};
    for (const [key, settingMeta] of Object.entries(meta.settings)) {
      values[key] = this.resolveValue(key, settingMeta, kvData).value;
    }
    return values;
  }

  /**
   * Validate a single value
   */
  private validateSingleValue(
    key: string,
    value: unknown,
    meta: SettingMeta
  ): SettingsValidationResult {
    const errors: SettingsValidationError[] = [];

    // Type validation
    switch (meta.type) {
      case 'number':
      case 'duration':
        if (typeof value !== 'number') {
          errors.push({ key, reason: `Expected number, got ${typeof value}` });
        } else {
          if (meta.min !== undefined && value < meta.min) {
            errors.push({ key, reason: `Value must be >= ${meta.min}` });
          }
          if (meta.max !== undefined && value > meta.max) {
            errors.push({ key, reason: `Value must be <= ${meta.max}` });
          }
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          errors.push({ key, reason: `Expected boolean, got ${typeof value}` });
        }
        break;

      case 'string':
        if (typeof value !== 'string') {
          errors.push({ key, reason: `Expected string, got ${typeof value}` });
        }
        break;

      case 'enum':
        if (typeof value !== 'string') {
          errors.push({ key, reason: `Expected string, got ${typeof value}` });
        } else if (meta.enum && !meta.enum.includes(value)) {
          errors.push({ key, reason: `Value must be one of: ${meta.enum.join(', ')}` });
        }
        break;
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Check setting dependencies
   */
  private checkDependencies(
    key: string,
    meta: SettingMeta,
    currentKvData: Record<string, unknown>,
    pendingSet?: Record<string, unknown>
  ): { valid: boolean; reason: string } {
    if (!meta.dependsOn || meta.dependsOn.length === 0) {
      return { valid: true, reason: '' };
    }

    for (const dep of meta.dependsOn) {
      // Check pending set first, then current KV data
      const depValue = pendingSet?.[dep.key] ?? currentKvData[dep.key];

      // If dependency is disabled, reject the setting
      if (isDisabled(depValue)) {
        return {
          valid: false,
          reason: `Depends on ${dep.key} which is currently disabled`,
        };
      }

      if (depValue !== dep.value) {
        return {
          valid: false,
          reason: `Depends on ${dep.key} = ${JSON.stringify(dep.value)}`,
        };
      }
    }

    return { valid: true, reason: '' };
  }
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Conflict error (409)
 */
export class ConflictError extends Error {
  public readonly currentVersion: string;

  constructor(message: string, details: { currentVersion: string }) {
    super(message);
    this.name = 'ConflictError';
    this.currentVersion = details.currentVersion;
  }
}

/**
 * Create a SettingsManager instance
 */
export function createSettingsManager(options: {
  env: Record<string, string | undefined>;
  kv?: KVNamespace | null;
  cacheTTL?: number;
  auditCallback?: (event: SettingsAuditEvent) => Promise<void>;
}): SettingsManager {
  return new SettingsManager(options);
}
