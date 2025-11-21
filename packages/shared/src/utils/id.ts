/**
 * ID Generation Utilities
 */

/**
 * Generate a unique ID using UUID v4
 *
 * @returns UUID v4 string
 */
export function generateId(): string {
  return crypto.randomUUID();
}
