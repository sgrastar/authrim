import { describe, expect, it } from 'vitest';
import {
  BoundedServiceBindingInvocationBudget,
  CLOUDFLARE_SERVICE_BINDING_INVOCATION_LIMIT,
} from '../service-binding-invocation-budget';

describe('Service Binding invocation budget', () => {
  it('never admits more than the Cloudflare per-request limit', () => {
    const budget = new BoundedServiceBindingInvocationBudget();

    expect(budget.tryConsume(31)).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.remaining).toBe(0);
    expect(CLOUDFLARE_SERVICE_BINDING_INVOCATION_LIMIT).toBe(32);
  });

  it('rejects invalid consumption without changing the remaining allowance', () => {
    const budget = new BoundedServiceBindingInvocationBudget(2);

    expect(() => budget.tryConsume(0)).toThrow('control_service_binding_invocation_count_invalid');
    expect(budget.remaining).toBe(2);
  });
});
