/**
 * One-time import of the older settings stores into the Settings API.
 *
 * Before the Settings API, settings were kept in stores of their own (AUTHRIM_CONFIG
 * `oauth:config:*`, SETTINGS `system_settings`, a tenant's certification profile, and others).
 * This module plans the Settings API values that reproduce what runtime applies from them: the
 * platform-wide stores become platform values, and a tenant's certification profile becomes that
 * tenant's values. Planning only reads; `ar-management` applies the plan (see
 * `legacy-settings-import.ts` there) in bounded steps, without replacing any value already set
 * through the Settings API, and leaves the older stores in place.
 */

import {
  LEGACY_STORE_SOURCES,
  TENANT_PROFILE_CATEGORIES,
  readLegacyStore,
  tenantProfileValues,
  type LegacySettingsEnv,
} from './legacy-settings';
import { ALL_CATEGORY_META, type CategoryName } from '../types/settings/catalog';
import { createSettingsManager, type CategoryMeta } from '../utils/settings-manager';
import { LEGACY_UNSET } from '../utils/system-settings-fields';
import {
  buildTenantSystemSettingsKey,
  parseSettingsDocument,
  TENANT_SYSTEM_SETTINGS_CATEGORY,
} from '../utils/tenant-settings';

export type LegacyImportScope = { type: 'platform' } | { type: 'tenant'; id: string };

/** Values for one Settings API document, from one older store. */
export interface LegacyImportWrite {
  scope: LegacyImportScope;
  category: CategoryName;
  /** The older store the values come from. */
  source: string;
  values: Record<string, unknown>;
}

/** The stores, and the deployment's environment variables (for values left to env). */
export type LegacyImportEnv = LegacySettingsEnv & Record<string, unknown>;

const TENANT_PROFILE_PREFIX = 'settings:tenant:';
const TENANT_PROFILE_SUFFIX = `:${TENANT_SYSTEM_SETTINGS_CATEGORY}`;
const TENANT_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * One page of the tenants with a certification profile (an older `system_settings` overlay):
 * the tenants among the next `limit` tenant settings keys, and the cursor of the page after it
 * (null at the end).
 */
export async function listCertificationProfileTenants(
  kv: KVNamespace,
  cursor: string | null,
  limit: number
): Promise<{ tenants: string[]; cursor: string | null }> {
  const page = await kv.list({ prefix: TENANT_PROFILE_PREFIX, limit, cursor: cursor ?? undefined });
  const tenants: string[] = [];
  for (const { name } of page.keys) {
    if (!name.endsWith(TENANT_PROFILE_SUFFIX)) continue;
    const tenantId = name.slice(TENANT_PROFILE_PREFIX.length, -TENANT_PROFILE_SUFFIX.length);
    if (TENANT_ID.test(tenantId)) tenants.push(tenantId);
  }
  return { tenants, cursor: page.list_complete ? null : page.cursor };
}

/** What a setting resolves to from env and its default alone, by key, for one category. */
async function envAndDefaults(
  env: LegacyImportEnv,
  category: CategoryName
): Promise<Record<string, unknown>> {
  const manager = createSettingsManager({
    env: env as unknown as Record<string, string | undefined>,
    kv: null,
    cacheTTL: 0,
  });
  manager.registerCategory(ALL_CATEGORY_META[category] as CategoryMeta);
  return (await manager.getAll(category, { type: 'platform' })).values;
}

/**
 * The version of what the import reads: the older stores and the Settings API keys their values
 * map to. Raise it whenever a store or a mapping is added or changed, so an import completed
 * under an earlier version runs again for what was added (values already in the Settings API are
 * kept, as in every run).
 */
export const LEGACY_IMPORT_CONTRACT = 11;

/**
 * The platform values that reproduce the platform-wide older stores. Throws when any store
 * cannot be read, so an import never runs on part of what is saved.
 */
export async function planPlatformImport(env: LegacyImportEnv): Promise<LegacyImportWrite[]> {
  const writes: LegacyImportWrite[] = [];
  for (const source of LEGACY_STORE_SOURCES) {
    const values = await readLegacyStore(env, source.id);
    if (Object.keys(values).length === 0) continue;
    writes.push({
      scope: { type: 'platform' },
      category: source.category as CategoryName,
      source: source.id,
      values,
    });
  }
  return writes;
}

/** The global `system_settings` document (null when none), as tenant profiles lay over it. */
export async function readGlobalSystemSettings(
  env: LegacyImportEnv
): Promise<Record<string, unknown> | null> {
  return env.SETTINGS ? parseSettingsDocument(await env.SETTINGS.get('system_settings')) : null;
}

/**
 * The tenant values that reproduce one tenant's certification profile (each read once), over
 * the global document already read. Empty when the profile is gone. Throws when it cannot be
 * read or parsed.
 */
export async function planTenantProfileImport(
  env: LegacyImportEnv,
  tenantId: string,
  global: Record<string, unknown> | null
): Promise<LegacyImportWrite[]> {
  const profile = env.SETTINGS
    ? parseSettingsDocument(await env.SETTINGS.get(buildTenantSystemSettingsKey(tenantId)))
    : null;
  if (!profile) return [];
  const writes: LegacyImportWrite[] = [];
  for (const category of TENANT_PROFILE_CATEGORIES as CategoryName[]) {
    const values = tenantProfileValues(global, profile, category);
    if (Object.keys(values).length === 0) continue;
    // A field the profile's section leaves out applies from env or its default; once the
    // profile is no longer read, the platform's value would apply instead, so the value in
    // effect is written for the tenant.
    const fallback = Object.values(values).includes(LEGACY_UNSET)
      ? await envAndDefaults(env, category)
      : {};
    writes.push({
      scope: { type: 'tenant', id: tenantId },
      category,
      source: `SETTINGS ${buildTenantSystemSettingsKey(tenantId)}`,
      values: Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          value === LEGACY_UNSET ? fallback[key] : value,
        ])
      ),
    });
  }
  return writes;
}
