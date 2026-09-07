import type { AgentRateLimiterPort, AgentRateLimitRequest, AgentRateLimitResult } from '../ports';

interface CloudflareRateLimiterStub {
  incrementRpc(
    key: string,
    config: { windowSeconds: number; maxRequests: number }
  ): Promise<{ allowed: boolean; current: number; limit: number; resetAt: number }>;
}

export interface CloudflareRateLimiterNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): CloudflareRateLimiterStub;
}

/** Existing RateLimiterCounter DO adapted to the platform-neutral Agent rate-limit port. */
export class CloudflareDurableObjectRateLimiter implements AgentRateLimiterPort {
  constructor(private readonly namespace: CloudflareRateLimiterNamespace) {}

  async consume(request: AgentRateLimitRequest): Promise<AgentRateLimitResult> {
    if (
      !request.key ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      !Number.isSafeInteger(request.windowSeconds) ||
      request.windowSeconds < 1 ||
      (request.cost !== undefined && request.cost !== 1)
    ) {
      throw new TypeError('Invalid Agent rate-limit request');
    }
    const id = this.namespace.idFromName(`agent-access:${request.key}`);
    const result = await this.namespace.get(id).incrementRpc(request.key, {
      windowSeconds: request.windowSeconds,
      maxRequests: request.limit,
    });
    return {
      allowed: result.allowed,
      remaining: Math.max(0, result.limit - result.current),
      resetAt: result.resetAt,
    };
  }
}
