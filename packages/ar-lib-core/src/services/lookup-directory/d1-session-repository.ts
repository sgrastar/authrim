import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import type { D1ConsistencyRequest } from '../control-plane/control-plane-contracts';

export interface D1SessionReadResult<T> {
  rows: T[];
  bookmark: string | null;
  primaryRechecked: boolean;
}

type SessionCapableD1 = Pick<D1Database, 'withSession'>;

function createSession(db: SessionCapableD1, consistency: D1ConsistencyRequest): D1DatabaseSession {
  switch (consistency.consistencyClass) {
    case 'replica_eligible':
      return db.withSession('first-unconstrained');
    case 'primary_required':
      return db.withSession('first-primary');
    case 'read_after_write':
      if (!consistency.bookmark) throw new Error('d1_read_after_write_bookmark_required');
      return db.withSession(consistency.bookmark);
  }
}

async function querySession<T>(
  session: D1DatabaseSession,
  sql: string,
  params: readonly unknown[]
): Promise<T[]> {
  const statement = params.length > 0 ? session.prepare(sql).bind(...params) : session.prepare(sql);
  const result = await statement.all<T>();
  if (!result.success) throw new Error('d1_session_query_failed');
  return result.results ?? [];
}

export class D1SessionReadRepository {
  constructor(private readonly db: SessionCapableD1) {
    if (!db || typeof db.withSession !== 'function') throw new Error('d1_sessions_api_required');
  }

  async query<T>(input: {
    sql: string;
    params?: readonly unknown[];
    consistency: D1ConsistencyRequest;
    primaryRecheckOnEmpty?: boolean;
  }): Promise<D1SessionReadResult<T>> {
    const session = createSession(this.db, input.consistency);
    const rows = await querySession<T>(session, input.sql, input.params ?? []);
    if (
      rows.length > 0 ||
      input.consistency.consistencyClass !== 'replica_eligible' ||
      input.primaryRecheckOnEmpty !== true
    ) {
      return { rows, bookmark: session.getBookmark(), primaryRechecked: false };
    }

    const primary = this.db.withSession('first-primary');
    return {
      rows: await querySession<T>(primary, input.sql, input.params ?? []),
      bookmark: primary.getBookmark(),
      primaryRechecked: true,
    };
  }

  async queryOne<T>(input: {
    sql: string;
    params?: readonly unknown[];
    consistency: D1ConsistencyRequest;
    primaryRecheckOnEmpty?: boolean;
  }): Promise<{ row: T | null; bookmark: string | null; primaryRechecked: boolean }> {
    const result = await this.query<T>(input);
    if (result.rows.length > 1) throw new Error('d1_session_query_one_multiple_rows');
    return {
      row: result.rows[0] ?? null,
      bookmark: result.bookmark,
      primaryRechecked: result.primaryRechecked,
    };
  }
}
