/**
 * What the lite Login UI can render, and the checks that find what it cannot.
 *
 * The admin guard runs these before a tenant is switched to `always` and on every later change
 * that could add something unsupported; the lite UI's server driver uses the same lists and stops
 * (an error page, before any side effect) when it meets anything outside them. Anything new or
 * unknown is unsupported: a Flow component, a screen block or a sign-in method has to be added
 * here, deliberately, before the lite UI shows it.
 */
import type { ScreenField } from '../types/screens';

/** The Flow kinds the lite UI starts. */
export const LITE_FLOW_KINDS = ['login', 'registration'] as const;

/** Flow runtime components the lite UI drives. */
export const LITE_FLOW_COMPONENTS: ReadonlySet<string> = new Set([
  'interaction_context',
  'session_check',
  'registration_method_selector',
  'authentication_method_selector',
  'email_verification',
  'screen',
  'consent_policy',
  'account_action',
  'completion',
  'condition',
]);

/** Screen blocks the lite UI renders on sign-in, sign-up, code entry and consent screens. */
export const LITE_SCREEN_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'identity_field',
  'checkbox',
  'select',
  'radio',
  'auth_widget',
  'guest_login_widget',
  'code_input_widget',
  'consent_widget',
  'heading',
  'text',
  'security_verification',
  'divider',
  'layout_row',
  'link',
]);

/** Blocks the lite UI renders on account pages. */
export const LITE_ACCOUNT_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'heading',
  'text',
  'divider',
  'layout_row',
  'link',
  'account_upgrade_widget',
  'account_profile_widget',
  'account_device_list_widget',
  'account_session_widget',
  'account_passkey_widget',
  'account_totp_widget',
  'account_consent_widget',
  'account_activity_widget',
  'account_social_account_widget',
  'account_launcher_widget',
]);

/** Sign-in methods an `auth_widget` block may offer in the lite UI. */
export const LITE_AUTH_METHODS: ReadonlySet<string> = new Set([
  'mail_otp',
  'mail_otp_totp',
  'passkey',
  'totp',
  'external_idp',
]);

export type LiteModeIssueCode =
  /** The lite UI is not released in this environment. */
  | 'not_released'
  /** The policy store is not bound or could not be read. */
  | 'policy_store_unavailable'
  /** A sign-in method the tenant has switched on that the lite UI cannot offer. */
  | 'method_unsupported'
  /** A Flow assigned to the tenant uses a component the lite UI cannot drive. */
  | 'flow_component_unsupported'
  /** A Flow step names a screen that does not resolve. */
  | 'flow_screen_missing'
  /** A screen the lite UI would show has a block it cannot render. */
  | 'screen_block_unsupported'
  /** A screen offers a sign-in method the lite UI cannot, and the method is on. */
  | 'screen_method_unsupported'
  /** The account page has a block the lite UI cannot render. */
  | 'account_block_unsupported'
  /** An application sends its users to its own Login UI. */
  | 'client_login_ui_url'
  /** External sign-in returns to a different origin than the tenant's issuer. */
  | 'issuer_origin_mismatch'
  /**
   * The tenant's accounts are made asynchronously (routed account storage: a sign-up answers 202
   * and is resumed), which the lite sign-up does not resume yet.
   */
  | 'account_provisioning_async';

/**
 * One reason the lite UI cannot serve the tenant. `subject` names the thing (a method, a Flow, a
 * screen key, a client ID); `detail` the unsupported part (a component, a block, a method).
 * Both are identifiers from the tenant's configuration, never personal data.
 */
export interface LiteModeIssue {
  code: LiteModeIssueCode;
  subject?: string;
  detail?: string;
}

function hidden(field: ScreenField, enabledMethods: ReadonlySet<string>): boolean {
  const condition = field.display_condition;
  if (!condition) return false;
  if (condition.mode === 'hidden') return true;
  return (
    condition.mode === 'feature_enabled' &&
    typeof condition.feature === 'string' &&
    !enabledMethods.has(condition.feature)
  );
}

/**
 * The issues of one screen of a sign-in or sign-up Flow. `enabledMethods` holds the sign-in methods
 * the tenant has switched on (the screen-condition names: `passkey`, `mail_otp`, `totp`,
 * `external_idp`, `directory_password`, …): a block for a method that is off is never shown, so it
 * is allowed whatever it is.
 */
export function liteScreenIssues(
  screenKey: string,
  fields: readonly ScreenField[],
  enabledMethods: ReadonlySet<string>
): LiteModeIssue[] {
  const issues: LiteModeIssue[] = [];
  for (const field of fields) {
    if (hidden(field, enabledMethods)) continue;
    const blockType = field.block_type ?? 'identity_field';
    if (!LITE_SCREEN_BLOCK_TYPES.has(blockType)) {
      issues.push({ code: 'screen_block_unsupported', subject: screenKey, detail: blockType });
      continue;
    }
    if (blockType !== 'auth_widget') continue;
    const method = typeof field.auth_method === 'string' ? field.auth_method.trim() : '';
    if (LITE_AUTH_METHODS.has(method)) continue;
    if (method && !enabledMethods.has(method)) continue;
    issues.push({
      code: 'screen_method_unsupported',
      subject: screenKey,
      detail: method || 'none',
    });
  }
  return issues;
}

/** The issues of an account page's screen. */
export function liteAccountScreenIssues(
  screenKey: string,
  fields: readonly ScreenField[]
): LiteModeIssue[] {
  const issues: LiteModeIssue[] = [];
  for (const field of fields) {
    if (field.display_condition?.mode === 'hidden') continue;
    const blockType = field.block_type ?? 'identity_field';
    if (!LITE_ACCOUNT_BLOCK_TYPES.has(blockType)) {
      issues.push({ code: 'account_block_unsupported', subject: screenKey, detail: blockType });
    }
  }
  return issues;
}

/** The components of a published Flow the lite UI cannot drive (`subject`: the Flow's ID). */
export function liteFlowComponentIssues(
  flowId: string,
  steps: ReadonlyArray<{ component?: unknown }>
): LiteModeIssue[] {
  const issues: LiteModeIssue[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    const component = typeof step.component === 'string' ? step.component : 'unknown';
    if (LITE_FLOW_COMPONENTS.has(component) || seen.has(component)) continue;
    seen.add(component);
    issues.push({ code: 'flow_component_unsupported', subject: flowId, detail: component });
  }
  return issues;
}

/** Issues in a stable order, each once. */
export function normalizeLiteModeIssues(issues: readonly LiteModeIssue[]): LiteModeIssue[] {
  const unique = new Map<string, LiteModeIssue>();
  for (const issue of issues) {
    const key = `${issue.code}\u0000${issue.subject ?? ''}\u0000${issue.detail ?? ''}`;
    if (!unique.has(key)) unique.set(key, issue);
  }
  return [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}
