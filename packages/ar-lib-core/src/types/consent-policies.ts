export type ConsentPolicyRequirement = 'required' | 'optional' | 'hidden';
export type ConsentPolicyVersionMode = 'current' | 'fixed' | 'minimum';
export type ConsentPolicyCheckboxMode = 'none' | 'required' | 'optional';
export type ConsentPolicyAssignmentType = 'registration' | 'login' | 'oidc_client' | 'saml_sp';
export type ClientTrustPolicyTargetType = 'oidc_client' | 'saml_sp';
export type SignInConfirmationMode = 'disabled' | 'first_time' | 'every_time';
export type ConsentPolicyItemBindingType =
  | 'subject'
  | 'scope'
  | 'claim'
  | 'saml_attribute'
  | 'destination_field_set'
  | 'identity_schema'
  | 'destination_field_mapping_set'
  | 'user_decision';

export interface ConsentPolicy {
  id: string;
  tenant_id: string;
  name: string;
  display_name: string;
  description?: string | null;
  is_active: number | boolean;
  created_at: number;
  updated_at: number;
}

export interface ConsentPolicyItem {
  id: string;
  tenant_id: string;
  policy_id: string;
  statement_id: string;
  requirement: ConsentPolicyRequirement;
  version_mode: ConsentPolicyVersionMode;
  version_id?: string | null;
  min_version?: string | null;
  checkbox_mode: ConsentPolicyCheckboxMode;
  checkbox_default_checked: number | boolean;
  binding_type?: ConsentPolicyItemBindingType | null;
  binding_value?: string | null;
  evidence_profile?: string | null;
  language_fallback?: string | null;
  display_order: number;
  created_at: number;
  updated_at: number;
}

export interface ConsentPolicyAssignment {
  id: string;
  tenant_id: string;
  assignment_type: ConsentPolicyAssignmentType;
  target_id: string;
  policy_id: string;
  created_at: number;
  updated_at: number;
}

export interface ClientTrustPolicy {
  id: string;
  tenant_id: string;
  name: string;
  display_name: string;
  description?: string | null;
  target_type: ClientTrustPolicyTargetType;
  target_id: string;
  first_party: number | boolean;
  trusted: number | boolean;
  skip_authorization_consent: number | boolean;
  is_active: number | boolean;
  created_at: number;
  updated_at: number;
}

export interface SignInConfirmationPolicy {
  id: string;
  tenant_id: string;
  name: string;
  display_name: string;
  description?: string | null;
  trigger_type: 'login';
  mode: SignInConfirmationMode;
  remember_duration_days: number;
  show_application_context: number | boolean;
  show_tenant_context: number | boolean;
  is_active: number | boolean;
  created_at: number;
  updated_at: number;
}
