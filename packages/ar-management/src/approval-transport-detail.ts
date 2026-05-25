import type { Context } from 'hono';
import type {
  ApprovalApproverSubjectType,
  ApprovalDecisionStatus,
  ApprovalRequest,
  ApprovalRequestApproval,
  ApprovalRequestRepository,
  ApprovalRequestStatus,
  ApprovalTransportMethod,
  DatabaseAdapter,
  Env,
} from '@authrim/ar-lib-core';
import { type ObjectClass } from '@authrim/ar-lib-core/services/object-catalog';
import {
  loadChunkedSensitiveDetailJson,
  storeImmediateChunkedSensitiveDetailJson,
} from '@authrim/ar-lib-core/services/sensitive-detail-chunk-store';
import { createLoggingTenantKeyResolverFromSource } from './logging-tenant-key';

const APPROVAL_TRANSPORT_DETAIL_CONTENT_TYPE = 'application/json';
const DEFAULT_OBJECT_KEY_VERSION = 1;

export type ApprovalTransportEvidenceEventKind =
  | 'request_created'
  | 'step_initial'
  | 'step_artifact_issued'
  | 'step_receipt_issued'
  | 'grant_subject_token_issued'
  | 'grant_revoked'
  | 'step_approved'
  | 'step_denied'
  | 'step_remind'
  | 'step_resend'
  | 'request_cancelled';

export interface ApprovalTransportEvidenceEvent {
  id: string;
  kind: ApprovalTransportEvidenceEventKind;
  at: number;
  actor_subject_type: ApprovalApproverSubjectType | null;
  actor_subject_id: string | null;
  request_status: ApprovalRequestStatus;
  approval_step: {
    id: string;
    step_key: string;
    side: ApprovalRequestApproval['side'];
    subject_type: ApprovalRequestApproval['subject_type'];
    subject_id: string | null;
    relation_type: string | null;
    relation_source: string | null;
    status: ApprovalDecisionStatus;
  } | null;
  method: ApprovalTransportMethod | null;
  transport_channel: string | null;
  reason_code: string | null;
  reason_note: string | null;
  notification_action: 'initial' | 'remind' | 'resend' | null;
  notification_count: number | null;
  transport_summary: {
    provider: string | null;
    delivery_status: string | null;
    target: string | null;
    correlation_id: string | null;
    transport_request_id: string | null;
  } | null;
  transport_detail: {
    request: Record<string, unknown> | null;
    response: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
  } | null;
}

export interface ApprovalTransportEvidence {
  version: 1;
  request: {
    public_request_id: string;
    investigation_id: string;
    request_surface: string;
    requested_action: string;
    target_subject_type: ApprovalRequest['target_subject_type'];
    target_subject_id: string;
    redaction_level: ApprovalRequest['redaction_level'];
    status: ApprovalRequestStatus;
    reason_code: string;
    reason_note: string | null;
    reference: ApprovalRequest['reference'];
    ticket_reference: ApprovalRequest['ticket_reference'];
    policy_preset: string;
    reuse_scope: ApprovalRequest['reuse_scope'];
    partial_access_allowed: boolean;
    scope_json: ApprovalRequest['scope_json'];
    requested_at: number;
    expires_at: number;
    decided_at: number | null;
  };
  events: ApprovalTransportEvidenceEvent[];
}

export interface AppendApprovalTransportEventInput {
  kind: ApprovalTransportEvidenceEventKind;
  actorSubjectType: ApprovalApproverSubjectType | null;
  actorSubjectId: string | null;
  requestStatus: ApprovalRequestStatus;
  approval?: ApprovalRequestApproval | null;
  method?: ApprovalTransportMethod | null;
  transportChannel?: string | null;
  reasonCode?: string | null;
  reasonNote?: string | null;
  notificationAction?: 'initial' | 'remind' | 'resend' | null;
  notificationCount?: number | null;
  transportSummary?: {
    provider?: string | null;
    delivery_status?: string | null;
    target?: string | null;
    correlation_id?: string | null;
    transport_request_id?: string | null;
  } | null;
  transportDetail?: {
    request?: Record<string, unknown> | null;
    response?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  occurredAt?: number;
}

function getObjectEncryptionKeyVersion(env: Env): number {
  const parsed = Number.parseInt(env.OBJECT_ENCRYPTION_KEY_VERSION ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_OBJECT_KEY_VERSION;
}

function createEmptyEvidence(request: ApprovalRequest): ApprovalTransportEvidence {
  return {
    version: 1,
    request: {
      public_request_id: request.public_request_id,
      investigation_id: request.investigation_id,
      request_surface: request.request_surface,
      requested_action: request.requested_action,
      target_subject_type: request.target_subject_type,
      target_subject_id: request.target_subject_id,
      redaction_level: request.redaction_level,
      status: request.status,
      reason_code: request.reason_code,
      reason_note: request.reason_note,
      reference: request.reference,
      ticket_reference: request.ticket_reference,
      policy_preset: request.policy_preset,
      reuse_scope: request.reuse_scope,
      partial_access_allowed: request.partial_access_allowed,
      scope_json: request.scope_json,
      requested_at: request.requested_at,
      expires_at: request.expires_at,
      decided_at: request.decided_at,
    },
    events: [],
  };
}

async function persistApprovalTransportDetail(
  c: Context<any, any, any>,
  adapter: DatabaseAdapter,
  requestRepo: ApprovalRequestRepository,
  request: ApprovalRequest,
  detail: ApprovalTransportEvidence
): Promise<ApprovalRequest> {
  if (!c.env.SENSITIVE_DETAILS || !c.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return request;
  }

  const objectClass: ObjectClass = 'approval_transport_detail';
  const keyVersion = getObjectEncryptionKeyVersion(c.env);
  const tenantKeyResolver = createLoggingTenantKeyResolverFromSource(
    c.env.DB,
    'approval-transport-detail-tenant-key'
  );
  const stored = await storeImmediateChunkedSensitiveDetailJson({
    adapter,
    bucket: c.env.SENSITIVE_DETAILS,
    rootKeyHex: c.env.OBJECT_ENCRYPTION_ROOT_KEY,
    tenantId: request.tenant_id,
    objectClass,
    payload: detail,
    contentType: APPROVAL_TRANSPORT_DETAIL_CONTENT_TYPE,
    createdAt: Date.now(),
    keyVersion,
    tenantKeySalt: c.env.LOGGING_TENANT_KEY_SALT,
    ...(tenantKeyResolver ? ({ tenantKeyResolver } as Record<string, unknown>) : {}),
    surface: 'approval_transport',
    logType: 'admin_audit',
    catalogId: request.detail_object_catalog_id,
    publicArtifactId: request.detail_object_catalog_id ? undefined : request.public_request_id,
  });

  if (request.detail_object_catalog_id === stored.catalogId) {
    return request;
  }
  return (
    (await requestRepo.updateApprovalRequestDetailObjectCatalogId(request.id, stored.catalogId)) ??
    request
  );
}

export async function loadApprovalTransportDetail(
  c: Context<any, any, any>,
  adapter: DatabaseAdapter,
  request: ApprovalRequest
): Promise<ApprovalTransportEvidence | null> {
  if (!request.detail_object_catalog_id) {
    return null;
  }

  return loadChunkedSensitiveDetailJson<ApprovalTransportEvidence>(adapter, c.env, {
    tenantId: request.tenant_id,
    objectCatalogId: request.detail_object_catalog_id,
    expectedClass: 'approval_transport_detail',
  });
}

export async function appendApprovalTransportEvent(
  c: Context<any, any, any>,
  adapter: DatabaseAdapter,
  requestRepo: ApprovalRequestRepository,
  request: ApprovalRequest,
  input: AppendApprovalTransportEventInput
): Promise<ApprovalRequest> {
  if (!c.env.SENSITIVE_DETAILS || !c.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return request;
  }

  const detail =
    (await loadApprovalTransportDetail(c, adapter, request)) ?? createEmptyEvidence(request);
  detail.request.status = request.status;
  detail.request.redaction_level = request.redaction_level;
  detail.request.expires_at = request.expires_at;
  detail.request.decided_at = request.decided_at;
  detail.request.reason_code = request.reason_code;
  detail.request.reason_note = request.reason_note;
  detail.request.reference = request.reference;
  detail.request.ticket_reference = request.ticket_reference;
  detail.request.scope_json = request.scope_json;

  detail.events.push({
    id: crypto.randomUUID(),
    kind: input.kind,
    at: input.occurredAt ?? Date.now(),
    actor_subject_type: input.actorSubjectType,
    actor_subject_id: input.actorSubjectId,
    request_status: input.requestStatus,
    approval_step: input.approval
      ? {
          id: input.approval.id,
          step_key: input.approval.step_key,
          side: input.approval.side,
          subject_type: input.approval.subject_type,
          subject_id: input.approval.subject_id ?? null,
          relation_type: input.approval.relation_type ?? null,
          relation_source: input.approval.relation_source ?? null,
          status: input.approval.status,
        }
      : null,
    method: input.method ?? null,
    transport_channel: input.transportChannel ?? null,
    reason_code: input.reasonCode ?? null,
    reason_note: input.reasonNote ?? null,
    notification_action: input.notificationAction ?? null,
    notification_count: input.notificationCount ?? null,
    transport_summary: input.transportSummary
      ? {
          provider: input.transportSummary.provider ?? null,
          delivery_status: input.transportSummary.delivery_status ?? null,
          target: input.transportSummary.target ?? null,
          correlation_id: input.transportSummary.correlation_id ?? null,
          transport_request_id: input.transportSummary.transport_request_id ?? null,
        }
      : null,
    transport_detail: input.transportDetail
      ? {
          request: input.transportDetail.request ?? null,
          response: input.transportDetail.response ?? null,
          metadata: input.transportDetail.metadata ?? null,
        }
      : null,
  });

  return persistApprovalTransportDetail(c, adapter, requestRepo, request, detail);
}
