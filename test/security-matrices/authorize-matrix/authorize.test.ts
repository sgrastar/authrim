import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  createSecurityMatrixEnv,
  seedClientRow,
  seedRegionShardConfig,
  type SecurityMatrixEnvKit,
} from '../fixtures/env';
import { CallLedger, LedgerExecutionContext } from '../fixtures/call-ledger';
import { createMatrixAuthorizeApp, requestUrl } from '../fixtures/hono-context';
import { installFrozenNow, restoreRealClock } from '../fixtures/deterministic-clock';
import { AUTHORIZE_CASE_TABLE, authorizeLegalPairKeys, type AuthorizeCase } from './cases';
import { findDuplicateIds } from '../fixtures/case-fingerprint';
import { runBinaryGoldenChecks } from '../fixtures/coverage-verifier';
import type { Hono } from 'hono';
import type { Env } from '../../../packages/ar-lib-core/src/types/env';

const CLIENT_PUBLIC = 'matrix-public';
const REDIRECT = 'https://client.example/callback';

async function authorizeGet(
  app: Hono<{ Bindings: Env }>,
  kit: SecurityMatrixEnvKit,
  query: Record<string, string>
): Promise<Response> {
  const url = new URL(requestUrl('/authorize'));
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const ledger = new CallLedger();
  const request = new Request(url.toString(), { method: 'GET' });
  const response = await app.fetch(request, kit.env, new LedgerExecutionContext(ledger));
  await ledger.drain();
  return response;
}

describe('authorize-matrix protocol suite', () => {
  let kit: SecurityMatrixEnvKit;

  beforeEach(async () => {
    installFrozenNow(1700000000);
    const ledger = new CallLedger();
    kit = await createSecurityMatrixEnv(ledger);
    seedRegionShardConfig(kit);
    // Use builtin forms so validation errors return JSON from the AS directly.
    (kit.env as unknown as Record<string, unknown>).ENABLE_CONFORMANCE_MODE = 'true';
    seedClientRow(kit, {
      client_id: CLIENT_PUBLIC,
      client_secret_hash: undefined,
      token_endpoint_auth_method: 'none',
      default_resource: 'svc://matrix-api',
      redirect_uris: REDIRECT,
      scope: 'openid',
    });
  });

  afterEach(() => {
    restoreRealClock();
  });

  it('rejects request together with request_uri', async () => {
    expect.hasAssertions();
    const app = createMatrixAuthorizeApp(kit);
    const response = await authorizeGet(app, kit, {
      request: 'eyJhbGciOiJub25lIn0.eyJpc3MiOiJjbGllbnQifQ.',
      request_uri: 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_abc',
      client_id: CLIENT_PUBLIC,
      response_type: 'code',
      redirect_uri: REDIRECT,
      scope: 'openid',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('invalid_request');
  });

  it('rejects an unsupported response_type', async () => {
    expect.hasAssertions();
    const app = createMatrixAuthorizeApp(kit);
    const response = await authorizeGet(app, kit, {
      client_id: CLIENT_PUBLIC,
      response_type: 'token',
      redirect_uri: REDIRECT,
      scope: 'openid',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('unsupported_response_type');
  });

  it('rejects an unknown client without redirecting to an unvalidated URI', async () => {
    expect.hasAssertions();
    const app = createMatrixAuthorizeApp(kit);
    const response = await authorizeGet(app, kit, {
      client_id: 'matrix-does-not-exist',
      response_type: 'code',
      redirect_uri: 'https://attacker.example/callback',
      scope: 'openid',
    });
    expect(response.status).toBe(400);
    const location = response.headers.get('location');
    expect(location).toBeNull();
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('invalid_request');
  });

  it('rejects a malformed redirect_uri before any redirect', async () => {
    expect.hasAssertions();
    const app = createMatrixAuthorizeApp(kit);
    const response = await authorizeGet(app, kit, {
      client_id: CLIENT_PUBLIC,
      response_type: 'code',
      redirect_uri: 'not-a-url',
      scope: 'openid',
    });
    expect(response.status).toBe(400);
    const location = response.headers.get('location');
    expect(location).toBeNull();
  });

  it('never redirects an error to an unregistered URI', async () => {
    expect.hasAssertions();
    const app = createMatrixAuthorizeApp(kit);
    const response = await authorizeGet(app, kit, {
      client_id: CLIENT_PUBLIC,
      response_type: 'code',
      redirect_uri: 'https://attacker.example/callback',
      scope: 'openid',
    });
    // A validation error for an unregistered redirect is returned by the AS directly.
    expect(response.status).toBe(400);
    const location = response.headers.get('location');
    expect(location).toBeNull();
  });

  it('handles a malformed PAR request_uri without ever targeting an unvalidated URI', async () => {
    expect.hasAssertions();
    const app = createMatrixAuthorizeApp(kit);
    const response = await authorizeGet(app, kit, {
      request_uri: 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_invalid',
      client_id: CLIENT_PUBLIC,
      redirect_uri: REDIRECT,
      response_type: 'code',
    });
    // RFC 9126 permits returning the error to a verified registered redirect, or the AS
    // responds directly. Either way the target must never be an unvalidated URI.
    const location = response.headers.get('location');
    if (location) {
      expect(new URL(location).origin + new URL(location).pathname).toBe(REDIRECT);
    } else {
      expect(response.status).toBe(400);
    }
  });

  for (const entry of AUTHORIZE_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const app = createMatrixAuthorizeApp(kit);
      const query: Record<string, string> = {
        client_id: entry.clientType === 'unknown' ? 'matrix-does-not-exist' : CLIENT_PUBLIC,
        redirect_uri:
          entry.redirectValid === 'registered'
            ? REDIRECT
            : entry.redirectValid === 'malformed'
              ? 'not-a-url'
              : 'https://attacker.example/callback',
        scope: 'openid',
      };
      if (entry.responseType === 'missing') {
        // omit
      } else if (entry.responseType === 'unsupported') {
        query.response_type = 'token';
      } else {
        query.response_type = 'code';
      }
      if (entry.requestSource === 'par') {
        query.request_uri = 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_invalid';
      } else if (entry.requestSource === 'jar') {
        query.request = 'eyJhbGciOiJub25lIn0.eyJpc3MiOiJjbGllbnQifQ.';
      }
      const response = await authorizeGet(app, kit, query);
      // The security invariant: a redirect target, when present, must be the registered
      // redirect URI and never the unvalidated candidate.
      const location = response.headers.get('location');
      if (location) {
        const target = new URL(location);
        expect(target.origin + target.pathname).toBe(REDIRECT);
      }
      expect(entry.fingerprint.length).toBeGreaterThan(0);
    });
  }

  it('covers every legal 2-way tuple of the declared dimensions', () => {
    expect.hasAssertions();
    const covered = new Set<string>();
    const order = ['requestSource', 'clientType', 'redirectValid', 'responseType'];
    for (const entry of AUTHORIZE_CASE_TABLE) {
      for (let left = 0; left < order.length - 1; left += 1) {
        for (let right = left + 1; right < order.length; right += 1) {
          covered.add(
            `${order[left]}=${entry.dimensions[order[left]]}|${order[right]}=${entry.dimensions[order[right]]}`
          );
        }
      }
    }
    const legal = authorizeLegalPairKeys();
    const missing = legal.filter((key) => !covered.has(key));
    expect(missing).toEqual([]);
  });

  it('assigns unique case ids and unique semantic fingerprints', () => {
    expect.hasAssertions();
    const ids = AUTHORIZE_CASE_TABLE.map((entry) => entry.id);
    expect(findDuplicateIds(ids)).toEqual([]);
    const fingerprints = AUTHORIZE_CASE_TABLE.map((entry) => entry.fingerprint);
    expect(findDuplicateIds(fingerprints)).toEqual([]);
  });

  it('reproduces the reviewer binary coverage golden counts independently', () => {
    expect.hasAssertions();
    const issues = runBinaryGoldenChecks();
    expect(issues).toEqual([]);
  });
});
