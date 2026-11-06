import type { Context } from 'hono';
import type {
  ApprovalRequest,
  ApprovalRequestApproval,
  ApprovalTransportMethod,
} from '@authrim/ar-lib-core';
import {
  ApprovalTransportChannelResolutionError,
  resolveApprovalTransportChannel,
} from './approval-approver-contact';
import {
  resolveApprovalNotificationPolicy,
  type ApprovalNotificationPolicySource,
} from './approval-notification-policy';

type AdminContext = Context<any, any, any>;

export interface ApprovalResolvedNotificationTransport {
  method: ApprovalTransportMethod;
  transportChannel: string | null;
  acceptableMethods: ApprovalTransportMethod[];
  source: ApprovalNotificationPolicySource;
  fallbackFromMethod: ApprovalTransportMethod | null;
}

function dedupeMethods(methods: readonly ApprovalTransportMethod[]): ApprovalTransportMethod[] {
  return Array.from(new Set(methods));
}

export async function resolveApprovalNotificationTransport(
  c: AdminContext,
  input: {
    request: ApprovalRequest;
    approval: Pick<
      ApprovalRequestApproval,
      'side' | 'subject_type' | 'subject_id' | 'method' | 'transport_channel'
    >;
    overrideMethod?: ApprovalTransportMethod | null;
    overrideTransportChannel?: string | null;
    strictMethod?: boolean;
  }
): Promise<ApprovalResolvedNotificationTransport> {
  const policy = resolveApprovalNotificationPolicy({
    request: input.request,
    approval: input.approval,
    overrideMethod: input.overrideMethod ?? null,
    overrideTransportChannel: input.overrideTransportChannel ?? null,
  });

  const preferredMethod = policy.method;
  // Strict only for a method the caller asked for and policy still allows: a retired one (a
  // person's portal_confirm) was replaced, so the verified methods are tried in order.
  const requestedMethod = input.overrideMethod ?? input.approval.method ?? null;
  const strict = !!input.strictMethod && requestedMethod === preferredMethod;
  const candidateMethods = strict
    ? [preferredMethod]
    : dedupeMethods([preferredMethod, ...policy.acceptableMethods]);

  let lastResolutionError: ApprovalTransportChannelResolutionError | null = null;

  // For an OTP the destination is the approver's verified contact; only a channel the caller
  // supplied now is checked against it. The step's stored channel (a label such as `ciba`, or a
  // contact since changed) is not the caller's choice and must not fail the resolution.
  const storedChannel = input.approval.transport_channel?.trim() || null;
  const callerChannel = input.overrideTransportChannel?.trim() || null;
  const callerSuppliedChannel =
    callerChannel && callerChannel !== storedChannel ? callerChannel : null;

  for (const candidateMethod of candidateMethods) {
    const isOtp = candidateMethod === 'email_otp' || candidateMethod === 'sms_otp';
    const candidateTransportChannel =
      candidateMethod !== preferredMethod
        ? null
        : isOtp
          ? callerSuppliedChannel
          : policy.transportChannel;

    try {
      const transportChannel = await resolveApprovalTransportChannel(
        c,
        input.request,
        {
          subject_type: input.approval.subject_type,
          subject_id: input.approval.subject_id,
          method: input.approval.method,
          transport_channel: input.approval.transport_channel,
        },
        {
          method: candidateMethod,
          transportChannel: candidateTransportChannel,
        }
      );

      return {
        method: candidateMethod,
        transportChannel,
        acceptableMethods: policy.acceptableMethods,
        source: policy.source,
        fallbackFromMethod: candidateMethod === preferredMethod ? null : preferredMethod,
      };
    } catch (error) {
      if (!(error instanceof ApprovalTransportChannelResolutionError)) {
        throw error;
      }

      lastResolutionError = error;
      if (strict) {
        throw error;
      }
    }
  }

  throw (
    lastResolutionError ??
    new ApprovalTransportChannelResolutionError(
      'No approval transport method could be resolved for this approver.'
    )
  );
}
