export type ScreenKind =
  | 'registration'
  | 'profile_completion'
  | 'login'
  | 'consent'
  | 'code_input'
  | 'account'
  | 'custom';
export type ScreenBlockType =
  | 'identity_field'
  | 'auth_widget'
  | 'guest_login_widget'
  | 'code_input_widget'
  | 'consent_widget'
  | 'heading'
  | 'text'
  | 'security_verification'
  | 'divider'
  | 'layout_row'
  | 'link'
  /** A choice from a list (a drop-down). */
  | 'select'
  /** A choice from a list, every option on screen. */
  | 'radio'
  /** A yes/no answer. */
  | 'checkbox'
  | 'account_upgrade_widget'
  | 'account_profile_widget'
  | 'account_device_list_widget'
  | 'account_session_widget'
  | 'account_passkey_widget'
  | 'account_totp_widget'
  | 'account_consent_widget'
  | 'account_activity_widget'
  | 'account_social_account_widget'
  | 'account_launcher_widget';

/**
 * The legacy way to ask a yes/no question: an `identity_field` with `value_type: 'boolean'`. Saved
 * screens are rewritten to a `checkbox` block; the run time still reads both.
 */
export type ScreenValueType = 'text' | 'boolean';

/** Where the answer to a part that is not stored to the profile goes (one or both). */
export type ScreenAnswerTarget = 'flow_event' | 'record';
export const SCREEN_ANSWER_TARGETS: readonly ScreenAnswerTarget[] = ['flow_event', 'record'];

/** A choice of a `select` or `radio` part that is not stored to the profile. */
export interface ScreenFieldOption {
  value: string;
  label: string;
}

/** The input parts: what a person answers on a screen. */
export const SCREEN_INPUT_BLOCK_TYPES = ['identity_field', 'select', 'radio', 'checkbox'] as const;
/** The input parts whose answers are a choice from a list. */
export const SCREEN_CHOICE_BLOCK_TYPES = ['select', 'radio'] as const;
export const MAX_SCREEN_FIELD_OPTIONS = 100;
export const MAX_SCREEN_OPTION_VALUE_LENGTH = 128;
export const MAX_SCREEN_OPTION_LABEL_LENGTH = 100;
export type ScreenCanvasLayout = 'narrow' | 'wide';
export type ScreenHumanVerificationTiming = 'initial' | 'submit';
export type ScreenDisplayConditionMode = 'always' | 'feature_enabled' | 'hidden';
export type ScreenDisplayConditionFeature =
  | 'passkey'
  | 'mail_otp'
  | 'mail_otp_totp'
  | 'totp'
  | 'external_idp'
  | 'directory_password';

export interface ScreenDisplayCondition {
  mode: ScreenDisplayConditionMode;
  feature?: ScreenDisplayConditionFeature | null;
}

export interface ScreenSettings {
  canvas_layout?: ScreenCanvasLayout;
  base_preset_key?: string;
  base_preset_version?: number;
}

export interface ScreenField {
  field: string;
  label: string;
  required: boolean;
  block_type?: ScreenBlockType;
  block_id?: string;
  value_type?: ScreenValueType | null;
  auth_method?: string | null;
  code_input_mode?: 'auto' | 'mail_otp' | 'totp' | null;
  external_idp_show_action_text?: boolean | null;
  text?: string | null;
  help_text?: string | null;
  placeholder?: string | null;
  href?: string | null;
  human_verification_timing?: ScreenHumanVerificationTiming | null;
  display_condition?: ScreenDisplayCondition | null;
  layout_columns?: number | null;
  layout_column?: number | null;
  order?: number;
  /** Input parts: whether the label is shown (a hidden one is still read out). Default true. */
  show_label?: boolean;
  /**
   * Input parts: whether the answer is the user's attribute named by `field` (default true). When
   * false, `field` is the answer's own key, and `answer_targets` says where the answer goes.
   */
  store_to_profile?: boolean;
  /** Only when `store_to_profile` is false: one or both. */
  answer_targets?: ScreenAnswerTarget[];
  /**
   * Only for a `select` or `radio` part not stored to the profile. A part stored to the profile
   * takes its choices from the attribute's Identity Schema at run time (none are saved here).
   */
  options?: ScreenFieldOption[];
}

export interface ScreenLocalization {
  display_name?: string;
  description?: string;
  fields?: Record<
    string,
    Partial<Pick<ScreenField, 'label' | 'text' | 'help_text' | 'placeholder'>> & {
      /** The labels of a part's own options (not stored to the profile), by option value. */
      options?: Record<string, string>;
    }
  >;
}

export interface Screen {
  id: string;
  tenant_id: string;
  screen_key: string;
  display_name: string;
  description?: string | null;
  screen_kind: ScreenKind;
  fields_json: string | ScreenField[];
  localizations_json?: string | Record<string, ScreenLocalization> | null;
  settings_json?: string | ScreenSettings | null;
  is_active: number | boolean;
  is_system: number | boolean;
  /** Optimistic-concurrency counter: a change must name it (If-Match), and raises it by one. */
  version?: number;
  created_at: number;
  updated_at: number;
}

export interface ScreenResponse extends Omit<
  Screen,
  'fields_json' | 'localizations_json' | 'settings_json'
> {
  fields: ScreenField[];
  localizations: Record<string, ScreenLocalization>;
  settings: ScreenSettings;
  version: number;
}

/** Where a screen is used: a flow node that shows it, or an account page that places it. */
export type ScreenUsage =
  | {
      kind: 'flow';
      flow_id: string;
      flow_name: string;
      node_id: string | null;
      node_title: string | null;
      /**
       * In the flow's draft, in the version it has published, or in an older published version
       * that sign-ins in progress still run.
       */
      stage: 'draft' | 'published' | 'running';
    }
  | { kind: 'account_page'; page_id: string | null; page_name: string };

export type AccountPagePlacementWidth = 'full' | 'half';

export type AccountPageVisibilityCondition =
  | 'always'
  | 'hidden'
  | 'passkey_enabled'
  | 'totp_enabled'
  | 'external_idp_enabled'
  | 'consent_records_available'
  | 'multiple_sessions';

export interface AccountPageScreenPlacement {
  id: string;
  screen_key: string;
  width: AccountPagePlacementWidth;
  enabled: boolean;
  condition: AccountPageVisibilityCondition;
  show_for_guests: boolean;
}

export interface AccountPageLocalization {
  title?: string;
  description?: string;
}

export interface AccountPageDefinition {
  schema_version: 'authrim.account_page.v1';
  base_preset_id?: 'authrim-default';
  base_preset_version?: number;
  title?: string;
  description?: string;
  localizations?: Record<string, AccountPageLocalization>;
  screens: AccountPageScreenPlacement[];
}

export interface PublishedAccountPageDefinition extends AccountPageDefinition {
  resolved_at: string;
  screen_snapshots: Record<string, ScreenResponse>;
}

export interface AccountPageRecord {
  id: string;
  name: string;
  base_preset_id: 'authrim-default';
  base_preset_version: number;
  draft: AccountPageDefinition;
  published?: PublishedAccountPageDefinition;
  rollback?: PublishedAccountPageDefinition;
  published_version: number;
  published_at: string;
  created_at: number;
  updated_at: number;
}

export interface AccountPagesDocument {
  schema_version: 'authrim.account_pages.v1';
  default_page_id: string | null;
  pages: AccountPageRecord[];
}

export const ACCOUNT_PAGE_PRESET_VERSION = 3;

export const DEFAULT_ACCOUNT_PAGE_DEFINITION: AccountPageDefinition = {
  schema_version: 'authrim.account_page.v1',
  base_preset_id: 'authrim-default',
  base_preset_version: ACCOUNT_PAGE_PRESET_VERSION,
  screens: [
    {
      id: 'overview',
      screen_key: 'account_overview',
      width: 'full',
      enabled: true,
      condition: 'always',
      show_for_guests: true,
    },
    {
      id: 'launchers',
      screen_key: 'account_launchers',
      width: 'full',
      enabled: true,
      condition: 'always',
      show_for_guests: true,
    },
    {
      id: 'profile',
      screen_key: 'account_profile',
      width: 'half',
      enabled: true,
      condition: 'always',
      show_for_guests: true,
    },
    {
      id: 'devices',
      screen_key: 'account_devices',
      width: 'half',
      enabled: true,
      condition: 'always',
      show_for_guests: true,
    },
    {
      id: 'sessions',
      screen_key: 'account_sessions',
      width: 'half',
      enabled: true,
      condition: 'always',
      show_for_guests: true,
    },
    {
      id: 'passkeys',
      screen_key: 'account_passkeys',
      width: 'half',
      enabled: true,
      condition: 'passkey_enabled',
      show_for_guests: true,
    },
    {
      id: 'totp',
      screen_key: 'account_totp',
      width: 'full',
      enabled: true,
      condition: 'totp_enabled',
      show_for_guests: true,
    },
    {
      id: 'consents',
      screen_key: 'account_consents',
      width: 'full',
      enabled: true,
      condition: 'always',
      show_for_guests: true,
    },
    {
      id: 'activity',
      screen_key: 'account_activity',
      width: 'full',
      enabled: true,
      condition: 'always',
      show_for_guests: true,
    },
  ],
};
