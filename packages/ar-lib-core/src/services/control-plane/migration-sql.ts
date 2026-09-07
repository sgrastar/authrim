const MAX_MIGRATION_BYTES = 1024 * 1024;
const MAX_STATEMENT_BYTES = 100_000;
// A semantically consolidated fresh-install baseline can contain thousands of seed rows while
// remaining bounded by MAX_MIGRATION_BYTES. Keep the statement-count guard above the largest
// supported baseline instead of forcing release history back into artificial file fragments.
const MAX_STATEMENTS = 8192;

type LexerState =
  | 'normal'
  | 'single_quote'
  | 'double_quote'
  | 'backtick_quote'
  | 'bracket_quote'
  | 'line_comment'
  | 'block_comment';

export interface SplitMigrationSqlOptions {
  maxMigrationBytes?: number;
  maxStatementBytes?: number;
  maxStatements?: number;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasExecutableToken(statement: string): boolean {
  return (
    statement
      .replace(/--[^\n]*(?:\n|$)/gu, ' ')
      .replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .trim().length > 0
  );
}

function assertStatementAllowed(statement: string): void {
  const firstToken = statement
    .replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/gu, '')
    .match(/^[A-Za-z]+/u)?.[0]
    ?.toUpperCase();
  if (
    firstToken &&
    ['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(firstToken)
  ) {
    throw new Error('migration_sql_explicit_transaction_forbidden');
  }
  if (/^\s*\./u.test(statement)) {
    throw new Error('migration_sql_dot_command_forbidden');
  }
}

export function splitMigrationSql(sql: string, options: SplitMigrationSqlOptions = {}): string[] {
  if (sql.includes('\0')) throw new Error('migration_sql_nul_forbidden');
  const maxMigrationBytes = options.maxMigrationBytes ?? MAX_MIGRATION_BYTES;
  const maxStatementBytes = options.maxStatementBytes ?? MAX_STATEMENT_BYTES;
  const maxStatements = options.maxStatements ?? MAX_STATEMENTS;
  if (byteLength(sql) > maxMigrationBytes) throw new Error('migration_sql_file_too_large');

  let state: LexerState = 'normal';
  let current = '';
  let token = '';
  let prefixTokens: string[] = [];
  let trigger = false;
  let triggerBeginSeen = false;
  let triggerEndSeen = false;
  let caseDepth = 0;
  const statements: string[] = [];

  const resetStatementState = (): void => {
    token = '';
    prefixTokens = [];
    trigger = false;
    triggerBeginSeen = false;
    triggerEndSeen = false;
    caseDepth = 0;
  };

  const acceptToken = (): void => {
    if (!token) return;
    const normalized = token.toUpperCase();
    token = '';
    if (prefixTokens.length < 3) prefixTokens.push(normalized);
    trigger =
      (prefixTokens[0] === 'CREATE' && prefixTokens[1] === 'TRIGGER') ||
      (prefixTokens[0] === 'CREATE' &&
        (prefixTokens[1] === 'TEMP' || prefixTokens[1] === 'TEMPORARY') &&
        prefixTokens[2] === 'TRIGGER');
    if (!trigger) return;
    if (normalized === 'CASE') {
      caseDepth += 1;
    } else if (normalized === 'END') {
      if (caseDepth > 0) caseDepth -= 1;
      else if (triggerBeginSeen) triggerEndSeen = true;
    } else if (normalized === 'BEGIN' && !triggerBeginSeen) {
      triggerBeginSeen = true;
    }
  };

  const finishStatement = (): void => {
    acceptToken();
    const statement = current.trim();
    current = '';
    if (hasExecutableToken(statement)) {
      assertStatementAllowed(statement);
      if (byteLength(statement) > maxStatementBytes) {
        throw new Error('migration_sql_statement_too_large');
      }
      statements.push(statement);
      if (statements.length > maxStatements) throw new Error('migration_sql_too_many_statements');
    }
    resetStatementState();
  };

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    current += character;

    if (state === 'line_comment') {
      if (character === '\n') state = 'normal';
      continue;
    }
    if (state === 'block_comment') {
      if (character === '*' && next === '/') {
        current += next;
        index += 1;
        state = 'normal';
      }
      continue;
    }
    if (state === 'single_quote' || state === 'double_quote' || state === 'backtick_quote') {
      const delimiter = state === 'single_quote' ? "'" : state === 'double_quote' ? '"' : '`';
      if (character === delimiter) {
        if (next === delimiter) {
          current += next;
          index += 1;
        } else {
          state = 'normal';
        }
      }
      continue;
    }
    if (state === 'bracket_quote') {
      if (character === ']') state = 'normal';
      continue;
    }

    if (character === '-' && next === '-') {
      acceptToken();
      current += next;
      index += 1;
      state = 'line_comment';
    } else if (character === '/' && next === '*') {
      acceptToken();
      current += next;
      index += 1;
      state = 'block_comment';
    } else if (character === "'") {
      acceptToken();
      state = 'single_quote';
    } else if (character === '"') {
      acceptToken();
      state = 'double_quote';
    } else if (character === '`') {
      acceptToken();
      state = 'backtick_quote';
    } else if (character === '[') {
      acceptToken();
      state = 'bracket_quote';
    } else if (/[A-Za-z_]/u.test(character)) {
      token += character;
    } else {
      acceptToken();
      if (character === ';' && (!trigger || triggerEndSeen)) finishStatement();
    }
  }

  if (state !== 'normal' && state !== 'line_comment') {
    throw new Error('migration_sql_unterminated_token');
  }
  finishStatement();
  if (statements.length === 0) throw new Error('migration_sql_empty');
  return statements;
}

export const MIGRATION_SQL_LIMITS = {
  maxMigrationBytes: MAX_MIGRATION_BYTES,
  maxStatementBytes: MAX_STATEMENT_BYTES,
  maxStatements: MAX_STATEMENTS,
} as const;
