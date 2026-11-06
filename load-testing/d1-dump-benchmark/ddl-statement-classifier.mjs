export const MAX_DDL_HEADER_BYTES = 16 * 1024;

/**
 * Classify one statement whose boundaries are validated by SqlStreamSplitter.
 *
 * Feed original string fragments to consume(). classification is undefined
 * until a decision is available, then remains the same frozen object. finish()
 * returns that object, or {kind:'other'} for whitespace/comments only. PRAGMA
 * wrappers are ordinary `other` statements; feed each statement separately.
 *
 * Only undecided headers are scanned and retained, up to 16 KiB of UTF-8. The
 * body of an INSERT, CREATE INDEX, or CREATE TRIGGER is never retained/scanned
 * after classification. This helper does not validate statement syntax/body.
 */
export function createStatementClassifier() {
  return new StatementClassifier();
}

class StatementClassifier {
  constructor() {
    this.phase = 'start';
    this.mode = 'normal';
    this.token = '';
    this.quoteEnd = '';
    this.headerBytes = 0;
    this.previousHighSurrogate = false;
    this.indexQualified = false;
    this.tableQualified = false;
    this.table = '';
    this.result = undefined;
    this.closed = false;
  }

  get classification() {
    return this.result;
  }

  consume(text) {
    if (this.closed) throw headerError('DDL_CLASSIFY_CLOSED', 'Statement classifier is finished.');
    if (typeof text !== 'string') throw new TypeError('Statement fragments must be strings.');
    for (let index = 0; index < text.length && this.result === undefined; ) {
      const char = text[index];
      if (this.mode === 'word') {
        if (isWordCode(text.charCodeAt(index))) {
          this._count(char);
          this.token += char;
          index++;
        } else {
          this._finishToken(false);
        }
        continue;
      }
      if (this.mode === 'quote') {
        this._count(char);
        index++;
        if (char === this.quoteEnd) this.mode = 'quote-end';
        else this.token += char;
        continue;
      }
      if (this.mode === 'quote-end') {
        if (char === this.quoteEnd) {
          this._count(char);
          this.token += char;
          this.mode = 'quote';
          index++;
        } else {
          this._finishToken(true);
        }
        continue;
      }
      if (this.mode === 'line-comment') {
        this._count(char);
        index++;
        if (char === '\r' || char === '\n') this.mode = 'normal';
        continue;
      }
      if (this.mode === 'block-comment') {
        this._count(char);
        index++;
        if (char === '*') this.mode = 'block-star';
        continue;
      }
      if (this.mode === 'block-star') {
        this._count(char);
        index++;
        if (char === '/') this.mode = 'normal';
        else if (char !== '*') this.mode = 'block-comment';
        continue;
      }
      if (this.mode === 'dash' || this.mode === 'slash') {
        const previous = this.mode;
        if ((previous === 'dash' && char === '-') || (previous === 'slash' && char === '*')) {
          this._count(char);
          index++;
          this.mode = previous === 'dash' ? 'line-comment' : 'block-comment';
        } else {
          this.mode = 'normal';
          this._punctuation(previous === 'dash' ? '-' : '/');
        }
        continue;
      }

      this._count(char);
      index++;
      if (isSpaceCode(char.charCodeAt(0))) continue;
      if (isWordCode(char.charCodeAt(0))) {
        this.token = char;
        this.mode = 'word';
      } else if (char === '-' || char === '/') {
        this.mode = char === '-' ? 'dash' : 'slash';
      } else if (char === "'" || char === '"' || char === '`' || char === '[') {
        if (this.phase === 'start') this._decide('other');
        else {
          this.token = '';
          this.quoteEnd = char === '[' ? ']' : char;
          this.mode = 'quote';
        }
      } else {
        this._punctuation(char);
      }
    }
    return this.result;
  }

  finish() {
    if (this.closed) throw headerError('DDL_CLASSIFY_CLOSED', 'Statement classifier is finished.');
    this.closed = true;
    if (this.result !== undefined) return this.result;
    if (this.mode === 'word') this._finishToken(false);
    else if (this.mode === 'quote-end') this._finishToken(true);
    else if (this.mode === 'quote') {
      throw headerError(
        'DDL_CLASSIFY_UNTERMINATED_QUOTE',
        'DDL header ends inside a quoted token.'
      );
    } else if (this.mode === 'block-comment' || this.mode === 'block-star') {
      throw headerError(
        'DDL_CLASSIFY_UNTERMINATED_COMMENT',
        'DDL header ends inside a block comment.'
      );
    } else if (this.mode === 'dash' || this.mode === 'slash') {
      this._punctuation(this.mode === 'dash' ? '-' : '/');
    }
    if (this.result !== undefined) return this.result;
    if (this.phase === 'table-after-name') this._decide('index', this.table);
    else if (this.phase === 'start') this._decide('other');
    else
      throw headerError('DDL_CLASSIFY_INCOMPLETE', 'SQL ends before its DDL header is complete.');
    return this.result;
  }

  _count(char) {
    const code = char.charCodeAt(0);
    if (code === 0) throw headerError('DDL_CLASSIFY_NUL', 'DDL header contains a NUL character.');
    this.headerBytes +=
      code < 0x80
        ? 1
        : code < 0x800
          ? 2
          : code >= 0xdc00 && code <= 0xdfff && this.previousHighSurrogate
            ? 1
            : 3;
    this.previousHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    if (this.headerBytes > MAX_DDL_HEADER_BYTES) {
      throw headerError('DDL_CLASSIFY_TOO_LARGE', 'Undecided SQL header exceeds 16 KiB.');
    }
  }

  _finishToken(quoted) {
    const token = this.token;
    this.token = '';
    this.mode = 'normal';
    const keyword = quoted ? undefined : token.toUpperCase();
    if (this.phase === 'start') {
      if (keyword === 'CREATE') this.phase = 'create';
      else this._decide('other');
    } else if (this.phase === 'create') {
      if (keyword === 'INDEX') this.phase = 'index-name-start';
      else if (keyword === 'UNIQUE') this.phase = 'create-unique';
      else if (keyword === 'TEMP' || keyword === 'TEMPORARY') this.phase = 'create-temp';
      else if (keyword === 'TRIGGER') this._decide('trigger');
      else this._decide('other');
    } else if (this.phase === 'create-unique') {
      if (keyword === 'INDEX') this.phase = 'index-name-start';
      else this._decide('other');
    } else if (this.phase === 'create-temp') {
      if (keyword === 'TRIGGER') this._decide('trigger');
      else this._decide('other');
    } else if (this.phase === 'index-name-start') {
      this.phase = keyword === 'IF' ? 'index-if-not' : 'index-after-name';
    } else if (this.phase === 'index-if-not') {
      this._expect(keyword === 'NOT', 'index-if-exists');
    } else if (this.phase === 'index-if-exists') {
      this._expect(keyword === 'EXISTS', 'index-name-required');
    } else if (this.phase === 'index-name-required') {
      this.phase = 'index-after-name';
    } else if (this.phase === 'index-after-name') {
      this._expect(keyword === 'ON', 'table-name-required');
    } else if (this.phase === 'table-name-required') {
      this.table = token;
      this.phase = 'table-after-name';
    } else {
      this._malformed();
    }
  }

  _punctuation(char) {
    if (this.phase === 'start' || this.phase.startsWith('create')) {
      this._decide('other');
    } else if (this.phase === 'index-after-name' && char === '.' && !this.indexQualified) {
      this.indexQualified = true;
      this.phase = 'index-name-required';
    } else if (this.phase === 'table-after-name' && char === '.' && !this.tableQualified) {
      this.tableQualified = true;
      this.phase = 'table-name-required';
    } else if (this.phase === 'table-after-name' && char === '(') {
      this._decide('index', this.table);
    } else {
      this._malformed();
    }
  }

  _expect(condition, nextPhase) {
    if (!condition) this._malformed();
    this.phase = nextPhase;
  }

  _malformed() {
    throw headerError('DDL_CLASSIFY_MALFORMED', 'CREATE INDEX header is malformed or unsupported.');
  }

  _decide(kind, table) {
    this.result = Object.freeze(table === undefined ? { kind } : { kind, table });
    this.token = '';
  }
}

function isWordCode(code) {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 36 ||
    (code >= 128 && code !== 0xfeff)
  );
}

function isSpaceCode(code) {
  return code === 32 || (code >= 9 && code <= 13) || code === 0xfeff;
}

function headerError(code, message) {
  return Object.assign(new Error(message), { code });
}
