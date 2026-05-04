/**
 * Database Adapter Interface
 *
 * Provides an abstraction layer for database operations, enabling:
 * - Multiple backend support (D1, Postgres via Hyperdrive, DynamoDB, etc.)
 * - Mock adapters for testing
 * - Partition-specific adapters (different backends per partition)
 *
 * Design decisions:
 * - Generic methods for type-safe queries
 * - Transaction support with context passing
 * - Batch operations for performance
 * - Health check for monitoring
 */
// =============================================================================
// SQL Utilities
// =============================================================================
/**
 * Escape special characters in a LIKE pattern to prevent SQL injection
 *
 * LIKE patterns treat `%` and `_` as wildcards:
 * - `%` matches zero or more characters
 * - `_` matches exactly one character
 *
 * When user input is used in LIKE patterns, these characters must be escaped
 * to be treated as literal characters.
 *
 * @param pattern - The user input to escape
 * @returns Escaped pattern safe for use in LIKE clauses
 *
 * @example
 * ```typescript
 * const search = "test%user_name";
 * const escaped = escapeLikePattern(search);
 * // escaped = "test\\%user\\_name"
 *
 * await adapter.query(
 *   'SELECT * FROM users WHERE name LIKE ?',
 *   [`%${escaped}%`]
 * );
 * ```
 */
export function escapeLikePattern(pattern) {
    // Escape backslash first (since it's the escape character)
    // then escape % and _
    return pattern.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
