/**
 * Tenant-Aware Settings Accessor
 *
 * Provides a unified interface to read per-tenant settings from KV.
 * Key format: `settings:tenant:{tenantId}:{category}`
 *
 * Replaces the previously hardcoded `settings:tenant:default:{category}` reads.
 */

import { createLogger } from './logger';
import {
  applySystemSettingsOverrides,
  readSystemSettingsOverrides,
} from './system-settings-overrides';
import {
  CATEGORY_SCOPE_CONFIG,
  isCategoryAvailableAtScope,
  type CategoryName,
} from '../types/settings/catalog';

const log = createLogger().module('TENANT_SETTINGS');

export type TenantSettingsCategory =
  | 'tenant'
  | 'login-ui'
  | 'authentication-methods'
  | 'feature-flags'
  | 'tokens'
  | 'step-up'
  | 'login-entry'
  | 'tenant-discovery-ui'
  | 'support-ops'
  | 'plugin';

/** Tenant-scoped compatibility overlay for legacy `system_settings` consumers. */
export const TENANT_SYSTEM_SETTINGS_CATEGORY = 'certification-profile';

export function buildTenantSystemSettingsKey(tenantId: string): string {
  return `settings:tenant:${tenantId}:${TENANT_SYSTEM_SETTINGS_CATEGORY}`;
}

/**
 * Parse a stored settings document: null when none is stored. Anything stored that is not a JSON
 * object (an empty string, invalid JSON, an array, a number) throws, so it is never taken for an
 * absent document.
 */
export function parseSettingsDocument(
  raw: string | null | undefined
): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Tenant system settings must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function parseSettingsObject(raw: string | null, failOnError = false): Record<string, unknown> {
  try {
    return parseSettingsDocument(raw) ?? {};
  } catch (error) {
    if (failOnError) throw error;
    return {};
  }
}

export interface TenantSystemSettingsReadOptions {
  /** Propagate KV and malformed-JSON errors so security profiles can fail closed. */
  failOnError?: boolean;
  /** The client the settings are for, so values set for that client apply too. */
  clientId?: string;
  /**
   * The top-level sections the caller reads (`fapi`, `oidc`, `conformance`); Settings API values
   * are read only for those. All when omitted.
   */
  sections?: readonly string[];
}

/**
 * Read effective legacy system settings for a tenant, with the values set through the
 * Settings API applied (client over tenant over platform); see `system-settings-overrides`.
 * Settings not set there keep the older document's value and fallbacks.
 */
export async function getTenantSystemSettings(
  kv: KVNamespace | undefined,
  tenantId: string,
  options: TenantSystemSettingsReadOptions = {}
): Promise<Record<string, unknown> | null> {
  if (!kv) return null;
  const base = await getTenantSystemSettingsBase(kv, tenantId, options);
  let overrides: Record<string, unknown>;
  try {
    overrides = await readSystemSettingsOverrides(kv, {
      tenantId,
      clientId: options.clientId,
      sections: options.sections,
    });
  } catch (error) {
    if (options.failOnError) throw error;
    // Callers that do not fail closed already accept missing settings; keep the older values.
    log.warn('Settings API values for system settings could not be read');
    return base;
  }
  if (Object.keys(overrides).length === 0) return base;
  return applySystemSettingsOverrides(base ?? {}, overrides);
}

/**
 * The older system settings document for a tenant, without Settings API values.
 *
 * The global `system_settings` value remains the deployment default. A tenant may
 * override complete top-level sections (for example `oidc` and `fapi`) without
 * changing the behavior of other tenants.
 */
export async function getTenantSystemSettingsBase(
  kv: KVNamespace | undefined,
  tenantId: string,
  options: TenantSystemSettingsReadOptions = {}
): Promise<Record<string, unknown> | null> {
  if (!kv) return null;

  try {
    const [globalRaw, tenantRaw] = await Promise.all([
      kv.get('system_settings'),
      kv.get(buildTenantSystemSettingsKey(tenantId)),
    ]);
    if ((globalRaw ?? null) === null && (tenantRaw ?? null) === null) return null;
    return {
      ...parseSettingsObject(globalRaw, options.failOnError),
      ...parseSettingsObject(tenantRaw, options.failOnError),
    };
  } catch (error) {
    if (options.failOnError) throw error;
    return null;
  }
}

/**
 * Read a tenant settings object from KV.
 *
 * @param kv - KV namespace to read from (undefined = returns null)
 * @param tenantId - Tenant ID
 * @param category - Settings category
 * @returns Parsed settings object, or null if not found or on error
 */
export async function getTenantSettings(
  kv: KVNamespace | undefined,
  tenantId: string,
  category: TenantSettingsCategory
): Promise<Record<string, unknown> | null> {
  if (!kv) return null;

  const key = `settings:tenant:${tenantId}:${category}`;

  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The KV namespaces a tenant settings document can live in. */
export interface TenantSettingsStores {
  /** Written by the Settings API: the source of truth. */
  SETTINGS?: KVNamespace;
  /** Holds the copy written when the tenant was created; later edits do not update it. */
  AUTHRIM_CONFIG?: KVNamespace;
}

type TenantSettingsRead =
  | { state: 'found'; data: Record<string, unknown> }
  | { state: 'absent' }
  | { state: 'unreadable' };

/** Read one KV document, telling a missing document apart from one that could not be read. */
async function readTenantSettingsFrom(
  kv: KVNamespace | undefined,
  key: string
): Promise<TenantSettingsRead> {
  if (!kv) return { state: 'absent' };
  let raw: string | null;
  try {
    raw = await kv.get(key);
  } catch {
    return { state: 'unreadable' };
  }
  if (raw === null) return { state: 'absent' };
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { state: 'found', data: parsed as Record<string, unknown> }
      : { state: 'unreadable' };
  } catch {
    return { state: 'unreadable' };
  }
}

/** Thrown when a tenant settings document exists but cannot be read (KV failure, or not an object). */
export class TenantSettingsUnavailableError extends Error {
  constructor(readonly category: string) {
    super(`Tenant settings could not be read: ${category}`);
    this.name = 'TenantSettingsUnavailableError';
  }
}

export interface TenantSettingsDocumentOptions {
  /**
   * What to do when a document cannot be read.
   * - 'throw' (default): fail closed. Use it wherever missing settings would widen what is
   *   allowed, such as tenant binding, profiles, feature flags and token contents.
   * - 'empty': treat the tenant as having no settings. Only for callers whose fallback is at
   *   least as strict as any setting, such as allowed origins that fall back to the issuer.
   */
  onUnreadable?: 'throw' | 'empty';
}

function isPlatformScopedCategory(category: TenantSettingsCategory): boolean {
  return (
    category in CATEGORY_SCOPE_CONFIG &&
    isCategoryAvailableAtScope(category as CategoryName, 'platform')
  );
}

/**
 * Read a tenant's settings document where the Settings API keeps it, with the platform's
 * values underneath when the category can also be set for the whole platform (the same
 * inheritance the Settings API shows).
 *
 * Tenant creation also writes a copy of some categories to AUTHRIM_CONFIG, but edits made
 * through the Settings API only reach SETTINGS, so that copy goes stale. SETTINGS therefore
 * wins, and the AUTHRIM_CONFIG copy is read only when SETTINGS has no tenant document.
 *
 * A document that cannot be read never falls back to the stale copy, which could bring back
 * values an admin has since changed; see `onUnreadable` for what happens instead.
 */
export async function getTenantSettingsDocument(
  stores: TenantSettingsStores,
  tenantId: string,
  category: TenantSettingsCategory,
  options: TenantSettingsDocumentOptions = {}
): Promise<Record<string, unknown> | null> {
  const [tenant, platform] = await Promise.all([
    readTenantSettingsFrom(stores.SETTINGS, `settings:tenant:${tenantId}:${category}`),
    isPlatformScopedCategory(category)
      ? readTenantSettingsFrom(stores.SETTINGS, `settings:platform:${category}`)
      : Promise.resolve<TenantSettingsRead>({ state: 'absent' }),
  ]);
  const unreadable = (): null => {
    log.warn('Tenant settings could not be read', { category });
    if (options.onUnreadable === 'empty') return null;
    throw new TenantSettingsUnavailableError(category);
  };
  // Never fall back to the legacy copy when SETTINGS itself cannot be read.
  if (tenant.state === 'unreadable' || platform.state === 'unreadable') return unreadable();
  let own: Record<string, unknown> | null = null;
  if (tenant.state === 'found') {
    own = tenant.data;
  } else {
    const legacy = await readTenantSettingsFrom(
      stores.AUTHRIM_CONFIG,
      `settings:tenant:${tenantId}:${category}`
    );
    // A legacy copy that exists but cannot be read is as unknown as an unreadable SETTINGS.
    if (legacy.state === 'unreadable') return unreadable();
    if (legacy.state === 'found') own = legacy.data;
  }
  if (platform.state !== 'found') return own;
  return { ...platform.data, ...(own ?? {}) };
}

/**
 * Read a boolean flag from a settings document: true or false when it is set (the disabled
 * marker reads as false), null when the document does not set it, so the caller can fall back
 * to older flags only then. An explicit false must not be overridden by a fallback.
 */
export function readSettingsFlag(
  settings: Record<string, unknown> | null | undefined,
  key: string
): boolean | null {
  const value = settings?.[key];
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0' || value === DISABLED_FLAG_MARKER) {
    return false;
  }
  return null;
}

/** Mirrors `DISABLED_MARKER` in settings-manager, which cannot be imported here. */
const DISABLED_FLAG_MARKER = '__DISABLED__';
