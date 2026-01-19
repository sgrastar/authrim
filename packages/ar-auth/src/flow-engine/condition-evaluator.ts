/**
 * ConditionEvaluator - Flow Engine 条件評価エンジン
 *
 * FlowCondition と ConditionGroup を再帰的に評価する。
 * Decision/Switch ノードの分岐判定に使用。
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

// セキュリティ制限
const MAX_RECURSION_DEPTH = 10; // 再帰深さ制限
const MAX_REGEX_LENGTH = 100; // 正規表現の最大長
const REGEX_TIMEOUT_MS = 100; // 正規表現実行タイムアウト（実質的な制限）
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype']; // Prototype Pollution対策

/**
 * 条件評価のメインエントリーポイント
 * FlowCondition または ConditionGroup を評価して真偽値を返す
 *
 * @param condition - 評価する条件
 * @param context - ランタイムコンテキスト
 * @param depth - 再帰深さ（内部使用）
 * @returns 評価結果（true: 条件を満たす, false: 条件を満たさない）
 */
export function evaluate(
  condition: FlowCondition | ConditionGroup,
  context: FlowRuntimeContext,
  depth = 0
): boolean {
  // 再帰深さチェック（無限ループ/スタックオーバーフロー対策）
  if (depth > MAX_RECURSION_DEPTH) {
    console.error(`[Security] Maximum condition nesting depth (${MAX_RECURSION_DEPTH}) exceeded`);
    return false;
  }

  // ConditionGroup かどうかを判定
  if ('logic' in condition) {
    return evaluateGroup(condition, context, depth);
  }

  // 単一条件の評価
  return evaluateSingle(condition, context);
}

/**
 * ConditionGroup の評価（AND/OR ロジック）
 *
 * @param group - 条件グループ
 * @param context - ランタイムコンテキスト
 * @param depth - 再帰深さ
 * @returns 評価結果
 */
export function evaluateGroup(
  group: ConditionGroup,
  context: FlowRuntimeContext,
  depth: number
): boolean {
  if (group.conditions.length === 0) {
    // 空の条件グループは true とする
    return true;
  }

  if (group.logic === 'and') {
    // AND: すべての条件が true である必要がある
    return group.conditions.every((cond) => evaluate(cond, context, depth + 1));
  } else {
    // OR: いずれかの条件が true であればよい
    return group.conditions.some((cond) => evaluate(cond, context, depth + 1));
  }
}

/**
 * 単一条件の評価
 *
 * @param condition - 単一条件
 * @param context - ランタイムコンテキスト
 * @returns 評価結果
 */
export function evaluateSingle(
  condition: FlowCondition,
  context: FlowRuntimeContext
): boolean {
  const actualValue = getValueByKey(condition.key, context);
  const { operator, value: expectedValue } = condition;

  switch (operator) {
    case 'equals':
      return actualValue === expectedValue;

    case 'notEquals':
      return actualValue !== expectedValue;

    case 'contains':
      if (typeof actualValue === 'string' && typeof expectedValue === 'string') {
        return actualValue.includes(expectedValue);
      }
      if (Array.isArray(actualValue)) {
        return actualValue.includes(expectedValue);
      }
      return false;

    case 'notContains':
      if (typeof actualValue === 'string' && typeof expectedValue === 'string') {
        return !actualValue.includes(expectedValue);
      }
      if (Array.isArray(actualValue)) {
        return !actualValue.includes(expectedValue);
      }
      return true;

    case 'startsWith':
      if (typeof actualValue === 'string' && typeof expectedValue === 'string') {
        return actualValue.startsWith(expectedValue);
      }
      return false;

    case 'endsWith':
      if (typeof actualValue === 'string' && typeof expectedValue === 'string') {
        return actualValue.endsWith(expectedValue);
      }
      return false;

    case 'greaterThan':
      if (typeof actualValue === 'number' && typeof expectedValue === 'number') {
        return actualValue > expectedValue;
      }
      return false;

    case 'lessThan':
      if (typeof actualValue === 'number' && typeof expectedValue === 'number') {
        return actualValue < expectedValue;
      }
      return false;

    case 'greaterOrEqual':
      if (typeof actualValue === 'number' && typeof expectedValue === 'number') {
        return actualValue >= expectedValue;
      }
      return false;

    case 'lessOrEqual':
      if (typeof actualValue === 'number' && typeof expectedValue === 'number') {
        return actualValue <= expectedValue;
      }
      return false;

    case 'in':
      if (Array.isArray(expectedValue)) {
        return expectedValue.includes(actualValue);
      }
      return false;

    case 'notIn':
      if (Array.isArray(expectedValue)) {
        return !expectedValue.includes(actualValue);
      }
      return true;

    case 'exists':
      return actualValue !== null && actualValue !== undefined;

    case 'notExists':
      return actualValue === null || actualValue === undefined;

    case 'matches':
      if (typeof actualValue === 'string' && typeof expectedValue === 'string') {
        try {
          // ReDoS（正規表現DoS攻撃）対策

          // 1. 正規表現の長さ制限
          if (expectedValue.length > MAX_REGEX_LENGTH) {
            console.warn(`[Security] Regex pattern too long (${expectedValue.length} > ${MAX_REGEX_LENGTH}), rejecting`);
            return false;
          }

          // 2. 危険なパターンの検出（ネストされた量指定子）
          // 例: (a+)+, (a*)+, (a{1,10})+
          if (/(\*|\+|\{[0-9,]+\}){2,}/.test(expectedValue)) {
            console.warn('[Security] Potentially dangerous regex pattern detected (nested quantifiers)');
            return false;
          }

          // 3. バックトラッキングを引き起こす可能性のあるパターン
          // 例: (.*)*
          if (/\(\.\*[\*\+]\)/.test(expectedValue)) {
            console.warn('[Security] Dangerous regex pattern detected (catastrophic backtracking risk)');
            return false;
          }

          // 4. 正規表現のコンパイルと実行
          const startTime = Date.now();
          const regex = new RegExp(expectedValue);
          const result = regex.test(actualValue);
          const elapsed = Date.now() - startTime;

          // 5. 実行時間の監視（パフォーマンス問題の検出）
          if (elapsed > REGEX_TIMEOUT_MS) {
            console.warn(`[Security] Slow regex execution detected: ${elapsed}ms (pattern: ${expectedValue.substring(0, 50)}...)`);
          }

          return result;
        } catch (error) {
          // 不正な正規表現の場合は false
          // セキュリティ対策（High 9）: error オブジェクトをそのまま出力せず、メッセージのみ
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
      // 未知のオペレーターは false を返す
      const _exhaustiveCheck: never = operator;
      console.warn(`Unknown operator: ${_exhaustiveCheck}`);
      return false;
    }
  }
}

/**
 * ドット記法でネストされたオブジェクトから値を取得
 *
 * Prototype Pollution 対策:
 * - __proto__, constructor, prototype などの危険なキーを拒否
 * - hasOwnProperty でプロトタイプチェーンを遡らない
 *
 * @param key - 条件キー（例: "user.email", "request.country"）
 * @param context - ランタイムコンテキスト
 * @returns 取得した値（存在しない場合は undefined）
 *
 * @example
 * getValueByKey('user.email', { user: { email: 'test@example.com' } })
 * // => 'test@example.com'
 *
 * getValueByKey('user.customAttributes.role', { user: { customAttributes: { role: 'admin' } } })
 * // => 'admin'
 */
export function getValueByKey(
  key: ConditionKey | string,
  context: FlowRuntimeContext
): unknown {
  const parts = key.split('.');

  // Prototype Pollution 対策: 危険なキーのチェック
  for (const part of parts) {
    if (DANGEROUS_KEYS.includes(part)) {
      console.error(`[Security] Dangerous key detected in condition: "${part}" (full key: "${key}")`);
      return undefined;
    }
  }

  // contextから値を辿る
  let current: unknown = context;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current !== 'object') {
      return undefined;
    }

    // hasOwnProperty を使用してプロトタイプチェーンを遡らない
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * ConditionEvaluator ユーティリティ関数群のエクスポート
 */
export const ConditionEvaluator = {
  evaluate,
  evaluateGroup,
  evaluateSingle,
  getValueByKey,
};
