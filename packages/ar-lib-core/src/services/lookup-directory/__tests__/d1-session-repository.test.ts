import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { createD1ConsistencyRequest } from '../../control-plane/control-plane-contracts';
import { D1SessionReadRepository } from '../d1-session-repository';

function session(rows: unknown[], bookmark: string | null, success = true): D1DatabaseSession {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn(async () => ({ success, results: rows, meta: {} })),
    })),
    batch: vi.fn(),
    getBookmark: vi.fn(() => bookmark),
  } as unknown as D1DatabaseSession;
}

function database(sessions: D1DatabaseSession[]): {
  db: Pick<D1Database, 'withSession'>;
  withSession: ReturnType<typeof vi.fn>;
} {
  const withSession = vi.fn();
  for (const value of sessions) withSession.mockReturnValueOnce(value);
  return { db: { withSession } as Pick<D1Database, 'withSession'>, withSession };
}

describe('D1SessionReadRepository', () => {
  it('uses a replica-eligible session and rechecks an empty result once on primary', async () => {
    const replica = session([], 'replica-bookmark');
    const primary = session([{ id: 'account-a' }], 'primary-bookmark');
    const { db, withSession } = database([replica, primary]);

    const result = await new D1SessionReadRepository(db).query<{ id: string }>({
      sql: 'SELECT id FROM lookup_identifiers WHERE identifier_blind_digest = ?',
      params: ['digest'],
      consistency: createD1ConsistencyRequest('replica_eligible'),
      primaryRecheckOnEmpty: true,
    });

    expect(withSession.mock.calls).toEqual([['first-unconstrained'], ['first-primary']]);
    expect(result).toEqual({
      rows: [{ id: 'account-a' }],
      bookmark: 'primary-bookmark',
      primaryRechecked: true,
    });
  });

  it('does not recheck non-empty replica results or cross-request negative-cache them', async () => {
    const replica = session([{ id: 'account-a' }], 'replica-bookmark');
    const { db, withSession } = database([replica]);
    const result = await new D1SessionReadRepository(db).query<{ id: string }>({
      sql: 'SELECT id FROM lookup_identifiers',
      consistency: createD1ConsistencyRequest('replica_eligible'),
      primaryRecheckOnEmpty: true,
    });
    expect(withSession).toHaveBeenCalledTimes(1);
    expect(result.primaryRechecked).toBe(false);
  });

  it('uses first-primary for security reads and a supplied bookmark for read-after-write', async () => {
    const first = database([session([], 'primary')]);
    await new D1SessionReadRepository(first.db).query({
      sql: 'SELECT 1',
      consistency: createD1ConsistencyRequest('primary_required'),
      primaryRecheckOnEmpty: true,
    });
    expect(first.withSession).toHaveBeenCalledWith('first-primary');

    const second = database([session([], 'after-write')]);
    await new D1SessionReadRepository(second.db).query({
      sql: 'SELECT 1',
      consistency: createD1ConsistencyRequest('read_after_write', 'bookmark-123'),
    });
    expect(second.withSession).toHaveBeenCalledWith('bookmark-123');
  });

  it('fails closed when Sessions API or D1 query success is unavailable', async () => {
    expect(() => new D1SessionReadRepository({} as Pick<D1Database, 'withSession'>)).toThrow(
      'd1_sessions_api_required'
    );

    const { db } = database([session([], null, false)]);
    await expect(
      new D1SessionReadRepository(db).query({
        sql: 'SELECT 1',
        consistency: createD1ConsistencyRequest('primary_required'),
      })
    ).rejects.toThrow('d1_session_query_failed');
  });
});
