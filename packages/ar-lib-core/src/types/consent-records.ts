export type ConsentRecordProtocol = 'oidc' | 'saml' | 'document' | 'custom';
export type ConsentRecordKind =
  | 'terms'
  | 'privacy'
  | 'attribute_release'
  | 'scope_claim_release'
  | 'form_confirmation'
  | 'custom';
export type ConsentRecordRecipientType = 'oidc_client' | 'saml_sp' | 'tenant' | 'external_party';
export type ConsentRecordBindingType =
  | 'subject'
  | 'identity_schema'
  | 'destination_field_mapping_set'
  | 'user_decision';
export type ConsentRecordResourceType =
  | 'userinfo'
  | 'id_token'
  | 'saml_attributes'
  | 'document'
  | 'custom';
export type ConsentRecordDecision = 'accepted' | 'rejected' | 'once' | 'always' | 'selected';
export type ConsentRecordLifecycleStatus = 'active' | 'revoked' | 'expired' | 'superseded';

export interface ConsentRecord {
  id: string;
  tenant_id: string;
  subject_user_id: string;
  actor_user_id?: string | null;
  protocol: ConsentRecordProtocol;
  consent_kind: ConsentRecordKind;
  client_id?: string | null;
  saml_sp_id?: string | null;
  recipient_type?: ConsentRecordRecipientType | null;
  recipient_id?: string | null;
  binding_type: ConsentRecordBindingType;
  binding_key?: string | null;
  resource_type?: ConsentRecordResourceType | null;
  resource_id?: string | null;
  purpose_key?: string | null;
  statement_id: string;
  statement_version: string;
  policy_id?: string | null;
  flow_id?: string | null;
  flow_version_id?: string | null;
  flow_node_id?: string | null;
  decision: ConsentRecordDecision;
  selected_value?: string | null;
  selected_options_json?: string | null;
  released_scopes_json?: string | null;
  released_claims_json?: string | null;
  released_attributes_json?: string | null;
  status: ConsentRecordLifecycleStatus;
  expires_at?: number | null;
  revoked_at?: number | null;
  evidence_json?: string | null;
  created_at: number;
  updated_at: number;
}
