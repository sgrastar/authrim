import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.hoisted(() => vi.fn());
vi.mock('../core/generated-smoke-common.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/generated-smoke-common.js')>();
  return { ...actual, fetchJsonWithTimeout: fetchJson };
});

import { ensureGeneratedTokenExchangeEnabled } from '../core/generated-token-exchange-settings.js';

const input = {
  baseUrl: 'https://issuer.test',
  timeoutMs: 100,
  adminSecret: 'secret',
  tenantId: 'tenant-a',
  checkId: 'token-exchange',
  title: 'token exchange',
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      enabled: { value: false, source: 'default' },
      allowedSubjectTokenTypes: { value: ['refresh_token'], source: 'default' },
      maxResourceParams: { value: 4, source: 'default' },
      maxAudienceParams: { value: 5, source: 'default' },
      ...overrides,
    },
  };
}

describe('ensureGeneratedTokenExchangeEnabled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchJson.mockReset();
  });

  it('leaves already-compatible settings unchanged', async () => {
    fetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      payload: snapshot({
        enabled: { value: true, source: 'env' },
        allowedSubjectTokenTypes: { value: ['access_token'], source: 'env' },
      }),
    });

    const result = await ensureGeneratedTokenExchangeEnabled(input);

    expect(result.check.status).toBe('pass');
    expect(fetchJson).toHaveBeenCalledOnce();
    await expect(result.restore()).resolves.toBeNull();
  });

  it('enables access-token exchange then deletes a temporary override on restore', async () => {
    fetchJson
      .mockResolvedValueOnce({ ok: true, status: 200, payload: snapshot() })
      .mockResolvedValueOnce({ ok: true, status: 200, payload: {} })
      .mockResolvedValueOnce({ ok: true, status: 204, payload: {} });

    const promise = ensureGeneratedTokenExchangeEnabled(input);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.check.status).toBe('warn');
    expect(JSON.parse(fetchJson.mock.calls[1][2].body)).toMatchObject({
      enabled: true,
      allowedSubjectTokenTypes: ['refresh_token', 'access_token'],
    });
    const restored = await result.restore();
    expect(restored?.status).toBe('pass');
    expect(fetchJson.mock.calls[2][2]).toMatchObject({ method: 'DELETE' });
  });

  it('restores the previous nested KV-backed snapshot with PUT', async () => {
    fetchJson
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: snapshot({
          idJag: {
            enabled: { value: true, source: 'kv' },
            allowedIssuers: { value: ['https://issuer-a'], source: 'kv' },
            maxTokenLifetime: { value: 600, source: 'kv' },
            includeTenantClaim: { value: false, source: 'kv' },
            requireConfidentialClient: { value: false, source: 'kv' },
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, payload: {} })
      .mockResolvedValueOnce({ ok: false, status: 503, error: 'unavailable' });
    const promise = ensureGeneratedTokenExchangeEnabled(input);
    await vi.runAllTimersAsync();
    const result = await promise;
    const restored = await result.restore();

    expect(fetchJson.mock.calls[2][2]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(fetchJson.mock.calls[2][2].body).idJag).toEqual({
      enabled: true,
      allowedIssuers: ['https://issuer-a'],
      maxTokenLifetime: 600,
      includeTenantClaim: false,
      requireConfidentialClient: false,
    });
    expect(restored?.status).toBe('warn');
  });

  it('returns actionable checks for read, parse, and update failures', async () => {
    fetchJson.mockResolvedValueOnce({ ok: false, status: 401, error: 'unauthorized' });
    expect((await ensureGeneratedTokenExchangeEnabled(input)).check).toMatchObject({
      status: 'fail',
      httpStatus: 401,
    });

    fetchJson.mockResolvedValueOnce({ ok: true, status: 200, payload: { settings: null } });
    expect((await ensureGeneratedTokenExchangeEnabled(input)).check.status).toBe('fail');

    fetchJson
      .mockResolvedValueOnce({ ok: true, status: 200, payload: snapshot() })
      .mockResolvedValueOnce({ ok: false, status: 403, bodyText: 'forbidden' });
    expect((await ensureGeneratedTokenExchangeEnabled(input)).check.status).toBe('fail');
  });

  it('retries a rate-limited settings request only when retry_after is usable', async () => {
    fetchJson
      .mockResolvedValueOnce({ ok: false, status: 429, payload: { retry_after: 1 } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: snapshot({
          enabled: { value: true },
          allowedSubjectTokenTypes: { value: ['access_token'] },
        }),
      });
    const promise = ensureGeneratedTokenExchangeEnabled(input);
    await vi.runAllTimersAsync();
    expect((await promise).check.status).toBe('pass');
    expect(fetchJson).toHaveBeenCalledTimes(2);

    fetchJson.mockReset().mockResolvedValue({
      ok: false,
      status: 429,
      payload: { retry_after: 0 },
    });
    expect((await ensureGeneratedTokenExchangeEnabled(input)).check.status).toBe('fail');
    expect(fetchJson).toHaveBeenCalledOnce();
  });
});
