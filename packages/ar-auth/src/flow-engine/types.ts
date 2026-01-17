/**
 * Flow Engine - 3層IR型定義
 *
 * アーキテクチャ原則:
 * - GraphDefinition（編集用）: Admin UI / Flow Designerで使用
 * - CompiledPlan（実行用）: Flow Engineが実行時に参照
 * - RuntimeState（DO保存用）: Durable Objectに永続化
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

import type {
  ProfileId,
  Intent,
  CapabilityType,
  CapabilityHints,
  ValidationRule,
  UIContract,
  StabilityLevel,
} from '@authrim/ar-lib-core';

// =============================================================================
// Layer 1: GraphDefinition（編集用）
// Admin UI / Flow Designerで使用。ビジュアル編集に最適化。
// =============================================================================

/**
 * GraphDefinition - Admin UI / Flow Designer用
 * ビジュアル編集に最適化された形式
 */
export interface GraphDefinition {
  /** 一意識別子 */
  id: string;

  /** フロー定義のバージョン（セマンティックバージョン e.g., "1.0.0"） */
  flowVersion: string;

  /** フロー名称 */
  name: string;

  /** フロー説明 */
  description: string;

  /** 対象プロファイル */
  profileId: ProfileId;

  /** ノード定義 */
  nodes: GraphNode[];

  /** エッジ定義 */
  edges: GraphEdge[];

  /** メタデータ */
  metadata: GraphMetadata;
}

/**
 * グラフノード - フローの各ステップ
 */
export interface GraphNode {
  /** ノード一意識別子 */
  id: string;

  /** ノードタイプ */
  type: GraphNodeType;

  /** UI配置位置（Flow Designer用） */
  position: { x: number; y: number };

  /** ノードデータ */
  data: GraphNodeData;
}

/**
 * ノードデータ
 */
export interface GraphNodeData {
  /** 表示ラベル */
  label: string;

  /** Intent（意図/目的） */
  intent: Intent;

  /** Capabilityテンプレート */
  capabilities: CapabilityTemplate[];

  /** ノード固有設定 */
  config: Record<string, unknown>;
}

/**
 * ノードタイプ
 *
 * 設計原則:
 * - 選択 = UIノード（ユーザーが選ぶ）
 * - 判断 = Check/Resolveノード（システムが判定）
 * - 実行 = Actionノード（副作用を起こす）
 * - 制御 = Controlノード（フロー制御）
 */
export type GraphNodeType =
  // === 1. Control Nodes（制御系）===
  | 'start' // フロー開始
  | 'end' // フロー終了
  | 'goto' // Flow内ジャンプ（ループ・共通処理用）

  // === 2. State/Check Nodes（状態判定系）===
  | 'check_session' // セッション有無確認
  | 'check_auth_level' // ACR/強度チェック
  | 'check_first_login' // 初回ログインか
  | 'check_user_attribute' // ユーザー属性チェック
  | 'check_context' // client/locale/ip/country
  | 'check_risk' // リスクスコア

  // === 3. Selection/UI Nodes（選択・入力系）===
  | 'auth_method_select' // 認証方法選択（email or social等）
  | 'login_method_select' // ログイン方法選択（passkey or OTP等）
  | 'identifier' // 識別子入力（email/phone/username）
  | 'profile_input' // プロフィール入力（name/birthdate等）
  | 'custom_form' // 管理者定義フォーム
  | 'information' // 説明のみ（読み取り専用）
  | 'challenge' // CAPTCHA/Botチャレンジ

  // === 4. Authentication Nodes（認証実行系）===
  | 'login' // 認証実行（passkey/otp/password/social）
  | 'mfa' // 追加認証（TOTP/SMS/WebAuthn）
  | 'register' // 新規登録

  // === 5. Consent/Profile Nodes（同意・プロフィール）===
  | 'consent' // 利用規約・同意
  | 'check_consent_status' // 同意済みか確認
  | 'record_consent' // 同意記録（監査用）

  // === 6. Resolve Nodes（解決系 - 重要）===
  | 'resolve_tenant' // テナント解決（email domain等から）
  | 'resolve_org' // 組織解決
  | 'resolve_policy' // ポリシー解決

  // === 7. Session/Token Nodes（セッション・トークン）===
  | 'issue_tokens' // トークン発行
  | 'refresh_session' // セッション更新
  | 'revoke_session' // 強制ログアウト
  | 'bind_device' // デバイス紐付け
  | 'link_account' // ソーシャル連携・ID統合

  // === 8. Side Effect Nodes（外部連携・副作用）===
  | 'redirect' // 意味ベースリダイレクト
  | 'webhook' // 外部通知
  | 'event_emit' // 内部イベント発火（audit/analytics）
  | 'email_send' // メール送信
  | 'sms_send' // SMS送信
  | 'push_notify' // Push通知

  // === 9. Logic/Decision Nodes（条件・分岐）===
  | 'decision' // 複合条件分岐
  | 'switch' // enum分岐（locale/client_type）

  // === 10. Policy Nodes（ポリシー判定）===
  | 'policy_check' // RBAC/ABAC/ReBAC判定

  // === 11. Error/Debug Nodes ===
  | 'error' // エラー表示（retry/support）
  | 'log' // ログ出力（開発用）

  // === Legacy (deprecated, kept for migration) ===
  | 'auth_method' // → auth_method_select に移行
  | 'user_input' // → profile_input/custom_form に移行
  | 'condition' // → decision に移行
  | 'check_user' // → check_user_attribute に移行
  | 'set_variable' // → 内部処理へ
  | 'call_api' // → webhook に統合
  | 'send_notification' // → email_send/sms_send/push_notify に分割
  | 'risk_check' // → check_risk に移行
  | 'wait_input'; // → custom_form に移行

// =============================================================================
// Condition Types - 条件評価用
// =============================================================================

/**
 * 条件キー - 評価対象のデータパス
 * Descope dynamic keysを参考に設計
 */
export type ConditionKey =
  // === User Attributes ===
  | 'user.id'
  | 'user.email'
  | 'user.emailDomain'
  | 'user.phone'
  | 'user.verifiedEmail'
  | 'user.verifiedPhone'
  | 'user.status'
  | 'user.tenantIds'
  | 'user.roles'
  | 'user.permissions'
  | `user.customAttributes.${string}`

  // === Authentication State ===
  | 'user.isLoggedIn'
  | 'user.hasPassword'
  | 'user.hasTotp'
  | 'user.hasWebAuthn'
  | 'user.hasSocialLogin'
  | 'user.mfaEnabled'

  // === Authentication History ===
  | 'lastAuth.time'
  | 'lastAuth.method'
  | 'lastAuth.country'
  | 'lastAuth.city'
  | 'lastAuth.ip'

  // === Device & Context ===
  | 'device.type'
  | 'device.os'
  | 'device.browser'
  | 'device.webAuthnSupport'
  | 'device.trustedDevice'

  // === Location & IP ===
  | 'request.country'
  | 'request.city'
  | 'request.ip'
  | 'request.isVPN'
  | 'request.isTor'

  // === Risk Assessment ===
  | 'risk.score'
  | 'risk.botDetected'
  | 'risk.impossibleTravel'
  | 'risk.newDevice'
  | 'risk.newLocation'

  // === Tenant & Client Context ===
  | 'tenant.id'
  | 'tenant.name'
  | 'tenant.enforceSSO'
  | 'tenant.allowedAuthMethods'
  | 'client.id'
  | 'client.type'

  // === Form Input ===
  | 'form.email'
  | 'form.phone'
  | 'form.identifier'
  | `form.${string}`

  // === Previous Node Results ===
  | 'prevNode.success'
  | 'prevNode.result'
  | 'prevNode.error'
  | 'prevNode.errorCode'

  // === Flow Variables ===
  | `var.${string}`;

/**
 * 条件演算子
 */
export type ConditionOperator =
  | 'equals' // ==
  | 'notEquals' // !=
  | 'contains' // string/array contains
  | 'notContains' // string/array not contains
  | 'startsWith' // string starts with
  | 'endsWith' // string ends with
  | 'greaterThan' // >
  | 'lessThan' // <
  | 'greaterOrEqual' // >=
  | 'lessOrEqual' // <=
  | 'in' // value in array
  | 'notIn' // value not in array
  | 'exists' // not null/undefined
  | 'notExists' // null/undefined
  | 'matches' // regex match
  | 'isTrue' // boolean true (no value needed)
  | 'isFalse'; // boolean false (no value needed)

/**
 * 単一条件
 */
export interface FlowCondition {
  /** 条件キー */
  key: ConditionKey | string; // stringでカスタムキーも許可

  /** 演算子 */
  operator: ConditionOperator;

  /** 比較値（isTrue/isFalseでは不要） */
  value?: unknown;
}

/**
 * 条件グループ（複数条件の組み合わせ）
 */
export interface ConditionGroup {
  /** 論理演算子 */
  logic: 'and' | 'or';

  /** 条件リスト */
  conditions: (FlowCondition | ConditionGroup)[];
}

/**
 * ノード出力 - 直前ノードの結果
 */
export interface NodeOutput {
  /** 成功/失敗 */
  success: boolean;

  /** 結果値（文字列、数値、真偽値、オブジェクト） */
  result?: string | number | boolean | Record<string, unknown>;

  /** エラー情報 */
  error?: {
    code: string;
    message: string;
  };
}

/**
 * フローランタイムコンテキスト - 条件評価時に利用
 */
export interface FlowRuntimeContext {
  // === User ===
  user?: {
    id?: string;
    email?: string;
    emailDomain?: string;
    phone?: string;
    verifiedEmail?: boolean;
    verifiedPhone?: boolean;
    status?: 'active' | 'disabled' | 'invited';
    tenantIds?: string[];
    roles?: string[];
    permissions?: string[];
    customAttributes?: Record<string, unknown>;
    isLoggedIn?: boolean;
    hasPassword?: boolean;
    hasTotp?: boolean;
    hasWebAuthn?: boolean;
    hasSocialLogin?: boolean;
    mfaEnabled?: boolean;
  };

  // === Last Auth ===
  lastAuth?: {
    time?: number;
    method?: string;
    country?: string;
    city?: string;
    ip?: string;
  };

  // === Device ===
  device?: {
    type?: 'mobile' | 'desktop' | 'tablet';
    os?: string;
    browser?: string;
    webAuthnSupport?: boolean;
    trustedDevice?: boolean;
  };

  // === Request ===
  request?: {
    country?: string;
    city?: string;
    ip?: string;
    isVPN?: boolean;
    isTor?: boolean;
  };

  // === Risk ===
  risk?: {
    score?: number;
    botDetected?: boolean;
    impossibleTravel?: boolean;
    newDevice?: boolean;
    newLocation?: boolean;
  };

  // === Tenant & Client ===
  tenant?: {
    id?: string;
    name?: string;
    enforceSSO?: boolean;
    allowedAuthMethods?: string[];
  };
  client?: {
    id?: string;
    type?: 'public' | 'confidential';
  };

  // === Form Input ===
  form?: Record<string, unknown>;

  // === Previous Node ===
  prevNode?: NodeOutput;

  // === Flow Variables ===
  variables?: Record<string, unknown>;
}

/**
 * グラフエッジ - ノード間の遷移
 */
export interface GraphEdge {
  /** エッジ一意識別子 */
  id: string;

  /** 始点ノードID */
  source: string;

  /** 終点ノードID */
  target: string;

  /** 始点ハンドル（複数出力用） */
  sourceHandle?: string;

  /** 終点ハンドル（複数入力用） */
  targetHandle?: string;

  /** エッジタイプ */
  type: GraphEdgeType;

  /** エッジデータ */
  data?: GraphEdgeData;
}

/**
 * エッジデータ
 */
export interface GraphEdgeData {
  /** 表示ラベル */
  label?: string;

  /** 遷移条件（conditionalタイプ用） */
  condition?: EdgeCondition;
}

/**
 * エッジタイプ
 */
export type GraphEdgeType = 'success' | 'error' | 'conditional';

/**
 * エッジ条件
 */
export interface EdgeCondition {
  /** 条件タイプ */
  type: 'capability_result' | 'policy_check' | 'feature_flag' | 'custom';

  /** 評価式（JSONPath風またはJavaScript式） */
  expression: string;
}

/**
 * グラフメタデータ
 */
export interface GraphMetadata {
  /** 作成日時（ISO 8601） */
  createdAt: string;

  /** 更新日時（ISO 8601） */
  updatedAt: string;

  /** 作成者（user_id） */
  createdBy?: string;
}

/**
 * Capabilityテンプレート - UIContract生成時に解決される
 */
export interface CapabilityTemplate {
  /** Capabilityタイプ */
  type: CapabilityType;

  /** ID接尾辞（完全IDは `${nodeId}_${idSuffix}`） */
  idSuffix: string;

  /** 必須フラグ */
  required: boolean;

  /** ヒントテンプレート */
  hintsTemplate?: Partial<CapabilityHints>;

  /** バリデーションルール */
  validationRules?: ValidationRule[];
}

// =============================================================================
// Layer 2: CompiledPlan（実行用）
// Flow Engineが実行時に参照。最適化された形式。
// =============================================================================

/**
 * CompiledPlan - Flow Engine実行用
 * GraphDefinitionをコンパイルした最適化形式
 */
export interface CompiledPlan {
  /** コンパイル済みプランID */
  id: string;

  /** CompiledPlan自体のバージョン */
  version: string;

  /** 元のGraphDefinitionのflowVersion */
  sourceVersion: string;

  /** 対象プロファイル */
  profileId: ProfileId;

  /** エントリーポイントノードID */
  entryNodeId: string;

  /** ノードマップ（id -> CompiledNode） */
  nodes: Map<string, CompiledNode>;

  /** 遷移マップ（sourceNodeId -> CompiledTransition[]） */
  transitions: Map<string, CompiledTransition[]>;

  /** コンパイル日時（ISO 8601） */
  compiledAt: string;
}

/**
 * コンパイル済みノード
 */
export interface CompiledNode {
  /** ノードID */
  id: string;

  /** ノードタイプ */
  type: GraphNodeType;

  /** Intent */
  intent: Intent;

  /** 解決済みCapability */
  capabilities: ResolvedCapability[];

  /** 成功時の次ノードID（nullは終端） */
  nextOnSuccess: string | null;

  /** エラー時の次ノードID（nullはデフォルトエラーハンドリング） */
  nextOnError: string | null;
}

/**
 * コンパイル済み遷移
 */
export interface CompiledTransition {
  /** 遷移先ノードID */
  targetNodeId: string;

  /** 遷移タイプ */
  type: 'success' | 'error' | 'conditional';

  /** コンパイル済み条件（conditionalタイプ用） */
  condition?: CompiledCondition;
}

/**
 * コンパイル済み条件
 */
export interface CompiledCondition {
  /** 条件タイプ */
  type: 'capability_result' | 'policy_check' | 'feature_flag' | 'custom';

  /** 元の式 */
  expression: string;

  /** 評価関数（コンパイル時に生成） */
  evaluate: (context: EvaluationContext) => boolean;
}

/**
 * 条件評価コンテキスト
 */
export interface EvaluationContext {
  /** 収集済みデータ */
  collectedData: Record<string, unknown>;

  /** 完了済みCapability ID */
  completedCapabilities: string[];

  /** ユーザークレーム */
  claims?: Record<string, unknown>;

  /** 機能フラグ */
  featureFlags?: Record<string, boolean>;
}

/**
 * 解決済みCapability
 */
export interface ResolvedCapability {
  /** Capabilityタイプ */
  type: CapabilityType;

  /** 完全ID（`${nodeId}_${idSuffix}`） */
  id: string;

  /** 必須フラグ */
  required: boolean;

  /** 解決済みヒント */
  hints: CapabilityHints;

  /** バリデーションルール */
  validationRules: ValidationRule[];

  /** 安定性レベル */
  stability: StabilityLevel;
}

// =============================================================================
// Layer 3: RuntimeState（DO保存用）
// Durable Objectに永続化。最小限のデータ。
// =============================================================================

/**
 * RuntimeState - Durable Object保存用
 * 実行時の状態を最小限に保持
 */
export interface RuntimeState {
  // === セッション識別 ===

  /** セッションID */
  sessionId: string;

  /** フローID */
  flowId: string;

  /** テナントID */
  tenantId: string;

  /** クライアントID */
  clientId: string;

  // === 現在位置 ===

  /** 現在のノードID */
  currentNodeId: string;

  /** 訪問済みノードID */
  visitedNodeIds: string[];

  // === 収集済みデータ ===

  /** 収集したデータ（capabilityId -> response） */
  collectedData: Record<string, unknown>;

  /** 完了済みCapability ID */
  completedCapabilities: string[];

  // === 認証コンテキスト ===

  /** 認証済みユーザーID */
  userId?: string;

  /** ユーザークレーム */
  claims?: Record<string, unknown>;

  // === OAuth パラメータ（認可フロー用） ===
  oauthParams?: OAuthFlowParams;

  // === タイムスタンプ ===

  /** フロー開始時刻（UNIX ms） */
  startedAt: number;

  /** 有効期限（UNIX ms） */
  expiresAt: number;

  /** 最終アクティビティ時刻（UNIX ms） */
  lastActivityAt: number;

  // === 冪等性管理 ===

  /** 処理済みrequestId -> スナップショット */
  processedRequestIds: Record<string, RuntimeStateSnapshot>;
}

/**
 * OAuthフローパラメータ
 */
export interface OAuthFlowParams {
  responseType?: string;
  redirectUri?: string;
  scope?: string;
  state?: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  acrValues?: string;
  loginHint?: string;
  prompt?: string;
  maxAge?: number;
}

/**
 * 冪等性のためのスナップショット
 * 同一requestIdの再送時にこの結果を返す
 */
export interface RuntimeStateSnapshot {
  /** リクエストID */
  requestId: string;

  /** 処理時刻（UNIX ms） */
  processedAt: number;

  /** 結果のノードID */
  resultNodeId: string;

  /** 結果データ（UIContractまたはリダイレクト情報） */
  resultData: FlowSubmitResult;
}

// =============================================================================
// API Request/Response Types
// =============================================================================

/**
 * POST /api/flow/init リクエスト
 */
export interface FlowInitRequest {
  /** フロータイプ */
  flowType: 'login' | 'authorization' | 'consent' | 'logout';

  /** クライアントID */
  clientId: string;

  /** テナントID（マルチテナント用） */
  tenantId?: string;

  /** OAuthパラメータ（認可フロー用） */
  oauthParams?: OAuthFlowParams;
}

/**
 * POST /api/flow/init レスポンス
 */
export interface FlowInitResponse {
  /** セッションID */
  sessionId: string;

  /** UIContractバージョン */
  uiContractVersion: '0.1';

  /** 初期UIContract */
  uiContract: UIContract;
}

/**
 * POST /api/flow/submit リクエスト
 */
export interface FlowSubmitRequest {
  /** セッションID */
  sessionId: string;

  /** リクエストID（クライアント生成UUID、冪等性用） */
  requestId: string;

  /** Capability ID */
  capabilityId: string;

  /** Capability応答 */
  response: unknown;
}

/**
 * POST /api/flow/submit レスポンス
 */
export type FlowSubmitResponse = FlowSubmitResult;

/**
 * フロー送信結果
 */
export type FlowSubmitResult =
  | { type: 'continue'; uiContract: UIContract }
  | { type: 'redirect'; redirect: FlowRedirect }
  | { type: 'error'; error: FlowError };

/**
 * リダイレクト情報
 */
export interface FlowRedirect {
  /** リダイレクトURL */
  url: string;

  /** HTTPメソッド */
  method: 'GET' | 'POST';

  /** 追加パラメータ */
  params?: Record<string, string>;
}

/**
 * フローエラー
 */
export interface FlowError {
  /** エラーコード */
  code: string;

  /** エラーメッセージ */
  message: string;

  /** 追加詳細 */
  details?: Record<string, unknown>;
}

/**
 * GET /api/flow/state/:sessionId レスポンス
 */
export interface FlowStateResponse {
  /** 現在の状態（公開用サブセット） */
  state: {
    currentNodeId: string;
    visitedNodeIds: string[];
    completedCapabilities: string[];
  };

  /** 現在のUIContract */
  uiContract: UIContract;
}

// =============================================================================
// Flow Migrator Types
// =============================================================================

/**
 * マイグレーション関数
 */
export type MigrationFn = (flow: GraphDefinition) => GraphDefinition;

/**
 * マイグレーション定義
 */
export interface MigrationDefinition {
  /** 移行元バージョン */
  fromVersion: string;

  /** 移行先バージョン */
  toVersion: string;

  /** マイグレーション関数 */
  migrate: MigrationFn;
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * GraphDefinitionをCompiledPlanに変換するコンパイラ
 */
export interface FlowCompiler {
  compile(graph: GraphDefinition): CompiledPlan;
}

/**
 * RuntimeStateの作成パラメータ
 */
export interface CreateRuntimeStateParams {
  sessionId: string;
  flowId: string;
  tenantId: string;
  clientId: string;
  entryNodeId: string;
  ttlMs: number;
  oauthParams?: OAuthFlowParams;
}

/**
 * セッション有効期限のデフォルト値（10分）
 */
export const DEFAULT_FLOW_TTL_MS = 10 * 60 * 1000;

/**
 * 冪等性スナップショットの最大保持数
 */
export const MAX_PROCESSED_REQUEST_IDS = 100;
