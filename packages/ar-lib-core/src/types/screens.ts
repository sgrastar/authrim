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
  | 'code_input_widget'
  | 'consent_widget'
  | 'heading'
  | 'text'
  | 'security_verification'
  | 'divider'
  | 'layout_row'
  | 'link'
  | 'account_profile_widget'
  | 'account_device_list_widget'
  | 'account_session_widget'
  | 'account_passkey_widget'
  | 'account_totp_widget'
  | 'account_consent_widget'
  | 'account_activity_widget'
  | 'account_social_account_widget'
  | 'account_launcher_widget';

export type ScreenValueType = 'text' | 'boolean';
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
}

export interface ScreenLocalization {
  display_name?: string;
  description?: string;
  fields?: Record<
    string,
    Partial<Pick<ScreenField, 'label' | 'text' | 'help_text' | 'placeholder'>>
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
}

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

export const ACCOUNT_PAGE_PRESET_VERSION = 2;

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
    },
    {
      id: 'launchers',
      screen_key: 'account_launchers',
      width: 'full',
      enabled: true,
      condition: 'always',
    },
    {
      id: 'profile',
      screen_key: 'account_profile',
      width: 'half',
      enabled: true,
      condition: 'always',
    },
    {
      id: 'devices',
      screen_key: 'account_devices',
      width: 'half',
      enabled: true,
      condition: 'always',
    },
    {
      id: 'sessions',
      screen_key: 'account_sessions',
      width: 'half',
      enabled: true,
      condition: 'always',
    },
    {
      id: 'passkeys',
      screen_key: 'account_passkeys',
      width: 'half',
      enabled: true,
      condition: 'passkey_enabled',
    },
    {
      id: 'totp',
      screen_key: 'account_totp',
      width: 'full',
      enabled: true,
      condition: 'totp_enabled',
    },
    {
      id: 'consents',
      screen_key: 'account_consents',
      width: 'full',
      enabled: true,
      condition: 'always',
    },
    {
      id: 'activity',
      screen_key: 'account_activity',
      width: 'full',
      enabled: true,
      condition: 'always',
    },
  ],
};
