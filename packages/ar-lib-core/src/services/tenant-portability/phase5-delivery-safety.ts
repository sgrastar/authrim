export interface Phase5DeliverySafetyEvidence {
  version: 1;
  sourceEnvironment: 'stopped';
  historicalDelivery: 'hold';
  scheduledCatchup: 'disabled';
  activation: 'new_events_only';
}

/**
 * Fails closed unless the operator/runtime evidence proves that restoring settings cannot replay
 * historical webhook, notification, or log-delivery work.
 */
export function assertPhase5DeliverySafety(
  value: unknown
): asserts value is Phase5DeliverySafetyEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('backup_phase5_delivery_unsafe');
  const evidence = value as Record<string, unknown>;
  if (
    Object.keys(evidence).sort().join(',') !==
      'activation,historicalDelivery,scheduledCatchup,sourceEnvironment,version' ||
    evidence.version !== 1 ||
    evidence.sourceEnvironment !== 'stopped' ||
    evidence.historicalDelivery !== 'hold' ||
    evidence.scheduledCatchup !== 'disabled' ||
    evidence.activation !== 'new_events_only'
  )
    throw new Error('backup_phase5_delivery_unsafe');
}
