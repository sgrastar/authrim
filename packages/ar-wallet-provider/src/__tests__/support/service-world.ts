/** Test helper: a complete provider (Apple-shaped devices, a real chain, ports) with a mutable clock. */
import { createWalletProviderApp } from '../../service/app';
import { DEFAULT_LIMITS, profileFor, type WalletProviderConfig } from '../../service/config';
import type { ProviderLogEvent } from '../../service/logger';
import { createSecretSigner } from '../../cloudflare/secret-signer';
import { createD1DeviceRegistry } from '../../cloudflare/d1-device-registry';
import { createD1RateLimiter } from '../../cloudflare/d1-rate-limiter';
import { sha256, toHex } from '../../domain/bytes';
import type { WalletAttestationAnchor } from '@op-verifiers/wallet-attestation';
import type { WalletProviderPorts } from '@authrim/ar-lib-core';
import { createD1Shim } from './d1-shim';
import { ext, makeAppleWorld, makeCert, type AppleWorld } from './apple-fixture';
import { exportSpki, genPair } from './keys';
import { createMemoryRateLimiter, createMemoryRegistry } from './memory-ports';
import { oid, seq, type B } from './der';

export const NOW = 1_800_000_000;
const DAY = 86400;
export const APP_ID = 'TEAM123456.com.authrim.keyring';
export const b64 = (b: B): string => btoa(String.fromCharCode(...b));

export interface ProviderSide {
  secret: string;
  chain: B[];
  anchor: WalletAttestationAnchor;
}

async function p256() {
  const kp = await genPair('P-256');
  return { priv: kp.privateKey, spki: await exportSpki(kp.publicKey) };
}

export async function makeProviderSide(
  name: string,
  opts: { eku?: boolean; leafNotAfter?: number; leafNotBefore?: number; now?: number } = {}
): Promise<ProviderSide> {
  const base = opts.now ?? NOW;
  const root = await p256();
  const inter = await p256();
  const leaf = await p256();
  const interDer = await makeCert({
    subjectCn: name,
    issuerCn: 'Provider Root',
    subjectSpki: inter.spki,
    issuerKey: root.priv,
    issuerCurve: 'P-256',
    hash: 'SHA-256',
    notBefore: base - 10 * DAY,
    notAfter: base + 700 * DAY,
    ca: true,
  });
  const leafDer = await makeCert({
    subjectCn: `${name} leaf`,
    issuerCn: name,
    subjectSpki: leaf.spki,
    issuerKey: inter.priv,
    issuerCurve: 'P-256',
    hash: 'SHA-256',
    notBefore: opts.leafNotBefore ?? base - DAY,
    notAfter: opts.leafNotAfter ?? base + 30 * DAY,
    ca: false,
    extra: opts.eku ? [ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.2')))] : [],
  });
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', leaf.priv)) as ArrayBuffer);
  return {
    secret: JSON.stringify({ privateKeyPkcs8: b64(pkcs8), chain: [b64(leafDer), b64(interDer)] }),
    chain: [leafDer, interDer],
    anchor: { certificate: b64(interDer), sha256: toHex(await sha256(interDer)), label: name },
  };
}

export interface World {
  apple: AppleWorld;
  wallet: ProviderSide;
  key: ProviderSide;
  clock: { t: number };
  logs: ProviderLogEvent[];
  config: WalletProviderConfig;
  ports: WalletProviderPorts;
  app: ReturnType<typeof createWalletProviderApp>;
  post: (path: string, body: unknown, ip?: string) => Promise<Response>;
  get: (path: string) => Promise<Response>;
}

export interface WorldOptions {
  backend?: 'memory' | 'd1';
  environment?: 'staging' | 'production';
  policy?: Partial<WalletProviderConfig['policy']>;
  walletSecret?: string | null;
  keySecret?: string | null;
  limits?: Partial<WalletProviderConfig['limits']>;
}

const SECRET = new Uint8Array(32).fill(7);

export async function makeWorld(o: WorldOptions = {}): Promise<World> {
  const apple = await makeAppleWorld(NOW);
  const wallet = await makeProviderSide('Wallet Attestation CA');
  const key = await makeProviderSide('Key Attestation CA');
  const clock = { t: NOW };
  const now = () => clock.t;
  const environment = o.environment ?? 'production';
  const config: WalletProviderConfig = {
    environment,
    challengeLabel: environment,
    challengeSecrets: [SECRET],
    challengeTtlSeconds: 300,
    issuer: 'https://wallet-provider.authrim.com',
    clientId: 'keyring-ios',
    walletTtlSeconds: 3600,
    keyTtlSeconds: 600,
    keyStorage: ['iso_18045_high'],
    policy: {
      ...profileFor(environment),
      appIds: [APP_ID],
      appleRootDer: apple.rootDer,
      appleRootSha256: apple.rootSha256,
      ...o.policy,
    },
    limits: { ...DEFAULT_LIMITS, ...o.limits },
    maxBodyBytes: 32 * 1024,
  };
  const d1 = o.backend === 'd1' ? createD1Shim() : null;
  const ports: WalletProviderPorts = {
    registry: d1 ? createD1DeviceRegistry(d1) : createMemoryRegistry(),
    rateLimiter: d1 ? createD1RateLimiter(d1, now) : createMemoryRateLimiter(now),
    signer: createSecretSigner({
      walletSecret: o.walletSecret === null ? undefined : (o.walletSecret ?? wallet.secret),
      keySecret: o.keySecret === null ? undefined : (o.keySecret ?? key.secret),
      walletIntermediateSha256: wallet.anchor.sha256,
      keyIntermediateSha256: key.anchor.sha256,
      now,
    }),
  };
  const logs: ProviderLogEvent[] = [];
  const app = createWalletProviderApp({
    config,
    ports,
    now,
    sourceOf: (req) => req.headers.get('x-test-ip') ?? '203.0.113.1',
    logger: { log: (event) => logs.push(event) },
  });
  return {
    apple,
    wallet,
    key,
    clock,
    logs,
    config,
    ports,
    app,
    post: async (path, body, ip) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(ip ? { 'x-test-ip': ip } : {}) },
        body: JSON.stringify(body),
      }),
    get: async (path) => app.request(path),
  };
}
