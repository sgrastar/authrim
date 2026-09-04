export const CLOUDFLARE_SERVICE_BINDING_INVOCATION_LIMIT = 32;

export interface ServiceBindingInvocationBudget {
  tryConsume(count?: number): boolean;
  readonly remaining: number;
}

export class BoundedServiceBindingInvocationBudget implements ServiceBindingInvocationBudget {
  private consumed = 0;

  constructor(private readonly limit = CLOUDFLARE_SERVICE_BINDING_INVOCATION_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('control_service_binding_invocation_limit_invalid');
    }
  }

  get remaining(): number {
    return this.limit - this.consumed;
  }

  tryConsume(count = 1): boolean {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error('control_service_binding_invocation_count_invalid');
    }
    if (count > this.remaining) return false;
    this.consumed += count;
    return true;
  }
}

export function consumeServiceBindingInvocation(
  budget: ServiceBindingInvocationBudget | undefined,
  count = 1
): boolean {
  return budget?.tryConsume(count) ?? true;
}
