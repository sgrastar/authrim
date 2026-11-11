/**
 * The platform layer of a tenant's Default profiles: the Default methods (which methods each use
 * offers) and the Default session rules (session lifetimes, refresh, single sign-on).
 *
 * A Default is not a stored profile: it is the tenant's own settings. The platform can set the
 * same settings in its documents, and a tenant inherits each one it does not set. Two platform
 * switches set the tenant's values aside, for these settings only:
 * - `profiles.<kind>.tenant_change_allowed` off (tenants may not change the platform's profiles);
 * - `profiles.<kind>.default_locked` on (the platform's Default holds for every tenant).
 * A value set aside is kept, not deleted: it applies again once the switch allows it.
 *
 * Every reader of these settings goes through this file (raw documents with
 * layerTenantDocument, resolved values with layerResolvedSettings), so no path decides on the
 * tenant's values alone. The readers that load the layer are in effective-settings.ts.
 */
import type { PlatformProfileKind } from '../repositories/admin/platform-profile';
import { AUTHENTICATION_METHODS_DEFAULT_LAYER_KEYS } from '../types/settings/authentication-methods';
import { DISABLED_MARKER, type SettingSource } from '../utils/settings-manager';

/** The settings categories that hold a Default profile's settings. */
export type DefaultLayerCategory = 'authentication-methods' | 'session' | 'oauth';

/** The session settings the Default session rules hold (as a session profile does). */
export const SESSION_DEFAULT_LAYER_KEYS = [
  'session.default_ttl',
  'session.max_ttl',
  'session.ttl.email_code',
  'session.ttl.directory_password',
  'session.ttl.direct_auth',
  'session.ttl.passkey',
  'session.ttl.passkey_registration',
  'session.ttl.guest',
  'session.ttl.did',
  'session.refresh_default',
] as const;

export const DEFAULT_LAYER_KEYS: Readonly<Record<DefaultLayerCategory, readonly string[]>> = {
  'authentication-methods': AUTHENTICATION_METHODS_DEFAULT_LAYER_KEYS,
  session: SESSION_DEFAULT_LAYER_KEYS,
  oauth: ['oauth.sso_enabled'],
};

export const DEFAULT_LAYER_KIND: Readonly<Record<DefaultLayerCategory, PlatformProfileKind>> = {
  'authentication-methods': 'method',
  session: 'session',
  oauth: 'session',
};

/** The categories of a kind of Default. */
export const DEFAULT_LAYER_CATEGORIES: Readonly<
  Record<PlatformProfileKind, readonly DefaultLayerCategory[]>
> = {
  method: ['authentication-methods'],
  session: ['session', 'oauth'],
};

/**
 * Older single switches a tenant may still hold for a method: each stands for the method's uses
 * where the tenant sets no use switch of its own.
 */
export const LEGACY_METHOD_SWITCHES: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    (['passkey', 'email_otp', 'totp'] as const).map((method) => [
      `authentication-methods.${method}.enabled`,
      (['signup', 'login', 'reauth', 'account_link'] as const).map(
        (use) => `authentication-methods.${method}.${use}_enabled`
      ),
    ])
  );

export function isDefaultLayerCategory(category: string): category is DefaultLayerCategory {
  return Object.prototype.hasOwnProperty.call(DEFAULT_LAYER_KEYS, category);
}

/** Whether a setting is one a Default profile holds. */
export function isDefaultLayerKey(category: DefaultLayerCategory, key: string): boolean {
  return DEFAULT_LAYER_KEYS[category].includes(key);
}

/** Why a tenant's own values for its Default do not apply now (null: they apply). */
export type DefaultSetAsideReason = 'locked' | 'changes_not_allowed';

/** What the platform holds for one category of a Default. */
export interface DefaultProfileLayer {
  category: DefaultLayerCategory;
  /** The category resolved at the platform: the platform's value, else env, else default. */
  platformValues: Record<string, unknown>;
  platformSources: Record<string, SettingSource>;
  /** Why the tenant's values for the Default's settings are set aside, or null. */
  tenantSetAside: DefaultSetAsideReason | null;
}

/** The layer, from the category and the `profiles` switches as the platform resolves them. */
export function defaultProfileLayerFrom(
  category: DefaultLayerCategory,
  platform: { values: Record<string, unknown>; sources: Record<string, SettingSource> },
  profiles: { values: Record<string, unknown> }
): DefaultProfileLayer {
  const kind = DEFAULT_LAYER_KIND[category];
  const locked = profiles.values[`profiles.${kind}.default_locked`] === true;
  const changeAllowed = profiles.values[`profiles.${kind}.tenant_change_allowed`] !== false;
  // Read at the platform scope, the platform's own values come as `kv`.
  const platformSources = Object.fromEntries(
    Object.entries(platform.sources).map(([key, source]) => [
      key,
      source === 'kv' ? 'platform' : source,
    ])
  ) as Record<string, SettingSource>;
  return {
    category,
    platformValues: platform.values,
    platformSources,
    tenantSetAside: locked ? 'locked' : changeAllowed ? null : 'changes_not_allowed',
  };
}

/**
 * A tenant's stored document with the platform layer under it, for readers that read the raw
 * document: each Default setting the tenant sets (and may) stays; one it does not set takes the
 * platform's stored value; with neither, it stays unset (the reader's own environment variable
 * and default apply, as before). Other settings are the tenant's alone.
 */
export function layerTenantDocument(
  document: Record<string, unknown>,
  layer: DefaultProfileLayer
): Record<string, unknown> {
  const layered: Record<string, unknown> = { ...document };
  const honoured = layer.tenantSetAside === null;
  if (!honoured) {
    for (const key of DEFAULT_LAYER_KEYS[layer.category]) delete layered[key];
    for (const legacy of Object.keys(LEGACY_METHOD_SWITCHES)) delete layered[legacy];
  }
  if (honoured) {
    // An older single switch is handed to the readers as the boolean it reads as.
    for (const legacy of Object.keys(LEGACY_METHOD_SWITCHES)) {
      const on = parseLegacySwitch(layered[legacy]);
      if (on !== null) layered[legacy] = on;
    }
  }
  for (const key of DEFAULT_LAYER_KEYS[layer.category]) {
    if (layered[key] !== undefined) continue;
    // A tenant's older switch for the method still decides the uses it sets no switch for.
    if (honoured && legacySwitchCovers(document, key)) continue;
    if (layer.platformSources[key] === 'platform') layered[key] = layer.platformValues[key];
  }
  return layered;
}

function legacySwitchCovers(document: Record<string, unknown>, key: string): boolean {
  for (const [legacy, uses] of Object.entries(LEGACY_METHOD_SWITCHES)) {
    if (uses.includes(key) && parseLegacySwitch(document[legacy]) !== null) return true;
  }
  return false;
}

/**
 * An older single switch as sign-in reads it: a boolean, or the string true/false in any case
 * with spaces around it; the disabled marker is off. Anything else is no switch (null).
 */
export function parseLegacySwitch(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === DISABLED_MARKER) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

/**
 * Resolved tenant values (read at the tenant scope, own values as `kv`) with each older single
 * switch the tenant holds standing for the uses it sets no switch of its own for, as sign-in
 * reads them. `raw` is the tenant's stored document (the resolved values turn the disabled
 * marker into false, and an unparseable string would be kept as it is).
 */
export function withLegacyMethodSwitches(
  resolved: { values: Record<string, unknown>; sources: Record<string, SettingSource> },
  raw: Record<string, unknown> = resolved.values
): { values: Record<string, unknown>; sources: Record<string, SettingSource> } {
  const values = { ...resolved.values };
  const sources = { ...resolved.sources };
  for (const [legacy, uses] of Object.entries(LEGACY_METHOD_SWITCHES)) {
    if (resolved.sources[legacy] !== 'kv') continue;
    const on = parseLegacySwitch(raw[legacy] ?? resolved.values[legacy]);
    if (on === null) continue;
    for (const use of uses) {
      if (sources[use] === 'kv') continue;
      values[use] = on;
      sources[use] = 'kv';
    }
  }
  return { values, sources };
}

/**
 * Resolved values (a settings manager's answer at the tenant or client scope, with or without
 * the platform as a parent) with the platform layer applied: a Default setting keeps the tenant's
 * (or app's) value only where the tenant's values apply; otherwise it takes the platform's
 * resolution (the platform's value, else env, else default). An app's own value is kept: an app's
 * single sign-on setting comes before the Default.
 */
export function layerResolvedSettings(
  resolved: { values: Record<string, unknown>; sources: Record<string, SettingSource> },
  layer: DefaultProfileLayer,
  /** The scope that was read (its own values come as `kv`). */
  readAt: 'tenant' | 'client'
): { values: Record<string, unknown>; sources: Record<string, SettingSource> } {
  const values = { ...resolved.values };
  const sources = { ...resolved.sources };
  const honoured = layer.tenantSetAside === null;
  for (const key of DEFAULT_LAYER_KEYS[layer.category]) {
    const source = sources[key];
    if (source === 'kv' && readAt === 'client') continue;
    const tenantValue = source === 'tenant' || (source === 'kv' && readAt === 'tenant');
    if (tenantValue && honoured) continue;
    if (!(key in layer.platformValues)) continue;
    values[key] = layer.platformValues[key];
    sources[key] = layer.platformSources[key] ?? 'default';
  }
  return { values, sources };
}
