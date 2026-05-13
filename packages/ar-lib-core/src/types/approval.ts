/**
 * Approval / Elevation Governance Types
 *
 * Shared domain types for Phase 7/8 approval workflows, mixed approvals,
 * delegated support access, and downstream elevation grants.
 *
 * Public wire compatibility note:
 * - Phase 1 delegated mutation surfaces may still expose `reference_id: string`
 * - The canonical storage/governance model uses StructuredReference
 * - Bridge layers are responsible for converting between the two
 */

export type ApprovalRequestStatus =
  | 'pending'
  | 'partially_approved'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'cancelled';

export type ApprovalDecisionStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export type ApprovalApproverSide = 'admin_operator' | 'customer_data_owner' | 'guardian_delegate';

export type ApprovalApproverSubjectType =
  | 'admin_user'
  | 'end_user'
  | 'customer_delegate'
  | 'service_principal';

export type ApprovalTargetSubjectType =
  | 'user'
  | 'artifact'
  | 'service_resource'
  | 'tenant_resource';

export type ApprovalReuseScope = 'request' | 'case';

export type ApprovalRedactionLevel = 'summary_only' | 'masked' | 'raw';

export type ApprovalTransportMethod =
  | 'ciba'
  | 'passkey'
  | 'portal_confirm'
  | 'email_otp'
  | 'sms_otp'
  | 'reauth';

export type ApprovalNotificationAction = 'initial' | 'resend' | 'remind';

export type ElevationGrantStatus = 'active' | 'expired' | 'revoked';

export type UserApprovalRelationType =
  | 'guardian'
  | 'parental_delegate'
  | 'legal_representative'
  | 'care_delegate'
  | string;

export interface StructuredReference {
  system: string;
  id: string;
  url?: string | null;
}

export interface ApprovalCompletionArtifact {
  artifact_id: string;
  tenant_id: string;
  request_id: string;
  approval_id: string;
  step_key: string;
  investigation_id: string;
  request_surface: string;
  requested_action: string;
  target_subject_type: ApprovalTargetSubjectType;
  target_subject_id: string;
  requester_subject_type: ApprovalApproverSubjectType;
  requester_subject_id: string;
  approver_side: ApprovalApproverSide;
  approver_subject_type: ApprovalApproverSubjectType;
  approver_subject_id: string | null;
  relation_type: UserApprovalRelationType | null;
  relation_source: string | null;
  method: ApprovalTransportMethod;
  transport_channel: string | null;
  redaction_level: ApprovalRedactionLevel;
  policy_preset: string;
  reuse_scope: ApprovalReuseScope;
  partial_access_allowed: boolean;
  reference: StructuredReference | null;
  ticket_reference: StructuredReference | null;
  expires_at: number;
  created_at: number;
  consumed: boolean;
}

export interface ApprovalDecisionReceipt {
  receipt_id: string;
  artifact_id: string;
  tenant_id: string;
  request_id: string;
  approval_id: string;
  step_key: string;
  investigation_id: string;
  request_surface: string;
  requested_action: string;
  target_subject_type: ApprovalTargetSubjectType;
  target_subject_id: string;
  requester_subject_type: ApprovalApproverSubjectType;
  requester_subject_id: string;
  approver_side: ApprovalApproverSide;
  approver_subject_type: ApprovalApproverSubjectType;
  approver_subject_id: string | null;
  relation_type: UserApprovalRelationType | null;
  relation_source: string | null;
  method: ApprovalTransportMethod;
  transport_channel: string | null;
  redaction_level: ApprovalRedactionLevel;
  request_status: ApprovalRequestStatus;
  decision: ApprovalDecisionStatus;
  grant_ids: string[];
  reference: StructuredReference | null;
  ticket_reference: StructuredReference | null;
  completed_at: number;
  expires_at: number;
  created_at: number;
}

export type ApprovalScopePrimitive = string | number | boolean | null;

export type ApprovalScopeJson =
  | ApprovalScopePrimitive
  | ApprovalScopeJson[]
  | { [key: string]: ApprovalScopeJson | undefined };

export interface ApprovalScopeDescriptor {
  version?: 1;
  surface: string;
  action: string;
  tenant_id: string;
  resource_class: string;
  resource_ids?: string[];
  detail_classes?: string[];
  dataset?: string | null;
  audience?: string | null;
  investigation_id?: string | null;
  redaction_level?: ApprovalRedactionLevel;
  attributes?: Record<string, ApprovalScopeJson | undefined>;
}

export interface ApprovalRequest {
  id: string;
  public_request_id: string;
  tenant_id: string;
  investigation_id: string;
  requester_subject_type: ApprovalApproverSubjectType;
  requester_subject_id: string;
  target_subject_type: ApprovalTargetSubjectType;
  target_subject_id: string;
  request_surface: string;
  requested_action: string;
  redaction_level: ApprovalRedactionLevel;
  status: ApprovalRequestStatus;
  scope_canonical: string;
  scope_json: ApprovalScopeDescriptor;
  reason_code: string;
  reason_note: string | null;
  reference: StructuredReference | null;
  ticket_reference: StructuredReference | null;
  reuse_scope: ApprovalReuseScope;
  policy_preset: string;
  partial_access_allowed: boolean;
  requested_at: number;
  expires_at: number;
  decided_at: number | null;
  detail_object_catalog_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ApprovalRequestCreateInput {
  tenant_id?: string;
  public_request_id?: string;
  investigation_id: string;
  requester_subject_type: ApprovalApproverSubjectType;
  requester_subject_id: string;
  target_subject_type: ApprovalTargetSubjectType;
  target_subject_id: string;
  request_surface: string;
  requested_action: string;
  redaction_level?: ApprovalRedactionLevel;
  status?: ApprovalRequestStatus;
  scope_json: ApprovalScopeDescriptor;
  scope_canonical: string;
  reason_code: string;
  reason_note?: string | null;
  reference?: StructuredReference | null;
  ticket_reference?: StructuredReference | null;
  reuse_scope?: ApprovalReuseScope;
  policy_preset: string;
  partial_access_allowed?: boolean;
  requested_at?: number;
  expires_at: number;
  decided_at?: number | null;
  detail_object_catalog_id?: string | null;
}

export interface ApprovalRequestApproval {
  id: string;
  approval_request_id: string;
  step_key: string;
  side: ApprovalApproverSide;
  subject_type: ApprovalApproverSubjectType;
  subject_id: string | null;
  relation_type: UserApprovalRelationType | null;
  relation_source: string | null;
  status: ApprovalDecisionStatus;
  method: ApprovalTransportMethod | null;
  transport_channel: string | null;
  reason_code: string | null;
  reason_note: string | null;
  last_notification_action: ApprovalNotificationAction | null;
  last_notified_at: number | null;
  notification_count: number;
  requested_at: number;
  decided_at: number | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

export interface ApprovalRequestApprovalCreateInput {
  approval_request_id: string;
  step_key: string;
  side: ApprovalApproverSide;
  subject_type: ApprovalApproverSubjectType;
  subject_id?: string | null;
  relation_type?: UserApprovalRelationType | null;
  relation_source?: string | null;
  status?: ApprovalDecisionStatus;
  method?: ApprovalTransportMethod | null;
  transport_channel?: string | null;
  reason_code?: string | null;
  reason_note?: string | null;
  last_notification_action?: ApprovalNotificationAction | null;
  last_notified_at?: number | null;
  notification_count?: number;
  requested_at?: number;
  decided_at?: number | null;
  expires_at: number;
}

export interface ApprovalRequestApprovalUpdateInput {
  status?: ApprovalDecisionStatus;
  subject_id?: string | null;
  method?: ApprovalTransportMethod | null;
  transport_channel?: string | null;
  reason_code?: string | null;
  reason_note?: string | null;
  last_notification_action?: ApprovalNotificationAction | null;
  last_notified_at?: number | null;
  notification_count?: number;
  decided_at?: number | null;
  expires_at?: number;
}

export interface ElevationGrant {
  id: string;
  public_grant_id: string;
  approval_request_id: string;
  tenant_id: string;
  status: ElevationGrantStatus;
  target_audience: string;
  resource_class: string;
  redaction_level: ApprovalRedactionLevel;
  scope_canonical: string;
  scope_json: ApprovalScopeDescriptor;
  authorization_details_json: Record<string, unknown> | null;
  requester_subject_type: ApprovalApproverSubjectType;
  requester_subject_id: string;
  actor_subject_type: ApprovalApproverSubjectType;
  actor_subject_id: string;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoke_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface ElevationGrantCreateInput {
  approval_request_id: string;
  tenant_id: string;
  public_grant_id?: string;
  status?: ElevationGrantStatus;
  target_audience: string;
  resource_class: string;
  redaction_level: ApprovalRedactionLevel;
  scope_canonical: string;
  scope_json: ApprovalScopeDescriptor;
  authorization_details_json?: Record<string, unknown> | null;
  requester_subject_type: ApprovalApproverSubjectType;
  requester_subject_id: string;
  actor_subject_type: ApprovalApproverSubjectType;
  actor_subject_id: string;
  issued_at?: number;
  expires_at: number;
  revoked_at?: number | null;
  revoke_reason?: string | null;
}
