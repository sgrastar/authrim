/**
 * Incrementally locate SQLite statement boundaries without retaining statements.
 *
 * Each push returns input slices, in order and without changing a character. A
 * piece with boundary=true ends immediately after a complete statement's `;`.
 * Other pieces may end anywhere, including inside a quoted string or comment.
 * Call finish() before accepting the stream: it rejects a truncated final
 * statement, quoted token, block comment, or CREATE TRIGGER body.
 *
 * This is a lexical boundary scanner, not a general SQL syntax validator.
 */
export class SqlStreamSplitter {
  constructor({ rejectForeignKeysEnable = false } = {}) {
    this.rejectForeignKeysEnable = rejectForeignKeysEnable;
    this.mode = 'normal';
    this.word = '';
    this.wordLength = 0;
    this.quoted = '';
    this.quotedLength = 0;
    this.quoteEnd = '';
    this.closed = false;
    this._resetStatement();
  }

  push(text) {
    if (this.closed) throw splitError('SQL_SPLIT_CLOSED', 'SQL splitter is already finished.');
    if (typeof text !== 'string') throw new TypeError('SQL splitter push() requires a string.');
    if (text.includes('\0')) throw splitError('SQL_SPLIT_NUL', 'SQL contains a NUL character.');

    const pieces = [];
    let pieceStart = 0;
    let index = 0;
    while (index < text.length) {
      if (this.mode === 'quote') {
        const end = text.indexOf(this.quoteEnd, index);
        if (end < 0) {
          this._appendQuoted(text, index, text.length);
          break;
        }
        this._appendQuoted(text, index, end);
        index = end + 1;
        this.mode = 'quote-end';
        continue;
      }
      if (this.mode === 'quote-end') {
        if (text[index] === this.quoteEnd) {
          this._appendQuoted(text, index, index + 1);
          index++;
          this.mode = 'quote';
          continue;
        }
        this._finishQuoted();
        continue;
      }
      if (this.mode === 'line-comment') {
        const lf = text.indexOf('\n', index);
        const cr = text.indexOf('\r', index);
        const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
        if (end < 0) break;
        index = end + 1;
        this.mode = 'normal';
        continue;
      }
      if (this.mode === 'block-comment') {
        const end = text.indexOf('*/', index);
        if (end < 0) {
          if (text[text.length - 1] === '*') this.mode = 'block-star';
          break;
        }
        index = end + 2;
        this.mode = 'normal';
        continue;
      }
      if (this.mode === 'block-star') {
        if (text[index] === '/') {
          index++;
          this.mode = 'normal';
        } else {
          this.mode = 'block-comment';
        }
        continue;
      }
      if (this.mode === 'dash' || this.mode === 'slash') {
        const previous = this.mode;
        if (previous === 'dash' && text[index] === '-') {
          index++;
          this.mode = 'line-comment';
        } else if (previous === 'slash' && text[index] === '*') {
          index++;
          this.mode = 'block-comment';
        } else {
          this.mode = 'normal';
          this._punctuation(previous === 'dash' ? '-' : '/');
        }
        continue;
      }

      let end = index;
      while (end < text.length && isWordCode(text.charCodeAt(end))) end++;
      if (end > index) {
        if (this.word.length < TOKEN_LIMIT) {
          this.word += text.slice(index, Math.min(end, index + TOKEN_LIMIT - this.word.length));
        }
        this.wordLength += end - index;
        this.hasContent = true;
        index = end;
        continue;
      }
      this._finishWord();

      const char = text[index];
      const code = text.charCodeAt(index);
      if (isSpaceCode(code)) {
        index++;
      } else if (char === '-' || char === '/') {
        this.mode = char === '-' ? 'dash' : 'slash';
        index++;
      } else if (char === "'" || char === '"' || char === '`' || char === '[') {
        this.mode = 'quote';
        this.quoteEnd = char === '[' ? ']' : char;
        this.quoted = '';
        this.quotedLength = 0;
        this.hasContent = true;
        index++;
      } else if (char === ';') {
        if (this._semicolon()) {
          pieces.push({ text: text.slice(pieceStart, index + 1), boundary: true });
          pieceStart = index + 1;
        }
        index++;
      } else {
        this._punctuation(char);
        index++;
      }
    }
    if (pieceStart < text.length) pieces.push({ text: text.slice(pieceStart), boundary: false });
    return pieces;
  }

  finish() {
    if (this.closed) throw splitError('SQL_SPLIT_CLOSED', 'SQL splitter is already finished.');
    this.closed = true;
    if (this.mode === 'quote') {
      throw splitError('SQL_SPLIT_UNTERMINATED_QUOTE', 'SQL ends inside a quoted token.');
    }
    if (this.mode === 'block-comment' || this.mode === 'block-star') {
      throw splitError('SQL_SPLIT_UNTERMINATED_COMMENT', 'SQL ends inside a block comment.');
    }
    if (this.mode === 'quote-end') this._finishQuoted();
    if (this.mode === 'dash' || this.mode === 'slash') {
      this._punctuation(this.mode === 'dash' ? '-' : '/');
    }
    this._finishWord();
    if (this.trigger !== null) {
      throw splitError(
        'SQL_SPLIT_INCOMPLETE_TRIGGER',
        'SQL ends inside a CREATE TRIGGER statement.'
      );
    }
    if (this.hasContent) {
      throw splitError(
        'SQL_SPLIT_INCOMPLETE_STATEMENT',
        'Final SQL statement has no terminating semicolon.'
      );
    }
    return [];
  }

  _resetStatement() {
    this.hasContent = false;
    this.prefix = 'start';
    this.trigger = null;
    this.caseDepth = 0;
    this.triggerStatementEnd = false;
    this.pragma = 'start';
    this.pragmaName = '';
    this.pragmaQualified = false;
  }

  _finishWord() {
    if (this.wordLength === 0) return;
    this._token(this.wordLength <= TOKEN_LIMIT ? this.word.toUpperCase() : null, false);
    this.word = '';
    this.wordLength = 0;
  }

  _appendQuoted(text, start, end) {
    if (this.quoted.length < TOKEN_LIMIT) {
      this.quoted += text.slice(start, Math.min(end, start + TOKEN_LIMIT - this.quoted.length));
    }
    this.quotedLength += end - start;
  }

  _finishQuoted() {
    this._token(this.quotedLength <= TOKEN_LIMIT ? this.quoted.toUpperCase() : null, true);
    this.quoted = '';
    this.quotedLength = 0;
    this.mode = 'normal';
  }

  _token(word, quoted) {
    this._pragmaToken(word, quoted);
    if (this.trigger === 'header') {
      if (!quoted && word === 'BEGIN') this.trigger = 'body';
      return;
    }
    if (this.trigger !== null) {
      if (this.trigger === 'end') this.trigger = 'body';
      if (!quoted && word === 'CASE') {
        this.caseDepth++;
      } else if (!quoted && word === 'END') {
        if (this.caseDepth > 0) this.caseDepth--;
        else if (this.triggerStatementEnd) this.trigger = 'end';
      }
      this.triggerStatementEnd = false;
      return;
    }
    if (!quoted && this.prefix === 'start' && word === 'CREATE') {
      this.prefix = 'create';
    } else if (!quoted && this.prefix === 'create' && (word === 'TEMP' || word === 'TEMPORARY')) {
      this.prefix = 'create-temp';
    } else if (
      !quoted &&
      (this.prefix === 'create' || this.prefix === 'create-temp') &&
      word === 'TRIGGER'
    ) {
      this.trigger = 'header';
      this.prefix = 'other';
    } else {
      this.prefix = 'other';
    }
  }

  _punctuation(char) {
    this.hasContent = true;
    this.prefix = 'other';
    if (this.trigger === 'end') this.trigger = 'body';
    this.triggerStatementEnd = false;
    if (!this.rejectForeignKeysEnable) return;
    if (this.pragma === 'after-name' && char === '.' && !this.pragmaQualified) {
      this.pragma = 'name';
      this.pragmaQualified = true;
    } else if (this.pragma === 'after-name' && (char === '=' || char === '(')) {
      this.pragma = this.pragmaName === 'FOREIGN_KEYS' ? 'value' : 'ignore';
    } else if (this.pragma === 'value') {
      this._rejectForeignKeysEnable();
    } else {
      this.pragma = 'ignore';
    }
  }

  _pragmaToken(word, quoted) {
    if (!this.rejectForeignKeysEnable) return;
    if (this.pragma === 'start') {
      this.pragma = !quoted && word === 'PRAGMA' ? 'name' : 'ignore';
    } else if (this.pragma === 'name') {
      this.pragmaName = word;
      this.pragma = 'after-name';
    } else if (this.pragma === 'value') {
      // SQLite accepts additional numeric/string representations of true. Only
      // values that are unambiguously disabled may pass this optional guard.
      if (word !== 'OFF' && word !== 'FALSE' && word !== 'NO' && word !== '0') {
        this._rejectForeignKeysEnable();
      }
      this.pragma = 'ignore';
    } else {
      this.pragma = 'ignore';
    }
  }

  _rejectForeignKeysEnable() {
    throw splitError(
      'FOREIGN_KEYS_ENABLE_UNSUPPORTED',
      'A foreign_keys assignment must use OFF, FALSE, NO, or 0 for this import.'
    );
  }

  _semicolon() {
    if (this.pragma === 'value') this._rejectForeignKeysEnable();
    if (this.trigger === 'end') {
      this._resetStatement();
      return true;
    }
    if (this.trigger !== null) {
      this.triggerStatementEnd = this.trigger === 'body' && this.caseDepth === 0;
      return false;
    }
    this._resetStatement();
    return true;
  }
}

const TOKEN_LIMIT = 32;

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

function splitError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Convenience adapter for an async/sync iterable of UTF-8 Uint8Array chunks, or
 * an iterable of string chunks. Chunk types must not be mixed. UTF-8 decoding is
 * fatal and preserves the BOM, so joining the emitted text preserves input bytes.
 */
export async function* splitSqlStream(source, options) {
  const splitter = new SqlStreamSplitter(options);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let type;
  for await (const chunk of source) {
    const chunkType = typeof chunk === 'string' ? 'string' : 'bytes';
    if (chunkType === 'bytes' && !(chunk instanceof Uint8Array)) {
      throw new TypeError('SQL stream chunks must be strings or Uint8Array values.');
    }
    if (type !== undefined && type !== chunkType) {
      throw new TypeError('SQL stream must not mix string and byte chunks.');
    }
    type = chunkType;
    const text = type === 'string' ? chunk : decodeUtf8(decoder, chunk, true);
    yield* splitter.push(text);
  }
  if (type === 'bytes') yield* splitter.push(decodeUtf8(decoder, undefined, false));
  yield* splitter.finish();
}

function decodeUtf8(decoder, chunk, stream) {
  try {
    return decoder.decode(chunk, { stream });
  } catch {
    throw splitError('SQL_SPLIT_INVALID_UTF8', 'SQL input is not valid UTF-8.');
  }
}
