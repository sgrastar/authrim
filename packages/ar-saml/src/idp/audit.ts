import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { createAuditLog, scheduleAuditLog } from '@authrim/ar-lib-core';
import type { MissingRequiredSAMLAttribute } from './attributes';

export const SAML_POLICY_FAILED_AUDIT_EVENT = 'saml.policy.failed';

export type SAMLPolicyFailureKind =
  | 'required_attribute_missing'
  | 'attribute_release_consent_required'
  | 'identity_mapping_failed'
  | 'authn_request_signature_required'
  | 'authn_request_certificate_missing'
  | 'authn_request_unsupported_signature_algorithm'
  | 'authn_request_unsupported_digest_algorithm'
  | 'authn_request_incomplete_redirect_signature'
  | 'authn_request_invalid_signature'
  | 'authn_request_invalid_acs_url'
  | 'authn_request_unsupported_response_binding'
  | 'authn_request_unsupported_authn_context'
  | 'authn_request_invalid_nameid_policy'
  | 'authn_request_no_passive'
  | 'logout_request_signature_required'
  | 'logout_request_certificate_missing'
  | 'logout_request_unsupported_signature_algorithm'
  | 'logout_request_unsupported_digest_algorithm'
  | 'logout_request_incomplete_redirect_signature'
  | 'logout_request_invalid_signature'
  | 'logout_request_invalid_nameid_format'
  | 'logout_request_invalid_nameid_qualifier'
  | 'logout_request_session_index_required'
  | 'logout_response_signature_required'
  | 'logout_response_certificate_missing'
  | 'logout_response_unsupported_signature_algorithm'
  | 'logout_response_unsupported_digest_algorithm'
  | 'logout_response_incomplete_redirect_signature'
  | 'logout_response_invalid_signature'
  | 'logout_response_invalid_in_response_to'
  | 'logout_response_invalid_destination'
  | 'logout_response_non_success_status';

export interface SAMLPolicyFailureAuditInput {
  tenantId: string;
  spEntityId: string;
  authnRequestId: string;
  failureKind: SAMLPolicyFailureKind;
  missingAttributes?: MissingRequiredSAMLAttribute[];
  policyDetails?: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
}

export function buildSAMLPolicyFailureAuditMetadata(
  input: Pick<
    SAMLPolicyFailureAuditInput,
    'failureKind' | 'spEntityId' | 'authnRequestId' | 'missingAttributes' | 'policyDetails'
  >
): string {
  return JSON.stringify({
    protocol: 'saml',
    failure_kind: input.failureKind,
    sp_entity_id: input.spEntityId,
    request_id: input.authnRequestId,
    ...(input.missingAttributes
      ? {
          missing_attributes: input.missingAttributes.map((attribute) => ({
            name: attribute.name,
            friendly_name: attribute.friendlyName,
            source: attribute.source,
            claim: attribute.claim,
          })),
        }
      : {}),
    ...(input.policyDetails ? { policy_details: input.policyDetails } : {}),
  });
}

export function scheduleSAMLPolicyFailureAudit(
  c: Context<{ Bindings: Env }>,
  input: Omit<SAMLPolicyFailureAuditInput, 'ipAddress' | 'userAgent'>
): void {
  const auditPromise = createAuditLog(c.env, {
    tenantId: input.tenantId,
    userId: 'saml-idp',
    action: SAML_POLICY_FAILED_AUDIT_EVENT,
    resource: 'saml_service_provider',
    resourceId: input.spEntityId,
    ipAddress: getRequestIp(c),
    userAgent: c.req.header('User-Agent') || 'unknown',
    metadata: buildSAMLPolicyFailureAuditMetadata({
      failureKind: input.failureKind,
      spEntityId: input.spEntityId,
      authnRequestId: input.authnRequestId,
      missingAttributes: input.missingAttributes,
      policyDetails: input.policyDetails,
    }),
    severity: 'warning',
  });

  scheduleAuditLog(c.executionCtx, auditPromise);
}

function getRequestIp(c: Context<{ Bindings: Env }>): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-Real-IP') ||
    'unknown'
  );
}
