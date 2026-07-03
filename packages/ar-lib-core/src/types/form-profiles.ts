export type FormProfileKind = 'registration' | 'profile_completion' | 'login' | 'consent' | 'custom';
export type FormProfileBlockType =
  | 'identity_field'
  | 'auth_widget'
  | 'consent_widget'
  | 'heading'
  | 'text'
  | 'security_verification'
  | 'divider'
  | 'layout_row';

export type FormProfileValueType = 'text' | 'boolean';
export type FormProfileCanvasLayout = 'narrow' | 'wide';

export interface FormProfileSettings {
  canvas_layout?: FormProfileCanvasLayout;
}

export interface FormProfileField {
  field: string;
  label: string;
  required: boolean;
  block_type?: FormProfileBlockType;
  block_id?: string;
  value_type?: FormProfileValueType | null;
  auth_method?: string | null;
  text?: string | null;
  help_text?: string | null;
  placeholder?: string | null;
  layout_columns?: number | null;
  layout_column?: number | null;
  order?: number;
}

export interface FormProfileLocalization {
  display_name?: string;
  description?: string;
  fields?: Record<string, Partial<Pick<FormProfileField, 'label' | 'help_text' | 'placeholder'>>>;
}

export interface FormProfile {
  id: string;
  tenant_id: string;
  profile_key: string;
  display_name: string;
  description?: string | null;
  form_kind: FormProfileKind;
  fields_json: string | FormProfileField[];
  localizations_json?: string | Record<string, FormProfileLocalization> | null;
  settings_json?: string | FormProfileSettings | null;
  is_active: number | boolean;
  is_system: number | boolean;
  created_at: number;
  updated_at: number;
}

export interface FormProfileResponse extends Omit<
  FormProfile,
  'fields_json' | 'localizations_json' | 'settings_json'
> {
  fields: FormProfileField[];
  localizations: Record<string, FormProfileLocalization>;
  settings: FormProfileSettings;
}
