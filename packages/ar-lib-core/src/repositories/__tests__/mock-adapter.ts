/**
 * Mock Database Adapter for Testing
 *
 * Provides an in-memory database adapter for unit testing repositories.
 */

import type { DatabaseAdapter, ExecuteResult, TransactionContext } from '../../db/adapter';

interface MockTable {
  rows: Map<string, Record<string, unknown>>;
  primaryKey: string;
}

/**
 * Mock Database Adapter
 *
 * In-memory implementation for testing.
 */
export class MockDatabaseAdapter implements DatabaseAdapter {
  private tables: Map<string, MockTable> = new Map();
  private queryLog: Array<{ sql: string; params?: unknown[] }> = [];

  /**
   * Initialize a table for testing
   */
  initTable(tableName: string, primaryKey: string = 'id'): void {
    this.tables.set(tableName, { rows: new Map(), primaryKey });
  }

  /**
   * Seed data into a table
   */
  seed(tableName: string, rows: Record<string, unknown>[]): void {
    let table = this.tables.get(tableName);
    if (!table) {
      this.initTable(tableName);
      table = this.tables.get(tableName)!;
    }

    for (const row of rows) {
      const pk = row[table.primaryKey] as string;
      table.rows.set(pk, { ...row });
    }
  }

  /**
   * Get all rows from a table (for assertions)
   */
  getAll(tableName: string): Record<string, unknown>[] {
    const table = this.tables.get(tableName);
    return table ? Array.from(table.rows.values()) : [];
  }

  /**
   * Get a single row by primary key (for assertions)
   */
  getById(tableName: string, id: string): Record<string, unknown> | undefined {
    return this.tables.get(tableName)?.rows.get(id);
  }

  /**
   * Get query log (for assertions)
   */
  getQueryLog(): Array<{ sql: string; params?: unknown[] }> {
    return [...this.queryLog];
  }

  /**
   * Clear all data and logs
   */
  reset(): void {
    this.tables.clear();
    this.queryLog = [];
  }

  /**
   * Execute a query that returns multiple rows
   */
  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    this.queryLog.push({ sql, params });

    // Handle COUNT(*) queries
    if (sql.toUpperCase().includes('COUNT(*)')) {
      const tableName = this.extractTableName(sql);
      const table = this.tables.get(tableName);
      if (!table) return [{ count: 0 } as unknown as T];

      const allRows = Array.from(table.rows.values());
      const conditions = this.parseWhereConditions(sql, params);
      const filtered = allRows.filter((row) => this.matchesConditions(row, conditions));

      return [{ count: filtered.length } as unknown as T];
    }

    const tableName = this.extractTableName(sql);
    const table = this.tables.get(tableName);
    if (!table) return [];

    const allRows = Array.from(table.rows.values());

    // Check for special OR pattern: (field1 = ? OR field2 = literal)
    const orPattern = sql.match(
      /WHERE\s+\((\w+)\s*=\s*\?\s+OR\s+(\w+)\s*=\s*([0-9]+|'[^']*'|"[^"]*")\)/i
    );
    if (orPattern) {
      const field1 = orPattern[1];
      const field2 = orPattern[2];
      let literal: unknown = orPattern[3];

      // Parse literal value
      if (/^[0-9]+$/.test(orPattern[3])) {
        literal = parseInt(orPattern[3], 10);
      } else if ((literal as string).startsWith("'") || (literal as string).startsWith('"')) {
        literal = (literal as string).slice(1, -1);
      }

      const value1 = params?.[0];

      // Filter with OR logic
      let results = allRows.filter((row) => row[field1] === value1 || row[field2] === literal);

      // Continue with ORDER BY, LIMIT, OFFSET processing
      // Handle ORDER BY (supports multiple fields)
      const orderMatch = sql.match(/ORDER\s+BY\s+(.+?)(?:\s+LIMIT|\s+OFFSET|$)/i);
      if (orderMatch) {
        const orderClause = orderMatch[1].trim();
        const orderFields = orderClause
          .split(',')
          .map((field) => {
            const match = field.trim().match(/(\w+)\s+(ASC|DESC)?/i);
            if (match) {
              return {
                field: match[1],
                direction: (match[2] || 'ASC').toUpperCase() as 'ASC' | 'DESC',
              };
            }
            return null;
          })
          .filter((f): f is { field: string; direction: 'ASC' | 'DESC' } => f !== null);

        if (orderFields.length > 0) {
          results.sort((a, b) => {
            for (const { field, direction } of orderFields) {
              const aVal = a[field] as number | string;
              const bVal = b[field] as number | string;
              if (aVal < bVal) return direction === 'ASC' ? -1 : 1;
              if (aVal > bVal) return direction === 'ASC' ? 1 : -1;
            }
            return 0;
          });
        }
      }

      // Handle LIMIT and OFFSET
      const limitMatch = sql.match(/LIMIT\s+\?/i);
      const offsetMatch = sql.match(/OFFSET\s+\?/i);

      if (limitMatch || offsetMatch) {
        const { limitVal, offsetVal } = this.extractLimitOffset(sql, params);
        if (offsetVal > 0) {
          results = results.slice(offsetVal);
        }
        if (limitVal > 0) {
          results = results.slice(0, limitVal);
        }
      } else {
        const numericLimitMatch = sql.match(/LIMIT\s+(\d+)/i);
        if (numericLimitMatch) {
          results = results.slice(0, parseInt(numericLimitMatch[1]));
        }
      }

      return results as T[];
    }

    // Standard AND conditions
    const conditions = this.parseWhereConditions(sql, params);

    // Filter rows
    let results = allRows.filter((row) => this.matchesConditions(row, conditions));

    // Handle ORDER BY (supports multiple fields)
    const orderMatch = sql.match(/ORDER\s+BY\s+(.+?)(?:\s+LIMIT|\s+OFFSET|$)/i);
    if (orderMatch) {
      const orderClause = orderMatch[1].trim();
      // Parse multiple order fields: "priority DESC, relation_name ASC"
      const orderFields = orderClause
        .split(',')
        .map((field) => {
          const match = field.trim().match(/(\w+)\s+(ASC|DESC)?/i);
          if (match) {
            return {
              field: match[1],
              direction: (match[2] || 'ASC').toUpperCase() as 'ASC' | 'DESC',
            };
          }
          return null;
        })
        .filter((f): f is { field: string; direction: 'ASC' | 'DESC' } => f !== null);

      if (orderFields.length > 0) {
        results.sort((a, b) => {
          for (const { field, direction } of orderFields) {
            const aVal = a[field] as number | string;
            const bVal = b[field] as number | string;
            if (aVal < bVal) return direction === 'ASC' ? -1 : 1;
            if (aVal > bVal) return direction === 'ASC' ? 1 : -1;
          }
          return 0;
        });
      }
    }

    // Handle LIMIT and OFFSET
    const limitMatch = sql.match(/LIMIT\s+\?/i);
    const offsetMatch = sql.match(/OFFSET\s+\?/i);

    if (limitMatch || offsetMatch) {
      // Find LIMIT and OFFSET values from params
      const { limitVal, offsetVal } = this.extractLimitOffset(sql, params);
      if (offsetVal > 0) {
        results = results.slice(offsetVal);
      }
      if (limitVal > 0) {
        results = results.slice(0, limitVal);
      }
    } else {
      // Handle numeric LIMIT
      const numericLimitMatch = sql.match(/LIMIT\s+(\d+)/i);
      if (numericLimitMatch) {
        results = results.slice(0, parseInt(numericLimitMatch[1]));
      }
    }

    return results as T[];
  }

  /**
   * Execute a query that returns a single row
   */
  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    const results = await this.query<T>(sql, params);
    return results[0] ?? null;
  }

  /**
   * Execute an INSERT/UPDATE/DELETE statement
   */
  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    this.queryLog.push({ sql, params });

    const sqlUpper = sql.toUpperCase().trim();
    const tableName = this.extractTableName(sql);

    if (sqlUpper.startsWith('INSERT')) {
      return this.handleInsert(tableName, sql, params);
    } else if (sqlUpper.startsWith('UPDATE')) {
      return this.handleUpdate(tableName, sql, params);
    } else if (sqlUpper.startsWith('DELETE')) {
      return this.handleDelete(tableName, sql, params);
    }

    return { success: true, rowsAffected: 0, lastRowId: null };
  }

  /**
   * Execute a transaction
   */
  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    // Simple mock transaction - no rollback support
    const tx: TransactionContext = {
      query: this.query.bind(this),
      queryOne: this.queryOne.bind(this),
      execute: this.execute.bind(this),
    };
    return fn(tx);
  }

  /**
   * Execute multiple statements in a batch
   */
  async batch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<ExecuteResult[]> {
    const results: ExecuteResult[] = [];
    for (const stmt of statements) {
      results.push(await this.execute(stmt.sql, stmt.params));
    }
    return results;
  }

  /**
   * Check if adapter is healthy
   */
  async isHealthy(): Promise<boolean> {
    return true;
  }

  // ========== Private Helpers ==========

  private extractTableName(sql: string): string {
    // FROM tablename / INTO tablename / UPDATE tablename / DELETE FROM tablename
    const fromMatch = sql.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
    return fromMatch?.[1] ?? '';
  }

  private parseWhereConditions(
    sql: string,
    params?: unknown[]
  ): Array<{ field: string; value: unknown; operator?: string }> {
    const conditions: Array<{ field: string; value: unknown; operator?: string }> = [];
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|$)/i);
    if (!whereMatch) return conditions;

    const wherePart = whereMatch[1];

    // Parse placeholder conditions (field = ?)
    const placeholderFields = wherePart.match(/(\w+)\s*=\s*\?/g);
    let paramIndex = 0;

    if (placeholderFields && params) {
      for (const match of placeholderFields) {
        const fieldName = match.match(/(\w+)\s*=/)?.[1];
        if (fieldName && paramIndex < params.length) {
          conditions.push({ field: fieldName, value: params[paramIndex] });
          paramIndex++;
        }
      }
    }

    // Parse comparison operators (field <= ?, field > ?, etc.)
    const comparisonMatches = wherePart.match(/(\w+)\s*(<=|>=|<|>)\s*\?/g);
    if (comparisonMatches && params) {
      for (const match of comparisonMatches) {
        const parts = match.match(/(\w+)\s*(<=|>=|<|>)\s*\?/);
        if (parts && paramIndex < params.length) {
          conditions.push({
            field: parts[1],
            value: params[paramIndex],
            operator: parts[2],
          });
          paramIndex++;
        }
      }
    }

    // Parse IS NULL conditions
    const isNullMatches = wherePart.match(/(\w+)\s+IS\s+NULL/gi);
    if (isNullMatches) {
      for (const match of isNullMatches) {
        const parts = match.match(/(\w+)\s+IS\s+NULL/i);
        if (parts) {
          conditions.push({ field: parts[1], value: null, operator: 'IS NULL' });
        }
      }
    }

    // Parse literal value conditions (field = 0, field = 'value')
    const literalMatches = wherePart.match(/(\w+)\s*=\s*([0-9]+|'[^']*'|"[^"]*")/g);
    if (literalMatches) {
      for (const match of literalMatches) {
        const parts = match.match(/(\w+)\s*=\s*([0-9]+|'[^']*'|"[^"]*")/);
        if (parts) {
          let value: unknown = parts[2];
          // Parse numeric literals
          if (/^[0-9]+$/.test(parts[2])) {
            value = parseInt(parts[2], 10);
          }
          // Remove quotes from string literals
          else if ((value as string).startsWith("'") || (value as string).startsWith('"')) {
            value = (value as string).slice(1, -1);
          }
          conditions.push({ field: parts[1], value, operator: '=' });
        }
      }
    }

    // Parse IS NOT NULL conditions
    const isNotNullMatches = wherePart.match(/(\w+)\s+IS\s+NOT\s+NULL/gi);
    if (isNotNullMatches) {
      for (const match of isNotNullMatches) {
        const parts = match.match(/(\w+)\s+IS\s+NOT\s+NULL/i);
        if (parts) {
          conditions.push({ field: parts[1], value: null, operator: 'IS NOT NULL' });
        }
      }
    }

    // Parse literal string conditions (field = 'value')
    const stringMatches = wherePart.match(/(\w+)\s*=\s*'([^']*)'/g);
    if (stringMatches) {
      for (const match of stringMatches) {
        const parts = match.match(/(\w+)\s*=\s*'([^']*)'/);
        if (parts) {
          const fieldName = parts[1];
          const value = parts[2];
          const exists = conditions.some((c) => c.field === fieldName);
          if (!exists) {
            conditions.push({ field: fieldName, value });
          }
        }
      }
    }

    return conditions;
  }

  /**
   * Extract LIMIT and OFFSET values from params
   * Params order: WHERE params, then LIMIT, then OFFSET
   */
  private extractLimitOffset(
    sql: string,
    params?: unknown[]
  ): { limitVal: number; offsetVal: number } {
    if (!params) return { limitVal: 0, offsetVal: 0 };

    // Count WHERE conditions
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|$)/i);
    let whereParamCount = 0;
    if (whereMatch) {
      const wherePart = whereMatch[1];
      const matches = wherePart.match(/\?/g);
      whereParamCount = matches ? matches.length : 0;
    }

    // Params after WHERE are LIMIT and OFFSET
    const hasLimit = sql.toUpperCase().includes('LIMIT');
    const hasOffset = sql.toUpperCase().includes('OFFSET');

    let limitVal = 0;
    let offsetVal = 0;

    if (hasLimit && hasOffset) {
      limitVal = (params[whereParamCount] as number) || 0;
      offsetVal = (params[whereParamCount + 1] as number) || 0;
    } else if (hasLimit) {
      limitVal = (params[whereParamCount] as number) || 0;
    } else if (hasOffset) {
      offsetVal = (params[whereParamCount] as number) || 0;
    }

    return { limitVal, offsetVal };
  }

  private matchesConditions(
    row: Record<string, unknown>,
    conditions: Array<{ field: string; value: unknown; operator?: string }>
  ): boolean {
    for (const cond of conditions) {
      const rowValue = row[cond.field];

      if (cond.operator === 'IS NULL') {
        if (rowValue !== null && rowValue !== undefined) {
          return false;
        }
      } else if (cond.operator === 'IS NOT NULL') {
        if (rowValue === null || rowValue === undefined) {
          return false;
        }
      } else if (cond.operator === '<=') {
        if ((rowValue as number) > (cond.value as number)) {
          return false;
        }
      } else if (cond.operator === '>=') {
        if ((rowValue as number) < (cond.value as number)) {
          return false;
        }
      } else if (cond.operator === '<') {
        if ((rowValue as number) >= (cond.value as number)) {
          return false;
        }
      } else if (cond.operator === '>') {
        if ((rowValue as number) <= (cond.value as number)) {
          return false;
        }
      } else {
        // Default equality check
        if (rowValue !== cond.value) {
          return false;
        }
      }
    }
    return true;
  }

  private handleInsert(tableName: string, sql: string, params?: unknown[]): ExecuteResult {
    let table = this.tables.get(tableName);
    if (!table) {
      this.initTable(tableName);
      table = this.tables.get(tableName)!;
    }

    // Parse column names from INSERT INTO table (col1, col2, ...) VALUES (?, ?, ...)
    const columnsMatch = sql.match(/\(([^)]+)\)\s*\bVALUES\b/i);
    if (!columnsMatch || !params) {
      return { success: false, rowsAffected: 0, lastRowId: null };
    }

    const columns = columnsMatch[1].split(',').map((c) => c.trim());
    const valuesMatch = sql.match(/\bVALUES\b\s*\(([^)]+)\)/i);
    const valueTokens = valuesMatch
      ? valuesMatch[1].split(',').map((value) => value.trim())
      : columns.map(() => '?');
    const row: Record<string, unknown> = {};
    let paramIndex = 0;

    columns.forEach((col, idx) => {
      const token = valueTokens[idx] ?? '?';
      if (token === '?') {
        row[col] = params[paramIndex];
        paramIndex++;
      } else if (/^NULL$/i.test(token)) {
        row[col] = null;
      } else if (/^[0-9]+$/.test(token)) {
        row[col] = Number.parseInt(token, 10);
      } else if (token.startsWith("'") || token.startsWith('"')) {
        row[col] = token.slice(1, -1);
      } else {
        row[col] = token;
      }
    });

    const pk = row[table.primaryKey] as string;
    table.rows.set(pk, row);

    return { success: true, rowsAffected: 1, lastRowId: pk };
  }

  private handleUpdate(tableName: string, sql: string, params?: unknown[]): ExecuteResult {
    const table = this.tables.get(tableName);
    if (!table || !params) {
      return { success: true, rowsAffected: 0, lastRowId: null };
    }

    // Parse SET clause and WHERE clause
    const setMatch = sql.match(/SET\s+([\s\S]+?)\s+WHERE/i);
    const whereMatch = sql.match(/WHERE\s+([\s\S]+?)$/i);

    if (!setMatch || !whereMatch) {
      return { success: true, rowsAffected: 0, lastRowId: null };
    }

    const setClause = setMatch[1];
    const whereClause = whereMatch[1];

    // Build update data
    const updateData: Record<string, unknown> = {};
    let paramIndex = 0;
    for (const assignment of setClause.split(',')) {
      const match = assignment.trim().match(/(\w+)\s*=\s*(.+)$/);
      if (!match) continue;
      const field = match[1];
      const token = match[2].trim();
      if (token === '?') {
        updateData[field] = params[paramIndex];
        paramIndex++;
      } else if (/^NULL$/i.test(token)) {
        updateData[field] = null;
      } else if (/^[0-9]+$/.test(token)) {
        updateData[field] = Number.parseInt(token, 10);
      } else if (token.startsWith("'") || token.startsWith('"')) {
        updateData[field] = token.slice(1, -1);
      } else {
        updateData[field] = token;
      }
    }

    // Parse WHERE conditions (both placeholders and literals)
    const conditions: Array<{ field: string; value: unknown }> = [];
    const whereParts = whereClause.split(/\s+AND\s+/i);

    whereParts.forEach((part) => {
      part = part.trim();
      // Match field = ? (placeholder)
      const placeholderMatch = part.match(/(\w+)\s*=\s*\?/);
      if (placeholderMatch) {
        conditions.push({ field: placeholderMatch[1], value: params[paramIndex] });
        paramIndex++;
        return;
      }
      // Match field = literal (number or string)
      const literalMatch = part.match(/(\w+)\s*=\s*([0-9]+|'[^']*'|"[^"]*")/);
      if (literalMatch) {
        let value: unknown = literalMatch[2];
        // Parse numeric literals
        if (/^[0-9]+$/.test(literalMatch[2])) {
          value = parseInt(literalMatch[2], 10);
        }
        // Remove quotes from string literals
        else if ((value as string).startsWith("'") || (value as string).startsWith('"')) {
          value = (value as string).slice(1, -1);
        }
        conditions.push({ field: literalMatch[1], value });
      }
    });

    // Update matching rows
    let rowsAffected = 0;
    for (const [pk, row] of table.rows.entries()) {
      if (this.matchesConditions(row, conditions)) {
        Object.assign(row, updateData);
        table.rows.set(pk, row);
        rowsAffected++;
      }
    }

    return { success: true, rowsAffected, lastRowId: null };
  }

  private handleDelete(tableName: string, sql: string, params?: unknown[]): ExecuteResult {
    const table = this.tables.get(tableName);
    if (!table) {
      return { success: true, rowsAffected: 0, lastRowId: null };
    }

    const conditions = this.parseWhereConditions(sql, params);
    let rowsAffected = 0;

    for (const [pk, row] of table.rows.entries()) {
      if (this.matchesConditions(row, conditions)) {
        table.rows.delete(pk);
        rowsAffected++;
      }
    }

    return { success: true, rowsAffected, lastRowId: null };
  }
}
