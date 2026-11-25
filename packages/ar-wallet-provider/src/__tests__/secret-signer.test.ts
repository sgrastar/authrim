import { describe, expect, it } from 'vitest';
import { createSecretSigner } from '../cloudflare/secret-signer';
import { NOW, makeProviderSide } from './support/service-world';
import { genPair, exportSpki } from './support/keys';

const wallet = {
  iss: 'https://p',
  sub: 'keyring-ios',
  iat: NOW,
  exp: NOW + 3600,
  cnf: { jwk: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(42) + 'Q', y: 'A'.repeat(42) + 'Q' } },
} as const;

async function signer(secret: string | undefined, t = NOW, pin?: string) {
  return createSecretSigner({
    walletSecret: secret,
    keySecret: undefined,
    walletIntermediateSha256: pin,
    keyIntermediateSha256: undefined,
    now: () => t,
  });
}

describe('secret signer', () => {
  it('signs, and reports the chain limit as health', async () => {
    const side = await makeProviderSide('W');
    const s = await signer(side.secret, NOW, side.anchor.sha256);
    expect(
      'jwt' in (await s.signWalletAttestation({ ...wallet, cnf: { jwk: { ...wallet.cnf.jwk } } }))
    ).toBe(true);
    const { chainNotAfter } = await s.health();
    expect(chainNotAfter.wallet).toBe(NOW + 30 * 86400);
    expect(chainNotAfter.key).toBe(0); // not configured
  });

  it('refuses missing, malformed, mismatched, EKU, expired and not-yet-valid secrets', async () => {
    const claims = { ...wallet, cnf: { jwk: { ...wallet.cnf.jwk } } };
    let pin: string | undefined;
    const code = async (secret: string | undefined, t = NOW) =>
      (await (await signer(secret, t, pin)).signWalletAttestation(claims)) as { code?: string };
    pin = 'ab'.repeat(32);
    expect(await code(undefined)).toMatchObject({ code: 'signer_not_configured' });
    expect(await code('not json')).toMatchObject({ code: 'signer_secret_invalid' });
    expect(await code(JSON.stringify({ privateKeyPkcs8: 1, chain: [] }))).toMatchObject({
      code: 'signer_secret_invalid',
    });
    const side = await makeProviderSide('W');
    pin = side.anchor.sha256;
    const parsed = JSON.parse(side.secret) as { privateKeyPkcs8: string; chain: string[] };
    const other = await genPair('P-256');
    await exportSpki(other.publicKey);
    const pkcs8 = btoa(
      String.fromCharCode(
        ...new Uint8Array((await crypto.subtle.exportKey('pkcs8', other.privateKey)) as ArrayBuffer)
      )
    );
    expect(await code(JSON.stringify({ ...parsed, privateKeyPkcs8: pkcs8 }))).toMatchObject({
      code: 'signer_key_mismatch',
    });
    expect(await code(JSON.stringify({ ...parsed, chain: [parsed.chain[0]] }))).toMatchObject({
      code: 'signer_secret_invalid',
    });
    const eku = await makeProviderSide('EKU', { eku: true });
    pin = eku.anchor.sha256;
    expect(await code(eku.secret)).toMatchObject({ code: 'signer_chain_invalid' });
    pin = side.anchor.sha256;
    expect(await code(side.secret, NOW + 31 * 86400)).toMatchObject({
      code: 'signer_chain_invalid',
    });
    expect(await code(side.secret, NOW - 5 * 86400)).toMatchObject({
      code: 'signer_chain_invalid',
    });
  });

  it('never signs claims that are not the exact shape', async () => {
    const side = await makeProviderSide('W');
    const s = await signer(side.secret, NOW, side.anchor.sha256);
    const result = await s.signWalletAttestation({
      ...wallet,
      exp: NOW + 90000,
      cnf: { jwk: { ...wallet.cnf.jwk } },
    });
    expect(result).toEqual({ refused: true, code: 'claims_invalid' });
  });

  it('refuses a chain that does not end at the pinned intermediate or whose leaf it did not sign', async () => {
    const claims = { ...wallet, cnf: { jwk: { ...wallet.cnf.jwk } } };
    const a = await makeProviderSide('A');
    const b = await makeProviderSide('B');
    const sign = async (secret: string, pin: string | undefined) =>
      (await (await signer(secret, NOW, pin)).signWalletAttestation(claims)) as { code?: string };
    // the right chain under the wrong pin (another environment's intermediate)
    expect(await sign(a.secret, b.anchor.sha256)).toMatchObject({ code: 'signer_chain_untrusted' });
    // leaf of A glued to the intermediate of B, with B pinned: the signature does not verify
    const pa = JSON.parse(a.secret) as { privateKeyPkcs8: string; chain: string[] };
    const pb = JSON.parse(b.secret) as { chain: string[] };
    const glued = JSON.stringify({ ...pa, chain: [pa.chain[0], pb.chain[1]] });
    expect(await sign(glued, b.anchor.sha256)).toMatchObject({ code: 'signer_chain_invalid' });
    // no pin configured: not usable at all
    expect(await sign(a.secret, undefined)).toMatchObject({ code: 'signer_not_configured' });
  });
});
