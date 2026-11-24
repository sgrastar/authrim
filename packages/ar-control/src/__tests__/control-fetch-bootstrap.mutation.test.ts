import { beforeEach, describe, expect, it, vi } from 'vitest';
import { make } from './support/control-rpc-harness';

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  advance: vi.fn(),
  release: vi.fn(),
  failureCode: vi.fn(),
  samlDr: vi.fn(),
}));

vi.mock('../bootstrap-accelerator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bootstrap-accelerator')>()),
  admitInitialBootstrapAcceleration: mocks.admit,
  advanceInitialBootstrap: mocks.advance,
  releaseInitialBootstrapAcceleration: mocks.release,
  bootstrapAcceleratorFailureCode: mocks.failureCode,
}));
vi.mock('../saml-dr-mutation-entrypoint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../saml-dr-mutation-entrypoint')>()),
  runControlSamlDrOperation: mocks.samlDr,
}));

const URL_ADVANCE = 'https://control.internal/api/internal/control/bootstrap/advance';
const TOKEN = 'aaa.bbb.ccc';

function post(headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) {
  return new Request(URL_ADVANCE, { method: 'POST', headers });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.release.mockResolvedValue(undefined);
  mocks.samlDr.mockImplementation((env: unknown, operation: (env: unknown) => unknown) =>
    operation(env)
  );
});

const NOT_FOUND_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'text/plain; charset=utf-8',
  'x-content-type-options': 'nosniff',
};

function headersOf(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.entries());
}

describe('Control fetch routing', () => {
  it('answers a missing request with a hardened 404', async () => {
    const response = await make().control.fetch();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
    expect(headersOf(response)).toEqual(NOT_FOUND_HEADERS);
  });

  it.each([
    ['GET', URL_ADVANCE],
    ['POST', 'https://control.internal/api/internal/control/bootstrap/other'],
    ['POST', 'https://control.internal/api/internal/control/bootstrap/advance/'],
    ['PUT', URL_ADVANCE],
  ])('answers %s %s with a hardened 404 and never admits', async (method, url) => {
    const response = await make().control.fetch(
      new Request(url, { method, headers: { Authorization: `Bearer ${TOKEN}` } })
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
    expect(headersOf(response)).toEqual(NOT_FOUND_HEADERS);
    expect(mocks.admit).not.toHaveBeenCalled();
  });
});

describe('Control bootstrap advance', () => {
  it.each([
    [undefined],
    ['Bearer'],
    ['Bearer a.b'],
    ['Bearer a.b.c.d'],
    ['Bearer\ta.b.c'],
    ['Bearera.b.c'],
    ['Bearer: a.b.c'],
    ['Bearer a.b.c d'],
    ['Bearer ..'],
    ['Bearer a.b.c!'],
    ['Basic a.b.c'],
  ])(
    'answers an invalid authorization header (%s) with 401 before admission',
    async (authorization) => {
      const response = await make().control.fetch(
        post(authorization === undefined ? {} : { Authorization: authorization })
      );
      expect(response.status).toBe(401);
      expect(headersOf(response)).toEqual({
        'cache-control': 'no-store',
        'www-authenticate': 'Bearer',
      });
      expect(mocks.admit).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['Bearer aaa.bbb.ccc'],
    ['bearer aaa.bbb.ccc'],
    ['BEARER aaa.bbb.ccc'],
    ['Bearer  aaa.bbb.ccc'],
    ['bEaReR     aaa.bbb.ccc'],
  ])('verifies the same proof for the equivalent header %j', async (authorization) => {
    mocks.admit.mockResolvedValue({ state: 'inactive' });
    const { control, env } = make();
    await control.fetch(post({ Authorization: authorization }));
    expect(mocks.admit).toHaveBeenCalledExactlyOnceWith({ env, proof: TOKEN });
  });

  it('rejects an unknown action with a bare 400 before admission', async () => {
    const response = await make().control.fetch(
      post({ Authorization: `Bearer ${TOKEN}`, 'X-Authrim-Bootstrap-Action': 'other' })
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('');
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it('admits without a purpose when no action header is sent', async () => {
    mocks.admit.mockResolvedValue({ state: 'inactive' });
    const { control, env } = make();
    await control.fetch(post());
    expect(mocks.admit).toHaveBeenCalledExactlyOnceWith({ env, proof: TOKEN });
  });

  it.each([
    ['rejects', 'reject'],
    ['resolves nothing', 'empty'],
  ])('answers 401 when admission %s', async (_name, mode) => {
    if (mode === 'reject') mocks.admit.mockRejectedValue(new Error('signature details'));
    else mocks.admit.mockResolvedValue(null);
    const response = await make().control.fetch(post());
    expect(response.status).toBe(401);
    expect(headersOf(response)).toEqual({
      'cache-control': 'no-store',
      'www-authenticate': 'Bearer',
    });
    expect(await response.text()).toBe('');
    expect(mocks.advance).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('treats an inactive accelerator as not found', async () => {
    mocks.admit.mockResolvedValue({ state: 'inactive' });
    const response = await make().control.fetch(post());
    expect(response.status).toBe(404);
    expect(headersOf(response)).toEqual({ 'cache-control': 'no-store' });
    expect(await response.text()).toBe('');
    expect(mocks.advance).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('advances the bootstrap once when the lease is acquired and always releases it', async () => {
    const claims = { purpose: 'initial_bootstrap', jti: 'proof-1' };
    mocks.admit.mockResolvedValue({ state: 'acquired', claims });
    mocks.advance.mockResolvedValue(undefined);
    const { control, env } = make();
    const response = await control.fetch(post());
    expect(response.status).toBe(202);
    expect(headersOf(response)).toEqual({ 'cache-control': 'no-store' });
    expect(mocks.advance).toHaveBeenCalledExactlyOnceWith({ env });
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith({ env, claims });
  });

  it('reports the sanitized failure code and still releases the lease', async () => {
    const claims = { purpose: 'initial_bootstrap', jti: 'proof-1' };
    const failure = new Error('provider secret');
    mocks.admit.mockResolvedValue({ state: 'acquired', claims });
    mocks.advance.mockRejectedValue(failure);
    mocks.failureCode.mockReturnValue('bootstrap_code_x');
    const { control, env } = make();
    const response = await control.fetch(post());
    expect(response.status).toBe(503);
    expect(headersOf(response)).toEqual({
      'cache-control': 'no-store',
      'x-authrim-error-code': 'bootstrap_code_x',
    });
    expect(mocks.failureCode).toHaveBeenCalledExactlyOnceWith(failure);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith({ env, claims });
  });

  it('answers a busy lease with 202 without advancing or releasing', async () => {
    mocks.admit.mockResolvedValue({ state: 'busy' });
    const response = await make().control.fetch(post());
    expect(response.status).toBe(202);
    expect(headersOf(response)).toEqual({ 'cache-control': 'no-store' });
    expect(mocks.advance).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});

describe('Control bootstrap advance under SAML DR export', () => {
  it('runs inside the covered writer operation with the same environment', async () => {
    mocks.admit.mockResolvedValue({ state: 'busy' });
    const { control, env } = make({}, { ENABLE_SAML_DR_EXPORT: 'true' });
    const response = await control.fetch(post());
    expect(response.status).toBe(202);
    expect(mocks.samlDr).toHaveBeenCalledTimes(1);
    expect(mocks.samlDr.mock.calls[0]?.[0]).toBe(env);
    expect(mocks.admit).toHaveBeenCalledExactlyOnceWith({ env, proof: TOKEN });
  });

  it('turns an unavailable writer gate into a retryable 503 without leaking detail', async () => {
    mocks.samlDr.mockRejectedValue(new Error('saml_dr_writer_unavailable'));
    const response = await make({}, { ENABLE_SAML_DR_EXPORT: 'true' }).control.fetch(post());
    expect(response.status).toBe(503);
    expect(headersOf(response)).toEqual({ 'cache-control': 'no-store', 'retry-after': '5' });
    expect(await response.text()).toBe('');
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it.each([
    ['without the flag', {}, 'POST', URL_ADVANCE],
    ['with the flag off', { ENABLE_SAML_DR_EXPORT: 'false' }, 'POST', URL_ADVANCE],
    ['for a GET', { ENABLE_SAML_DR_EXPORT: 'true' }, 'GET', URL_ADVANCE],
    [
      'for another path',
      { ENABLE_SAML_DR_EXPORT: 'true' },
      'POST',
      'https://control.internal/other',
    ],
  ])('does not use the writer gate %s', async (_name, overrides, method, url) => {
    mocks.admit.mockResolvedValue({ state: 'busy' });
    await make({}, overrides).control.fetch(
      new Request(url, { method, headers: { Authorization: `Bearer ${TOKEN}` } })
    );
    expect(mocks.samlDr).not.toHaveBeenCalled();
  });
});
