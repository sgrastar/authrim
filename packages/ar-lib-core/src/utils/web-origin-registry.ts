import type { Env } from '../types/env';
import { ensureDatabaseAdapter, type DatabaseSource } from '../db';
import type { DatabaseAdapter } from '../db/adapter';
import { buildKVKey } from './tenant-context';
import { validateAllowedOrigins } from './custom-redirect';
import { getCacheTTL } from './cache-config';
import { createLogger } from './logger';

const log = createLogger().module('WEB_ORIGIN_REGISTRY');

export interface WebOriginRegistryEntry {
  origin: string;
  client_ids: string[];
  cors: {
    allowed: boolean;
  };
  csp: {
    frame_ancestors?: string[];
  };
  handoff_allowed: boolean;
  iframe_allowed: boolean;
  environment?: string;
}

export interface WebOriginRegistryDocument {
  origins: WebOriginRegistryEntry[];
}

export interface WebOriginRegistryWriteEntry {
  origin: string;
  cors?: {
    allowed?: boolean;
  };
  csp?: {
    frame_ancestors?: string[];
  };
  handoff_allowed?: boolean;
  iframe_allowed?: boolean;
  environment?: string | null;
}

export interface WebOriginRegistryWritePayload {
  origins: Array<string | WebOriginRegistryWriteEntry>;
}

interface WebOriginRegistryRow {
  origin: string;
  client_id: string;
  cors_allowed: number | boolean | null;
  csp_frame_ancestors: string | null;
  handoff_allowed: number | boolean | null;
  iframe_allowed: number | boolean | null;
  environment: string | null;
}

function cacheKey(tenantId: string, clientId: string): string {
  return buildKVKey('web-origin-registry', clientId, tenantId);
}

function toBoolean(value: number | boolean | null | undefined, defaultValue: boolean): boolean {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  return value === true || value === 1;
}

function parseFrameAncestors(value: string | null): string[] | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
      return parsed;
    }
  } catch {
    // Invalid persisted JSON should not break login metadata reads.
  }
  return undefined;
}

function normalizeRegistryInput(
  payload: WebOriginRegistryWritePayload
): WebOriginRegistryWriteEntry[] {
  const entries = payload.origins.map((entry) =>
    typeof entry === 'string' ? { origin: entry } : entry
  );
  const originValidations = entries.map((entry) => ({
    entry,
    validation: validateAllowedOrigins([entry.origin]),
  }));
  const validation = validateAllowedOrigins(entries.map((entry) => entry.origin));
  if (!validation.valid) {
    throw new Error(`Invalid web_origin_registry origins: ${validation.errors.join(', ')}`);
  }

  return validation.normalizedOrigins.map((origin) => {
    const original = originValidations.find(
      ({ validation }) => validation.valid && validation.normalizedOrigins[0] === origin
    )?.entry;
    const frameAncestors = original?.csp?.frame_ancestors;
    const frameAncestorsValidation = frameAncestors?.length
      ? validateAllowedOrigins(frameAncestors)
      : undefined;
    if (frameAncestorsValidation && !frameAncestorsValidation.valid) {
      throw new Error(
        `Invalid web_origin_registry frame_ancestors: ${frameAncestorsValidation.errors.join(', ')}`
      );
    }
    return {
      origin,
      cors: { allowed: original?.cors?.allowed ?? true },
      csp: {
        frame_ancestors: frameAncestorsValidation?.normalizedOrigins,
      },
      handoff_allowed: original?.handoff_allowed ?? true,
      iframe_allowed: original?.iframe_allowed ?? false,
      environment: original?.environment ?? undefined,
    };
  });
}

function rowToEntry(row: WebOriginRegistryRow): WebOriginRegistryEntry {
  const frameAncestors = parseFrameAncestors(row.csp_frame_ancestors);
  return {
    origin: row.origin,
    client_ids: [row.client_id],
    cors: { allowed: toBoolean(row.cors_allowed, true) },
    csp: frameAncestors?.length ? { frame_ancestors: frameAncestors } : {},
    handoff_allowed: toBoolean(row.handoff_allowed, true),
    iframe_allowed: toBoolean(row.iframe_allowed, false),
    environment: row.environment ?? undefined,
  };
}

export function buildWebOriginRegistryFromOrigins(
  clientId: string,
  origins: string[],
  options: { iframeAllowed?: boolean } = {}
): WebOriginRegistryDocument {
  const validation = validateAllowedOrigins(origins);
  const iframeAllowed = options.iframeAllowed === true;
  return {
    origins: validation.valid
      ? validation.normalizedOrigins.map((origin) => ({
          origin,
          client_ids: [clientId],
          cors: { allowed: true },
          csp: iframeAllowed ? { frame_ancestors: [origin] } : {},
          handoff_allowed: true,
          iframe_allowed: iframeAllowed,
        }))
      : [],
  };
}

export function validateWebOriginRegistryPayload(
  payload: WebOriginRegistryWritePayload
): { valid: true } | { valid: false; error: string } {
  try {
    normalizeRegistryInput(payload);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid web_origin_registry',
    };
  }
}

export async function getWebOriginRegistry(
  env: Env,
  tenantId: string,
  clientId: string,
  source: DatabaseSource | DatabaseAdapter
): Promise<WebOriginRegistryDocument> {
  const key = cacheKey(tenantId, clientId);

  if (env.CLIENTS_CACHE) {
    const cached = await env.CLIENTS_CACHE.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as WebOriginRegistryDocument;
      } catch {
        await env.CLIENTS_CACHE.delete(key).catch(() => undefined);
      }
    }
  }

  const adapter = 'query' in source ? source : ensureDatabaseAdapter(source, 'web-origin-registry');
  const rows = await adapter.query<WebOriginRegistryRow>(
    `SELECT origin, client_id, cors_allowed, csp_frame_ancestors, handoff_allowed, iframe_allowed, environment
       FROM web_origin_registry
      WHERE tenant_id = ? AND client_id = ? AND is_active = 1
      ORDER BY origin ASC`,
    [tenantId, clientId]
  );
  const document: WebOriginRegistryDocument = {
    origins: rows.map(rowToEntry),
  };

  if (env.CLIENTS_CACHE) {
    try {
      // Reuse the policy TTL tier: origin registry changes are security-sensitive and
      // should converge faster than general client display metadata.
      const ttl = await getCacheTTL(env, 'policy', clientId);
      await env.CLIENTS_CACHE.put(key, JSON.stringify(document), { expirationTtl: ttl });
    } catch {
      log.warn('Failed to cache web origin registry');
    }
  }

  return document;
}

export async function replaceWebOriginRegistry(
  adapter: DatabaseAdapter,
  tenantId: string,
  clientId: string,
  payload: WebOriginRegistryWritePayload
): Promise<WebOriginRegistryDocument> {
  const entries = normalizeRegistryInput(payload);
  const now = Math.floor(Date.now() / 1000);

  await adapter.execute('DELETE FROM web_origin_registry WHERE tenant_id = ? AND client_id = ?', [
    tenantId,
    clientId,
  ]);

  for (const entry of entries) {
    await adapter.execute(
      `INSERT INTO web_origin_registry (
        id, tenant_id, client_id, origin, cors_allowed, csp_frame_ancestors,
        handoff_allowed, iframe_allowed, environment, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        crypto.randomUUID(),
        tenantId,
        clientId,
        entry.origin,
        entry.cors?.allowed === false ? 0 : 1,
        entry.csp?.frame_ancestors?.length ? JSON.stringify(entry.csp.frame_ancestors) : null,
        entry.handoff_allowed === false ? 0 : 1,
        entry.iframe_allowed === true ? 1 : 0,
        entry.environment ?? null,
        now,
        now,
      ]
    );
  }

  return {
    origins: entries.map((entry) => ({
      origin: entry.origin,
      client_ids: [clientId],
      cors: { allowed: entry.cors?.allowed !== false },
      csp: entry.csp?.frame_ancestors?.length ? { frame_ancestors: entry.csp.frame_ancestors } : {},
      handoff_allowed: entry.handoff_allowed !== false,
      iframe_allowed: entry.iframe_allowed === true,
      environment: entry.environment ?? undefined,
    })),
  };
}

export async function invalidateWebOriginRegistryCache(
  env: Env,
  tenantId: string,
  clientId: string
): Promise<void> {
  if (!env.CLIENTS_CACHE) {
    return;
  }
  await env.CLIENTS_CACHE.delete(cacheKey(tenantId, clientId));
}

export async function isIframeOidcAuthEnabled(env: Env, tenantId: string): Promise<boolean> {
  const tenantFlagKey = `flag:tenant:${tenantId}:ENABLE_IFRAME_OIDC_AUTH`;
  const globalFlagKey = 'flag:ENABLE_IFRAME_OIDC_AUTH';

  for (const key of [tenantFlagKey, globalFlagKey]) {
    try {
      const value = await env.AUTHRIM_CONFIG?.get(key);
      if (value === 'true') {
        return true;
      }
      if (value === 'false') {
        return false;
      }
    } catch {
      // Treat unavailable dynamic config as disabled-by-default.
    }
  }

  return env.ENABLE_IFRAME_OIDC_AUTH === 'true';
}
