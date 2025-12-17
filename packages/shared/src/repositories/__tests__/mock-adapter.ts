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
    const conditions = this.parseWhereConditions(sql, params);

    // Filter rows
    let results = allRows.filter((row) => this.matchesConditions(row, conditions));

    // Handle ORDER BY
    const orderMatch = sql.match(/ORDER\s+BY\s+(\w+)\s+(ASC|DESC)?/i);
    if (orderMatch) {
      const orderField = orderMatch[1];
      const orderDir = (orderMatch[2] || 'ASC').toUpperCase();
      results.sort((a, b) => {
        const aVal = a[orderField] as number | string;
        const bVal = b[orderField] as number | string;
        if (aVal < bVal) return orderDir === 'ASC' ? -1 : 1;
        if (aVal > bVal) return orderDir === 'ASC' ? 1 : -1;
        return 0;
      });
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
  ): Array<{ field: string; value: unknown }> {
    const conditions: Array<{ field: string; value: unknown }> = [];
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

    // Parse literal number conditions (field = 1, field = 0)
    const literalMatches = wherePart.match(/(\w+)\s*=\s*(\d+)/g);
    if (literalMatches) {
      for (const match of literalMatches) {
        const parts = match.match(/(\w+)\s*=\s*(\d+)/);
        if (parts && !match.includes('?')) {
          // Only add if not already a placeholder condition
          const fieldName = parts[1];
          const value = parseInt(parts[2], 10);
          // Check if field was already added via placeholder
          const exists = conditions.some((c) => c.field === fieldName);
          if (!exists) {
            conditions.push({ field: fieldName, value });
          }
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
    conditions: Array<{ field: string; value: unknown }>
  ): boolean {
    for (const cond of conditions) {
      if (row[cond.field] !== cond.value) {
        return false;
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
    const columnsMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
    if (!columnsMatch || !params) {
      return { success: false, rowsAffected: 0, lastRowId: null };
    }

    const columns = columnsMatch[1].split(',').map((c) => c.trim());
    const row: Record<string, unknown> = {};

    columns.forEach((col, idx) => {
      row[col] = params[idx];
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
    const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i);
    const whereMatch = sql.match(/WHERE\s+(.+?)$/i);

    if (!setMatch || !whereMatch) {
      return { success: true, rowsAffected: 0, lastRowId: null };
    }

    const setClause = setMatch[1];
    const whereClause = whereMatch[1];

    // Parse SET fields
    const setFields = setClause.split(',').map((s) => s.trim().split('=')[0].trim());
    const setParamCount = setFields.length;

    // Parse WHERE fields
    const whereFields = whereClause.match(/(\w+)\s*=\s*\?/g) || [];
    const whereParamCount = whereFields.length;

    // Split params
    const setParams = params.slice(0, setParamCount);
    const whereParams = params.slice(setParamCount, setParamCount + whereParamCount);

    // Build update data
    const updateData: Record<string, unknown> = {};
    setFields.forEach((field, idx) => {
      updateData[field] = setParams[idx];
    });

    // Build conditions
    const conditions: Array<{ field: string; value: unknown }> = [];
    whereFields.forEach((match, idx) => {
      const fieldName = match.match(/(\w+)\s*=/)?.[1];
      if (fieldName) {
        conditions.push({ field: fieldName, value: whereParams[idx] });
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
