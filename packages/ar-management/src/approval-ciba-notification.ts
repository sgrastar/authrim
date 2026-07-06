import type { Context } from 'hono';
import type { ApprovalRequest, ApprovalRequestApproval, Env } from '@authrim/ar-lib-core';
import { getRequiredPluginContext } from '@authrim/ar-lib-core';
import { getApprovalNotificationCooldownMs } from './approval-policy-presets';
import {
  ApprovalTransportChannelResolutionError,
  resolveApprovalTransportChannel,
} from './approval-approver-contact';

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

function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function looksLikePhone(value: string): boolean {
  return /^\+?[0-9().\-\s]{6,}$/.test(value);
}

function buildCompletionPath(artifactId: string): string {
  return `/api/approval-artifacts/${encodeURIComponent(artifactId)}/portal`;
}

function buildDevicePath(artifactId: string): string {
  return `/api/approval-artifacts/${encodeURIComponent(artifactId)}/ciba/device`;
}

const APPROVAL_CIBA_DELIVERY_PREFIX = 'approval_ciba:delivery:';

export class ApprovalCibaNotificationError extends Error {
  status: number;
  retryAfterMs: number | null;

  constructor(message: string, status = 409, retryAfterMs: number | null = null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

interface ApprovalCibaDeliveryState {
  auth_req_id: string | null;
  notification_count: number;
  last_notified_at: number;
}

function getDeliveryStateKey(artifactId: string): string {
  return `${APPROVAL_CIBA_DELIVERY_PREFIX}${artifactId}`;
}

export async function getApprovalCibaDeliveryState(
  env: Pick<Env, 'AUTHRIM_CONFIG'>,
  artifactId: string
): Promise<ApprovalCibaDeliveryState | null> {
  const raw = await env.AUTHRIM_CONFIG?.get(getDeliveryStateKey(artifactId));
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as Partial<ApprovalCibaDeliveryState>;
  if (
    typeof parsed.last_notified_at !== 'number' ||
    typeof parsed.notification_count !== 'number'
  ) {
    return null;
  }

  return {
    auth_req_id: typeof parsed.auth_req_id === 'string' ? parsed.auth_req_id : null,
    notification_count: parsed.notification_count,
    last_notified_at: parsed.last_notified_at,
  };
}

export async function assertApprovalCibaNotificationCooldown(input: {
  env: Pick<Env, 'AUTHRIM_CONFIG'>;
  artifactId: string;
  policyPreset: string;
  now?: number;
}): Promise<ApprovalCibaDeliveryState | null> {
  const deliveryState = await getApprovalCibaDeliveryState(input.env, input.artifactId);
  if (!deliveryState) {
    return null;
  }

  const now = input.now ?? Date.now();
  const cooldownMs = getApprovalNotificationCooldownMs(input.policyPreset, 'resend');
  const elapsedMs = now - deliveryState.last_notified_at;
  if (elapsedMs < cooldownMs) {
    throw new ApprovalCibaNotificationError(
      'This approval step was notified too recently. Please wait before retrying.',
      429,
      cooldownMs - elapsedMs
    );
  }

  return deliveryState;
}

export async function recordApprovalCibaNotificationDispatch(input: {
  env: Pick<Env, 'AUTHRIM_CONFIG'>;
  artifactId: string;
  authReqId: string;
  expiresAt: number;
  previousState?: ApprovalCibaDeliveryState | null;
  now?: number;
}): Promise<ApprovalCibaDeliveryState> {
  if (!input.env.AUTHRIM_CONFIG) {
    throw new ApprovalCibaNotificationError(
      'AUTHRIM_CONFIG is required for approval CIBA delivery state.',
      500
    );
  }

  const now = input.now ?? Date.now();
  const nextState: ApprovalCibaDeliveryState = {
    auth_req_id: input.authReqId,
    notification_count: (input.previousState?.notification_count ?? 0) + 1,
    last_notified_at: now,
  };
  const ttlSeconds = Math.max(1, Math.ceil((input.expiresAt - now) / 1000));
  await input.env.AUTHRIM_CONFIG.put(
    getDeliveryStateKey(input.artifactId),
    JSON.stringify(nextState),
    {
      expirationTtl: ttlSeconds,
    }
  );
  return nextState;
}

async function resolveCibaTarget(
  c: AdminContext,
  request: ApprovalRequest,
  approval: ApprovalRequestApproval
): Promise<{ channel: 'email' | 'sms'; target: string }> {
  const explicitTarget = approval.transport_channel?.trim() ?? '';
  if (looksLikeEmail(explicitTarget)) {
    return { channel: 'email', target: explicitTarget };
  }
  if (looksLikePhone(explicitTarget)) {
    return { channel: 'sms', target: explicitTarget };
  }

  try {
    const emailTarget = await resolveApprovalTransportChannel(c, request, approval, {
      method: 'email_otp',
    });
    if (emailTarget && looksLikeEmail(emailTarget)) {
      return { channel: 'email', target: emailTarget };
    }
  } catch (error) {
    if (!(error instanceof ApprovalTransportChannelResolutionError)) {
      throw error;
    }
  }

  try {
    const smsTarget = await resolveApprovalTransportChannel(c, request, approval, {
      method: 'sms_otp',
    });
    if (smsTarget && looksLikePhone(smsTarget)) {
      return { channel: 'sms', target: smsTarget };
    }
  } catch (error) {
    if (!(error instanceof ApprovalTransportChannelResolutionError)) {
      throw error;
    }
  }

  throw new ApprovalCibaNotificationError(
    'CIBA completion requires a verified email or phone delivery target for the approver.',
    409
  );
}

export async function dispatchApprovalCibaUserCode(
  c: AdminContext,
  input: {
    request: ApprovalRequest;
    approval: ApprovalRequestApproval;
    artifactId: string;
    authReqId: string;
    userCode: string;
  }
): Promise<{
  channel: 'email' | 'sms';
  target: string;
  messageId: string | null;
}> {
  const { channel, target } = await resolveCibaTarget(c, input.request, input.approval);
  const pluginCtx = getRequiredPluginContext(c, 'notification');
  const notifier = pluginCtx.registry.getNotifier(channel) as NotificationHandler | undefined;
  if (!notifier) {
    throw new ApprovalCibaNotificationError(
      `No ${channel} notifier is configured for CIBA delivery.`,
      503
    );
  }

  const body =
    channel === 'email'
      ? [
          'An Authrim approval request is waiting on your authentication device.',
          `Investigation: ${input.request.investigation_id}`,
          `Action: ${input.request.request_surface}/${input.request.requested_action}`,
          `Verification code: ${input.userCode}`,
          `Device path: ${buildDevicePath(input.artifactId)}`,
          `Portal path: ${buildCompletionPath(input.artifactId)}`,
        ].join('\n')
      : [
          'Authrim approval pending.',
          `Code ${input.userCode}`,
          `Device ${buildDevicePath(input.artifactId)}`,
        ].join(' ');

  const result = await notifier.send({
    channel,
    to: target,
    subject:
      channel === 'email'
        ? `Approval device confirmation: ${input.request.request_surface}`
        : undefined,
    body,
    metadata: {
      kind: 'approval_ciba',
      auth_req_id: input.authReqId,
      approval_request_id: input.request.public_request_id,
      approval_step_id: input.approval.id,
      artifact_id: input.artifactId,
      investigation_id: input.request.investigation_id,
    },
  });

  if (!result.success) {
    throw new ApprovalCibaNotificationError(
      result.error ?? `Failed to deliver CIBA verification code via ${channel}.`,
      result.retryable ? 503 : 409
    );
  }

  return {
    channel,
    target,
    messageId: result.messageId ?? null,
  };
}
