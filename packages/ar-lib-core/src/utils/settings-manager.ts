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
import { sanitizeObject } from './security';

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
  | { type: 'client'; id: string; tenantId: string };

/**
 * Setting value source
 * - 'kv': set at the requested scope
 * - 'tenant' / 'platform': inherited from that parent scope
 * - 'env' / 'default': the deployment's environment variable, or the code default
 */
export type SettingSource = 'env' | 'kv' | 'default' | 'tenant' | 'platform';

/** Where a value would come from if the requested scope set nothing. */
export type InheritedSettingSource = Exclude<SettingSource, 'kv'>;

/**
 * Read options
 */
export interface SettingsReadOptions {
  /**
   * Scopes to inherit from, nearest first (for a client: its tenant, then the platform).
   * Only scopes the category allows belong here; see `settingsParentScopes`.
   */
  parents?: SettingScope[];
}

/** Options of `SettingsManager.patch`. */
export interface SettingsPatchOptions extends SettingsReadOptions {
  /**
   * Save values without checking their dependencies: for a set saved as a whole (values carried
   * over from the older stores, which applied whatever their dependencies were, or a
   * certification profile), where refusing one would change what applies.
   */
  skipDependencyCheck?: boolean;
}

interface InheritedLayer {
  source: InheritedSettingSource;
  data: Record<string, unknown>;
}

/** The layers a scope inherits from, nearest first: its tenant, then the platform. */
function inheritedLayers(
  parents: SettingScope[],
  parentData: Record<string, unknown>[]
): InheritedLayer[] {
  return parents.map((parent, index) => ({
    source: parent.type as InheritedSettingSource,
    data: parentData[index],
  }));
}

/**
 * Marker for disabled settings
 * Use this instead of null to explicitly disable a setting
 */
export const DISABLED_MARKER = '__DISABLED__';

/**
 * Setting metadata for validation and UI
 */
export interface SettingMeta {
  /** Key in dot.notation format */
  key: string;
  /** Value type */
  type: 'number' | 'boolean' | 'string' | 'duration' | 'enum' | 'json';
  /** Default value (from code) */
  default: unknown;
  /** Environment variable key mapping */
  envKey?: string;
  /**
   * The scopes this setting can be set at, when fewer than its category allows (for example a
   * platform-only switch in a category that tenants can also set). Values stored at other
   * scopes are ignored, and setting them is refused.
   */
  scopes?: Array<'platform' | 'tenant' | 'client'>;
  /**
   * How a boolean environment variable reads. 'true-or-1' (default): only `true` or `1` is true.
   * 'unless-false': anything but `false` or `0` is true, as the older oauth-config read it.
   * 'exactly-true': only the exact string `true` is true, as the older system settings read it.
   */
  envBoolean?: 'true-or-1' | 'unless-false' | 'exactly-true';
  /**
   * 'false': a defined but empty boolean env value reads as false (not as unset), for settings
   * whose runtime treats any defined value as set. Implied by envBoolean 'exactly-true'.
   */
  envEmpty?: 'unset' | 'false';
  /**
   * 'positive': a number env value of 0 or less is ignored, as runtime ignores it.
   * 'in-range': one outside min..max is ignored, as runtime ignores it.
   * 'fraction-in-range': read as a decimal (not cut to its whole part), and ignored outside
   * min..max, for a setting such as a sample rate.
   */
  envNumber?: 'any' | 'positive' | 'in-range' | 'fraction-in-range';
  /** Human-readable label */
  label: string;
  /** Description for admin UI */
  description: string;
  /** Minimum value (for number/duration) */
  min?: number;
  /** Maximum value (for number/duration) */
  max?: number;
  /** Require a safe integer for numeric settings. */
  integer?: boolean;
  /** Require a multiple of this (for a value runtime applies in larger units, such as ms as s). */
  step?: number;
  /** 'strip-trailing-slash': a string env value loses one trailing slash, as runtime reads it. */
  envString?: 'as-is' | 'strip-trailing-slash';
  /** Unit (e.g., "seconds", "ms") */
  unit?: string;
  /** Allowed values (for enum type) */
  enum?: string[];
  /** Whether restart is required for changes to take effect */
  restartRequired?: boolean;
  /** Dependency on other settings */
  dependsOn?: Array<{ key: string; value: unknown }>;
  /**
   * Visibility level
   * - 'public': visible to all users
   * - 'admin': visible to admin users
   * - 'internal': setup-time only, locked in UI
   * - 'page': managed on a dedicated page, hidden from settings list
   */
  visibility?: 'public' | 'admin' | 'internal' | 'page';
  /**
   * Implementation status
   * - 'active': fully implemented (default)
   * - 'in_development': setting is defined but not yet consumed by frontend
   */
  status?: 'active' | 'in_development';
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
  /** What each value would be if this scope set nothing: the parents, then env, then default */
  inherited: {
    values: Record<string, unknown>;
    sources: Record<string, InheritedSettingSource>;
  };
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
  /**
   * 'pending' when the change is saved but not yet copied to the KV that runtime workers read.
   * Until a scheduled retry copies it (within about a minute), runtime keeps the previous values.
   */
  projection?: 'pending';
}

export interface CanonicalSettingsDocument {
  data: Record<string, unknown>;
  version: string;
}

/** Strong source used for platform, tenant and client settings; KV remains a runtime projection. */
export interface SettingsCanonicalStore {
  load(category: string, scope: SettingScope): Promise<CanonicalSettingsDocument | null>;
  create(
    category: string,
    scope: SettingScope,
    document: CanonicalSettingsDocument
  ): Promise<CanonicalSettingsDocument>;
  compareAndSet(
    category: string,
    scope: SettingScope,
    expectedVersion: string,
    document: CanonicalSettingsDocument
  ): Promise<boolean>;
  markProjected(category: string, scope: SettingScope, version: string): Promise<void>;
  /**
   * Ask for this version to be projected again by the scheduled retry. Does nothing when a
   * newer version has been saved since, because that save projects itself.
   */
  markPending(category: string, scope: SettingScope, version: string): Promise<void>;
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
function parseEnvValue(
  value: string | undefined,
  type: SettingMeta['type'],
  parsing: Pick<
    SettingMeta,
    | 'envBoolean'
    | 'envEmpty'
    | 'envNumber'
    | 'step'
    | 'integer'
    | 'envString'
    | 'min'
    | 'max'
    | 'enum'
  > = {}
): unknown {
  const envBoolean = parsing.envBoolean ?? 'true-or-1';
  // Runtime that treats any defined value as set reads a defined but empty boolean as false.
  if (
    value === '' &&
    type === 'boolean' &&
    (envBoolean === 'exactly-true' || parsing.envEmpty === 'false')
  ) {
    return false;
  }
  if (value === undefined || value === '') {
    return undefined;
  }

  switch (type) {
    case 'number':
    case 'duration': {
      const parsed =
        parsing.envNumber === 'fraction-in-range' ? parseFloat(value) : parseInt(value, 10);
      if (!Number.isFinite(parsed)) return undefined;
      if (parsing.envNumber === 'positive' && parsed <= 0) return undefined;
      if (
        (parsing.envNumber === 'in-range' || parsing.envNumber === 'fraction-in-range') &&
        ((parsing.min !== undefined && parsed < parsing.min) ||
          (parsing.max !== undefined && parsed > parsing.max))
      ) {
        return undefined;
      }
      if (parsing.integer && !Number.isSafeInteger(parsed)) return undefined;
      // A value the setting refuses (runtime could not apply it) is not used from env either.
      return parsing.step !== undefined && parsed % parsing.step !== 0 ? undefined : parsed;
    }
    case 'boolean':
      if (envBoolean === 'unless-false') return value.toLowerCase() !== 'false' && value !== '0';
      if (envBoolean === 'exactly-true') return value === 'true';
      return value.toLowerCase() === 'true' || value === '1';
    case 'string':
      return parsing.envString === 'strip-trailing-slash' ? value.replace(/\/$/, '') : value;
    case 'enum':
      // A value the setting does not offer is not used from env (its default applies).
      return !parsing.enum || parsing.enum.includes(value) ? value : undefined;
    case 'json':
      try {
        return JSON.parse(value);
      } catch {
        return undefined;
      }
    default:
      return value;
  }
}

/**
 * Check if a value is the disabled marker
 */
/** Whether a setting can be set at a scope (its own `scopes`, when it narrows its category's). */
function settableAt(meta: SettingMeta, scope: 'platform' | 'tenant' | 'client'): boolean {
  return !meta.scopes || meta.scopes.includes(scope);
}

/** A value stored in one scope's document; the disabled marker reads as false. */
function readLayer(data: Record<string, unknown>, key: string): { value: unknown } | undefined {
  const value = data[key];
  if (value === undefined) return undefined;
  return { value: isDisabled(value) ? false : value };
}

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
      return `settings:client:${validateKVKeyPart(scope.tenantId, 'tenantId')}:${validateKVKeyPart(scope.id, 'clientId')}:${safeCategory}`;
  }
}

export function settingsStorageKey(category: string, scope: SettingScope): string {
  return getKVKey(category, scope);
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
  private canonicalStore: SettingsCanonicalStore | null;
  private legacyKv: KVNamespace | null;
  private readOnly: boolean;

  // In-memory cache for runtime performance
  private cache: Map<string, { data: Record<string, unknown>; expiresAt: number }> = new Map();
  private cacheTTL: number;
  private strictReads: boolean;

  constructor(options: {
    env: Record<string, string | undefined>;
    kv?: KVNamespace | null;
    cacheTTL?: number;
    strictReads?: boolean;
    canonicalStore?: SettingsCanonicalStore | null;
    /**
     * KV holding the tenant settings copy written at tenant creation (AUTHRIM_CONFIG). Read
     * only to bootstrap a tenant's canonical document when the primary KV has none, so a tenant
     * created before settings were written to SETTINGS keeps its values.
     */
    legacyKv?: KVNamespace | null;
    auditCallback?: (event: SettingsAuditEvent) => Promise<void>;
    /**
     * Read without writing anything: a missing canonical document is read from KV (and, for a
     * tenant, the creation-time copy) without creating it, and saves are refused. For previews.
     */
    readOnly?: boolean;
  }) {
    this.env = options.env;
    this.kv = options.kv ?? null;
    this.cacheTTL = options.cacheTTL ?? 5000; // Default 5 seconds
    this.auditCallback = options.auditCallback;
    this.strictReads = options.strictReads ?? false;
    this.canonicalStore = options.canonicalStore ?? null;
    this.legacyKv = options.legacyKv ?? null;
    this.readOnly = options.readOnly ?? false;
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
  async getAll(
    category: string,
    scope: SettingScope,
    options: SettingsReadOptions = {}
  ): Promise<SettingsGetResult> {
    const meta = this.categoryMeta.get(category);
    if (!meta) {
      throw new Error(`Unknown category: ${category}`);
    }

    const parents = options.parents ?? [];
    const [kvData, ...parentData] = await Promise.all([
      this.loadKVData(category, scope),
      ...parents.map((parent) => this.loadKVData(category, parent)),
    ]);
    const layers = inheritedLayers(parents, parentData);

    // Resolve values with priority: this scope > parents (nearest first) > env > default
    const values: Record<string, unknown> = {};
    const sources: Record<string, SettingSource> = {};
    const inherited: SettingsGetResult['inherited'] = { values: {}, sources: {} };

    for (const [key, settingMeta] of Object.entries(meta.settings)) {
      const fallback = this.resolveInherited(key, settingMeta, layers);
      inherited.values[key] = fallback.value;
      inherited.sources[key] = fallback.source;
      const own = settableAt(settingMeta, scope.type) ? readLayer(kvData, key) : undefined;
      values[key] = own ? own.value : fallback.value;
      sources[key] = own ? 'kv' : fallback.source;
    }

    return {
      category,
      scope,
      version: generateVersion(kvData),
      values,
      sources,
      inherited,
    };
  }

  /**
   * Get a single setting value
   */
  async get(key: string, scope: SettingScope, options: SettingsReadOptions = {}): Promise<unknown> {
    const category = this.categoryOfKey(key);
    if (!category) {
      throw new Error(`Unknown setting: ${key}`);
    }
    const result = await this.getAll(category, scope, options);
    return result.values[key];
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
    actor: string,
    options: SettingsPatchOptions = {}
  ): Promise<SettingsPatchResult> {
    const meta = this.categoryMeta.get(category);
    if (!meta) {
      throw new Error(`Unknown category: ${category}`);
    }

    // Platform writeability is enforced by the API layer. The manager only applies
    // scoped patch semantics once the caller has authorized the scope/category pair.

    // Load current KV data directly from KV (skip cache to prevent TOCTOU race conditions)
    // This ensures we always read the latest KV data for version checking
    const kvData = await this.loadKVData(category, scope, true);
    const currentVersion = generateVersion(kvData);
    // Dependencies are checked against effective values, which may come from a parent scope.
    const parents = options.parents ?? [];
    const parentData = await Promise.all(
      parents.map((parent) => this.loadKVData(category, parent))
    );
    const layers = inheritedLayers(parents, parentData);

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

    // Build the document as it would be after this request: sets, then clears, then disables.
    // Dependencies are checked against that document, so a value set, cleared or disabled in
    // the same request counts, and anything this scope does not set is read as inherited.
    const original = { ...kvData };
    const setKeys: string[] = [];

    // A key named by more than one operation has no single outcome; refuse it everywhere.
    const operationCount = new Map<string, number>();
    for (const key of [
      ...new Set(Object.keys(request.set ?? {})),
      ...new Set(request.clear ?? []),
      ...new Set(request.disable ?? []),
    ]) {
      operationCount.set(key, (operationCount.get(key) ?? 0) + 1);
    }
    for (const [key, count] of operationCount) {
      if (count > 1) rejected[key] = 'Conflicting operations for the same key';
      const keyMeta = meta.settings[key];
      if (keyMeta && !settableAt(keyMeta, scope.type) && !(key in rejected)) {
        rejected[key] = `Not settable at ${scope.type} scope`;
      }
    }

    if (request.set) {
      for (const [key, value] of Object.entries(request.set)) {
        if (key in rejected) continue;
        const settingMeta = meta.settings[key];
        if (!settingMeta) {
          rejected[key] = 'Unknown setting key';
          continue;
        }
        // KV values take priority over env values (per CLAUDE.md policy), so KV writes are
        // allowed even when env is set.
        const validation = this.validateSingleValue(key, value, settingMeta);
        if (!validation.valid) {
          rejected[key] = validation.errors[0]?.reason ?? 'Validation failed';
          continue;
        }
        kvData[key] = value;
        setKeys.push(key);
      }
    }

    if (request.clear) {
      for (const key of request.clear) {
        if (key in rejected) continue;
        if (!meta.settings[key]) {
          rejected[key] = 'Unknown setting key';
          continue;
        }
        // Clearing KV lets the inherited value (parents, env, default) take effect.
        if (key in kvData) {
          delete kvData[key];
          if (key in original) cleared.push(key);
        }
      }
    }

    if (request.disable) {
      for (const key of request.disable) {
        if (key in rejected) continue;
        const settingMeta = meta.settings[key];
        if (!settingMeta) {
          rejected[key] = 'Unknown setting key';
          continue;
        }
        // Only boolean settings can be disabled; the marker takes precedence over env.
        if (settingMeta.type !== 'boolean') {
          rejected[key] = 'Only boolean settings can be disabled';
          continue;
        }
        kvData[key] = DISABLED_MARKER;
        disabled.push(key);
      }
    }

    // Refuse sets whose dependencies the resulting document does not meet. Refusing one can
    // break another's dependency, so repeat until nothing more is refused.
    let changed = options.skipDependencyCheck !== true;
    while (changed) {
      changed = false;
      for (const key of setKeys) {
        if (key in rejected) continue;
        const depCheck = this.checkDependencies(
          meta.settings[key],
          meta,
          kvData,
          layers,
          scope.type
        );
        if (depCheck.valid) continue;
        rejected[key] = depCheck.reason;
        if (key in original) kvData[key] = original[key];
        else delete kvData[key];
        changed = true;
      }
    }

    for (const key of setKeys) {
      if (key in rejected) continue;
      applied.push(key);
      diff[key] = { before: original[key], after: request.set?.[key] };
    }
    for (const key of cleared) {
      // After clearing, the scope takes what it inherits (a parent, env or the default).
      diff[key] = {
        before: original[key],
        after: this.resolveInherited(key, meta.settings[key], layers).value,
      };
    }
    for (const key of disabled) {
      diff[key] = { before: original[key], after: DISABLED_MARKER };
    }

    // Save if anything changed
    const hasChanges = applied.length > 0 || cleared.length > 0 || disabled.length > 0;
    let projection: 'applied' | 'pending' = 'applied';
    if (hasChanges) {
      projection = await this.saveKVData(category, scope, kvData, currentVersion);

      // Invalidate cache
      this.invalidateCache(category, scope);

      // Emit audit event
      if (this.auditCallback && Object.keys(diff).length > 0) {
        const scopeId = scope.type === 'platform' ? 'platform' : scope.id;
        await this.auditCallback({
          event: 'settings.updated',
          scope: scope.type,
          scopeId,
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
      ...(projection === 'pending' ? { projection } : {}),
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
  async getRuntimeView(
    category: string,
    scope: SettingScope,
    options: SettingsReadOptions = {}
  ): Promise<Record<string, unknown>> {
    // loadKVData serves each scope's document from the short-lived cache.
    const result = await this.getAll(category, scope, options);
    return result.values;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Load KV data for a category and scope
   * @param skipCache - If true, bypass cache and read directly from KV (used for patch operations)
   */
  private async loadKVData(
    category: string,
    scope: SettingScope,
    skipCache = false
  ): Promise<Record<string, unknown>> {
    if (!this.kv && !this.canonicalStore) {
      return {};
    }

    const cacheKey = getKVKey(category, scope);

    // Check cache unless explicitly skipped (for TOCTOU safety in patch operations)
    if (!skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
      }
    }

    try {
      const key = getKVKey(category, scope);
      if (this.canonicalStore) {
        const canonical = await this.canonicalStore.load(category, scope);
        if (canonical) {
          if (generateVersion(canonical.data) !== canonical.version)
            throw new Error('settings_canonical_version_invalid');
          this.cache.set(cacheKey, {
            data: canonical.data,
            expiresAt: Date.now() + this.cacheTTL,
          });
          return canonical.data;
        }
      }
      let json = this.kv ? await this.kv.get(key) : null;
      // Bootstrapping a tenant document with nothing in the primary KV: take the creation-time
      // copy instead of starting empty. It is left pending so it gets projected to the primary KV.
      let fromLegacy = false;
      if (json === null && this.canonicalStore && scope.type === 'tenant' && this.legacyKv) {
        json = await this.legacyKv.get(key);
        fromLegacy = json !== null;
      }

      // Parse and validate KV data
      let data: Record<string, unknown> = {};
      // Only a missing key is an empty document: a stored empty string is unreadable data.
      if (json !== null) {
        const parsed: unknown = JSON.parse(json) as unknown;
        // Validate parsed data is a plain object (not null, not array)
        // and sanitize to prevent prototype pollution
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          data = sanitizeObject(parsed);
        } else {
          if (this.strictReads) throw new Error('settings_data_invalid');
          log.warn(
            `Invalid KV data format for ${key}: expected object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
          );
        }
      }

      // A read-only manager (previews) never creates the canonical document from KV.
      if (this.canonicalStore && !this.readOnly) {
        const sourceVersion = generateVersion(data);
        const created = await this.canonicalStore.create(category, scope, {
          data,
          version: sourceVersion,
        });
        if (generateVersion(created.data) !== created.version)
          throw new Error('settings_canonical_version_invalid');
        if (json !== null && !fromLegacy && created.version === sourceVersion)
          await this.canonicalStore.markProjected(category, scope, created.version);
        data = created.data;
      }

      // Update cache
      this.cache.set(cacheKey, {
        data,
        expiresAt: Date.now() + this.cacheTTL,
      });

      return data;
    } catch {
      log.warn('Failed to load settings from KV');
      if (this.strictReads || this.canonicalStore) throw new Error('settings_read_failed');
      return {};
    }
  }

  /**
   * Save KV data for a category and scope
   */
  private async saveKVData(
    category: string,
    scope: SettingScope,
    data: Record<string, unknown>,
    expectedVersion: string
  ): Promise<'applied' | 'pending'> {
    const key = getKVKey(category, scope);
    const version = generateVersion(data);
    if (this.readOnly) throw new Error('Settings manager is read-only');
    if (this.canonicalStore) {
      if (
        !(await this.canonicalStore.compareAndSet(category, scope, expectedVersion, {
          data,
          version,
        }))
      ) {
        const latest = await this.canonicalStore.load(category, scope);
        throw new ConflictError('Settings were updated by someone else. Please refresh.', {
          currentVersion: latest?.version ?? expectedVersion,
        });
      }
      return this.projectLatest(category, scope, key);
    }
    if (!this.kv) throw new Error('KV not configured');
    await this.kv.put(key, JSON.stringify(data));
    return 'applied';
  }

  private async projectLatest(
    category: string,
    scope: SettingScope,
    key: string
  ): Promise<'applied' | 'pending'> {
    if (!this.canonicalStore || !this.kv) {
      log.warn('Settings saved; KV projection remains pending');
      return 'pending';
    }
    return projectLatestSettingsDocument(this.canonicalStore, this.kv, category, scope, key);
  }

  /**
   * Invalidate cache for a category and scope
   */
  private invalidateCache(category: string, scope: SettingScope): void {
    const cacheKey = getKVKey(category, scope);
    this.cache.delete(cacheKey);
  }

  /**
   * Resolve the value a scope inherits: the parents (nearest first), then env, then default
   * (per CLAUDE.md: Priority: Cache → KV → Environment variables → Default values).
   * A value set in KV overrides environment variables without redeployment.
   */
  private resolveInherited(
    key: string,
    meta: SettingMeta,
    layers: InheritedLayer[]
  ): { value: unknown; source: InheritedSettingSource } {
    for (const layer of layers) {
      // A parent is consulted only where that scope may set the setting.
      if (!settableAt(meta, layer.source === 'tenant' ? 'tenant' : 'platform')) continue;
      const found = readLayer(layer.data, key);
      if (found) return { value: found.value, source: layer.source };
    }

    if (meta.envKey) {
      const envValue = parseEnvValue(this.env[meta.envKey], meta.type, meta);
      if (envValue !== undefined) {
        return { value: envValue, source: 'env' };
      }
    }

    return { value: meta.default, source: 'default' };
  }

  /** The registered category that defines a key (key prefixes do not always match the category). */
  private categoryOfKey(key: string): string | undefined {
    for (const [category, meta] of this.categoryMeta) {
      if (key in meta.settings) return category;
    }
    return undefined;
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
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          errors.push({ key, reason: `Expected number, got ${typeof value}` });
        } else {
          if (meta.integer && !Number.isSafeInteger(value)) {
            errors.push({ key, reason: 'Value must be a safe integer' });
          }
          if (meta.step !== undefined && value % meta.step !== 0) {
            errors.push({ key, reason: `Value must be a multiple of ${meta.step}` });
          }
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

      case 'json':
        if (typeof value === 'string') {
          try {
            JSON.parse(value);
          } catch {
            errors.push({ key, reason: 'Expected valid JSON string' });
          }
        } else {
          try {
            JSON.stringify(value);
          } catch {
            errors.push({ key, reason: 'Expected JSON-serializable value' });
          }
        }
        break;
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Check setting dependencies against effective values: the value in the candidate document
   * (this scope after the request), else what the scope inherits (parents, env, default).
   * A dependency set to the disabled marker reads as disabled.
   */
  private checkDependencies(
    meta: SettingMeta,
    categoryMeta: CategoryMeta,
    candidate: Record<string, unknown>,
    layers: InheritedLayer[],
    scopeType: SettingScope['type']
  ): { valid: boolean; reason: string } {
    if (!meta.dependsOn || meta.dependsOn.length === 0) {
      return { valid: true, reason: '' };
    }

    for (const dep of meta.dependsOn) {
      const depMeta = categoryMeta.settings[dep.key];
      const raw =
        dep.key in candidate && (!depMeta || settableAt(depMeta, scopeType))
          ? candidate[dep.key]
          : depMeta
            ? this.effectiveInheritedRaw(dep.key, depMeta, layers)
            : undefined;

      if (isDisabled(raw)) {
        return {
          valid: false,
          reason: `Depends on ${dep.key} which is currently disabled`,
        };
      }

      if (raw !== dep.value) {
        return {
          valid: false,
          reason: `Depends on ${dep.key} = ${JSON.stringify(dep.value)}`,
        };
      }
    }

    return { valid: true, reason: '' };
  }

  /** The inherited value of a key, keeping a parent's disabled marker so it can be reported. */
  private effectiveInheritedRaw(key: string, meta: SettingMeta, layers: InheritedLayer[]): unknown {
    for (const layer of layers) {
      if (!settableAt(meta, layer.source === 'tenant' ? 'tenant' : 'platform')) continue;
      if (layer.data[key] !== undefined) return layer.data[key];
    }
    return this.resolveInherited(key, meta, []).value;
  }
}

/**
 * Copy the latest canonical settings document to the KV that runtime workers read. Used right
 * after a save and by the scheduled retry of pending projections.
 *
 * Always the latest, never a document the caller holds: another save may have landed in
 * between, and writing an older document after it would leave KV behind the canonical copy
 * while that copy is already marked as projected. After writing, the canonical version is read
 * again; if it moved, the newer document is written instead, so whichever projection finishes
 * last leaves KV at the latest version. If that does not settle within a few attempts, or KV
 * keeps failing, the latest version seen is marked pending again for the scheduled retry.
 *
 * KV has no conditional write, so a slow write of an older document can still land after a
 * newer one was projected and marked, and a failed read can hide that. The scheduled retry
 * therefore also compares recently projected documents with KV and repairs any that differ
 * (`processPendingSettingsProjections`).
 */
export async function projectLatestSettingsDocument(
  store: SettingsCanonicalStore,
  kv: KVNamespace,
  category: string,
  scope: SettingScope,
  key: string,
  attempts = 3
): Promise<'applied' | 'pending'> {
  let lastSeen: string | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Any failure (reading the canonical copy, writing KV, marking) counts as this attempt
    // failing: the save itself has already succeeded and must not be reported as an error.
    try {
      const latest = await store.load(category, scope);
      if (!latest) return 'applied';
      lastSeen = latest.version;
      await kv.put(key, JSON.stringify(latest.data));
      const after = await store.load(category, scope);
      if (after) lastSeen = after.version;
      if (after?.version !== latest.version) continue;
      // Throws when a newer save landed between the check and the mark; project that one.
      await store.markProjected(category, scope, latest.version);
      return 'applied';
    } catch {
      continue;
    }
  }
  log.warn('Settings saved; KV projection remains pending');
  if (lastSeen) {
    try {
      await store.markPending(category, scope, lastSeen);
    } catch {
      log.warn('Settings projection could not be marked pending');
    }
  }
  return 'pending';
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
export function createSettingsManager(
  options: ConstructorParameters<typeof SettingsManager>[0]
): SettingsManager {
  return new SettingsManager(options);
}
