export const APPROVAL_PRESETS = {
  support_case_default: { requestTtlSeconds: 15 * 60 },
  technical_debug_default: { requestTtlSeconds: 15 * 60 },
  security_investigation_default: { requestTtlSeconds: 5 * 60 },
  guardian_support_default: { requestTtlSeconds: 30 * 60 },
  compliance_review_default: { requestTtlSeconds: 15 * 60 },
} as const;

export const APPROVAL_NOTIFICATION_COOLDOWN_SECONDS = {
  default: {
    remind: 5 * 60,
    resend: 10 * 60,
  },
  support_case_default: {
    remind: 5 * 60,
    resend: 10 * 60,
  },
  technical_debug_default: {
    remind: 5 * 60,
    resend: 10 * 60,
  },
  security_investigation_default: {
    remind: 5 * 60,
    resend: 10 * 60,
  },
  guardian_support_default: {
    remind: 5 * 60,
    resend: 10 * 60,
  },
  compliance_review_default: {
    remind: 5 * 60,
    resend: 10 * 60,
  },
} as const;

export type ApprovalPolicyPreset = keyof typeof APPROVAL_PRESETS;
export type ApprovalNotificationCooldownAction = 'remind' | 'resend';

export interface ApprovalResolvedPolicySummary {
  preset: ApprovalPolicyPreset | string;
  request_ttl_seconds: number | null;
  notification_cooldown_seconds: {
    remind: number;
    resend: number;
  };
}

export function getApprovalPresetExpiry(policyPreset: ApprovalPolicyPreset): number {
  return Date.now() + APPROVAL_PRESETS[policyPreset].requestTtlSeconds * 1000;
}

export function getApprovalNotificationCooldownMs(
  policyPreset: string,
  action: ApprovalNotificationCooldownAction
): number {
  const presetCooldown =
    APPROVAL_NOTIFICATION_COOLDOWN_SECONDS[
      policyPreset as keyof typeof APPROVAL_NOTIFICATION_COOLDOWN_SECONDS
    ] ?? APPROVAL_NOTIFICATION_COOLDOWN_SECONDS.default;
  return presetCooldown[action] * 1000;
}

export function resolveApprovalEffectivePolicy(
  policyPreset: ApprovalPolicyPreset | string
): ApprovalResolvedPolicySummary {
  const preset =
    APPROVAL_NOTIFICATION_COOLDOWN_SECONDS[
      policyPreset as keyof typeof APPROVAL_NOTIFICATION_COOLDOWN_SECONDS
    ] ?? APPROVAL_NOTIFICATION_COOLDOWN_SECONDS.default;
  const ttl =
    APPROVAL_PRESETS[policyPreset as ApprovalPolicyPreset]?.requestTtlSeconds ?? null;

  return {
    preset: policyPreset,
    request_ttl_seconds: ttl,
    notification_cooldown_seconds: {
      remind: preset.remind,
      resend: preset.resend,
    },
  };
}
