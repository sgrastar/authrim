/**
 * Local D1 batch executor.
 *
 * Control bootstrap code issues parameterised D1 batches through the Cloudflare REST API. Wrangler
 * has no parameter binding, so locally the parameters are inlined as SQL literals and the whole
 * batch runs as one script; `wrangler d1 execute --json` returns one result per statement, which
 * keeps the response shape callers rely on (SELECT results at the same indexes).
 */

import {
  executeD1Command,
  type D1BatchExecutionResult,
  type D1BatchStatement,
  type LocalWranglerTarget,
} from '../cloudflare.js';

type SqlParam = string | number | boolean | null;

function literal(value: SqlParam): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('local_d1_batch_param_not_finite');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${value.replace(/'/gu, "''")}'`;
}

/** Replace `?` placeholders (outside string literals) with the given parameters, in order. */
export function inlineD1Params(sql: string, params: readonly unknown[] = []): string {
  let index = 0;
  let quote: string | null = null;
  let output = '';
  for (let position = 0; position < sql.length; position += 1) {
    const char = sql[position]!;
    if (quote) {
      output += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      output += char;
      continue;
    }
    if (char === '?') {
      if (index >= params.length) throw new Error('local_d1_batch_param_missing');
      output += literal(params[index] as SqlParam);
      index += 1;
      continue;
    }
    output += char;
  }
  if (index !== params.length) throw new Error('local_d1_batch_param_unused');
  return output;
}

function parseResults(stdout: string): Array<{ results?: unknown[]; success?: boolean }> {
  const candidates = [stdout.trim(), stdout.slice(Math.max(0, stdout.indexOf('[\n'))).trim()];
  for (const candidate of candidates) {
    if (!candidate.startsWith('[')) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed as Array<{ results?: unknown[]; success?: boolean }>;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('local_d1_batch_output_unparseable');
}

export function createLocalD1BatchExecutor(
  target: LocalWranglerTarget
): (databaseId: string, batch: readonly D1BatchStatement[]) => Promise<D1BatchExecutionResult[]> {
  return async (databaseId, batch) => {
    if (batch.length === 0) throw new Error('local_d1_batch_empty');
    const script = batch
      .map((statement) => {
        const sql = inlineD1Params(statement.sql, statement.params ?? []).trim();
        return sql.endsWith(';') ? sql : `${sql};`;
      })
      .join('\n');
    const { stdout } = await executeD1Command(databaseId, script, { json: true, target });
    const results = parseResults(stdout);
    if (results.length !== batch.length) {
      throw new Error(`local_d1_batch_result_count_mismatch:${results.length}:${batch.length}`);
    }
    return results.map((entry) => ({
      success: true as const,
      results: entry.results ?? [],
    }));
  };
}
