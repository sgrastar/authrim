/**
 * Test helpers for identity assurance (IAL) in token endpoint tests: evidence rows, and an account
 * database that answers (or fails) the evidence read and counts it.
 */

import type { Mock } from 'vitest';
import type { MockD1Database } from './mocks';

const NOW = Date.now();

/** A row of the evidence read (`resolveUserEffectiveIAL`). */
export function evidenceRow(level: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `ev-${level}`,
    assurance_framework: 'nist_800_63',
    assurance_level: level,
    verified_at: NOW - 1000,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

export function isEvidenceRead(sql: string): boolean {
  return sql.includes('assurance_evidence');
}

/**
 * Make a D1 mock answer the evidence read with `rows` (or fail it), and return the evidence reads
 * seen so far.
 */
export function useEvidenceD1(
  db: MockD1Database,
  rows: Array<Record<string, unknown>> | 'fail'
): { reads: string[] } {
  const reads: string[] = [];
  const base = db.prepare.getMockImplementation();
  if (!base) throw new Error('The D1 mock has no prepare implementation');
  db.prepare.mockImplementation((sql: string) => {
    const statement = base(sql);
    if (isEvidenceRead(sql)) {
      reads.push(sql);
      statement.all.mockImplementation(async () => {
        if (rows === 'fail') throw new Error('account database is down');
        return { results: rows, success: true };
      });
    }
    return statement;
  });
  return { reads };
}

/**
 * The same for an account database that is a database adapter (`query`).
 */
export function useEvidenceAdapter(
  adapter: { query: Mock<(sql: string, ...rest: unknown[]) => Promise<unknown>> },
  rows: Array<Record<string, unknown>> | 'fail'
): { reads: string[] } {
  const reads: string[] = [];
  const base = adapter.query.getMockImplementation() ?? (() => Promise.resolve([]));
  adapter.query.mockImplementation((sql: string, ...rest: unknown[]) => {
    if (!isEvidenceRead(sql)) return base(sql, ...rest);
    reads.push(sql);
    return rows === 'fail'
      ? Promise.reject(new Error('account database is down'))
      : Promise.resolve(rows);
  });
  return { reads };
}
