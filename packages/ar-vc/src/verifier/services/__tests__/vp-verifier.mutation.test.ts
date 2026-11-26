/**
 * VP verifier: exact outputs, status-claim parsing, holder key selection and error texts.
 */

import { exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';

const h = vi.hoisted(() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    module: vi.fn(),
  };
  logger.module.mockReturnValue(logger);
  return {
    logger,
    evaluatorPolicies: [] as unknown[],
    validate: vi.fn(),
  };
});

vi.mock('../issuer-trust', () => ({
  checkIssuerTrust: vi.fn(),
  getIssuerPublicKey: vi.fn(),
}));

vi.mock('../../../utils/vc-config', () => ({
  createVCConfigManager: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  parseSDJWTVC: vi.fn(),
  verifySDJWTVC: vi.fn(),
  HaipPolicyEvaluator: class {
    constructor(policy: unknown) {
      h.evaluatorPolicies.push(policy);
    }
    validateVerificationResult(input: unknown) {
      return h.validate(input) as unknown;
    }
  },
  getHaipPolicy: vi.fn(),
  getCredentialStatusValue: vi.fn(),
  TSL_STATUS_SUSPENDED: 2,
  decodeBase64Url: (value: string) =>
    atob(
      value
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(value.length / 4) * 4, '=')
    ),
  resolveAuthCorePersistenceAdapterFromEnv: vi.fn(),
  TrustedIssuerRepository: class {
    constructor(public adapter: unknown) {}
  },
  createLogger: vi.fn(() => h.logger),
}));

import { verifyVPToken } from '../vp-verifier';
import { checkIssuerTrust, getIssuerPublicKey } from '../issuer-trust';
import { createVCConfigManager } from '../../../utils/vc-config';
import {
  getCredentialStatusValue,
  getHaipPolicy,
  parseSDJWTVC,
  resolveAuthCorePersistenceAdapterFromEnv,
  verifySDJWTVC,
} from '@authrim/ar-lib-core';

// The logger is created at import time, before any mock is cleared.
const loggerModuleNames = h.logger.module.mock.calls.map((call): unknown => call[0]);

const ISSUER = 'did:web:issuer.example';
const OPTIONS = { nonce: 'n-1', audience: 'aud-1', tenantId: 'tenant-1' };
const ENV = { VERIFIER_IDENTIFIER: 'x' } as unknown as Env;
const KEY = { sentinel: 'issuer-key' } as unknown as CryptoKey;

const b64 = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwtWith = (header: unknown) => `${b64(header)}.${b64({})}.sig`;

function policy(overrides: Record<string, unknown> = {}) {
  return {
    requireHolderBinding: true,
    requireIssuerTrust: true,
    requireStatusCheck: false,
    ...overrides,
  };
}

interface Setup {
  payload?: Record<string, unknown>;
  issuerJwt?: string;
  kbJwt?: string | null;
  policy?: Record<string, unknown>;
  trust?: Record<string, unknown>;
  verify?: Record<string, unknown>;
  token?: string;
}

function setup(s: Setup = {}) {
  vi.mocked(getHaipPolicy).mockReturnValue(policy(s.policy) as never);
  vi.mocked(parseSDJWTVC).mockResolvedValue({
    payload: { iss: ISSUER, vct: 'vct-1', ...s.payload },
    disclosures: [],
    issuerJwt: s.issuerJwt ?? jwtWith({ alg: 'ES256' }),
    kbJwt: s.kbJwt === undefined ? 'kb' : s.kbJwt,
  } as never);
  vi.mocked(checkIssuerTrust).mockResolvedValue({
    trusted: true,
    jwksUri: 'https://issuer.example/jwks',
    ...s.trust,
  } as never);
  vi.mocked(getIssuerPublicKey).mockResolvedValue(KEY);
  vi.mocked(verifySDJWTVC).mockResolvedValue({
    verified: true,
    disclosedClaims: { a: 1 },
    holderBindingVerified: true,
    ...s.verify,
  } as never);
  return () => verifyVPToken(ENV, s.token ?? jwtWith({ alg: 'ES256' }), OPTIONS);
}

beforeEach(() => {
  vi.resetAllMocks();
  h.evaluatorPolicies.length = 0;
  h.logger.module.mockReturnValue(h.logger);
  h.validate.mockReturnValue({ valid: true, haipCompliant: true, errors: [], warnings: [] });
  vi.mocked(createVCConfigManager).mockReturnValue({
    getHaipPolicyVersion: vi.fn().mockResolvedValue('final-1.0'),
  } as never);
  vi.mocked(resolveAuthCorePersistenceAdapterFromEnv).mockResolvedValue({ adapter: 1 } as never);
  vi.mocked(getCredentialStatusValue).mockResolvedValue(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('verifyVPToken: envelope', () => {
  it('names its logger module', () => {
    expect(loggerModuleNames).toContain('VC-VP-VERIFIER');
  });

  it('returns the exact failure result for an unparsable token', async () => {
    vi.mocked(getHaipPolicy).mockReturnValue(policy() as never);
    vi.mocked(parseSDJWTVC).mockResolvedValue(null as never);
    expect(await verifyVPToken(ENV, 'x', OPTIONS)).toEqual({
      verified: false,
      holderBindingVerified: false,
      issuerTrusted: false,
      statusValid: false,
      errors: ['Invalid SD-JWT VC format'],
      warnings: [],
      haipCompliant: false,
    });
  });

  it('hides internal failures behind a generic error', async () => {
    const run = setup();
    vi.mocked(getHaipPolicy).mockImplementation(() => {
      throw new Error('secret detail');
    });
    expect(await run()).toEqual({
      verified: false,
      holderBindingVerified: false,
      issuerTrusted: false,
      statusValid: false,
      errors: ['Verification failed'],
      warnings: [],
      haipCompliant: false,
    });
    expect(h.logger.error).toHaveBeenCalledWith(
      'VP token verification failed',
      {},
      expect.objectContaining({ message: 'secret detail' })
    );
  });

  it('wires version, adapter, repository and trust lookup with the tenant', async () => {
    await setup()();
    expect(getHaipPolicy).toHaveBeenCalledWith('final-1.0');
    expect(h.evaluatorPolicies).toEqual([policy()]);
    expect(resolveAuthCorePersistenceAdapterFromEnv).toHaveBeenCalledWith(
      ENV,
      'vc-vp-verifier:tenant-1',
      { tenantId: 'tenant-1' }
    );
    expect(checkIssuerTrust).toHaveBeenCalledWith({ adapter: { adapter: 1 } }, ISSUER, 'tenant-1');
  });

  it('returns the full successful result with no errors', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const result = await setup({ payload: { exp: 2_000_000_000 } })();
    expect(result).toEqual({
      verified: true,
      issuerDid: ISSUER,
      credentialType: 'vct-1',
      format: 'dc+sd-jwt',
      disclosedClaims: { a: 1 },
      holderBindingVerified: true,
      issuerTrusted: true,
      statusValid: true,
      credentialExpiresAt: 2_000_000_000_000,
      statusCheckedAt: 1_700_000_000_000,
      statusFreshUntil: 1_700_000_000_000,
      errors: [],
      warnings: [],
      haipCompliant: true,
    });
  });

  it('clamps a negative exp to 0 and leaves a non-numeric exp undefined', async () => {
    expect((await setup({ payload: { exp: -5 } })()).credentialExpiresAt).toBe(0);
    expect((await setup({ payload: { exp: '5' } })()).credentialExpiresAt).toBeUndefined();
  });

  it('is not verified when the signature is invalid even without errors', async () => {
    const result = await setup({ verify: { verified: false } })();
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(false);
  });

  it('reports an untrusted issuer only when the policy requires trust', async () => {
    const untrusted = { trusted: false, jwksUri: undefined };
    const required = await setup({ trust: untrusted })();
    expect(required.errors).toEqual(['Issuer is not trusted']);
    expect(required.issuerTrusted).toBe(false);
    expect(required.verified).toBe(false);
    const optional = await setup({ trust: untrusted, policy: { requireIssuerTrust: false } })();
    expect(optional.errors).toEqual([]);
    expect(optional.verified).toBe(true);
  });

  it('keeps Unknown as the message of non-Error failures', async () => {
    const run = setup();
    vi.mocked(getIssuerPublicKey).mockRejectedValue('boom');
    expect((await run()).errors).toEqual([
      'Failed to get issuer public key: Unknown',
      'Key Binding JWT verification failed',
    ]);

    const run2 = setup();
    vi.mocked(verifySDJWTVC).mockRejectedValue('boom');
    expect((await run2()).errors).toEqual([
      'Signature verification failed: Unknown',
      'Key Binding JWT verification failed',
    ]);

    const run3 = setup({ payload: { status: { status_list: { uri: 'https://i/s', idx: 0 } } } });
    vi.mocked(getCredentialStatusValue).mockRejectedValue('boom');
    expect((await run3()).errors).toEqual(['Status check failed: Unknown']);
  });

  it('does not verify the signature without an issuer key', async () => {
    const run = setup();
    vi.mocked(getIssuerPublicKey).mockRejectedValue(new Error('no key'));
    const result = await run();
    expect(verifySDJWTVC).not.toHaveBeenCalled();
    expect(result.errors).toEqual([
      'Failed to get issuer public key: no key',
      'Key Binding JWT verification failed',
    ]);
    expect(result.disclosedClaims).toEqual({});
    expect(result.holderBindingVerified).toBe(false);
  });
});

describe('verifyVPToken: holder binding and HAIP evaluation', () => {
  it('tells a failed key binding from a missing one', async () => {
    const failed = await setup({ verify: { holderBindingVerified: false } })();
    expect(failed.errors).toEqual(['Key Binding JWT verification failed']);
    const missing = await setup({ kbJwt: null, verify: { holderBindingVerified: false } })();
    expect(missing.errors).toEqual(['Key Binding JWT required but not present']);
  });

  it('ignores a missing binding when the policy does not require it', async () => {
    const result = await setup({
      policy: { requireHolderBinding: false },
      verify: { holderBindingVerified: false },
    })();
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
  });

  it('hands the facts to the evaluator and merges its errors and warnings', async () => {
    h.validate.mockReturnValue({
      valid: false,
      haipCompliant: false,
      errors: ['haip-error'],
      warnings: ['haip-warning'],
    });
    const result = await setup({ token: `${jwtWith({ alg: 'ES384' })}~disclosure~kb` })();
    expect(h.validate).toHaveBeenCalledWith({
      algorithm: 'ES384',
      format: 'dc+sd-jwt',
      holderBindingVerified: true,
      issuerTrusted: true,
      statusValid: true,
    });
    expect(result.errors).toEqual(['haip-error']);
    expect(result.warnings).toEqual(['haip-warning']);
    expect(result.haipCompliant).toBe(false);
    expect(result.verified).toBe(false);
  });

  it('adds nothing from the evaluator when it is valid', async () => {
    h.validate.mockReturnValue({
      valid: true,
      haipCompliant: true,
      errors: ['must-not-appear'],
      warnings: ['kept'],
    });
    const result = await setup()();
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(['kept']);
  });

  it.each([
    ['ES384', jwtWith({ alg: 'ES384' }), 'ES384'],
    ['ES512', jwtWith({ alg: 'ES512' }), 'ES512'],
    ['a header without alg', jwtWith({}), 'ES256'],
    ['an empty alg', jwtWith({ alg: '' }), 'ES256'],
    ['no dot at all', 'nodot', 'ES256'],
    ['an unreadable header', '!!!.payload.sig', 'ES256'],
    ['two segments only', `${b64({ alg: 'ES384' })}.${b64({})}`, 'ES384'],
    ['a disclosure suffix', `${jwtWith({ alg: 'ES512' })}~d1~d2~kb`, 'ES512'],
  ])('reads the algorithm from %s', async (_name, token, expected) => {
    await setup({ token })();
    expect(h.validate.mock.calls[0][0].algorithm).toBe(expected);
  });
});

describe('verifyVPToken: issuer key id and holder key', () => {
  it.each([
    ['a kid', jwtWith({ alg: 'ES256', kid: 'k1' }), 'k1'],
    ['no kid', jwtWith({ alg: 'ES256' }), undefined],
    ['an empty kid', jwtWith({ alg: 'ES256', kid: '' }), undefined],
    ['a non-string kid', jwtWith({ alg: 'ES256', kid: 7 }), undefined],
    ['an unreadable header', 'garbage', undefined],
  ])('passes the header kid of %s to the key lookup', async (_name, issuerJwt, kid) => {
    await setup({ issuerJwt })();
    expect(getIssuerPublicKey).toHaveBeenCalledWith(
      ENV,
      ISSUER,
      'https://issuer.example/jwks',
      kid
    );
  });

  async function holderKeyFor(cnf: unknown) {
    await setup({ payload: { cnf } })();
    return vi.mocked(verifySDJWTVC).mock.calls.at(-1)?.[2] as unknown as CryptoKey | null;
  }

  it('imports a public EC holder key and bounds the verification inputs', async () => {
    const { publicKey } = await generateKeyPair('ES256', { extractable: true });
    const jwk = await exportJWK(publicKey);
    const key = await holderKeyFor({ jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } });
    expect(key?.type).toBe('public');
    expect(vi.mocked(verifySDJWTVC).mock.calls[0][0]).toBe(jwtWith({ alg: 'ES256' }));
    expect(vi.mocked(verifySDJWTVC).mock.calls[0][1]).toBe(KEY);
    expect(vi.mocked(verifySDJWTVC).mock.calls[0][3]).toEqual({
      issuer: ISSUER,
      vct: 'vct-1',
      nonce: 'n-1',
      audience: 'aud-1',
    });
  });

  it('accepts matching alg, use and key_ops restrictions and P-384 keys', async () => {
    const { publicKey } = await generateKeyPair('ES384', { extractable: true });
    const jwk = await exportJWK(publicKey);
    const base = { kty: 'EC', crv: 'P-384', x: jwk.x, y: jwk.y };
    for (const extra of [
      { alg: 'ES384' },
      { use: 'sig' },
      { key_ops: ['verify'] },
      { key_ops: ['sign', 'verify'] },
    ]) {
      expect(await holderKeyFor({ jwk: { ...base, ...extra } })).not.toBeNull();
    }
  });

  it('imports a P-521 holder key', async () => {
    const { publicKey } = await generateKeyPair('ES512', { extractable: true });
    const jwk = await exportJWK(publicKey);
    const key = await holderKeyFor({ jwk: { kty: 'EC', crv: 'P-521', x: jwk.x, y: jwk.y } });
    expect(key?.type).toBe('public');
  });

  it('refuses a holder key that is not a usable public signing EC key', async () => {
    const { publicKey } = await generateKeyPair('ES256', { extractable: true });
    const { x, y } = await exportJWK(publicKey);
    const ok = { kty: 'EC', crv: 'P-256', x, y };
    for (const cnf of [
      undefined,
      {},
      { jwk: { ...ok, kty: 'RSA' } },
      { jwk: { ...ok, kty: 'OKP' } },
      { jwk: { ...ok, d: 'private' } },
      { jwk: { ...ok, crv: 'secp256k1' } },
      { jwk: { ...ok, x: 5 } },
      { jwk: { ...ok, y: undefined } },
      { jwk: { ...ok, alg: 'ES384' } },
      { jwk: { ...ok, use: 'enc' } },
      { jwk: { ...ok, key_ops: ['sign'] } },
      { jwk: { ...ok, key_ops: 'verify' } },
      { jwk: { ...ok, x: 'AAAA', y: 'AAAA' } },
    ]) {
      expect(await holderKeyFor(cnf)).toBeNull();
    }
  });
});

describe('verifyVPToken: status claims', () => {
  const URI = 'https://issuer.example/status/1';
  const tsl = (status_list: unknown) => ({ status: { status_list } });
  const bitstring = (entry: unknown) => ({ credentialStatus: entry });
  const entry = {
    type: 'BitstringStatusListEntry',
    statusListCredential: URI,
    statusListIndex: 3,
    statusPurpose: 'revocation',
  };

  it('passes the list format, uri, index and cache bounds to the status lookup', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const result = await setup({ payload: tsl({ uri: URI, idx: 0 }) })();
    expect(getCredentialStatusValue).toHaveBeenCalledWith(URI, 0, {
      cacheTtlMs: 300_000,
      verifySignature: true,
      keyResolver: expect.any(Function),
      format: 'ietf_tsl_v1',
      expectedIssuer: ISSUER,
    });
    expect(result.statusValid).toBe(true);
    expect(result.statusCheckedAt).toBe(1_000_000);
    expect(result.statusFreshUntil).toBe(1_300_000);
    expect(result.errors).toEqual([]);
  });

  it('reads a bitstring entry with its own format and index', async () => {
    await setup({ payload: bitstring(entry) })();
    expect(getCredentialStatusValue).toHaveBeenCalledWith(
      URI,
      3,
      expect.objectContaining({ format: 'w3c_bitstring_v1' })
    );
  });

  it.each([
    ['a null status', { status: null }],
    ['a status without a list', { status: {} }],
    ['an empty uri', tsl({ uri: '', idx: 1 })],
    ['a non-string uri', tsl({ uri: 5, idx: 1 })],
    ['a negative index', tsl({ uri: URI, idx: -1 })],
    ['a fractional index', tsl({ uri: URI, idx: 1.5 })],
    ['a string index', tsl({ uri: URI, idx: '1' })],
  ])('rejects %s as a malformed status claim', async (_name, payload) => {
    const result = await setup({ payload })();
    expect(result.errors).toEqual(['Status check failed: Malformed status claim']);
    expect(result.statusValid).toBe(false);
    expect(result.verified).toBe(false);
    expect(getCredentialStatusValue).not.toHaveBeenCalled();
  });

  it('accepts index 0 and a one-character uri', async () => {
    const result = await setup({ payload: tsl({ uri: 'u', idx: 0 }) })();
    expect(result.statusValid).toBe(true);
    expect(getCredentialStatusValue).toHaveBeenCalledWith('u', 0, expect.anything());
  });

  it.each([
    ['a null entry', bitstring(null)],
    ['a wrong type', bitstring({ ...entry, type: 'Other' })],
    ['a missing credential', bitstring({ ...entry, statusListCredential: undefined })],
    ['an empty credential', bitstring({ ...entry, statusListCredential: '' })],
    ['a numeric credential', bitstring({ ...entry, statusListCredential: 5 })],
    ['a string index', bitstring({ ...entry, statusListIndex: '3' })],
  ])('rejects %s as a malformed credentialStatus claim', async (_name, payload) => {
    const result = await setup({ payload })();
    expect(result.errors).toEqual(['Status check failed: Malformed credentialStatus claim']);
    expect(result.statusValid).toBe(false);
  });

  it('rejects both claims at once', async () => {
    const result = await setup({
      payload: { ...tsl({ uri: URI, idx: 0 }), ...bitstring(entry) },
    })();
    expect(result.errors).toEqual(['Status check failed: Ambiguous status claim']);
  });

  it('words the refusal by status value and list purpose', async () => {
    const run = async (payload: Record<string, unknown>, value: number) => {
      const go = setup({ payload });
      vi.mocked(getCredentialStatusValue).mockResolvedValue(value);
      return (await go()).errors;
    };
    expect(await run(tsl({ uri: URI, idx: 0 }), 1)).toEqual(['Credential has been revoked']);
    expect(await run(tsl({ uri: URI, idx: 0 }), 2)).toEqual(['Credential has been suspended']);
    expect(await run(bitstring(entry), 1)).toEqual(['Credential has been revoked']);
    expect(await run(bitstring({ ...entry, statusPurpose: 'suspension' }), 1)).toEqual([
      'Credential has been suspended',
    ]);
    expect(await run(bitstring({ ...entry, statusPurpose: 'other' }), 1)).toEqual([
      'Credential has been revoked',
    ]);
    expect(await run(bitstring({ ...entry, statusPurpose: undefined }), 1)).toEqual([
      'Credential has been revoked',
    ]);
  });

  it('requires a status claim only when the policy does', async () => {
    const required = await setup({ policy: { requireStatusCheck: true } })();
    expect(required.errors).toEqual(['Status claim required but not present in credential']);
    expect(required.statusValid).toBe(false);
    expect(h.validate.mock.calls[0][0].statusValid).toBe(false);
    const optional = await setup()();
    expect(optional.errors).toEqual([]);
    expect(optional.statusValid).toBe(true);
    expect(h.validate.mock.calls[1][0].statusValid).toBe(true);
  });

  describe('status list key resolver', () => {
    const OTHER = { sentinel: 'other-key' } as unknown as CryptoKey;

    async function resolver(issuerJwt: string) {
      await setup({ payload: tsl({ uri: URI, idx: 0 }), issuerJwt })();
      vi.mocked(getIssuerPublicKey).mockClear();
      vi.mocked(getIssuerPublicKey).mockResolvedValue(OTHER);
      const options = vi.mocked(getCredentialStatusValue).mock.calls[0][2] as {
        keyResolver: (issuer: string, kid?: string) => Promise<CryptoKey>;
      };
      return options.keyResolver;
    }

    it('refuses a list of another issuer', async () => {
      const keyResolver = await resolver(jwtWith({ alg: 'ES256', kid: 'k1' }));
      await expect(keyResolver('did:web:attacker.example', 'k1')).rejects.toThrow(
        'Status List issuer mismatch: credential and status list have different issuers'
      );
      expect(getIssuerPublicKey).not.toHaveBeenCalled();
    });

    it('reuses the credential key for no kid or the credential kid', async () => {
      const keyResolver = await resolver(jwtWith({ alg: 'ES256', kid: 'k1' }));
      expect(await keyResolver(ISSUER, undefined)).toBe(KEY);
      expect(await keyResolver(ISSUER, 'k1')).toBe(KEY);
      expect(getIssuerPublicKey).not.toHaveBeenCalled();
    });

    it('looks up the key a list names when it is another one', async () => {
      const keyResolver = await resolver(jwtWith({ alg: 'ES256', kid: 'k1' }));
      expect(await keyResolver(ISSUER, 'k2')).toBe(OTHER);
      expect(getIssuerPublicKey).toHaveBeenCalledWith(
        ENV,
        ISSUER,
        'https://issuer.example/jwks',
        'k2'
      );
    });

    it('treats a kid-less credential and a named list key as different keys', async () => {
      const keyResolver = await resolver(jwtWith({ alg: 'ES256' }));
      expect(await keyResolver(ISSUER, 'k9')).toBe(OTHER);
      expect(await keyResolver(ISSUER, undefined)).toBe(KEY);
    });
  });
});
