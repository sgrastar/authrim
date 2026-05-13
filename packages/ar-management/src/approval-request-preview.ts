import type { Context } from 'hono';
import type {
  ApprovalApproverSubjectType,
  ApprovalRedactionLevel,
  ApprovalRequest,
  ApprovalRequestApproval,
  ApprovalScopeDescriptor,
  ApprovalScopeJson,
  ApprovalTransportMethod,
  Env,
  UserApprovalRelationType,
} from '@authrim/ar-lib-core';
import {
  canonicalizeApprovalScope,
  ensureDatabaseAdapter,
  generateInvestigationId,
  normalizeStructuredReference,
  resolveProductProtectedResourceAudience,
  resolveProductProtectedResourceDetailClasses,
} from '@authrim/ar-lib-core';
import { type ApprovalNotificationPolicySource } from './approval-notification-policy';
import { describeApprovalCompletionMethod } from './approval-completion-guidance';
import { resolveApprovalNotificationTransport } from './approval-notification-resolution';
import { getApprovalPresetExpiry, resolveApprovalEffectivePolicy } from './approval-policy-presets';

type AdminContext = Context<any, any, any>;

export class ApprovalStepResolutionError extends Error {}

export interface ApprovalRequestPreviewStepInput {
  step_key: string;
  side: 'admin_operator' | 'customer_data_owner' | 'guardian_delegate';
  subject_type: 'admin_user' | 'end_user' | 'customer_delegate' | 'service_principal';
  subject_id?: string;
  relation_type?: string;
  relation_source?: string;
  method?: ApprovalTransportMethod;
  transport_channel?: string;
  expires_at?: number;
}

export interface ApprovalRequestPreviewInput {
  investigation_id?: string;
  requester_subject_type?: 'admin_user' | 'end_user' | 'customer_delegate' | 'service_principal';
  requester_subject_id?: string;
  target_subject_type: 'user' | 'artifact' | 'service_resource' | 'tenant_resource';
  target_subject_id: string;
  request_surface: string;
  requested_action: string;
  resource_class: string;
  resource_ids?: string[];
  detail_classes?: string[];
  dataset?: string;
  audience?: string;
  redaction_level?: 'summary_only' | 'masked' | 'raw';
  attributes?: Record<string, unknown>;
  reason_code: string;
  reason_note?: string;
  reference_id?: string;
  reference?: {
    system: string;
    id: string;
    url?: string;
  };
  ticket_reference?: {
    system: string;
    id: string;
    url?: string;
  };
  policy_preset:
    | 'support_case_default'
    | 'technical_debug_default'
    | 'security_investigation_default'
    | 'guardian_support_default'
    | 'compliance_review_default';
  reuse_scope?: 'request' | 'case';
  partial_access_allowed?: boolean;
  expires_at?: number;
  approvals: ApprovalRequestPreviewStepInput[];
}

export interface ApprovalPreviewResolvedStep {
  step_key: string;
  side: ApprovalRequestPreviewStepInput['side'];
  subject_type: ApprovalRequestPreviewStepInput['subject_type'];
  subject_id: string | null;
  relation_type: string | null;
  relation_source: string | null;
  expires_at: number;
  method: ApprovalTransportMethod | null;
  transport_channel: string | null;
  acceptable_methods: ApprovalTransportMethod[];
  selection_source: ApprovalNotificationPolicySource;
  guidance_title: string | null;
  guidance_body: string | null;
  fallback_note: string | null;
  transport_resolution_error?: string;
}

export interface ApprovalPreviewResponse {
  request: {
    investigation_id: string;
    tenant_id: string;
    requester_subject_type: string;
    requester_subject_id: string;
    target_subject_type: string;
    target_subject_id: string;
    request_surface: string;
    requested_action: string;
    redaction_level: ApprovalRedactionLevel;
    reason_code: string;
    reason_note: string | null;
    reference: { system: string; id: string; url?: string | null } | null;
    ticket_reference: { system: string; id: string; url?: string | null } | null;
    policy_preset: ApprovalRequestPreviewInput['policy_preset'];
    reuse_scope: 'request' | 'case';
    partial_access_allowed: boolean;
    expires_at: number;
    scope_json: ApprovalScopeDescriptor;
    scope_canonical: string;
    resolved_policy: {
      preset: string;
      request_ttl_seconds: number | null;
      notification_cooldown_seconds: {
        remind: number;
        resend: number;
      };
    };
  };
  steps: ApprovalPreviewResolvedStep[];
}

const RELATIONSHIP_TO_APPROVAL_RELATION_TYPE: Record<string, UserApprovalRelationType> = {
  parent_child: 'parental_delegate',
  guardian: 'guardian',
  delegate: 'care_delegate',
};

export async function resolveApprovalSteps(
  c: AdminContext,
  request: ApprovalRequest,
  steps: ApprovalRequestPreviewStepInput[]
): Promise<ApprovalRequestPreviewStepInput[]> {
  const resolved: ApprovalRequestPreviewStepInput[] = [];

  for (const step of steps) {
    if (step.side === 'customer_data_owner' && !step.subject_id) {
      if (request.target_subject_type !== 'user') {
        throw new ApprovalStepResolutionError(
          'customer_data_owner auto resolution requires a user target subject'
        );
      }

      resolved.push({
        ...step,
        subject_type: 'end_user',
        subject_id: request.target_subject_id,
        relation_source: step.relation_source ?? 'target_subject',
      });
      continue;
    }

    if (step.side === 'guardian_delegate' && !step.subject_id) {
      if (request.target_subject_type !== 'user') {
        throw new ApprovalStepResolutionError(
          'guardian_delegate auto resolution requires a user target subject'
        );
      }

      const coreAdapter = ensureDatabaseAdapter(c.env.DB, 'admin-approvals-guardian-resolution');
      const relationships = await coreAdapter.query<{ relationship_type: string; from_id: string }>(
        `SELECT relationship_type, from_id
           FROM relationships
          WHERE tenant_id = ?
            AND to_type = 'subject'
            AND to_id = ?
            AND from_type = 'subject'
            AND relationship_type IN ('parent_child', 'guardian', 'delegate')
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at ASC`,
        [request.tenant_id, request.target_subject_id, Math.floor(Date.now() / 1000)]
      );

      if (relationships.length === 0) {
        throw new ApprovalStepResolutionError(
          'guardian_delegate auto resolution found no valid delegate relationships'
        );
      }

      relationships.forEach((relationship, index) => {
        resolved.push({
          ...step,
          step_key: relationships.length === 1 ? step.step_key : `${step.step_key}:${index + 1}`,
          subject_type: 'customer_delegate',
          subject_id: relationship.from_id,
          relation_type:
            step.relation_type ??
            RELATIONSHIP_TO_APPROVAL_RELATION_TYPE[relationship.relationship_type] ??
            'care_delegate',
          relation_source: step.relation_source ?? 'rebac_relation',
        });
      });
      continue;
    }

    resolved.push(step);
  }

  return resolved;
}

export function buildApprovalPreviewRequest(input: {
  tenantId: string;
  requesterSubjectType: ApprovalRequest['requester_subject_type'];
  requesterSubjectId: string;
  body: ApprovalRequestPreviewInput;
}): ApprovalPreviewResponse['request'] {
  const { tenantId, requesterSubjectType, requesterSubjectId, body } = input;
  const scope = canonicalizeApprovalScope({
    version: 1,
    surface: body.request_surface,
    action: body.requested_action,
    tenant_id: tenantId,
    resource_class: body.resource_class,
    resource_ids: body.resource_ids?.length ? body.resource_ids : [body.target_subject_id],
    detail_classes: resolveProductProtectedResourceDetailClasses({
      resourceClass: body.resource_class,
      requestedDetailClasses: body.detail_classes,
    }),
    dataset: body.dataset,
    audience:
      resolveProductProtectedResourceAudience({
        resourceClass: body.resource_class,
        requestedAudience: body.audience,
      }) ?? undefined,
    investigation_id: body.investigation_id ?? generateInvestigationId(),
    redaction_level: (body.redaction_level ?? 'masked') as ApprovalRedactionLevel,
    attributes: body.attributes as Record<string, ApprovalScopeJson | undefined> | undefined,
  });

  return {
    investigation_id: scope.normalized.investigation_id ?? generateInvestigationId(),
    tenant_id: tenantId,
    requester_subject_type: (body.requester_subject_type ??
      requesterSubjectType) as ApprovalApproverSubjectType,
    requester_subject_id: body.requester_subject_id ?? requesterSubjectId,
    target_subject_type: body.target_subject_type,
    target_subject_id: body.target_subject_id,
    request_surface: body.request_surface,
    requested_action: body.requested_action,
    redaction_level: (body.redaction_level ?? 'masked') as ApprovalRedactionLevel,
    reason_code: body.reason_code,
    reason_note: body.reason_note ?? null,
    reference:
      normalizeStructuredReference(body.reference ?? body.reference_id ?? null, {
        defaultSystem: 'external',
      }) ?? null,
    ticket_reference: normalizeStructuredReference(body.ticket_reference ?? null) ?? null,
    policy_preset: body.policy_preset,
    reuse_scope: body.reuse_scope ?? 'request',
    partial_access_allowed: body.partial_access_allowed ?? false,
    expires_at: body.expires_at ?? getApprovalPresetExpiry(body.policy_preset),
    scope_json: scope.normalized,
    scope_canonical: scope.canonical,
    resolved_policy: resolveApprovalEffectivePolicy(body.policy_preset),
  };
}

function buildSyntheticApprovalRequest(
  preview: ApprovalPreviewResponse['request']
): ApprovalRequest {
  const now = Date.now();
  return {
    id: 'preview',
    public_request_id: 'preview',
    tenant_id: preview.tenant_id,
    investigation_id: preview.investigation_id,
    requester_subject_type:
      preview.requester_subject_type as ApprovalRequest['requester_subject_type'],
    requester_subject_id: preview.requester_subject_id,
    target_subject_type: preview.target_subject_type as ApprovalRequest['target_subject_type'],
    target_subject_id: preview.target_subject_id,
    request_surface: preview.request_surface,
    requested_action: preview.requested_action,
    redaction_level: preview.redaction_level,
    status: 'pending',
    scope_json: preview.scope_json as ApprovalRequest['scope_json'],
    scope_canonical: preview.scope_canonical,
    reason_code: preview.reason_code,
    reason_note: preview.reason_note,
    reference: preview.reference,
    ticket_reference: preview.ticket_reference,
    policy_preset: preview.policy_preset,
    reuse_scope: preview.reuse_scope,
    partial_access_allowed: preview.partial_access_allowed,
    requested_at: now,
    expires_at: preview.expires_at,
    decided_at: null,
    created_at: now,
    updated_at: now,
    detail_object_catalog_id: null,
  };
}

export async function previewApprovalRequestResolution(
  c: AdminContext,
  input: {
    tenantId: string;
    requesterSubjectType: ApprovalRequest['requester_subject_type'];
    requesterSubjectId: string;
    body: ApprovalRequestPreviewInput;
  }
): Promise<ApprovalPreviewResponse> {
  const requestPreview = buildApprovalPreviewRequest(input);
  const syntheticRequest = buildSyntheticApprovalRequest(requestPreview);
  const resolvedSteps = await resolveApprovalSteps(c, syntheticRequest, input.body.approvals);

  const steps = await Promise.all(
    resolvedSteps.map(async (step) => {
      let transportChannel: string | null = null;
      let transportResolutionError: string | undefined;
      let completionGuide: ReturnType<typeof describeApprovalCompletionMethod> | null = null;
      let selectedMethod: ApprovalTransportMethod | null = step.method ?? null;
      let acceptableMethods: ApprovalTransportMethod[] = step.method ? [step.method] : [];
      let selectionSource: ApprovalNotificationPolicySource = step.method
        ? 'approval_step'
        : 'policy_default';
      try {
        const previewApproval: Pick<
          ApprovalRequestApproval,
          'side' | 'subject_type' | 'subject_id' | 'method' | 'transport_channel'
        > = {
          side: step.side,
          subject_type: step.subject_type,
          subject_id: step.subject_id ?? null,
          method: step.method ?? null,
          transport_channel: step.transport_channel ?? null,
        };
        const resolvedTransport = await resolveApprovalNotificationTransport(c, {
          request: syntheticRequest,
          approval: previewApproval,
          strictMethod: !!step.method,
        });
        selectedMethod = resolvedTransport.method;
        transportChannel = resolvedTransport.transportChannel;
        acceptableMethods = resolvedTransport.acceptableMethods;
        selectionSource = resolvedTransport.source;
        completionGuide = describeApprovalCompletionMethod({
          method: resolvedTransport.method,
          transportChannel,
          acceptableMethods: resolvedTransport.acceptableMethods,
        });
      } catch (error) {
        if (error instanceof Error) {
          transportResolutionError = error.message;
        } else {
          throw error;
        }
      }

      return {
        step_key: step.step_key,
        side: step.side,
        subject_type: step.subject_type,
        subject_id: step.subject_id ?? null,
        relation_type: step.relation_type ?? null,
        relation_source: step.relation_source ?? null,
        expires_at: step.expires_at ?? requestPreview.expires_at,
        method: selectedMethod,
        transport_channel: transportChannel,
        acceptable_methods: acceptableMethods,
        selection_source: selectionSource,
        guidance_title: completionGuide?.guidance_title ?? null,
        guidance_body: completionGuide?.guidance_body ?? null,
        fallback_note: completionGuide?.fallback_note ?? null,
        ...(transportResolutionError
          ? { transport_resolution_error: transportResolutionError }
          : {}),
      } satisfies ApprovalPreviewResolvedStep;
    })
  );

  return {
    request: requestPreview,
    steps,
  };
}
