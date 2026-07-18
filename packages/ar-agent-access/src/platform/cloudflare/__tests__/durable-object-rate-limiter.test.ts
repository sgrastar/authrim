import { describe, expect, it, vi } from 'vitest';
import { CloudflareDurableObjectRateLimiter } from '../durable-object-rate-limiter';

describe('CloudflareDurableObjectRateLimiter', () => {
  it('adapts the existing atomic DO counter without exposing it to core/protocol', async () => {
    const incrementRpc = vi.fn().mockResolvedValue({
      allowed: true,
      current: 2,
      limit: 5,
      resetAt: 160,
    });
    const namespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ incrementRpc })),
    };
    const adapter = new CloudflareDurableObjectRateLimiter(namespace);

    await expect(
      adapter.consume({ key: 'tenant:grant:tool', limit: 5, windowSeconds: 60 })
    ).resolves.toEqual({ allowed: true, remaining: 3, resetAt: 160 });
    expect(namespace.idFromName).toHaveBeenCalledWith('agent-access:tenant:grant:tool');
    expect(incrementRpc).toHaveBeenCalledWith('tenant:grant:tool', {
      maxRequests: 5,
      windowSeconds: 60,
    });
  });

  it('rejects unsupported weighted costs instead of silently undercounting', async () => {
    const adapter = new CloudflareDurableObjectRateLimiter({
      idFromName: vi.fn(),
      get: vi.fn(),
    });
    await expect(
      adapter.consume({ key: 'key', limit: 1, windowSeconds: 1, cost: 2 })
    ).rejects.toThrow('Invalid Agent rate-limit request');
  });
});
