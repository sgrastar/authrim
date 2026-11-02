import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_DDL_HEADER_BYTES, createStatementClassifier } from './ddl-statement-classifier.mjs';

function classify(chunks) {
  const classifier = createStatementClassifier();
  for (const chunk of chunks) classifier.consume(chunk);
  return classifier.finish();
}

const indexCases = [
  ['CREATE INDEX idx_session ON sessions(id);', 'sessions'],
  ['CREATE UNIQUE INDEX IF NOT EXISTS main.idx_session ON main.sessions(id);', 'sessions'],
  [
    '\ufeff-- CREATE TRIGGER fake;\r\n/* ON wrong */ cReAtE /* gap */ UnIqUe InDeX "main"."ix;""name" ON "schema" . "session;""records" (id);',
    'session;"records',
  ],
  ['CREATE INDEX `ix``name` ON `main`.`日本語😀``records` (x);', '日本語😀`records'],
  ['CREATE INDEX [ix]]name] ON [main].[records]]name] (x);', 'records]name'],
  ["CREATE INDEX 'ix''name' ON 'table''name' (x);", "table'name"],
  ['CREATE INDEX "IF" ON "ON" (x);', 'ON'],
  ['CREATE INDEX main."ON" ON "main.table" (x) WHERE x = \';\';', 'main.table'],
  ['CREATE INDEX idx ON main /* schema */ . /* table */ records /* columns */ (x);', 'records'],
];

test('classifies SQLite index headers and decodes quoted, qualified target table names', () => {
  for (const [sql, table] of indexCases) {
    assert.deepEqual(classify([sql]), { kind: 'index', table }, sql);
  }
});

test('every two-chunk cut and single-character chunks produce identical classifications', () => {
  for (const [sql, table] of indexCases) {
    const expected = { kind: 'index', table };
    for (let split = 0; split <= sql.length; split++) {
      assert.deepEqual(classify([sql.slice(0, split), sql.slice(split)]), expected, `cut ${split}`);
    }
    assert.deepEqual(classify(sql.split('')), expected);
  }
});

test('classifies triggers immediately without retaining or parsing their bodies', () => {
  for (const prefix of ['CREATE TRIGGER ', 'CREATE TEMP TRIGGER ', 'CREATE TEMPORARY TRIGGER ']) {
    const classifier = createStatementClassifier();
    const result = classifier.consume(`/* leading */ ${prefix}`);
    assert.deepEqual(result, { kind: 'trigger' });
    assert.equal(classifier.classification, result);
    assert.equal(
      classifier.consume('x AFTER UPDATE OF "ON", x ON main.t BEGIN SELECT CASE END; END;'),
      result
    );
    assert.equal(classifier.consume('a'.repeat(1024 * 1024)), result);
    assert.equal(classifier.finish(), result);
  }
});

test('early classification enables streaming large non-DDL statements unchanged', () => {
  for (const prefix of [
    'INSERT ',
    'UPDATE ',
    'SELECT ',
    'PRAGMA ',
    'CREATE TABLE ',
    'CREATE VIEW ',
  ]) {
    const classifier = createStatementClassifier();
    assert.equal(classifier.classification, undefined);
    const result = classifier.consume(prefix);
    assert.deepEqual(result, { kind: 'other' });
    assert.ok(Object.isFrozen(result));
    assert.equal(classifier.consume("'" + 'payload;'.repeat(1024 * 1024)), result);
    assert.equal(classifier.finish(), result);
  }
});

test('FK wrapper statements, quoted keywords, and comment-only input classify as other', () => {
  for (const sql of [
    'PRAGMA foreign_keys=OFF;',
    'PRAGMA foreign_keys=ON;',
    'PRAGMA defer_foreign_keys=ON;',
    '"CREATE" INDEX x ON y(z);',
    "'CREATE INDEX fake ON other(x)'",
    '-- CREATE INDEX fake ON other(x)\n SELECT 1;',
    '/* CREATE UNIQUE INDEX fake ON other(x) */ CREATE TABLE t(x);',
    '',
    ' \t\n\r\ufeff',
    '-- EOF',
    '/***/ -- EOF',
  ]) {
    assert.deepEqual(classify(sql.split('')), { kind: 'other' }, sql);
  }
});

test('classification waits for a complete target identifier and optional schema qualifier', () => {
  const classifier = createStatementClassifier();
  assert.equal(classifier.consume('CREATE INDEX idx ON "mai'), undefined);
  assert.equal(classifier.consume('n"'), undefined);
  assert.equal(classifier.consume(' /* comment */ '), undefined);
  assert.equal(classifier.consume('. "records"'), undefined);
  assert.deepEqual(classifier.consume(' ('), { kind: 'index', table: 'records' });
  assert.deepEqual(classifier.finish(), { kind: 'index', table: 'records' });
  assert.deepEqual(classify(['CREATE INDEX idx ON "records"']), {
    kind: 'index',
    table: 'records',
  });
});

test('rejects malformed or incomplete recognized index headers instead of routing them as data', () => {
  const malformed = [
    'CREATE INDEX IF WRONG x ON t(x);',
    'CREATE INDEX IF NOT WRONG x ON t(x);',
    'CREATE INDEX idx WRONG t(x);',
    'CREATE INDEX main.extra.idx ON t(x);',
    'CREATE INDEX idx ON main.extra.t(x);',
    'CREATE INDEX idx ON t WHERE x;',
    'CREATE INDEX idx ON (x);',
  ];
  for (const sql of malformed) {
    assert.throws(() => classify(sql.split('')), { code: 'DDL_CLASSIFY_MALFORMED' }, sql);
  }
  for (const sql of [
    'CREATE',
    'CREATE UNIQUE',
    'CREATE TEMP',
    'CREATE INDEX',
    'CREATE INDEX idx ON',
  ]) {
    assert.throws(() => classify(sql.split('')), { code: 'DDL_CLASSIFY_INCOMPLETE' }, sql);
  }
});

test('rejects unterminated quoted headers and block comments', () => {
  for (const sql of [
    'CREATE INDEX "idx',
    'CREATE INDEX idx ON [table',
    "CREATE INDEX idx ON 't''",
  ]) {
    assert.throws(() => classify(sql.split('')), { code: 'DDL_CLASSIFY_UNTERMINATED_QUOTE' }, sql);
  }
  for (const sql of ['/* unterminated', '/**', 'CREATE /* gap*']) {
    assert.throws(
      () => classify(sql.split('')),
      { code: 'DDL_CLASSIFY_UNTERMINATED_COMMENT' },
      sql
    );
  }
});

test('enforces a 16 KiB UTF-8 header limit across comments, tokens, and quoted identifiers', () => {
  for (const opening of ['/*', '--', 'CREATE INDEX "', 'CREATE INDEX ']) {
    const classifier = createStatementClassifier();
    classifier.consume(opening);
    assert.throws(() => classifier.consume('x'.repeat(MAX_DDL_HEADER_BYTES)), {
      code: 'DDL_CLASSIFY_TOO_LARGE',
    });
  }
  const ascii = createStatementClassifier();
  ascii.consume(' '.repeat(MAX_DDL_HEADER_BYTES));
  assert.deepEqual(ascii.finish(), { kind: 'other' });
  for (const value of ['日', '😀']) {
    const classifier = createStatementClassifier();
    const prefix = '/*';
    classifier.consume(prefix);
    const count = Math.floor((MAX_DDL_HEADER_BYTES - prefix.length) / Buffer.byteLength(value));
    for (const char of value.repeat(count).split('')) classifier.consume(char);
    assert.ok(classifier.headerBytes <= MAX_DDL_HEADER_BYTES);
    assert.throws(() => classifier.consume(value), { code: 'DDL_CLASSIFY_TOO_LARGE' });
  }
});

test('rejects invalid API use and NUL in undecided headers', () => {
  const classifier = createStatementClassifier();
  assert.throws(() => classifier.consume(new Uint8Array()), TypeError);
  assert.throws(() => classifier.consume('/*\0'), { code: 'DDL_CLASSIFY_NUL' });
  const completed = createStatementClassifier();
  completed.consume('SELECT ');
  completed.finish();
  assert.throws(() => completed.consume(''), { code: 'DDL_CLASSIFY_CLOSED' });
  assert.throws(() => completed.finish(), { code: 'DDL_CLASSIFY_CLOSED' });
});
