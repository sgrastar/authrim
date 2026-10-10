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
const url = 'https://issuer.test/api/admin/tenants/tenant-a/settings/tokens';
const ENABLED = 'tokens.exchange_enabled';
const DELEGATION = 'tokens.exchange_delegation_enabled';
const TYPES = 'tokens.exchange_allowed_subject_token_types';

function settings(
  values: Record<string, unknown> = {},
  sources: Record<string, string> = {},
  version = 'v1'
) {
  return {
    ok: true,
    status: 200,
    payload: {
      version,
      values: { [ENABLED]: false, [DELEGATION]: false, [TYPES]: 'jwt', ...values },
      sources: { [ENABLED]: 'default', [DELEGATION]: 'default', [TYPES]: 'default', ...sources },
    },
  };
}
const saved = { ok: true, status: 200, payload: { applied: [], rejected: {} } };
/** The settings while the temporary change is in place. */
const changed = settings(
  { [ENABLED]: true, [DELEGATION]: true, [TYPES]: 'jwt,access_token' },
  { [ENABLED]: 'kv', [DELEGATION]: 'kv', [TYPES]: 'kv' },
  'v2'
);

async function enable() {
  const promise = ensureGeneratedTokenExchangeEnabled(input);
  await vi.runAllTimersAsync();
  return promise;
}

describe('ensureGeneratedTokenExchangeEnabled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchJson.mockReset();
  });

  it('leaves already-compatible settings unchanged', async () => {
    fetchJson.mockResolvedValue(
      settings({ [ENABLED]: true, [DELEGATION]: true, [TYPES]: 'access_token' })
    );

    const result = await ensureGeneratedTokenExchangeEnabled(input);

    expect(result.check.status).toBe('pass');
    expect(fetchJson).toHaveBeenCalledOnce();
    expect(fetchJson.mock.calls[0][0]).toBe(url);
    await expect(result.restore()).resolves.toBeNull();
  });

  it('enables access-token exchange for the tenant, then clears what the tenant had not set', async () => {
    fetchJson
      .mockResolvedValueOnce(settings())
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce(saved);

    const result = await enable();
    expect(result.check.status).toBe('warn');
    expect(fetchJson.mock.calls[1][2].method).toBe('PATCH');
    expect(JSON.parse(fetchJson.mock.calls[1][2].body)).toEqual({
      ifMatch: 'v1',
      set: { [ENABLED]: true, [DELEGATION]: true, [TYPES]: 'jwt,access_token' },
    });

    const restored = await result.restore();
    expect(restored?.status).toBe('pass');
    expect(JSON.parse(fetchJson.mock.calls[3][2].body)).toEqual({
      ifMatch: 'v2',
      set: {},
      clear: [ENABLED, DELEGATION, TYPES],
    });
  });

  it("puts back the tenant's own values on restore", async () => {
    fetchJson
      .mockResolvedValueOnce(settings({ [ENABLED]: false }, { [ENABLED]: 'kv' }))
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce(saved);

    const result = await enable();
    await result.restore();
    expect(JSON.parse(fetchJson.mock.calls[3][2].body)).toEqual({
      ifMatch: 'v2',
      set: { [ENABLED]: false },
      clear: [DELEGATION, TYPES],
    });
  });

  it('fails when the settings cannot be read, are refused, or do not reach runtime', async () => {
    fetchJson.mockResolvedValueOnce({ ok: false, status: 503, payload: {} });
    const unreadable = await ensureGeneratedTokenExchangeEnabled(input);
    expect(unreadable.check.status).toBe('fail');
    await expect(unreadable.restore()).resolves.toBeNull();

    fetchJson.mockResolvedValueOnce(settings()).mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { applied: [], rejected: { [ENABLED]: 'not allowed' } },
    });
    expect((await ensureGeneratedTokenExchangeEnabled(input)).check.status).toBe('fail');

    fetchJson.mockResolvedValueOnce(settings()).mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { applied: [ENABLED], rejected: {}, projection: 'pending' },
    });
    expect((await ensureGeneratedTokenExchangeEnabled(input)).check.status).toBe('fail');
  });

  it("puts back what was saved even when the save's answer was lost", async () => {
    fetchJson
      .mockResolvedValueOnce(settings())
      .mockResolvedValueOnce({ ok: false, status: 0, error: 'timeout' })
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce(saved);

    const result = await ensureGeneratedTokenExchangeEnabled(input);
    expect(result.check.status).toBe('fail');
    await expect(result.restore()).resolves.toMatchObject({ status: 'pass' });
    expect(JSON.parse(fetchJson.mock.calls[3][2].body)).toMatchObject({
      clear: [ENABLED, DELEGATION, TYPES],
    });
  });

  it('leaves a key someone changed meanwhile as it is', async () => {
    fetchJson
      .mockResolvedValueOnce(settings())
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(
        settings(
          { [ENABLED]: true, [TYPES]: 'access_token,id_token' },
          { [ENABLED]: 'kv', [TYPES]: 'kv' },
          'v3'
        )
      )
      .mockResolvedValueOnce(saved);

    const result = await enable();
    const restored = await result.restore();
    expect(restored?.status).toBe('warn');
    expect(JSON.parse(fetchJson.mock.calls[3][2].body)).toEqual({
      ifMatch: 'v3',
      set: {},
      clear: [ENABLED],
    });
  });

  it('reads the URNs runtime takes as the names a tenant setting holds', async () => {
    const urn = 'urn:ietf:params:oauth:token-type:';
    fetchJson.mockResolvedValueOnce(
      settings(
        { [ENABLED]: true, [DELEGATION]: true, [TYPES]: `${urn}access_token` },
        { [TYPES]: 'env' }
      )
    );
    expect((await ensureGeneratedTokenExchangeEnabled(input)).changed).toBe(false);

    fetchJson
      .mockResolvedValueOnce(
        settings(
          { [TYPES]: `${urn}jwt, ${urn}refresh_token,urn:authrim:token-type:elevation-grant,jwt` },
          { [TYPES]: 'env' }
        )
      )
      .mockResolvedValueOnce(saved);
    const result = await enable();
    expect(result.changed).toBe(true);
    expect(JSON.parse(fetchJson.mock.calls[2][2].body).set).toEqual({
      [ENABLED]: true,
      [DELEGATION]: true,
      [TYPES]: 'jwt,access_token',
    });
  });

  it('changes nothing when runtime accepts a type a tenant setting cannot hold', async () => {
    fetchJson.mockResolvedValueOnce(
      settings({ [TYPES]: 'urn:example:token-type:custom,jwt' }, { [TYPES]: 'env' })
    );

    const result = await ensureGeneratedTokenExchangeEnabled(input);
    expect(result.check.status).toBe('fail');
    expect(result.check.details.join(' ')).toContain('urn:example:token-type:custom');
    expect(result.changed).toBe(false);
    expect(fetchJson).toHaveBeenCalledOnce();
    await expect(result.restore()).resolves.toBeNull();
  });

  it('changes only what is missing', async () => {
    fetchJson
      .mockResolvedValueOnce(
        settings(
          { [DELEGATION]: true, [TYPES]: 'urn:ietf:params:oauth:token-type:access_token' },
          { [ENABLED]: 'kv', [DELEGATION]: 'kv', [TYPES]: 'kv' }
        )
      )
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(
        settings(
          {
            [ENABLED]: true,
            [DELEGATION]: true,
            [TYPES]: 'urn:ietf:params:oauth:token-type:access_token',
          },
          { [ENABLED]: 'kv', [DELEGATION]: 'kv', [TYPES]: 'kv' },
          'v2'
        )
      )
      .mockResolvedValueOnce(saved);

    const result = await enable();
    expect(JSON.parse(fetchJson.mock.calls[1][2].body).set).toEqual({ [ENABLED]: true });
    await expect(result.restore()).resolves.toMatchObject({ status: 'pass' });
    expect(JSON.parse(fetchJson.mock.calls[3][2].body)).toEqual({
      ifMatch: 'v2',
      set: { [ENABLED]: false },
      clear: [],
    });
  });

  it('also lets the tenant delegate, which the delegating service client of the checks needs', async () => {
    fetchJson
      .mockResolvedValueOnce(settings({ [ENABLED]: true, [TYPES]: 'access_token' }))
      .mockResolvedValueOnce(saved);

    const result = await enable();

    expect(result.changed).toBe(true);
    expect(JSON.parse(fetchJson.mock.calls[1][2].body)).toEqual({
      ifMatch: 'v1',
      set: { [DELEGATION]: true },
    });
  });

  it("changes nothing when the tenant's own list could not be saved back", async () => {
    fetchJson.mockResolvedValueOnce(
      settings(
        { [TYPES]: 'urn:ietf:params:oauth:token-type:jwt' },
        { [ENABLED]: 'kv', [TYPES]: 'kv' }
      )
    );

    const result = await ensureGeneratedTokenExchangeEnabled(input);
    expect(result.check.status).toBe('fail');
    expect(result.changed).toBe(false);
    expect(fetchJson).toHaveBeenCalledOnce();
  });
});
