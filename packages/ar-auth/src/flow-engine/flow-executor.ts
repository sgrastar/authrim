/**
 * FlowExecutor - Flow Engineの中核
 *
 * 責務:
 * - Flow初期化（/init）
 * - Capability応答処理（/submit）
 * - 状態取得（/state）
 * - Flowキャンセル（/cancel）
 * - FlowStateStore DO連携
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

import { type Env, getFlowStateStoreStub } from '@authrim/ar-lib-core';
import type {
  FlowInitRequest,
  FlowInitResponse,
  FlowSubmitRequest,
  FlowSubmitResponse,
  FlowStateResponse,
  CompiledPlan,
  CompiledNode,
  OAuthFlowParams,
  DecisionNodeConfig,
  SwitchNodeConfig,
  FlowRuntimeContext,
} from './types';
import { DEFAULT_FLOW_TTL_MS } from './types';
import { FlowRegistry, createFlowRegistry, type FlowType } from './flow-registry';
import { createFlowCompiler, type FlowCompilerService } from './flow-compiler';
import { UIContractGenerator, createUIContractGenerator } from './ui-contract-generator';
import { evaluate } from './condition-evaluator';

// =============================================================================
// Types
// =============================================================================

/**
 * FlowExecutorオプション
 */
export interface FlowExecutorOptions {
  /** セッションTTL（ミリ秒） */
  ttlMs?: number;
}

/**
 * DO初期化レスポンス
 */
interface DOInitResponse {
  success: boolean;
  state?: {
    sessionId: string;
    flowId: string;
    currentNodeId: string;
    visitedNodeIds: string[];
    completedCapabilities: string[];
    expiresAt: number;
  };
  error?: string;
  code?: string;
}

/**
 * DOが返すOAuthパラメータ（snake_caseでOAuth標準に準拠）
 */
interface DOOAuthParams {
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: 'plain' | 'S256';
  redirect_uri?: string;
  scope?: string;
  response_type?: string;
  response_mode?: string;
  acr_values?: string;
  max_age?: number;
  ui_locales?: string;
  prompt?: string;
  login_hint?: string;
  claims?: string;
}

/**
 * DO状態レスポンス
 */
interface DOStateResponse {
  state?: {
    sessionId: string;
    flowId: string;
    flowType: string;
    tenantId: string;
    clientId: string;
    currentNodeId: string;
    visitedNodeIds: string[];
    completedCapabilities: string[];
    startedAt: number;
    expiresAt: number;
    requestTimestamps?: number[];
    collectedData?: Record<string, unknown>;
    oauthParams?: DOOAuthParams;
  };
  error?: string;
  code?: string;
}

/**
 * DO冪等性チェックレスポンス
 */
interface DOCheckRequestResponse {
  found: boolean;
  result?: FlowSubmitResponse;
  state?: {
    sessionId: string;
    flowId: string;
    flowType: string;
    tenantId: string;
    clientId: string;
    currentNodeId: string;
    visitedNodeIds: string[];
    completedCapabilities: string[];
    startedAt: number;
    expiresAt: number;
    requestTimestamps?: number[];
    collectedData?: Record<string, unknown>;
    oauthParams?: DOOAuthParams;
  };
  error?: string;
  code?: string;
}

// =============================================================================
// FlowExecutor
// =============================================================================

/**
 * FlowExecutor - Flow Engineの中核
 */
export class FlowExecutor {
  private registry: FlowRegistry;
  private compiler: FlowCompilerService;
  private uiGenerator: UIContractGenerator;
  private compiledPlans: Map<string, CompiledPlan> = new Map();
  private ttlMs: number;

  constructor(
    private env: Env,
    options: FlowExecutorOptions = {}
  ) {
    this.registry = createFlowRegistry({ kv: env.AUTHRIM_CONFIG });
    this.compiler = createFlowCompiler() as FlowCompilerService;
    this.uiGenerator = createUIContractGenerator();
    this.ttlMs = options.ttlMs ?? DEFAULT_FLOW_TTL_MS;
  }

  /**
   * Flowを初期化しUIContractを返却
   */
  async initFlow(params: {
    flowType: FlowType;
    clientId: string;
    tenantId: string;
    oauthParams?: OAuthFlowParams;
  }): Promise<FlowInitResponse> {
    const { flowType, clientId, tenantId, oauthParams } = params;

    // セキュリティ対策（Medium 10）: Tenant/Client 基本バリデーション
    this.validateBasicTenantClient(tenantId, clientId);

    // 1. Flow定義を取得
    const graphDef = await this.registry.getFlow(flowType, tenantId);
    if (!graphDef) {
      throw new Error(`Flow not found: ${flowType}`);
    }

    // 2. CompiledPlanを取得またはコンパイル
    const compiledPlan = this.getOrCompilePlan(graphDef, tenantId);

    // 3. セッションIDを生成
    const sessionId = `flow_${crypto.randomUUID()}`;

    // 4. エントリーノードを決定（startノードはスキップ）
    const entryNode = compiledPlan.nodes.get(compiledPlan.entryNodeId);
    if (!entryNode) {
      throw new Error(`Entry node not found: ${compiledPlan.entryNodeId}`);
    }

    // startノードの場合、次のノードを実際のエントリーとして扱う
    let actualEntryNodeId = compiledPlan.entryNodeId;
    let currentNode = entryNode;
    if (entryNode.type === 'start' && entryNode.nextOnSuccess) {
      const nextNode = compiledPlan.nodes.get(entryNode.nextOnSuccess);
      if (nextNode) {
        actualEntryNodeId = entryNode.nextOnSuccess;
        currentNode = nextNode;
      }
    }

    // 5. FlowStateStore DOを呼び出して初期化
    // DOには実際に表示するノードIDを保存（startノードはスキップ済み）
    const doResponse = await this.callDO<DOInitResponse>(tenantId, sessionId, '/init', 'POST', {
      sessionId,
      flowId: graphDef.id,
      flowType, // flowTypeを保存（再コンパイル時に必要）
      tenantId,
      clientId,
      entryNodeId: actualEntryNodeId,
      ttlMs: this.ttlMs,
      oauthParams,
    });

    if (!doResponse.success || !doResponse.state) {
      throw new Error(doResponse.error || 'Failed to initialize flow');
    }

    const uiContract = this.uiGenerator.generate({
      compiledNode: currentNode,
      flowId: graphDef.id,
      profileId: graphDef.profileId,
    });

    return {
      sessionId,
      uiContractVersion: '0.1',
      uiContract,
    };
  }

  /**
   * Capability応答を処理し次のUIContractを返却
   */
  async submitCapability(params: FlowSubmitRequest): Promise<FlowSubmitResponse> {
    const { sessionId, requestId, capabilityId, response, tenantId, clientId } = params;

    if (!tenantId?.trim()) {
      return {
        type: 'error',
        error: {
          code: 'tenant_required',
          message: 'Tenant context is required',
        },
      };
    }

    // 1. 冪等性チェック（/check-request）
    // これにより同一requestIdのリクエストは処理をスキップしてキャッシュ結果を返す
    const checkResponse = await this.callDO<DOCheckRequestResponse>(
      tenantId,
      sessionId,
      '/check-request',
      'POST',
      { requestId }
    );

    // エラーチェック
    if (checkResponse.error) {
      return {
        type: 'error',
        error: {
          code: checkResponse.code || 'check_error',
          message: checkResponse.error,
        },
      };
    }

    // 冪等性ヒット: キャッシュされた結果を返す
    if (checkResponse.found && checkResponse.result) {
      return checkResponse.result;
    }

    // 未処理: check-requestが返した状態を使用
    if (!checkResponse.state) {
      return {
        type: 'error',
        error: {
          code: 'session_not_found',
          message: 'Session not found',
        },
      };
    }

    const {
      flowId,
      flowType,
      currentNodeId,
      collectedData = {},
      oauthParams,
    } = checkResponse.state;

    // セキュリティ対策: セッション検証（Critical 4）
    // リクエストコンテキストのtenantId/clientIdがセッションのものと一致するか検証
    // これによりセッションハイジャック攻撃を防止
    if (checkResponse.state.tenantId !== tenantId) {
      console.error(
        `[Security] Session tenant mismatch: expected=${tenantId}, got=${checkResponse.state.tenantId}`
      );
      return {
        type: 'error',
        error: {
          code: 'invalid_session',
          message: 'Session tenant mismatch',
        },
      };
    }
    if (clientId && checkResponse.state.clientId !== clientId) {
      console.error(
        `[Security] Session client mismatch: expected=${clientId}, got=${checkResponse.state.clientId}`
      );
      return {
        type: 'error',
        error: {
          code: 'invalid_session',
          message: 'Session client mismatch',
        },
      };
    }

    // セキュリティ対策: レート制限（Critical 3）
    // セッション状態からリクエストタイムスタンプを取得（DO側で実装されていない場合は空配列）
    let requestTimestamps =
      checkResponse.state.requestTimestamps || [];
    const now = Date.now();
    const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1分間のウィンドウ
    const MAX_REQUESTS_PER_WINDOW = 30; // 1分間に最大30リクエスト
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // セッション最大30分
    const MAX_TIMESTAMP_HISTORY = 100; // タイムスタンプ履歴の最大サイズ（メモリDoS対策）

    // 配列サイズ制限（メモリ枯渇攻撃対策）
    if (requestTimestamps.length > MAX_TIMESTAMP_HISTORY) {
      requestTimestamps = requestTimestamps.slice(-MAX_TIMESTAMP_HISTORY);
    }

    // 1. 古いタイムスタンプを削除（ウィンドウ外）
    const recentTimestamps = requestTimestamps.filter(
      (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS
    );

    // 2. レート制限チェック
    if (recentTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
      console.error(
        `[Security] Rate limit exceeded: ${recentTimestamps.length} requests in ${RATE_LIMIT_WINDOW_MS}ms (max: ${MAX_REQUESTS_PER_WINDOW})`
      );
      return {
        type: 'error',
        error: {
          code: 'rate_limit_exceeded',
          message: 'Too many requests. Please wait a moment and try again.',
        },
      };
    }

    // 3. セッションタイムアウトチェック
    const sessionStartedAt = checkResponse.state.startedAt;
    if (now - sessionStartedAt > SESSION_TIMEOUT_MS) {
      console.error(
        `[Security] Session timeout: ${Math.floor((now - sessionStartedAt) / 1000 / 60)} minutes elapsed (max: ${SESSION_TIMEOUT_MS / 1000 / 60})`
      );
      return {
        type: 'error',
        error: {
          code: 'session_timeout',
          message: 'Session has expired. Please start over.',
        },
      };
    }

    // セキュリティ対策: 循環参照検出（High 6）
    // セッション状態から訪問履歴を取得（DO側で実装されていない場合は空配列）
    const rawVisitedNodes = checkResponse.state.visitedNodeIds;
    // セキュリティ対策（Medium 8）: 型安全性を保証（配列でない場合は空配列にフォールバック）
    let visitedNodes: string[] = Array.isArray(rawVisitedNodes) ? rawVisitedNodes : [];
    const MAX_VISITS_PER_NODE = 3; // 同じノードへの最大訪問回数
    const MAX_TOTAL_NODES = 50; // フロー全体での最大ノード訪問数（無限ループ対策）
    const MAX_VISITED_HISTORY = 200; // 訪問履歴配列の最大サイズ（メモリDoS対策）

    // 配列サイズの事前チェック（メモリ枯渇攻撃対策）
    if (visitedNodes.length > MAX_VISITED_HISTORY) {
      console.warn(
        `[Security] Visited nodes history too large (${visitedNodes.length}), truncating to last ${MAX_VISITED_HISTORY} entries`
      );
      visitedNodes = visitedNodes.slice(-MAX_VISITED_HISTORY);
    }

    // 1. 同じノードへの過度な訪問をチェック
    const currentNodeVisitCount = visitedNodes.filter((id) => id === currentNodeId).length;
    if (currentNodeVisitCount >= MAX_VISITS_PER_NODE) {
      console.error(
        `[Security] Circular reference detected: Node "${currentNodeId}" visited ${currentNodeVisitCount} times (max: ${MAX_VISITS_PER_NODE})`
      );
      return {
        type: 'error',
        error: {
          code: 'circular_reference',
          message: 'Flow contains a circular reference. Please contact support.',
        },
      };
    }

    // 2. フロー全体のノード訪問数をチェック（無限ループ対策）
    if (visitedNodes.length >= MAX_TOTAL_NODES) {
      console.error(
        `[Security] Maximum flow length exceeded: ${visitedNodes.length} nodes visited (max: ${MAX_TOTAL_NODES})`
      );
      return {
        type: 'error',
        error: {
          code: 'flow_too_long',
          message: 'Flow execution limit exceeded. Please contact support.',
        },
      };
    }

    // 2. CompiledPlanを取得
    const compiledPlan = this.compiledPlans.get(
      this.getCompiledPlanCacheKey(checkResponse.state.tenantId, flowId)
    );
    if (!compiledPlan) {
      // キャッシュにない場合、再コンパイル
      // flowTypeはDOに保存されているため、セッションから取得
      const graphDef = await this.registry.getFlow(
        flowType as FlowType,
        checkResponse.state.tenantId
      );
      if (!graphDef) {
        return {
          type: 'error',
          error: {
            code: 'flow_not_found',
            message: 'Flow definition not found',
          },
        };
      }
      this.getOrCompilePlan(graphDef, checkResponse.state.tenantId);
    }

    const plan = this.compiledPlans.get(
      this.getCompiledPlanCacheKey(checkResponse.state.tenantId, flowId)
    );
    if (!plan) {
      return {
        type: 'error',
        error: {
          code: 'plan_not_found',
          message: 'Compiled plan not found',
        },
      };
    }

    // 3. 現在のノードを取得
    const currentNode = plan.nodes.get(currentNodeId);
    if (!currentNode) {
      return {
        type: 'error',
        error: {
          code: 'node_not_found',
          message: `Node not found: ${currentNodeId}`,
        },
      };
    }

    // 4. 次のノードを決定（Decision/Switch対応）
    // tenantId/clientIdはDOから取得した検証済みの値を使用（セキュリティ強化）
    const runtimeContext = this.buildRuntimeContext(collectedData, {
      tenantId: checkResponse.state.tenantId,
      clientId: checkResponse.state.clientId,
    });
    const nextNodeId = await this.determineNextNode(currentNode, plan, runtimeContext);

    // 完了チェック
    if (!nextNodeId) {
      // フロー完了 → リダイレクト
      // redirect_uri はOAuthパラメータから取得、なければフォールバック
      const redirectUrl = oauthParams?.redirect_uri || '/callback';
      return {
        type: 'redirect',
        redirect: {
          url: redirectUrl,
          method: 'GET',
        },
      };
    }

    const nextNode = plan.nodes.get(nextNodeId);
    if (!nextNode) {
      return {
        type: 'error',
        error: {
          code: 'next_node_not_found',
          message: `Next node not found: ${nextNodeId}`,
        },
      };
    }

    // endノードの場合、リダイレクト
    if (nextNode.type === 'end') {
      // redirect_uri はOAuthパラメータから取得、なければフォールバック
      const redirectUrl = oauthParams?.redirect_uri || '/callback';
      return {
        type: 'redirect',
        redirect: {
          url: redirectUrl,
          method: 'GET',
        },
      };
    }

    // 5. 次のUIContractを生成
    const updatedCollectedData = {
      ...collectedData,
      [capabilityId]: response,
    };

    const uiContract = this.uiGenerator.generate({
      compiledNode: nextNode,
      flowId,
      runtimeState: {
        collectedData: updatedCollectedData,
      },
      profileId: plan.profileId,
    });

    // 6. DOに状態を保存
    const submitResult: FlowSubmitResponse = {
      type: 'continue',
      uiContract,
    };

    // 訪問履歴を更新（現在のノードを追加）
    const updatedVisitedNodes = [...visitedNodes, currentNodeId];

    // リクエストタイムスタンプを更新（現在時刻を追加）
    const updatedRequestTimestamps = [...recentTimestamps, now];

    await this.callDO(tenantId, sessionId, '/submit', 'POST', {
      requestId,
      capabilityId,
      response,
      result: submitResult,
      nextNodeId,
      visitedNodes: updatedVisitedNodes, // 訪問履歴を保存
      requestTimestamps: updatedRequestTimestamps, // リクエストタイムスタンプを保存
    });

    return submitResult;
  }

  /**
   * 現在の状態を取得
   */
  async getFlowState(sessionId: string, tenantId: string): Promise<FlowStateResponse> {
    // 1. DOから状態を取得
    const stateResponse = await this.callDO<DOStateResponse>(tenantId, sessionId, '/state', 'GET');

    if (stateResponse.error || !stateResponse.state) {
      throw new Error(stateResponse.error || 'Session not found');
    }

    const {
      flowId,
      flowType,
      tenantId: stateTenantId,
      currentNodeId,
      visitedNodeIds,
      completedCapabilities,
      collectedData,
    } = stateResponse.state;

    // 2. CompiledPlanを取得
    let plan = this.compiledPlans.get(this.getCompiledPlanCacheKey(stateTenantId, flowId));
    if (!plan) {
      // キャッシュにない場合、再コンパイル
      // flowTypeはDOに保存されているため、セッションから取得
      const graphDef = await this.registry.getFlow(flowType as FlowType, stateTenantId);
      if (graphDef) {
        plan = this.getOrCompilePlan(graphDef, stateTenantId);
      }
    }

    if (!plan) {
      throw new Error('Compiled plan not found');
    }

    // 3. 現在のノードを取得
    const currentNode = plan.nodes.get(currentNodeId);
    if (!currentNode) {
      throw new Error(`Node not found: ${currentNodeId}`);
    }

    // 4. UIContractを生成
    const uiContract = this.uiGenerator.generate({
      compiledNode: currentNode,
      flowId,
      runtimeState: {
        collectedData,
      },
      profileId: plan.profileId,
    });

    return {
      state: {
        currentNodeId,
        visitedNodeIds,
        completedCapabilities,
      },
      uiContract,
    };
  }

  /**
   * Flowをキャンセル
   */
  async cancelFlow(sessionId: string, tenantId: string): Promise<void> {
    await this.callDO(tenantId, sessionId, '/cancel', 'DELETE');
  }

  // =============================================================================
  // Private Methods
  // =============================================================================

  /**
   * CompiledPlanを取得またはコンパイル
   */
  private getOrCompilePlan(
    graphDef: {
      id: string;
      flowVersion: string;
      profileId: string;
      nodes: unknown[];
      edges: unknown[];
      name: string;
      description: string;
      metadata: unknown;
    },
    tenantId: string
  ): CompiledPlan {
    const cacheKey = this.getCompiledPlanCacheKey(tenantId, graphDef.id);

    // キャッシュにあればそれを返す
    const cached = this.compiledPlans.get(cacheKey);
    if (cached && cached.sourceVersion === graphDef.flowVersion) {
      return cached;
    }

    // コンパイル
    const compiled = this.compiler.compile(graphDef as Parameters<typeof this.compiler.compile>[0]);
    this.compiledPlans.set(cacheKey, compiled);

    return compiled;
  }

  private getCompiledPlanCacheKey(tenantId: string, flowId: string): string {
    return `compiled:${tenantId}:${flowId}`;
  }

  /**
   * FlowStateStore DOを呼び出す
   *
   * Routing strategy:
   * - one Durable Object per tenant + flow session
   * - the DO stores exactly one RuntimeState and serializes that session only
   */
  private async callDO<T>(
    tenantId: string,
    sessionId: string,
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown
  ): Promise<T> {
    // シャーディングユーティリティを使用してDO stubを取得
    const { stub } = await getFlowStateStoreStub(this.env, sessionId, tenantId);

    // リクエストを作成
    const requestInit: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': tenantId,
        'X-Flow-Session-Id': sessionId,
      },
    };

    if (body && method !== 'GET') {
      requestInit.body = JSON.stringify(body);
    }

    // DOを呼び出す
    const response = await stub.fetch(new Request(`http://localhost${path}`, requestInit));

    // レスポンスをパース
    return (await response.json()) as T;
  }

  /**
   * 次のノードIDを決定（Decision/Switch対応）
   *
   * @param currentNode - 現在のノード
   * @param plan - コンパイル済みプラン
   * @param context - ランタイムコンテキスト
   * @returns 次のノードID（nullはフロー終了）
   */
  private async determineNextNode(
    currentNode: CompiledNode,
    plan: CompiledPlan,
    context: FlowRuntimeContext
  ): Promise<string | null> {
    // Decision/Switchノードの場合
    if (currentNode.type === 'decision' || currentNode.type === 'switch') {
      return this.evaluateDecisionNode(currentNode, plan, context);
    }

    // 通常のノード: nextOnSuccess を返す
    return currentNode.nextOnSuccess;
  }

  /**
   * Decision/Switchノードの評価
   *
   * @param node - Decision/Switchノード
   * @param plan - コンパイル済みプラン
   * @param context - ランタイムコンテキスト
   * @returns 遷移先ノードID
   */
  private evaluateDecisionNode(
    node: CompiledNode,
    plan: CompiledPlan,
    context: FlowRuntimeContext
  ): string | null {
    if (node.type === 'decision') {
      return this.evaluateDecisionBranches(node, plan, context);
    }

    if (node.type === 'switch') {
      return this.evaluateSwitchCases(node, plan, context);
    }

    return null;
  }

  /**
   * Decisionブランチを評価
   *
   * @param node - Decisionノード
   * @param plan - コンパイル済みプラン
   * @param context - ランタイムコンテキスト
   * @returns 遷移先ノードID
   */
  private evaluateDecisionBranches(
    node: CompiledNode,
    plan: CompiledPlan,
    context: FlowRuntimeContext
  ): string | null {
    const config = node.decisionConfig as DecisionNodeConfig | undefined;
    if (!config) {
      return null;
    }

    // 遷移リストを取得（priority順にソート済み）
    const transitions = plan.transitions.get(node.id) || [];

    // priority順に条件を評価
    for (const branch of config.branches) {
      // 条件評価
      const matches = evaluate(branch.condition, context);

      if (matches) {
        // マッチした分岐の遷移先を返す
        const transition = transitions.find((t) => t.sourceHandle === branch.id);
        if (transition) {
          // セキュリティ対策（Medium 12）: 遷移先ノードの存在確認
          if (!plan.nodes.has(transition.targetNodeId)) {
            console.error(
              `[Security] Invalid transition: target node "${transition.targetNodeId}" does not exist in plan`
            );
            return null;
          }
          return transition.targetNodeId;
        }
      }
    }

    // どの条件にもマッチしない場合、デフォルト分岐
    if (config.defaultBranch) {
      const defaultTransition = transitions.find((t) => t.sourceHandle === config.defaultBranch);
      if (defaultTransition) {
        // セキュリティ対策（Medium 12）: 遷移先ノードの存在確認
        if (!plan.nodes.has(defaultTransition.targetNodeId)) {
          console.error(
            `[Security] Invalid default transition: target node "${defaultTransition.targetNodeId}" does not exist in plan`
          );
          return null;
        }
        return defaultTransition.targetNodeId;
      }
    }

    // デフォルト分岐もない場合はnull（フロー終了）
    return null;
  }

  /**
   * Switchケースを評価
   *
   * @param node - Switchノード
   * @param plan - コンパイル済みプラン
   * @param context - ランタイムコンテキスト
   * @returns 遷移先ノードID
   */
  private evaluateSwitchCases(
    node: CompiledNode,
    plan: CompiledPlan,
    context: FlowRuntimeContext
  ): string | null {
    const config = node.decisionConfig as SwitchNodeConfig | undefined;
    if (!config) {
      return null;
    }

    // Prototype Pollution対策用の危険なキー
    const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

    // switchKeyの値を取得
    const keyParts = config.switchKey.split('.');
    let value: unknown = context;
    for (const part of keyParts) {
      // Prototype Pollution対策: 危険なキーを拒否
      if (DANGEROUS_KEYS.includes(part)) {
        console.error(
          `[Security] Dangerous key detected in switchKey: "${part}" (full key: "${config.switchKey}")`
        );
        value = undefined;
        break;
      }

      if (value === null || value === undefined || typeof value !== 'object') {
        value = undefined;
        break;
      }

      // Prototype Pollution対策: hasOwnPropertyでプロトタイプチェーンを遡らない
      if (!Object.prototype.hasOwnProperty.call(value, part)) {
        value = undefined;
        break;
      }

      value = (value as Record<string, unknown>)[part];
    }

    // 遷移リストを取得
    const transitions = plan.transitions.get(node.id) || [];

    // 各caseと値を比較
    for (const caseItem of config.cases) {
      if (caseItem.values.includes(value as string | number | boolean)) {
        const transition = transitions.find((t) => t.sourceHandle === caseItem.id);
        if (transition) {
          // セキュリティ対策（Medium 12）: 遷移先ノードの存在確認
          if (!plan.nodes.has(transition.targetNodeId)) {
            console.error(
              `[Security] Invalid switch transition: target node "${transition.targetNodeId}" does not exist in plan`
            );
            return null;
          }
          return transition.targetNodeId;
        }
      }
    }

    // どのcaseにもマッチしない場合、デフォルトcase
    if (config.defaultCase) {
      const defaultTransition = transitions.find((t) => t.sourceHandle === config.defaultCase);
      if (defaultTransition) {
        // セキュリティ対策（Medium 12）: 遷移先ノードの存在確認
        if (!plan.nodes.has(defaultTransition.targetNodeId)) {
          console.error(
            `[Security] Invalid switch default transition: target node "${defaultTransition.targetNodeId}" does not exist in plan`
          );
          return null;
        }
        return defaultTransition.targetNodeId;
      }
    }

    // デフォルトcaseもない場合はnull（フロー終了）
    return null;
  }

  /**
   * ログ出力時に機密情報をサニタイズ（Medium 9）
   *
   * セキュリティ対策:
   * - 循環参照検出（無限ループ防止）
   * - 深さ制限（スタックオーバーフロー防止）
   * - 配列/オブジェクトサイズ制限（メモリDoS防止）
   * - 機密キー（password, secret等）のマスキング
   *
   * 使用例（デバッグ時）:
   * ```
   * console.error('[Debug] Context:', this.sanitizeForLogging(context));
   * console.warn('[Debug] State:', this.sanitizeForLogging(collectedData));
   * ```
   *
   * @param obj - ログ出力するオブジェクト
   * @param seen - 循環参照検出用（内部使用）
   * @param depth - 現在の深さ（内部使用）
   * @returns サニタイズされたオブジェクト
   */
  private sanitizeForLogging(obj: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
    const MAX_DEPTH = 10; // 最大深さ
    const MAX_ITEMS = 100; // 配列/オブジェクトの最大アイテム数

    // 深さ制限チェック
    if (depth > MAX_DEPTH) {
      return '[MAX_DEPTH_EXCEEDED]';
    }

    // プリミティブ値はそのまま返す
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    // 循環参照チェック
    if (seen.has(obj)) {
      return '[CIRCULAR_REFERENCE]';
    }
    seen.add(obj);

    // 機密情報のキーパターン
    const SENSITIVE_KEYS = [
      'password',
      'secret',
      'token',
      'access_token',
      'refresh_token',
      'id_token',
      'authorization',
      'api_key',
      'apiKey',
      'sessionId',
      'session_id',
      'credit_card',
      'creditCard',
      'ssn',
      'privateKey',
      'private_key',
    ];

    // 配列の場合
    if (Array.isArray(obj)) {
      // サイズ制限チェック
      if (obj.length > MAX_ITEMS) {
        return `[Array(${obj.length}) - truncated to first ${MAX_ITEMS} items]`;
      }
      return obj.slice(0, MAX_ITEMS).map((item) => this.sanitizeForLogging(item, seen, depth + 1));
    }

    // オブジェクトの場合
    const keys = Object.keys(obj);

    // プロパティ数制限チェック
    if (keys.length > MAX_ITEMS) {
      return `[Object with ${keys.length} properties - truncated]`;
    }

    const sanitized: Record<string, unknown> = {};
    for (const key of keys) {
      const lowerKey = key.toLowerCase();
      const isSensitive = SENSITIVE_KEYS.some((sensitiveKey) =>
        lowerKey.includes(sensitiveKey.toLowerCase())
      );

      if (isSensitive) {
        sanitized[key] = '[REDACTED]';
      } else {
        const value = (obj as Record<string, unknown>)[key];
        if (typeof value === 'object' && value !== null) {
          sanitized[key] = this.sanitizeForLogging(value, seen, depth + 1);
        } else {
          sanitized[key] = value;
        }
      }
    }

    return sanitized;
  }

  /**
   * collectedDataからFlowRuntimeContextを構築
   *
   * セキュリティ対策:
   * - collectedDataは信頼できないデータとして扱う
   * - ホワイトリスト方式で許可されたフィールドのみ抽出
   * - 将来的には、user情報などは認証済みソースから再取得すべき
   *
   * @param collectedData - 収集済みデータ
   * @returns FlowRuntimeContext
   */
  /**
   * 基本的なTenant/Client IDバリデーション（Medium 10）
   *
   * セキュリティ対策:
   * - null/undefined/空文字のチェック
   * - 最小限の型チェック
   *
   * 注意: これは基本的なバリデーションのみです。
   * 実際の運用では、以下の追加検証が必要:
   * - Tenant/Clientの存在確認（DB検索）
   * - Tenant/Clientのアクティブ状態確認
   * - ClientがTenantに属していることの確認
   * - 権限チェック
   *
   * @param tenantId - テナントID
   * @param clientId - クライアントID
   * @throws Error バリデーション失敗時
   */
  private validateBasicTenantClient(tenantId: string, clientId: string): void {
    // 基本的なnull/undefinedチェック
    if (!tenantId || typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new Error('Invalid tenantId');
    }
    if (!clientId || typeof clientId !== 'string' || clientId.trim() === '') {
      throw new Error('Invalid clientId');
    }

    // セキュリティ警告: 実際の権限チェックは未実装
    console.warn(
      `[Security] Basic validation passed for tenantId="${tenantId}", clientId="${clientId}", but full authorization check is not implemented`
    );
  }

  /**
   * 型安全なランタイムコンテキスト構築
   *
   * セキュリティ強化（High 5）:
   * - 危険な`as`型キャストを排除
   * - Type guardによる安全な型チェック
   * - デフォルト値によるフォールバック
   * - tenant/clientはDOから取得した検証済みの値を使用
   *
   * @param collectedData - 収集済みデータ（信頼できないデータとして扱う）
   * @param verifiedContext - DOから取得した検証済みコンテキスト
   */
  private buildRuntimeContext(
    collectedData: Record<string, unknown>,
    verifiedContext?: {
      tenantId?: string;
      clientId?: string;
    }
  ): FlowRuntimeContext {
    // Type guard: objectかどうかチェック
    const isObject = (value: unknown): value is Record<string, unknown> => {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    };

    // Type guard: NodeOutputかどうかチェック
    const isNodeOutput = (value: unknown): value is import('./types.js').NodeOutput => {
      return isObject(value) && typeof value.success === 'boolean';
    };

    // tenant/clientはDOから取得した検証済みの値を優先使用
    // collectedDataからの値は信頼できないため無視
    const tenant = verifiedContext?.tenantId ? { id: verifiedContext.tenantId } : undefined;
    const client = verifiedContext?.clientId ? { id: verifiedContext.clientId } : undefined;

    return {
      // tenant/clientはDOから取得した検証済みの値を使用（セキュリティ強化）
      tenant,
      client,

      // user/device/request/riskはcollectedDataから取得（将来的には認証済みソースから取得すべき）
      // 注意: これらの値はフロー内でのみ使用され、認証判定には直接使用されない
      user: isObject(collectedData.user) ? collectedData.user : undefined,
      device: isObject(collectedData.device) ? collectedData.device : undefined,
      request: isObject(collectedData.request) ? collectedData.request : undefined,
      risk: isObject(collectedData.risk) ? collectedData.risk : undefined,

      // 以下はフロー内で収集されたデータ
      form: isObject(collectedData.form) ? collectedData.form : undefined,
      prevNode: isNodeOutput(collectedData.prevNode) ? collectedData.prevNode : undefined,
      variables: isObject(collectedData.variables) ? collectedData.variables : undefined,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * FlowExecutorを作成
 *
 * @param env - Cloudflare Worker環境
 * @param options - オプション
 * @returns FlowExecutor インスタンス
 *
 * @example
 * const executor = createFlowExecutor(c.env);
 * const response = await executor.initFlow({
 *   flowType: 'login',
 *   clientId: 'test-client',
 *   tenantId: 'default',
 * });
 */
export function createFlowExecutor(env: Env, options?: FlowExecutorOptions): FlowExecutor {
  return new FlowExecutor(env, options);
}

// =============================================================================
// Export
// =============================================================================

export default FlowExecutor;
