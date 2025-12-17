/**
 * Base Repository
 *
 * Abstract base class for all repositories.
 * Provides common functionality:
 * - CRUD operations
 * - Pagination
 * - Filtering
 * - ID generation
 *
 * Design decisions:
 * - Uses DatabaseAdapter for database operations (enables testing/mocking)
 * - Generic type parameter for entity type
 * - Soft delete support via is_active flag
 * - Audit fields (created_at, updated_at) handling
 */

import type { DatabaseAdapter, ExecuteResult, PIIStatus, PIIClass } from '../db/adapter';

/**
 * Base entity interface
 * All entities should extend this interface
 */
export interface BaseEntity {
  id: string;
  created_at: number;
  updated_at: number;
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  /** Page number (1-indexed) */
  page?: number;
  /** Items per page (default: 20, max: 100) */
  limit?: number;
  /** Sort field */
  sortBy?: string;
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Pagination result
 */
export interface PaginationResult<T> {
  /** Items in current page */
  items: T[];
  /** Total item count */
  total: number;
  /** Current page number */
  page: number;
  /** Items per page */
  limit: number;
  /** Total pages */
  totalPages: number;
  /** Has next page */
  hasNext: boolean;
  /** Has previous page */
  hasPrev: boolean;
}

/**
 * Filter operator types
 */
export type FilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in';

/**
 * Filter condition
 */
export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value: unknown;
}

/**
 * Repository configuration
 */
export interface RepositoryConfig {
  /** Table name in the database */
  tableName: string;
  /** Primary key field (default: 'id') */
  primaryKey?: string;
  /** Enable soft delete (default: true) */
  softDelete?: boolean;
  /** Soft delete field (default: 'is_active') */
  softDeleteField?: string;
  /** Allowed fields for sorting and filtering (prevents SQL injection) */
  allowedFields?: string[];
}

/**
 * Default allowed fields for all repositories
 * (base entity fields)
 */
const DEFAULT_ALLOWED_FIELDS = ['id', 'created_at', 'updated_at'];

/**
 * Generate a unique ID
 * Uses crypto.randomUUID() for UUIDv4 generation
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Get current timestamp in milliseconds
 */
export function getCurrentTimestamp(): number {
  return Date.now();
}

/**
 * Base Repository class
 *
 * @typeParam T - Entity type extending BaseEntity
 */
export abstract class BaseRepository<T extends BaseEntity> {
  protected readonly adapter: DatabaseAdapter;
  protected readonly tableName: string;
  protected readonly primaryKey: string;
  protected readonly softDelete: boolean;
  protected readonly softDeleteField: string;
  protected readonly allowedFields: Set<string>;

  constructor(adapter: DatabaseAdapter, config: RepositoryConfig) {
    this.adapter = adapter;
    this.tableName = config.tableName;
    this.primaryKey = config.primaryKey ?? 'id';
    this.softDelete = config.softDelete ?? true;
    this.softDeleteField = config.softDeleteField ?? 'is_active';
    // Build allowed fields set from config + defaults + soft delete field
    const fields = new Set([...DEFAULT_ALLOWED_FIELDS, ...(config.allowedFields ?? [])]);
    if (config.softDeleteField) {
      fields.add(config.softDeleteField);
    }
    this.allowedFields = fields;
  }

  /**
   * Validate a field name against allowed fields
   * Throws an error if the field is not allowed (prevents SQL injection)
   *
   * @param field - Field name to validate
   * @param context - Context for error message (e.g., 'sortBy', 'filter')
   * @returns The validated field name
   */
  protected validateFieldName(field: string, context: string): string {
    // Simple alphanumeric + underscore validation as first line of defense
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
      throw new Error(`Invalid ${context} field name: ${field}`);
    }
    // Check against allowlist
    if (!this.allowedFields.has(field)) {
      throw new Error(`Field '${field}' is not allowed for ${context}`);
    }
    return field;
  }

  /**
   * Validate sort order (must be 'asc' or 'desc')
   *
   * @param order - Sort order to validate
   * @returns Validated sort order (defaults to 'desc' if invalid)
   */
  protected validateSortOrder(order: string | undefined): 'asc' | 'desc' {
    const normalized = order?.toLowerCase();
    if (normalized === 'asc' || normalized === 'desc') {
      return normalized;
    }
    return 'desc'; // Safe default
  }

  /**
   * Find entity by ID
   *
   * @param id - Entity ID
   * @returns Entity or null if not found
   */
  async findById(id: string): Promise<T | null> {
    const sql = this.softDelete
      ? `SELECT * FROM ${this.tableName} WHERE ${this.primaryKey} = ? AND ${this.softDeleteField} = 1`
      : `SELECT * FROM ${this.tableName} WHERE ${this.primaryKey} = ?`;

    return this.adapter.queryOne<T>(sql, [id]);
  }

  /**
   * Find all entities matching conditions
   *
   * @param conditions - Filter conditions
   * @param options - Pagination options
   * @returns Paginated result
   */
  async findAll(
    conditions?: FilterCondition[],
    options?: PaginationOptions
  ): Promise<PaginationResult<T>> {
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 20));
    const offset = (page - 1) * limit;

    // Validate and sanitize sort parameters (prevents SQL injection)
    const sortBy = this.validateFieldName(options?.sortBy ?? 'created_at', 'sortBy');
    const sortOrder = this.validateSortOrder(options?.sortOrder);

    // Build WHERE clause
    const { whereClause, params } = this.buildWhereClause(conditions);

    // Count query
    const countSql = `SELECT COUNT(*) as count FROM ${this.tableName} ${whereClause}`;
    const countResult = await this.adapter.queryOne<{ count: number }>(countSql, params);
    const total = countResult?.count ?? 0;

    // Data query (sortBy and sortOrder are now validated)
    const dataSql = `SELECT * FROM ${this.tableName} ${whereClause} ORDER BY ${sortBy} ${sortOrder.toUpperCase()} LIMIT ? OFFSET ?`;
    const items = await this.adapter.query<T>(dataSql, [...params, limit, offset]);

    const totalPages = Math.ceil(total / limit);

    return {
      items,
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /**
   * Find one entity matching conditions
   *
   * @param conditions - Filter conditions
   * @returns Entity or null if not found
   */
  async findOne(conditions: FilterCondition[]): Promise<T | null> {
    const { whereClause, params } = this.buildWhereClause(conditions);
    const sql = `SELECT * FROM ${this.tableName} ${whereClause} LIMIT 1`;
    return this.adapter.queryOne<T>(sql, params);
  }

  /**
   * Validate field name for create/update operations (prevents SQL injection)
   * Unlike validateFieldName which throws, this returns boolean for filtering.
   *
   * @param field - Field name to validate
   * @returns True if field is allowed
   */
  protected isAllowedField(field: string): boolean {
    // First check: alphanumeric + underscore only
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
      return false;
    }
    // Second check: must be in allowed fields list OR be a base field
    return this.allowedFields.has(field);
  }

  /**
   * Create a new entity
   *
   * @param data - Entity data (without id, created_at, updated_at)
   * @returns Created entity
   */
  async create(data: Omit<T, 'id' | 'created_at' | 'updated_at'> & { id?: string }): Promise<T> {
    const id = data.id ?? generateId();
    const now = getCurrentTimestamp();

    const entityData = {
      ...data,
      id,
      created_at: now,
      updated_at: now,
    };

    // Filter and validate field names to prevent SQL injection
    const fields = Object.keys(entityData).filter((field) => {
      if (!this.isAllowedField(field)) {
        console.warn(
          `BaseRepository.create: Invalid field '${field}' ignored in ${this.tableName}`
        );
        return false;
      }
      return true;
    });

    if (fields.length === 0) {
      throw new Error(`BaseRepository.create: No valid fields provided for ${this.tableName}`);
    }

    const placeholders = fields.map(() => '?').join(', ');
    const values = fields.map((f) => entityData[f as keyof typeof entityData]);

    const sql = `INSERT INTO ${this.tableName} (${fields.join(', ')}) VALUES (${placeholders})`;
    await this.adapter.execute(sql, values);

    return entityData as T;
  }

  /**
   * Update an entity
   *
   * @param id - Entity ID
   * @param data - Fields to update
   * @returns Updated entity or null if not found
   */
  async update(
    id: string,
    data: Partial<Omit<T, 'id' | 'created_at' | 'updated_at'>>
  ): Promise<T | null> {
    // Check if entity exists
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }

    const now = getCurrentTimestamp();
    const updateData = {
      ...data,
      updated_at: now,
    };

    // Filter and validate field names to prevent SQL injection
    const fields = Object.keys(updateData).filter((field) => {
      const value = updateData[field as keyof typeof updateData];
      if (value === undefined) return false;

      if (!this.isAllowedField(field)) {
        console.warn(
          `BaseRepository.update: Invalid field '${field}' ignored in ${this.tableName}`
        );
        return false;
      }
      return true;
    });

    if (fields.length === 0) {
      // No valid fields to update, return existing entity
      return existing;
    }

    const setClause = fields.map((f) => `${f} = ?`).join(', ');
    const values = fields.map((f) => updateData[f as keyof typeof updateData]);

    const sql = `UPDATE ${this.tableName} SET ${setClause} WHERE ${this.primaryKey} = ?`;
    await this.adapter.execute(sql, [...values, id]);

    return this.findById(id);
  }

  /**
   * Delete an entity
   *
   * If soft delete is enabled, sets is_active to 0.
   * Otherwise, performs hard delete.
   *
   * @param id - Entity ID
   * @returns True if deleted, false if not found
   */
  async delete(id: string): Promise<boolean> {
    if (this.softDelete) {
      const result = await this.adapter.execute(
        `UPDATE ${this.tableName} SET ${this.softDeleteField} = 0, updated_at = ? WHERE ${this.primaryKey} = ?`,
        [getCurrentTimestamp(), id]
      );
      return result.rowsAffected > 0;
    } else {
      const result = await this.adapter.execute(
        `DELETE FROM ${this.tableName} WHERE ${this.primaryKey} = ?`,
        [id]
      );
      return result.rowsAffected > 0;
    }
  }

  /**
   * Hard delete an entity (bypasses soft delete)
   *
   * @param id - Entity ID
   * @returns True if deleted, false if not found
   */
  async hardDelete(id: string): Promise<boolean> {
    const result = await this.adapter.execute(
      `DELETE FROM ${this.tableName} WHERE ${this.primaryKey} = ?`,
      [id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Check if entity exists
   *
   * @param id - Entity ID
   * @returns True if exists
   */
  async exists(id: string): Promise<boolean> {
    const sql = this.softDelete
      ? `SELECT 1 FROM ${this.tableName} WHERE ${this.primaryKey} = ? AND ${this.softDeleteField} = 1`
      : `SELECT 1 FROM ${this.tableName} WHERE ${this.primaryKey} = ?`;

    const result = await this.adapter.queryOne<{ 1: number }>(sql, [id]);
    return result !== null;
  }

  /**
   * Count entities matching conditions
   *
   * @param conditions - Filter conditions
   * @returns Count
   */
  async count(conditions?: FilterCondition[]): Promise<number> {
    const { whereClause, params } = this.buildWhereClause(conditions);
    const sql = `SELECT COUNT(*) as count FROM ${this.tableName} ${whereClause}`;
    const result = await this.adapter.queryOne<{ count: number }>(sql, params);
    return result?.count ?? 0;
  }

  /**
   * Build WHERE clause from conditions
   */
  protected buildWhereClause(conditions?: FilterCondition[]): {
    whereClause: string;
    params: unknown[];
  } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    // Add soft delete condition
    if (this.softDelete) {
      clauses.push(`${this.softDeleteField} = 1`);
    }

    // Add user conditions
    if (conditions && conditions.length > 0) {
      for (const condition of conditions) {
        const { clause, value } = this.buildCondition(condition);
        clauses.push(clause);
        if (Array.isArray(value)) {
          params.push(...value);
        } else {
          params.push(value);
        }
      }
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    return { whereClause, params };
  }

  /**
   * Build a single condition clause
   * Field names are validated against allowedFields to prevent SQL injection
   */
  protected buildCondition(condition: FilterCondition): { clause: string; value: unknown } {
    const { field, operator, value } = condition;

    // Validate field name to prevent SQL injection
    const validatedField = this.validateFieldName(field, 'filter');

    switch (operator) {
      case 'eq':
        return { clause: `${validatedField} = ?`, value };
      case 'ne':
        return { clause: `${validatedField} != ?`, value };
      case 'gt':
        return { clause: `${validatedField} > ?`, value };
      case 'gte':
        return { clause: `${validatedField} >= ?`, value };
      case 'lt':
        return { clause: `${validatedField} < ?`, value };
      case 'lte':
        return { clause: `${validatedField} <= ?`, value };
      case 'like':
        // Escape SQL LIKE wildcards (% and _) to prevent unintended pattern matching
        const escapedValue = String(value).replace(/[%_]/g, (char) => `\\${char}`);
        return { clause: `${validatedField} LIKE ? ESCAPE '\\'`, value: `%${escapedValue}%` };
      case 'in':
        if (!Array.isArray(value)) {
          throw new Error('IN operator requires array value');
        }
        const placeholders = value.map(() => '?').join(', ');
        return { clause: `${validatedField} IN (${placeholders})`, value };
      default:
        throw new Error(`Unknown operator: ${operator}`);
    }
  }

  /**
   * Get the database adapter
   * Useful for custom queries
   */
  getAdapter(): DatabaseAdapter {
    return this.adapter;
  }
}

/**
 * Re-export types for convenience
 */
export type { DatabaseAdapter, ExecuteResult, PIIStatus, PIIClass };
