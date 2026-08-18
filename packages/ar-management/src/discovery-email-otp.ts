import type { D1Database } from '@cloudflare/workers-types';
import {
  createLookupBlindIndexes,
  decodeActiveLookupMembershipRows,
  loadVerifiedLookupBucketAssignmentProvider,
  LookupRouteResolver,
  normalizeLookupEmail,
  produceNotificationDelivery,
  type Env,
  type LookupBlindIndex,
  type LookupIdentifierRow,
  type ResolvedLookupMembership,
} from '@authrim/ar-lib-core';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';

const OTP_TTL_SECONDS = 10 * 60;
const OTP_ATTEMPT_LIMIT = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const CHALLENGE_PATTERN = /^discovery-([0-9]{1,4})-([1-9][0-9]*)-([a-f0-9-]{36})$/u;

interface ChallengeRow {
  challenge_id: string;
  normalization_version: number;
  email_blind_digest: string;
  hmac_key_generation: number;
  previous_email_blind_digest: string | null;
  previous_hmac_key_generation: number | null;
  previous_virtual_bucket: number | null;
  otp_verifier: string;
  delivery_state: string;
  attempt_count: number;
  attempt_limit: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface DiscoveryEmailOtpStartResult {
  challengeId: string;
  expiresIn: number;
}

export interface DiscoveryEmailOtpDependencies {
  now?: () => number;
  randomId?: () => string;
  randomCode?: () => string;
  timingNow?: () => number;
  recordTiming?: (name: DiscoveryEmailOtpTimingName, durationMs: number) => void;
}

export type DiscoveryEmailOtpTimingName =
  | 'otp_registry'
  | 'otp_assignment'
  | 'otp_verifier'
  | 'otp_challenge'
  | 'otp_membership_batch'
  | 'lookup_membership';

function d1Binding(env: Env, bindingRef: string): D1Database {
  const value = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!value || typeof value !== 'object') throw new Error('discovery_lookup_unavailable');
  const binding = value as Partial<D1Database>;
  if (
    typeof binding.prepare !== 'function' ||
    typeof binding.batch !== 'function' ||
    typeof binding.withSession !== 'function'
  ) {
    throw new Error('discovery_lookup_unavailable');
  }
  return value as D1Database;
}

async function hmac(value: string, secret: string, domain: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${domain}\0${value}`)
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

function otpSecret(env: Env): string {
  const secret = env.OTP_HMAC_SECRET;
  if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error('discovery_otp_unavailable');
  }
  return secret;
}

function randomOtpCode(): string {
  const bytes = new Uint8Array(6);
  const digits: number[] = [];
  while (digits.length < 6) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= 250) continue;
      digits.push(Math.floor(byte / 25));
      if (digits.length === 6) break;
    }
  }
  return digits.join('');
}

async function assignments(env: Env) {
  if (!env.TENANT_RUNTIME_REGISTRY || !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS) {
    throw new Error('discovery_lookup_unavailable');
  }
  return loadVerifiedLookupBucketAssignmentProvider({
    store: env.TENANT_RUNTIME_REGISTRY,
    environmentId: env.AUTHRIM_ENVIRONMENT_NAME ?? '',
    publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
  });
}

function challengeRoute(challengeId: string): {
  virtualBucket: number;
  assignmentGeneration: number;
} {
  const match = CHALLENGE_PATTERN.exec(challengeId);
  if (!match) throw new Error('discovery_challenge_invalid');
  const bucket = Number(match[1]);
  const generation = Number(match[2]);
  if (
    !Number.isSafeInteger(bucket) ||
    bucket < 0 ||
    bucket > 4095 ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    throw new Error('discovery_challenge_invalid');
  }
  return { virtualBucket: bucket, assignmentGeneration: generation };
}

function strictPinnedBinding(env: Env, value: unknown): D1Database {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('discovery_challenge_invalid');
  }
  const target = value as Record<string, unknown>;
  if (
    typeof target.lookupShardId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(target.lookupShardId) ||
    typeof target.bindingRef !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(target.bindingRef) ||
    !Number.isSafeInteger(target.assignmentGeneration) ||
    (target.assignmentGeneration as number) < 1
  ) {
    throw new Error('discovery_challenge_invalid');
  }
  return d1Binding(env, target.bindingRef);
}

function consumedChallenge(
  value: ChallengeRow | null | undefined,
  suppliedVerifier: string,
  now: number
): ChallengeRow {
  if (
    !value ||
    value.delivery_state !== 'sent' ||
    value.expires_at < now ||
    value.consumed_at !== now ||
    value.otp_verifier !== suppliedVerifier
  ) {
    throw new Error('discovery_challenge_invalid');
  }
  return value;
}

function challengeIndexes(
  challenge: { virtualBucket: number },
  consumed: ChallengeRow
): LookupBlindIndex[] {
  const indexes: LookupBlindIndex[] = [
    {
      indexKind: 'email_exact',
      normalizationVersion: consumed.normalization_version,
      hmacKeyGeneration: consumed.hmac_key_generation,
      digest: consumed.email_blind_digest,
      virtualBucket: challenge.virtualBucket,
    },
  ];
  const previousValues = [
    consumed.previous_email_blind_digest,
    consumed.previous_hmac_key_generation,
    consumed.previous_virtual_bucket,
  ];
  if (previousValues.some((value) => value !== null)) {
    if (previousValues.some((value) => value === null)) {
      throw new Error('discovery_challenge_invalid');
    }
    indexes.push({
      indexKind: 'email_exact',
      normalizationVersion: consumed.normalization_version,
      hmacKeyGeneration: consumed.previous_hmac_key_generation!,
      digest: consumed.previous_email_blind_digest!,
      virtualBucket: consumed.previous_virtual_bucket!,
    });
  }
  return indexes;
}

export class DiscoveryEmailOtpService {
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly randomCode: () => string;
  private readonly timingNow: () => number;
  private readonly recordTiming?: DiscoveryEmailOtpDependencies['recordTiming'];

  constructor(
    private readonly env: Env,
    dependencies: DiscoveryEmailOtpDependencies = {}
  ) {
    this.now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
    this.randomId = dependencies.randomId ?? (() => crypto.randomUUID());
    this.randomCode = dependencies.randomCode ?? randomOtpCode;
    this.timingNow = dependencies.timingNow ?? (() => performance.now());
    this.recordTiming = dependencies.recordTiming;
  }

  private async measure<T>(
    name: DiscoveryEmailOtpTimingName,
    operation: () => Promise<T>
  ): Promise<T> {
    if (!this.recordTiming) return operation();
    const startedAt = this.timingNow();
    try {
      return await operation();
    } finally {
      this.recordTiming(name, Math.max(0, this.timingNow() - startedAt));
    }
  }

  async start(input: { email: string; clientIp: string }): Promise<DiscoveryEmailOtpStartResult> {
    const normalizedEmail = normalizeLookupEmail(input.email);
    const lookupKeys = (await loadLookupHmacRuntimeKeys(this.env)).readKeys;
    const verifierSecret = otpSecret(this.env);
    const indexes = await createLookupBlindIndexes('email_exact', normalizedEmail, lookupKeys);
    const index = indexes[0];
    const previousIndex = indexes[1] ?? null;
    const assignment = await (
      await assignments(this.env)
    ).resolveActiveAssignment(index.virtualBucket);
    const lookup = await (await createLookupBucketWriteResolver(this.env))(index.virtualBucket);
    const ipDigest = await hmac(
      input.clientIp || 'unknown',
      verifierSecret,
      'discovery-rate-ip-v1'
    );
    const limiter = this.env.RATE_LIMITER.get(
      this.env.RATE_LIMITER.idFromName('lookup-discovery-email-otp')
    );
    const emailRateDigest = await hmac(normalizedEmail, verifierSecret, 'discovery-rate-email-v1');
    const [emailLimit, ipLimit] = await Promise.all([
      limiter.incrementRpc(`email:${emailRateDigest}`, {
        windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
        maxRequests: 5,
      }),
      limiter.incrementRpc(`ip:${ipDigest}`, {
        windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
        maxRequests: 20,
      }),
    ]);
    if (!emailLimit.allowed || !ipLimit.allowed) throw new Error('discovery_rate_limited');

    const now = this.now();
    const challengeId = `discovery-${index.virtualBucket}-${assignment.assignmentGeneration}-${this.randomId()}`;
    const code = this.randomCode();
    if (!/^\d{6}$/u.test(code)) throw new Error('discovery_otp_generator_invalid');
    const verifier = await hmac(`${challengeId}\0${code}`, verifierSecret, 'discovery-otp-v1');
    const primary = lookup.withSession('first-primary');
    await primary
      .prepare(
        `INSERT INTO lookup_discovery_otp_challenges (
           challenge_id, virtual_bucket, normalization_version, email_blind_digest,
           hmac_key_generation,
           previous_email_blind_digest, previous_hmac_key_generation, previous_virtual_bucket,
           otp_verifier, delivery_state, attempt_count, attempt_limit, expires_at,
           consumed_at, rate_limit_ip_digest, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, ?, ?, ?)`
      )
      .bind(
        challengeId,
        index.virtualBucket,
        index.normalizationVersion,
        index.digest,
        index.hmacKeyGeneration,
        previousIndex?.digest ?? null,
        previousIndex?.hmacKeyGeneration ?? null,
        previousIndex?.virtualBucket ?? null,
        verifier,
        OTP_ATTEMPT_LIMIT,
        now + OTP_TTL_SECONDS,
        ipDigest,
        now,
        now
      )
      .run();
    try {
      const delivery = await produceNotificationDelivery(this.env, {
        owner: { owner: 'platform' },
        intentId: `discovery-email-otp:${challengeId}`,
        outboxId: `notification:${challengeId}`,
        notificationKind: 'discovery.email-otp',
        idempotencyKey: `discovery-email-otp:${challengeId}`,
        expiresAt: now + OTP_TTL_SECONDS,
        payload: {
          channel: 'email',
          to: normalizedEmail,
          from: this.env.EMAIL_FROM || 'noreply@authrim.dev',
          subject: 'Your tenant discovery code',
          body: `Your tenant discovery code is ${code}. It expires in 10 minutes.`,
        },
      });
      if (delivery.delivery === 'permanent_failure') {
        throw new Error('discovery_email_provider_unavailable');
      }
      await primary
        .prepare(
          `UPDATE lookup_discovery_otp_challenges
              SET delivery_state = 'sent', updated_at = ?
            WHERE challenge_id = ? AND delivery_state = 'pending'`
        )
        .bind(now, challengeId)
        .run();
    } catch {
      await primary
        .prepare(
          `UPDATE lookup_discovery_otp_challenges
              SET delivery_state = 'failed', updated_at = ?
            WHERE challenge_id = ? AND delivery_state = 'pending'`
        )
        .bind(now, challengeId)
        .run();
      throw new Error('discovery_email_provider_unavailable');
    }
    return { challengeId, expiresIn: OTP_TTL_SECONDS };
  }

  async verify(input: { challengeId: string; code: string }): Promise<ResolvedLookupMembership[]> {
    const challenge = challengeRoute(input.challengeId);
    const verifierSecret = otpSecret(this.env);
    const assignmentProvider = await this.measure('otp_registry', () => assignments(this.env));
    const activeAssignment = await this.measure('otp_assignment', () =>
      assignmentProvider.resolveActiveAssignment(challenge.virtualBucket)
    );
    const activeGeneration =
      activeAssignment.assignmentGeneration === challenge.assignmentGeneration;
    const lookup = activeGeneration
      ? d1Binding(this.env, activeAssignment.bindingRef)
      : this.env.CONTROL && typeof this.env.CONTROL.resolveLookupBucketRouteVersion === 'function'
        ? strictPinnedBinding(
            this.env,
            await this.env.CONTROL.resolveLookupBucketRouteVersion({
              virtualBucket: challenge.virtualBucket,
              assignmentGeneration: challenge.assignmentGeneration,
            })
          )
        : (() => {
            throw new Error('discovery_challenge_invalid');
          })();
    const primary = lookup.withSession('first-primary');
    const suppliedVerifier = await this.measure('otp_verifier', () =>
      hmac(
        `${input.challengeId}\0${/^\d{6}$/u.test(input.code) ? input.code : '000000'}`,
        verifierSecret,
        'discovery-otp-v1'
      )
    );
    const now = this.now();
    const consumeStatement = primary
      .prepare(
        `UPDATE lookup_discovery_otp_challenges
          SET attempt_count = attempt_count + 1,
              consumed_at = CASE WHEN otp_verifier = ? THEN ? ELSE consumed_at END,
              updated_at = ?
        WHERE challenge_id = ? AND delivery_state = 'sent' AND consumed_at IS NULL
          AND expires_at >= ? AND attempt_count < attempt_limit
      RETURNING challenge_id, normalization_version, email_blind_digest,
                hmac_key_generation, previous_email_blind_digest,
                previous_hmac_key_generation, previous_virtual_bucket,
                otp_verifier, delivery_state, attempt_count, attempt_limit,
                expires_at, consumed_at`
      )
      .bind(suppliedVerifier, now, now, input.challengeId, now);

    let consumed: ChallengeRow;
    let prefetchedMembershipRows: LookupIdentifierRow[] | null = null;
    if (activeGeneration) {
      // The SELECT is speculative: only UPDATE RETURNING proves this request consumed the OTP.
      const batch = await this.measure('otp_membership_batch', () =>
        primary.batch<ChallengeRow | LookupIdentifierRow>([
          consumeStatement,
          primary
            .prepare(
              `SELECT identifier.virtual_bucket, identifier.index_kind,
                      identifier.normalization_version, identifier.hmac_key_generation,
                      identifier.identifier_blind_digest, identifier.tenant_id,
                      identifier.account_id, identifier.route_schema_version,
                      identifier.account_route_generation,
                      identifier.required_binding_route_generation,
                      identifier.residency_policy_id, identifier.route_projection_json,
                      identifier.tenant_lifecycle_state, identifier.runtime_route_status,
                      identifier.lifecycle_state
                 FROM lookup_discovery_otp_challenges challenge
                 JOIN lookup_identifiers identifier
                   ON identifier.virtual_bucket = ?
                  AND identifier.index_kind = 'email_exact'
                  AND identifier.normalization_version = challenge.normalization_version
                  AND identifier.hmac_key_generation = challenge.hmac_key_generation
                  AND identifier.identifier_blind_digest = challenge.email_blind_digest
                WHERE challenge.challenge_id = ?
                  AND challenge.delivery_state = 'sent'
                  AND challenge.consumed_at = ?
                  AND challenge.otp_verifier = ?
                  AND identifier.lifecycle_state = 'active'
                ORDER BY identifier.tenant_id, identifier.account_id
                LIMIT 101`
            )
            .bind(challenge.virtualBucket, input.challengeId, now, suppliedVerifier),
        ])
      );
      if (
        batch.length !== 2 ||
        !Array.isArray(batch[0]?.results) ||
        !Array.isArray(batch[1]?.results)
      ) {
        throw new Error('discovery_lookup_unavailable');
      }
      const consumedRows = batch[0].results as ChallengeRow[];
      if (consumedRows.length > 1) throw new Error('discovery_lookup_unavailable');
      consumed = consumedChallenge(consumedRows[0], suppliedVerifier, now);
      prefetchedMembershipRows = batch[1].results as LookupIdentifierRow[];
    } else {
      consumed = consumedChallenge(
        await this.measure('otp_challenge', () => consumeStatement.first<ChallengeRow>()),
        suppliedVerifier,
        now
      );
    }
    const indexes = challengeIndexes(challenge, consumed);
    if (prefetchedMembershipRows && indexes.length === 1) {
      return decodeActiveLookupMembershipRows(prefetchedMembershipRows, indexes[0]);
    }
    const resolver = new LookupRouteResolver(
      this.env as unknown as { [bindingRef: string]: unknown },
      assignmentProvider
    );
    return this.measure('lookup_membership', () => resolver.resolveMemberships({ indexes }));
  }
}
