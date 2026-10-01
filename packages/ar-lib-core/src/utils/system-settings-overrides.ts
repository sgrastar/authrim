/**
 * Settings API values applied to the older `system_settings` view.
 *
 * Several runtime checks (FAPI, token exchange, client credentials, external request_uri,
 * introspection, conformance mode) read the older `system_settings` document, written by the
 * older `/api/admin/settings/*` endpoints. The same settings exist in the Settings API. This
 * module lays the values set there (client over tenant over platform, where the category has
 * those scopes) on top of that document, so a value saved through the Settings API applies,
 * while anything not set there keeps the older document's value and fallbacks exactly as before.
 */

import {
  ALL_CATEGORY_META,
  isCategoryAvailableAtScope,
  type CategoryName,
} from '../types/settings/catalog';

/** Where each Settings API setting lives in the `system_settings` document. */
interface SystemSettingsField {
  category: CategoryName;
  key: string;
  path: readonly string[];
  /** Convert the Settings API value to the document's form. */
  toDocument?: (value: unknown) => unknown;
  /** Convert the document's value to the Settings API form (for showing it as a fallback). */
  fromDocument?: (value: unknown) => unknown;
  /**
   * What runtime uses when the document has the field's section but not the field itself, so
   * the fallback shown matches what applies.
   */
  sectionDefault?: unknown;
}

const commaList = {
  toDocument: (value: unknown) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean)
      : value,
  fromDocument: (value: unknown) =>
    Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').join(',') : value,
};

export const SYSTEM_SETTINGS_FIELDS: readonly SystemSettingsField[] = [
  { category: 'security', key: 'security.fapi_enabled', path: ['fapi', 'enabled'] },
  { category: 'security', key: 'security.fapi_strict_dpop', path: ['fapi', 'strictDPoP'] },
  {
    category: 'security',
    key: 'security.fapi_allow_public_clients',
    path: ['fapi', 'allowPublicClients'],
  },
  {
    category: 'security',
    key: 'security.require_signed_request_object',
    path: ['fapi', 'messageSigning', 'requireSignedRequestObject'],
  },
  {
    category: 'oauth',
    key: 'oauth.https_request_uri_enabled',
    path: ['oidc', 'httpsRequestUri', 'enabled'],
  },
  {
    category: 'oauth',
    key: 'oauth.https_request_uri_allowed_domains',
    path: ['oidc', 'httpsRequestUri', 'allowedDomains'],
    ...commaList,
  },
  {
    category: 'tokens',
    key: 'tokens.exchange_enabled',
    path: ['oidc', 'tokenExchange', 'enabled'],
  },
  {
    category: 'tokens',
    key: 'tokens.introspection_cache_ttl',
    path: ['oidc', 'introspectionCache', 'ttlSeconds'],
  },
  {
    category: 'feature-flags',
    key: 'feature.introspection_cache_enabled',
    path: ['oidc', 'introspectionCache', 'enabled'],
  },
  {
    category: 'tokens',
    key: 'tokens.introspection_strict_validation',
    path: ['oidc', 'introspectionValidation', 'strictValidation'],
  },
  {
    category: 'feature-flags',
    key: 'feature.enable_client_credentials',
    path: ['oidc', 'clientCredentials', 'enabled'],
  },
  {
    category: 'feature-flags',
    key: 'feature.conformance_enabled',
    path: ['conformance', 'enabled'],
    sectionDefault: false,
  },
  {
    category: 'feature-flags',
    key: 'feature.conformance_use_builtin_forms',
    path: ['conformance', 'useBuiltinForms'],
    sectionDefault: true,
  },
];

const DISABLED_MARKER = '__DISABLED__';

export interface SystemSettingsTarget {
  /** Null for the platform-wide document (no tenant or client values apply). */
  tenantId: string | null;
  clientId?: string;
  /**
   * The top-level sections of the document the caller reads (`fapi`, `oidc`, `conformance`).
   * Only the Settings API documents for those are read; all when omitted.
   */
  sections?: readonly string[];
}

type DocumentRead = Record<string, unknown> | null;

const CACHE_TTL_MS = 30_000;
/** Bounds the per-isolate cache, so many distinct tenants or clients cannot grow it without end. */
const CACHE_MAX_ENTRIES = 1000;
const documentCache = new WeakMap<object, Map<string, { value: DocumentRead; at: number }>>();

/** One Settings API document, cached briefly per isolate. Throws when it cannot be read. */
async function readDocument(kv: KVNamespace, key: string): Promise<DocumentRead> {
  let cache = documentCache.get(kv);
  if (!cache) {
    cache = new Map();
    documentCache.set(kv, cache);
  }
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const raw = await kv.get(key);
  let value: DocumentRead = null;
  if (raw !== null) {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError(`Settings document is not an object: ${key}`);
    }
    value = parsed as Record<string, unknown>;
  }
  cache.delete(key);
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Maps keep insertion order: drop the oldest entry.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, at: Date.now() });
  return value;
}

type ScopeLevel = 'platform' | 'tenant' | 'client';

/** The Settings API documents for a category, nearest scope first. */
function documentKeys(
  category: CategoryName,
  target: SystemSettingsTarget
): Array<{ scope: ScopeLevel; key: string }> {
  const keys: Array<{ scope: ScopeLevel; key: string }> = [];
  if (target.tenantId) {
    if (target.clientId && isCategoryAvailableAtScope(category, 'client')) {
      keys.push({
        scope: 'client',
        key: `settings:client:${target.tenantId}:${target.clientId}:${category}`,
      });
    }
    if (isCategoryAvailableAtScope(category, 'tenant')) {
      keys.push({ scope: 'tenant', key: `settings:tenant:${target.tenantId}:${category}` });
    }
  }
  if (isCategoryAvailableAtScope(category, 'platform')) {
    keys.push({ scope: 'platform', key: `settings:platform:${category}` });
  }
  return keys;
}

/** The scopes a setting can be set at, when narrower than its category's. */
function settingScopes(field: SystemSettingsField): readonly ScopeLevel[] | undefined {
  const settings = ALL_CATEGORY_META[field.category].settings as Record<
    string,
    { scopes?: ScopeLevel[] }
  >;
  return settings[field.key]?.scopes;
}

/**
 * The Settings API values set for the fields that live in `system_settings`, keyed by setting
 * key: the nearest scope that sets each one wins. Values not set anywhere are left out, so the
 * older document (and its own fallbacks) still decides them. Throws when a document exists but
 * cannot be read.
 */
export async function readSystemSettingsOverrides(
  kv: KVNamespace,
  target: SystemSettingsTarget
): Promise<Record<string, unknown>> {
  const fields = SYSTEM_SETTINGS_FIELDS.filter(
    (field) => !target.sections || target.sections.includes(field.path[0])
  );
  const categories = [...new Set(fields.map((field) => field.category))];
  const documents = new Map<CategoryName, Array<{ scope: ScopeLevel; document: DocumentRead }>>(
    await Promise.all(
      categories.map(
        async (category) =>
          [
            category,
            await Promise.all(
              documentKeys(category, target).map(async ({ scope, key }) => ({
                scope,
                document: await readDocument(kv, key),
              }))
            ),
          ] as const
      )
    )
  );
  const overrides: Record<string, unknown> = {};
  for (const field of fields) {
    const scopes = settingScopes(field);
    for (const { scope, document } of documents.get(field.category) ?? []) {
      if (scopes && !scopes.includes(scope)) continue;
      if (document && document[field.key] !== undefined) {
        const value = document[field.key];
        overrides[field.key] = value === DISABLED_MARKER ? false : value;
        break;
      }
    }
  }
  return overrides;
}

/** A copy of the document with the Settings API values written at their paths. */
export function applySystemSettingsOverrides(
  document: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...document };
  for (const field of SYSTEM_SETTINGS_FIELDS) {
    if (!(field.key in overrides)) continue;
    const value = field.toDocument ? field.toDocument(overrides[field.key]) : overrides[field.key];
    let node = result;
    for (const [index, part] of field.path.entries()) {
      if (index === field.path.length - 1) {
        node[part] = value;
      } else {
        const child = node[part];
        node[part] =
          child && typeof child === 'object' && !Array.isArray(child)
            ? { ...(child as Record<string, unknown>) }
            : {};
        node = node[part] as Record<string, unknown>;
      }
    }
  }
  return result;
}

/**
 * The document's own values for the fields of one category, keyed by setting key, in the
 * Settings API form. Used to show them as the platform value the Settings API falls back to.
 */
export function systemSettingsFieldValues(
  document: Record<string, unknown> | null,
  category: string
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (!document) return values;
  for (const field of SYSTEM_SETTINGS_FIELDS) {
    if (field.category !== category) continue;
    let node: unknown = document;
    let parent: unknown = undefined;
    for (const part of field.path) {
      parent = node;
      node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
    }
    if (
      node === undefined &&
      field.sectionDefault !== undefined &&
      parent &&
      typeof parent === 'object'
    ) {
      node = field.sectionDefault;
    }
    if (node !== undefined)
      values[field.key] = field.fromDocument ? field.fromDocument(node) : node;
  }
  return values;
}
