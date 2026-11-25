/**
 * The wallet provider HTTP app (design sections 4, 8, 9). Runtime neutral: everything it needs
 * comes in through `WalletProviderDeps`, so the Cloudflare Worker and the AWS Lambda entry build
 * the same app around their own adapters.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { DeviceRecord, WalletProviderPorts } from '@authrim/ar-lib-core';
import { verifyAssertion } from '../domain/app-attest-assertion';
import { verifyAttestation } from '../domain/app-attest-attestation';
import {
  boundedExpiry,
  keyAttestationClaims,
  walletAttestationClaims,
} from '../domain/attestation-jwt';
import { fromBase64, fromBase64Url, sha256, toHex, utf8 } from '../domain/bytes';
import { checkChallenge, createChallenge } from '../domain/challenge';
import {
  buildClientData,
  isOnCurve,
  isPrintableToken,
  normalizeJwk,
  type Purpose,
} from '../domain/client-data';
import type { RateLimitRule, WalletProviderConfig } from './config';
import { silentLogger, type ProviderLogEvent, type ProviderLogger } from './logger';

export interface WalletProviderDeps {
  config: WalletProviderConfig;
  ports: WalletProviderPorts;
  /** Epoch seconds. */
  now: () => number;
  /** The client address as the platform reports it (used only as a hashed rate-limit key). */
  sourceOf: (request: Request) => string;
  logger?: ProviderLogger;
  requestId?: () => string;
}

type Endpoint = ProviderLogEvent['endpoint'];

interface Outcome {
  status: number;
  body: Record<string, unknown>;
  outcome: string;
  reason?: string;
  retryAfter?: number;
  keyIdHash?: string;
  counter?: number;
  environment?: string;
  validationCategory?: number;
  bundleVersion?: string;
}

const refuse = (status: number, error: string, reason?: string): Outcome => ({
  status,
  body: { error },
  outcome: error,
  reason,
});

const unavailable = (reason: string): Outcome => refuse(503, 'provider_unavailable', reason);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const LOCK_RULE = (config: WalletProviderConfig): RateLimitRule => ({
  windowSeconds: config.limits.failureLockoutSeconds,
  maxRequests: 0,
});

export function createWalletProviderApp(deps: WalletProviderDeps): Hono {
  const { config, ports } = deps;
  const logger = deps.logger ?? silentLogger;
  const newRequestId = deps.requestId ?? (() => crypto.randomUUID());
  const app = new Hono();

  /** One counter per limit: the three source limits must never share a row (their windows differ). */
  async function sourceKey(request: Request, kind: string): Promise<string> {
    const secret = config.challengeSecrets[0] ?? new Uint8Array();
    const digest = await sha256(new Uint8Array([...secret, ...utf8(deps.sourceOf(request))]));
    return `src:${kind}:${toHex(digest).slice(0, 32)}`;
  }

  async function limit(rule: RateLimitRule, key: string): Promise<Outcome | null> {
    const result = await ports.rateLimiter.check({ key, ...rule });
    if (result.allowed) return null;
    return {
      ...refuse(429, 'rate_limited'),
      retryAfter: Math.max(1, result.resetAt - deps.now()),
    };
  }

  /** Reads at most `maxBodyBytes`; a longer stream is cut off instead of being buffered. */
  async function readJson(c: Context): Promise<Record<string, unknown> | null> {
    const declared = Number(c.req.header('content-length') ?? '0');
    if (!Number.isFinite(declared) || declared > config.maxBodyBytes) return null;
    const stream = c.req.raw.body;
    if (!stream) return null;
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > config.maxBodyBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      const parsed: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      );
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function run(endpoint: Endpoint, work: (c: Context) => Promise<Outcome>) {
    return async (c: Context): Promise<Response> => {
      const started = Date.now();
      let result: Outcome;
      try {
        result = await work(c);
      } catch {
        // A store or signer failure: nothing is known, so nothing is claimed (fail closed).
        result = unavailable('internal_error');
      }
      const event: ProviderLogEvent = {
        requestId: newRequestId(),
        endpoint,
        status: result.status,
        outcome: result.outcome,
        reason: result.reason,
        keyIdHash: result.keyIdHash,
        counter: result.counter,
        environment: result.environment,
        validationCategory: result.validationCategory,
        bundleVersion: result.bundleVersion,
        latencyMs: Date.now() - started,
      };
      logger.log(event);
      const headers: Record<string, string> = { 'cache-control': 'no-store' };
      if (result.retryAfter !== undefined) headers['retry-after'] = String(result.retryAfter);
      return c.json(result.body, result.status as 200, headers);
    };
  }

  async function keyHash(keyId: string): Promise<string> {
    return toHex(await sha256(utf8(keyId))).slice(0, 12);
  }

  app.post(
    '/challenge',
    run('challenge', async (c) => {
      const limited = await limit(
        config.limits.challengePerSource,
        await sourceKey(c.req.raw, 'challenge')
      );
      if (limited) return limited;
      const challenge = await createChallenge({
        secret: config.challengeSecrets[0],
        environment: config.challengeLabel,
        now: deps.now(),
        ttlSeconds: config.challengeTtlSeconds,
      });
      return { status: 200, body: { challenge }, outcome: 'ok' };
    })
  );

  app.post(
    '/register',
    run('register', async (c) => {
      const limited =
        (await limit(config.limits.registerPerSource, await sourceKey(c.req.raw, 'register'))) ??
        (await limit(config.limits.registerGlobal, 'register:global'));
      if (limited) return limited;
      const body = await readJson(c);
      const keyId = body?.key_id;
      const challenge = body?.challenge;
      const object = body?.attestation_object;
      if (
        typeof keyId !== 'string' ||
        typeof object !== 'string' ||
        !isPrintableToken(challenge) ||
        fromBase64(keyId)?.length !== 32 ||
        object.length > 21848
      ) {
        return refuse(400, 'invalid_request');
      }
      const objectBytes = fromBase64(object);
      if (!objectBytes) return refuse(400, 'invalid_request');
      const hash = await keyHash(keyId);
      const attestationSha256 = toHex(await sha256(objectBytes));
      const challengeSha256 = toHex(await sha256(utf8(challenge)));

      // Idempotency first, so a lost response is recoverable after the challenge expired.
      const existing = await ports.registry.get(keyId);
      if (existing) {
        if (
          existing.attestationSha256 !== attestationSha256 ||
          existing.challengeSha256 !== challengeSha256
        ) {
          return { ...refuse(409, 'key_exists'), keyIdHash: hash };
        }
        if (existing.revokedAt !== undefined) return { ...refuse(403, 'revoked'), keyIdHash: hash };
        return { status: 200, body: {}, outcome: 'ok', reason: 'same', keyIdHash: hash };
      }

      const now = deps.now();
      const status = await checkChallenge({
        challenge,
        secrets: config.challengeSecrets,
        environment: config.challengeLabel,
        now,
      });
      if (status !== 'ok') return { ...refuse(400, 'invalid_challenge', status), keyIdHash: hash };

      const verified = await verifyAttestation(
        { keyId, challenge, attestationObject: object, now },
        config.policy
      );
      if (!verified.ok) {
        return { ...refuse(400, 'invalid_attestation', verified.reason), keyIdHash: hash };
      }
      const a = verified.attestation;
      const record: DeviceRecord = {
        keyId,
        publicKeyJwk: a.publicKeyJwk,
        counter: 0,
        environment: a.environment,
        validationCategory: a.build.validationCategory,
        bundleVersion: a.build.bundleVersion,
        appIdHash: a.appIdHash,
        attestationSha256: a.attestationSha256,
        challengeSha256: a.challengeSha256,
        receipt: a.receipt,
        createdAt: now,
      };
      const result = await ports.registry.register(record);
      const meta = {
        keyIdHash: hash,
        environment: a.environment,
        validationCategory: a.build.validationCategory,
        bundleVersion: a.build.bundleVersion,
      };
      if (result === 'conflict') return { ...refuse(409, 'key_exists'), ...meta };
      if (result === 'challenge_used')
        return { ...refuse(400, 'invalid_challenge', 'claimed'), ...meta };
      return { status: 200, body: {}, outcome: 'ok', reason: result, ...meta };
    })
  );

  function attestation(purpose: Purpose) {
    return run(purpose, async (c) => {
      // The source limit comes before the body is read; the per-key limit only after the key is
      // known, so unregistered key ids cannot make counter rows.
      const sourceLimited = await limit(
        config.limits.attestPerSource,
        await sourceKey(c.req.raw, 'attest')
      );
      if (sourceLimited) return sourceLimited;
      const body = await readJson(c);
      const keyId = body?.key_id;
      if (typeof keyId !== 'string' || fromBase64(keyId)?.length !== 32) {
        return refuse(400, 'invalid_request');
      }
      const hash = await keyHash(keyId);
      const tag = { keyIdHash: hash };
      const challenge = body?.challenge;
      const assertion = body?.assertion;
      const nonce = body?.nonce;
      const jwk = normalizeJwk(body?.jwk);
      if (
        body?.purpose !== purpose ||
        !isPrintableToken(challenge) ||
        typeof assertion !== 'string' ||
        !jwk ||
        (purpose === 'key-attestation' ? !isPrintableToken(nonce) : nonce !== undefined) ||
        !(await isOnCurve(jwk))
      ) {
        return { ...refuse(400, 'invalid_request'), ...tag };
      }

      const record = await ports.registry.get(keyId);
      if (!record) return { ...refuse(401, 'unknown_key'), ...tag };
      if (record.revokedAt !== undefined) return { ...refuse(403, 'revoked'), ...tag };

      const keyLimited = await limit(config.limits.attestPerKey, `key:${hash}`);
      if (keyLimited) return { ...keyLimited, ...tag };
      const lock = await ports.rateLimiter.peek({ key: `lock:${hash}`, ...LOCK_RULE(config) });
      if (!lock.allowed) {
        return {
          ...refuse(429, 'rate_limited', 'failure_lockout'),
          retryAfter: Math.max(1, lock.resetAt - deps.now()),
          ...tag,
        };
      }

      const now = deps.now();
      const status = await checkChallenge({
        challenge,
        secrets: config.challengeSecrets,
        environment: config.challengeLabel,
        now,
      });
      if (status !== 'ok') return { ...refuse(400, 'invalid_challenge', status), ...tag };

      const x = fromBase64Url(record.publicKeyJwk.x);
      const y = fromBase64Url(record.publicKeyJwk.y);
      if (!x || !y) return unavailable('stored_key_invalid');
      const clientData = await buildClientData({
        purpose,
        challenge,
        jwk,
        nonce: typeof nonce === 'string' ? nonce : undefined,
      });
      const verified = await verifyAssertion(
        {
          assertion,
          clientData,
          publicPoint: new Uint8Array([4, ...x, ...y]),
          storedCounter: record.counter,
          appIdHash: record.appIdHash,
        },
        config.policy
      );
      if (!verified.ok) {
        if (verified.reason === 'counter_not_greater') {
          return { ...refuse(401, 'counter_replayed', verified.reason), ...tag };
        }
        if (verified.reason === 'build_not_allowed') {
          return { ...refuse(400, 'invalid_attestation', verified.reason), ...tag };
        }
        // The Nth failure inside the window starts a fixed lockout (a window of one request
        // with a maximum of zero: allowed only while no lock window is live).
        const failed = await ports.rateLimiter.check({
          key: `fail:${hash}`,
          ...config.limits.failuresPerKey,
        });
        if (failed.remaining === 0) {
          await ports.rateLimiter.check({ key: `lock:${hash}`, ...LOCK_RULE(config) });
        }
        return { ...refuse(401, 'invalid_assertion', verified.reason), ...tag };
      }

      // Build and sign in memory first: a signer failure changes no state.
      const limits = (await ports.signer.health()).chainNotAfter;
      const isWallet = purpose === 'wallet-attestation';
      const exp = boundedExpiry({
        now,
        ttlSeconds: isWallet ? config.walletTtlSeconds : config.keyTtlSeconds,
        chainLimit: isWallet ? limits.wallet : limits.key,
      });
      if (exp === null) return { ...unavailable('chain_expiring'), ...tag };
      const signed = isWallet
        ? await ports.signer.signWalletAttestation(
            walletAttestationClaims({
              issuer: config.issuer,
              clientId: config.clientId,
              now,
              exp,
              jwk,
            })
          )
        : await ports.signer.signKeyAttestation(
            keyAttestationClaims({
              now,
              exp,
              nonce: nonce as string,
              jwk,
              keyStorage: config.keyStorage,
            })
          );
      if ('refused' in signed) return { ...unavailable(signed.code), ...tag };

      // The only state change: the JWT is returned only if the counter advanced.
      const advanced = await ports.registry.advanceCounter(
        keyId,
        verified.counter,
        verified.build,
        now
      );
      const meta = {
        ...tag,
        counter: verified.counter,
        environment: record.environment,
        validationCategory: verified.build.validationCategory,
        bundleVersion: verified.build.bundleVersion,
      };
      if (advanced === 'advanced') {
        return { status: 200, body: { attestation: signed.jwt }, outcome: 'ok', ...meta };
      }
      if (advanced === 'not_greater')
        return { ...refuse(401, 'counter_replayed', advanced), ...meta };
      if (advanced === 'revoked') return { ...refuse(403, 'revoked'), ...meta };
      return { ...refuse(401, 'unknown_key'), ...meta };
    });
  }

  app.post('/wallet-attestation', attestation('wallet-attestation'));
  app.post('/key-attestation', attestation('key-attestation'));

  app.get(
    '/healthz',
    run('healthz', async () => {
      const { chainNotAfter } = await ports.signer.health();
      const now = deps.now();
      const days = (until: number): number => Math.max(0, Math.floor((until - now) / 86400));
      const healthy = chainNotAfter.wallet - now > 3600 && chainNotAfter.key - now > 3600;
      return {
        status: healthy ? 200 : 503,
        body: {
          status: healthy ? 'ok' : 'unhealthy',
          environment: config.environment,
          leafDaysRemaining: { wallet: days(chainNotAfter.wallet), key: days(chainNotAfter.key) },
        },
        outcome: healthy ? 'ok' : 'provider_unavailable',
      };
    })
  );

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}
