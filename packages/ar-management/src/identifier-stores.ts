import type { Context } from 'hono';
import {
  createAuditLog,
  getTenantIdFromContext,
  requireDedicatedAdminDatabaseAdapter,
  sha256Hex,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';

/**
 * Identifiers people already have at another identity provider, imported so a
 * persistent_identifier step with `stored` (prefer or require) releases them unchanged: the
 * IdPs whose identifiers cannot be made again from a salt (Shibboleth stored IDs, a cloud IdP).
 *
 * The CSV has a header `audience,source_value,identifier`: who it was issued to (the SP entity ID,
 * the OIDC client ID or sector host, as the step resolves it), the value it belongs to (the user
 * name or account ID the step reads), and the identifier before protocol framing (no scope, no
 * NameQualifiers). The source value is kept only as its SHA-256. Nothing imported is echoed back.
 */

type AdminContext = Context<{ Bindings: Env }>;

const STORE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_AUDIENCE = 2048;
const MAX_IDENTIFIER = 512;
/** D1 binds at most 100 parameters: 2 fixed and 4 per row. */
const LOOKUP_CHUNK = 24;

const invalid = (c: AdminContext, description: string) =>
  c.json({ error: 'invalid_request', error_description: description }, 400);

function adapterOf(c: AdminContext): DatabaseAdapter {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'mapped-identifier-store');
}

export async function adminIdentifierStoresListHandler(c: AdminContext): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const rows = await adapterOf(c).query<{ store_name: string; count: number; updated_at: number }>(
    `SELECT store_name, COUNT(*) AS count, MAX(updated_at) AS updated_at
       FROM mapped_identifier_values
      WHERE tenant_id = ?
      GROUP BY store_name
      ORDER BY store_name`,
    [tenantId]
  );
  return c.json({
    stores: rows.map((row) => ({
      name: row.store_name,
      count: Number(row.count),
      updatedAt: Number(row.updated_at),
    })),
  });
}

interface ImportRow {
  audience: string;
  sourceHash: string;
  identifier: string;
}

/**
 * POST `{ csv, replace? }`. All rows are written or none. A row the store already holds with the
 * same identifier is left as it is; one with another identifier is replaced only with `replace`;
 * an identifier that already belongs to someone else (in the file or the store, for the same
 * audience) refuses the import.
 */
export async function adminIdentifierStoreImportHandler(c: AdminContext): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const store = c.req.param('name') ?? '';
  if (!STORE_NAME.test(store)) return invalid(c, 'name is invalid');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return invalid(c, 'Request body must be valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return invalid(c, 'Request body must be an object');
  }
  const { csv, replace } = body as Record<string, unknown>;
  if (typeof csv !== 'string' || csv.length === 0) return invalid(c, 'csv is required');
  if (new TextEncoder().encode(csv).length > MAX_CSV_BYTES) return invalid(c, 'csv is too large');
  if (replace !== undefined && typeof replace !== 'boolean') {
    return invalid(c, 'replace must be a boolean');
  }

  const parsed = parseCsv(csv);
  if (!parsed) return invalid(c, 'csv is not valid');
  const [header, ...records] = parsed.filter((row) => !(row.length === 1 && row[0] === ''));
  if (!header || header.join(',') !== 'audience,source_value,identifier') {
    return invalid(c, 'csv header must be audience,source_value,identifier');
  }
  if (records.length === 0) return invalid(c, 'csv has no rows');
  if (records.length > MAX_ROWS) return invalid(c, `csv has more than ${MAX_ROWS} rows`);

  // One identifier per person and audience, and no identifier for two people, within the file.
  const byKey = new Map<string, ImportRow>();
  const ownerOf = new Map<string, string>();
  for (const [index, record] of records.entries()) {
    const line = index + 2;
    if (record.length !== 3) return invalid(c, `row ${line} must have three fields`);
    const [audience, sourceValue, identifier] = record;
    if (!audience || audience.length > MAX_AUDIENCE) return invalid(c, `row ${line}: audience`);
    if (!sourceValue) return invalid(c, `row ${line}: source_value`);
    if (!identifier || identifier.length > MAX_IDENTIFIER || /\s/u.test(identifier)) {
      return invalid(c, `row ${line}: identifier`);
    }
    const row = { audience, sourceHash: await sha256Hex(sourceValue), identifier };
    const key = `${audience}\n${row.sourceHash}`;
    const seen = byKey.get(key);
    if (seen && seen.identifier !== identifier) {
      return invalid(c, `row ${line}: another identifier for the same person and audience`);
    }
    const owner = ownerOf.get(`${audience}\n${identifier}`);
    if (owner && owner !== row.sourceHash) {
      return invalid(c, `row ${line}: the identifier belongs to another person in the file`);
    }
    byKey.set(key, row);
    ownerOf.set(`${audience}\n${identifier}`, row.sourceHash);
  }

  const adapter = adapterOf(c);
  const rows = [...byKey.values()];
  const existing = new Map<string, string>();
  const takenBy = new Map<string, string>();
  for (let start = 0; start < rows.length; start += LOOKUP_CHUNK) {
    const chunk = rows.slice(start, start + LOOKUP_CHUNK);
    let found: Array<{ audience: string; source_hash: string; identifier: string }>;
    try {
      found = await adapter.query<{
        audience: string;
        source_hash: string;
        identifier: string;
      }>(
        `SELECT audience, source_hash, identifier FROM mapped_identifier_values
        WHERE tenant_id = ? AND store_name = ?
          AND ((${chunk.map(() => '(audience = ? AND source_hash = ?)').join(' OR ')})
            OR (${chunk.map(() => '(audience = ? AND identifier = ?)').join(' OR ')}))`,
        [
          tenantId,
          store,
          ...chunk.flatMap((row) => [row.audience, row.sourceHash]),
          ...chunk.flatMap((row) => [row.audience, row.identifier]),
        ]
      );
    } catch {
      return c.json(
        { error: 'server_error', error_description: 'The store could not be read' },
        500
      );
    }
    for (const row of found) {
      existing.set(`${row.audience}\n${row.source_hash}`, row.identifier);
      takenBy.set(`${row.audience}\n${row.identifier}`, row.source_hash);
    }
  }

  let created = 0;
  let replaced = 0;
  let unchanged = 0;
  let conflicts = 0;
  let foreign = 0;
  const now = Date.now();
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  for (const row of rows) {
    const current = existing.get(`${row.audience}\n${row.sourceHash}`);
    const holder = takenBy.get(`${row.audience}\n${row.identifier}`);
    if (holder && holder !== row.sourceHash) {
      foreign++;
      continue;
    }
    if (current === row.identifier) {
      unchanged++;
      continue;
    }
    if (current !== undefined && replace !== true) {
      conflicts++;
      continue;
    }
    statements.push(
      current === undefined
        ? {
            sql: `INSERT INTO mapped_identifier_values
                    (tenant_id, store_name, audience, source_hash, identifier, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            params: [tenantId, store, row.audience, row.sourceHash, row.identifier, now, now],
          }
        : {
            sql: `UPDATE mapped_identifier_values SET identifier = ?, updated_at = ?
                   WHERE tenant_id = ? AND store_name = ? AND audience = ? AND source_hash = ?`,
            params: [row.identifier, now, tenantId, store, row.audience, row.sourceHash],
          }
    );
    if (current === undefined) created++;
    else replaced++;
  }
  if (foreign > 0 || conflicts > 0) {
    return c.json(
      {
        error: 'conflict',
        error_description:
          foreign > 0
            ? 'Some identifiers already belong to other people in this store'
            : 'Some people already have another identifier in this store; import with replace to change them',
        conflicts,
        identifiersOfOthers: foreign,
      },
      409
    );
  }
  if (statements.length > 0) {
    try {
      await adapter.batch(statements);
    } catch {
      // A concurrent import took a key or an identifier: nothing of this one was written.
      return c.json(
        { error: 'conflict', error_description: 'The store changed during the import; retry' },
        409
      );
    }
    const admin = (c as unknown as { get(key: string): unknown }).get(
      'adminAuth'
    ) as AdminAuthContext | null;
    await createAuditLog(c.env, {
      tenantId,
      userId: admin?.userId ?? 'unknown',
      action: 'identifier_store.imported',
      resource: 'identifier_store',
      resourceId: store,
      severity: 'warning',
      ipAddress: c.req.header('CF-Connecting-IP') ?? 'unknown',
      userAgent: c.req.header('User-Agent') ?? 'unknown',
      metadata: JSON.stringify({ created, replaced, unchanged }),
    });
  }
  return c.json({ store, created, replaced, unchanged });
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. Null when a quote is left open. */
function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === '') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (quoted) return null;
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
