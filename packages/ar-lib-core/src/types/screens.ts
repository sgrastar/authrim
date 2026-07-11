export type ScreenKind =
  | 'registration'
  | 'profile_completion'
  | 'login'
  | 'consent'
  | 'code_input'
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
  | 'layout_row';

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
