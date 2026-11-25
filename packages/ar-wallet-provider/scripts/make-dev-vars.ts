/**
 * Writes `.dev.vars` for local `wrangler dev --env staging`: a throw-away provider chain and a
 * FAKE Apple root (so /healthz, /challenge and the config load work; real devices cannot register
 * against it). Never used for deployment; `.dev.vars` is git-ignored.
 */
import { writeFileSync } from 'node:fs';
import { makeAppleWorld } from '../src/__tests__/support/apple-fixture';
import { makeProviderSide } from '../src/__tests__/support/service-world';

const now = Math.floor(Date.now() / 1000);
const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

async function main(): Promise<void> {
  const apple = await makeAppleWorld(now);
  const wallet = await makeProviderSide('Dev Wallet Attestation CA', { now });
  const key = await makeProviderSide('Dev Key Attestation CA', { now });
  const lines = [
    `APPLE_ROOT_DER_B64=${b64(apple.rootDer)}`,
    `APPLE_ROOT_SHA256=${apple.rootSha256}`,
    `CHALLENGE_HMAC_KEY=${b64(crypto.getRandomValues(new Uint8Array(32)))}`,
    `WALLET_INTERMEDIATE_SHA256=${wallet.anchor.sha256}`,
    `KEY_INTERMEDIATE_SHA256=${key.anchor.sha256}`,
    `WALLET_ATTESTATION_SIGNER=${wallet.secret}`,
    `KEY_ATTESTATION_SIGNER=${key.secret}`,
  ];
  writeFileSync(new URL('../.dev.vars', import.meta.url), `${lines.join('\n')}\n`, { mode: 0o600 });
}
void main();
