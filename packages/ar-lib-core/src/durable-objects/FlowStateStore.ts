/**
 * FlowStateStore - Durable Object
 *
 * 責務（厳格に限定）:
 * - RuntimeState保管
 * - 排他制御（同一セッションの並行リクエスト防止）
 * - TTL管理（有効期限切れの自動削除）
 * - requestId重複検知（冪等性）
 *
 * 責務外（Worker側で処理）:
 * - PolicyResolver
 * - UIContractGenerator
 * - CapabilityResolver
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

import type { DurableObjectState } from '@cloudflare/workers-types';

// =============================================================================
// Types (Flow Engine specific)
// =============================================================================

/** OAuth Flow パラメータ */
export interface OAuthFlowParams {
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

/** RuntimeState - Layer 3: DO保存用 */
export interface RuntimeState {
  /** セッションID */
  sessionId: string;
  /** FlowID（どのFlowを実行中か） */
  flowId: string;
  /** FlowType（'login' | 'authorization' | 'consent' | 'logout'） */
  flowType: string;
  /** テナントID */
  tenantId: string;
  /** クライアントID */
  clientId: string;
  /** 現在のノードID */
  currentNodeId: string;
  /** 訪問済みノードID配列 */
  visitedNodeIds: string[];
  /** 収集済みデータ（capabilityId → 応答データ） */
  collectedData: Record<string, unknown>;
  /** 完了済みcapabilityId配列 */
  completedCapabilities: string[];
  /** OAuthパラメータ（PKCE等） */
  oauthParams?: OAuthFlowParams;
  /** 認証済みユーザーID（認証完了後に設定） */
  userId?: string;
  /** Flow開始時刻（Unix ms） */
  startedAt: number;
  /** Flow有効期限（Unix ms） */
  expiresAt: number;
  /** 最終アクティビティ時刻（Unix ms） */
  lastActivityAt: number;
  /** Recent request timestamps for per-session rate limiting */
  requestTimestamps: number[];
  /** 処理済みrequestId → スナップショット（冪等性用） */
  processedRequestIds: Record<string, RuntimeStateSnapshot>;
}

/** RuntimeStateスナップショット（冪等性用） */
export interface RuntimeStateSnapshot {
  /** リクエストID */
  requestId: string;
  /** 処理時刻（Unix ms） */
  processedAt: number;
  /** 処理結果のノードID */
  resultNodeId: string;
  /** 処理結果データ */
  resultData: FlowSubmitResult;
}

/** Capability応答処理の結果 */
export type FlowSubmitResult =
  | {
      type: 'continue';
      uiContract: unknown;
    }
  | {
      type: 'redirect';
      redirect: { url: string; method?: string };
    }
  | {
      type: 'error';
      error: { code: string; message: string };
    };

/** RuntimeState作成パラメータ */
export interface CreateRuntimeStateParams {
  /** セッションID */
  sessionId: string;
  /** FlowID */
  flowId: string;
  /** FlowType（'login' | 'authorization' | 'consent' | 'logout'） */
  flowType: string;
  /** テナントID */
  tenantId: string;
  /** クライアントID */
  clientId: string;
  /** エントリーノードID */
  entryNodeId: string;
  /** TTL（ミリ秒） */
  ttlMs?: number;
  /** OAuthパラメータ */
  oauthParams?: OAuthFlowParams;
}

/** デフォルトのFlow TTL（15分） */
export const DEFAULT_FLOW_TTL_MS = 15 * 60 * 1000;

/** 冪等性用に保持する最大requestId数 */
export const MAX_PROCESSED_REQUEST_IDS = 100;

// =============================================================================
// FlowStateStore Durable Object
// =============================================================================

/**
 * FlowStateStore Durable Object
 *
 * Durable Objectは同一IDへのリクエストを直列化するため、
 * 並行リクエストの排他制御が自動的に行われる。
 */
export class FlowStateStore {
  private state: DurableObjectState;
  private runtimeState: RuntimeState | null = null;
  private initialized = false;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  /**
   * HTTPリクエストハンドラ
   * DOへのすべてのリクエストはここを通る
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    try {
      // 初期化（必要に応じて）
      if (!this.initialized) {
        await this.loadState();
      }

      // ルーティング
      switch (`${method} ${pathname}`) {
        case 'POST /init':
          return await this.handleInit(request);
        case 'POST /submit':
          return await this.handleSubmit(request);
        case 'POST /check-request':
          return await this.handleCheckRequest(request);
        case 'GET /state':
          return await this.handleGetState(request);
        case 'DELETE /cancel':
          return await this.handleCancel(request);
        default:
          return new Response(JSON.stringify({ error: 'Not Found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // =============================================================================
  // Handler Methods
  // =============================================================================

  /**
   * POST /init - RuntimeState初期化
   */
  private async handleInit(request: Request): Promise<Response> {
    const params = (await request.json()) as CreateRuntimeStateParams;
    const validationError = this.validateInitRequest(request, params);
    if (validationError) {
      return validationError;
    }

    // 既存の状態があればエラー
    if (this.runtimeState) {
      return new Response(
        JSON.stringify({
          error: 'Session already exists',
          code: 'session_exists',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // RuntimeState作成
    const now = Date.now();
    this.runtimeState = {
      sessionId: params.sessionId,
      flowId: params.flowId,
      flowType: params.flowType,
      tenantId: params.tenantId,
      clientId: params.clientId,
      currentNodeId: params.entryNodeId,
      visitedNodeIds: [params.entryNodeId],
      collectedData: {},
      completedCapabilities: [],
      oauthParams: params.oauthParams,
      startedAt: now,
      expiresAt: now + (params.ttlMs || DEFAULT_FLOW_TTL_MS),
      lastActivityAt: now,
      requestTimestamps: [],
      processedRequestIds: {},
    };

    // 永続化
    await this.saveState();

    // TTLアラーム設定
    await this.state.storage.setAlarm(this.runtimeState.expiresAt);

    return new Response(JSON.stringify({ success: true, state: this.getPublicState() }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * POST /submit - Capability応答処理
   * 冪等性: sessionId + requestId で重複検知
   */
  private async handleSubmit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      requestId: string;
      capabilityId: string;
      response: unknown;
      // Worker側で計算された結果
      result: FlowSubmitResult;
      nextNodeId: string;
      requestTimestamps?: number[];
    };

    // 状態チェック
    if (!this.runtimeState) {
      return new Response(
        JSON.stringify({
          error: 'Session not found',
          code: 'session_not_found',
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const validationError = this.validateRuntimeRequest(request);
    if (validationError) {
      return validationError;
    }

    // 有効期限チェック
    if (Date.now() > this.runtimeState.expiresAt) {
      return new Response(
        JSON.stringify({
          error: 'Session expired',
          code: 'session_expired',
        }),
        { status: 410, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 冪等性チェック
    const existingSnapshot = this.runtimeState.processedRequestIds[body.requestId];
    if (existingSnapshot) {
      // 同一requestIdの再送 → 前回の結果を返す
      return new Response(JSON.stringify(existingSnapshot.resultData), {
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotent': 'true',
        },
      });
    }

    // 状態更新
    const now = Date.now();
    this.runtimeState.currentNodeId = body.nextNodeId;
    this.runtimeState.visitedNodeIds.push(body.nextNodeId);
    this.runtimeState.collectedData[body.capabilityId] = body.response;
    this.runtimeState.completedCapabilities.push(body.capabilityId);
    this.runtimeState.lastActivityAt = now;
    if (Array.isArray(body.requestTimestamps)) {
      this.runtimeState.requestTimestamps = body.requestTimestamps.filter(
        (timestamp): timestamp is number =>
          typeof timestamp === 'number' && Number.isFinite(timestamp)
      );
    }

    // 冪等性スナップショット保存
    const snapshot: RuntimeStateSnapshot = {
      requestId: body.requestId,
      processedAt: now,
      resultNodeId: body.nextNodeId,
      resultData: body.result,
    };
    this.runtimeState.processedRequestIds[body.requestId] = snapshot;

    // 古いスナップショットを削除（MAX_PROCESSED_REQUEST_IDS以上は保持しない）
    this.pruneOldSnapshots();

    // 永続化
    await this.saveState();

    return new Response(JSON.stringify(body.result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * GET /state - 現在の状態取得
   */
  private async handleGetState(request: Request): Promise<Response> {
    if (!this.runtimeState) {
      return new Response(
        JSON.stringify({
          error: 'Session not found',
          code: 'session_not_found',
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const validationError = this.validateRuntimeRequest(request);
    if (validationError) {
      return validationError;
    }

    // 有効期限チェック
    if (Date.now() > this.runtimeState.expiresAt) {
      return new Response(
        JSON.stringify({
          error: 'Session expired',
          code: 'session_expired',
        }),
        { status: 410, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ state: this.getPublicState() }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * DELETE /cancel - セッションキャンセル
   */
  private async handleCancel(request: Request): Promise<Response> {
    const validationError = this.validateRuntimeRequest(request, { allowMissingState: true });
    if (validationError) {
      return validationError;
    }

    if (this.runtimeState) {
      // アラームをキャンセル
      await this.state.storage.deleteAlarm();

      // 状態をクリア
      this.runtimeState = null;
      await this.state.storage.delete('runtimeState');
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * POST /check-request - 冪等性チェック（Worker側での事前チェック用）
   *
   * requestIdが既に処理済みかどうかをチェックし、
   * 処理済みの場合はキャッシュされた結果を返す。
   * これによりWorker側でUIContractの再生成を回避できる。
   */
  private async handleCheckRequest(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      requestId: string;
    };

    // 状態チェック
    if (!this.runtimeState) {
      return new Response(
        JSON.stringify({
          error: 'Session not found',
          code: 'session_not_found',
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const validationError = this.validateRuntimeRequest(request);
    if (validationError) {
      return validationError;
    }

    // 有効期限チェック
    if (Date.now() > this.runtimeState.expiresAt) {
      return new Response(
        JSON.stringify({
          error: 'Session expired',
          code: 'session_expired',
        }),
        { status: 410, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 冪等性チェック
    const existingSnapshot = this.runtimeState.processedRequestIds[body.requestId];
    if (existingSnapshot) {
      // 同一requestIdの再送 → 前回の結果を返す
      return new Response(
        JSON.stringify({
          found: true,
          result: existingSnapshot.resultData,
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotent': 'true',
          },
        }
      );
    }

    // 未処理
    return new Response(
      JSON.stringify({
        found: false,
        state: this.getPublicState(),
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // =============================================================================
  // Alarm Handler (TTL管理)
  // =============================================================================

  /**
   * アラームハンドラ - 有効期限切れ時に呼ばれる
   */
  async alarm(): Promise<void> {
    // 有効期限切れの状態をクリア
    this.runtimeState = null;
    await this.state.storage.delete('runtimeState');
  }

  // =============================================================================
  // Internal Methods
  // =============================================================================

  /**
   * 状態をストレージから読み込み
   */
  private async loadState(): Promise<void> {
    const stored = await this.state.storage.get<RuntimeState>('runtimeState');
    if (stored) {
      // processedRequestIdsをオブジェクトとして復元
      this.runtimeState = {
        ...stored,
        requestTimestamps: stored.requestTimestamps || [],
        processedRequestIds: stored.processedRequestIds || {},
      };
    }
    this.initialized = true;
  }

  /**
   * 状態をストレージに保存
   */
  private async saveState(): Promise<void> {
    if (this.runtimeState) {
      await this.state.storage.put('runtimeState', this.runtimeState);
    }
  }

  /**
   * 公開用の状態サブセットを取得
   */
  private getPublicState(): {
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
    requestTimestamps: number[];
    collectedData?: Record<string, unknown>;
    oauthParams?: OAuthFlowParams;
  } | null {
    if (!this.runtimeState) return null;

    return {
      sessionId: this.runtimeState.sessionId,
      flowId: this.runtimeState.flowId,
      flowType: this.runtimeState.flowType,
      tenantId: this.runtimeState.tenantId,
      clientId: this.runtimeState.clientId,
      currentNodeId: this.runtimeState.currentNodeId,
      visitedNodeIds: this.runtimeState.visitedNodeIds,
      completedCapabilities: this.runtimeState.completedCapabilities,
      startedAt: this.runtimeState.startedAt,
      expiresAt: this.runtimeState.expiresAt,
      requestTimestamps: this.runtimeState.requestTimestamps,
      collectedData: this.runtimeState.collectedData,
      oauthParams: this.runtimeState.oauthParams,
    };
  }

  private validateInitRequest(request: Request, params: CreateRuntimeStateParams): Response | null {
    const tenantId = this.getRequiredHeader(request, 'X-Tenant-Id', 'tenant_required');
    if (tenantId instanceof Response) {
      return tenantId;
    }

    const sessionId = this.getRequiredHeader(request, 'X-Flow-Session-Id', 'session_required');
    if (sessionId instanceof Response) {
      return sessionId;
    }

    if (!params.tenantId || params.tenantId.trim() !== tenantId) {
      return this.jsonError('Tenant mismatch', 'tenant_mismatch', 403);
    }

    if (!params.sessionId || params.sessionId.trim() !== sessionId) {
      return this.jsonError('Session mismatch', 'session_mismatch', 403);
    }

    return null;
  }

  private validateRuntimeRequest(
    request: Request,
    options: { allowMissingState?: boolean } = {}
  ): Response | null {
    const tenantId = this.getRequiredHeader(request, 'X-Tenant-Id', 'tenant_required');
    if (tenantId instanceof Response) {
      return tenantId;
    }

    const sessionId = this.getRequiredHeader(request, 'X-Flow-Session-Id', 'session_required');
    if (sessionId instanceof Response) {
      return sessionId;
    }

    if (!this.runtimeState) {
      return options.allowMissingState
        ? null
        : this.jsonError('Session not found', 'session_not_found', 404);
    }

    if (this.runtimeState.tenantId !== tenantId) {
      return this.jsonError('Tenant mismatch', 'tenant_mismatch', 403);
    }

    if (this.runtimeState.sessionId !== sessionId) {
      return this.jsonError('Session mismatch', 'session_mismatch', 403);
    }

    return null;
  }

  private getRequiredHeader(request: Request, headerName: string, code: string): string | Response {
    const value = request.headers.get(headerName)?.trim();
    if (!value) {
      return this.jsonError(`${headerName} header is required`, code, 400);
    }
    return value;
  }

  private jsonError(error: string, code: string, status: number): Response {
    return new Response(JSON.stringify({ error, code }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * 古い冪等性スナップショットを削除
   */
  private pruneOldSnapshots(): void {
    if (!this.runtimeState) return;

    const requestIds = Object.keys(this.runtimeState.processedRequestIds);
    if (requestIds.length <= MAX_PROCESSED_REQUEST_IDS) return;

    // processedAtでソートして古いものを削除
    const sorted = requestIds.sort((a, b) => {
      const aTime = this.runtimeState!.processedRequestIds[a].processedAt;
      const bTime = this.runtimeState!.processedRequestIds[b].processedAt;
      return aTime - bTime;
    });

    const toDelete = sorted.slice(0, requestIds.length - MAX_PROCESSED_REQUEST_IDS);
    for (const id of toDelete) {
      delete this.runtimeState.processedRequestIds[id];
    }
  }
}

// =============================================================================
// Export
// =============================================================================

export default FlowStateStore;
