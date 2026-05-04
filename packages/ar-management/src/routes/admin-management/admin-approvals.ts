/**
 * Admin Approval / Elevation API
 *
 * Management surface for mixed approval requests and their per-approver
 * decisions. This stores canonical scope and approval metadata in DB_ADMIN and
 * issues short-lived elevation grants when a request reaches full approval.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  adminAuthMiddleware,
  requireDedicatedAdminDatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  getTenantIdFromContext,
  ApprovalRequestRepository,
  ApprovalRequestApprovalRepository,
  ElevationGrantRepository,
  canonicalizeApprovalScope,
  createElevationGrantSubjectToken,
  ELEVATION_GRANT_SUBJECT_TOKEN_TYPE,
  generateInvestigationId,
  normalizeStructuredReference,
  resolveProductProtectedResourceAudience,
  resolveProductProtectedResourceDetailClasses,
  type ApprovalScopeJson,
  type ApprovalDecisionStatus,
  type ApprovalRedactionLevel,
  type ApprovalRequest,
  type ApprovalRequestApproval,
  type ApprovalRequestStatus,
  type ApprovalTransportMethod,
  type ElevationGrant,
} from '@authrim/ar-lib-core';
import { auditAdminSensitiveRead, requireAdminPermissionOrElevationGrant } from '../../admin-elevation-access';
import {
  appendApprovalTransportEvent,
  loadApprovalTransportDetail,
} from '../../approval-transport-detail';
import { issueApprovalCompletionArtifact } from '../../approval-completion-artifact';
import { buildApprovalCompletionRequirements } from '../../approval-completion-guidance';
import { buildApprovalGrantIntegrationHint } from '../../approval-grant-integration-hint';
import { listApprovalDecisionReceiptsForEvidence } from '../../approval-decision-receipt-tracking';
import {
  ApprovalTransportChannelResolutionError,
} from '../../approval-approver-contact';
import { dispatchApprovalNotification } from '../../approval-notification-dispatch';
import { resolveApprovalNotificationTransport } from '../../approval-notification-resolution';
import {
  APPROVAL_PRESETS,
  getApprovalNotificationCooldownMs,
  getApprovalPresetExpiry,
  resolveApprovalEffectivePolicy,
} from '../../approval-policy-presets';
import {
  ApprovalStepResolutionError,
  previewApprovalRequestResolution,
  resolveApprovalSteps,
} from '../../approval-request-preview';
import { resolveApprovalStepGuide } from '../../approval-step-guide';
import {
  applyApprovalDecisionForRequest,
  syncElevationGrantsForRequest,
} from '../../approval-workflow';
import { getRequestAwareIssuerUrl } from '../../request-issuer';
import { writeAdminAuditLog } from '../../admin-shared';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
type ApprovalNotificationKind = 'remind' | 'resend';
type ApprovalNotificationAction = 'initial' | ApprovalNotificationKind;

interface ApprovalNotificationResult {
  approval_id: string;
  step_key: string;
  action: ApprovalNotificationAction;
  method: ApprovalTransportMethod;
  transport_channel: string | null;
  completion_artifact?: {
    artifact_id: string;
    path: string;
    expires_at: number;
  } | null;
  success: boolean;
  delivery_status: string | null;
  target: string | null;
  transport_request_id: string | null;
  error: string | null;
  retryable: boolean;
}

const StructuredReferenceSchema = z.object({
  system: z.string().min(1),
  id: z.string().min(1),
  url: z.string().url().optional(),
});

const ApprovalTransportSummarySchema = z.object({
  provider: z.string().min(1).optional(),
  delivery_status: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  correlation_id: z.string().min(1).optional(),
  transport_request_id: z.string().min(1).optional(),
});

const ApprovalTransportDetailSchema = z.object({
  request: z.record(z.string(), z.unknown()).nullable().optional(),
  response: z.record(z.string(), z.unknown()).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const ApprovalStepSchema = z.object({
  step_key: z.string().min(1).max(100),
  side: z.enum(['admin_operator', 'customer_data_owner', 'guardian_delegate']),
  subject_type: z.enum(['admin_user', 'end_user', 'customer_delegate', 'service_principal']),
  subject_id: z.string().min(1).optional(),
  relation_type: z.string().min(1).optional(),
  relation_source: z.string().min(1).optional(),
  method: z.enum(['ciba', 'passkey', 'portal_confirm', 'email_otp', 'sms_otp', 'reauth']).optional(),
  transport_channel: z.string().min(1).optional(),
  expires_at: z.number().int().positive().optional(),
});

const ApprovalRequestCreateSchema = z.object({
  investigation_id: z.string().min(1).optional(),
  requester_subject_type: z
    .enum(['admin_user', 'end_user', 'customer_delegate', 'service_principal'])
    .optional(),
  requester_subject_id: z.string().min(1).optional(),
  target_subject_type: z.enum(['user', 'artifact', 'service_resource', 'tenant_resource']),
  target_subject_id: z.string().min(1),
  request_surface: z.string().min(1),
  requested_action: z.string().min(1),
  resource_class: z.string().min(1),
  resource_ids: z.array(z.string().min(1)).optional(),
  detail_classes: z.array(z.string().min(1)).optional(),
  dataset: z.string().min(1).optional(),
  audience: z.string().min(1).optional(),
  redaction_level: z.enum(['summary_only', 'masked', 'raw']).default('masked'),
  attributes: z.record(z.string(), z.unknown()).optional(),
  reason_code: z.string().min(1),
  reason_note: z.string().min(1).optional(),
  reference_id: z.string().min(1).optional(),
  reference: StructuredReferenceSchema.optional(),
  ticket_reference: StructuredReferenceSchema.optional(),
  policy_preset: z.enum([
    'support_case_default',
    'technical_debug_default',
    'security_investigation_default',
    'guardian_support_default',
    'compliance_review_default',
  ]),
  reuse_scope: z.enum(['request', 'case']).default('request'),
  partial_access_allowed: z.boolean().default(false),
  expires_at: z.number().int().positive().optional(),
  approvals: z.array(ApprovalStepSchema).min(1),
});

const ApprovalDecisionBodySchema = z.object({
  method: z.enum(['ciba', 'passkey', 'portal_confirm', 'email_otp', 'sms_otp', 'reauth']).optional(),
  transport_channel: z.string().min(1).optional(),
  reason_code: z.string().min(1).optional(),
  reason_note: z.string().min(1).optional(),
  transport_summary: ApprovalTransportSummarySchema.optional(),
  transport_detail: ApprovalTransportDetailSchema.optional(),
});

const ApprovalCancelBodySchema = z.object({
  reason_code: z.string().min(1).optional(),
  reason_note: z.string().min(1).optional(),
});

const ApprovalGrantRevokeSchema = z.object({
  reason_code: z.string().min(1).optional(),
  reason_note: z.string().min(1).optional(),
});

const ApprovalGrantSubjectTokenSchema = z.object({
  client_id: z.string().min(1),
  expires_in: z.number().int().min(60).max(30 * 60).optional(),
});

const ApprovalArtifactIssueSchema = z.object({
  method: z.enum(['ciba', 'passkey', 'portal_confirm', 'email_otp', 'sms_otp', 'reauth']).optional(),
  transport_channel: z.string().min(1).optional(),
  expires_in_seconds: z.number().int().min(60).max(60 * 60).optional(),
});

export const adminApprovalsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

adminApprovalsRouter.use('*', adminAuthMiddleware());

function getAdminAdapter(c: Context<any, any, any>) {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-approvals');
}

function hasPermission(c: AdminContext, permission: string): boolean {
  const permissions = c.get('adminAuth')?.permissions || [];
  return hasAdminPermission(permissions, permission);
}

function formatApprovalResponse(
  request: ApprovalRequest,
  approvals: ApprovalRequestApproval[],
  grants: ElevationGrant[] = [],
  options?: { notificationResults?: ApprovalNotificationResult[] }
) {
  return {
    ...request,
    has_detail: !!request.detail_object_catalog_id,
    approvals,
    grants,
    ...(options?.notificationResults?.length
      ? { notification_results: options.notificationResults }
      : {}),
    resolved_policy: resolveApprovalEffectivePolicy(request.policy_preset),
  };
}

function formatNotificationResult(
  approval: ApprovalRequestApproval,
  action: ApprovalNotificationAction,
  result: Awaited<ReturnType<typeof dispatchApprovalNotification>>
): ApprovalNotificationResult {
  return {
    approval_id: approval.id,
    step_key: approval.step_key,
    action,
    method: result.method,
    transport_channel: result.transportChannel,
    completion_artifact: result.completionArtifact
      ? {
          artifact_id: result.completionArtifact.artifactId,
          path: result.completionArtifact.path,
          expires_at: result.completionArtifact.expiresAt,
        }
      : null,
    success: result.success,
    delivery_status: result.summary.delivery_status,
    target: result.summary.target,
    transport_request_id: result.summary.transport_request_id,
    error: result.error ?? null,
    retryable: result.retryable ?? false,
  };
}

function buildGrantSubjectTokenEvidenceMetadata(input: {
  grant: ElevationGrant;
  clientId: string;
  subjectTokenType: string;
  expiresIn: number;
  jti?: string | null;
  integrationHint: ReturnType<typeof buildApprovalGrantIntegrationHint>;
}) {
  return {
    approval_grant_subject_token: {
      public_grant_id: input.grant.public_grant_id,
      client_id: input.clientId,
      subject_token_type: input.subjectTokenType,
      expires_in: input.expiresIn,
      jti: input.jti ?? null,
      target_audience: input.integrationHint.target_audience ?? null,
      resource_class: input.integrationHint.resource_class,
      resource_ids: input.integrationHint.resource_ids,
      detail_classes: input.integrationHint.detail_classes,
      redaction_level: input.grant.redaction_level,
      requires_online_check: input.integrationHint.requires_online_check,
      fail_closed: input.integrationHint.fail_closed,
      require_full_access: input.integrationHint.authorization_defaults.require_full_access,
    },
  };
}

function mergeTransportDetailMetadata(
  operatorInput: z.infer<typeof ApprovalTransportDetailSchema> | undefined,
  result: Awaited<ReturnType<typeof dispatchApprovalNotification>>
) {
  if (!operatorInput) {
    return result.detail;
  }

  return {
    request: result.detail.request,
    response: result.detail.response,
    metadata: {
      ...(result.detail.metadata ?? {}),
      operator_input: {
        request: operatorInput.request ?? null,
        response: operatorInput.response ?? null,
        metadata: operatorInput.metadata ?? null,
      },
    },
  };
}

function canManagePendingRequest(request: ApprovalRequest): boolean {
  return request.status === 'pending' || request.status === 'partially_approved';
}

async function dispatchAndRecordNotificationAttempt(
  c: AdminContext,
  adapter: ReturnType<typeof getAdminAdapter>,
  requestRepo: ApprovalRequestRepository,
  approvalRepo: ApprovalRequestApprovalRepository,
  request: ApprovalRequest,
  approval: ApprovalRequestApproval,
  action: ApprovalNotificationAction,
  input: {
    method?: ApprovalTransportMethod | null;
    transportChannel?: string | null;
    reasonCode?: string | null;
    reasonNote?: string | null;
    operatorTransportDetail?: z.infer<typeof ApprovalTransportDetailSchema>;
  }
): Promise<{
  requestWithDetail: ApprovalRequest;
  approval: ApprovalRequestApproval;
  result: Awaited<ReturnType<typeof dispatchApprovalNotification>>;
}> {
  const now = Date.now();
  const nextNotificationCount = (approval.notification_count ?? 0) + 1;
  const dispatchResult = await dispatchApprovalNotification(c, {
    request,
    approval,
    action,
    method: input.method ?? null,
    transportChannel: input.transportChannel ?? null,
    reasonCode: input.reasonCode ?? null,
    reasonNote: input.reasonNote ?? null,
    operatorTransportDetail: input.operatorTransportDetail ?? null,
  });

  const updatedApproval =
    (await approvalRepo.updateApproval(approval.id, {
      method: dispatchResult.method,
      transport_channel: dispatchResult.transportChannel,
      reason_code: input.reasonCode ?? approval.reason_code ?? null,
      reason_note: input.reasonNote ?? approval.reason_note ?? null,
      last_notification_action: action,
      last_notified_at: now,
      notification_count: nextNotificationCount,
    })) ?? approval;

  const requestWithDetail = await appendApprovalTransportEvent(c, adapter, requestRepo, request, {
    kind:
      action === 'initial'
        ? 'step_initial'
        : action === 'resend'
          ? 'step_resend'
          : 'step_remind',
    actorSubjectType: 'admin_user',
    actorSubjectId:
      action === 'initial' ? request.requester_subject_id : c.get('adminAuth')?.userId ?? null,
    requestStatus: request.status,
    approval: updatedApproval,
    method: dispatchResult.method,
    transportChannel: dispatchResult.transportChannel,
    reasonCode: input.reasonCode ?? request.reason_code,
    reasonNote: input.reasonNote ?? request.reason_note,
    notificationAction: action,
    notificationCount: nextNotificationCount,
    transportSummary: dispatchResult.summary,
    transportDetail: mergeTransportDetailMetadata(input.operatorTransportDetail, dispatchResult),
    occurredAt: now,
  });

  return {
    requestWithDetail,
    approval: updatedApproval,
    result: dispatchResult,
  };
}

async function notifyPendingApproval(
  c: AdminContext,
  action: ApprovalNotificationKind
): Promise<Response> {
  if (!hasPermission(c, ADMIN_PERMISSIONS.APPROVALS_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const body = ApprovalDecisionBodySchema.parse(await c.req.json());
    const adapter = getAdminAdapter(c);
    const requestRepo = new ApprovalRequestRepository(adapter);
    const approvalRepo = new ApprovalRequestApprovalRepository(adapter);
    const grantRepo = new ElevationGrantRepository(adapter);
    const request = await requestRepo.getApprovalRequestByPublicId(c.req.param('requestId')!);
    if (!request) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (!canManagePendingRequest(request)) {
      return c.json(
        {
          error: 'approval_request_not_pending',
          error_description: 'Only pending or partially approved requests can be reminded or resent.',
        },
        409
      );
    }

    const approval = await approvalRepo.getApprovalById(c.req.param('approvalId')!);
    if (!approval || approval.approval_request_id !== request.id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (approval.status !== 'pending') {
      return c.json(
        {
          error: 'approval_step_not_pending',
          error_description: 'Only pending approval steps can be reminded or resent.',
        },
        409
      );
    }

    const now = Date.now();
    const cooldownMs = getApprovalNotificationCooldownMs(request.policy_preset, action);
    const notificationState = approval as ApprovalRequestApproval & {
      last_notification_action?: 'initial' | 'resend' | 'remind' | null;
      last_notified_at?: number | null;
      notification_count?: number;
    };
    if (notificationState.last_notified_at && now - notificationState.last_notified_at < cooldownMs) {
      const retryAfterMs = cooldownMs - (now - notificationState.last_notified_at);
      return c.json(
        {
          error: 'approval_notification_cooldown',
          error_description:
            'This approval step was notified too recently. Please wait before retrying.',
          action,
          retry_after_ms: retryAfterMs,
          retry_after_seconds: Math.ceil(retryAfterMs / 1000),
        },
        429
      );
    }

    const notification = await dispatchAndRecordNotificationAttempt(
      c,
      adapter,
      requestRepo,
      approvalRepo,
      request,
      approval,
      action,
      {
        method: (body.method ?? approval.method ?? null) as ApprovalTransportMethod | null,
        transportChannel: body.transport_channel ?? approval.transport_channel ?? null,
        reasonCode: body.reason_code ?? approval.reason_code ?? null,
        reasonNote: body.reason_note ?? approval.reason_note ?? null,
        operatorTransportDetail: body.transport_detail,
      }
    );

    const approvals = await approvalRepo.listApprovalsForRequest(request.id);
    const grants = await grantRepo.listElevationGrantsForRequest(request.id);

    return c.json(
      formatApprovalResponse(notification.requestWithDetail, approvals, grants, {
        notificationResults: [formatNotificationResult(notification.approval, action, notification.result)],
      })
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: error.issues[0]?.path.join('.') || 'body',
          reason: error.issues[0]?.message || 'Invalid approval notification payload',
        },
      });
    }
    if (error instanceof ApprovalTransportChannelResolutionError) {
      return c.json(
        {
          error: 'approval_transport_resolution_failed',
          error_description: error.message,
        },
        409
      );
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

adminApprovalsRouter.get('/', async (c) => {
  if (!hasPermission(c as AdminContext, ADMIN_PERMISSIONS.APPROVALS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const requestRepo = new ApprovalRequestRepository(adapter);
    const approvalRepo = new ApprovalRequestApprovalRepository(adapter);
    const grantRepo = new ElevationGrantRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const status = c.req.query('status') as ApprovalRequestStatus | undefined;
    const investigationId = c.req.query('investigation_id');
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '50', 10), 200));

    const requests = await requestRepo.listApprovalRequests({
      tenantId,
      status,
      investigationId: investigationId || undefined,
      limit,
    });

    const items = await Promise.all(
      requests.map(async (request) => ({
        request,
        approvals: await approvalRepo.listApprovalsForRequest(request.id),
        grants: await grantRepo.listElevationGrantsForRequest(request.id),
      }))
    );

    return c.json({
      items: items.map((item) => formatApprovalResponse(item.request, item.approvals, item.grants)),
      total: items.length,
    });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminApprovalsRouter.post('/preview', async (c) => {
  if (!hasPermission(c as AdminContext, ADMIN_PERMISSIONS.APPROVALS_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const body = ApprovalRequestCreateSchema.parse(await c.req.json());
    const tenantId = getTenantIdFromContext(c);
    const adminAuth = (c as AdminContext).get('adminAuth');
    const preview = await previewApprovalRequestResolution(c as AdminContext, {
      tenantId,
      requesterSubjectType:
        body.requester_subject_type ?? (adminAuth?.userId ? 'admin_user' : 'service_principal'),
      requesterSubjectId: body.requester_subject_id ?? adminAuth?.userId ?? 'system',
      body,
    });

    return c.json(preview);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: error.issues[0]?.path.join('.') || 'body',
          reason: error.issues[0]?.message || 'Invalid approval preview payload',
        },
      });
    }
    if (error instanceof ApprovalStepResolutionError) {
      return c.json(
        {
          error: 'approval_step_resolution_failed',
          error_description: error.message,
        },
        409
      );
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminApprovalsRouter.post('/', async (c) => {
  if (!hasPermission(c as AdminContext, ADMIN_PERMISSIONS.APPROVALS_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const body = ApprovalRequestCreateSchema.parse(await c.req.json());
    const adapter = getAdminAdapter(c);
    const requestRepo = new ApprovalRequestRepository(adapter);
    const approvalRepo = new ApprovalRequestApprovalRepository(adapter);
    const grantRepo = new ElevationGrantRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const adminAuth = (c as AdminContext).get('adminAuth');

    const scope = canonicalizeApprovalScope({
      version: 1,
      surface: body.request_surface,
      action: body.requested_action,
      tenant_id: tenantId,
      resource_class: body.resource_class,
      resource_ids: body.resource_ids ?? [body.target_subject_id],
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
      redaction_level: body.redaction_level as ApprovalRedactionLevel,
      attributes: body.attributes as Record<string, ApprovalScopeJson | undefined> | undefined,
    });

    const request = await requestRepo.createApprovalRequest({
      tenant_id: tenantId,
      investigation_id: scope.normalized.investigation_id ?? generateInvestigationId(),
      requester_subject_type:
        body.requester_subject_type ?? (adminAuth?.userId ? 'admin_user' : 'service_principal'),
      requester_subject_id: body.requester_subject_id ?? adminAuth?.userId ?? 'system',
      target_subject_type: body.target_subject_type,
      target_subject_id: body.target_subject_id,
      request_surface: body.request_surface,
      requested_action: body.requested_action,
      redaction_level: body.redaction_level as ApprovalRedactionLevel,
      scope_json: scope.normalized,
      scope_canonical: scope.canonical,
      reason_code: body.reason_code,
      reason_note: body.reason_note ?? null,
      reference:
        normalizeStructuredReference(body.reference ?? body.reference_id ?? null, {
          defaultSystem: 'external',
        }) ?? null,
      ticket_reference: normalizeStructuredReference(body.ticket_reference ?? null) ?? null,
      policy_preset: body.policy_preset,
      reuse_scope: body.reuse_scope,
      partial_access_allowed: body.partial_access_allowed,
      expires_at: body.expires_at ?? getApprovalPresetExpiry(body.policy_preset),
    });

    const resolvedSteps = await resolveApprovalSteps(c as AdminContext, request, body.approvals);

    const approvals = await Promise.all(
      resolvedSteps.map(async (step) => {
        const resolvedTransport = await resolveApprovalNotificationTransport(
          c as AdminContext,
          {
            request,
            approval: {
              side: step.side,
              subject_type: step.subject_type,
              subject_id: step.subject_id ?? null,
              method: step.method ?? null,
              transport_channel: step.transport_channel ?? null,
            },
            strictMethod: !!step.method,
          }
        );

        return approvalRepo.createApproval({
          approval_request_id: request.id,
          step_key: step.step_key,
          side: step.side,
          subject_type: step.subject_type,
          subject_id: step.subject_id ?? null,
          relation_type: step.relation_type ?? null,
          relation_source: step.relation_source ?? null,
          method: resolvedTransport.method,
          transport_channel: resolvedTransport.transportChannel,
          notification_count: 0,
          last_notification_action: null,
          last_notified_at: null,
          expires_at: step.expires_at ?? request.expires_at,
        });
      })
    );

    const requestWithDetail = await appendApprovalTransportEvent(c, adapter, requestRepo, request, {
      kind: 'request_created',
      actorSubjectType: request.requester_subject_type,
      actorSubjectId: request.requester_subject_id,
      requestStatus: request.status,
      method: null,
      transportChannel: null,
      reasonCode: request.reason_code,
      reasonNote: request.reason_note,
      notificationAction: null,
      occurredAt: request.created_at,
    });

    let currentRequest = requestWithDetail;
    const notificationResults: ApprovalNotificationResult[] = [];

    for (const approval of approvals) {
      if (!approval.method) {
        continue;
      }

      const notification = await dispatchAndRecordNotificationAttempt(
        c as AdminContext,
        adapter,
        requestRepo,
        approvalRepo,
        currentRequest,
        approval,
        'initial',
        {
          method: approval.method,
          transportChannel: approval.transport_channel,
          reasonCode: request.reason_code,
          reasonNote: request.reason_note,
        }
      );
      currentRequest = notification.requestWithDetail;
      notificationResults.push(
        formatNotificationResult(notification.approval, 'initial', notification.result)
      );
    }

    const latestApprovals = await approvalRepo.listApprovalsForRequest(request.id);
    const grants = await syncElevationGrantsForRequest(grantRepo, currentRequest);
    return c.json(
      formatApprovalResponse(currentRequest, latestApprovals, grants, { notificationResults }),
      201
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: error.issues[0]?.path.join('.') || 'body', reason: error.issues[0]?.message || 'Invalid approval request payload' },
      });
    }
    if (error instanceof ApprovalStepResolutionError) {
      return c.json(
        {
          error: 'approval_step_resolution_failed',
          error_description: error.message,
        },
        409
      );
    }
    if (error instanceof ApprovalTransportChannelResolutionError) {
      return c.json(
        {
          error: 'approval_transport_resolution_failed',
          error_description: error.message,
        },
        409
      );
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminApprovalsRouter.get('/:requestId', async (c) => {
  if (!hasPermission(c as AdminContext, ADMIN_PERMISSIONS.APPROVALS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const requestRepo = new ApprovalRequestRepository(adapter);
    const approvalRepo = new ApprovalRequestApprovalRepository(adapter);
    const grantRepo = new ElevationGrantRepository(adapter);
    const requestId = c.req.param('requestId')!;
    const request = await requestRepo.getApprovalRequestByPublicId(requestId);
    if (!request) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const approvals = await approvalRepo.listApprovalsForRequest(request.id);
    const grants = await grantRepo.listElevationGrantsForRequest(request.id);
    return c.json(formatApprovalResponse(request, approvals, grants));
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminApprovalsRouter.post('/:requestId/grants/:grantId/subject-token', async (c) => {
  if (!hasPermission(c as AdminContext, ADMIN_PERMISSIONS.APPROVALS_GRANT_ISSUE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const body = ApprovalGrantSubjectTokenSchema.parse(await c.req.json());
    const adapter = getAdminAdapter(c);
    const requestRepo = new ApprovalRequestRepository(adapter);
    const grantRepo = new ElevationGrantRepository(adapter);
    const request = await requestRepo.getApprovalRequestByPublicId(c.req.param('requestId')!);
    if (!request) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const grants = await grantRepo.listElevationGrantsForRequest(request.id);
    const grant = grants.find((item) => item.public_grant_id === c.req.param('grantId')!);
    if (!grant) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (grant.status !== 'active' || grant.revoked_at || grant.expires_at <= Date.now()) {
      return c.json(
        {
          error: 'inactive_elevation_grant',
          error_description: 'The selected elevation grant is inactive or expired.',
        },
        409
      );
    }

    const remainingGrantSeconds = Math.max(1, Math.floor((grant.expires_at - Date.now()) / 1000));
    const ttlSeconds = Math.min(body.expires_in ?? 5 * 60, remainingGrantSeconds);
    const issuer = getRequestAwareIssuerUrl(
      c as unknown as Context<{ Bindings: Env }>,
      request.tenant_id
    );
    const subjectToken = await createElevationGrantSubjectToken({
      env: c.env,
      tenantId: request.tenant_id,
      issuer,
      clientId: body.client_id,
      request,
      grant,
      expiresInSeconds: ttlSeconds,
    });
    const integrationHint = buildApprovalGrantIntegrationHint({
      issuer,
      clientId: body.client_id,
      request,
      grant,
    });

    await appendApprovalTransportEvent(
      c as unknown as Context<{ Bindings: Env }>,
      adapter,
      requestRepo,
      request,
      {
        kind: 'grant_subject_token_issued',
        actorSubjectType: 'admin_user',
        actorSubjectId: c.get('adminAuth')?.userId ?? null,
        requestStatus: request.status,
        reasonCode: request.reason_code,
        reasonNote: request.reason_note,
        transportSummary: {
          provider: 'authrim.elevation_subject_token',
          delivery_status: 'issued',
          target: body.client_id,
          correlation_id: request.investigation_id,
          transport_request_id: subjectToken.jti ?? null,
        },
        transportDetail: {
          request: {
            client_id: body.client_id,
            expires_in: ttlSeconds,
          },
          response: {
            issued: true,
            subject_token_type: subjectToken.subjectTokenType,
            expires_in: subjectToken.expiresIn,
            jti: subjectToken.jti,
          },
          metadata: buildGrantSubjectTokenEvidenceMetadata({
            grant,
            clientId: body.client_id,
            subjectTokenType: subjectToken.subjectTokenType,
            expiresIn: subjectToken.expiresIn,
            jti: subjectToken.jti,
            integrationHint,
          }),
        },
      }
    );

    await writeAdminAuditLog(c as unknown as Context<{ Bindings: Env }>, {
      action: 'approval_grant_subject_token_issued',
      resourceType: 'elevation_grant',
      resourceId: grant.public_grant_id,
      result: 'success',
      severity: 'info',
      metadata: {
        approval_request_id: request.public_request_id,
        client_id: body.client_id,
        target_audience: integrationHint.target_audience ?? null,
        resource_class: integrationHint.resource_class,
        resource_ids: integrationHint.resource_ids,
        detail_classes: integrationHint.detail_classes,
        redaction_level: grant.redaction_level,
        expires_in: subjectToken.expiresIn,
        subject_token_type: subjectToken.subjectTokenType,
        subject_token_jti: subjectToken.jti ?? null,
        requires_online_check: integrationHint.requires_online_check,
        fail_closed: integrationHint.fail_closed,
      },
    });

    return c.json({
      grant_id: grant.public_grant_id,
      request_id: request.public_request_id,
      investigation_id: request.investigation_id,
      subject_token: subjectToken.subjectToken,
      subject_token_type: subjectToken.subjectTokenType,
      expires_in: subjectToken.expiresIn,
      authorization_details: subjectToken.authorizationDetails,
      token_exchange_hint: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: ELEVATION_GRANT_SUBJECT_TOKEN_TYPE,
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        client_id: body.client_id,
      },
      integration_hint: integrationHint,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: error.issues[0]?.path.join('.') || 'body',
          reason: error.issues[0]?.message || 'Invalid grant subject token payload',
        },
      });
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminApprovalsRouter.post('/:requestId/grants/:grantId/revoke', async (c) => {
  if (!hasPermission(c as AdminContext, ADMIN_PERMISSIONS.APPROVALS_GRANT_ISSUE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const body = ApprovalGrantRevokeSchema.parse(await c.req.json().catch(() => ({})));
    const adapter = getAdminAdapter(c);
    const requestRepo = new ApprovalRequestRepository(adapter);
    const approvalRepo = new ApprovalRequestApprovalRepository(adapter);
    const grantRepo = new ElevationGrantRepository(adapter);
    const request = await requestRepo.getApprovalRequestByPublicId(c.req.param('requestId')!);
    if (!request) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const grants = await grantRepo.listElevationGrantsForRequest(request.id);
    const grant = grants.find((item) => item.public_grant_id === c.req.param('grantId')!);
    if (!grant) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (grant.status !== 'active' || grant.revoked_at || grant.expires_at <= Date.now()) {
      return c.json(
        {
          error: 'inactive_elevation_grant',
          error_description: 'The selected elevation grant is inactive or already revoked.',
        },
        409
      );
    }

    const revokeReason = body.reason_code?.trim() || 'manual_revoke';
    const revokedAt = Date.now();
    const updatedGrant = await grantRepo.updateElevationGrantStatus(grant.id, 'revoked', {
      revokedAt,
      revokeReason,
    });
    const approvals = await approvalRepo.listApprovalsForRequest(request.id);

    await appendApprovalTransportEvent(
      c as unknown as Context<{ Bindings: Env }>,
      adapter,
      requestRepo,
      request,
      {
        kind: 'grant_revoked',
        actorSubjectType: 'admin_user',
        actorSubjectId: c.get('adminAuth')?.userId ?? null,
        requestStatus: request.status,
        reasonCode: revokeReason,
        reasonNote: body.reason_note ?? null,
        transportDetail: {
          metadata: {
            elevation_grant: {
              public_grant_id: grant.public_grant_id,
              target_audience: grant.target_audience,
              resource_class: grant.resource_class,
              redaction_level: grant.redaction_level,
              revoked_at: revokedAt,
              revoke_reason: revokeReason,
            },
          },
        },
      }
    );

    await writeAdminAuditLog(c as unknown as Context<{ Bindings: Env }>, {
      action: 'approval_grant_revoked',
      resourceType: 'elevation_grant',
      resourceId: grant.public_grant_id,
      result: 'success',
      severity: 'warn',
      metadata: {
        approval_request_id: request.public_request_id,
        target_audience: grant.target_audience,
        resource_class: grant.resource_class,
        revoke_reason: revokeReason,
        reason_note: body.reason_note ?? null,
      },
    });

    return c.json(
      formatApprovalResponse(
        request,
        approvals,
        grants.map((item) => (item.id === grant.id && updatedGrant ? updatedGrant : item))
      )
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: error.issues[0]?.path.join('.') || 'body',
          reason: error.issues[0]?.message || 'Invalid grant revoke payload',
        },
      });
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminApprovalsRouter.post('/:requestId/steps/:approvalId/artifacts', async (c) => {
  if (!hasPermission(c as AdminContext, ADMIN_PERMISSIONS.APPROVALS_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const body = ApprovalArtifactIssueSchema.parse(await c.req.json());
    const adapter = getAdminAdapter(c);
    const requestRepo = new ApprovalRequestRepository(adapter);
    const approvalRepo = new ApprovalRequestApprovalRepository(adapter);
    const request = await requestRepo.getApprovalRequestByPublicId(c.req.param('requestId')!);
    if (!request) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (!canManagePendingRequest(request)) {
      return c.json(
        {
          error: 'approval_request_not_pending',
          error_description: 'Only pending or partially approved requests can issue artifacts.',
        },
        409
      );
    }

    const approval = await approvalRepo.getApprovalById(c.req.param('approvalId')!);
    if (!approval || approval.approval_request_id !== request.id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (approval.status !== 'pending') {
      return c.json(
        {
          error: 'approval_step_not_pending',
          error_description: 'Only pending approval steps can issue completion artifacts.',
        },
        409
      );
    }

    const resolvedTransport = await resolveApprovalNotificationTransport(c as AdminContext, {
      request,
      approval,
      overrideMethod: (body.method ?? approval.method ?? null) as ApprovalTransportMethod | null,
      overrideTransportChannel: body.transport_channel ?? approval.transport_channel ?? null,
      strictMethod: !!body.method,
    });

    const artifact = await issueApprovalCompletionArtifact(c as AdminContext, {
      request,
      approval,
      method: resolvedTransport.method,
      transportChannel: resolvedTransport.transportChannel,
      expiresAt:
        body.expires_in_seconds && body.expires_in_seconds > 0
          ? Math.min(Date.now() + body.expires_in_seconds * 1000, approval.expires_at)
          : approval.expires_at,
    });

    const requestWithDetail = await appendApprovalTransportEvent(
      c,
      adapter,
      requestRepo,
      request,
      {
        kind: 'step_artifact_issued',
        actorSubjectType: 'admin_user',
        actorSubjectId: c.get('adminAuth')?.userId ?? null,
        requestStatus: request.status,
        approval,
        method: resolvedTransport.method,
        transportChannel: resolvedTransport.transportChannel,
        reasonCode: request.reason_code,
        reasonNote: request.reason_note,
        transportSummary: {
          provider: 'authrim.approval_artifact',
          delivery_status: 'issued',
          target: resolvedTransport.transportChannel ?? approval.subject_id ?? null,
          correlation_id: request.investigation_id,
          transport_request_id: artifact.artifact_id,
        },
        transportDetail: {
          request: {
            artifact_id: artifact.artifact_id,
            completion_path: `/api/approval-artifacts/${encodeURIComponent(artifact.artifact_id)}`,
          },
          response: {
            issued: true,
          },
          metadata: {
            acceptable_methods: resolvedTransport.acceptableMethods,
            selection_source: resolvedTransport.source,
            fallback_from_method: resolvedTransport.fallbackFromMethod,
          },
        },
      }
    );

    return c.json({
      artifact,
      completion_path: `/api/approval-artifacts/${encodeURIComponent(artifact.artifact_id)}`,
      completion_requirements: buildApprovalCompletionRequirements({
        artifactId: artifact.artifact_id,
        method: resolvedTransport.method,
        transportChannel: resolvedTransport.transportChannel,
        acceptableMethods: resolvedTransport.acceptableMethods,
        approval: {
          subject_type: approval.subject_type,
          subject_id: approval.subject_id,
          relation_type: approval.relation_type,
          relation_source: approval.relation_source,
        },
      }),
      request: formatApprovalResponse(
        requestWithDetail,
        await approvalRepo.listApprovalsForRequest(request.id),
        []
      ),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: error.issues[0]?.path.join('.') || 'body',
          reason: error.issues[0]?.message || 'Invalid approval artifact payload',
        },
      });
    }
    if (error instanceof ApprovalTransportChannelResolutionError) {
      return c.json(
        {
          error: 'approval_transport_resolution_failed',
          error_description: error.message,
        },
        409
      );
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminApprovalsRouter.get('/:requestId/evidence', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const requestRepo = new ApprovalRequestRepository(adapter);
    const request = await requestRepo.getApprovalRequestByPublicId(c.req.param('requestId')!);
    if (!request) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const access = await requireAdminPermissionOrElevationGrant(c as AdminContext, {
      directPermission: ADMIN_PERMISSIONS.APPROVALS_DETAIL_READ,
      requestSurface: 'approvals',
      requestedAction: 'detail_read',
      resourceClass: 'approval_transport_detail',
      resourceIds: [request.public_request_id, request.detail_object_catalog_id],
      detailClass: 'transport_evidence',
      targetAudience: 'admin_api',
    });
    if (access instanceof Response) {
      return access;
    }

    const detail = await loadApprovalTransportDetail(c, adapter, request);
    if (!detail) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await auditAdminSensitiveRead(c as AdminContext, access, {
      action: 'approval.transport_detail_read',
      resourceType: 'approval_request',
      resourceId: request.public_request_id,
      metadata: {
        investigation_id: request.investigation_id,
        request_surface: request.request_surface,
        requested_action: request.requested_action,
      },
    });

    return c.json(detail);
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminApprovalsRouter.get('/:requestId/receipts', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const requestRepo = new ApprovalRequestRepository(adapter);
    const request = await requestRepo.getApprovalRequestByPublicId(c.req.param('requestId')!);
    if (!request) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const access = await requireAdminPermissionOrElevationGrant(c as AdminContext, {
      directPermission: ADMIN_PERMISSIONS.APPROVALS_DETAIL_READ,
      requestSurface: 'approvals',
      requestedAction: 'detail_read',
      resourceClass: 'approval_transport_detail',
      resourceIds: [request.public_request_id, request.detail_object_catalog_id],
      detailClass: 'decision_receipts',
      targetAudience: 'admin_api',
    });
    if (access instanceof Response) {
      return access;
    }

    const detail = await loadApprovalTransportDetail(c, adapter, request);
    if (!detail) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const receipts = await listApprovalDecisionReceiptsForEvidence(c.env, detail);

    await auditAdminSensitiveRead(c as AdminContext, access, {
      action: 'approval.decision_receipts_read',
      resourceType: 'approval_request',
      resourceId: request.public_request_id,
      metadata: {
        investigation_id: request.investigation_id,
        request_surface: request.request_surface,
        requested_action: request.requested_action,
        receipt_count: receipts.length,
      },
    });

    return c.json({
      request_id: request.public_request_id,
      investigation_id: request.investigation_id,
      items: receipts,
    });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

adminApprovalsRouter.get('/:requestId/steps/:approvalId/guide', async (c) => {
  if (!hasPermission(c as AdminContext, ADMIN_PERMISSIONS.APPROVALS_READ)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const requestRepo = new ApprovalRequestRepository(adapter);
    const approvalRepo = new ApprovalRequestApprovalRepository(adapter);
    const request = await requestRepo.getApprovalRequestByPublicId(c.req.param('requestId')!);
    if (!request) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const approval = await approvalRepo.getApprovalById(c.req.param('approvalId')!);
    if (!approval || approval.approval_request_id !== request.id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    return c.json(
      await resolveApprovalStepGuide(c as AdminContext, {
        request,
        approval,
      })
    );
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

async function updateApprovalDecision(
  c: AdminContext,
  nextStatus: ApprovalDecisionStatus
): Promise<Response> {
  if (!hasPermission(c, ADMIN_PERMISSIONS.APPROVALS_APPROVE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const body = ApprovalDecisionBodySchema.parse(await c.req.json());
    const adapter = getAdminAdapter(c);
    const requestRepo = new ApprovalRequestRepository(adapter);
    const approvalRepo = new ApprovalRequestApprovalRepository(adapter);
    const grantRepo = new ElevationGrantRepository(adapter);
    const request = await requestRepo.getApprovalRequestByPublicId(c.req.param('requestId')!);
    if (!request) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const approval = await approvalRepo.getApprovalById(c.req.param('approvalId')!);
    if (!approval || approval.approval_request_id !== request.id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const result = await applyApprovalDecisionForRequest(c, {
      adapter,
      requestRepo,
      approvalRepo,
      grantRepo,
    }, {
      request,
      approval,
      nextStatus,
      actorSubjectType: 'admin_user',
      actorSubjectId: c.get('adminAuth')?.userId ?? null,
      method: (body.method ?? null) as ApprovalTransportMethod | null,
      transportChannel: body.transport_channel ?? null,
      reasonCode: body.reason_code ?? null,
      reasonNote: body.reason_note ?? null,
      transportSummary: body.transport_summary ?? null,
      transportDetail: body.transport_detail ?? null,
    });

    return c.json(formatApprovalResponse(result.request, result.approvals, result.grants));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: error.issues[0]?.path.join('.') || 'body', reason: error.issues[0]?.message || 'Invalid approval decision payload' },
      });
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

adminApprovalsRouter.post('/:requestId/steps/:approvalId/approve', async (c) =>
  updateApprovalDecision(c as AdminContext, 'approved')
);

adminApprovalsRouter.post('/:requestId/steps/:approvalId/deny', async (c) =>
  updateApprovalDecision(c as AdminContext, 'denied')
);

adminApprovalsRouter.post('/:requestId/steps/:approvalId/remind', async (c) =>
  notifyPendingApproval(c as AdminContext, 'remind')
);

adminApprovalsRouter.post('/:requestId/steps/:approvalId/resend', async (c) =>
  notifyPendingApproval(c as AdminContext, 'resend')
);

adminApprovalsRouter.post('/:requestId/cancel', async (c) => {
  if (!hasPermission(c as AdminContext, ADMIN_PERMISSIONS.APPROVALS_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const body = ApprovalCancelBodySchema.parse(await c.req.json());
    const adapter = getAdminAdapter(c);
    const requestRepo = new ApprovalRequestRepository(adapter);
    const approvalRepo = new ApprovalRequestApprovalRepository(adapter);
    const grantRepo = new ElevationGrantRepository(adapter);
    const request = await requestRepo.getApprovalRequestByPublicId(c.req.param('requestId')!);
    if (!request) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const approvals = await approvalRepo.listApprovalsForRequest(request.id);
    await Promise.all(
      approvals
        .filter((approval) => approval.status === 'pending' || approval.status === 'approved')
        .map((approval) =>
          approvalRepo.updateApproval(approval.id, {
            status: 'cancelled',
            decided_at: Date.now(),
          })
        )
    );
    const refreshed = await approvalRepo.listApprovalsForRequest(request.id);
    const updatedRequest = await requestRepo.updateApprovalRequestStatus(request.id, 'cancelled', {
      decidedAt: Date.now(),
    });
    const effectiveRequest = updatedRequest ?? request;
    const requestWithDetail = await appendApprovalTransportEvent(
      c,
      adapter,
      requestRepo,
      effectiveRequest,
      {
        kind: 'request_cancelled',
        actorSubjectType: 'admin_user',
        actorSubjectId: c.get('adminAuth')?.userId ?? null,
        requestStatus: 'cancelled',
        reasonCode: body.reason_code ?? null,
        reasonNote: body.reason_note ?? null,
      }
    );
    const grants = await syncElevationGrantsForRequest(grantRepo, requestWithDetail);

    return c.json(formatApprovalResponse(requestWithDetail, refreshed, grants));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: error.issues[0]?.path.join('.') || 'body', reason: error.issues[0]?.message || 'Invalid cancellation payload' },
      });
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});
