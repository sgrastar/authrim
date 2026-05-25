/**
 * ConditionEvaluator - Flow Engine condition evaluation engine
 *
 * Recursively evaluate FlowCondition and ConditionGroup..
 * Used for Decision/Switch node branch decisions..
 *
 * @see types.ts - FlowCondition, ConditionGroup, FlowRuntimeContext
 */

import type {
  FlowCondition,
  ConditionGroup,
  FlowRuntimeContext,
  ConditionKey,
  ConditionOperator,
} from './types.js';

// Security limits
const MAX_RECURSION_DEPTH = 10; // Recursion depth limit
const MAX_REGEX_LENGTH = 100; // Maximum regular expression length
const REGEX_TIMEOUT_MS = 100; // Regular expression execution timeout (effective limit)
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype']; // Prototype pollution mitigation
const MAX_STRING_LENGTH = 10000; // Maximum string operation length (DoS mitigation)
const MAX_ARRAY_LENGTH = 1000; // Maximum array operation length (DoS mitigation)

/**
 * Main entry point for condition evaluation
 * Evaluate FlowCondition or ConditionGroup and return a boolean
 *
 * @param condition - condition to evaluate
 * @param context - runtime context
 * @param depth - recursion depth (internal use)
 * @returns evaluation result (true: condition satisfied, false: condition not satisfied)
 */
export function evaluate(
  condition: FlowCondition | ConditionGroup,
  context: FlowRuntimeContext,
  depth = 0
): boolean {
  // Recursion depth check (infinite loop / stack overflow mitigation)
  if (depth > MAX_RECURSION_DEPTH) {
    console.error(`[Security] Maximum condition nesting depth (${MAX_RECURSION_DEPTH}) exceeded`);
    return false;
  }

  // Determine whether it is a ConditionGroup
  if ('logic' in condition) {
    return evaluateGroup(condition, context, depth);
  }

  // Evaluate a single condition
  return evaluateSingle(condition, context);
}

/**
 * Evaluate ConditionGroup (AND/OR logic)
 *
 * @param group - Condition group
 * @param context - runtime context
 * @param depth - recursion depth
 * @returns evaluation result
 */
export function evaluateGroup(
  group: ConditionGroup,
  context: FlowRuntimeContext,
  depth: number
): boolean {
  if (group.conditions.length === 0) {
    // Security mitigation (High 7): Empty condition groups return false  (fail-safe)
    // Return false because treating empty conditions as "all satisfied" is dangerous
    console.warn('[Security] Empty condition group evaluated to false (fail-safe)');
    return false;
  }

  if (group.logic === 'and') {
    // AND: All conditions must be true
    return group.conditions.every((cond) => evaluate(cond, context, depth + 1));
  } else {
    // OR: Any condition may be true
    return group.conditions.some((cond) => evaluate(cond, context, depth + 1));
  }
}

/**
 * Evaluate a single condition
 *
 * @param condition - Single condition
 * @param context - runtime context
 * @returns evaluation result
 */
export function evaluateSingle(condition: FlowCondition, context: FlowRuntimeContext): boolean {
  const actualValue = getValueByKey(condition.key, context);
  const { operator, value: expectedValue } = condition;

  switch (operator) {
    case 'equals':
      return actualValue === expectedValue;

    case 'notEquals':
      return actualValue !== expectedValue;

    case 'contains':
      if (typeof actualValue === 'string' && typeof expectedValue === 'string') {
        // DoS mitigation: string size limit
        if (actualValue.length > MAX_STRING_LENGTH) {
          console.warn(
            `[Security] String too long for contains operation: ${actualValue.length} > ${MAX_STRING_LENGTH}`
          );
          return false;
        }
        return actualValue.includes(expectedValue);
      }
      if (Array.isArray(actualValue)) {
        // DoS mitigation: array size limit
        if (actualValue.length > MAX_ARRAY_LENGTH) {
          console.warn(
            `[Security] Array too long for contains operation: ${actualValue.length} > ${MAX_ARRAY_LENGTH}`
          );
          return false;
        }
        return actualValue.includes(expectedValue);
      }
      return false;

    case 'notContains':
      if (typeof actualValue === 'string' && typeof expectedValue === 'string') {
        // DoS mitigation: string size limit
        if (actualValue.length > MAX_STRING_LENGTH) {
          console.warn(
            `[Security] String too long for notContains operation: ${actualValue.length} > ${MAX_STRING_LENGTH}`
          );
          return false;
        }
        return !actualValue.includes(expectedValue);
      }
      if (Array.isArray(actualValue)) {
        // DoS mitigation: array size limit
        if (actualValue.length > MAX_ARRAY_LENGTH) {
          console.warn(
            `[Security] Array too long for notContains operation: ${actualValue.length} > ${MAX_ARRAY_LENGTH}`
          );
          return false;
        }
        return !actualValue.includes(expectedValue);
      }
      return false;

    case 'startsWith':
      if (typeof actualValue === 'string' && typeof expectedValue === 'string') {
        // DoS mitigation: string size limit
        if (actualValue.length > MAX_STRING_LENGTH) {
          console.warn(
            `[Security] String too long for startsWith operation: ${actualValue.length} > ${MAX_STRING_LENGTH}`
          );
          return false;
        }
        return actualValue.startsWith(expectedValue);
      }
      return false;

    case 'endsWith':
      if (typeof actualValue === 'string' && typeof expectedValue === 'string') {
        // DoS mitigation: string size limit
        if (actualValue.length > MAX_STRING_LENGTH) {
          console.warn(
            `[Security] String too long for endsWith operation: ${actualValue.length} > ${MAX_STRING_LENGTH}`
          );
          return false;
        }
        return actualValue.endsWith(expectedValue);
      }
      return false;

    case 'greaterThan':
      if (typeof actualValue === 'number' && typeof expectedValue === 'number') {
        // NaN/Infinity mitigation
        if (!Number.isFinite(actualValue) || !Number.isFinite(expectedValue)) {
          console.warn(
            `[Security] Non-finite number in greaterThan: actual=${actualValue}, expected=${expectedValue}`
          );
          return false;
        }
        return actualValue > expectedValue;
      }
      return false;

    case 'lessThan':
      if (typeof actualValue === 'number' && typeof expectedValue === 'number') {
        // NaN/Infinity mitigation
        if (!Number.isFinite(actualValue) || !Number.isFinite(expectedValue)) {
          console.warn(
            `[Security] Non-finite number in lessThan: actual=${actualValue}, expected=${expectedValue}`
          );
          return false;
        }
        return actualValue < expectedValue;
      }
      return false;

    case 'greaterOrEqual':
      if (typeof actualValue === 'number' && typeof expectedValue === 'number') {
        // NaN/Infinity mitigation
        if (!Number.isFinite(actualValue) || !Number.isFinite(expectedValue)) {
          console.warn(
            `[Security] Non-finite number in greaterOrEqual: actual=${actualValue}, expected=${expectedValue}`
          );
          return false;
        }
        return actualValue >= expectedValue;
      }
      return false;

    case 'lessOrEqual':
      if (typeof actualValue === 'number' && typeof expectedValue === 'number') {
        // NaN/Infinity mitigation
        if (!Number.isFinite(actualValue) || !Number.isFinite(expectedValue)) {
          console.warn(
            `[Security] Non-finite number in lessOrEqual: actual=${actualValue}, expected=${expectedValue}`
          );
          return false;
        }
        return actualValue <= expectedValue;
      }
      return false;

    case 'in':
      if (Array.isArray(expectedValue)) {
        // DoS mitigation: array size limit
        if (expectedValue.length > MAX_ARRAY_LENGTH) {
          console.warn(
            `[Security] Array too long for 'in' operation: ${expectedValue.length} > ${MAX_ARRAY_LENGTH}`
          );
          return false;
        }
        return expectedValue.includes(actualValue);
      }
      // Security mitigation (Medium 11): Array type-safety check
      console.warn(`[Security] 'in' operator expects array, got ${typeof expectedValue}`);
      return false;

    case 'notIn':
      if (Array.isArray(expectedValue)) {
        // DoS mitigation: array size limit
        if (expectedValue.length > MAX_ARRAY_LENGTH) {
          console.warn(
            `[Security] Array too long for 'notIn' operation: ${expectedValue.length} > ${MAX_ARRAY_LENGTH}`
          );
          return false;
        }
        return !expectedValue.includes(actualValue);
      }
      // Security mitigation (Medium 11): Array type-safety check
      console.warn(`[Security] 'notIn' operator expects array, got ${typeof expectedValue}`);
      return false;

    case 'exists':
      return actualValue !== null && actualValue !== undefined;

    case 'notExists':
      return actualValue === null || actualValue === undefined;

    case 'matches':
      if (typeof actualValue === 'string' && typeof expectedValue === 'string') {
        try {
          // ReDoS (regular expression DoS attack) mitigation

          // 1. Regular expression length limit
          if (expectedValue.length > MAX_REGEX_LENGTH) {
            console.warn(
              `[Security] Regex pattern too long (${expectedValue.length} > ${MAX_REGEX_LENGTH}), rejecting`
            );
            return false;
          }

          // 2. Comprehensive dangerous pattern detection
          const REDOS_PATTERNS = [
            // Nested quantifiers: (a+)+, (a*)+, (.{1,10})+
            // Pattern with a quantifier inside a group followed by another quantifier
            /\([^)]*[\*\+\{][^)]*\)[\*\+\{]/,
            // Backtracking: (.*)*, (.+)+
            /\(\.\*[\*\+]\)/,
            /\(\.\+[\*\+]\)/,
            // Quantifier with alternatives: (a|a)*, (a|ab)*
            /\([^)]*\|[^)]*\)[\*\+]/,
            // Overlapping alternatives: (x+x+)+
            /\([^)]*\+[^)]*\+[^)]*\)\+/,
            // Quantifier with backreference: (a+)\1+
            /\([^)]+\)\\[0-9][\*\+]/,
            // Lookahead/lookbehind abuse: (?=...)*, (?<=...)+
            /\(\?[=!<].*?\)[\*\+]/,
            // Possessive quantifiers (supported by some JS engines): .++, .*+
            /\.\*\+|\.\+\+/,
            // Excessive character class repetition: [a-z]{100,1000}
            /\[[^\]]+\]\{[0-9]{3,}(,[0-9]*)?\}/,
            // Long chain of alternatives: (aa|aaa|aaaa|...)*
            /\([^)]{20,}\|[^)]{20,}\)[\*\+]/,
          ];

          for (const pattern of REDOS_PATTERNS) {
            if (pattern.test(expectedValue)) {
              console.warn(
                '[Security] Dangerous regex pattern detected - potential ReDoS vulnerability'
              );
              return false;
            }
          }

          // 4. Compile and execute the regular expression
          const startTime = Date.now();
          const regex = new RegExp(expectedValue);
          const result = regex.test(actualValue);
          const elapsed = Date.now() - startTime;

          // 5. Monitor execution time (detect performance issues)
          if (elapsed > REGEX_TIMEOUT_MS) {
            console.warn(
              `[Security] Slow regex execution detected: ${elapsed}ms (pattern: ${expectedValue.substring(0, 50)}...)`
            );
          }

          return result;
        } catch (error) {
          // Return false for invalid regular expressions
          // Security mitigation (High 9): Log only the message instead of the raw error object
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          console.error(`[Security] Invalid regex pattern: ${errorMsg}`);
          return false;
        }
      }
      return false;

    case 'isTrue':
      return actualValue === true;

    case 'isFalse':
      return actualValue === false;

    default: {
      // Unknown operators return false
      const _exhaustiveCheck: never = operator;
      console.warn(`Unknown operator: ${_exhaustiveCheck}`);
      return false;
    }
  }
}

/**
 * Get a value from a nested object using dot notation
 *
 * Prototype Pollution mitigation:
 * - __proto__, constructor, prototype and other dangerous keys
 * - Use hasOwnProperty to avoid walking the prototype chain
 *
 * @param key - Condition key (example: "user.email", "request.country")
 * @param context - runtime context
 * @returns Retrieved value, or undefined when it does not exist
 *
 * @example
 * getValueByKey('user.email', { user: { email: 'test@example.com' } })
 * // => 'test@example.com'
 *
 * getValueByKey('user.customAttributes.role', { user: { customAttributes: { role: 'admin' } } })
 * // => 'admin'
 */
export function getValueByKey(key: ConditionKey | string, context: FlowRuntimeContext): unknown {
  const parts = key.split('.');

  // Prototype Pollution mitigation: Check dangerous keys
  for (const part of parts) {
    if (DANGEROUS_KEYS.includes(part)) {
      console.error(
        `[Security] Dangerous key detected in condition: "${part}" (full key: "${key}")`
      );
      return undefined;
    }
  }

  // Traverse values from context
  let current: unknown = context;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current !== 'object') {
      return undefined;
    }

    // Use hasOwnProperty to avoid walking the prototype chain
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * ConditionEvaluator utility function exports
 */
export const ConditionEvaluator = {
  evaluate,
  evaluateGroup,
  evaluateSingle,
  getValueByKey,
};
