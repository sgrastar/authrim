import type { Context } from 'hono';
import type {
  ApprovalNotificationAction,
  ApprovalRequest,
  ApprovalRequestApproval,
  ApprovalTransportMethod,
  Env,
} from '@authrim/ar-lib-core';
import { getPluginContext } from '@authrim/ar-lib-core';
import { issueApprovalCompletionArtifact } from './approval-completion-artifact';
import { issueApprovalOtpChallenge } from './approval-otp';
import { resolveApprovalNotificationTransport } from './approval-notification-resolution';

export interface ApprovalNotificationDispatchInput {
  request: ApprovalRequest;
  approval: ApprovalRequestApproval;
  action: ApprovalNotificationAction;
  method?: ApprovalTransportMethod | null;
  transportChannel?: string | null;
  reasonCode?: string | null;
  reasonNote?: string | null;
  operatorTransportDetail?: {
    request?: Record<string, unknown> | null;
    response?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
  } | null;
}

export interface ApprovalNotificationDispatchResult {
  success: boolean;
  method: ApprovalTransportMethod;
  transportChannel: string | null;
  completionArtifact?: {
    artifactId: string;
    path: string;
    expiresAt: number;
  } | null;
  summary: {
    provider: string | null;
    delivery_status: string | null;
    target: string | null;
    correlation_id: string | null;
    transport_request_id: string | null;
  };
  detail: {
    request: Record<string, unknown> | null;
    response: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
  };
  error?: string;
  retryable?: boolean;
}

type AdminContext = Context<any, any, any>;
type NotificationHandler = {
  send(notification: {
    channel: string;
    to: string;
    from?: string;
    subject?: string;
    body: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    success: boolean;
    messageId?: string;
    error?: string;
    retryable?: boolean;
  }>;
};

const APPROVAL_NOTIFICATION_FROM = 'noreply@authrim.dev';

function createCorrelationId(
  request: ApprovalRequest,
  approval: ApprovalRequestApproval,
  action: ApprovalNotificationAction
): string {
  return [
    request.investigation_id,
    request.public_request_id,
    approval.step_key,
    action,
    Date.now().toString(36),
  ].join(':');
}

function buildApprovalTitle(request: ApprovalRequest): string {
  return `Approval required: ${request.request_surface} / ${request.requested_action}`;
}

function buildApprovalPortalPath(request: ApprovalRequest): string {
  return `/admin/approvals?investigation_id=${encodeURIComponent(request.investigation_id)}`;
}

function buildApprovalCompletionPath(artifactId: string): string {
  return `/api/approval-artifacts/${encodeURIComponent(artifactId)}/portal`;
}

function buildEmailHtml(
  request: ApprovalRequest,
  approval: ApprovalRequestApproval,
  action: ApprovalNotificationAction,
  completionPath?: string | null,
  otpCode?: string | null
): string {
  return `
    <p>An Authrim approval action requires your review.</p>
    <ul>
      <li><strong>Investigation</strong>: ${request.investigation_id}</li>
      <li><strong>Surface</strong>: ${request.request_surface}</li>
      <li><strong>Action</strong>: ${request.requested_action}</li>
      <li><strong>Step</strong>: ${approval.step_key}</li>
      <li><strong>Reason</strong>: ${request.reason_code}</li>
      <li><strong>Notification</strong>: ${action}</li>
    </ul>
    <p>Open Authrim to review the approval request:</p>
    <p><code>${buildApprovalPortalPath(request)}</code></p>
    ${otpCode ? `<p>Verification code: <strong>${otpCode}</strong></p>` : ''}
    ${completionPath ? `<p>Completion artifact path: <code>${completionPath}</code></p>` : ''}
  `.trim();
}

function buildEmailText(
  request: ApprovalRequest,
  approval: ApprovalRequestApproval,
  action: ApprovalNotificationAction,
  completionPath?: string | null,
  otpCode?: string | null
): string {
  return [
    'An Authrim approval action requires your review.',
    `Investigation: ${request.investigation_id}`,
    `Surface: ${request.request_surface}`,
    `Action: ${request.requested_action}`,
    `Step: ${approval.step_key}`,
    `Reason: ${request.reason_code}`,
    `Notification: ${action}`,
    `Review path: ${buildApprovalPortalPath(request)}`,
    ...(otpCode ? [`Verification code: ${otpCode}`] : []),
    ...(completionPath ? [`Completion path: ${completionPath}`] : []),
  ].join('\n');
}

function buildSmsText(
  request: ApprovalRequest,
  approval: ApprovalRequestApproval,
  action: ApprovalNotificationAction,
  completionPath?: string | null,
  otpCode?: string | null
): string {
  return [
    'Authrim approval required.',
    `Case ${request.investigation_id}`,
    `${request.request_surface}/${request.requested_action}`,
    `Step ${approval.step_key}`,
    `Action ${action}`,
    ...(otpCode ? [`Code ${otpCode}`] : []),
    ...(completionPath ? [`Complete ${completionPath}`] : []),
  ].join(' ');
}

function buildBaseMetadata(
  request: ApprovalRequest,
  approval: ApprovalRequestApproval,
  action: ApprovalNotificationAction,
  method: ApprovalTransportMethod,
  transportChannel: string | null,
  metadata?: {
    acceptableMethods?: ApprovalTransportMethod[];
    selectionSource?: string;
  }
): Record<string, unknown> {
  return {
    investigation_id: request.investigation_id,
    approval_request_id: request.public_request_id,
    approval_step_id: approval.id,
    approval_step_key: approval.step_key,
    request_surface: request.request_surface,
    requested_action: request.requested_action,
    policy_preset: request.policy_preset,
    reason_code: request.reason_code,
    redaction_level: request.redaction_level,
    action,
    method,
    transport_channel: transportChannel,
    acceptable_methods: metadata?.acceptableMethods ?? null,
    selection_source: metadata?.selectionSource ?? null,
  };
}

interface ApprovalCompletionDispatchArtifact {
  artifact_id: string;
  expires_at: number;
}

async function sendViaNotifier(
  c: AdminContext,
  channel: 'email' | 'sms',
  target: string,
  notification: {
    subject?: string;
    body: string;
    metadata?: Record<string, unknown>;
  },
  input: ApprovalNotificationDispatchInput,
  method: ApprovalTransportMethod,
  transportChannel: string | null,
  correlationId: string,
  metadataContext?: {
    acceptableMethods?: ApprovalTransportMethod[];
    selectionSource?: string;
  },
  completionArtifact?: ApprovalCompletionDispatchArtifact | null,
  completionPath?: string | null
): Promise<ApprovalNotificationDispatchResult> {
  const pluginCtx = getPluginContext(c);
  const notifier = pluginCtx.registry.getNotifier(channel) as NotificationHandler | undefined;

  if (!notifier) {
    return {
      success: false,
      method,
      transportChannel,
      summary: {
        provider: `notifier.${channel}`,
        delivery_status: 'failed',
        target,
        correlation_id: correlationId,
        transport_request_id: null,
      },
      completionArtifact:
        completionArtifact && completionPath
          ? {
              artifactId: completionArtifact.artifact_id,
              path: completionPath,
              expiresAt: completionArtifact.expires_at,
            }
          : null,
      detail: {
        request: {
          channel,
          to: target,
          subject: notification.subject ?? null,
          completion_path: completionPath ?? null,
        },
        response: {
          success: false,
          error: `No ${channel} notifier is configured`,
          retryable: false,
        },
        metadata: {
          ...buildBaseMetadata(
            input.request,
            input.approval,
            input.action,
            method,
            transportChannel,
            metadataContext
          ),
          approval_completion_artifact:
            completionArtifact && completionPath
              ? {
                  artifact_id: completionArtifact.artifact_id,
                  path: completionPath,
                  expires_at: completionArtifact.expires_at,
                }
              : null,
          operator_input: input.operatorTransportDetail ?? null,
        },
      },
      error: `No ${channel} notifier is configured`,
      retryable: false,
    };
  }

  const payload = {
    channel,
    to: target,
    from: channel === 'email' ? c.env.EMAIL_FROM || APPROVAL_NOTIFICATION_FROM : undefined,
    subject: notification.subject,
    body: notification.body,
    metadata: notification.metadata,
  };

  try {
    const result = await notifier.send(payload);
    return {
      success: result.success,
      method,
      transportChannel,
      summary: {
        provider: `notifier.${channel}`,
        delivery_status: result.success ? 'sent' : 'failed',
        target,
        correlation_id: correlationId,
        transport_request_id: result.messageId ?? null,
      },
      completionArtifact:
        completionArtifact && completionPath
          ? {
              artifactId: completionArtifact.artifact_id,
              path: completionPath,
              expiresAt: completionArtifact.expires_at,
            }
          : null,
      detail: {
        request: payload as unknown as Record<string, unknown>,
        response: {
          success: result.success,
          messageId: result.messageId ?? null,
          error: result.error ?? null,
          retryable: result.retryable ?? false,
        },
        metadata: {
          ...buildBaseMetadata(
            input.request,
            input.approval,
            input.action,
            method,
            transportChannel,
            metadataContext
          ),
          approval_completion_artifact:
            completionArtifact && completionPath
              ? {
                  artifact_id: completionArtifact.artifact_id,
                  path: completionPath,
                  expires_at: completionArtifact.expires_at,
                }
              : null,
          operator_input: input.operatorTransportDetail ?? null,
        },
      },
      ...(result.success
        ? {}
        : {
            error: result.error ?? `${channel} notification failed`,
            retryable: result.retryable ?? false,
          }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : `${channel} notification failed`;
    return {
      success: false,
      method,
      transportChannel,
      summary: {
        provider: `notifier.${channel}`,
        delivery_status: 'failed',
        target,
        correlation_id: correlationId,
        transport_request_id: null,
      },
      completionArtifact:
        completionArtifact && completionPath
          ? {
              artifactId: completionArtifact.artifact_id,
              path: completionPath,
              expiresAt: completionArtifact.expires_at,
            }
          : null,
      detail: {
        request: payload as unknown as Record<string, unknown>,
        response: {
          success: false,
          error: message,
          retryable: true,
        },
        metadata: {
          ...buildBaseMetadata(
            input.request,
            input.approval,
            input.action,
            method,
            transportChannel,
            metadataContext
          ),
          approval_completion_artifact:
            completionArtifact && completionPath
              ? {
                  artifact_id: completionArtifact.artifact_id,
                  path: completionPath,
                  expires_at: completionArtifact.expires_at,
                }
              : null,
          operator_input: input.operatorTransportDetail ?? null,
        },
      },
      error: message,
      retryable: true,
    };
  }
}

function buildRecordedTransportResult(
  input: ApprovalNotificationDispatchInput,
  method: ApprovalTransportMethod,
  transportChannel: string | null,
  correlationId: string,
  metadataContext?: {
    acceptableMethods?: ApprovalTransportMethod[];
    selectionSource?: string;
  },
  completionArtifact?: ApprovalCompletionDispatchArtifact | null,
  completionPath?: string | null
): ApprovalNotificationDispatchResult {
  const target = transportChannel || input.approval.subject_id || null;
  const transportRequestId = completionArtifact?.artifact_id ?? crypto.randomUUID();
  return {
    success: true,
    method,
    transportChannel,
    summary: {
      provider: `authrim.${method}`,
      delivery_status: 'recorded',
      target,
      correlation_id: correlationId,
      transport_request_id: transportRequestId,
    },
    completionArtifact:
      completionArtifact && completionPath
        ? {
            artifactId: completionArtifact.artifact_id,
            path: completionPath,
            expiresAt: completionArtifact.expires_at,
          }
        : null,
    detail: {
      request: {
        channel: method,
        target,
        portal_path: buildApprovalPortalPath(input.request),
        completion_path: completionPath ?? null,
        investigation_id: input.request.investigation_id,
      },
      response: {
        status: 'recorded',
        transport_request_id: transportRequestId,
      },
      metadata: {
        ...buildBaseMetadata(
          input.request,
          input.approval,
          input.action,
          method,
          transportChannel,
          metadataContext
        ),
        approval_completion_artifact:
          completionArtifact && completionPath
            ? {
                artifact_id: completionArtifact.artifact_id,
                path: completionPath,
                expires_at: completionArtifact.expires_at,
              }
            : null,
        operator_input: input.operatorTransportDetail ?? null,
      },
    },
  };
}

export async function dispatchApprovalNotification(
  c: AdminContext,
  input: ApprovalNotificationDispatchInput
): Promise<ApprovalNotificationDispatchResult> {
  const resolvedTransport = await resolveApprovalNotificationTransport(c, {
    request: input.request,
    approval: input.approval,
    overrideMethod: input.method ?? null,
    overrideTransportChannel: input.transportChannel ?? null,
    strictMethod: !!input.method,
  });
  const method = resolvedTransport.method;
  const transportChannel = resolvedTransport.transportChannel;
  const correlationId = createCorrelationId(input.request, input.approval, input.action);
  const metadataContext = {
    acceptableMethods: resolvedTransport.acceptableMethods,
    selectionSource: resolvedTransport.source,
  };
  const completionArtifact = await issueApprovalCompletionArtifact(c, {
    request: input.request,
    approval: input.approval,
    method,
    transportChannel,
  });
  const completionPath = buildApprovalCompletionPath(completionArtifact.artifact_id);

  if (method === 'email_otp' || method === 'sms_otp') {
    const target = transportChannel;
    if (!target) {
      return {
        success: false,
        method,
        transportChannel,
        summary: {
          provider: `notifier.${method === 'email_otp' ? 'email' : 'sms'}`,
          delivery_status: 'failed',
          target: null,
          correlation_id: correlationId,
          transport_request_id: null,
        },
        completionArtifact: {
          artifactId: completionArtifact.artifact_id,
          path: completionPath,
          expiresAt: completionArtifact.expires_at,
        },
        detail: {
          request: null,
          response: {
            success: false,
            error: 'A transport target is required for this notification method',
            retryable: false,
          },
          metadata: {
            ...buildBaseMetadata(
              input.request,
              input.approval,
              input.action,
              method,
              transportChannel,
              metadataContext
            ),
            approval_completion_artifact: {
              artifact_id: completionArtifact.artifact_id,
              path: completionPath,
              expires_at: completionArtifact.expires_at,
            },
            operator_input: input.operatorTransportDetail ?? null,
          },
        },
        error: 'A transport target is required for this notification method',
        retryable: false,
      };
    }

    const otpChallenge = await issueApprovalOtpChallenge(c.env, {
      tenantId: input.request.tenant_id,
      artifactId: completionArtifact.artifact_id,
      method,
      target,
      approverSubjectId: input.approval.subject_id ?? null,
    });

    if (method === 'email_otp') {
      return sendViaNotifier(
        c,
        'email',
        target,
        {
          subject: buildApprovalTitle(input.request),
          body: buildEmailHtml(
            input.request,
            input.approval,
            input.action,
            completionPath,
            otpChallenge.code
          ),
          metadata: {
            textBody: buildEmailText(
              input.request,
              input.approval,
              input.action,
              completionPath,
              otpChallenge.code
            ),
            ...buildBaseMetadata(
              input.request,
              input.approval,
              input.action,
              method,
              transportChannel,
              metadataContext
            ),
            approval_completion_artifact: {
              artifact_id: completionArtifact.artifact_id,
              path: completionPath,
              expires_at: completionArtifact.expires_at,
            },
            approval_otp: {
              expires_at: otpChallenge.expiresAt,
            },
          },
        },
        input,
        method,
        transportChannel,
        correlationId,
        metadataContext,
        completionArtifact,
        completionPath
      );
    }

    return sendViaNotifier(
      c,
      'sms',
      target,
      {
        body: buildSmsText(
          input.request,
          input.approval,
          input.action,
          completionPath,
          otpChallenge.code
        ),
        metadata: buildBaseMetadata(
          input.request,
          input.approval,
          input.action,
          method,
          transportChannel,
          metadataContext
        ),
      },
      input,
      method,
      transportChannel,
      correlationId,
      metadataContext,
      completionArtifact,
      completionPath
    );
  }

  return buildRecordedTransportResult(
    input,
    method,
    transportChannel,
    correlationId,
    metadataContext,
    completionArtifact,
    completionPath
  );
}
