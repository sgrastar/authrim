import { describe, expect, it } from 'vitest';
import { assertPhase5DeliverySafety } from '../phase5-delivery-safety';

const safe = {
  version: 1,
  sourceEnvironment: 'stopped',
  historicalDelivery: 'hold',
  scheduledCatchup: 'disabled',
  activation: 'new_events_only',
};

describe('Phase 5 delivery activation safety', () => {
  it('accepts the exact stopped-source and new-events-only contract', () => {
    expect(() => assertPhase5DeliverySafety(safe)).not.toThrow();
  });

  it.each([
    ['source still running', { ...safe, sourceEnvironment: 'running' }],
    ['historical work enabled', { ...safe, historicalDelivery: 'resume' }],
    ['scheduled catchup enabled', { ...safe, scheduledCatchup: 'enabled' }],
    ['old events enabled', { ...safe, activation: 'all_events' }],
    ['unrecognized evidence field', { ...safe, approvedBy: 'operator' }],
  ])('rejects %s', (_label, value) => {
    expect(() => assertPhase5DeliverySafety(value)).toThrow('backup_phase5_delivery_unsafe');
  });
});
