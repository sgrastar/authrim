import { describe, expect, it, vi } from 'vitest';
import type { AgentConfigurationOperationRequest } from '../platform/ports';
import { CloudflareAgentRuntimeDiagnostics } from '../platform/cloudflare/runtime-diagnostics';

const MAX = 256 * 1024;
const ISSUER = 'https://tenant.example';

function operation(issuerOrigin = ISSUER): AgentConfigurationOperationRequest {
  return {
    operation: 'admin.read.runtime.diagnostics',
    actor: {
      mode: 'mode_a',
      sub: 'client:client-1',
      assurance: 'public_client_transaction',
      tokenBinding: 'bearer',
      clientId: 'client-1',
    },
    grant: {} as never,
    issuerOrigin,
    correlationId: 'correlation-1',
    input: {},
  };
}

interface Responses {
  discovery?: () => Response;
  jwks?: () => Response;
  health?: () => Response;
}

function diagnostics(responses: Responses = {}) {
  const discovery = {
    fetch: vi.fn(async (incoming: Request) =>
      incoming.url.endsWith('openid-configuration')
        ? (responses.discovery?.() ?? Response.json({ issuer: ISSUER }))
        : (responses.jwks?.() ?? Response.json({ keys: [] }))
    ),
  };
  const management = {
    fetch: vi.fn(async (_incoming: Request) => responses.health?.() ?? Response.json({ ok: true })),
  };
  return {
    discovery,
    management,
    inspect: (request = operation()) =>
      new CloudflareAgentRuntimeDiagnostics(discovery, management).inspect(request),
  };
}

async function snapshot(responses: Responses) {
  const result = await diagnostics(responses).inspect();
  expect(result.status).toBe(200);
  return (result.body as { snapshot: Record<string, unknown> }).snapshot;
}

describe('runtime diagnostics issuer validation', () => {
  it.each([
    'not a url',
    'http://tenant.example',
    'https://tenant.example/path',
    'https://u:p@tenant.example',
  ])('refuses issuer %s without calling owners', async (issuer) => {
    const d = diagnostics();
    await expect(d.inspect(operation(issuer))).resolves.toEqual({
      status: 400,
      body: { error: 'AGENT_RUNTIME_ISSUER_INVALID' },
    });
    expect(d.discovery.fetch).not.toHaveBeenCalled();
  });

  it('sends the forwarded host and correlation id to Management health', async () => {
    const d = diagnostics();
    await d.inspect();
    const sent = d.management.fetch.mock.calls[0]?.[0];
    expect(sent.url).toBe('https://ar-management.internal/api/health');
    expect(sent.headers.get('x-authrim-forwarded-host')).toBe('tenant.example');
    expect(sent.headers.get('x-correlation-id')).toBe('correlation-1');
  });
});

describe('runtime diagnostics snapshot', () => {
  it('is healthy only when every owner is ok and the issuer matches', async () => {
    await expect(snapshot({})).resolves.toMatchObject({
      healthy: true,
      issuer_matches: true,
      reported_issuer: ISSUER,
    });
  });

  it.each([
    ['discovery', { discovery: () => new Response('down', { status: 500 }) }],
    ['jwks', { jwks: () => new Response('down', { status: 502 }) }],
    ['health', { health: () => new Response(null, { status: 503 }) }],
    ['issuer', { discovery: () => Response.json({ issuer: 'https://other.example' }) }],
  ] as const)(
    'is unhealthy when %s fails, without parsing failed bodies',
    async (_name, responses) => {
      const result = await snapshot(responses);
      expect(result.healthy).toBe(false);
    }
  );

  it('reports a failed discovery without an issuer and a failed JWKS without keys', async () => {
    const result = await snapshot({
      discovery: () => new Response('not json', { status: 500 }),
      jwks: () => new Response('not json', { status: 500 }),
    });
    expect(result).toMatchObject({
      discovery_status: 500,
      issuer_matches: false,
      reported_issuer: null,
      jwks_status: 500,
      signing_keys: [],
    });
  });

  it('exposes at most 20 keys and only their string public metadata fields', async () => {
    const keys = [
      {
        kid: 'k-0',
        kty: 'RSA',
        alg: 'RS256',
        use: 'sig',
        crv: 'P-256',
        n: 'secret-modulus',
        d: 'x',
      },
      'not-an-object',
      { kid: 7, kty: 'EC' },
      ...Array.from({ length: 25 }, (_, index) => ({ kid: `extra-${index}` })),
    ];
    const result = await snapshot({ jwks: () => Response.json({ keys }) });
    const signing = result.signing_keys as Record<string, unknown>[];
    expect(signing).toHaveLength(19);
    expect(signing[0]).toEqual({ kid: 'k-0', kty: 'RSA', alg: 'RS256', use: 'sig', crv: 'P-256' });
    expect(signing[1]).toEqual({ kty: 'EC' });
    expect(signing.at(-1)).toEqual({ kid: 'extra-16' });
  });

  it('treats a JWKS document without a keys array as no keys', async () => {
    await expect(snapshot({ jwks: () => Response.json({ keys: 'none' }) })).resolves.toMatchObject({
      signing_keys: [],
    });
  });
});

describe('runtime diagnostics response bounds', () => {
  it('accepts a declared length at the limit and a small declared length', async () => {
    for (const length of ['20', String(MAX)]) {
      const result = await snapshot({
        discovery: () =>
          new Response(JSON.stringify({ issuer: ISSUER }), {
            headers: { 'content-length': length },
          }),
      });
      expect(result.reported_issuer).toBe(ISSUER);
    }
  });

  it('fails closed for oversized declared or actual bodies', async () => {
    const oversizedDeclared = await diagnostics({
      jwks: () => new Response('{}', { headers: { 'content-length': String(MAX + 1) } }),
    }).inspect();
    expect(oversizedDeclared).toEqual({
      status: 503,
      body: { error: 'AGENT_RUNTIME_DIAGNOSTICS_UNAVAILABLE' },
      executionStatus: 'definite',
    });
    const exact = `{"keys":[],"p":"${'x'.repeat(MAX - 18)}"}`;
    expect(new TextEncoder().encode(exact).byteLength).toBe(MAX);
    await expect(snapshot({ jwks: () => new Response(exact) })).resolves.toMatchObject({
      signing_keys: [],
    });
    const oversized = await diagnostics({ jwks: () => new Response(`${exact} `) }).inspect();
    expect(oversized.status).toBe(503);
  });
});
