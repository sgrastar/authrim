/**
 * Effective settings for runtime workers.
 *
 * Resolves a category the way the Settings API shows it: the client's value, else the tenant's,
 * else the platform's (where the category has those scopes), else a value saved in an older
 * platform-wide store, else the environment variable, else the built-in default.
 */

import {
  ALL_CATEGORY_META,
  isCategoryAvailableAtScope,
  settingsParentScopes,
  type CategoryName,
} from '../types/settings/catalog';
import {
  createSettingsManager,
  type CategoryMeta,
  type SettingScope,
  type SettingSource,
  type SettingsManager,
} from '../utils/settings-manager';
import { readLegacySettings, type LegacySettingsEnv } from './legacy-settings';

export interface EffectiveSettingsEnv extends LegacySettingsEnv {
  SETTINGS?: KVNamespace;
}

export interface EffectiveSettingsTarget {
  tenantId: string;
  /** The client, for categories that can be set per client. */
  clientId?: string;
  /**
   * Read the Settings API documents and the older stores without the per-isolate caches, for
   * admin responses that must show a value just saved; a store that cannot be read then fails
   * the call.
   */
  freshLegacy?: boolean;
  /**
   * The older stores' values, already read by the caller (so a decision uses one read of them);
   * the older stores are then not read here.
   */
  legacy?: Record<string, unknown>;
  /** The keys the caller needs: only the older stores that can hold them are read. */
  keys?: readonly string[];
  /**
   * Fail when an older store cannot be read, instead of skipping its values: for callers that
   * fall back to those stores themselves. Implied by `freshLegacy`.
   */
  strictLegacy?: boolean;
}

const RUNTIME_CACHE_TTL_MS = 60_000;
/** What a scope id may look like inside a settings key (see settings-manager). */
const SETTINGS_KEY_PART = /^[a-zA-Z0-9_-]{1,128}$/;
const managers = new WeakMap<object, SettingsManager>();
const freshManagers = new WeakMap<object, SettingsManager>();

/** The manager for runtime reads (documents cached briefly), or for admin views (`fresh`). */
function managerFor(env: EffectiveSettingsEnv, fresh = false): SettingsManager {
  const key = (env.SETTINGS ?? env) as object;
  const cache = fresh ? freshManagers : managers;
  let manager = cache.get(key);
  if (!manager) {
    manager = createSettingsManager({
      env: env as unknown as Record<string, string | undefined>,
      kv: env.SETTINGS ?? null,
      cacheTTL: fresh ? 0 : RUNTIME_CACHE_TTL_MS,
      // A settings document that exists but cannot be read must not silently become defaults.
      strictReads: true,
    });
    for (const meta of Object.values(ALL_CATEGORY_META)) {
      manager.registerCategory(meta as CategoryMeta);
    }
    cache.set(key, manager);
  }
  return manager;
}

/** The effective values of one category for a tenant, or for one of its clients. */
export async function resolveEffectiveSettings(
  env: EffectiveSettingsEnv,
  category: CategoryName,
  target: EffectiveSettingsTarget
): Promise<Record<string, unknown>> {
  return (await resolveEffectiveSettingsWithSources(env, category, target)).values;
}

/** Like resolveEffectiveSettings, with where each value came from ('default' when unset). */
export async function resolveEffectiveSettingsWithSources(
  env: EffectiveSettingsEnv,
  category: CategoryName,
  target: EffectiveSettingsTarget
): Promise<{ values: Record<string, unknown>; sources: Record<string, SettingSource> }> {
  // Client settings are stored under the client id, so an id that cannot be part of a settings
  // key (such as a URL-shaped JWT bearer issuer) has none: use the tenant's.
  const clientId =
    target.clientId && SETTINGS_KEY_PART.test(target.clientId) ? target.clientId : undefined;
  const scope: SettingScope =
    clientId && isCategoryAvailableAtScope(category, 'client')
      ? { type: 'client', id: clientId, tenantId: target.tenantId }
      : { type: 'tenant', id: target.tenantId };
  const legacy =
    target.legacy ??
    (await readLegacySettings(env, category, {
      tenantId: target.tenantId,
      fresh: target.freshLegacy,
      strict: target.strictLegacy ?? target.freshLegacy,
      keys: target.keys,
    }));
  const { values, sources } = await managerFor(env, target.freshLegacy === true).getAll(
    category,
    scope,
    {
      parents: settingsParentScopes(category, scope),
      legacy,
    }
  );
  return { values, sources };
}

/**
 * The effective values of one category for the whole platform (for settings that only the
 * platform can set): the platform's Settings API value, else a value saved in an older store,
 * else the environment variable, else the built-in default; with where each value came from.
 */
export async function resolvePlatformSettingsWithSources(
  env: EffectiveSettingsEnv,
  category: CategoryName,
  options: Pick<EffectiveSettingsTarget, 'keys' | 'strictLegacy' | 'freshLegacy' | 'legacy'> = {}
): Promise<{ values: Record<string, unknown>; sources: Record<string, SettingSource> }> {
  const legacy =
    options.legacy ??
    (await readLegacySettings(env, category, {
      fresh: options.freshLegacy,
      strict: options.strictLegacy ?? options.freshLegacy,
      keys: options.keys,
    }));
  const { values, sources } = await managerFor(env, options.freshLegacy === true).getAll(
    category,
    { type: 'platform' },
    { legacy }
  );
  return { values, sources };
}
