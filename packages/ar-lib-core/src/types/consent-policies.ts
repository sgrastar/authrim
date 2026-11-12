export type ClientTrustPolicyTargetType = 'oidc_client' | 'saml_sp';
export type SignInConfirmationMode = 'disabled' | 'first_time' | 'every_time';

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
