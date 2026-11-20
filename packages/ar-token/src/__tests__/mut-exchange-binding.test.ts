/**
 * Token Exchange: the subject token's sender binding (cnf: DPoP jkt, mTLS x5t#S256) against what
 * the request proves; the federation assurance level gate; the RFC 6750 error headers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exchangeContext,
  expectError,
  issuedClaims,
  keyEnv,
  m,
  resetExchange,
  settingsOverrides,
  userSubject,
} from './helpers/mut-exchange-harness';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const h = await import('./helpers/mut-exchange-harness');
  return h.mockCore(await importOriginal());
});
vi.mock('../external-id-jag-verifier', async () =>
  (await import('./helpers/mut-exchange-harness')).mockJagVerifier()
);

import { tokenHandler } from '../token';

const MISMATCH = 'Subject token sender binding does not match';

async function exchange(): Promise<Response> {
  return tokenHandler(exchangeContext({}, { env: await keyEnv() }));
}

/** The request proves DPoP key `jkt` and/or presents certificate `certificate`. */
function proves(input: { jkt?: string; certificate?: string }): void {
  if (input.jkt) {
    m.extractDPoPProof.mockReturnValue('dpop-proof');
    m.validateDPoPProof.mockResolvedValue({ valid: true, jkt: input.jkt });
  }
  m.getPresentedClientCertificateThumbprint.mockResolvedValue(input.certificate);
}

function subjectCnf(cnf: unknown): void {
  m.parseToken.mockReturnValue(userSubject({ cnf }));
}

describe('subject token sender binding', () => {
  beforeEach(() => resetExchange());

  it.each([
    ['null', null],
    ['a string', 'jkt-1'],
    ['an array', [{ jkt: 'jkt-1' }]],
    ['empty', {}],
    ['an empty jkt', { jkt: '' }],
    ['an empty thumbprint', { 'x5t#S256': '' }],
    ['a thumbprint that is not a string', { 'x5t#S256': 5 }],
    ['a jkt next to an empty thumbprint', { jkt: 'jkt-1', 'x5t#S256': '' }],
    ['a thumbprint next to an empty jkt', { jkt: '', 'x5t#S256': 'tp-1' }],
    ['an unknown confirmation method', { jkt: 'jkt-1', kid: 'k' }],
  ])('refuses a cnf that is %s', async (_name, cnf) => {
    proves({ jkt: 'jkt-1', certificate: 'tp-1' });
    subjectCnf(cnf);
    await expectError(await exchange(), 400, 'invalid_grant', MISMATCH);
  });

  it('accepts a DPoP-bound subject token presented with its key', async () => {
    proves({ jkt: 'jkt-1' });
    subjectCnf({ jkt: 'jkt-1' });
    expect((await exchange()).status).toBe(200);
    expect(issuedClaims().cnf).toEqual({ jkt: 'jkt-1' });
  });

  it.each([
    ['another DPoP key', { jkt: 'jkt-2' }],
    ['no DPoP proof', {}],
    ['only a certificate', { certificate: 'jkt-1' }],
  ])('refuses a DPoP-bound subject token presented with %s', async (_name, proof) => {
    proves(proof);
    subjectCnf({ jkt: 'jkt-1' });
    await expectError(await exchange(), 400, 'invalid_grant', MISMATCH);
  });

  it('accepts a certificate-bound subject token over its certificate and keeps the binding', async () => {
    proves({ certificate: 'tp-1' });
    subjectCnf({ 'x5t#S256': 'tp-1' });
    expect((await exchange()).status).toBe(200);
    expect(issuedClaims().cnf).toEqual({ 'x5t#S256': 'tp-1' });
  });

  it.each([
    ['another certificate', { certificate: 'tp-2' }],
    ['no certificate', {}],
    ['only a DPoP proof', { jkt: 'tp-1' }],
  ])('refuses a certificate-bound subject token over %s', async (_name, proof) => {
    proves(proof);
    subjectCnf({ 'x5t#S256': 'tp-1' });
    await expectError(await exchange(), 400, 'invalid_grant', MISMATCH);
  });

  it('requires both proofs for a token bound to a key and a certificate', async () => {
    subjectCnf({ jkt: 'jkt-1', 'x5t#S256': 'tp-1' });
    proves({ jkt: 'jkt-1', certificate: 'tp-1' });
    expect((await exchange()).status).toBe(200);
    expect(issuedClaims().cnf).toEqual({ jkt: 'jkt-1', 'x5t#S256': 'tp-1' });

    resetExchange();
    subjectCnf({ jkt: 'jkt-1', 'x5t#S256': 'tp-1' });
    proves({ jkt: 'jkt-1', certificate: 'tp-2' });
    await expectError(await exchange(), 400, 'invalid_grant', MISMATCH);
  });
});

describe('federation assurance level', () => {
  beforeEach(() => resetExchange());

  it('refuses token exchange at FAL3 with pushed signed requests required', async () => {
    settingsOverrides.assurance = {
      'assurance.enabled': true,
      'assurance.default_fal': 'FAL3',
      'assurance.fal3_requires_par': true,
    };
    m.extractDPoPProof.mockReturnValue('dpop-proof');
    await expectError(
      await exchange(),
      400,
      'unauthorized_client',
      'This grant does not meet the required federation assurance level (FAL3)'
    );
  });

  it('answers 503 when the assurance settings cannot be read', async () => {
    settingsOverrides.assurance = { __throw: true };
    await expectError(
      await exchange(),
      503,
      'temporarily_unavailable',
      'Assurance settings are temporarily unavailable'
    );
  });
});

describe('error response headers', () => {
  beforeEach(() => resetExchange());

  it('sends WWW-Authenticate with a 401 only', async () => {
    m.verifyClientSecretHash.mockResolvedValue(false);
    const unauthorized = exchangeContext({}, { env: await keyEnv() });
    await expectError(
      await tokenHandler(unauthorized),
      401,
      'invalid_client',
      'Invalid client credentials'
    );
    expect(unauthorized.res.headers.get('WWW-Authenticate')).toBe(
      'Bearer error="invalid_client", error_description="Invalid client credentials"'
    );
    expect(unauthorized.res.headers.get('Cache-Control')).toBe('no-store');

    m.verifyClientSecretHash.mockResolvedValue(true);
    m.parseToken.mockReturnValue(userSubject({ cnf: null }));
    const badRequest = exchangeContext({}, { env: await keyEnv() });
    await expectError(await tokenHandler(badRequest), 400, 'invalid_grant', MISMATCH);
    expect(badRequest.res.headers.get('WWW-Authenticate')).toBeUndefined();
    expect(badRequest.res.headers.get('Pragma')).toBe('no-cache');
  });
});
