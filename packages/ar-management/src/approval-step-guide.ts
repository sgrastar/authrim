import type { Context } from 'hono';
import type {
  ApprovalRequest,
  ApprovalRequestApproval,
  ApprovalTransportMethod,
} from '@authrim/ar-lib-core';
import {
  describeApprovalCompletionMethod,
  resolveApprovalCompletionMode,
} from './approval-completion-guidance';
import {
  resolveApprovalNotificationTransport,
} from './approval-notification-resolution';
import type { ApprovalNotificationPolicySource } from './approval-notification-policy';

type AdminContext = Context<any, any, any>;

export interface ApprovalStepGuideResult {
  request_id: string;
  approval_id: string;
  step_key: string;
  status: ApprovalRequestApproval['status'];
  expires_at: number;
  selection_source: ApprovalNotificationPolicySource | null;
  resolution_error: string | null;
  guide: {
    mode: 'artifact_only' | 'step_up_required';
    method: ApprovalTransportMethod;
    transport_channel: string | null;
    acceptable_methods: ApprovalTransportMethod[];
    guidance_title: string;
    guidance_body: string;
    fallback_note: string | null;
  } | null;
}

export async function resolveApprovalStepGuide(
  c: AdminContext,
  input: {
    request: ApprovalRequest;
    approval: ApprovalRequestApproval;
  }
): Promise<ApprovalStepGuideResult> {
  try {
    const resolvedTransport = await resolveApprovalNotificationTransport(c, {
      request: input.request,
      approval: input.approval,
      strictMethod: !!input.approval.method,
    });
    const guide = describeApprovalCompletionMethod({
      method: resolvedTransport.method,
      transportChannel: resolvedTransport.transportChannel,
      acceptableMethods: resolvedTransport.acceptableMethods,
    });

    return {
      request_id: input.request.public_request_id,
      approval_id: input.approval.id,
      step_key: input.approval.step_key,
      status: input.approval.status,
      expires_at: input.approval.expires_at,
      selection_source: resolvedTransport.source,
      resolution_error: null,
      guide: {
        mode: resolveApprovalCompletionMode(resolvedTransport.method),
        method: resolvedTransport.method,
        transport_channel: guide.transport_channel,
        acceptable_methods: guide.acceptable_methods,
        guidance_title: guide.guidance_title,
        guidance_body: guide.guidance_body,
        fallback_note: guide.fallback_note,
      },
    };
  } catch (error) {
    return {
      request_id: input.request.public_request_id,
      approval_id: input.approval.id,
      step_key: input.approval.step_key,
      status: input.approval.status,
      expires_at: input.approval.expires_at,
      selection_source: null,
      resolution_error: error instanceof Error ? error.message : 'Failed to resolve approval step guide',
      guide: null,
    };
  }
}
