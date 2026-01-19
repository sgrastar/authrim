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
  RuntimeState,
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
 * DO状態レスポンス
 */
interface DOStateResponse {
  state?: {
    sessionId: string;
    flowId: string;
    currentNodeId: string;
    visitedNodeIds: string[];
    completedCapabilities: string[];
    expiresAt: number;
    collectedData?: Record<string, unknown>;
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
    currentNodeId: string;
    visitedNodeIds: string[];
    completedCapabilities: string[];
    expiresAt: number;
    collectedData?: Record<string, unknown>;
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

    // セキュリティ対策（Medium 10）: Tenant/Client 権限チェック
    // TODO: 以下の検証を実装する必要がある
    // 1. tenantId が存在し、アクティブであることを確認
    // 2. clientId が tenantId に属していることを確認
    // 3. clientId がこの flowType を実行する権限を持っていることを確認
    // 現在は簡易実装のため、これらのチェックが省略されている
    // 実装例:
    //   const tenant = await this.validateTenant(tenantId);
    //   const client = await this.validateClient(clientId, tenantId);
    //   if (!tenant || !client) {
    //     throw new Error('Unauthorized: Invalid tenant or client');
    //   }

    console.warn(
      `[Security] initFlow: Missing tenant/client validation for tenantId="${tenantId}", clientId="${clientId}"`
    );

    // 1. Flow定義を取得
    const graphDef = await this.registry.getFlow(flowType, tenantId);
    if (!graphDef) {
      throw new Error(`Flow not found: ${flowType}`);
    }

    // 2. CompiledPlanを取得またはコンパイル
    const compiledPlan = this.getOrCompilePlan(graphDef);

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
    const doResponse = await this.callDO<DOInitResponse>(sessionId, '/init', 'POST', {
      sessionId,
      flowId: graphDef.id,
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
    const { sessionId, requestId, capabilityId, response } = params;

    // セキュリティ対策（Medium 10）: セッション権限チェック
    // TODO: 以下の検証を実装する必要がある
    // 1. sessionId が有効（期限切れでない、改ざんされていない）
    // 2. セッションが正しい tenantId/clientId に属している
    // 3. リクエスト元 IP/User-Agent がセッション作成時と一致する
    // 現在は DO 側でセッション管理しているが、追加の検証が必要
    // 実装例:
    //   const session = await this.validateSession(sessionId);
    //   if (!session || session.isExpired()) {
    //     return { type: 'error', error: { code: 'invalid_session', message: 'Session expired' } };
    //   }

    console.warn(`[Security] submitCapability: Missing session validation for sessionId="${sessionId}"`);

    // 1. 冪等性チェック（/check-request）
    // これにより同一requestIdのリクエストは処理をスキップしてキャッシュ結果を返す
    const checkResponse = await this.callDO<DOCheckRequestResponse>(
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

    const { flowId, currentNodeId, collectedData = {} } = checkResponse.state;

    // セキュリティ対策: レート制限（Critical 3）
    // セッション状態からリクエストタイムスタンプを取得（DO側で実装されていない場合は空配列）
    const requestTimestamps =
      (checkResponse.state as { requestTimestamps?: number[] }).requestTimestamps || [];
    const now = Date.now();
    const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1分間のウィンドウ
    const MAX_REQUESTS_PER_WINDOW = 30; // 1分間に最大30リクエスト
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // セッション最大30分

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
    const sessionCreatedAt =
      (checkResponse.state as { createdAt?: number }).createdAt || now;
    if (now - sessionCreatedAt > SESSION_TIMEOUT_MS) {
      console.error(
        `[Security] Session timeout: ${Math.floor((now - sessionCreatedAt) / 1000 / 60)} minutes elapsed (max: ${SESSION_TIMEOUT_MS / 1000 / 60})`
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
    const visitedNodes = (checkResponse.state as { visitedNodes?: string[] }).visitedNodes || [];
    const MAX_VISITS_PER_NODE = 3; // 同じノードへの最大訪問回数
    const MAX_TOTAL_NODES = 50; // フロー全体での最大ノード訪問数（無限ループ対策）

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
    const compiledPlan = this.compiledPlans.get(`compiled-${flowId}`);
    if (!compiledPlan) {
      // キャッシュにない場合、再コンパイル
      const graphDef = await this.registry.getFlow('login'); // TODO: flowTypeを保存
      if (!graphDef) {
        return {
          type: 'error',
          error: {
            code: 'flow_not_found',
            message: 'Flow definition not found',
          },
        };
      }
      this.getOrCompilePlan(graphDef);
    }

    const plan = this.compiledPlans.get(`compiled-${flowId}`);
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
    const runtimeContext = this.buildRuntimeContext(collectedData);
    const nextNodeId = await this.determineNextNode(currentNode, plan, runtimeContext);

    // 完了チェック
    if (!nextNodeId) {
      // フロー完了 → リダイレクト
      return {
        type: 'redirect',
        redirect: {
          url: '/callback', // TODO: 実際のリダイレクトURLを取得
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
      return {
        type: 'redirect',
        redirect: {
          url: '/callback', // TODO: 実際のリダイレクトURLを取得
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

    await this.callDO(sessionId, '/submit', 'POST', {
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
  async getFlowState(sessionId: string): Promise<FlowStateResponse> {
    // 1. DOから状態を取得
    const stateResponse = await this.callDO<DOStateResponse>(sessionId, '/state', 'GET');

    if (stateResponse.error || !stateResponse.state) {
      throw new Error(stateResponse.error || 'Session not found');
    }

    const { flowId, currentNodeId, visitedNodeIds, completedCapabilities, collectedData } =
      stateResponse.state;

    // 2. CompiledPlanを取得
    let plan = this.compiledPlans.get(`compiled-${flowId}`);
    if (!plan) {
      // キャッシュにない場合、再コンパイル
      const graphDef = await this.registry.getFlow('login');
      if (graphDef) {
        plan = this.getOrCompilePlan(graphDef);
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
  async cancelFlow(sessionId: string): Promise<void> {
    await this.callDO(sessionId, '/cancel', 'DELETE');
  }

  // =============================================================================
  // Private Methods
  // =============================================================================

  /**
   * CompiledPlanを取得またはコンパイル
   */
  private getOrCompilePlan(graphDef: {
    id: string;
    flowVersion: string;
    profileId: string;
    nodes: unknown[];
    edges: unknown[];
    name: string;
    description: string;
    metadata: unknown;
  }): CompiledPlan {
    const cacheKey = `compiled-${graphDef.id}`;

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

  /**
   * FlowStateStore DOを呼び出す
   *
   * シャーディング戦略:
   * - sessionIdをFNV-1aハッシュでシャードインデックスに変換
   * - シャード数はKV/環境変数/デフォルト(32)の優先順で取得
   * - DOインスタンス名: flow-{shardIndex}
   */
  private async callDO<T>(
    sessionId: string,
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown
  ): Promise<T> {
    // シャーディングユーティリティを使用してDO stubを取得
    const { stub } = await getFlowStateStoreStub(this.env, sessionId);

    // リクエストを作成
    const requestInit: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
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
          return transition.targetNodeId;
        }
      }
    }

    // どの条件にもマッチしない場合、デフォルト分岐
    if (config.defaultBranch) {
      const defaultTransition = transitions.find((t) => t.sourceHandle === config.defaultBranch);
      if (defaultTransition) {
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

    // switchKeyの値を取得
    const keyParts = config.switchKey.split('.');
    let value: unknown = context;
    for (const part of keyParts) {
      if (value === null || value === undefined || typeof value !== 'object') {
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
          return transition.targetNodeId;
        }
      }
    }

    // どのcaseにもマッチしない場合、デフォルトcase
    if (config.defaultCase) {
      const defaultTransition = transitions.find((t) => t.sourceHandle === config.defaultCase);
      if (defaultTransition) {
        return defaultTransition.targetNodeId;
      }
    }

    // デフォルトcaseもない場合はnull（フロー終了）
    return null;
  }

  /**
   * ログ出力時に機密情報をサニタイズ（High 9）
   *
   * @param obj - ログ出力するオブジェクト
   * @returns サニタイズされたオブジェクト
   */
  private sanitizeForLogging(obj: unknown): unknown {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

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
      return obj.map((item) => this.sanitizeForLogging(item));
    }

    // オブジェクトの場合
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = SENSITIVE_KEYS.some((sensitiveKey) =>
        lowerKey.includes(sensitiveKey.toLowerCase())
      );

      if (isSensitive) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeForLogging(value);
      } else {
        sanitized[key] = value;
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
  private buildRuntimeContext(collectedData: Record<string, unknown>): FlowRuntimeContext {
    // セキュリティ警告: collectedDataは信頼できないデータ
    // TODO: 認証済みソースから実際のユーザー情報を取得する実装が必要
    // 現在は簡易実装として、collectedDataから必要な情報を抽出

    // 本来は認証済みソースから取得すべき情報
    // 暫定的にcollectedDataから取得するが、将来的には以下のような実装が必要:
    // - user: セッションIDからユーザー情報を再取得
    // - device: リクエストヘッダーから抽出
    // - request: 実際のHTTPリクエストから抽出
    // - risk: リスク評価エンジンから取得
    // - tenant/client: セッションから検証済みのものを取得

    console.warn(
      '[Security] buildRuntimeContext: Using collectedData for context. This should be replaced with authenticated sources.'
    );

    return {
      // TODO: 以下は認証済みソースから取得すべき
      user: collectedData.user as FlowRuntimeContext['user'],
      device: collectedData.device as FlowRuntimeContext['device'],
      request: collectedData.request as FlowRuntimeContext['request'],
      risk: collectedData.risk as FlowRuntimeContext['risk'],
      tenant: collectedData.tenant as FlowRuntimeContext['tenant'],
      client: collectedData.client as FlowRuntimeContext['client'],

      // 以下は信頼できないデータとして許可
      form: collectedData.form as FlowRuntimeContext['form'],
      prevNode: collectedData.prevNode as FlowRuntimeContext['prevNode'],
      variables: collectedData.variables as FlowRuntimeContext['variables'],
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
