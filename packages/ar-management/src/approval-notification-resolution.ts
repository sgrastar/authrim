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
  const candidateMethods = input.strictMethod
    ? [preferredMethod]
    : dedupeMethods([preferredMethod, ...policy.acceptableMethods]);

  let lastResolutionError: ApprovalTransportChannelResolutionError | null = null;

  for (const candidateMethod of candidateMethods) {
    const candidateTransportChannel =
      candidateMethod === preferredMethod ? policy.transportChannel : null;

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
      if (input.strictMethod) {
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
