/**
 * Audit routing rules (platform) and the PII configuration (tenant) as canonical settings
 * documents. D1 is the source of truth and is written only against the version a decision was
 * made on (SettingsManager.patch with ifMatch); the settings KV is the projection runtime reads.
 * Data kept before in AUTHRIM_CONFIG (`audit_routing_rules`, `pii_config:{tenantId}`) is adopted
 * into the document the first time it is read for management, and read by runtime until then.
 */

import type { TenantPIIConfig } from './audit/types';
import { DatabaseSettingsCanonicalStore } from './settings-canonical-store';
import { requireDedicatedAdminDatabaseAdapter } from './admin-database-adapter';
import { sanitizeObject } from '../utils/security';
import {
  createSettingsManager,
  generateVersion,
  settingsStorageKey,
  type SettingScope,
  type SettingsManager,
} from '../utils/settings-manager';
import {
  AUDIT_PII_CATEGORY,
  AUDIT_PII_CATEGORY_META,
  AUDIT_PII_CONFIG_KEY,
  LEGACY_PII_CONFIG_KV_PREFIX,
} from '../types/settings/audit-pii';
import {
  AUDIT_ROUTING_CATEGORY,
  AUDIT_ROUTING_CATEGORY_META,
  AUDIT_ROUTING_RULES_KEY,
  LEGACY_AUDIT_ROUTING_RULES_KV_KEY,
} from '../types/settings/audit-routing';
import type { Env } from '../types/env';

type AuditSettingsEnv = Pick<Env, 'SETTINGS' | 'AUTHRIM_CONFIG' | 'DB_ADMIN'>;

const PLATFORM: SettingScope = { type: 'platform' };
const KEY_PART = /^[a-zA-Z0-9_-]{1,128}$/;

export function isValidAuditSettingsTenantId(tenantId: string): boolean {
  return KEY_PART.test(tenantId);
}

export function createAuditSettingsManager(
  env: AuditSettingsEnv,
  options: { strict?: boolean } = {}
): { manager: SettingsManager; store: DatabaseSettingsCanonicalStore } {
  const store = new DatabaseSettingsCanonicalStore(
    requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical')
  );
  const manager = createSettingsManager({
    strictReads: options.strict === true,
    env: {},
    kv: env.SETTINGS ?? null,
    cacheTTL: 0,
    canonicalStore: store,
  });
  manager.registerCategory(AUDIT_ROUTING_CATEGORY_META);
  manager.registerCategory(AUDIT_PII_CATEGORY_META);
  return { manager, store };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

interface CanonicalRead {
  data: Record<string, unknown>;
  version: string;
  /**
   * Set when no canonical document exists yet and `data` is what is in effect (the projected or
   * the legacy value). Reading never writes; call this after the gate, just before the save: it
   * creates the document from `data` (idempotent; one created meanwhile is kept, and the save
   * then fails its version check).
   */
  adopt?: () => Promise<void>;
}

/**
 * The document as it stands: the canonical one, else what is in effect without it (the settings
 * KV projection, else the legacy AUTHRIM_CONFIG value). Nothing is written. A legacy value that
 * cannot be parsed throws (it is unreadable, not absent).
 */
async function readCanonicalOrInEffect(
  env: AuditSettingsEnv,
  store: DatabaseSettingsCanonicalStore,
  category: string,
  scope: SettingScope,
  legacyKey: string,
  toData: (parsed: unknown) => Record<string, unknown>
): Promise<CanonicalRead> {
  const canonical = await store.load(category, scope);
  if (canonical) return { data: canonical.data, version: canonical.version };
  let data: Record<string, unknown> = {};
  const projected = env.SETTINGS
    ? await env.SETTINGS.get(settingsStorageKey(category, scope))
    : null;
  if (projected !== null) {
    const parsed: unknown = JSON.parse(projected);
    if (!isObject(parsed)) throw new Error('settings_data_invalid');
    data = sanitizeObject(parsed);
  } else if (env.AUTHRIM_CONFIG) {
    const text = await env.AUTHRIM_CONFIG.get(legacyKey);
    if (text !== null) data = toData(JSON.parse(text) as unknown);
  }
  const version = generateVersion(data);
  return {
    data,
    version,
    adopt: async () => {
      await store.create(category, scope, { data, version });
    },
  };
}

const routingData = (parsed: unknown): Record<string, unknown> => {
  if (!Array.isArray(parsed)) throw new Error('audit_retention_rules_invalid');
  return { [AUDIT_ROUTING_RULES_KEY]: parsed };
};
const piiData = (parsed: unknown): Record<string, unknown> => {
  if (!isObject(parsed)) throw new Error('pii_config_invalid');
  return { [AUDIT_PII_CONFIG_KEY]: parsed };
};

export interface AuditRoutingState<T = unknown> {
  /** Saves with `patch(ifMatch: version)`. */
  manager: SettingsManager;
  /** The version of the document the rules were read from; save against it. */
  version: string;
  rules: T[];
  /** See `CanonicalRead.adopt`: call after the gate, before the save. */
  adopt?: () => Promise<void>;
}

/** One strict read of the platform routing document. Writes nothing. */
export async function loadAuditRoutingState(env: AuditSettingsEnv): Promise<AuditRoutingState> {
  const { manager, store } = createAuditSettingsManager(env, { strict: true });
  const read = await readCanonicalOrInEffect(
    env,
    store,
    AUDIT_ROUTING_CATEGORY,
    PLATFORM,
    LEGACY_AUDIT_ROUTING_RULES_KV_KEY,
    routingData
  );
  const rules = read.data[AUDIT_ROUTING_RULES_KEY] ?? [];
  if (!Array.isArray(rules)) throw new Error('audit_retention_rules_invalid');
  return { manager, version: read.version, rules, adopt: read.adopt };
}

export interface PIIConfigState {
  manager: SettingsManager;
  version: string;
  /** The tenant's own configuration; null when it has none (defaults apply). */
  stored: TenantPIIConfig | null;
  /** See `CanonicalRead.adopt`: call after the gate, before the save. */
  adopt?: () => Promise<void>;
}

export async function loadPIIConfigState(
  env: AuditSettingsEnv,
  tenantId: string
): Promise<PIIConfigState> {
  if (!isValidAuditSettingsTenantId(tenantId)) throw new Error('invalid_tenant_id');
  const { manager, store } = createAuditSettingsManager(env, { strict: true });
  const read = await readCanonicalOrInEffect(
    env,
    store,
    AUDIT_PII_CATEGORY,
    { type: 'tenant', id: tenantId },
    `${LEGACY_PII_CONFIG_KV_PREFIX}${tenantId}`,
    piiData
  );
  const value = read.data[AUDIT_PII_CONFIG_KEY];
  return {
    manager,
    version: read.version,
    stored: isObject(value) ? (value as unknown as TenantPIIConfig) : null,
    adopt: read.adopt,
  };
}

export const AUDIT_ROUTING_PROJECTION_KEY = settingsStorageKey(AUDIT_ROUTING_CATEGORY, PLATFORM);
export function auditPIIProjectionKey(tenantId: string): string {
  return settingsStorageKey(AUDIT_PII_CATEGORY, { type: 'tenant', id: tenantId });
}

/** Every tenant's own PII configuration (canonical documents, then legacy ones not yet adopted). */
export async function listTenantPIIConfigs(
  env: AuditSettingsEnv
): Promise<Array<{ tenantId: string; config: TenantPIIConfig }>> {
  const adapter = requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical');
  const rows = await adapter.query<{ scope_id: string; document_json: string }>(
    `SELECT scope_id, document_json FROM tenant_settings_documents
     WHERE scope_type='tenant' AND category=? ORDER BY scope_id`,
    [AUDIT_PII_CATEGORY]
  );
  const byTenant = new Map<string, TenantPIIConfig>();
  for (const row of rows) {
    try {
      const data = JSON.parse(row.document_json) as Record<string, unknown>;
      if (isObject(data[AUDIT_PII_CONFIG_KEY]))
        byTenant.set(row.scope_id, data[AUDIT_PII_CONFIG_KEY] as unknown as TenantPIIConfig);
    } catch {
      // unreadable document: listed as having no custom configuration
    }
  }
  const documented = new Set(rows.map((row) => row.scope_id));
  if (env.AUTHRIM_CONFIG) {
    const listed = await env.AUTHRIM_CONFIG.list({ prefix: LEGACY_PII_CONFIG_KV_PREFIX });
    for (const key of listed.keys) {
      const tenantId = key.name.slice(LEGACY_PII_CONFIG_KV_PREFIX.length);
      if (documented.has(tenantId)) continue;
      try {
        const value = await env.AUTHRIM_CONFIG.get(key.name);
        const parsed: unknown = value ? JSON.parse(value) : null;
        if (isObject(parsed)) byTenant.set(tenantId, parsed as unknown as TenantPIIConfig);
      } catch {
        // skip unreadable legacy value
      }
    }
  }
  return [...byTenant].map(([tenantId, config]) => ({ tenantId, config }));
}
