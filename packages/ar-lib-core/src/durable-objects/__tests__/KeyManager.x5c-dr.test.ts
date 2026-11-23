/**
 * An exception inside a replication write permit is kept as an unconfirmed write and blocks a later
 * switch of the primary. The VC certificate-chain RPCs must therefore return their expected
 * refusals out of the permit and throw them afterwards. These tests wrap the covered operation and
 * record every exception that escapes the callback.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { KeyManager } from '../KeyManager.ts';
import type { Env } from '../../types/env';
import { buildCertificate, bytesToBase64 } from '../../vc/x509-certificate';

const escaped = vi.hoisted(() => ({ errors: [] as string[], depth: 0 }));

vi.mock('../../utils/keys', () => ({
  generateKeySet: async (kid: string) => ({
    publicJWK: { kty: 'RSA', kid, n: `mock-modulus-${kid}`, e: 'AQAB' },
    privatePEM: ['-----BEGIN PRIVATE KEY-----', `mock-${kid}`, '-----END PRIVATE KEY-----'].join(
      '\n'
    ),
  }),
}));

vi.mock('../../services/tenant-portability/saml-dr-writer', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../services/tenant-portability/saml-dr-writer')>();
  return {
    ...original,
    runSamlDrCoveredOperation: ((
      env: never,
      context: never,
      operation: (...a: never[]) => Promise<unknown>
    ) =>
      original.runSamlDrCoveredOperation(env, context, async (...args: never[]) => {
        // Only an exception that leaves the outermost covered operation is one that would leave a
        // permit open; a nested covered call (rotateECKeys inside a signing RPC) is handled by its
        // caller.
        escaped.depth += 1;
        const outermost = escaped.depth === 1;
        try {
          return await operation(...args);
        } catch (error) {
          if (outermost)
            escaped.errors.push(error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          escaped.depth -= 1;
        }
      })) as typeof original.runSamlDrCoveredOperation,
  };
});

class MockState {
  map = new Map<string, unknown>();
  private async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  storage = {
    get: async <T>(key: string): Promise<T | undefined> => this.map.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => this.put(key, value),
    delete: async (key: string): Promise<void> => {
      this.map.delete(key);
    },
    list: async (): Promise<Map<string, unknown>> => new Map(this.map),
    transaction: async <T>(
      callback: (tx: { put: (key: string, value: unknown) => Promise<void> }) => Promise<T>
    ) => callback({ put: (key, value) => this.put(key, value) }),
  };
  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }
}

const HOST = 'issuer.example.com';
const HOUR = 3_600_000;

async function chainFor(publicKey: JWK) {
  const root = await generateKeyPair('ES256', { extractable: true });
  const ca = await generateKeyPair('ES256', { extractable: true });
  const rootJwk = await exportJWK(root.publicKey);
  const caJwk = await exportJWK(ca.publicKey);
  const sign = (key: CryptoKey) => async (tbs: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, tbs));
  const now = Date.now();
  const caCert = await buildCertificate(
    {
      subject: { commonName: 'Test CA' },
      issuer: { commonName: 'Test Root' },
      subjectPublicKey: caJwk,
      issuerPublicKey: rootJwk,
      notBefore: new Date(now - HOUR),
      notAfter: new Date(now + 100 * HOUR),
      isCA: true,
      pathLength: 0,
    },
    sign(root.privateKey)
  );
  const leaf = await buildCertificate(
    {
      subject: { commonName: HOST },
      issuer: { commonName: 'Test CA' },
      subjectPublicKey: publicKey,
      issuerPublicKey: caJwk,
      notBefore: new Date(now - HOUR),
      notAfter: new Date(now + 48 * HOUR),
      dnsNames: [HOST],
      isCA: false,
    },
    sign(ca.privateKey)
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', caCert));
  return {
    chain: [bytesToBase64(leaf), bytesToBase64(caCert)],
    fingerprint: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

describe('VC certificate chain RPCs inside a replication write permit', () => {
  let state: MockState;
  let env: Env;
  let keyManager: KeyManager;

  beforeEach(() => {
    escaped.errors.length = 0;
    escaped.depth = 0;
    state = new MockState();
    env = {
      KEY_MANAGER_SECRET: 'test-secret-token',
      ISSUER_URL: 'https://test.example.com',
    } as Env;
    keyManager = new KeyManager(state as unknown as DurableObjectState, env);
  });

  const vcPayload = () => ({
    iss: `https://${HOST}`,
    vct: 'https://authrim.com/credentials/admin/v1',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    _sd_alg: 'sha-256',
    _sd: ['digest-a'],
  });

  it('returns x5c_required out of the permit scope for both signing RPCs', async () => {
    await keyManager.rotateECKeysRpc('ES256');
    escaped.errors.length = 0;
    escaped.depth = 0;
    await expect(keyManager.signSDJWTIssuerRpc(vcPayload(), { requireX5c: true })).rejects.toThrow(
      'x5c_required'
    );
    const now = Math.floor(Date.now() / 1000);
    await expect(
      keyManager.signStatusListCredentialRpc(
        {
          iss: `https://${HOST}`,
          sub: `https://${HOST}/vci/status-lists/a`,
          iat: now,
          exp: now + 3600,
          ttl: 300,
          status_list: { bits: 2, lst: 'eJzTBwAAAQAB' },
        },
        { requireX5c: true }
      )
    ).rejects.toThrow('x5c_required');
    expect(escaped.errors).toEqual([]);
  });

  it('returns refusals for malformed signing payloads out of the permit scope', async () => {
    await keyManager.rotateECKeysRpc('ES256');
    escaped.errors.length = 0;
    escaped.depth = 0;
    const now = Math.floor(Date.now() / 1000);
    const cycle: Record<string, unknown> = { iss: `https://${HOST}`, vct: 'v', iat: now };
    cycle.self = cycle;
    for (const payload of [
      { ...vcPayload(), vct: undefined },
      { ...vcPayload(), iat: now - 3600 },
      { ...vcPayload(), _sd_alg: 'sha-1' },
      { ...vcPayload(), big: 'x'.repeat(70 * 1024) },
      cycle,
    ]) {
      await expect(keyManager.signSDJWTIssuerRpc(payload as never)).rejects.toThrow(
        'invalid_sd_jwt_issuer_signing_input'
      );
    }
    for (const payload of [
      { iss: `https://${HOST}`, iat: now },
      {
        iss: `https://${HOST}`,
        status_list: { bits: 2, lst: 'x' },
        big: 'x'.repeat(5 * 1024 * 1024),
      },
      cycle,
    ]) {
      await expect(keyManager.signStatusListCredentialRpc(payload as never)).rejects.toThrow(
        'invalid_status_list_signing_input'
      );
    }
    expect(escaped.errors).toEqual([]);
  });

  it('refuses non-object payloads and non-finite time claims without an exception in the permit', async () => {
    await keyManager.rotateECKeysRpc('ES256');
    escaped.errors.length = 0;
    escaped.depth = 0;
    const now = Math.floor(Date.now() / 1000);
    for (const payload of [null, undefined, 'text', 5, [], { ...vcPayload(), iat: Number.NaN }]) {
      await expect(keyManager.signSDJWTIssuerRpc(payload as never)).rejects.toThrow(
        'invalid_sd_jwt_issuer_signing_input'
      );
    }
    for (const claims of [
      { exp: Number.POSITIVE_INFINITY },
      { nbf: Number.POSITIVE_INFINITY },
      { exp: 'later' },
    ]) {
      await expect(
        keyManager.signSDJWTIssuerRpc({ ...vcPayload(), ...claims } as never)
      ).rejects.toThrow('invalid_sd_jwt_issuer_signing_input');
    }
    const legacy = (statusPurpose: unknown, extra: Record<string, unknown> = {}) => ({
      iss: 'did:web:issuer.example.com',
      sub: 'https://issuer.example.com/vci/status/list-a',
      iat: now,
      exp: now + 3600,
      vc: {
        type: ['VerifiableCredential', 'BitstringStatusListCredential'],
        credentialSubject: { type: 'BitstringStatusList', statusPurpose, encodedList: 'x' },
      },
      ...extra,
    });
    for (const payload of [
      null,
      undefined,
      'text',
      [],
      legacy(Symbol('x')),
      legacy({ toString: () => 'revocation' }),
      legacy('revocation', { nbf: Number.POSITIVE_INFINITY }),
    ]) {
      await expect(keyManager.signStatusListCredentialRpc(payload as never)).rejects.toThrow(
        'invalid_status_list_signing_input'
      );
    }
    expect(escaped.errors).toEqual([]);
  });

  it('measures the payload limit in UTF-8 bytes, not characters', async () => {
    await keyManager.rotateECKeysRpc('ES256');
    escaped.errors.length = 0;
    escaped.depth = 0;
    // 25 000 three-byte characters are 75 000 bytes: over 64 KiB, though under 64 K characters.
    const wide = { ...vcPayload(), note: 'あ'.repeat(25_000) };
    expect(JSON.stringify(wide).length).toBeLessThan(64 * 1024);
    await expect(keyManager.signSDJWTIssuerRpc(wide)).rejects.toThrow(
      'invalid_sd_jwt_issuer_signing_input'
    );
    const narrow = { ...vcPayload(), note: 'あ'.repeat(10_000) };
    await expect(keyManager.signSDJWTIssuerRpc(narrow)).resolves.toBeDefined();
    expect(escaped.errors).toEqual([]);
  });

  it('returns the key retention cap as a refusal, not an exception in the permit', async () => {
    await keyManager.rotateECKeysRpc('ES256');
    const stored = state.map.get('ecState') as {
      keys: unknown[];
      activeKeyIds: Record<string, string>;
      retiredPublicKeys?: unknown[];
    };
    const now = Date.now();
    stored.keys = [];
    stored.activeKeyIds = {};
    stored.retiredPublicKeys = Array.from({ length: 1024 }, (_, index) => ({
      kid: `retired-${index}`,
      algorithm: 'ES256',
      publicJWK: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: `retired-${index}` },
      retiredAt: now - 1000,
      retainUntil: now + 10_000_000,
    }));
    state.map.set('ecState', stored);
    const restarted = new KeyManager(state as unknown as DurableObjectState, env);
    escaped.errors.length = 0;
    escaped.depth = 0;
    await expect(restarted.signSDJWTIssuerRpc(vcPayload())).rejects.toThrow(
      'vc_issuer_key_retention_cap_reached'
    );
    expect(escaped.errors).toEqual([]);
  });

  it('returns every expected registration refusal out of the permit scope', async () => {
    const key = await keyManager.rotateECKeysRpc('ES256');
    const { chain, fingerprint } = await chainFor(key.publicJWK);
    escaped.errors.length = 0;
    escaped.depth = 0;

    // No issuing CA configured.
    await expect(
      keyManager.setVcIssuerKeyCertificateChainRpc({ kid: key.kid, chain, issuerHost: HOST })
    ).rejects.toThrow('vc_x5c_trust_anchor_not_configured');
    // Unknown key.
    env.VC_X5C_ISSUING_CA_SHA256 = fingerprint;
    await expect(
      keyManager.setVcIssuerKeyCertificateChainRpc({ kid: 'nope', chain, issuerHost: HOST })
    ).rejects.toThrow('vc_issuer_key_not_found');
    // A chain that does not validate (wrong host) and an untrusted CA.
    await expect(
      keyManager.setVcIssuerKeyCertificateChainRpc({
        kid: key.kid,
        chain,
        issuerHost: 'other.example.com',
      })
    ).rejects.toThrow('leaf_host_mismatch');
    env.VC_X5C_ISSUING_CA_SHA256 = 'c'.repeat(64);
    await expect(
      keyManager.setVcIssuerKeyCertificateChainRpc({ kid: key.kid, chain, issuerHost: HOST })
    ).rejects.toThrow('untrusted_issuing_ca');
    expect(escaped.errors).toEqual([]);
  });

  it('throws from inside the permit only when the outcome of a save is unknown', async () => {
    const key = await keyManager.rotateECKeysRpc('ES256');
    const { chain, fingerprint } = await chainFor(key.publicJWK);
    env.VC_X5C_ISSUING_CA_SHA256 = fingerprint;
    escaped.errors.length = 0;
    escaped.depth = 0;
    vi.spyOn(state.storage, 'put').mockRejectedValueOnce(new Error('synthetic storage failure'));
    await expect(
      keyManager.setVcIssuerKeyCertificateChainRpc({ kid: key.kid, chain, issuerHost: HOST })
    ).rejects.toThrow('synthetic storage failure');
    expect(escaped.errors).toEqual(['synthetic storage failure']);
  });

  it('returns refusals for malformed signing options and key ids out of the permit scope', async () => {
    await keyManager.rotateECKeysRpc('ES256');
    escaped.errors.length = 0;
    escaped.depth = 0;
    await expect(
      keyManager.signSDJWTIssuerRpc(vcPayload(), { requireX5c: 'yes' } as never)
    ).rejects.toThrow('invalid_vc_signing_options');
    await expect(
      keyManager.setVcIssuerKeyCertificateChainRpc({ kid: ' ', chain: [], issuerHost: HOST })
    ).rejects.toThrow('invalid_kid');
    await expect(
      keyManager.setVcIssuerKeyCertificateChainRpc({ kid: 'k', chain: [], issuerHost: 5 as never })
    ).rejects.toThrow('invalid_issuer_host');
    expect(escaped.errors).toEqual([]);
  });
});
