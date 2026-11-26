import { describe, expect, it, vi } from 'vitest';
import { PolicyEngine } from '../engine';
import type { PolicyContext, PolicyRule } from '../types';

const from = 1_700_000_000;
const to = 1_700_003_600;

const rule: PolicyRule = {
  id: 'rule',
  name: 'rule',
  priority: 1,
  effect: 'allow',
  conditions: [{ type: 'valid_during', params: { from, to } }],
};

function allowed(timestamp: number): boolean {
  const engine = new PolicyEngine({ defaultDecision: 'deny' });
  engine.addRules([rule]);
  const context: PolicyContext = {
    subject: { id: 'user-1', roles: [] },
    resource: { type: 'report', id: 'r1' },
    action: { name: 'read' },
    timestamp,
  };
  return engine.evaluate(context).allowed;
}

describe('valid_during is judged at the request time', () => {
  it('allows inside the period and denies outside it', () => {
    expect(allowed((from + 10) * 1000)).toBe(true);
    expect(allowed((from - 10) * 1000)).toBe(false);
    expect(allowed((to + 10) * 1000)).toBe(false);
  });

  it('falls back to the current time for an invalid timestamp, like other time conditions', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime((to + 100) * 1000);
      expect(allowed(Number.NaN)).toBe(false);
      expect(allowed('x' as unknown as number)).toBe(false);
      vi.setSystemTime((from + 10) * 1000);
      expect(allowed(Number.NaN)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
