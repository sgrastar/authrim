import assert from 'node:assert/strict';
import test from 'node:test';
import { SqlStreamSplitter, splitSqlStream } from './sql-stream-splitter.mjs';

function scan(chunks, options) {
  const splitter = new SqlStreamSplitter(options);
  const pieces = chunks.flatMap((chunk) => splitter.push(chunk));
  pieces.push(...splitter.finish());
  return pieces;
}

function statements(pieces) {
  const result = [];
  let statement = '';
  for (const piece of pieces) {
    statement += piece.text;
    if (piece.boundary) {
      result.push(statement);
      statement = '';
    }
  }
  return { statements: result, trailing: statement };
}

const complexStatements = [
  '\ufeff-- source; comment\r\n/* comments ; */ CREATE TABLE "odd;""name" (`a;``b`, [c;]]d]);',
  "\nINSERT INTO \"odd;\"\"name\" VALUES ('日本語😀; it''s data', '/* not a comment */', '--;');",
  `\nCrEaTe /* between */ TeMpOrArY -- keyword break\n TrIgGeR "begin;" AFTER INSERT ON t
    WHEN new.x <> 'BEGIN;END;'
    BEGIN
      UPDATE t SET x = CASE WHEN x = 1 THEN CASE WHEN y = 2 THEN 'END;' ELSE ';' END ELSE 3 END;
      INSERT INTO log VALUES ('CASE; END;', "quoted;identifier");
      -- END; not a terminator
      /* END; */ END;`,
  '\nCREATE TRIGGER t2 AFTER DELETE ON t BEGIN DELETE FROM t; END;',
  '\nSELECT CASE WHEN 1 THEN 2 ELSE 3 END;',
];
const trailing = '\n /* trailing ; */ -- EOF ;';
const complexSql = complexStatements.join('') + trailing;

test('preserves exact SQL and recognizes nested CASE inside trigger bodies', () => {
  const pieces = scan([complexSql]);
  assert.equal(pieces.map((piece) => piece.text).join(''), complexSql);
  assert.deepEqual(statements(pieces), { statements: complexStatements, trailing });
});

test('every possible two-chunk split preserves all lexical and trigger boundaries', () => {
  for (let split = 0; split <= complexSql.length; split++) {
    const pieces = scan([complexSql.slice(0, split), complexSql.slice(split)]);
    assert.equal(pieces.map((piece) => piece.text).join(''), complexSql, `split ${split}`);
    assert.deepEqual(
      statements(pieces),
      { statements: complexStatements, trailing },
      `split ${split}`
    );
  }
});

test('one-character chunks handle doubled quote delimiters and split comment delimiters', () => {
  assert.deepEqual(statements(scan(complexSql.split(''))), {
    statements: complexStatements,
    trailing,
  });
});

test('single-byte UTF-8 chunks preserve BOM and multibyte characters exactly', async () => {
  const bytes = new TextEncoder().encode(complexSql);
  const pieces = [];
  for await (const piece of splitSqlStream(Array.from(bytes, (byte) => Uint8Array.of(byte)))) {
    pieces.push(piece);
  }
  assert.deepEqual(new TextEncoder().encode(pieces.map((piece) => piece.text).join('')), bytes);
  assert.deepEqual(statements(pieces), { statements: complexStatements, trailing });
});

test('large unfinished statements emit immediately and retain only bounded token prefixes', () => {
  const splitter = new SqlStreamSplitter();
  const opening = "INSERT INTO t VALUES ('";
  assert.deepEqual(splitter.push(opening), [{ text: opening, boundary: false }]);
  const payload = 'z'.repeat(1024 * 1024);
  for (let index = 0; index < 12; index++) {
    assert.deepEqual(splitter.push(payload), [{ text: payload, boundary: false }]);
    assert.ok(splitter.quoted.length <= 32);
  }
  assert.deepEqual(splitter.push("');"), [{ text: "');", boundary: true }]);
  assert.deepEqual(splitter.push('a'.repeat(1024 * 1024)), [
    { text: 'a'.repeat(1024 * 1024), boundary: false },
  ]);
  assert.ok(splitter.word.length <= 32);
  splitter.push(';');
  splitter.finish();
});

test('quoted and identifier tokens named CREATE/TRIGGER/BEGIN/END do not create triggers', () => {
  const sql = `SELECT "CREATE", 'TRIGGER', [BEGIN], \`END\`; CREATE TABLE trigger_log (x);`;
  assert.equal(statements(scan([sql])).statements.length, 2);
});

test('empty statements and trailing comment/whitespace-only streams are accepted', () => {
  assert.deepEqual(statements(scan([';; /* ; */ ; -- tail'])), {
    statements: [';', ';', ' /* ; */ ;'],
    trailing: ' -- tail',
  });
  for (const sql of ['', ' \t\r\n\ufeff', '-- EOF', '/* block */', '-- line\r/* block */']) {
    assert.equal(statements(scan([sql])).statements.length, 0);
  }
});

test('finish rejects incomplete statements, lexical constructs, and trigger bodies', () => {
  const cases = [
    ['SELECT 1', 'SQL_SPLIT_INCOMPLETE_STATEMENT'],
    ["SELECT 'a", 'SQL_SPLIT_UNTERMINATED_QUOTE'],
    ['SELECT "a', 'SQL_SPLIT_UNTERMINATED_QUOTE'],
    ['SELECT `a', 'SQL_SPLIT_UNTERMINATED_QUOTE'],
    ['SELECT [a', 'SQL_SPLIT_UNTERMINATED_QUOTE'],
    ['SELECT 1; /*', 'SQL_SPLIT_UNTERMINATED_COMMENT'],
    ['SELECT 1; /* a*', 'SQL_SPLIT_UNTERMINATED_COMMENT'],
    ['CREATE TRIGGER x AFTER INSERT ON t', 'SQL_SPLIT_INCOMPLETE_TRIGGER'],
    ['CREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT 1;', 'SQL_SPLIT_INCOMPLETE_TRIGGER'],
    ['CREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT 1; END', 'SQL_SPLIT_INCOMPLETE_TRIGGER'],
    [
      'CREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT CASE WHEN 1 THEN 2; END;',
      'SQL_SPLIT_INCOMPLETE_TRIGGER',
    ],
    ['-- comment\n-', 'SQL_SPLIT_INCOMPLETE_STATEMENT'],
    ['/', 'SQL_SPLIT_INCOMPLETE_STATEMENT'],
  ];
  for (const [sql, code] of cases) {
    for (const chunks of [[sql], sql.split('')]) {
      assert.throws(() => scan(chunks), { code }, sql);
    }
  }
});

test('a quote at EOF is closed, but still requires the statement semicolon', () => {
  assert.throws(() => scan(["SELECT 'closed'"]), { code: 'SQL_SPLIT_INCOMPLETE_STATEMENT' });
  assert.throws(() => scan(["SELECT 'escaped''"]), { code: 'SQL_SPLIT_UNTERMINATED_QUOTE' });
});

test('rejects invalid and truncated UTF-8 instead of replacing bytes', async () => {
  for (const bytes of [Uint8Array.of(0xff), Uint8Array.of(0xe3, 0x81)]) {
    await assert.rejects(
      async () => {
        for await (const _piece of splitSqlStream([bytes])) {
          /* consume */
        }
      },
      { code: 'SQL_SPLIT_INVALID_UTF8' }
    );
  }
});

test('foreign key guard rejects enabling assignments including quoted and qualified forms', () => {
  const cases = [
    'PRAGMA foreign_keys=ON;',
    'pragma foreign_keys(1);',
    'PRAGMA main.foreign_keys = TRUE;',
    'PRAGMA "main" . "foreign_keys" = "ON";',
    "PRAGMA 'foreign_keys' = 'on';",
    'PRAGMA [foreign_keys] (`TRUE`);',
    'PRAGMA /* comment */ foreign_keys /* gap */ = /* value */ YES;',
    'PRAGMA foreign_keys=2;',
    'PRAGMA foreign_keys=+1;',
    'PRAGMA foreign_keys=0x10;',
    "PRAGMA foreign_keys='1foo';",
    'PRAGMA foreign_keys=;',
  ];
  for (const sql of cases) {
    for (const chunks of [[sql], sql.split('')]) {
      assert.throws(
        () => scan(chunks, { rejectForeignKeysEnable: true }),
        {
          code: 'FOREIGN_KEYS_ENABLE_UNSUPPORTED',
        },
        sql
      );
    }
  }
});

test('foreign key guard permits disabled values, inspection, and unrelated SQL', () => {
  const sql = [
    'PRAGMA foreign_keys=OFF;',
    'PRAGMA foreign_keys(FALSE);',
    'PRAGMA main.foreign_keys="NO";',
    "PRAGMA [foreign_keys]='0';",
    'PRAGMA foreign_keys;',
    'PRAGMA defer_foreign_keys=ON;',
    "INSERT INTO t VALUES ('PRAGMA foreign_keys=ON;');",
    '-- PRAGMA foreign_keys=ON;\nSELECT 1;',
    '/* PRAGMA foreign_keys=ON; */ SELECT 2;',
    'CREATE TABLE foreign_keys (x);',
  ].join('\n');
  const pieces = scan(sql.split(''), { rejectForeignKeysEnable: true });
  assert.equal(pieces.map((piece) => piece.text).join(''), sql);
  assert.equal(statements(pieces).statements.length, 10);
  assert.equal(statements(scan(['PRAGMA foreign_keys=ON;'])).statements.length, 1);
});

test('guard bounds token memory even for adversarial pragma values', () => {
  const splitter = new SqlStreamSplitter({ rejectForeignKeysEnable: true });
  splitter.push("PRAGMA foreign_keys='");
  splitter.push('O'.repeat(1024 * 1024));
  assert.equal(splitter.quoted.length, 32);
  assert.throws(() => splitter.push("';"), { code: 'FOREIGN_KEYS_ENABLE_UNSUPPORTED' });
});

test('fails explicitly for NUL, invalid API use, and writes after finish', async () => {
  assert.throws(() => scan(["SELECT 'a\0b';"]), { code: 'SQL_SPLIT_NUL' });
  const splitter = new SqlStreamSplitter();
  assert.throws(() => splitter.push(Uint8Array.of(1)), TypeError);
  splitter.finish();
  assert.throws(() => splitter.push(''), { code: 'SQL_SPLIT_CLOSED' });
  assert.throws(() => splitter.finish(), { code: 'SQL_SPLIT_CLOSED' });
  for (const chunks of [[new Uint8Array(), 'SELECT 1;'], [123]]) {
    await assert.rejects(async () => {
      for await (const _piece of splitSqlStream(chunks)) {
        /* consume */
      }
    }, TypeError);
  }
});
