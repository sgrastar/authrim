import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareSecretTextKeyProvider,
  CloudflareServiceBindingBulkChildExecutor,
  CloudflareServiceBindingDownscopeTokenProvider,
  CloudflareServiceBindingRateLimiter,
  CloudflareServiceBindingSecretKeyProvider,
} from '../platform/cloudflare/service-binding';

const HEX = Array.from({ length: 32 }, (_, index) => (index * 7 + 3).toString(16).padStart(2, '0'))
  .join('')
  .toUpperCase();

async function roundTrip(key: CryptoKey): Promise<string> {
  const reference = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from({ length: 32 }, (_, index) => index * 7 + 3),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const iv = new Uint8Array(12);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode('payload')
  );
  return new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, reference, sealed)
  );
}

describe('CloudflareSecretTextKeyProvider', () => {
  it('imports the exact 32 hex-decoded bytes as a non-extractable AES-GCM key', async () => {
    const key = await new CloudflareSecretTextKeyProvider({ v2: HEX }).getEncryptionKey('v2');
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.usages.sort()).toEqual(['decrypt', 'encrypt']);
    await expect(roundTrip(key)).resolves.toBe('payload');
  });

  it.each([
    ['too short', HEX.slice(2)],
    ['with a prefix', `x${HEX}`],
    ['with a suffix', `${HEX}0`],
    ['non-hex', 'g'.repeat(64)],
  ])('rejects key material that is %s', async (_name, value) => {
    await expect(
      new CloudflareSecretTextKeyProvider({ v1: value }).getEncryptionKey('v1')
    ).rejects.toThrow(
      new TypeError('Agent elevation encryption key must be 32-byte hexadecimal data')
    );
  });

  it('rejects an unconfigured key version and any signing key request', async () => {
    const provider = new CloudflareSecretTextKeyProvider({ v1: HEX });
    await expect(provider.getEncryptionKey('v9')).rejects.toThrow(
      new TypeError('Agent elevation encryption key is unavailable')
    );
    await expect(provider.getSigningKey('v1')).rejects.toThrow(
      new TypeError('Signing keys are not configured by this provider')
    );
  });
});

describe('binding delegations', () => {
  it('passes rate-limit and key requests straight to the bindings', async () => {
    const result = { allowed: true, remaining: 1, resetAt: 2 };
    const consume = vi.fn(async () => result);
    const request = { key: 'k', limit: 1, windowSeconds: 60 };
    await expect(
      new CloudflareServiceBindingRateLimiter({ consume }).consume(request)
    ).resolves.toBe(result);
    expect(consume).toHaveBeenCalledWith(request);

    const signing = { type: 'signing' } as unknown as CryptoKey;
    const encryption = { type: 'encryption' } as unknown as CryptoKey;
    const binding = {
      getSigningKey: vi.fn(async () => signing),
      getEncryptionKey: vi.fn(async () => encryption),
    };
    const provider = new CloudflareServiceBindingSecretKeyProvider(binding);
    await expect(provider.getSigningKey('s-1')).resolves.toBe(signing);
    await expect(provider.getEncryptionKey('e-1')).resolves.toBe(encryption);
    expect(binding.getSigningKey).toHaveBeenCalledWith('s-1');
    expect(binding.getEncryptionKey).toHaveBeenCalledWith('e-1');
  });
});

describe('CloudflareServiceBindingDownscopeTokenProvider expiry', () => {
  const request = {
    tenantId: 't',
    authorization: { actor: {}, issuerOrigin: 'https://i.example' },
  } as never;

  it('rejects an exchanged token that expires exactly now, using the wall clock by default', async () => {
    const exchange = vi.fn(async () => ({ accessToken: 'down', expiresAt: 500 }));
    const binding = { exchangeAgentAccessToken: exchange, issueAgentBulkChildToken: vi.fn() };
    await expect(
      new CloudflareServiceBindingDownscopeTokenProvider(
        binding,
        () => 'src',
        () => 500
      ).getToken(request)
    ).rejects.toThrow('Agent Access downscope exchange returned an invalid token');
    await expect(
      new CloudflareServiceBindingDownscopeTokenProvider(binding, () => 'src').getToken(request)
    ).rejects.toThrow('Agent Access downscope exchange returned an invalid token');
    await expect(
      new CloudflareServiceBindingDownscopeTokenProvider(
        binding,
        () => 'src',
        () => 499
      ).getToken(request)
    ).resolves.toBe('down');
  });
});

describe('CloudflareServiceBindingBulkChildExecutor', () => {
  const bindingFields = {
    controlTenantId: 'control-1',
    targetTenantId: 'target-1',
    bulkPlanId: 'plan-1',
    bulkPlanVersion: 2,
    executionId: 'exec-1',
    executionAttempt: 1,
    executionFence: 4,
    stage: 'canary',
    planDigest: 'pd',
    approvalDigest: 'ad',
  };
  const request = {
    binding: bindingFields,
    childCapabilityDigest: 'cd',
    issuerOrigin: 'https://control.example',
    correlationId: 'corr-1',
    operation: 'users.update',
    input: { user_id: 'u-1' },
    idempotencyKey: 'idem-1',
  } as never;
  const routes = { 'users.update': { method: 'PATCH' as const, path: '/api/admin/users/u-1' } };

  function executor(issued: { accessToken: string; expiresAt: number }, now?: () => number) {
    const fetch = vi.fn(async (_request: Request) => Response.json({ ok: true }));
    const issue = vi.fn(async () => issued);
    const tokenService = { exchangeAgentAccessToken: vi.fn(), issueAgentBulkChildToken: issue };
    return {
      fetch,
      issue,
      run: new CloudflareServiceBindingBulkChildExecutor({ fetch }, routes, tokenService, now),
    };
  }

  it('issues a child token bound to the plan stage and calls the target tenant', async () => {
    const { fetch, issue, run } = executor({ accessToken: 'child', expiresAt: 1_000 }, () => 999);
    await expect(run.execute(request)).resolves.toMatchObject({ status: 200, body: { ok: true } });
    expect(issue).toHaveBeenCalledWith({
      issuerOrigin: 'https://control.example',
      audience: 'authrim:admin-api',
      ...bindingFields,
      childCapabilityDigest: 'cd',
      correlationId: 'corr-1',
    });
    const sent = fetch.mock.calls[0]?.[0];
    expect(sent.method).toBe('PATCH');
    expect(sent.headers.get('authorization')).toBe('Bearer child');
    expect(sent.headers.get('x-tenant-id')).toBe('target-1');
    expect(sent.headers.get('idempotency-key')).toBe('idem-1');
    expect(sent.headers.get('x-correlation-id')).toBe('corr-1');
  });

  it.each([
    ['an empty token', { accessToken: '', expiresAt: 2_000 }, () => 1_000],
    ['a token expiring now', { accessToken: 'child', expiresAt: 1_000 }, () => 1_000],
    ['an expired token with the default clock', { accessToken: 'child', expiresAt: 1 }, undefined],
  ])('refuses %s before calling Management', async (_name, issued, now) => {
    const { fetch, run } = executor(issued, now);
    await expect(run.execute(request)).rejects.toThrow('Agent Bulk child token is unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });
});
