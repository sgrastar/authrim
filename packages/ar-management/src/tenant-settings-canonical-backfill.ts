import { getCategoriesForScope } from '@authrim/ar-lib-core';
import type { SettingsCanonicalStore } from '@authrim/ar-lib-core/utils/settings-manager';
import { generateVersion, settingsStorageKey } from '@authrim/ar-lib-core/utils/settings-manager';
import { sanitizeObject } from '@authrim/ar-lib-core/utils/security';

interface KvReader {
  get(key: string): Promise<string | null>;
}

interface ClientDatabase {
  queryOne(sql: string, params: unknown[]): Promise<ClientRow | null>;
}

const EXTRA_TENANT_CATEGORIES = [
  'agent-access',
  'certification-profile',
  'directory-connectors',
  'email-settings',
  'saml',
  'scim',
  'step-up',
] as const;

export const TENANT_SETTINGS_BACKFILL_CATEGORIES = Object.freeze(
  [...new Set([...getCategoriesForScope('tenant'), ...EXTRA_TENANT_CATEGORIES])].sort()
);
export const CLIENT_SETTINGS_BACKFILL_CATEGORIES = Object.freeze(
  [...getCategoriesForScope('client')].sort()
);

interface BackfillCursor {
  version: 1;
  stage: 'tenant' | 'clients';
  tenantCategoryIndex: number;
  afterClientId: string;
  clientId: string | null;
  clientCategoryIndex: number;
}

interface ClientRow {
  client_id: string;
}

function invalid(): never {
  throw new Error('tenant_settings_backfill_invalid');
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function initialCursor(): BackfillCursor {
  return {
    version: 1,
    stage: 'tenant',
    tenantCategoryIndex: 0,
    afterClientId: '',
    clientId: null,
    clientCategoryIndex: 0,
  };
}

function parseCursor(value: string | null): BackfillCursor {
  if (value === null) return initialCursor();
  let cursor: unknown;
  try {
    cursor = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) invalid();
  const raw = cursor as Record<string, unknown>;
  if (
    Object.keys(raw).sort().join(',') !==
      'afterClientId,clientCategoryIndex,clientId,stage,tenantCategoryIndex,version' ||
    raw.version !== 1 ||
    !['tenant', 'clients'].includes(String(raw.stage)) ||
    !Number.isSafeInteger(raw.tenantCategoryIndex) ||
    (raw.tenantCategoryIndex as number) < 0 ||
    (raw.tenantCategoryIndex as number) > TENANT_SETTINGS_BACKFILL_CATEGORIES.length ||
    typeof raw.afterClientId !== 'string' ||
    (raw.afterClientId !== '' && !validId(raw.afterClientId)) ||
    (raw.clientId !== null && !validId(raw.clientId)) ||
    !Number.isSafeInteger(raw.clientCategoryIndex) ||
    (raw.clientCategoryIndex as number) < 0 ||
    (raw.clientCategoryIndex as number) >= CLIENT_SETTINGS_BACKFILL_CATEGORIES.length
  )
    invalid();
  const parsed = raw as unknown as BackfillCursor;
  if (
    (parsed.stage === 'tenant' &&
      (parsed.clientId !== null ||
        parsed.afterClientId !== '' ||
        parsed.clientCategoryIndex !== 0)) ||
    (parsed.stage === 'clients' &&
      (parsed.tenantCategoryIndex !== TENANT_SETTINGS_BACKFILL_CATEGORIES.length ||
        (parsed.clientId !== null && parsed.clientId <= parsed.afterClientId)))
  )
    invalid();
  return parsed;
}

function parseDocument(raw: string): Record<string, unknown> {
  if (new TextEncoder().encode(raw).byteLength > 1048576) invalid();
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return sanitizeObject(value as Record<string, unknown>);
}

async function backfillDocument(input: {
  canonical: SettingsCanonicalStore;
  sources: readonly KvReader[];
  category: string;
  scope: { type: 'tenant'; id: string } | { type: 'client'; tenantId: string; id: string };
}): Promise<void> {
  if (await input.canonical.load(input.category, input.scope)) return;
  const key = settingsStorageKey(input.category, input.scope);
  let raw: string | null = null;
  for (const source of input.sources) {
    raw = await source.get(key);
    if (raw !== null) break;
  }
  if (raw === null) return;
  const data = parseDocument(raw);
  const version = generateVersion(data);
  const created = await input.canonical.create(input.category, input.scope, { data, version });
  if (created.version === version) {
    await input.canonical.markProjected(input.category, input.scope, version);
  }
}

/**
 * Materialize existing exact Settings keys into Admin D1 before export capture. The cursor is
 * durable and bounded; no eventually-consistent KV listing can decide backup completeness.
 */
export async function backfillTenantSettingsCanonicalPage(input: {
  tenantId: string;
  canonical: SettingsCanonicalStore;
  sources: readonly KvReader[];
  clientDatabase: ClientDatabase;
  cursor: string | null;
  limit?: number;
}): Promise<{ cursor: string | null; done: boolean }> {
  if (
    !validId(input.tenantId) ||
    input.sources.length < 1 ||
    input.sources.length > 4 ||
    new Set(input.sources).size !== input.sources.length
  )
    invalid();
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
  const cursor = parseCursor(input.cursor);
  let processed = 0;

  while (processed < limit) {
    if (cursor.stage === 'tenant') {
      if (cursor.tenantCategoryIndex === TENANT_SETTINGS_BACKFILL_CATEGORIES.length) {
        cursor.stage = 'clients';
        continue;
      }
      const category = TENANT_SETTINGS_BACKFILL_CATEGORIES[cursor.tenantCategoryIndex];
      await backfillDocument({
        canonical: input.canonical,
        sources: input.sources,
        category,
        scope: { type: 'tenant', id: input.tenantId },
      });
      cursor.tenantCategoryIndex++;
      processed++;
      continue;
    }

    if (cursor.clientId === null) {
      const next = await input.clientDatabase.queryOne(
        `SELECT client_id FROM oauth_clients
        WHERE tenant_id=? AND client_id>? ORDER BY client_id LIMIT 1`,
        [input.tenantId, cursor.afterClientId]
      );
      if (!next) return { cursor: null, done: true };
      if (!validId(next.client_id) || next.client_id <= cursor.afterClientId) invalid();
      cursor.clientId = next.client_id;
      cursor.clientCategoryIndex = 0;
    }

    const category = CLIENT_SETTINGS_BACKFILL_CATEGORIES[cursor.clientCategoryIndex];
    await backfillDocument({
      canonical: input.canonical,
      sources: input.sources,
      category,
      scope: { type: 'client', tenantId: input.tenantId, id: cursor.clientId },
    });
    cursor.clientCategoryIndex++;
    processed++;
    if (cursor.clientCategoryIndex === CLIENT_SETTINGS_BACKFILL_CATEGORIES.length) {
      cursor.afterClientId = cursor.clientId;
      cursor.clientId = null;
      cursor.clientCategoryIndex = 0;
    }
  }

  return { cursor: JSON.stringify(cursor), done: false };
}
