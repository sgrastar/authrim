/** Typed row decoder for trusted SQLite module schemas, not a generic SQL import endpoint. */
export interface SqliteRowInsert {
  sql: string;
  params: Array<string | Uint8Array | null>;
}

const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('snapshot_invalid_identifier');
  return `"${value}"`;
};

export function sqliteSnapshotRowInsert(
  table: string,
  columns: readonly string[],
  rowJson: string
): SqliteRowInsert {
  const tableSql = identifier(table);
  if (!columns.length || new Set(columns).size !== columns.length) {
    throw new Error('snapshot_invalid_columns');
  }
  const columnSql = columns.map(identifier);
  const row: unknown = JSON.parse(rowJson);
  if (!row || typeof row !== 'object' || Array.isArray(row))
    throw new Error('snapshot_invalid_row');
  const fields = Object.keys(row);
  if (fields.length !== columns.length || fields.some((field) => !columns.includes(field))) {
    throw new Error('snapshot_row_schema_mismatch');
  }
  const params: SqliteRowInsert['params'] = [];
  const expressions = columns.map((column) => {
    const field: unknown = (row as Record<string, unknown>)[column];
    if (!Array.isArray(field) || field.length !== 2) throw new Error('snapshot_invalid_value');
    const type: unknown = field[0];
    const value: unknown = field[1];
    if (type === 'null' && value === null) {
      params.push(null);
      return '?';
    }
    if (typeof value !== 'string') throw new Error('snapshot_invalid_value');
    if (type === 'text') {
      params.push(value);
      return '?';
    }
    if (type === 'integer') {
      if (!/^(0|-?[1-9][0-9]{0,18})$/.test(value)) throw new Error('snapshot_invalid_integer');
      const integer = BigInt(value);
      if (integer < -(2n ** 63n) || integer > 2n ** 63n - 1n) {
        throw new Error('snapshot_integer_out_of_range');
      }
      params.push(value);
      return 'CAST(? AS INTEGER)';
    }
    if (type === 'real') {
      if (value === 'Inf') return '1e999';
      if (value === '-Inf') return '-1e999';
      if (
        !/^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value) ||
        !Number.isFinite(Number(value))
      ) {
        throw new Error('snapshot_invalid_real');
      }
      params.push(value);
      return 'CAST(? AS REAL)';
    }
    if (type === 'blob') {
      if (!/^(?:[0-9A-F]{2})*$/.test(value)) throw new Error('snapshot_invalid_blob');
      const bytes = new Uint8Array(value.length / 2);
      for (let index = 0; index < bytes.length; index++) {
        bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
      }
      params.push(bytes);
      return '?';
    }
    throw new Error('snapshot_unknown_value_type');
  });
  return {
    sql: `INSERT INTO ${tableSql} (${columnSql.join(', ')}) VALUES (${expressions.join(', ')})`,
    params,
  };
}
