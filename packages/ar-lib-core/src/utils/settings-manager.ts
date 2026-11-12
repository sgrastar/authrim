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
import {
  SETTING_LOCKS_FIELD,
  LOCKED_BY_PLATFORM,
  readSettingLocks,
  withoutSettingLocks,
  isLockedByPlatformReason,
} from './setting-locks';
import {
  identityMappingLevelHistoryChoicesEqual,
  normalizeIdentityMappingLevelHistoryChoice,
  type IdentityMappingLevelHistoryInput,
  type IdentityMappingLevelHistoryMetadata,
} from '../services/identity-mapping-level-history';

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
  /**
   * Decide what the request would apply, clear, disable and reject (version conflict included)
   * without saving, auditing or invalidating anything. A caller that must act before a change
   * is saved uses it to act only on a change that will be accepted.
   */
  dryRun?: boolean;
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

export {
  SETTING_LOCKS_FIELD,
  LOCKED_BY_PLATFORM,
  readSettingLocks,
  withoutSettingLocks,
  isLockedByPlatformReason,
};

/** The listed keys that are lockable settings of the category: the locks that are enforced. */
function enforcedLocks(
  meta: CategoryMeta,
  document: Record<string, unknown> | undefined
): string[] {
  return readSettingLocks(document).filter(
    (key) => meta.settings[key]?.lockable === true && settableAt(meta.settings[key], 'tenant')
  );
}

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
   * True when the platform may lock this setting (`lock` in a platform PATCH), so that tenants and
   * clients cannot change it and a value they stored is ignored. Mark a setting only when every
   * runtime read of it honours the lock; a lock on any other setting is refused.
   */
  lockable?: boolean;
  /**
   * How a boolean environment variable reads. 'true-or-1' (default): only `true` or `1` is true.
   * 'unless-false': anything but `false` or `0` is true, as the older oauth-config read it.
   * 'exactly-true': only the exact string `true` is true, as the older system settings read it.
   * 'unless-exactly-false': anything but the exact string `false` is true, for a protection that
   * only an explicit `false` turns off.
   */
  envBoolean?: 'true-or-1' | 'unless-false' | 'exactly-true' | 'unless-exactly-false';
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
  envNumber?: 'any' | 'positive' | 'in-range' | 'fraction-in-range' | 'strict-in-range';
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
  /**
   * True when a newer setting replaces this one. A deprecated setting is still accepted on write
   * (older clients keep working) but runtime no longer reads it, or reads it only as a fallback
   * for the setting that replaced it.
   */
  deprecated?: boolean;
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
  /**
   * The settings the platform has locked (sorted). At a tenant or client scope their values come
   * from the platform onward; at the platform scope this is the list the platform edits.
   */
  locked: string[];
  /**
   * The locked settings (a subset of `locked`) for which this scope still stores a value of its
   * own, sorted. The value is set aside, not used: `sources` says where the applied value comes
   * from, so this is how to tell that a stored value exists (a `clear` removes it). Always empty
   * at the platform scope.
   */
  setAside: string[];
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
  /** Platform scope only: lockable keys to lock, so tenants and clients cannot change them. */
  lock?: string[];
  /** Platform scope only: keys to unlock. */
  unlock?: string[];
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
  /** Keys newly locked (only when the request asked to lock or unlock). */
  locked?: string[];
  /** Keys newly unlocked (only when the request asked to lock or unlock). */
  unlocked?: string[];
  /**
   * 'pending' when the change is saved but not yet copied to the KV that runtime workers read.
   * Until a scheduled retry copies it (within about a minute), runtime keeps the previous values.
   */
  projection?: 'pending';
  /**
   * Only on a dry run: the scope's own document (what is saved, not the inherited values) before
   * the request and as the request would leave it, after the keys it rejects are left out. A caller
   * that must judge the result before it is saved (a guard) reads this, not the KV projection, so
   * it sees the same document the save would act on.
   */
  candidate?: {
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  };
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
    document: CanonicalSettingsDocument,
    history?: IdentityMappingLevelHistoryInput
  ): Promise<boolean>;
  /**
   * Save several documents at once, each only if still at its version: all of them or none
   * (false). Optional: a store without it cannot save a change across categories.
   */
  compareAndSetMany?(
    writes: ReadonlyArray<{
      category: string;
      scope: SettingScope;
      expectedVersion: string;
      document: CanonicalSettingsDocument;
    }>
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
      // 'strict-in-range': the whole value must be a number ('600junk' and '1800.9' are not 600
      // and 1800); it is then checked like 'in-range' (and as an integer where required).
      const parsed =
        parsing.envNumber === 'fraction-in-range'
          ? parseFloat(value)
          : parsing.envNumber === 'strict-in-range'
            ? /^\s*-?\d+(?:\.\d+)?\s*$/.test(value)
              ? Number(value)
              : NaN
            : parseInt(value, 10);
      if (!Number.isFinite(parsed)) return undefined;
      if (parsing.envNumber === 'positive' && parsed <= 0) return undefined;
      if (
        (parsing.envNumber === 'in-range' ||
          parsing.envNumber === 'fraction-in-range' ||
          parsing.envNumber === 'strict-in-range') &&
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
      if (envBoolean === 'unless-exactly-false') return value !== 'false';
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
 * A setting's value from its environment variable, parsed as the settings resolution parses it
 * (undefined when unset or refused). For a caller that falls back to the environment when the
 * stored settings cannot be read.
 */
export function readSettingEnvValue(
  env: Partial<Record<string, unknown>>,
  meta: SettingMeta
): unknown {
  if (!meta.envKey) return undefined;
  const raw = env[meta.envKey];
  return parseEnvValue(typeof raw === 'string' ? raw : undefined, meta.type, meta);
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
 * Validate one value against its setting metadata (type, range, enum): the check every settings
 * write applies per key. Exported so that other writers of setting values (saved Login UI
 * themes) validate exactly as a PATCH does.
 */
export function validateSettingValue(
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
  private identityMappingHistory?: IdentityMappingLevelHistoryMetadata;

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
    /** Required actor/provenance for the tenant Mapping Set choice's atomic history. */
    identityMappingHistory?: IdentityMappingLevelHistoryMetadata;
  }) {
    this.env = options.env;
    this.kv = options.kv ?? null;
    this.cacheTTL = options.cacheTTL ?? 5000; // Default 5 seconds
    this.auditCallback = options.auditCallback;
    this.strictReads = options.strictReads ?? false;
    this.canonicalStore = options.canonicalStore ?? null;
    this.legacyKv = options.legacyKv ?? null;
    this.readOnly = options.readOnly ?? false;
    this.identityMappingHistory = options.identityMappingHistory;
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
      ...parents.map((parent) => this.loadParent(meta, category, scope, parent)),
    ]);
    const layers = inheritedLayers(parents, parentData);
    // A locked setting resolves from the platform onward: the tenant's and the client's own
    // values are set aside (kept in their documents, applying again when unlocked).
    const { locked, lockLayers } = await this.locksFor(meta, category, scope, kvData, layers);

    // Resolve values with priority: this scope > parents (nearest first) > env > default
    const values: Record<string, unknown> = {};
    const sources: Record<string, SettingSource> = {};
    const inherited: SettingsGetResult['inherited'] = { values: {}, sources: {} };
    const setAside: string[] = [];

    for (const [key, settingMeta] of Object.entries(meta.settings)) {
      const isLocked = scope.type !== 'platform' && locked.has(key);
      const fallback = this.resolveInherited(
        key,
        settingMeta,
        layers,
        isLocked ? lockLayers : undefined
      );
      inherited.values[key] = fallback.value;
      inherited.sources[key] = fallback.source;
      const stored = settableAt(settingMeta, scope.type) ? readLayer(kvData, key) : undefined;
      if (isLocked && stored) setAside.push(key);
      const own = isLocked ? undefined : stored;
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
      locked: [...locked].sort(),
      setAside: setAside.sort(),
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

  /** What a PATCH would do to one document (nothing saved); throws on a version conflict. */
  private async decide(
    category: string,
    scope: SettingScope,
    request: SettingsPatchRequest,
    options: SettingsPatchOptions
  ) {
    const meta = this.categoryMeta.get(category);
    if (!meta) {
      throw new Error(`Unknown category: ${category}`);
    }

    // Platform writeability is enforced by the API layer. The manager only applies
    // scoped patch semantics once the caller has authorized the scope/category pair.

    // Load current KV data directly from KV (skip cache to prevent TOCTOU race conditions)
    // This ensures we always read the latest KV data for version checking
    // The loaded document is also what the cache holds: change a copy, never the cached object
    // (a dry run, or a request that ends up saving nothing, must leave no candidate behind).
    const kvData = structuredClone(await this.loadKVData(category, scope, true));
    const currentVersion = generateVersion(kvData);
    // Dependencies are checked against effective values, which may come from a parent scope.
    const parents = options.parents ?? [];
    const parentData = await Promise.all(
      parents.map((parent) => this.loadParent(meta, category, scope, parent, true))
    );
    const layers = inheritedLayers(parents, parentData);
    const { locked, lockLayers } = await this.locksFor(meta, category, scope, kvData, layers, true);

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
    const lockedNow: string[] = [];
    const unlockedNow: string[] = [];

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
      // The platform's lock: a tenant or client cannot set or disable a locked setting (it may
      // still clear a value of its own, which is set aside anyway).
      if (
        scope.type !== 'platform' &&
        locked.has(key) &&
        !(key in rejected) &&
        (Object.prototype.hasOwnProperty.call(request.set ?? {}, key) ||
          (request.disable ?? []).includes(key))
      ) {
        rejected[key] = `${LOCKED_BY_PLATFORM}: This setting is locked by the platform`;
      }
    }

    this.decideLocks(meta, scope, request, kvData, rejected, lockedNow, unlockedNow);

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
          scope.type,
          locked,
          lockLayers
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
        after: this.resolveInherited(
          key,
          meta.settings[key],
          layers,
          scope.type !== 'platform' && locked.has(key) ? lockLayers : undefined
        ).value,
      };
    }
    for (const key of disabled) {
      diff[key] = { before: original[key], after: DISABLED_MARKER };
    }
    for (const key of lockedNow) diff[`${LOCK_DIFF_PREFIX}${key}`] = { before: false, after: true };
    for (const key of unlockedNow)
      diff[`${LOCK_DIFF_PREFIX}${key}`] = { before: true, after: false };

    return {
      meta,
      kvData,
      original,
      currentVersion,
      applied,
      cleared,
      disabled,
      rejected,
      diff,
      lockedNow,
      unlockedNow,
    };
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
    const {
      kvData,
      original,
      currentVersion,
      applied,
      cleared,
      disabled,
      rejected,
      diff,
      lockedNow,
      unlockedNow,
    } = await this.decide(category, scope, request, options);
    const lockFields = lockResultFields(request, lockedNow, unlockedNow);

    if (options.dryRun) {
      return {
        version: currentVersion,
        applied,
        cleared,
        disabled,
        rejected,
        ...lockFields,
        candidate: { before: original, after: { ...kvData } },
      };
    }

    // Save if anything changed
    const hasChanges =
      applied.length > 0 ||
      cleared.length > 0 ||
      disabled.length > 0 ||
      lockedNow.length > 0 ||
      unlockedNow.length > 0;
    let projection: 'applied' | 'pending' = 'applied';
    if (hasChanges) {
      const key = 'identity_mapping.oidc_default_set_id';
      const recordsChoice =
        category === 'identity-mapping' &&
        scope.type === 'tenant' &&
        this.identityMappingHistory &&
        !identityMappingLevelHistoryChoicesEqual('tenant_default', original[key], kvData[key]);
      const history: IdentityMappingLevelHistoryInput | undefined =
        recordsChoice && scope.type === 'tenant' && this.identityMappingHistory
          ? {
              ...this.identityMappingHistory,
              id: crypto.randomUUID(),
              tenantId: scope.id,
              tier: 'tenant_default',
              before: normalizeIdentityMappingLevelHistoryChoice('tenant_default', original[key]),
              after: normalizeIdentityMappingLevelHistoryChoice('tenant_default', kvData[key]),
              sourceVersion: generateVersion(kvData),
            }
          : undefined;
      projection = await this.saveKVData(category, scope, kvData, currentVersion, history);

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
      ...lockFields,
      ...(projection === 'pending' ? { projection } : {}),
    };
  }

  /**
   * PATCHes of several categories of one scope, saved together: all of them or none. Each is
   * decided as `patch` decides it (its `ifMatch` checked, what it rejects left out); the
   * documents that change are then saved in one step of the canonical store, so a conflict on
   * any of them saves none (ConflictError). Needs a canonical store that can do that.
   */
  async patchMany(
    scope: SettingScope,
    changes: ReadonlyArray<{
      category: string;
      request: SettingsPatchRequest;
      options?: Omit<SettingsPatchOptions, 'dryRun'>;
    }>,
    actor: string
  ): Promise<SettingsPatchResult[]> {
    if (this.readOnly) throw new Error('Settings manager is read-only');
    const store = this.canonicalStore;
    if (!store?.compareAndSetMany) throw new Error('settings_atomic_save_unavailable');
    if (new Set(changes.map((change) => change.category)).size !== changes.length)
      throw new Error('settings_atomic_save_duplicate_category');
    // The identity mapping choice keeps a history row with its save: one category at a time.
    if (changes.some((change) => change.category === 'identity-mapping'))
      throw new Error('settings_atomic_save_unsupported_category');
    const decided = [];
    for (const change of changes)
      decided.push({
        category: change.category,
        ...(await this.decide(change.category, scope, change.request, change.options ?? {})),
      });
    const changed = decided.filter(
      (item) =>
        item.applied.length > 0 ||
        item.cleared.length > 0 ||
        item.disabled.length > 0 ||
        item.lockedNow.length > 0 ||
        item.unlockedNow.length > 0
    );
    if (changed.length > 0) {
      const saved = await store.compareAndSetMany(
        changed.map((item) => ({
          category: item.category,
          scope,
          expectedVersion: item.currentVersion,
          document: { data: item.kvData, version: generateVersion(item.kvData) },
        }))
      );
      if (!saved) {
        // Name the version of the first document another save changed meanwhile.
        for (const item of changed) {
          const latest = await store.load(item.category, scope);
          if (latest?.version !== item.currentVersion)
            throw new ConflictError('Settings were updated by someone else. Please refresh.', {
              currentVersion: latest?.version ?? item.currentVersion,
            });
        }
        throw new ConflictError('Settings were updated by someone else. Please refresh.', {
          currentVersion: changed[0].currentVersion,
        });
      }
    }
    const projections = new Map<string, 'applied' | 'pending'>();
    for (const item of changed) {
      projections.set(
        item.category,
        await this.projectLatest(item.category, scope, getKVKey(item.category, scope))
      );
      this.invalidateCache(item.category, scope);
      if (this.auditCallback && Object.keys(item.diff).length > 0) {
        await this.auditCallback({
          event: 'settings.updated',
          scope: scope.type,
          scopeId: scope.type === 'platform' ? 'platform' : scope.id,
          category: item.category,
          diff: item.diff,
          actor,
          timestamp: new Date().toISOString(),
        });
      }
    }
    return decided.map((item, index) => ({
      version: generateVersion(item.kvData),
      applied: item.applied,
      cleared: item.cleared,
      disabled: item.disabled,
      rejected: item.rejected,
      ...lockResultFields(changes[index].request, item.lockedNow, item.unlockedNow),
      ...(projections.get(item.category) === 'pending' ? { projection: 'pending' as const } : {}),
    }));
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
    skipCache = false,
    /**
     * The document decides a platform lock: a failure to read it throws, whatever `strictReads`
     * says, because an unreadable document read as empty would lift the lock.
     */
    failClosed = false
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
      // A binding that answers undefined for a missing key reads the same as one that answers null.
      let json = this.kv ? ((await this.kv.get(key)) ?? null) : null;
      // Bootstrapping a tenant document with nothing in the primary KV: take the creation-time
      // copy instead of starting empty. It is left pending so it gets projected to the primary KV.
      let fromLegacy = false;
      if (json === null && this.canonicalStore && scope.type === 'tenant' && this.legacyKv) {
        json = await this.legacyKv.get(key);
        fromLegacy = json !== null;
      }

      // Parse and validate KV data
      let data: Record<string, unknown> = {};
      // A tolerated unreadable document reads as empty for this call only: it is never cached
      // (a fail-closed read of the same key must not be served `{}`) nor made canonical.
      let degraded = false;
      // Only a missing key is an empty document: a stored empty string is unreadable data.
      if (json !== null) {
        const parsed: unknown = JSON.parse(json) as unknown;
        // Validate parsed data is a plain object (not null, not array)
        // and sanitize to prevent prototype pollution
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          data = sanitizeObject(parsed);
        } else {
          if (this.strictReads || failClosed) throw new Error('settings_data_invalid');
          log.warn(
            `Invalid KV data format for ${key}: expected object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
          );
          degraded = true;
        }
      }
      if (degraded) return data;

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
      if (this.strictReads || this.canonicalStore || failClosed) {
        throw new Error('settings_read_failed');
      }
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
    expectedVersion: string,
    history?: IdentityMappingLevelHistoryInput
  ): Promise<'applied' | 'pending'> {
    const key = getKVKey(category, scope);
    const version = generateVersion(data);
    if (this.readOnly) throw new Error('Settings manager is read-only');
    if (this.canonicalStore) {
      if (
        !(await this.canonicalStore.compareAndSet(
          category,
          scope,
          expectedVersion,
          {
            data,
            version,
          },
          history
        ))
      ) {
        const latest = await this.canonicalStore.load(category, scope);
        throw new ConflictError('Settings were updated by someone else. Please refresh.', {
          currentVersion: latest?.version ?? expectedVersion,
        });
      }
      return this.projectLatest(category, scope, key);
    }
    if (history) throw new Error('identity_mapping_history_canonical_required');
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
    layers: InheritedLayer[],
    /** A locked setting: only the platform layer is consulted (not a tenant under a client). */
    lockLayers?: InheritedLayer[]
  ): { value: unknown; source: InheritedSettingSource } {
    for (const layer of lockLayers ?? layers) {
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
    return validateSettingValue(key, value, meta);
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
    scopeType: SettingScope['type'],
    locked: ReadonlySet<string> = new Set(),
    lockLayers: InheritedLayer[] = []
  ): { valid: boolean; reason: string } {
    if (!meta.dependsOn || meta.dependsOn.length === 0) {
      return { valid: true, reason: '' };
    }

    for (const dep of meta.dependsOn) {
      const depMeta = categoryMeta.settings[dep.key];
      // A locked dependency is the platform's, not the stored value of this scope.
      const dependencyLocked = scopeType !== 'platform' && locked.has(dep.key);
      const raw =
        dep.key in candidate && !dependencyLocked && (!depMeta || settableAt(depMeta, scopeType))
          ? candidate[dep.key]
          : depMeta
            ? this.effectiveInheritedRaw(
                dep.key,
                depMeta,
                layers,
                dependencyLocked ? lockLayers : undefined
              )
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
  private effectiveInheritedRaw(
    key: string,
    meta: SettingMeta,
    layers: InheritedLayer[],
    lockLayers?: InheritedLayer[]
  ): unknown {
    for (const layer of lockLayers ?? layers) {
      if (!settableAt(meta, layer.source === 'tenant' ? 'tenant' : 'platform')) continue;
      if (layer.data[key] !== undefined) return layer.data[key];
    }
    return this.resolveInherited(key, meta, []).value;
  }

  /**
   * A parent's document. At a tenant or client scope, the platform document of a category with a
   * lockable setting carries the locks, so it is read fail-closed (see `loadKVData`).
   */
  private loadParent(
    meta: CategoryMeta,
    category: string,
    scope: SettingScope,
    parent: SettingScope,
    /** A write: the lock-bearing document is read as fresh as the one being patched. */
    fresh = false
  ): Promise<Record<string, unknown>> {
    const carriesLocks =
      scope.type !== 'platform' &&
      parent.type === 'platform' &&
      Object.values(meta.settings).some((setting) => setting.lockable === true);
    return this.loadKVData(category, parent, fresh && carriesLocks, carriesLocks);
  }

  /**
   * The enforced locks for a read or write at a scope, from the platform document (the scope's
   * own at the platform scope). Independent of the `parents` the caller passed: at a tenant or
   * client scope, a category with a lockable setting loads the platform document itself when the
   * caller did not pass it (categories without one pay no extra read). `lockLayers` is the layer
   * a locked setting resolves from.
   */
  private async locksFor(
    meta: CategoryMeta,
    category: string,
    scope: SettingScope,
    own: Record<string, unknown>,
    layers: InheritedLayer[],
    fresh = false
  ): Promise<{ locked: Set<string>; lockLayers: InheritedLayer[] }> {
    if (scope.type === 'platform') {
      return { locked: new Set(enforcedLocks(meta, own)), lockLayers: [] };
    }
    let layer = layers.find((candidate) => candidate.source === 'platform');
    if (!layer && Object.values(meta.settings).some((setting) => setting.lockable === true)) {
      layer = {
        source: 'platform',
        data: await this.loadKVData(category, { type: 'platform' }, fresh, true),
      };
    }
    return {
      locked: new Set(enforcedLocks(meta, layer?.data)),
      lockLayers: layer ? [layer] : [],
    };
  }

  /** Apply `lock` and `unlock` of a platform PATCH to the candidate document. */
  private decideLocks(
    meta: CategoryMeta,
    scope: SettingScope,
    request: SettingsPatchRequest,
    kvData: Record<string, unknown>,
    rejected: Record<string, string>,
    lockedNow: string[],
    unlockedNow: string[]
  ): void {
    const toLock = [...new Set(request.lock ?? [])];
    const toUnlock = [...new Set(request.unlock ?? [])];
    if (toLock.length === 0 && toUnlock.length === 0) return;
    if (scope.type !== 'platform') {
      for (const key of [...toLock, ...toUnlock])
        rejected[key] = 'Locks can only be changed at platform scope';
      return;
    }
    const current = new Set(readSettingLocks(kvData));
    const next = new Set(current);
    for (const key of toLock) {
      if (key in rejected) continue;
      if (toUnlock.includes(key)) {
        rejected[key] = 'Conflicting operations for the same key';
        continue;
      }
      const keyMeta = meta.settings[key];
      if (!keyMeta) {
        rejected[key] = 'Unknown setting key';
      } else if (keyMeta.lockable !== true || !settableAt(keyMeta, 'tenant')) {
        rejected[key] = 'Setting cannot be locked';
      } else if (!current.has(key)) {
        next.add(key);
        lockedNow.push(key);
      }
    }
    for (const key of toUnlock) {
      if (key in rejected) continue;
      // An entry for a setting that no longer exists or is no longer lockable can still be removed.
      if (current.has(key)) {
        next.delete(key);
        unlockedNow.push(key);
      } else if (!meta.settings[key]) {
        rejected[key] = 'Unknown setting key';
      }
    }
    if (lockedNow.length === 0 && unlockedNow.length === 0) return;
    if (next.size > 0) kvData[SETTING_LOCKS_FIELD] = [...next].sort();
    else delete kvData[SETTING_LOCKS_FIELD];
  }
}

const LOCK_DIFF_PREFIX = 'locked:';

/** `locked` / `unlocked` of a PATCH result, present only when the request asked for locks. */
function lockResultFields(
  request: SettingsPatchRequest,
  lockedNow: string[],
  unlockedNow: string[]
): { locked?: string[]; unlocked?: string[] } {
  return (request.lock?.length ?? 0) + (request.unlock?.length ?? 0) > 0
    ? { locked: lockedNow, unlocked: unlockedNow }
    : {};
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
 *
 * A document deleted while it was being written (a discarded tenant restore removes its
 * documents and their keys) is no longer listed for any retry, so the write is undone here.
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
  let written = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Any failure (reading the canonical copy, writing KV, marking) counts as this attempt
    // failing: the save itself has already succeeded and must not be reported as an error.
    try {
      const latest = await store.load(category, scope);
      if (!latest) {
        if (written) await kv.delete(key);
        return 'applied';
      }
      lastSeen = latest.version;
      written = true;
      await kv.put(key, JSON.stringify(latest.data));
      const after = await store.load(category, scope);
      if (!after) {
        await kv.delete(key);
        return 'applied';
      }
      lastSeen = after.version;
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
