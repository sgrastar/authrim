import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core/services/log-iceberg-emitter')>()),
  emitLogIcebergRow: vi.fn(async () => ({})),
}));
vi.mock('@authrim/ar-lib-core', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).coreMock(o as never)
);
vi.mock('../sign-in-attempt-recording', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().signInAttempt(o as never)
);
vi.mock('../flow-session-profile', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().flowSession(o as never)
);
vi.mock('../direct-auth', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().directAuth(o as never)
);
vi.mock('../human-verification', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().humanVerification(o as never)
);
vi.mock('../registration-policy-gate', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().registrationGate(o as never)
);
vi.mock('../account-provisioning', async (o) =>
  (await import('./helpers/mut-directory-login-harness'))
    .localMocks()
    .accountProvisioning(o as never)
);

import { createDirectoryPasswordLoginHandler } from '../directory-password-login';
import {
  WW_CONNECTOR,
  connectorSettings,
  createContext,
  failedEvents,
  m,
  read,
  resetHarness,
  verdictFetcher,
} from './helpers/mut-directory-login-harness';

const creds = { username: 'alice', password: 'correct' };

async function run(
  body: unknown,
  options: Parameters<typeof createContext>[1] = {},
  fetcher = verdictFetcher()
) {
  const handler = createDirectoryPasswordLoginHandler(fetcher);
  return read(await handler(createContext(body, options) as never));
}

beforeEach(() => resetHarness());

describe('directory password login: request validation', () => {
  it('rejects a body that is not JSON', async () => {
    const fetcher = verdictFetcher();
    const result = await run(new Error('bad json'), {}, fetcher);
    expect(result.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [{ username: '   ', password: 'x' }],
    [{ username: 'alice', password: '' }],
    [{ username: 42, password: 'x' }],
    [{ username: 'alice', password: 42 }],
  ])('rejects missing credentials %j without contacting the connector', async (body) => {
    const fetcher = verdictFetcher();
    const result = await run(body, {}, fetcher);
    expect(result.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect(m.attemptMetadata).not.toHaveBeenCalled();
  });

  it('returns 503 when the sign-in flow metadata cannot be resolved', async () => {
    m.attemptMetadata.mockRejectedValue(new Error('flow down'));
    expect(await run(creds)).toEqual({
      status: 503,
      body: {
        error: 'temporarily_unavailable',
        error_description: 'The sign-in flow is unavailable.',
      },
    });
  });

  it('returns an interaction refusal unchanged', async () => {
    m.namedRefusal.mockResolvedValue(Response.json({ error: 'refused' }, { status: 403 }));
    expect(await run(creds)).toEqual({ status: 403, body: { error: 'refused' } });
  });

  it('trims the authorization challenge id and rejects an unknown challenge', async () => {
    m.readChallengeType.mockResolvedValue(null);
    const fetcher = verdictFetcher();
    const result = await run({ ...creds, authorization_challenge_id: '  ch_1  ' }, {}, fetcher);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'invalid_request', error_code: 'AR130003' });
    expect(m.readChallengeType).toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'ch_1');
    expect(m.failures).toEqual([{ reason: 'challenge_mismatch', userId: null }]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the challenge type as the human verification action', async () => {
    m.readChallengeType.mockResolvedValue('reauth');
    await run({ ...creds, authorization_challenge_id: 'ch_1', human_verification_response: 'hv' });
    expect(m.humanVerification).toHaveBeenCalledWith(expect.anything(), 'reauth', 'hv');
  });

  it('defaults the human verification action to login and accepts the legacy turnstile field', async () => {
    await run({ ...creds, cf_turnstile_response: 'ts' });
    expect(m.humanVerification).toHaveBeenCalledWith(expect.anything(), 'login', 'ts');
    expect(m.readChallengeType).not.toHaveBeenCalled();
  });

  it('returns a failed human verification and records verification_failed', async () => {
    m.humanVerification.mockResolvedValue(Response.json({ error: 'hv_failed' }, { status: 400 }));
    const fetcher = verdictFetcher();
    expect(await run(creds, {}, fetcher)).toEqual({ status: 400, body: { error: 'hv_failed' } });
    expect(m.failures).toEqual([{ reason: 'verification_failed', userId: null }]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('directory password login: connector configuration', () => {
  const notConfigured = {
    status: 404,
    body: {
      error: 'directory_password_not_configured',
      error_description: 'Directory password login is not configured for this tenant',
    },
  };

  it.each([
    ['no settings', null],
    ['invalid JSON', '{'],
    ['disabled', connectorSettings({}, { enabled: false })],
    ['enabled as a non-true string', connectorSettings({}, { enabled: 'yes' })],
    ['no connectors array', { enabled: true, connectors: 'campus' }],
    ['default connector id not present', connectorSettings({}, { default_connector_id: 'other' })],
    ['non-hmac auth mode', connectorSettings({ auth_mode: 'mtls' })],
    ['invalid wordwarden connector id', connectorSettings({ connector_id: 'wwcon_short' })],
    ['missing key id', connectorSettings({ key_id: ' ' })],
    ['missing secret ref', connectorSettings({ secret_ref: undefined })],
    ['direct without endpoint', connectorSettings({ endpoint_url: '' })],
    ['secret env not allowed', connectorSettings({ secret_ref: 'env:OTHER_SECRET' })],
    ['secret env lowercase', connectorSettings({ secret_ref: 'env:wordwarden_secret' })],
    ['secret env missing', connectorSettings({ secret_ref: 'env:WORDWARDEN_MISSING' })],
    ['relay without binding', connectorSettings({ transport: 'relay', endpoint_url: undefined })],
  ])('returns 404 for %s', async (_l, settings) => {
    const fetcher = verdictFetcher();
    const result = await run(
      creds,
      { settings, env: { OTHER_SECRET: 'x', wordwarden_secret: 'x' } },
      fetcher
    );
    expect(result).toEqual(notConfigured);
    expect(m.failures).toEqual([{ reason: 'method_disabled', userId: null }]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(m.rateLimiter.incrementRpc).not.toHaveBeenCalled();
  });

  it('accepts enabled "TRUE" strings, trims ids, and skips malformed connectors', async () => {
    const settings = {
      enabled: ' TRUE ',
      default_connector_id: ' campus ',
      connectors: [
        null,
        ['x'],
        {
          id: 'campus',
          connector_id: WW_CONNECTOR,
          key_id: 'k',
          secret_ref: 'env:WORDWARDEN_SECRET',
        },
        connectorSettings({ id: ' campus ', attribute_names: ' mail , cn ,, ' }).connectors[0],
      ],
    };
    let sent: Record<string, unknown> = {};
    const result = await run(
      creds,
      { settings },
      verdictFetcher({}, (b) => (sent = b))
    );
    expect(result.status).toBe(200);
    expect(sent.attribute_names).toEqual(['mail', 'cn']);
  });

  it('uses the default connector id and attribute list when none are configured', async () => {
    let sent: Record<string, unknown> = {};
    const settings = connectorSettings(
      { attribute_names: [' ', 3] },
      { default_connector_id: undefined }
    );
    const result = await run(
      creds,
      { settings },
      verdictFetcher({}, (b) => (sent = b))
    );
    expect(result.status).toBe(200);
    expect(sent.attribute_names).toEqual(['mail', 'displayName', 'uid']);
  });

  it('accepts a bare AUTHRIM_WORDWARDEN_ secret name', async () => {
    const settings = connectorSettings({ secret_ref: 'AUTHRIM_WORDWARDEN_KEY' });
    const result = await run(creds, { settings, env: { AUTHRIM_WORDWARDEN_KEY: 's' } });
    expect(result.status).toBe(200);
  });

  it('passes trimmed attribute arrays to the connector', async () => {
    let sent: Record<string, unknown> = {};
    const settings = connectorSettings({ attribute_names: [' mail ', '', 'uid'] });
    await run(
      creds,
      { settings },
      verdictFetcher({}, (b) => (sent = b))
    );
    expect(sent.attribute_names).toEqual(['mail', 'uid']);
  });
});

describe('directory password login: account rate limit', () => {
  it('reserves an attempt keyed by the normalized username before verification', async () => {
    const first = createContext({ username: 'ＡＬＩＣＥ', password: 'x' });
    const handler = createDirectoryPasswordLoginHandler(verdictFetcher());
    await handler(first as never);
    await handler(createContext({ username: 'alice', password: 'x' }) as never);
    const [k1, opts] = m.rateLimiter.incrementRpc.mock.calls[0] as [string, Record<string, number>];
    const [k2] = m.rateLimiter.incrementRpc.mock.calls[1] as [string];
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^account:[0-9a-f]{64}$/);
    expect(opts).toEqual({ windowSeconds: 900, maxRequests: 5 });
    expect(first.env.RATE_LIMITER.idFromName).toHaveBeenCalledWith(
      expect.stringContaining('directory-password-account')
    );
    expect(m.rateLimiter.resetRpc).toHaveBeenCalledWith(k1);
  });

  it('returns 429 with Retry-After and records rate_limited', async () => {
    m.rateLimiter.incrementRpc.mockResolvedValue({ allowed: false, retryAfter: 42 });
    const handler = createDirectoryPasswordLoginHandler(verdictFetcher());
    const response = await handler(createContext(creds) as never);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(await response.json()).toEqual({
      error: 'rate_limit_exceeded',
      error_description: 'Too many login attempts. Please try again later.',
    });
    expect(m.failures).toEqual([{ reason: 'rate_limited', userId: null }]);
  });

  it('falls back to the window length for Retry-After', async () => {
    m.rateLimiter.incrementRpc.mockResolvedValue({ allowed: false });
    const handler = createDirectoryPasswordLoginHandler(verdictFetcher());
    const response = await handler(createContext(creds) as never);
    expect(response.headers.get('Retry-After')).toBe('900');
  });

  it('does not reset the limiter after a failed verdict', async () => {
    const result = await run(
      creds,
      {},
      verdictFetcher({ result: 'failure', reason: 'bad_password' })
    );
    expect(result).toEqual({ status: 401, body: { error: 'invalid_credentials' } });
    expect(m.rateLimiter.resetRpc).not.toHaveBeenCalled();
    expect(m.failures).toEqual([{ reason: 'verification_failed', userId: null }]);
    expect(failedEvents()[0]).toMatchObject({
      errorCode: 'directory_failure',
      connectorReason: 'bad_password',
      connectorId: 'campus',
      method: 'directory_password',
      usernameHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    });
  });

  it('reports a policy_required verdict with its own error code', async () => {
    await run(creds, {}, verdictFetcher({ result: 'policy_required' }));
    expect(failedEvents()[0]).toMatchObject({
      errorCode: 'directory_policy_required',
      connectorReason: 'policy_required',
    });
  });
});

describe('directory password login: connector errors', () => {
  it('maps a retryable error to 503 connector_unavailable and records an own code', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('down');
    });
    expect(await run(creds, {}, fetcher)).toEqual({
      status: 503,
      body: { error: 'connector_unavailable', retryable: true },
    });
    expect(failedEvents()[0]).toMatchObject({ errorCode: 'fetch_error' });
    expect(failedEvents()[0].connectorReason).toBeUndefined();
    expect(m.failures).toEqual([{ reason: 'service_unavailable', userId: null }]);
  });

  it('maps a non-retryable connector error to 400 and hides foreign codes behind directory_connector_error', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ error: { code: 'ldap_bind_refused', retryable: false } }, { status: 422 })
    );
    expect(await run(creds, {}, fetcher)).toEqual({
      status: 400,
      body: { error: 'connector_unavailable', retryable: false },
    });
    expect(failedEvents()[0]).toMatchObject({
      errorCode: 'directory_connector_error',
      connectorReason: 'ldap_bind_refused',
    });
  });

  function relayEnv(idFromName: () => unknown) {
    return {
      settings: connectorSettings({
        transport: 'relay',
        endpoint_url: undefined,
        relay: { verify_timeout_ms: 50_000 },
      }),
      env: { DIRECTORY_CONNECTOR_RELAY: { idFromName: vi.fn(idFromName), get: vi.fn() } },
    };
  }

  it('returns the tenant write-fence response for an unexpected placement error', async () => {
    const result = await run(
      creds,
      relayEnv(() => {
        throw new Error('write_fenced');
      })
    );
    expect(result).toEqual({ status: 503, body: { error: 'tenant_write_fenced' } });
    expect(m.failures).toEqual([{ reason: 'service_unavailable', userId: null }]);
  });

  it('returns an internal error for other unexpected errors', async () => {
    const result = await run(
      creds,
      relayEnv(() => {
        throw new Error('boom');
      })
    );
    expect(result.status).toBe(500);
    expect(m.failures).toEqual([{ reason: 'service_unavailable', userId: null }]);
  });

  it('verifies through the relay Durable Object named for the tenant and connector', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      return Response.json({
        request_id: body.request_id,
        tenant_id: 'tenant-a',
        connector_id: WW_CONNECTOR,
        result: 'failure',
        directory_status: 'ok',
      });
    });
    const options = relayEnv(() => ({ id: 1 }));
    (options.env.DIRECTORY_CONNECTOR_RELAY.get as ReturnType<typeof vi.fn>).mockReturnValue({
      fetch,
    });
    const fetcher = verdictFetcher();
    const result = await run(creds, options, fetcher);
    expect(result).toEqual({ status: 401, body: { error: 'invalid_credentials' } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(options.env.DIRECTORY_CONNECTOR_RELAY.idFromName).toHaveBeenCalledWith(
      `tenant-a:${WW_CONNECTOR}`
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toMatchObject({
      username: 'alice',
      attribute_names: ['mail', 'displayName', 'uid'],
    });
  });
});
