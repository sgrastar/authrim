/** Design section 11: nothing secret or request-derived is logged, and the app never uses console. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildClientData } from '../domain/client-data';
import type { CV } from './support/der';
import { makeAssertion, makeAttestation } from './support/apple-fixture';
import { genPair } from './support/keys';
import { makeWorld } from './support/service-world';

afterEach(() => vi.restoreAllMocks());

const ALLOWED = new Set([
  'requestId',
  'endpoint',
  'status',
  'outcome',
  'reason',
  'keyIdHash',
  'counter',
  'environment',
  'validationCategory',
  'bundleVersion',
  'latencyMs',
]);

describe('logging', () => {
  it('records only allow-listed fields and none of the request or secret values', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    const w = await makeWorld();
    const secrets: string[] = [];

    const challenge = ((await (await w.post('/challenge', {})).json()) as { challenge: string })
      .challenge;
    const build = new Map<string, CV>([
      ['apple_validation_category_01', Uint8Array.of(4, 0, 0, 0)],
      ['apple_bundle_version_01', '1.0'],
    ]);
    const dev = await makeAttestation(w.apple, {
      challenge,
      aaguid: 'production',
      extensions: build,
    });
    const reg = await w.post('/register', {
      key_id: dev.keyId,
      challenge,
      attestation_object: dev.attestationObject,
    });
    expect(reg.status).toBe(200);
    secrets.push(challenge, dev.keyId, dev.attestationObject);

    const kp = await genPair('P-256');
    const raw = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as { x: string; y: string };
    const jwk = { kty: 'EC', crv: 'P-256', x: raw.x, y: raw.y } as const;
    const nonce = 'SENTINEL-NONCE-5f3a';
    const ch2 = ((await (await w.post('/challenge', {})).json()) as { challenge: string })
      .challenge;
    const clientData = await buildClientData({
      purpose: 'key-attestation',
      challenge: ch2,
      jwk,
      nonce,
    });
    const assertion = await makeAssertion(dev, clientData, { counter: 1, extensions: build });
    const res = await w.post('/key-attestation', {
      key_id: dev.keyId,
      challenge: ch2,
      purpose: 'key-attestation',
      assertion,
      jwk,
      nonce,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const jwt = (JSON.parse(text) as { attestation: string }).attestation;
    secrets.push(ch2, assertion, nonce, jwk.x, jwk.y, jwt, ...jwt.split('.'));
    // failures too: replay, tampered, unknown key
    await w.post('/key-attestation', {
      key_id: dev.keyId,
      challenge: ch2,
      purpose: 'key-attestation',
      assertion,
      jwk,
      nonce,
    });
    await w.post('/register', { key_id: 'bad', challenge: 'c' });

    expect(w.logs.length).toBeGreaterThanOrEqual(5);
    for (const event of w.logs) {
      for (const field of Object.keys(event)) expect(ALLOWED.has(field)).toBe(true);
    }
    const logged = JSON.stringify(w.logs);
    for (const value of secrets) expect(logged).not.toContain(value);
    expect(logged).not.toContain(dev.keyId);
    expect(logged).toMatch(/"keyIdHash":"[0-9a-f]{12}"/u);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('keeps error bodies to the enumerated codes', async () => {
    const w = await makeWorld();
    const res = await w.post('/register', {
      key_id: 'x'.repeat(44),
      challenge: 'forged-challenge-xyz',
      attestation_object: 'AAAA',
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['error']);
    expect(['invalid_request', 'invalid_challenge', 'invalid_attestation']).toContain(body.error);
  });
});
