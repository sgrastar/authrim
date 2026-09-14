import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectBackupWriterCandidates,
  inventoryBackupWriters,
} from '../../../../../../scripts/tenant-backup/writer-inventory';

describe('backup writer review inventory', () => {
  it('finds aliases and optional/computed calls without guessing their storage ownership', () => {
    const rows = inspectBackupWriterCandidates(
      `async function save(kv: KVNamespace, key: string) {
        await kv?.put(key, value);
        await env['SETTINGS']['delete'](key);
        await store[method](key);
        await env.KEY_MANAGER.get(id).getActiveKeyRpc();
      }`,
      'writer.ts'
    );
    expect(rows.map((row) => [row.method, row.receiver, row.firstArgument, row.line])).toEqual([
      ['put', 'kv', 'key', 2],
      ['delete', "env['SETTINGS']", 'key', 3],
      ['<computed>', 'store', 'key', 4],
      ['getActiveKeyRpc', 'env.KEY_MANAGER.get(id)', null, 5],
    ]);
    expect(rows.every((row) => row.review === 'unreviewed')).toBe(true);
    expect(rows.every((row) => row.enclosingFunction === 'save')).toBe(true);
  });

  it('keeps SQL through query and multipart completion in the review queue', () => {
    const rows = inspectBackupWriterCandidates(
      `const finish = async () => {
        await db.queryOne('DELETE FROM items RETURNING id');
        await upload.complete(parts);
        await state.storage.transaction(async tx => tx.put(key, value));
      };`,
      'writer.ts'
    );
    expect(rows.map((row) => row.method)).toEqual(['queryOne', 'complete', 'transaction', 'put']);
    expect(rows[0].firstArgument).toBe("'DELETE FROM items RETURNING id'");
    expect(rows[0].enclosingFunction).toBe('finish');
  });

  it('does not invent writes from comments, strings or method declarations', () => {
    expect(
      inspectBackupWriterCandidates(
        `// env.SETTINGS.put(key, value)
        const documentation = 'kv.delete(key)';
        interface Store { put(key: string): void; }`,
        'writer.ts'
      )
    ).toEqual([]);
  });

  it('invalidates source review evidence when the enclosing writer changes', () => {
    const first = inspectBackupWriterCandidates('store.put(key, value);', 'writer.ts')[0];
    const second = inspectBackupWriterCandidates('store.put(otherKey, value);', 'writer.ts')[0];
    expect(first.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.sourceSha256).not.toBe(first.sourceSha256);
  });

  it('resolves constant key prefixes with lexical shadowing, without evaluating dynamic code', () => {
    const rows = inspectBackupWriterCandidates(
      'const PREFIX = "settings:";\n' +
        'const KEY = PREFIX + "platform:security";\n' +
        'store.put(KEY, data);\n' +
        'store.put(`${PREFIX}tenant:${tenantId}:security`, data);\n' +
        'function parameter(KEY: string) { store.put(KEY, data); }\n' +
        'function mutable() { let KEY = "initial"; KEY = external(); store.put(KEY, data); }\n' +
        'function local() { const KEY = "local"; store.put(KEY, data); }\n' +
        'store.put(makeKey(), data);',
      'writer.ts'
    );
    expect(rows.map((row) => row.keyEvidence)).toEqual([
      { kind: 'literal', value: 'settings:platform:security' },
      { kind: 'prefix', value: 'settings:tenant:' },
      { kind: 'dynamic' },
      { kind: 'dynamic' },
      { kind: 'literal', value: 'local' },
      { kind: 'dynamic' },
    ]);
  });

  it('bounds cyclic constant references and does not resolve imported bindings', () => {
    const rows = inspectBackupWriterCandidates(
      'import { KEY } from "./generated-secret"; const A = B; const B = A; store.put(A, data); store.put(KEY, data);',
      'writer.ts'
    );
    expect(rows.map((row) => row.keyEvidence)).toEqual([{ kind: 'dynamic' }, { kind: 'dynamic' }]);
  });

  it('reads only source candidates without executing files or following symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'authrim-writer-review-'));
    try {
      const src = join(root, 'packages', 'example', 'src');
      mkdirSync(join(src, '__tests__'), { recursive: true });
      mkdirSync(join(src, '.authrim'), { recursive: true });
      writeFileSync(
        join(src, 'writer.ts'),
        'throw new Error("must not execute"); kv.put(key, data);'
      );
      writeFileSync(join(src, 'writer.test.ts'), 'kv.delete(key);');
      writeFileSync(join(src, '__tests__', 'fixture.ts'), 'kv.delete(key);');
      writeFileSync(join(src, '.authrim', 'secret.ts'), 'kv.delete(key);');
      writeFileSync(join(root, 'outside.ts'), 'kv.delete(secret);');
      symlinkSync(join(root, 'outside.ts'), join(src, 'linked.ts'));
      const result = inventoryBackupWriters(root);
      expect(result.inspectedFiles).toBe(1);
      expect(result.candidates.map((row) => row.method)).toEqual(['put']);
      expect(result.completeWriterCoverage).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
