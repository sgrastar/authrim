/**
 * Issuing CA handling: the reason of each refusal, the CA cache, the back-off and its bounded
 * memory, and every renewal boundary.
 */

import { exportJWK, exportPKCS8, generateKeyPair, type JWK } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCertificate, bytesToBase64, parseCertificate } from '@authrim/ar-lib-core';

const h = vi.hoisted(() => {
  const logger = { module: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  logger.module.mockReturnValue(logger);
  return { logger, verifyCertificateSignature: vi.fn() };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  h.verifyCertificateSignature.mockImplementation(actual.verifyCertificateSignature);
  return {
    ...actual,
    createLogger: vi.fn(() => h.logger),
    verifyCertificateSignature: h.verifyCertificateSignature,
  };
});

import {
  ensureVcSigningCertificate,
  resetIssuerCaState,
  type IssuerCaEnv,
  type VcCertificateKeyManager,
} from '../issuer-ca';

const loggerModuleNames = h.logger.module.mock.calls.map((call): unknown => call[0]);
const MINUTE = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-23T00:00:00Z');
const HOST = 'issuer.example.com';
const URL = `https://${HOST}`;
const WARNING = 'No issuer certificate for the VC signing key';

async function pair() {
  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  return {
    privateKey: keys.privateKey,
    publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } as JWK,
  };
}
const signWith = (key: CryptoKey) => async (tbs: Uint8Array) =>
  new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, tbs));
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** One root and one issuing CA for the whole file: keys are slow to generate. */
let root: Awaited<ReturnType<typeof pair>>;
let ca: Awaited<ReturnType<typeof pair>>;
let pem: string;
const cas = new Map<string, { env: IssuerCaEnv; fingerprint: string; der: Uint8Array }>();

async function makeCa(notBefore = NOW - DAY, notAfter = NOW + 1000 * DAY) {
  const key = `${notBefore}:${notAfter}`;
  const known = cas.get(key);
  if (known) return known;
  const der = await buildCertificate(
    {
      subject: { commonName: 'Test Issuing CA', organization: 'Authrim' },
      issuer: { commonName: 'Test Root CA', organization: 'Authrim' },
      subjectPublicKey: ca.publicJwk,
      issuerPublicKey: root.publicJwk,
      notBefore: new Date(notBefore),
      notAfter: new Date(notAfter),
      isCA: true,
      pathLength: 0,
    },
    signWith(root.privateKey)
  );
  const fingerprint = await sha256Hex(der);
  const made = {
    env: {
      VC_ISSUING_CA_PRIVATE_KEY_PEM: pem,
      VC_ISSUING_CA_CERTIFICATE: bytesToBase64(der),
      VC_X5C_ISSUING_CA_SHA256: fingerprint,
    } as IssuerCaEnv,
    fingerprint,
    der,
  };
  cas.set(key, made);
  return made;
}

type State = {
  kid: string;
  publicJWK: JWK;
  issuerHost: string | null;
  caSha256: string | null;
  chainNotAfter: number | null;
};
let holderKey: JWK;
function manager(overrides: Partial<State> = {}, register = vi.fn(async () => undefined)) {
  const km: VcCertificateKeyManager = {
    getVcSigningCertificateStateRpc: vi.fn(async () => ({
      kid: 'kid-1',
      publicJWK: holderKey,
      issuerHost: null,
      caSha256: null,
      chainNotAfter: null,
      ...overrides,
    })),
    setVcIssuerKeyCertificateChainRpc: register as never,
  };
  return { km, register };
}
const warnReasons = () =>
  h.logger.warn.mock.calls
    .filter((call) => call[0] === WARNING)
    .map((call) => (call[1] as { reason: string }).reason);

let spyImportKey: { mock: { calls: unknown[][] }; mockRestore(): void } | undefined;

beforeEach(async () => {
  if (!root) {
    root = await pair();
    ca = await pair();
    holderKey = (await pair()).publicJwk;
    pem = await exportPKCS8(ca.privateKey);
  }
  resetIssuerCaState();
  vi.clearAllMocks();
  h.logger.module.mockReturnValue(h.logger);
});
afterEach(() => {
  spyImportKey?.mockRestore();
});

const ensure = (
  env: IssuerCaEnv,
  km: VcCertificateKeyManager,
  now = NOW,
  url = URL,
  key = 't1',
  until?: number
) => ensureVcSigningCertificate(env, km, url, key, now, until);

describe('issuing CA refusals name their reason', () => {
  it('names its logger module', () => {
    expect(loggerModuleNames).toContain('VC-ISSUER-CA');
  });

  it('is disabled when any of the three settings is missing or blank', async () => {
    const { env } = await makeCa();
    for (const key of Object.keys(env) as (keyof IssuerCaEnv)[]) {
      resetIssuerCaState();
      expect(await ensure({ ...env, [key]: '  ' }, manager().km)).toBe('disabled');
    }
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('reports an untrusted fingerprint and accepts a padded, upper-case trust list', async () => {
    const { env, fingerprint } = await makeCa();
    expect(await ensure({ ...env, VC_X5C_ISSUING_CA_SHA256: 'f'.repeat(64) }, manager().km)).toBe(
      'failed'
    );
    expect(warnReasons()).toEqual(['issuing_ca_not_trusted']);
    resetIssuerCaState();
    const padded = `${'0'.repeat(64)} ,  ${fingerprint.toUpperCase()} `;
    expect(await ensure({ ...env, VC_X5C_ISSUING_CA_SHA256: padded }, manager().km)).toBe('issued');
  });

  it('reports a certificate that is unreadable, and one with line breaks is read', async () => {
    const { env } = await makeCa();
    expect(await ensure({ ...env, VC_ISSUING_CA_CERTIFICATE: 'AAAA' }, manager().km)).toBe(
      'failed'
    );
    expect(warnReasons()).toEqual(['issuing_ca_unreadable']);
    resetIssuerCaState();
    const wrapped = (env.VC_ISSUING_CA_CERTIFICATE ?? '').replace(/(.{64})/g, '$1\n');
    expect(await ensure({ ...env, VC_ISSUING_CA_CERTIFICATE: wrapped }, manager().km)).toBe(
      'issued'
    );
  });

  it('reports a certificate that is not a CA', async () => {
    const der = await buildCertificate(
      {
        subject: { commonName: 'leaf.example.com' },
        issuer: { commonName: 'Test Root CA', organization: 'Authrim' },
        subjectPublicKey: ca.publicJwk,
        issuerPublicKey: root.publicJwk,
        notBefore: new Date(NOW - DAY),
        notAfter: new Date(NOW + 100 * DAY),
        isCA: false,
        dnsNames: ['leaf.example.com'],
      },
      signWith(root.privateKey)
    );
    const { env } = await makeCa();
    const notCa = {
      ...env,
      VC_ISSUING_CA_CERTIFICATE: bytesToBase64(der),
      VC_X5C_ISSUING_CA_SHA256: await sha256Hex(der),
    };
    expect(await ensure(notCa, manager().km)).toBe('failed');
    expect(warnReasons()).toEqual(['issuing_ca_not_a_ca']);
  });

  it('reports a private key that does not belong to the certificate', async () => {
    const other = await pair();
    const { env } = await makeCa();
    const wrong = await exportPKCS8(other.privateKey);
    expect(await ensure({ ...env, VC_ISSUING_CA_PRIVATE_KEY_PEM: wrong }, manager().km)).toBe(
      'failed'
    );
    expect(warnReasons()).toEqual(['issuing_ca_key_mismatch']);
  });

  it('reports a CA outside its validity, and accepts the very first and last instant', async () => {
    const { env } = await makeCa(NOW - DAY, NOW + 20 * DAY);
    expect(await ensure(env, manager().km, NOW - DAY - 1000)).toBe('failed');
    expect(await ensure(env, manager().km, NOW + 20 * DAY + 1000, URL, 't2')).toBe('failed');
    expect(warnReasons()).toEqual(['issuing_ca_not_valid_now', 'issuing_ca_not_valid_now']);
    resetIssuerCaState();
    h.logger.warn.mockClear();
    expect(await ensure(env, manager().km, NOW - DAY)).toBe('issued');
    resetIssuerCaState();
    // At the very end the CA is still valid, but too short to issue a leaf.
    expect(await ensure(env, manager().km, NOW + 20 * DAY)).toBe('failed');
    expect(warnReasons()).toEqual(['issuing_ca_expiring']);
  });

  it('reports an invalid and a not allowed issuer host', async () => {
    const { env } = await makeCa();
    expect(await ensure(env, manager().km, NOW, 'http://issuer.example.com')).toBe('failed');
    expect(await ensure(env, manager().km, NOW, 'not a url', 't2')).toBe('failed');
    const restricted = { ...env, VC_X5C_ALLOWED_ISSUER_HOSTS: 'other.example.com' };
    expect(await ensure(restricted, manager().km, NOW, URL, 't3')).toBe('failed');
    expect(warnReasons()).toEqual([
      'invalid_issuer_host',
      'invalid_issuer_host',
      'issuer_host_not_allowed',
    ]);
  });

  it('allows a 64 character host and refuses a 65 character one', async () => {
    const { env } = await makeCa();
    const host64 = `${'a'.repeat(52)}.example.com`;
    expect(host64).toHaveLength(64);
    expect(await ensure(env, manager().km, NOW, `https://${host64}`)).toBe('issued');
    expect(await ensure(env, manager().km, NOW, `https://a${host64}`, 't2')).toBe('failed');
    expect(warnReasons()).toEqual(['invalid_issuer_host']);
  });

  it('allows a wildcard entry for a one-letter label but not for the bare domain', async () => {
    const { env } = await makeCa();
    const wildcard = { ...env, VC_X5C_ALLOWED_ISSUER_HOSTS: '*.example.com' };
    expect(await ensure(wildcard, manager().km, NOW, 'https://a.example.com')).toBe('issued');
    expect(await ensure(wildcard, manager().km, NOW, 'https://example.com', 't2')).toBe('failed');
    expect(warnReasons()).toEqual(['issuer_host_not_allowed']);
  });

  it('reports the message of a failing KeyManager, or unknown for a non-error', async () => {
    const { env } = await makeCa();
    const failing = manager(
      {},
      vi.fn(async () => Promise.reject(new Error('kv down')))
    );
    expect(await ensure(env, failing.km)).toBe('failed');
    const rejectingPlain = vi.fn();
    rejectingPlain.mockRejectedValue('plain');
    const odd = manager({}, rejectingPlain);
    expect(await ensure(env, odd.km, NOW, URL, 't2')).toBe('failed');
    expect(warnReasons()).toEqual(['kv down', 'unknown']);
  });

  it('never registers a leaf the CA certificate cannot verify', async () => {
    const { env } = await makeCa();
    h.verifyCertificateSignature.mockResolvedValueOnce(false);
    const { km, register } = manager();
    expect(await ensure(env, km)).toBe('failed');
    expect(register).not.toHaveBeenCalled();
    expect(warnReasons()).toEqual(['issued_leaf_does_not_verify']);
  });
});

describe('issuing CA cache', () => {
  async function checks(configure: (env: IssuerCaEnv) => IssuerCaEnv, dt: number, spec = 'pkcs8') {
    const { env } = await makeCa();
    spyImportKey = vi.spyOn(crypto.subtle, 'importKey');
    const km = manager().km;
    await ensure(env, km, NOW, URL, 'a');
    await ensure(configure(env), km, NOW + dt, URL, 'b');
    return (spyImportKey?.mock.calls ?? []).filter((call) => call[0] === spec).length;
  }
  const same = (env: IssuerCaEnv) => env;

  it('reuses a checked CA for under five minutes and rereads it at five', async () => {
    expect(await checks(same, 5 * MINUTE - 1)).toBe(1);
    resetIssuerCaState();
    spyImportKey?.mockRestore();
    expect(await checks(same, 5 * MINUTE)).toBe(2);
  });

  it('rereads when only the certificate, the trust list or the key text changes', async () => {
    const { env } = await makeCa();
    expect(
      await checks(
        (e) => ({
          ...e,
          VC_ISSUING_CA_CERTIFICATE: `${(env.VC_ISSUING_CA_CERTIFICATE ?? '').slice(0, 40)}\n${(env.VC_ISSUING_CA_CERTIFICATE ?? '').slice(40)}`,
        }),
        1000
      )
    ).toBe(2);
    resetIssuerCaState();
    spyImportKey?.mockRestore();
    expect(
      await checks(
        (e) => ({
          ...e,
          VC_X5C_ISSUING_CA_SHA256: `${e.VC_X5C_ISSUING_CA_SHA256},${'0'.repeat(64)}`,
        }),
        1000
      )
    ).toBe(2);
    resetIssuerCaState();
    spyImportKey?.mockRestore();
    const keyText = (e: IssuerCaEnv) => e.VC_ISSUING_CA_PRIVATE_KEY_PEM ?? '';
    expect(
      await checks(
        (e) => ({
          ...e,
          VC_ISSUING_CA_PRIVATE_KEY_PEM: `${keyText(e).slice(0, 100)}\n${keyText(e).slice(100)}`,
        }),
        1000
      )
    ).toBe(2);
  });

  it('remembers a failed read for a minute only', async () => {
    const { env } = await makeCa();
    const bad = { ...env, VC_X5C_ISSUING_CA_SHA256: 'f'.repeat(64) };
    const reads = async (dt: number) => {
      resetIssuerCaState();
      const spy = vi.spyOn(crypto.subtle, 'digest');
      await ensure(bad, manager().km, NOW, URL, 'a');
      await ensure(bad, manager().km, NOW + dt, URL, 'b');
      const count = spy.mock.calls.length;
      spy.mockRestore();
      return count;
    };
    expect(await reads(MINUTE - 1)).toBe(1);
    expect(await reads(MINUTE)).toBe(2);
  });
});

describe('failure back-off', () => {
  it('holds a host back for a minute, per tenant and host', async () => {
    const { env } = await makeCa();
    const restricted = { ...env, VC_X5C_ALLOWED_ISSUER_HOSTS: 'b.example.com' };
    expect(await ensure(restricted, manager().km, NOW, 'https://a.example.com')).toBe('failed');
    h.logger.warn.mockClear();
    // Within the minute: refused without a new attempt.
    expect(await ensure(restricted, manager().km, NOW + MINUTE - 1, 'https://a.example.com')).toBe(
      'failed'
    );
    expect(warnReasons()).toEqual([]);
    // Another host of the same tenant is not held back by it.
    expect(await ensure(restricted, manager().km, NOW + 1, 'https://b.example.com')).toBe('issued');
    // At the minute the attempt is made again.
    expect(await ensure(restricted, manager().km, NOW + MINUTE, 'https://a.example.com')).toBe(
      'failed'
    );
    expect(warnReasons()).toEqual(['issuer_host_not_allowed']);
  });

  it('holds a key back for a minute and retries at the minute', async () => {
    const { env } = await makeCa(NOW - DAY, NOW + 3 * DAY);
    const { km, register } = manager();
    expect(await ensure(env, km)).toBe('failed');
    expect(warnReasons()).toEqual(['issuing_ca_expiring']);
    h.logger.warn.mockClear();
    expect(await ensure(env, km, NOW + MINUTE - 1)).toBe('failed');
    expect(warnReasons()).toEqual([]);
    expect(await ensure(env, km, NOW + MINUTE)).toBe('failed');
    expect(warnReasons()).toEqual(['issuing_ca_expiring']);
    expect(register).not.toHaveBeenCalled();
  });

  it('bounds the memory: expired entries go first, and only a full table is wiped', async () => {
    const { env } = await makeCa();
    const km = manager().km;
    const fail = (key: string, now: number) => ensure(env, km, now, 'http://bad.example.com', key);
    for (let index = 0; index < 250; index += 1) await fail(`early-${index}`, NOW);
    for (let index = 0; index < 250; index += 1) await fail(`late-${index}`, NOW + 30_000);
    h.logger.warn.mockClear();
    // The table is full; at the first entries' end they are dropped, the others kept.
    await fail('new', NOW + MINUTE);
    expect(warnReasons()).toEqual(['invalid_issuer_host']);
    h.logger.warn.mockClear();
    await fail('late-100', NOW + MINUTE + 1);
    expect(warnReasons()).toEqual([]);
    await fail('early-100', NOW + MINUTE + 1);
    expect(warnReasons()).toEqual(['invalid_issuer_host']);
  });

  it('wipes a table that is full of live entries', async () => {
    const { env } = await makeCa();
    const km = manager().km;
    const fail = (key: string, now: number) => ensure(env, km, now, 'http://bad.example.com', key);
    for (let index = 0; index < 500; index += 1) await fail(`k-${index}`, NOW);
    await fail('overflow', NOW + 1);
    h.logger.warn.mockClear();
    await fail('k-10', NOW + 2);
    expect(warnReasons()).toEqual(['invalid_issuer_host']);
    h.logger.warn.mockClear();
    await fail('overflow', NOW + 2);
    expect(warnReasons()).toEqual([]);
  });
});

describe('renewal boundaries', () => {
  const have = (days: number) => NOW + days * DAY;
  async function run(
    state: Partial<State>,
    options: { ca?: [number, number]; until?: number; days?: string } = {}
  ) {
    const made = await makeCa(...(options.ca ?? []));
    const { km, register } = manager({ issuerHost: HOST, caSha256: made.fingerprint, ...state });
    const env = { ...made.env, VC_X5C_LEAF_LIFETIME_DAYS: options.days };
    const result = await ensure(env, km, NOW, URL, 't1', options.until);
    return { result, register };
  }

  it('issues for a key without a chain, with a chain ending now, or of another CA', async () => {
    expect((await run({ chainNotAfter: null })).result).toBe('issued');
    expect((await run({ chainNotAfter: NOW })).result).toBe('issued');
    expect((await run({ chainNotAfter: have(300), caSha256: 'other' })).result).toBe('issued');
  });

  it('does not take a missing chain end for a live one even when the CA matches', async () => {
    const made = await makeCa();
    const result = await run({
      chainNotAfter: null,
      caSha256: made.fingerprint,
      issuerHost: 'x.example.com',
    });
    expect(result.result).toBe('issued');
  });

  it('keeps a chain of another host, and a good chain', async () => {
    expect((await run({ chainNotAfter: have(300), issuerHost: 'x.example.com' })).result).toBe(
      'current'
    );
    expect((await run({ chainNotAfter: have(300) })).result).toBe('current');
  });

  it('renews at exactly the renewal window and not before it', async () => {
    expect((await run({ chainNotAfter: have(30) + 1 })).result).toBe('current');
    expect((await run({ chainNotAfter: have(30) })).result).toBe('issued');
  });

  it('treats a chain that reaches the credential as covering it', async () => {
    expect((await run({ chainNotAfter: have(100) }, { until: have(100) })).result).toBe('current');
    expect((await run({ chainNotAfter: have(100) }, { until: have(100) + 1 })).result).toBe(
      'issued'
    );
  });

  it('does not renew when the CA would cut the new leaf short of a useful extension', async () => {
    // best end = CA end - 1 day = have + 1 day: exactly the minimum extension.
    const ca12: [number, number] = [NOW - DAY, NOW + 12 * DAY];
    expect((await run({ chainNotAfter: have(10) }, { ca: ca12 })).result).toBe('current');
    const ca13: [number, number] = [NOW - DAY, NOW + 13 * DAY];
    const longer = await run({ chainNotAfter: have(10) }, { ca: ca13 });
    expect(longer.result).toBe('issued');
  });

  it('issues a leaf of exactly the minimum life, but not a shorter one', async () => {
    expect((await run({}, { ca: [NOW - DAY, NOW + 8 * DAY] })).result).toBe('issued');
    const short = await run({}, { ca: [NOW - DAY, NOW + 8 * DAY - 1000] });
    expect(short.result).toBe('failed');
    expect(warnReasons()).toEqual(['issuing_ca_expiring']);
  });

  it.each([
    ['8', 8],
    ['825', 825],
    ['7', 400],
    ['826', 400],
    ['abc', 400],
    [undefined, 400],
  ])('reads the leaf lifetime setting %s as %s days', async (setting, days) => {
    const { register } = await run({}, { days: setting });
    const chain = (register.mock.calls[0] as unknown as [{ chain: string[] }])[0].chain;
    const leaf = parseCertificate(Uint8Array.from(atob(chain[0]), (c) => c.charCodeAt(0)));
    expect(leaf.notAfter.getTime()).toBe(NOW + days * DAY);
  });
});
