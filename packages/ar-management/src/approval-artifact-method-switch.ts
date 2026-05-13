import type { Context } from 'hono';
import type {
  ApprovalRequest,
  ApprovalRequestApproval,
  ApprovalRequestApprovalRepository,
  ApprovalRequestRepository,
  ApprovalTransportMethod,
  DatabaseAdapter,
} from '@authrim/ar-lib-core';
import { appendApprovalTransportEvent } from './approval-transport-detail';
import { consumeApprovalCompletionArtifact } from './approval-completion-artifact';
import { dispatchApprovalNotification } from './approval-notification-dispatch';
import { resolveApprovalNotificationPolicy } from './approval-notification-policy';
import { getApprovalNotificationCooldownMs } from './approval-policy-presets';

type AppContext = Context<any, any, any>;

export class ApprovalArtifactMethodSwitchError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | null;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    retryAfterMs?: number | null;
  }) {
    super(input.message);
    this.name = 'ApprovalArtifactMethodSwitchError';
    this.status = input.status;
    this.code = input.code;
    this.retryAfterMs = input.retryAfterMs ?? null;
  }
}

function buildNotificationActionMetadata(input: {
  previousArtifactId: string;
  previousMethod: ApprovalTransportMethod;
  requestedMethod: ApprovalTransportMethod;
  allowedMethods: ApprovalTransportMethod[];
}) {
  return {
    artifact_switch: {
      previous_artifact_id: input.previousArtifactId,
      previous_method: input.previousMethod,
      requested_method: input.requestedMethod,
      allowed_methods: input.allowedMethods,
    },
  };
}

function mergeTransportDetailMetadata(input: {
  detail: {
    request: Record<string, unknown> | null;
    response: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
  };
  metadata: Record<string, unknown>;
}) {
  return {
    request: input.detail.request,
    response: input.detail.response,
    metadata: {
      ...(input.detail.metadata ?? {}),
      ...input.metadata,
    },
  };
}

export interface SwitchApprovalArtifactMethodResult {
  requestWithDetail: ApprovalRequest;
  approval: ApprovalRequestApproval;
  dispatchResult: Awaited<ReturnType<typeof dispatchApprovalNotification>>;
  allowedMethods: ApprovalTransportMethod[];
  replacedArtifactId: string;
}

export async function switchApprovalArtifactMethod(
  c: AppContext,
  input: {
    adapter: DatabaseAdapter;
    requestRepo: ApprovalRequestRepository;
    approvalRepo: ApprovalRequestApprovalRepository;
    request: ApprovalRequest;
    approval: ApprovalRequestApproval;
    currentArtifactId: string;
    currentMethod: ApprovalTransportMethod;
    requestedMethod: ApprovalTransportMethod;
  }
): Promise<SwitchApprovalArtifactMethodResult> {
  const policy = resolveApprovalNotificationPolicy({
    request: input.request,
    approval: input.approval,
  });

  if (!policy.acceptableMethods.includes(input.requestedMethod)) {
    throw new ApprovalArtifactMethodSwitchError({
      status: 409,
      code: 'approval_completion_method_not_allowed',
      message: 'The requested fallback method is not allowed for this approval step.',
    });
  }

  const now = Date.now();
  const cooldownMs = getApprovalNotificationCooldownMs(input.request.policy_preset, 'resend');
  const lastNotifiedAt = input.approval.last_notified_at ?? null;
  if (lastNotifiedAt && now - lastNotifiedAt < cooldownMs) {
    const retryAfterMs = cooldownMs - (now - lastNotifiedAt);
    throw new ApprovalArtifactMethodSwitchError({
      status: 429,
      code: 'approval_notification_cooldown',
      message: 'This approval step was notified too recently. Please wait before retrying.',
      retryAfterMs,
    });
  }

  const dispatchResult = await dispatchApprovalNotification(c, {
    request: input.request,
    approval: input.approval,
    action: 'resend',
    method: input.requestedMethod,
    reasonCode: input.request.reason_code,
    reasonNote: input.request.reason_note,
  });

  if (!dispatchResult.success || !dispatchResult.completionArtifact) {
    throw new ApprovalArtifactMethodSwitchError({
      status: dispatchResult.retryable ? 503 : 409,
      code: 'approval_notification_dispatch_failed',
      message: dispatchResult.error ?? 'Failed to switch approval completion method.',
    });
  }

  const nextNotificationCount = (input.approval.notification_count ?? 0) + 1;
  const updatedApproval =
    (await input.approvalRepo.updateApproval(input.approval.id, {
      method: dispatchResult.method,
      transport_channel: dispatchResult.transportChannel,
      reason_code: input.request.reason_code,
      reason_note: input.request.reason_note,
      last_notification_action: 'resend',
      last_notified_at: now,
      notification_count: nextNotificationCount,
    })) ?? input.approval;

  const requestWithDetail = await appendApprovalTransportEvent(
    c,
    input.adapter,
    input.requestRepo,
    input.request,
    {
      kind: 'step_resend',
      actorSubjectType: input.approval.subject_type,
      actorSubjectId: input.approval.subject_id,
      requestStatus: input.request.status,
      approval: updatedApproval,
      method: dispatchResult.method,
      transportChannel: dispatchResult.transportChannel,
      reasonCode: input.request.reason_code,
      reasonNote: input.request.reason_note,
      notificationAction: 'resend',
      notificationCount: nextNotificationCount,
      transportSummary: dispatchResult.summary,
      transportDetail: mergeTransportDetailMetadata({
        detail: dispatchResult.detail,
        metadata: buildNotificationActionMetadata({
          previousArtifactId: input.currentArtifactId,
          previousMethod: input.currentMethod,
          requestedMethod: input.requestedMethod,
          allowedMethods: policy.acceptableMethods,
        }),
      }),
      occurredAt: now,
    }
  );

  await consumeApprovalCompletionArtifact(c.env, input.currentArtifactId, input.request.tenant_id);

  return {
    requestWithDetail,
    approval: updatedApproval,
    dispatchResult,
    allowedMethods: policy.acceptableMethods,
    replacedArtifactId: input.currentArtifactId,
  };
}
