export interface Phase5DeliverySafetyEvidence {
  version: 1;
  sourceEnvironment: 'stopped' | 'not_confirmed';
  historicalDelivery: 'hold' | 'resume' | 'unknown';
  scheduledCatchup: 'disabled' | 'enabled' | 'unknown';
  activation: 'new_events_only' | 'historical_and_new' | 'unknown';
}

export function parsePhase5DeliverySafety(value: unknown): Phase5DeliverySafetyEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('backup_phase5_delivery_invalid');
  const evidence = value as Record<string, unknown>;
  if (
    Object.keys(evidence).sort().join(',') !==
      'activation,historicalDelivery,scheduledCatchup,sourceEnvironment,version' ||
    evidence.version !== 1 ||
    !['stopped', 'not_confirmed'].includes(evidence.sourceEnvironment as string) ||
    !['hold', 'resume', 'unknown'].includes(evidence.historicalDelivery as string) ||
    !['disabled', 'enabled', 'unknown'].includes(evidence.scheduledCatchup as string) ||
    !['new_events_only', 'historical_and_new', 'unknown'].includes(evidence.activation as string)
  )
    throw new Error('backup_phase5_delivery_invalid');
  return evidence as unknown as Phase5DeliverySafetyEvidence;
}

/**
 * Fails closed unless the operator/runtime evidence proves that restoring settings cannot replay
 * historical webhook, notification, or log-delivery work.
 */
export function assertPhase5DeliverySafety(
  value: unknown
): asserts value is Phase5DeliverySafetyEvidence {
  let evidence: Phase5DeliverySafetyEvidence;
  try {
    evidence = parsePhase5DeliverySafety(value);
  } catch {
    throw new Error('backup_phase5_delivery_unsafe');
  }
  if (
    evidence.sourceEnvironment !== 'stopped' ||
    evidence.historicalDelivery !== 'hold' ||
    evidence.scheduledCatchup !== 'disabled' ||
    evidence.activation !== 'new_events_only'
  )
    throw new Error('backup_phase5_delivery_unsafe');
}
