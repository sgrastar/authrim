import { describe, expect, it } from 'vitest';
import { MockDatabaseAdapter } from './mock-adapter';

describe('mock SQL parser', () => {
  it('preserves literals, placeholders, NULL, ordering and pagination', async () => {
    const db = new MockDatabaseAdapter();
    db.initTable('items');
    await db.execute("INSERT INTO items (id, label, score, deleted) VALUES (?, 'first', 7, NULL)", [
      'a',
    ]);
    await db.execute(
      "INSERT INTO items (id, label, score, deleted) VALUES (?, 'second', 9, NULL)",
      ['b']
    );
    expect(
      await db.query(
        'SELECT * FROM items WHERE deleted IS NULL ORDER BY score DESC LIMIT ? OFFSET ?',
        [1, 0]
      )
    ).toEqual([{ id: 'b', label: 'second', score: 9, deleted: null }]);
    expect(await db.query('SELECT * FROM items WHERE score >= ?', [8])).toHaveLength(1);
    await db.execute(
      'UPDATE items\n SET label = ?, score = 10, deleted = NULL\n WHERE id = ? AND score = 7',
      ['changed', 'a']
    );
    expect(db.getById('items', 'a')).toEqual({
      id: 'a',
      label: 'changed',
      score: 10,
      deleted: null,
    });
    await db.execute("DELETE FROM items WHERE label = 'changed'");
    expect(db.getById('items', 'a')).toBeUndefined();
    expect(db.getById('items', 'b')).toBeDefined();
  });

  it.each(['foo-AND-bar', 'pre ORDER now', 'pre LIMIT now', 'pre GROUP now'])(
    'preserves literal %s without updating unrelated rows',
    async (id) => {
      const db = new MockDatabaseAdapter();
      db.seed('items', [
        { id, label: 'before' },
        { id: 'other', label: 'untouched' },
      ]);
      await db.execute(`UPDATE items SET label = ? WHERE id = '${id}'`, ['after']);
      expect(db.getById('items', id)?.label).toBe('after');
      expect(db.getById('items', 'other')?.label).toBe('untouched');
    }
  );

  it('does not repeatedly rescan long malformed identifiers, whitespace or parentheses', async () => {
    const db = new MockDatabaseAdapter();
    db.initTable('items');
    const started = performance.now();
    const word = '0'.repeat(40_000);
    const spaces = '\t'.repeat(40_000);
    await db.query(`SELECT * FROM items WHERE ${word}`, []);
    await db.query(`SELECT * FROM items WHERE a${spaces}`, []);
    await db.query(`SELECT * FROM items WHERE${spaces}`, []);
    await db.query(`SELECT * FROM items ORDER BY a${spaces}`, []);
    await db.execute(`UPDATE items SET a = 1 WHERE ${word}`, []);
    await db.execute(`UPDATE items SET ${word} WHERE a = 1`, []);
    await db.execute(`UPDATE items SET a =${spaces} WHERE a = 1`, []);
    await db.execute(`INSERT INTO items ${'('.repeat(40_000)}`, []);
    // Broad enough for CI variation; the former polynomial scans take seconds for these inputs.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
