/**
 * IdP Claim Normalizer
 *
 * Normalizes claims from different IdPs into consistent types
 * for rule evaluation.
 *
 * Handles:
 * - Single value vs array conversion
 * - Type coercion (number/string)
 * - Null/undefined handling
 * - Nested object access via dot notation
 */

import type { ConditionOperator } from '../types/policy-rules';
import { createLogger } from './logger';

const log = createLogger().module('CLAIM_NORMALIZER');

// =============================================================================
// Normalized Claim Value Types
// =============================================================================

/**
 * Normalized claim value types
 * All claim values are normalized to one of these types
 */
export type NormalizedClaimValue =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'array'; value: string[] }
  | { type: 'null' };

// =============================================================================
// Value Extraction
// =============================================================================

/**
 * Get nested value from object using dot notation
 *
 * @param obj - Source object
 * @param path - Dot-separated path (e.g., "address.country", "groups")
 * @returns Value at path or undefined
 *
 * @example
 * getNestedValue({ address: { country: "US" } }, "address.country") // "US"
 * getNestedValue({ groups: ["admin"] }, "groups") // ["admin"]
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) {
    return undefined;
  }

  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

// =============================================================================
// Normalization
// =============================================================================

/**
 * Normalize a claim value to a consistent type
 *
 * Normalization rules:
 * - null/undefined → { type: 'null' }
 * - string → { type: 'string', value: string }
 * - number → { type: 'number', value: number }
 * - boolean → { type: 'boolean', value: boolean }
 * - array of strings → { type: 'array', value: string[] }
 * - array of mixed → { type: 'array', value: string[] } (stringified)
 * - object → { type: 'string', value: JSON.stringify }
 *
 * @param value - Raw claim value
 * @returns Normalized value
 */
export function normalizeClaimValue(value: unknown): NormalizedClaimValue {
  // Null or undefined
  if (value === null || value === undefined) {
    return { type: 'null' };
  }

  // Boolean
  if (typeof value === 'boolean') {
    return { type: 'boolean', value };
  }

  // Number
  if (typeof value === 'number') {
    return { type: 'number', value };
  }

  // String
  if (typeof value === 'string') {
    return { type: 'string', value };
  }

  // Array
  if (Array.isArray(value)) {
    // Convert all elements to strings
    const stringValues = value.map((v) => {
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return String(v);
      if (typeof v === 'boolean') return String(v);
      return JSON.stringify(v);
    });
    return { type: 'array', value: stringValues };
  }

  // Object - stringify
  if (typeof value === 'object') {
    return { type: 'string', value: JSON.stringify(value) };
  }

  // Fallback - convert to string
  return { type: 'string', value: String(value) };
}

/**
 * Normalize expected value for comparison
 * Handles type coercion based on actual value type
 *
 * @param expected - Expected value from rule condition
 * @param actualType - Type of the actual normalized value
 * @returns Normalized expected value
 */
function normalizeExpectedValue(
  expected: string | string[] | boolean | number,
  actualType: NormalizedClaimValue['type']
): NormalizedClaimValue {
  // If expected is already an array, normalize it
  if (Array.isArray(expected)) {
    return { type: 'array', value: expected.map(String) };
  }

  // Match type with actual value type for fair comparison
  switch (actualType) {
    case 'number':
      if (typeof expected === 'number') {
        return { type: 'number', value: expected };
      }
      if (typeof expected === 'string') {
        const parsed = parseFloat(expected);
        if (!isNaN(parsed)) {
          return { type: 'number', value: parsed };
        }
      }
      return { type: 'string', value: String(expected) };

    case 'boolean':
      if (typeof expected === 'boolean') {
        return { type: 'boolean', value: expected };
      }
      if (expected === 'true') {
        return { type: 'boolean', value: true };
      }
      if (expected === 'false') {
        return { type: 'boolean', value: false };
      }
      return { type: 'string', value: String(expected) };

    case 'array':
      // When actual is array and expected is single value,
      // normalize expected to string for 'contains' comparison
      return { type: 'string', value: String(expected) };

    default:
      return { type: 'string', value: String(expected) };
  }
}

// =============================================================================
// Comparison
// =============================================================================

/**
 * Compare normalized values using specified operator
 *
 * @param actual - Normalized actual value
 * @param operator - Comparison operator
 * @param expected - Expected value from rule condition
 * @returns True if comparison matches
 */
export function compareNormalized(
  actual: NormalizedClaimValue,
  operator: ConditionOperator,
  expected: string | string[] | boolean | number
): boolean {
  // Handle exists/not_exists first - they don't need expected value
  if (operator === 'exists') {
    return actual.type !== 'null';
  }
  if (operator === 'not_exists') {
    return actual.type === 'null';
  }

  // If actual is null, most comparisons fail
  if (actual.type === 'null') {
    // Only not_equals returns true for null
    return operator === 'ne';
  }

  // Normalize expected value for comparison
  const normalizedExpected = normalizeExpectedValue(expected, actual.type);

  switch (operator) {
    case 'eq':
      return compareEquality(actual, normalizedExpected);

    case 'ne':
      return !compareEquality(actual, normalizedExpected);

    case 'contains':
      return compareContains(actual, expected);

    case 'in':
      return compareIn(actual, expected);

    case 'not_in':
      return !compareIn(actual, expected);

    case 'regex':
      return compareRegex(actual, expected);

    default:
      return false;
  }
}

/**
 * Compare equality between two normalized values
 */
function compareEquality(a: NormalizedClaimValue, b: NormalizedClaimValue): boolean {
  if (a.type !== b.type) {
    // Type mismatch - try string comparison
    return getStringValue(a) === getStringValue(b);
  }

  switch (a.type) {
    case 'null':
      return b.type === 'null';
    case 'string':
      return a.value === (b as { type: 'string'; value: string }).value;
    case 'number':
      return a.value === (b as { type: 'number'; value: number }).value;
    case 'boolean':
      return a.value === (b as { type: 'boolean'; value: boolean }).value;
    case 'array':
      const bArray = (b as { type: 'array'; value: string[] }).value;
      if (a.value.length !== bArray.length) return false;
      return a.value.every((v, i) => v === bArray[i]);
    default:
      return false;
  }
}

/**
 * Check if array contains value, or if string contains substring
 */
function compareContains(actual: NormalizedClaimValue, expected: unknown): boolean {
  const expectedStr = String(expected);

  if (actual.type === 'array') {
    // Array contains check
    return actual.value.some((v) => v === expectedStr);
  }

  if (actual.type === 'string') {
    // Substring contains check
    return actual.value.includes(expectedStr);
  }

  return false;
}

/**
 * Check if actual value is in expected array
 */
function compareIn(actual: NormalizedClaimValue, expected: unknown): boolean {
  if (!Array.isArray(expected)) {
    return false;
  }

  const actualStr = getStringValue(actual);
  return expected.map(String).includes(actualStr);
}

// =============================================================================
// ReDoS Protection Constants
// =============================================================================

/**
 * Maximum allowed regex pattern length to prevent ReDoS attacks
 */
const MAX_REGEX_PATTERN_LENGTH = 256;

/**
 * Maximum allowed input string length for regex matching
 */
const MAX_REGEX_INPUT_LENGTH = 1000;

/**
 * Dangerous regex patterns that can cause catastrophic backtracking
 * These patterns contain nested quantifiers which can lead to exponential time complexity
 */
const DANGEROUS_REGEX_PATTERNS = [
  /\([^)]*[+*][^)]*\)[+*]/, // Nested quantifiers like (a+)+ or (a*)*
  /\([^)]*[+*][^)]*\)\{/, // Nested quantifiers with {n,m}
  /\[[^\]]*\][+*][+*]/, // Character class with repeated quantifiers like [a-z]++
  /\.\*.*\.\*/, // Multiple greedy wildcards like .*foo.*bar.*
  /\.\+.*\.\+/, // Multiple greedy plus like .+foo.+bar.+
];

/**
 * Validate regex pattern for safety
 *
 * @param pattern - Regex pattern to validate
 * @returns Object with isValid and optional error message
 */
function validateRegexPattern(pattern: string): { isValid: boolean; error?: string } {
  // Check pattern length
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return {
      isValid: false,
      error: `Regex pattern exceeds maximum length of ${MAX_REGEX_PATTERN_LENGTH} characters`,
    };
  }

  // Check for dangerous patterns
  for (const dangerous of DANGEROUS_REGEX_PATTERNS) {
    if (dangerous.test(pattern)) {
      return {
        isValid: false,
        error: 'Regex pattern contains potentially dangerous nested quantifiers',
      };
    }
  }

  return { isValid: true };
}

/**
 * Match actual string value against regex pattern
 *
 * Security measures:
 * 1. Pattern length limit (256 chars) to prevent complex patterns
 * 2. Input length limit (1000 chars) to prevent long string attacks
 * 3. Dangerous pattern detection (nested quantifiers)
 * 4. Try-catch for invalid regex syntax
 *
 * @param actual - Normalized actual value
 * @param expected - Regex pattern string
 * @returns True if pattern matches, false otherwise (including for security violations)
 */
function compareRegex(actual: NormalizedClaimValue, expected: unknown): boolean {
  const actualStr = getStringValue(actual);
  if (typeof expected !== 'string') {
    return false;
  }

  // Validate pattern for security
  const validation = validateRegexPattern(expected);
  if (!validation.isValid) {
    log.warn('ReDoS Protection - Rejected regex pattern', { error: validation.error });
    return false;
  }

  // Truncate input string if too long (security measure)
  const safeInput =
    actualStr.length > MAX_REGEX_INPUT_LENGTH
      ? actualStr.slice(0, MAX_REGEX_INPUT_LENGTH)
      : actualStr;

  try {
    const regex = new RegExp(expected);
    return regex.test(safeInput);
  } catch {
    // Invalid regex pattern
    return false;
  }
}

/**
 * Get string representation of normalized value
 */
function getStringValue(value: NormalizedClaimValue): string {
  switch (value.type) {
    case 'null':
      return '';
    case 'string':
      return value.value;
    case 'number':
      return String(value.value);
    case 'boolean':
      return String(value.value);
    case 'array':
      return value.value.join(',');
    default:
      return '';
  }
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Extract and normalize claim from IdP claims object
 *
 * @param claims - Raw IdP claims object
 * @param path - Dot-separated path to claim
 * @returns Normalized claim value
 */
export function extractAndNormalizeClaim(
  claims: Record<string, unknown>,
  path: string
): NormalizedClaimValue {
  const rawValue = getNestedValue(claims, path);
  return normalizeClaimValue(rawValue);
}

/**
 * Compare claim value against expected value
 * Convenience function combining extraction and comparison
 *
 * @param claims - Raw IdP claims object
 * @param path - Dot-separated path to claim
 * @param operator - Comparison operator
 * @param expected - Expected value
 * @returns True if comparison matches
 */
export function compareClaimValue(
  claims: Record<string, unknown>,
  path: string,
  operator: ConditionOperator,
  expected: string | string[] | boolean | number
): boolean {
  const normalized = extractAndNormalizeClaim(claims, path);
  return compareNormalized(normalized, operator, expected);
}

/**
 * Check if claim exists (is not null/undefined)
 */
export function claimExists(claims: Record<string, unknown>, path: string): boolean {
  const normalized = extractAndNormalizeClaim(claims, path);
  return normalized.type !== 'null';
}

/**
 * Safely get string array from claim
 * Useful for group memberships
 *
 * @param claims - Raw IdP claims object
 * @param path - Dot-separated path to claim
 * @returns Array of strings (empty if claim doesn't exist or isn't array)
 */
export function getClaimAsStringArray(claims: Record<string, unknown>, path: string): string[] {
  const normalized = extractAndNormalizeClaim(claims, path);

  if (normalized.type === 'array') {
    return normalized.value;
  }

  if (normalized.type === 'string' && normalized.value.length > 0) {
    // Single string value - wrap in array
    return [normalized.value];
  }

  return [];
}
