/**
 * Statement definition lookups for records
 *
 * A consent record names the statement and version it was given for. Showing it (a title, a
 * category) needs the definition, which lives in the tenant metadata database while the record
 * lives in the account database, so the definitions are fetched by id and joined in the
 * application. A definition that cannot be found is simply absent from the result: the record is
 * evidence of an agreement and stays visible without it.
 */

import type { DatabaseAdapter } from '../db';

/** Bound parameters per statement stay well under the D1 limit of 100. */
const IN_LIST_CHUNK = 40;

export interface StatementDefinitionSummary {
  slug: string;
  category: string;
}

export interface StatementLocalizationSummary {
  title: string | null;
  description: string | null;
}

export interface StatementDefinitionLookup {
  statements: Map<string, StatementDefinitionSummary>;
  /** Keyed by version id; the requested language, else English. */
  localizations: Map<string, StatementLocalizationSummary>;
}

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += IN_LIST_CHUNK)
    out.push(values.slice(i, i + IN_LIST_CHUNK));
  return out;
}

const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(', ');

/**
 * Read the display definitions of the statements and versions that records refer to, from the
 * metadata database alone.
 */
export async function lookupStatementDefinitions(
  metadata: DatabaseAdapter,
  tenantId: string,
  refs: { statementIds: Iterable<string>; versionIds: Iterable<string> },
  language: string
): Promise<StatementDefinitionLookup> {
  const statementIds = [...new Set(refs.statementIds)];
  const versionIds = [...new Set(refs.versionIds)];
  const statements = new Map<string, StatementDefinitionSummary>();
  const localizations = new Map<string, StatementLocalizationSummary>();

  for (const ids of chunks(statementIds)) {
    const rows = await metadata.query<{ id: string; slug: string; category: string }>(
      `SELECT id, slug, category FROM consent_statements
        WHERE tenant_id = ? AND id IN (${placeholders(ids.length)})`,
      [tenantId, ...ids]
    );
    for (const row of rows) statements.set(row.id, { slug: row.slug, category: row.category });
  }

  for (const ids of chunks(versionIds)) {
    const rows = await metadata.query<{
      version_id: string;
      language: string;
      title: string | null;
      description: string | null;
    }>(
      `SELECT version_id, language, title, description FROM consent_statement_localizations
        WHERE tenant_id = ? AND language IN (?, 'en') AND version_id IN (${placeholders(ids.length)})`,
      [tenantId, language, ...ids]
    );
    for (const id of ids) {
      const preferred = rows.find((row) => row.version_id === id && row.language === language);
      const english = rows.find((row) => row.version_id === id && row.language === 'en');
      const chosen = preferred ?? english;
      if (chosen) {
        localizations.set(id, {
          // Title and description fall back to English independently, as the screen does.
          title: preferred?.title ?? english?.title ?? null,
          description: preferred?.description ?? english?.description ?? null,
        });
      }
    }
  }

  return { statements, localizations };
}
