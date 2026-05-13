import type { ApprovalApproverSubjectType, ApprovalTransportMethod } from '@authrim/ar-lib-core';

export type ApprovalCompletionMode = 'artifact_only' | 'step_up_required';

export interface ApprovalCompletionRequirementsView {
  mode: ApprovalCompletionMode;
  method: ApprovalTransportMethod;
  acceptable_methods: ApprovalTransportMethod[];
  artifact_path: string;
  portal_path: string;
  switch_method_path: string | null;
  assertion_endpoints: {
    options?: string;
    verify?: string;
    assert?: string;
    start?: string;
    status?: string;
    device?: string;
  } | null;
  transport_channel: string | null;
  guidance_title: string;
  guidance_body: string;
  fallback_note: string | null;
  approver_binding: {
    subject_type: ApprovalApproverSubjectType;
    subject_id: string | null;
    relation_type: string | null;
    relation_source: string | null;
  };
}

function maskEmail(value: string): string {
  const [localPart, domain] = value.split('@');
  if (!localPart || !domain) {
    return value;
  }
  if (localPart.length <= 2) {
    return `${localPart[0] ?? '*'}*@${domain}`;
  }
  return `${localPart.slice(0, 2)}***@${domain}`;
}

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) {
    return `••${digits}`;
  }
  return `••••${digits.slice(-4)}`;
}

function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function looksLikePhone(value: string): boolean {
  return /^\+?[0-9().\-\s]{6,}$/.test(value);
}

export function resolveApprovalCompletionMode(
  method: ApprovalTransportMethod
): ApprovalCompletionMode {
  return method === 'passkey' ||
    method === 'reauth' ||
    method === 'ciba' ||
    method === 'email_otp' ||
    method === 'sms_otp'
    ? 'step_up_required'
    : 'artifact_only';
}

function buildAssertionEndpoints(artifactId: string, method: ApprovalTransportMethod) {
  const encodedArtifactId = encodeURIComponent(artifactId);
  if (method === 'passkey') {
    return {
      options: `/api/approval-artifacts/${encodedArtifactId}/passkey/options`,
      verify: `/api/approval-artifacts/${encodedArtifactId}/passkey/verify`,
    };
  }
  if (method === 'reauth') {
    return {
      assert: `/api/approval-artifacts/${encodedArtifactId}/reauth/assert`,
    };
  }
  if (method === 'email_otp' || method === 'sms_otp') {
    return {
      verify: `/api/approval-artifacts/${encodedArtifactId}/otp/verify`,
    };
  }
  if (method === 'ciba') {
    return {
      start: `/api/approval-artifacts/${encodedArtifactId}/ciba/start`,
      status: `/api/approval-artifacts/${encodedArtifactId}/ciba/status`,
      device: `/api/approval-artifacts/${encodedArtifactId}/ciba/device`,
    };
  }
  return null;
}

function formatDisplayTransportChannel(
  method: ApprovalTransportMethod,
  transportChannel: string | null
): string | null {
  if (method === 'portal_confirm') {
    return 'Authrim approval portal';
  }
  if (method === 'passkey') {
    return 'Registered passkey on this device';
  }
  if (method === 'reauth') {
    return 'Current authenticated admin session';
  }
  if (method === 'ciba') {
    return 'Registered authentication device';
  }

  if (!transportChannel) {
    return method === 'email_otp'
      ? 'Verified email address'
      : method === 'sms_otp'
        ? 'Verified phone number'
        : null;
  }

  if (looksLikeEmail(transportChannel)) {
    return maskEmail(transportChannel);
  }
  if (looksLikePhone(transportChannel)) {
    return maskPhone(transportChannel);
  }
  return transportChannel;
}

function buildGuidance(method: ApprovalTransportMethod, displayChannel: string | null) {
  switch (method) {
    case 'portal_confirm':
      return {
        title: 'Review And Confirm In Portal',
        body: 'Review the request details on this page and choose Approve or Deny directly in the portal.',
      };
    case 'email_otp':
      return {
        title: 'Approve With Email Code',
        body: `Enter the 6-digit code delivered to ${displayChannel ?? 'your verified email address'}, then confirm the request.`,
      };
    case 'sms_otp':
      return {
        title: 'Approve With SMS Code',
        body: `Enter the 6-digit code delivered to ${displayChannel ?? 'your verified phone number'}, then confirm the request.`,
      };
    case 'passkey':
      return {
        title: 'Approve With Passkey',
        body: 'Use a registered passkey from the current browser or security key to complete the approval.',
      };
    case 'reauth':
      return {
        title: 'Reconfirm Current Session',
        body: 'Reconfirm the action with the currently authenticated admin session before completing the approval.',
      };
    case 'ciba':
      return {
        title: 'Approve On Authentication Device',
        body: 'Start the backchannel approval request, continue on the linked authentication device, then return here to complete the request.',
      };
    default:
      return {
        title: 'Complete Approval',
        body: 'Follow the configured completion method to approve or deny this request.',
      };
  }
}

function buildFallbackNote(
  method: ApprovalTransportMethod,
  acceptableMethods: ApprovalTransportMethod[]
): string | null {
  const fallbackMethods = acceptableMethods.filter((candidate) => candidate !== method);
  if (fallbackMethods.length === 0) {
    return null;
  }
  return `If this method is unavailable, re-issue the approval artifact with one of: ${fallbackMethods.join(', ')}.`;
}

export interface ApprovalCompletionMethodGuide {
  method: ApprovalTransportMethod;
  transport_channel: string | null;
  acceptable_methods: ApprovalTransportMethod[];
  guidance_title: string;
  guidance_body: string;
  fallback_note: string | null;
}

export function describeApprovalCompletionMethod(input: {
  method: ApprovalTransportMethod;
  transportChannel: string | null;
  acceptableMethods?: ApprovalTransportMethod[];
}): ApprovalCompletionMethodGuide {
  const acceptableMethods = Array.from(
    new Set([input.method, ...(input.acceptableMethods ?? [input.method])])
  );
  const displayChannel = formatDisplayTransportChannel(input.method, input.transportChannel);
  const guidance = buildGuidance(input.method, displayChannel);

  return {
    method: input.method,
    transport_channel: displayChannel,
    acceptable_methods: acceptableMethods,
    guidance_title: guidance.title,
    guidance_body: guidance.body,
    fallback_note: buildFallbackNote(input.method, acceptableMethods),
  };
}

export function buildApprovalCompletionRequirements(input: {
  artifactId: string;
  method: ApprovalTransportMethod;
  transportChannel: string | null;
  acceptableMethods?: ApprovalTransportMethod[];
  approval: {
    subject_type: ApprovalApproverSubjectType;
    subject_id: string | null;
    relation_type: string | null;
    relation_source: string | null;
  };
}): ApprovalCompletionRequirementsView {
  const mode = resolveApprovalCompletionMode(input.method);
  const guide = describeApprovalCompletionMethod({
    method: input.method,
    transportChannel: input.transportChannel,
    acceptableMethods: input.acceptableMethods,
  });
  const encodedArtifactId = encodeURIComponent(input.artifactId);

  return {
    mode,
    method: guide.method,
    acceptable_methods: guide.acceptable_methods,
    artifact_path: `/api/approval-artifacts/${encodedArtifactId}`,
    portal_path: `/api/approval-artifacts/${encodedArtifactId}/portal`,
    switch_method_path:
      guide.acceptable_methods.filter((method) => method !== guide.method).length > 0
        ? `/api/approval-artifacts/${encodedArtifactId}/switch-method`
        : null,
    assertion_endpoints: buildAssertionEndpoints(input.artifactId, input.method),
    transport_channel: guide.transport_channel,
    guidance_title: guide.guidance_title,
    guidance_body: guide.guidance_body,
    fallback_note: guide.fallback_note,
    approver_binding: {
      subject_type: input.approval.subject_type,
      subject_id: input.approval.subject_id,
      relation_type: input.approval.relation_type,
      relation_source: input.approval.relation_source,
    },
  };
}
