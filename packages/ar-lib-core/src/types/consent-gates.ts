export const CONSENT_GATE_KINDS = [
  'legal_document',
  'oidc_authorization',
  'saml_attribute_release',
] as const;

export type ConsentGateKind = (typeof CONSENT_GATE_KINDS)[number];
export type ConsentGateProtocol = 'direct' | 'oidc' | 'saml';
export type ConsentGateDecisionAction = 'skip' | 'challenge' | 'deny' | 'protocol_error';
export type ConsentGateItemAcceptanceStatus = 'accepted' | 'pending';
export type ConsentGateRepeatMode = 'once' | 'every_time' | 'until_attributes_change';
export type ConsentGateCurrentState = 'granted' | 'denied' | 'revoked' | 'expired' | null;
export type ConsentGateProtocolErrorCode = 'invalid_request' | 'consent_required';
export type ConsentGatePolicyResolution = 'fixed' | 'target_binding';
export type ConsentGateTargetType = 'tenant' | 'oidc_client' | 'saml_sp';
export type ConsentGateDecisionReceiptState = 'ready' | 'consumed' | 'denied' | 'expired';

export interface ConsentGateNodeConfig {
  consent_gate_kind?: ConsentGateKind;
  policy_resolution?: ConsentGatePolicyResolution;
  consent_policy_ref?: string;
  fallback_policy_ref?: string;
  policy_required?: boolean;
}

export interface ConsentGateDecisionItem {
  id: string;
  required: boolean;
  acceptanceStatus: ConsentGateItemAcceptanceStatus;
  actionRequired: boolean;
}

export interface ConsentGateReleaseState {
  mode: ConsentGateRepeatMode;
  currentSetHash: string;
  existingState: ConsentGateCurrentState;
  existingSetHash?: string | null;
}

export interface ConsentGateDecisionInput {
  gateKind: ConsentGateKind;
  protocol: ConsentGateProtocol;
  policyResolved: boolean;
  policyRequired: boolean;
  policyOutcome?: 'allow' | 'deny';
  releaseAvailable?: boolean;
  items: ConsentGateDecisionItem[];
  release?: ConsentGateReleaseState | null;
  oidcPrompt?: string | null;
}

export interface ConsentGateProtocolError {
  error: ConsentGateProtocolErrorCode;
  description: string;
}

export interface OIDCConsentReleaseDecision {
  protocol: 'oidc';
  requested_scopes: string[];
  selected_scopes: string[];
  required_scopes: string[];
  requested_claims: string[];
  selected_claims: string[];
  required_claims: string[];
}

export interface SAMLConsentReleaseDecision {
  protocol: 'saml';
  requested_attributes: string[];
  selected_attributes: string[];
  required_attributes: string[];
  consent_mode: ConsentGateRepeatMode;
}

export type ConsentGateReleaseDecision = OIDCConsentReleaseDecision | SAMLConsentReleaseDecision;

export interface ConsentGateDecisionResult {
  action: ConsentGateDecisionAction;
  gateKind: ConsentGateKind;
  reasonCodes: string[];
  forceInteraction: boolean;
  pendingItemIds: string[];
  protocolError?: ConsentGateProtocolError;
  release?: ConsentGateReleaseDecision;
}

export interface RuntimeConsentPolicyItemStatus {
  statement_id: string;
  version: string;
  acceptance_status: ConsentGateItemAcceptanceStatus;
  action_required: boolean;
  accepted_at: number | null;
  accepted_record_id: string | null;
}

export interface RuntimeConsentGateItem extends RuntimeConsentPolicyItemStatus {
  [key: string]: unknown;
}

export interface RuntimeConsentGateContent {
  gate_kind: ConsentGateKind;
  policy_id: string;
  policy_satisfied: boolean;
  force_interaction: boolean;
  release_set_hash: string | null;
  release_mode?: ConsentGateRepeatMode | null;
  release_current_state?: ConsentGateCurrentState;
  release_existing_set_hash?: string | null;
  items: RuntimeConsentGateItem[];
}

/**
 * Server-side receipt that binds a Flow decision to one protocol continuation.
 * Only the opaque `id` is exposed to the browser.
 */
export interface ConsentGateDecisionReceipt {
  id: string;
  tenant_id: string;
  interaction_id: string;
  flow_id: string;
  flow_version_id: string;
  flow_node_id: string;
  gate_kind: ConsentGateKind;
  subject_user_id: string;
  target_type: ConsentGateTargetType;
  target_id: string | null;
  policy_id: string | null;
  protocol_request_id: string | null;
  statement_version_set_hash: string | null;
  release_set_hash: string | null;
  decision: ConsentGateDecisionResult;
  evidence_record_ids: string[];
  state: ConsentGateDecisionReceiptState;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
  updated_at: number;
}
