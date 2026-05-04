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
/**
 * Marker for disabled settings
 * Use this instead of null to explicitly disable a setting
 */
export const DISABLED_MARKER = '__DISABLED__';
// ============================================================================
// Utility Functions
// ============================================================================
/**
 * Generate version hash from KV data
 * Uses canonical JSON (key sorted) for consistent hashing
 */
export function generateVersion(data) {
    const sorted = Object.keys(data)
        .sort()
        .reduce((acc, key) => {
        acc[key] = data[key];
        return acc;
    }, {});
    const json = JSON.stringify(sorted);
    const hash = createHash('sha256').update(json).digest('hex').slice(0, 16);
    return `sha256:${hash}`;
}
/**
 * Parse value from environment variable string
 */
function parseEnvValue(value, type) {
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
export function isDisabled(value) {
    return value === DISABLED_MARKER;
}
/**
 * Validate and sanitize KV key component
 * Prevents injection attacks via malicious category or scope IDs
 */
function validateKVKeyPart(part, partName) {
    // Only allow alphanumeric, hyphen, underscore (standard identifier characters)
    if (!/^[a-zA-Z0-9_-]+$/.test(part)) {
        throw new Error(`Invalid ${partName}: must contain only alphanumeric characters, hyphens, or underscores`);
    }
    // Limit length to prevent DoS via extremely long keys
    if (part.length > 128) {
        throw new Error(`Invalid ${partName}: exceeds maximum length of 128 characters`);
    }
    return part;
}
function getKVKey(category, scope) {
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
    env;
    kv;
    categoryMeta = new Map();
    auditCallback;
    // In-memory cache for runtime performance
    cache = new Map();
    cacheTTL;
    constructor(options) {
        this.env = options.env;
        this.kv = options.kv ?? null;
        this.cacheTTL = options.cacheTTL ?? 5000; // Default 5 seconds
        this.auditCallback = options.auditCallback;
    }
    /**
     * Register category metadata
     */
    registerCategory(meta) {
        this.categoryMeta.set(meta.category, meta);
    }
    /**
     * Get category metadata
     */
    getMeta(category) {
        return this.categoryMeta.get(category);
    }
    /**
     * Get all settings for a category
     */
    async getAll(category, scope) {
        const meta = this.categoryMeta.get(category);
        if (!meta) {
            throw new Error(`Unknown category: ${category}`);
        }
        // Load KV data
        const kvData = await this.loadKVData(category, scope);
        // Resolve values with priority: env > KV > default
        const values = {};
        const sources = {};
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
    async get(key, scope) {
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
    async patch(category, scope, request, actor) {
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
        // Check optimistic lock
        if (request.ifMatch !== currentVersion) {
            throw new ConflictError('Settings were updated by someone else. Please refresh.', {
                currentVersion,
            });
        }
        const applied = [];
        const cleared = [];
        const disabled = [];
        const rejected = {};
        const diff = {};
        // Process set operations
        if (request.set) {
            for (const [key, value] of Object.entries(request.set)) {
                const settingMeta = meta.settings[key];
                if (!settingMeta) {
                    rejected[key] = 'Unknown setting key';
                    continue;
                }
                // Note: KV values take priority over env values (per CLAUDE.md policy)
                // Priority: Cache → KV → Environment variables → Default values
                // So we allow KV writes even when env is set
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
                // Note: KV values take priority over env values (per CLAUDE.md policy)
                // Clearing KV allows env fallback to take effect
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
                // Note: KV values take priority over env values (per CLAUDE.md policy)
                // Disabling via KV marker takes precedence over env value
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
                const scopeWithId = scope;
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
    validate(category, values) {
        const meta = this.categoryMeta.get(category);
        if (!meta) {
            return { valid: false, errors: [{ key: category, reason: 'Unknown category' }] };
        }
        const errors = [];
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
    async getVersion(category, scope) {
        const kvData = await this.loadKVData(category, scope);
        return generateVersion(kvData);
    }
    /**
     * Get runtime view (resolved values only, no sources/version)
     * Uses short TTL cache for performance
     */
    async getRuntimeView(category, scope) {
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
     * @param skipCache - If true, bypass cache and read directly from KV (used for patch operations)
     */
    async loadKVData(category, scope, skipCache = false) {
        if (!this.kv) {
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
            const json = await this.kv.get(key);
            // Parse and validate KV data
            let data = {};
            if (json) {
                const parsed = JSON.parse(json);
                // Validate parsed data is a plain object (not null, not array)
                // and sanitize to prevent prototype pollution
                if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                    data = sanitizeObject(parsed);
                }
                else {
                    log.warn(`Invalid KV data format for ${key}: expected object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
                }
            }
            // Update cache
            this.cache.set(cacheKey, {
                data,
                expiresAt: Date.now() + this.cacheTTL,
            });
            return data;
        }
        catch (error) {
            log.warn('Failed to load settings from KV');
            return {};
        }
    }
    /**
     * Save KV data for a category and scope
     */
    async saveKVData(category, scope, data) {
        if (!this.kv) {
            throw new Error('KV not configured');
        }
        const key = getKVKey(category, scope);
        await this.kv.put(key, JSON.stringify(data));
    }
    /**
     * Invalidate cache for a category and scope
     */
    invalidateCache(category, scope) {
        const cacheKey = getKVKey(category, scope);
        this.cache.delete(cacheKey);
    }
    /**
     * Resolve a single value with priority: KV > env > default
     * (per CLAUDE.md: Priority: Cache → KV → Environment variables → Default values)
     *
     * This allows Admin UI to override environment variables without redeployment.
     */
    resolveValue(key, meta, kvData) {
        // 1. Check KV value (highest priority - allows dynamic override)
        const kvValue = kvData[key];
        if (kvValue !== undefined) {
            // Handle disabled marker
            if (isDisabled(kvValue)) {
                return { value: false, source: 'kv' };
            }
            return { value: kvValue, source: 'kv' };
        }
        // 2. Check env value (fallback when KV not set)
        if (meta.envKey) {
            const envValue = parseEnvValue(this.env[meta.envKey], meta.type);
            if (envValue !== undefined) {
                return { value: envValue, source: 'env' };
            }
        }
        // 3. Use default
        return { value: meta.default, source: 'default' };
    }
    /**
     * Resolve all values for a category
     */
    resolveAllValues(category, kvData) {
        const meta = this.categoryMeta.get(category);
        if (!meta) {
            return {};
        }
        const values = {};
        for (const [key, settingMeta] of Object.entries(meta.settings)) {
            values[key] = this.resolveValue(key, settingMeta, kvData).value;
        }
        return values;
    }
    /**
     * Validate a single value
     */
    validateSingleValue(key, value, meta) {
        const errors = [];
        // Type validation
        switch (meta.type) {
            case 'number':
            case 'duration':
                if (typeof value !== 'number') {
                    errors.push({ key, reason: `Expected number, got ${typeof value}` });
                }
                else {
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
                }
                else if (meta.enum && !meta.enum.includes(value)) {
                    errors.push({ key, reason: `Value must be one of: ${meta.enum.join(', ')}` });
                }
                break;
        }
        return { valid: errors.length === 0, errors };
    }
    /**
     * Check setting dependencies
     */
    checkDependencies(key, meta, currentKvData, pendingSet) {
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
    currentVersion;
    constructor(message, details) {
        super(message);
        this.name = 'ConflictError';
        this.currentVersion = details.currentVersion;
    }
}
/**
 * Create a SettingsManager instance
 */
export function createSettingsManager(options) {
    return new SettingsManager(options);
}
