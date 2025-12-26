/**
 * UI Display Types
 *
 * Types for displaying contract settings in an intuitive, user-friendly manner.
 * Supports the goal of making configuration "so intuitive that service designers
 * and marketing people won't get lost."
 */

// =============================================================================
// UI Term Mapping
// =============================================================================

/**
 * Technical term to user-friendly display name mapping.
 * Used to replace jargon with understandable labels.
 */
export const UI_TERM_MAPPING = {
  // Authentication methods
  passkey: 'パスキー（指紋・顔認証）',
  email_code: 'メール認証コード',
  password: 'パスワード',
  external_idp: 'ソーシャルログイン / SSO',
  did: '分散型ID',

  // Security features
  mfa: '二段階認証',
  pkce: 'セキュリティ強化',
  par: '事前認可リクエスト',
  jarm: 'セキュアレスポンス',

  // Scopes
  openid: '基本情報',
  profile: 'プロフィール情報',
  email: 'メールアドレス',
  offline_access: 'オフラインアクセス（長期ログイン）',
  address: '住所情報',
  phone: '電話番号',

  // Security tiers
  standard: '標準',
  enhanced: '強化',
  regulated: '規制対応',

  // Client types
  public: 'パブリック（SPA・モバイル）',
  confidential: 'コンフィデンシャル（サーバーサイド）',

  // Consent policies
  always: '毎回確認',
  first_time: '初回のみ確認',
  remember: 'ユーザーの選択を記憶',
  skip: '確認をスキップ（自社アプリのみ）',
} as const;

/**
 * UI term mapping type.
 */
export type UITermKey = keyof typeof UI_TERM_MAPPING;

// =============================================================================
// Setting Display Information
// =============================================================================

/**
 * UI display information for a setting item.
 */
export interface UISettingDisplay {
  /** Technical name (API field name) */
  technicalName: string;

  /** Display name (user-facing) */
  displayName: string;

  /** Short description (1 line) */
  shortDescription: string;

  /** Long description (detailed explanation) */
  longDescription?: string;

  /** Recommendation level */
  recommendationLevel: RecommendationLevel;

  /** Help URL */
  helpUrl?: string;

  /** Icon identifier */
  icon?: string;

  /** Category for grouping */
  category: SettingCategory;

  /** Input type for UI rendering */
  inputType: SettingInputType;

  /** Whether this is an advanced setting */
  advanced: boolean;
}

/**
 * Recommendation levels for settings.
 */
export type RecommendationLevel = 'recommended' | 'standard' | 'advanced' | 'deprecated';

/**
 * Setting categories for UI grouping.
 */
export type SettingCategory =
  | 'authentication' // 認証方式
  | 'security' // セキュリティ
  | 'tokens' // トークン設定
  | 'consent' // 同意設定
  | 'scopes' // スコープ・権限
  | 'encryption' // 暗号化
  | 'session' // セッション
  | 'integration' // 外部連携
  | 'compliance'; // コンプライアンス

/**
 * Input types for UI rendering.
 */
export type SettingInputType =
  | 'toggle' // On/Off toggle
  | 'select' // Single selection
  | 'multiselect' // Multiple selection
  | 'number' // Numeric input
  | 'duration' // Duration picker (seconds/minutes/hours/days)
  | 'text' // Text input
  | 'textarea' // Multi-line text
  | 'url_list' // List of URLs
  | 'scope_picker'; // Scope selection UI

// =============================================================================
// Setting State
// =============================================================================

/**
 * Current state of a setting item.
 */
export interface SettingState {
  /** Setting is available for modification */
  available: boolean;

  /** Reason for being unavailable (if available=false) */
  disabledReason?: string;

  /** Source of constraint */
  constrainedBy?: ConstraintSource;

  /** Current value */
  currentValue: unknown;

  /** Allowed values (if restricted) */
  allowedValues?: unknown[];

  /** Recommended value */
  recommendedValue?: unknown;

  /** Value bounds (for numeric values) */
  bounds?: ValueBounds;

  /** Whether current value differs from recommended */
  differsFromRecommended: boolean;
}

/**
 * Source of a constraint on a setting.
 */
export type ConstraintSource =
  | 'tenant' // Constrained by tenant policy
  | 'client' // Constrained by client profile
  | 'security_tier' // Constrained by security tier
  | 'compliance' // Constrained by compliance module
  | 'preset' // Constrained by preset (locked)
  | 'platform'; // Platform-level constraint

/**
 * Value bounds for numeric settings.
 */
export interface ValueBounds {
  /** Minimum value */
  min?: number;

  /** Maximum value */
  max?: number;

  /** Step increment */
  step?: number;

  /** Unit label */
  unit?: string;
}

// =============================================================================
// Setting Change Impact
// =============================================================================

/**
 * Preview of impact from changing a setting.
 */
export interface SettingChangeImpact {
  /** Setting being changed */
  setting: string;

  /** Display name of setting */
  displayName: string;

  /** Old value */
  oldValue: unknown;

  /** New value */
  newValue: unknown;

  /** Affected areas */
  affectedAreas: AffectedArea[];

  /** Overall severity */
  overallSeverity: ImpactSeverity;

  /** Requires confirmation */
  requiresConfirmation: boolean;

  /** Confirmation message (if required) */
  confirmationMessage?: string;
}

/**
 * Area affected by a setting change.
 */
export interface AffectedArea {
  /** Area name (e.g., "ログインフロー") */
  area: string;

  /** Impact description */
  impact: string;

  /** Severity level */
  severity: ImpactSeverity;
}

/**
 * Impact severity levels.
 */
export type ImpactSeverity = 'info' | 'warning' | 'breaking';

// =============================================================================
// Flow Designer Node Display
// =============================================================================

/**
 * Display state for a flow designer node.
 */
export interface FlowNodeDisplayState {
  /** Node type (capability type) */
  type: string;

  /** Display name */
  displayName: string;

  /** Short description */
  description: string;

  /** Node is available for use */
  available: boolean;

  /** Reason for being unavailable */
  disabledReason?: string;

  /** Node is required by policy */
  required: boolean;

  /** Reason for being required */
  requiredReason?: string;

  /** Node is read-only (OIDC core) */
  readonly: boolean;

  /** Icon identifier */
  icon: string;

  /** Category for palette grouping */
  category: NodeCategory;

  /** Badge text (e.g., "推奨", "必須") */
  badge?: NodeBadge;
}

/**
 * Node categories for palette grouping.
 */
export type NodeCategory =
  | 'authentication' // 認証方式
  | 'verification' // 検証
  | 'consent' // 同意
  | 'flow_control' // フロー制御
  | 'oidc_core'; // OIDC コア（編集不可）

/**
 * Badge for node display.
 */
export interface NodeBadge {
  /** Badge text */
  text: string;

  /** Badge color/variant */
  variant: 'info' | 'success' | 'warning' | 'error' | 'required';
}

// =============================================================================
// Flow Node Palette
// =============================================================================

/**
 * Categorized node palette for flow designer.
 */
export interface FlowNodePalette {
  /** Palette categories */
  categories: NodePaletteCategory[];
}

/**
 * Category in the node palette.
 */
export interface NodePaletteCategory {
  /** Category ID */
  id: NodeCategory;

  /** Display name (e.g., "認証方式") */
  displayName: string;

  /** Category description */
  description: string;

  /** Icon for category */
  icon?: string;

  /** Nodes in this category */
  nodes: FlowNodeDisplayState[];

  /** Whether category is collapsed by default */
  collapsed?: boolean;
}

// =============================================================================
// Preset Display
// =============================================================================

/**
 * Display information for a preset.
 */
export interface PresetDisplay {
  /** Preset ID */
  id: string;

  /** Display name */
  name: string;

  /** Short description */
  description: string;

  /** Target audience description */
  targetAudience: string;

  /** Feature highlights */
  highlights: PresetHighlight[];

  /** Icon identifier */
  icon?: string;

  /** Recommended badge */
  recommended?: boolean;

  /** Popular badge */
  popular?: boolean;
}

/**
 * Feature highlight for preset display.
 */
export interface PresetHighlight {
  /** Feature name */
  feature: string;

  /** Feature status in this preset */
  status: 'enabled' | 'disabled' | 'configurable';

  /** Description */
  description?: string;
}

// =============================================================================
// Validation Display
// =============================================================================

/**
 * Validation result for UI display.
 */
export interface ValidationDisplay {
  /** Overall validity */
  valid: boolean;

  /** Error messages for display */
  errors: ValidationMessageDisplay[];

  /** Warning messages for display */
  warnings: ValidationMessageDisplay[];

  /** Info messages for display */
  info: ValidationMessageDisplay[];
}

/**
 * Validation message for UI display.
 */
export interface ValidationMessageDisplay {
  /** Message text */
  message: string;

  /** Related field (for highlighting) */
  field?: string;

  /** Suggested action */
  suggestion?: string;

  /** Help URL */
  helpUrl?: string;
}

// =============================================================================
// Wizard/Guided Configuration
// =============================================================================

/**
 * Configuration wizard step.
 */
export interface ConfigWizardStep {
  /** Step ID */
  id: string;

  /** Step title */
  title: string;

  /** Step description */
  description: string;

  /** Settings in this step */
  settings: string[];

  /** Whether step is optional */
  optional: boolean;

  /** Skip condition */
  skipIf?: WizardSkipCondition;
}

/**
 * Condition for skipping a wizard step.
 */
export interface WizardSkipCondition {
  /** Setting to check */
  setting: string;

  /** Value that triggers skip */
  value: unknown;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get user-friendly display name for a technical term.
 */
export function getDisplayName(technicalTerm: string): string {
  const key = technicalTerm.toLowerCase().replace(/-/g, '_') as UITermKey;
  return UI_TERM_MAPPING[key] ?? technicalTerm;
}

/**
 * Get severity color class for UI styling.
 */
export function getSeverityColor(severity: ImpactSeverity): string {
  switch (severity) {
    case 'info':
      return 'text-blue-600';
    case 'warning':
      return 'text-amber-600';
    case 'breaking':
      return 'text-red-600';
    default:
      return 'text-gray-600';
  }
}

/**
 * Get badge variant color class for UI styling.
 */
export function getBadgeColor(variant: NodeBadge['variant']): string {
  switch (variant) {
    case 'info':
      return 'bg-blue-100 text-blue-800';
    case 'success':
      return 'bg-green-100 text-green-800';
    case 'warning':
      return 'bg-amber-100 text-amber-800';
    case 'error':
      return 'bg-red-100 text-red-800';
    case 'required':
      return 'bg-purple-100 text-purple-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}
