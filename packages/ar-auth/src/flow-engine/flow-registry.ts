/**
 * FlowRegistry - Flow定義の取得・管理
 *
 * 責務:
 * - D1からのカスタムFlow取得（Admin UI経由）
 * - ビルトインFlowの取得
 * - KVからのカスタムFlow取得（レガシー）
 *
 * 優先順位:
 * 1. D1: client-specific flow (tenant_id + client_id + profile_id)
 * 2. D1: tenant default flow (tenant_id + profile_id, client_id = NULL)
 * 3. ビルトインFlow
 * 4. KV: カスタムFlow（レガシー）
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

import type { GraphDefinition } from './types';
import { BUILTIN_FLOWS, getBuiltinFlow } from './flows/login-flow';

// =============================================================================
// Types
// =============================================================================

/**
 * FlowType - サポートするフロータイプ
 */
export type FlowType = 'login' | 'authorization' | 'consent' | 'logout';

/**
 * FlowRegistryOptions
 */
export interface FlowRegistryOptions {
  /** KVNamespace（カスタムFlow用、レガシー） */
  kv?: KVNamespace;
  /** D1Database（推奨: Admin UIからのカスタムFlow） */
  db?: D1Database;
}

// =============================================================================
// FlowRegistry
// =============================================================================

/**
 * FlowRegistry - Flow定義の取得・管理
 *
 * ヘッドレス運用対応:
 * - ビルトインFlowのみでも動作
 * - D1が設定されていればAdmin UIからのカスタムFlowを取得
 * - KVが設定されていればレガシーカスタムFlowも取得可能
 */
export class FlowRegistry {
  private kv?: KVNamespace;
  private db?: D1Database;

  constructor(options: FlowRegistryOptions = {}) {
    this.kv = options.kv;
    this.db = options.db;
  }

  /**
   * FlowTypeからGraphDefinitionを取得
   *
   * 優先順位:
   * 1. D1: client-specific flow (tenant_id + client_id + profile_id)
   * 2. D1: tenant default flow (tenant_id + profile_id, client_id = NULL)
   * 3. ビルトインFlow
   * 4. KV: カスタムFlow（レガシー）
   *
   * @param flowType - フロータイプ
   * @param tenantId - テナントID
   * @param clientId - クライアントID（オプション、client-specific flow用）
   * @returns GraphDefinition または null
   */
  async getFlow(
    flowType: FlowType,
    tenantId?: string,
    clientId?: string
  ): Promise<GraphDefinition | null> {
    // profileIdを解決（flowType → profileId）
    const profileId = this.flowTypeToProfileId(flowType);

    // 1. D1: client-specific flow
    if (this.db && tenantId && clientId) {
      const clientFlow = await this.getFlowFromD1(tenantId, profileId, clientId);
      if (clientFlow) {
        return clientFlow;
      }
    }

    // 2. D1: tenant default flow
    if (this.db && tenantId) {
      const tenantFlow = await this.getFlowFromD1(tenantId, profileId, null);
      if (tenantFlow) {
        return tenantFlow;
      }
    }

    // 3. ビルトインFlowを検索
    const builtinFlowId = this.getBuiltinFlowId(flowType);
    const builtinFlow = getBuiltinFlow(builtinFlowId);

    if (builtinFlow) {
      return builtinFlow;
    }

    // 4. カスタムFlow（KV）を検索（レガシー）
    if (this.kv && tenantId) {
      const customFlow = await this.getCustomFlowFromKV(tenantId, flowType);
      if (customFlow) {
        return customFlow;
      }
    }

    // 5. 見つからない場合はnull
    return null;
  }

  /**
   * すべてのビルトインFlowIDを取得
   */
  getBuiltinFlowIds(): string[] {
    return Object.keys(BUILTIN_FLOWS);
  }

  /**
   * FlowTypeからビルトインFlowIDを解決
   */
  private getBuiltinFlowId(flowType: FlowType): string {
    // FlowType → ビルトインFlowIDのマッピング
    const flowTypeToId: Record<FlowType, string> = {
      login: 'human-basic-login',
      authorization: 'human-basic-authorization', // 将来追加
      consent: 'human-basic-consent', // 将来追加
      logout: 'human-basic-logout', // 将来追加
    };

    return flowTypeToId[flowType];
  }

  /**
   * FlowTypeからProfileIdを解決
   */
  private flowTypeToProfileId(flowType: FlowType): string {
    // FlowType → ProfileIDのマッピング
    // 現在はすべて 'human-basic' を使用
    const flowTypeToProfile: Record<FlowType, string> = {
      login: 'human-basic',
      authorization: 'human-basic',
      consent: 'human-basic',
      logout: 'human-basic',
    };

    return flowTypeToProfile[flowType];
  }

  /**
   * D1からFlow定義を取得
   *
   * @param tenantId - テナントID
   * @param profileId - プロファイルID
   * @param clientId - クライアントID（NULLの場合はテナントデフォルト）
   */
  private async getFlowFromD1(
    tenantId: string,
    profileId: string,
    clientId: string | null
  ): Promise<GraphDefinition | null> {
    if (!this.db) {
      return null;
    }

    try {
      let result: D1Result<{ graph_definition: string }>;

      if (clientId) {
        // client-specific flow
        result = await this.db
          .prepare(
            `SELECT graph_definition FROM flows
             WHERE tenant_id = ? AND profile_id = ? AND client_id = ?
             AND is_active = 1`
          )
          .bind(tenantId, profileId, clientId)
          .all();
      } else {
        // tenant default flow (client_id IS NULL)
        result = await this.db
          .prepare(
            `SELECT graph_definition FROM flows
             WHERE tenant_id = ? AND profile_id = ? AND client_id IS NULL
             AND is_active = 1`
          )
          .bind(tenantId, profileId)
          .all();
      }

      if (result.results.length > 0) {
        const row = result.results[0];
        const graphDef = JSON.parse(row.graph_definition);

        if (this.isValidGraphDefinition(graphDef)) {
          return graphDef;
        }
      }

      return null;
    } catch (error) {
      console.error('Failed to get flow from D1:', error);
      return null;
    }
  }

  /**
   * KVからカスタムFlow定義を取得（レガシー）
   *
   * キー形式: flow:{tenantId}:{flowType}
   */
  private async getCustomFlowFromKV(
    tenantId: string,
    flowType: string
  ): Promise<GraphDefinition | null> {
    if (!this.kv) {
      return null;
    }

    const key = `flow:${tenantId}:${flowType}`;
    const stored = await this.kv.get(key, 'json');

    if (stored && this.isValidGraphDefinition(stored)) {
      return stored as GraphDefinition;
    }

    return null;
  }

  /**
   * GraphDefinitionの簡易バリデーション
   */
  private isValidGraphDefinition(obj: unknown): obj is GraphDefinition {
    if (!obj || typeof obj !== 'object') {
      return false;
    }

    const graph = obj as Partial<GraphDefinition>;

    return (
      typeof graph.id === 'string' &&
      typeof graph.flowVersion === 'string' &&
      typeof graph.name === 'string' &&
      Array.isArray(graph.nodes) &&
      Array.isArray(graph.edges)
    );
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * FlowRegistryを作成
 *
 * @param options - オプション
 * @returns FlowRegistry インスタンス
 *
 * @example
 * // ビルトインFlowのみ
 * const registry = createFlowRegistry();
 *
 * // D1対応（推奨: Admin UIからのカスタムFlow）
 * const registry = createFlowRegistry({ db: env.DB });
 *
 * // D1 + KV対応（フルオプション）
 * const registry = createFlowRegistry({ db: env.DB, kv: env.AUTHRIM_CONFIG });
 */
export function createFlowRegistry(options: FlowRegistryOptions = {}): FlowRegistry {
  return new FlowRegistry(options);
}

// =============================================================================
// Export
// =============================================================================

export default FlowRegistry;
