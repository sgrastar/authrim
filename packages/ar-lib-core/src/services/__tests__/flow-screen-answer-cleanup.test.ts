import { describe, expect, it } from 'vitest';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { contextWithoutScreenAnswers, expireFlowInteractions } from '../flow-screen-answer-cleanup';

const NOW = 1_800_000_000;
const answers = { 'survey:step': { plan: 'pro' } };

function seed(
  db: ReturnType<typeof sqliteAdapter>['db'],
  rows: Array<{ id: string; tenant?: string; state: string; expiresAt?: number; context: unknown }>
) {
  // Only the interactions matter here, not the flows they name.
  db.exec('PRAGMA foreign_keys = OFF');
  const insert = db.prepare(
    `INSERT INTO flow_interactions
       (id, tenant_id, flow_id, flow_version_id, state, contract_hash, signature, expires_at,
        created_at, updated_at, context_json)
     VALUES (?, ?, 'flow', 'version', ?, 'hash', 'signature', ?, ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.tenant ?? 'tenant_a',
      row.state,
      row.expiresAt ?? NOW - 1,
      NOW - 3600,
      NOW - 3600,
      typeof row.context === 'string' ? row.context : JSON.stringify(row.context)
    );
  }
}

const rowOf = (db: ReturnType<typeof sqliteAdapter>['db'], id: string) =>
  db.prepare('SELECT state, context_json FROM flow_interactions WHERE id = ?').get(id) as {
    state: string;
    context_json: string;
  };

describe('expireFlowInteractions', () => {
  it('expires the open interactions past their expiry, removing their screen answers', async () => {
    const { db, adapter } = sqliteAdapter('core');
    seed(db, [
      { id: 'left', state: 'active', context: { locale: 'ja', screen_answers: answers } },
      { id: 'plain', state: 'created', context: { locale: 'en' } },
      { id: 'later', state: 'active', expiresAt: NOW + 600, context: { screen_answers: answers } },
      { id: 'other', tenant: 'tenant_b', state: 'active', context: { screen_answers: answers } },
    ]);

    await expect(expireFlowInteractions(adapter, 'tenant_a', NOW)).resolves.toBe(2);

    expect(rowOf(db, 'left')).toEqual({ state: 'expired', context_json: '{"locale":"ja"}' });
    expect(rowOf(db, 'plain')).toEqual({ state: 'expired', context_json: '{"locale":"en"}' });
    // Still open: the steps to come may branch on them. Another tenant is not touched.
    expect(JSON.parse(rowOf(db, 'later').context_json)).toEqual({ screen_answers: answers });
    expect(rowOf(db, 'other').state).toBe('active');
  });

  it('expires an interaction whose context it cannot read, leaving the context as it is', async () => {
    const { db, adapter } = sqliteAdapter('core');
    seed(db, [{ id: 'garbled', state: 'active', context: '{"screen_answers": ' }]);

    await expect(expireFlowInteractions(adapter, 'tenant_a', NOW)).resolves.toBe(1);
    expect(rowOf(db, 'garbled')).toEqual({
      state: 'expired',
      context_json: '{"screen_answers": ',
    });
  });

  it('reads and writes back on PostgreSQL, a context that is not JSON included', async () => {
    const executed: Array<{ sql: string; params?: unknown[] }> = [];
    const adapter = {
      getType: () => 'postgres' as const,
      query: async () => [
        { id: 'left', context_json: JSON.stringify({ locale: 'ja', screen_answers: answers }) },
        { id: 'garbled', context_json: '{"screen_answers": ' },
      ],
      batch: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
        executed.push(...statements);
        return statements.map(() => ({ success: true, rowsAffected: 1 }));
      },
    } as unknown as Parameters<typeof expireFlowInteractions>[0];

    await expect(expireFlowInteractions(adapter, 'tenant_a', NOW)).resolves.toBe(2);

    // No JSON in SQL: the context is written as read without the answers, or kept as it is.
    expect(executed.map((statement) => statement.params?.[1])).toEqual(['{"locale":"ja"}', null]);
    for (const statement of executed) {
      expect(statement.sql).not.toContain('jsonb');
      expect(statement.sql).toContain('context_json IS NOT DISTINCT FROM ?');
    }
  });
});

describe('contextWithoutScreenAnswers', () => {
  it('removes the key, and answers null when there is nothing to remove', () => {
    expect(contextWithoutScreenAnswers(JSON.stringify({ a: 1, screen_answers: answers }))).toBe(
      '{"a":1}'
    );
    expect(
      contextWithoutScreenAnswers(JSON.stringify({ requested_scope: ['screen_answers'] }))
    ).toBe(null);
    expect(contextWithoutScreenAnswers('{"screen_answers": ')).toBe(null);
    expect(contextWithoutScreenAnswers(null)).toBe(null);
  });
});
