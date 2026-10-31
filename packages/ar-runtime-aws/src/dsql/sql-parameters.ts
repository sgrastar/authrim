/**
 * Convert the adapter's question-mark parameters without modifying SQL literals/comments.
 * Native PostgreSQL parameters are also accepted, but cannot be mixed with question marks.
 * Use native parameters and jsonb_exists() rather than PostgreSQL's ambiguous bare ? operator.
 */
export function toDsqlSql(sql: string): string {
  let output = '';
  let position = 0;
  let parameter = 0;
  let nativeParameters = false;
  const invalid = () => {
    throw new Error('aurora_dsql_sql_parameters_invalid');
  };
  if (typeof sql !== 'string' || sql.length === 0) invalid();
  while (position < sql.length) {
    const character = sql[position];
    const next = sql[position + 1];
    if (character === '-' && next === '-') {
      const end = sql.indexOf('\n', position + 2);
      const limit = end === -1 ? sql.length : end + 1;
      output += sql.slice(position, limit);
      position = limit;
      continue;
    }
    if (character === '/' && next === '*') {
      const start = position;
      let depth = 1;
      position += 2;
      while (position < sql.length && depth > 0) {
        if (sql[position] === '/' && sql[position + 1] === '*') {
          depth += 1;
          position += 2;
        } else if (sql[position] === '*' && sql[position + 1] === '/') {
          depth -= 1;
          position += 2;
        } else position += 1;
      }
      if (depth !== 0) invalid();
      output += sql.slice(start, position);
      continue;
    }
    if (character === "'" || character === '"') {
      const start = position;
      const escaped =
        character === "'" &&
        /[eE]/u.test(sql[position - 1] ?? '') &&
        (position === 1 || !/[A-Za-z0-9_$]/u.test(sql[position - 2]));
      position += 1;
      let closed = false;
      while (position < sql.length) {
        if (escaped && sql[position] === '\\') {
          position += 2;
        } else if (sql[position] === character) {
          if (sql[position + 1] === character) position += 2;
          else {
            position += 1;
            closed = true;
            break;
          }
        } else position += 1;
      }
      if (!closed) invalid();
      output += sql.slice(start, position);
      continue;
    }
    if (character === '$') {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(position))?.[0];
      if (delimiter) {
        const end = sql.indexOf(delimiter, position + delimiter.length);
        if (end === -1) invalid();
        const limit = end + delimiter.length;
        output += sql.slice(position, limit);
        position = limit;
        continue;
      }
      if (/\d/u.test(next ?? '')) nativeParameters = true;
    }
    if (character === '?') {
      if (next === '|' || next === '&') invalid();
      parameter += 1;
      output += `$${parameter}`;
    } else output += character;
    position += 1;
  }
  if (parameter > 0 && nativeParameters) invalid();
  return output;
}
