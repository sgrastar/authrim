import type {
  ApprovalRequest,
  ApprovalRequestApproval,
  ApprovalTransportMethod,
} from '@authrim/ar-lib-core';

export type ApprovalNotificationPolicySource =
  | 'explicit_override'
  | 'approval_step'
  | 'policy_default';

export interface ApprovalNotificationPolicyResolution {
  method: ApprovalTransportMethod;
  transportChannel: string | null;
  acceptableMethods: ApprovalTransportMethod[];
  source: ApprovalNotificationPolicySource;
}

type RequestPolicyContext = Pick<
  ApprovalRequest,
  'policy_preset' | 'target_subject_type' | 'request_surface' | 'requested_action'
>;

type ApprovalPolicyContext = Pick<
  ApprovalRequestApproval,
  'side' | 'subject_type' | 'subject_id' | 'method' | 'transport_channel'
>;

function normalizeChannel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function looksLikePhone(value: string): boolean {
  return /^\+?[0-9().\-\s]{6,}$/.test(value);
}

function dedupeMethods(methods: readonly ApprovalTransportMethod[]): ApprovalTransportMethod[] {
  return Array.from(new Set(methods));
}

function resolveDefaultMethodOrder(
  request: RequestPolicyContext,
  approval: ApprovalPolicyContext
): ApprovalTransportMethod[] {
  const isHighAssurancePreset =
    request.policy_preset === 'security_investigation_default' ||
    request.policy_preset === 'compliance_review_default';

  if (approval.side === 'admin_operator' || approval.subject_type === 'admin_user') {
    if (isHighAssurancePreset) {
      return ['passkey', 'reauth', 'portal_confirm'];
    }
    return ['portal_confirm', 'passkey', 'reauth'];
  }

  if (approval.subject_type === 'service_principal') {
    return ['reauth', 'portal_confirm'];
  }

  if (approval.side === 'guardian_delegate') {
    if (isHighAssurancePreset) {
      return ['ciba', 'portal_confirm', 'email_otp', 'sms_otp', 'passkey', 'reauth'];
    }
    return ['portal_confirm', 'email_otp', 'sms_otp', 'ciba', 'passkey', 'reauth'];
  }

  if (isHighAssurancePreset) {
    return ['ciba', 'portal_confirm', 'email_otp', 'sms_otp', 'passkey', 'reauth'];
  }

  return ['portal_confirm', 'email_otp', 'sms_otp', 'ciba', 'passkey', 'reauth'];
}

function resolveDefaultTransportChannel(
  approval: ApprovalPolicyContext,
  method: ApprovalTransportMethod
): string | null {
  if (method === 'email_otp' || method === 'sms_otp') {
    const subjectId = normalizeChannel(approval.subject_id);
    if (!subjectId) {
      return null;
    }
    if (method === 'email_otp' && looksLikeEmail(subjectId)) {
      return subjectId;
    }
    if (method === 'sms_otp' && looksLikePhone(subjectId)) {
      return subjectId;
    }
    return null;
  }

  return method;
}

export function resolveApprovalNotificationPolicy(input: {
  request: RequestPolicyContext;
  approval: ApprovalPolicyContext;
  overrideMethod?: ApprovalTransportMethod | null;
  overrideTransportChannel?: string | null;
}): ApprovalNotificationPolicyResolution {
  const { request, approval } = input;
  const explicitMethod = input.overrideMethod ?? null;
  const stepMethod = approval.method ?? null;
  const acceptableMethods = resolveDefaultMethodOrder(request, approval);

  let source: ApprovalNotificationPolicySource = 'policy_default';
  let method: ApprovalTransportMethod;
  if (explicitMethod) {
    method = explicitMethod;
    source = 'explicit_override';
  } else if (stepMethod) {
    method = stepMethod;
    source = 'approval_step';
  } else {
    method = acceptableMethods[0] ?? 'portal_confirm';
  }

  const resolvedChannel =
    normalizeChannel(input.overrideTransportChannel) ??
    normalizeChannel(approval.transport_channel) ??
    resolveDefaultTransportChannel(approval, method);

  return {
    method,
    transportChannel: resolvedChannel,
    acceptableMethods: dedupeMethods([method, ...acceptableMethods]),
    source,
  };
}
