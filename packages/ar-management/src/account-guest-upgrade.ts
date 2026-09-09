import { Context } from 'hono';
import {
  CanonicalRuntimeUserStore,
  GuestLifecycleRepository,
  GuestUpgradeRepository,
  commitGuestUpgrade,
  createAccountAuthContextFromHono,
  createPIIContextFromHono,
  getAccountDataContextFromHono,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  getMissingRequiredCustomClaims,
  loadClientContractCached,
  normalizeLookupEmail,
  passkeyCredentialLookupSubject,
  PasskeyRepository,
  produceNotificationDelivery,
  isNotificationDeliveryAvailable,
  resolveCustomClaimRuntimeSourcesFromEnv,
  resolveAccountDataContext,
  resolveGuestSettings,
  resolveAccountRegistrationState,
  syncUserLifecycleState,
  validateAccountDirectoryPublication,
  type AuthenticatorTransport,
  type Env,
  type GuestUpgradeOperation,
  type Session,
} from '@authrim/ar-lib-core';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { recordAccountOperation } from './account-operation-log';
import { requireAccountSession } from './account-page';
import { getAccountWebAuthnOrigin } from './account-passkeys';
import { addVerifiedAccountEmail } from './account-identifier-replacement';
import {
  buildAccountEmailAddition,
  buildAccountExternalSubjectAddition,
  publishAccountExternalSubjectAddition,
} from './account-identifier-addition';
import { InitialAccountIdentifierReservationService } from './account-directory-reservation';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';

type C = Context<{ Bindings: Env }>;
type Method = 'email' | 'passkey';
interface ProofPayload {
  email?: string;
  origin?: string;
  rpId?: string;
  credentialId?: string;
  publicKey?: string;
  counter?: number;
  transports?: AuthenticatorTransport[];
  aaguid?: string;
}

async function sha256(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
}
async function otpVerifier(
  env: Env,
  tenantId: string,
  operationId: string,
  code: string
): Promise<string> {
  if (!env.OTP_HMAC_SECRET || new TextEncoder().encode(env.OTP_HMAC_SECRET).length < 32)
    throw new Error('guest_upgrade_otp_unavailable');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.OTP_HMAC_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(JSON.stringify(['guest-upgrade', tenantId, operationId, code]))
      )
    ),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
}
function randomCode(): string {
  let code = '';
  while (code.length < 6) {
    const value = crypto.getRandomValues(new Uint8Array(1))[0];
    if (value < 250) code += String(value % 10);
  }
  return code;
}
function fail(c: C, error: string, status: 400 | 401 | 403 | 409 | 503 = 400): Response {
  return c.json({ error }, status);
}
async function context(c: C) {
  c.header('Cache-Control', 'no-store');
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) return accountSession;
  const tenantId = getTenantIdFromContext(c);
  const { stub: sessions } = getSessionStoreBySessionId(c.env, accountSession.sessionId, tenantId);
  const session = (await sessions.getSessionRpc(accountSession.sessionId)) as Session | null;
  if (
    !session ||
    session.userId !== accountSession.userId ||
    session.tenantId !== tenantId ||
    session.expiresAt <= Date.now()
  )
    return fail(c, 'invalid_session', 401);
  const clientId = session.data?.client_id;
  if (typeof clientId !== 'string' || !clientId) return fail(c, 'guest_client_required', 403);
  const auth = createAccountAuthContextFromHono(c, tenantId);
  const pii = createPIIContextFromHono(c, tenantId);
  const lifecycle = new GuestLifecycleRepository(auth.coreAdapter, tenantId);
  const operations = new GuestUpgradeRepository(pii.defaultPiiAdapter, tenantId);
  const row = await lifecycle.get(session.userId);
  if (!row || row.client_id !== clientId || ['deleting', 'deleted'].includes(row.phase))
    return fail(c, 'guest_unavailable', 409);
  return { tenantId, clientId, session, sessions, auth, pii, lifecycle, operations, row };
}
async function allowedMethods(c: C, tenantId: string, clientId: string): Promise<Method[]> {
  const settings = await resolveGuestSettings(c.env, tenantId);
  const contract = await loadClientContractCached(
    c,
    c.env.AUTHRIM_CONFIG,
    c.env,
    tenantId,
    clientId
  );
  if (!settings.policy.upgradeEnabled) return [];
  const candidates = settings.upgradeMethods.filter((method) =>
    contract?.guestAuth?.allowedUpgradeMethods?.includes(method)
  );
  const emailReady =
    candidates.includes('email') &&
    new TextEncoder().encode(c.env.OTP_HMAC_SECRET ?? '').length >= 32 &&
    (await isNotificationDeliveryAvailable(c.env, { owner: 'tenant', tenantId }));
  const origin = getAccountWebAuthnOrigin(c, true);
  const passkeyReady =
    origin !== null &&
    (new URL(origin).protocol === 'https:' ||
      ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
  return candidates.filter((method) => (method === 'email' ? emailReady : passkeyReady));
}

export async function getAccountGuestUpgradeHandler(c: C): Promise<Response> {
  try {
    const ctx = await context(c);
    if (ctx instanceof Response) return ctx;
    // Recover the initiating browser session after a crash between durable commit and RPC update.
    // Another session for the same guest must not inherit this proof's authentication methods.
    if (
      ctx.row.phase === 'registered' &&
      ctx.row.upgrade_operation_id &&
      ctx.session.data?.is_guest_session === true
    ) {
      const operation = await ctx.operations.get(ctx.row.upgrade_operation_id);
      if (
        operation?.state === 'completed' &&
        operation.initiating_session_id === ctx.session.id &&
        operation.user_id === ctx.session.userId &&
        operation.client_id === ctx.clientId
      ) {
        await ctx.sessions.updateSessionDataRpc(
          ctx.session.id,
          {
            is_guest_session: false,
            guest_resume_credential: false,
            device_id_hash: undefined,
            upgrade_eligible: false,
            upgrade_method: operation.method,
            upgraded_at: (ctx.row.upgraded_at ?? operation.updated_at) * 1000,
            amr: [operation.method === 'email' ? 'otp' : 'webauthn'],
            authTime: ctx.row.upgraded_at ?? operation.updated_at,
          },
          { onlyIfGuestSession: true }
        );
      }
    }
    const methods =
      ctx.row.phase === 'active' ? await allowedMethods(c, ctx.tenantId, ctx.clientId) : [];
    const sources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, ctx.tenantId, {
      accountId: ctx.session.userId,
    });
    if (!sources.nonPiiDb) throw new Error('account_data_route_incomplete');
    const missing = await getMissingRequiredCustomClaims({
      db: sources.nonPiiDb,
      dbPii: sources.piiDb,
      schemaDb: sources.schemaDb,
      tenantId: ctx.tenantId,
      userId: ctx.session.userId,
    });
    const user = await new CanonicalRuntimeUserStore({
      coreAdapter: ctx.auth.coreAdapter,
      piiAdapter: ctx.pii.defaultPiiAdapter,
      tenantId: ctx.tenantId,
    }).findById(ctx.session.userId);
    if (!user || user.tenant_id !== ctx.tenantId) return fail(c, 'guest_unavailable', 409);
    return c.json({
      status: user.status,
      registration_state: resolveAccountRegistrationState(user.registration_state, ctx.row.phase),
      deletion_due_at: ctx.row.deletion_due_at,
      upgrade_hold_until: ctx.row.upgrade_hold_until,
      upgrade_eligible: methods.length > 0,
      allowed_methods: methods,
      upgrade_in_progress: ctx.row.phase === 'upgrading',
      profile_complete: missing.length === 0,
    });
  } catch {
    return fail(c, 'guest_upgrade_unavailable', 503);
  }
}

export async function startAccountGuestUpgradeHandler(c: C): Promise<Response> {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (
      !body ||
      (body.method !== 'email' && body.method !== 'passkey') ||
      (body.preserve_sub !== undefined && body.preserve_sub !== true)
    )
      return fail(c, 'invalid_request');
    const method = body.method;
    const ctx = await context(c);
    if (ctx instanceof Response) return ctx;
    if (ctx.row.phase !== 'active') return fail(c, 'guest_upgrade_in_progress', 409);
    if (!(await allowedMethods(c, ctx.tenantId, ctx.clientId)).includes(method))
      return fail(c, 'guest_upgrade_disabled', 403);
    const now = Math.floor(Date.now() / 1000);
    const settings = await resolveGuestSettings(c.env, ctx.tenantId);
    const operationId = crypto.randomUUID();
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
    const payload: ProofPayload = {};
    let verifier: string;
    let code: string | undefined;
    let options: Awaited<ReturnType<typeof generateRegistrationOptions>> | undefined;
    if (method === 'email') {
      if (typeof body.email !== 'string' || body.email.length > 320)
        return fail(c, 'invalid_email');
      try {
        payload.email = normalizeLookupEmail(body.email);
      } catch {
        return fail(c, 'invalid_email');
      }
      code = randomCode();
      verifier = await otpVerifier(c.env, ctx.tenantId, operationId, code);
    } else {
      const origin = getAccountWebAuthnOrigin(c);
      if (!origin) return fail(c, 'invalid_origin');
      payload.origin = origin;
      payload.rpId = new URL(origin).hostname;
      options = await generateRegistrationOptions({
        rpName: 'Authrim',
        rpID: payload.rpId,
        userName: ctx.session.userId,
        userDisplayName: ctx.session.userId,
        userID: Uint8Array.from(new TextEncoder().encode(ctx.session.userId)),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        timeout: 60000,
      });
      verifier = options.challenge;
    }
    // Invalid input never spends the one-time hold. A later retry cannot renew it.
    if (
      !(await ctx.lifecycle.acquireHold(
        ctx.session.userId,
        now,
        settings.policy.upgradeHoldMinutes
      ))
    )
      return fail(c, 'guest_unavailable', 409);
    await ctx.operations.create({
      operationId,
      userId: ctx.session.userId,
      clientId: ctx.clientId,
      sessionId: ctx.session.id,
      requestTokenHash: await sha256(token),
      method,
      payloadJson: JSON.stringify(payload),
      verifier,
      now,
      expiresAt: now + 600,
    });
    await recordAccountOperation(c, {
      userId: ctx.session.userId,
      action: 'account.guest.upgrade_started',
      metadata: { operationId, method },
    });
    if (method === 'email') {
      const delivery = await produceNotificationDelivery(c.env, {
        owner: { owner: 'tenant', tenantId: ctx.tenantId },
        intentId: `guest-upgrade:${operationId}`,
        outboxId: `notification:guest-upgrade:${operationId}`,
        notificationKind: 'account.guest-upgrade-otp',
        accountId: ctx.session.userId,
        idempotencyKey: `guest-upgrade:${operationId}`,
        expiresAt: now + 600,
        payload: {
          channel: 'email',
          to: payload.email!,
          from: c.env.EMAIL_FROM || 'noreply@authrim.dev',
          subject: 'Register your guest account',
          body: `Your confirmation code is ${code}. It expires in 10 minutes.`,
        },
      });
      if (delivery.delivery === 'permanent_failure') {
        await ctx.operations.cancelUncommitted(operationId, now);
        return fail(c, 'verification_delivery_failed', 503);
      }
    }
    return c.json({
      operation_id: operationId,
      upgrade_token: token,
      method,
      expires_at: now + 600,
      ...(options && { options }),
    });
  } catch {
    return fail(c, 'guest_upgrade_unavailable', 503);
  }
}

async function publication(c: C, operation: GuestUpgradeOperation, payload: ProofPayload) {
  const account = getAccountDataContextFromHono(c);
  if (!account || account.legacyUserId !== operation.user_id)
    throw new Error('guest_upgrade_account_context_invalid');
  const base = {
    operationId:
      operation.method === 'email'
        ? `account-email-addition:${operation.operation_id}`
        : `guest-upgrade-route:${operation.operation_id}`,
    idempotencyKey: operation.request_token_hash,
    tenantId: operation.tenant_id,
    accountId: account.accountId,
    routeProjection: account.membership.routeProjection,
  };
  return operation.method === 'email'
    ? buildAccountEmailAddition(c.env, { ...base, email: payload.email! })
    : buildAccountExternalSubjectAddition(c.env, {
        ...base,
        externalSubject: passkeyCredentialLookupSubject({
          rpId: payload.rpId!,
          credentialId: payload.credentialId!,
        }),
      });
}

async function writeRegistration(
  c: C,
  ctx: Pick<Exclude<Awaited<ReturnType<typeof context>>, Response>, 'tenantId' | 'auth' | 'pii'> & {
    userId: string;
  },
  operation: GuestUpgradeOperation
): Promise<void> {
  const payload = JSON.parse(operation.proof_payload_json!) as ProofPayload;
  const preparedPublication = await validateAccountDirectoryPublication(
    JSON.parse(operation.reservation_publication_json ?? 'null')
  );
  if (operation.method === 'email') {
    // The helper uses the same stable operation identifier as the reservation below.
    await addVerifiedAccountEmail(c, {
      tenantId: ctx.tenantId,
      accountId: ctx.userId,
      challengeId: `identifier-replacement-${operation.operation_id}`,
      email: payload.email!,
      idempotencyKeySha256: operation.request_token_hash,
      preparedPublication,
    });
  } else {
    const repo = new PasskeyRepository(ctx.auth.coreAdapter, ctx.tenantId);
    const id = `guest-upgrade:${operation.operation_id}`;
    const existing = await repo.findByCredentialId(payload.credentialId!);
    if (
      existing &&
      (existing.id !== id ||
        existing.user_id !== ctx.userId ||
        existing.public_key !== payload.publicKey ||
        existing.rp_id !== payload.rpId)
    )
      throw new Error('guest_upgrade_credential_conflict');
    if (!existing)
      await repo.create({
        id,
        user_id: ctx.userId,
        credential_id: payload.credentialId!,
        rp_id: payload.rpId,
        public_key: payload.publicKey!,
        counter: payload.counter,
        transports: payload.transports,
        aaguid: payload.aaguid,
      });
    const account = getAccountDataContextFromHono(c)!;
    if (!c.env.ACCOUNT_DIRECTORY) throw new Error('account_directory_unavailable');
    await publishAccountExternalSubjectAddition(
      c.env,
      {
        operationId: `guest-upgrade-route:${operation.operation_id}`,
        idempotencyKey: operation.request_token_hash,
        tenantId: ctx.tenantId,
        accountId: account.accountId,
        externalSubject: passkeyCredentialLookupSubject({
          rpId: payload.rpId!,
          credentialId: payload.credentialId!,
        }),
        routeProjection: account.membership.routeProjection,
      },
      {
        tenantCoreUsers: ctx.auth.coreAdapter,
        directory: c.env.ACCOUNT_DIRECTORY,
        preparedPublication,
      }
    );
  }
  const users = new CanonicalRuntimeUserStore({
    coreAdapter: ctx.auth.coreAdapter,
    piiAdapter: ctx.pii.defaultPiiAdapter,
    tenantId: ctx.tenantId,
  });
  const user = await users.findById(ctx.userId);
  if (!user || user.account_type !== 'user') throw new Error('guest_upgrade_account_unavailable');
  await users.syncUser({
    userId: ctx.userId,
    email: payload.email ?? user.email ?? null,
    name: user.name ?? null,
    active: true,
    emailVerified: operation.method === 'email' || user.email_verified === 1,
    userType: 'end_user',
    sourceRef: 'guest_upgrade',
  });
  const sources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, ctx.tenantId, {
    accountId: ctx.userId,
  });
  if (!sources.nonPiiDb) throw new Error('guest_upgrade_profile_route_unavailable');
  await syncUserLifecycleState({
    db: sources.nonPiiDb,
    dbPii: sources.piiDb,
    schemaDb: sources.schemaDb,
    stateDb: ctx.auth.coreAdapter,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    accountAuthenticationEnv: c.env,
  });
  await ctx.auth.coreAdapter.execute(
    'UPDATE guest_devices SET is_active = FALSE WHERE tenant_id = ? AND user_id = ?',
    [ctx.tenantId, ctx.userId]
  );
  // Durable, non-PII audit evidence is idempotent across a crash or competing retry.
  await ctx.auth.coreAdapter.execute(
    `INSERT INTO guest_account_upgrades (id, tenant_id, guest_user_id, upgraded_user_id, upgrade_method, provider_id, preserve_sub, upgraded_at, data_migrated)
    VALUES (?, ?, ?, ?, ?, NULL, 1, ?, 0) ON CONFLICT (id) DO NOTHING`,
    [
      operation.operation_id,
      ctx.tenantId,
      ctx.userId,
      ctx.userId,
      operation.method,
      operation.updated_at * 1000,
    ]
  );
  await recordAccountOperation(c, {
    userId: ctx.userId,
    action: 'account.guest.upgraded',
    metadata: { operationId: operation.operation_id, method: operation.method },
  });
}

export async function completeAccountGuestUpgradeHandler(c: C): Promise<Response> {
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (
      !body ||
      typeof body.operation_id !== 'string' ||
      body.operation_id.length > 100 ||
      typeof body.upgrade_token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.upgrade_token) ||
      (body.preserve_sub !== undefined && body.preserve_sub !== true)
    )
      return fail(c, 'invalid_request');
    const ctx = await context(c);
    if (ctx instanceof Response) return ctx;
    let operation = await ctx.operations.get(body.operation_id);
    const tokenHash = await sha256(body.upgrade_token);
    if (
      !operation ||
      operation.user_id !== ctx.session.userId ||
      operation.client_id !== ctx.clientId ||
      operation.initiating_session_id !== ctx.session.id ||
      operation.request_token_hash !== tokenHash
    )
      return fail(c, 'invalid_upgrade_proof');
    const now = Math.floor(Date.now() / 1000);
    if (operation.state === 'awaiting_proof') {
      if (operation.expires_at <= now) return fail(c, 'upgrade_proof_expired');
      if (!(await allowedMethods(c, ctx.tenantId, ctx.clientId)).includes(operation.method))
        return fail(c, 'guest_upgrade_disabled', 403);
      const common = {
        operationId: operation.operation_id,
        userId: ctx.session.userId,
        sessionId: ctx.session.id,
        requestTokenHash: tokenHash,
        now,
      };
      if (operation.method === 'email') {
        if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code))
          return fail(c, 'invalid_upgrade_proof');
        if (
          !(await ctx.operations.verifyEmail({
            ...common,
            verifier: await otpVerifier(c.env, ctx.tenantId, operation.operation_id, body.code),
          }))
        )
          return fail(c, 'invalid_upgrade_proof');
      } else {
        const payload = JSON.parse(operation.proof_payload_json!) as ProofPayload;
        if (
          getAccountWebAuthnOrigin(c) !== payload.origin ||
          !body.passkey_response ||
          typeof body.passkey_response !== 'object'
        )
          return fail(c, 'invalid_upgrade_proof');
        let verification;
        try {
          verification = await verifyRegistrationResponse({
            response: body.passkey_response as RegistrationResponseJSON,
            expectedChallenge: operation.challenge_verifier!,
            expectedOrigin: payload.origin!,
            expectedRPID: payload.rpId!,
            requireUserVerification: true,
          });
        } catch {
          return fail(c, 'invalid_upgrade_proof');
        }
        if (!verification.verified || !verification.registrationInfo)
          return fail(c, 'invalid_upgrade_proof');
        const info = verification.registrationInfo;
        const credential = info.credential;
        if (!credential?.id || !credential.publicKey) return fail(c, 'invalid_upgrade_proof');
        payload.credentialId = credential.id;
        payload.publicKey = Buffer.from(credential.publicKey).toString('base64');
        payload.counter = credential.counter;
        payload.aaguid = info.aaguid;
        payload.transports = (credential.transports ?? []).filter(
          (value): value is AuthenticatorTransport =>
            ['usb', 'nfc', 'ble', 'internal', 'hybrid'].includes(value)
        );
        if (
          !(await ctx.operations.verifyPasskey({
            ...common,
            challenge: operation.challenge_verifier!,
            verifiedPayloadJson: JSON.stringify(payload),
          }))
        )
          return fail(c, 'invalid_upgrade_proof');
      }
      operation = (await ctx.operations.get(operation.operation_id))!;
    }
    if (operation.state === 'verified' && ctx.row.phase === 'active') {
      if (operation.expires_at <= now) return fail(c, 'upgrade_proof_expired');
      if (!(await allowedMethods(c, ctx.tenantId, ctx.clientId)).includes(operation.method))
        return fail(c, 'guest_upgrade_disabled', 403);
      const payload = JSON.parse(operation.proof_payload_json!) as ProofPayload;
      // Reserve uniqueness before changing the guest. Existing identities never merge.
      const pinned = await ctx.operations.pinReservation(
        operation.operation_id,
        operation.reservation_publication_json ??
          JSON.stringify(await publication(c, operation, payload))
      );
      if (!pinned) return fail(c, 'upgrade_proof_expired');
      const value = await validateAccountDirectoryPublication(JSON.parse(pinned));
      try {
        await new InitialAccountIdentifierReservationService({
          lookupForBucket: await createLookupBucketWriteResolver(c.env),
          now: () => now,
        }).reserve(value);
        const reflected = await ctx.operations.get(operation.operation_id);
        if (!reflected || !['verified', 'committing', 'completed'].includes(reflected.state)) {
          await new InitialAccountIdentifierReservationService({
            lookupForBucket: await createLookupBucketWriteResolver(c.env),
            now: () => now,
          }).release(value);
          return fail(c, 'upgrade_proof_expired');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'directory_identifier_reservation_conflict')
          return c.json(
            { error: 'identity_already_registered', existing_login_available: true },
            409
          );
        throw error;
      }
    }
    const result = await commitGuestUpgrade({
      lifecycle: ctx.lifecycle,
      operations: ctx.operations,
      userId: ctx.session.userId,
      clientId: ctx.clientId,
      operationId: operation.operation_id,
      now,
      leaseOwner: crypto.randomUUID(),
      isAllowed: async (method) =>
        (await allowedMethods(c, ctx.tenantId, ctx.clientId)).includes(method),
      commit: (op) => writeRegistration(c, { ...ctx, userId: ctx.session.userId }, op),
    });
    if (result === 'pending') return c.json({ status: 'in_progress' }, 202);
    if (result !== 'completed')
      return fail(
        c,
        result === 'expired' ? 'upgrade_proof_expired' : 'guest_upgrade_unavailable',
        409
      );
    // A completed retry must not refresh authentication or replace a later login.
    if (ctx.session.data?.is_guest_session === true) {
      const completed = await ctx.lifecycle.get(ctx.session.userId);
      const authenticatedAt = completed?.upgraded_at ?? operation.updated_at;
      await ctx.sessions.updateSessionDataRpc(
        ctx.session.id,
        {
          is_guest_session: false,
          guest_resume_credential: false,
          device_id_hash: undefined,
          upgrade_eligible: false,
          upgrade_method: operation.method,
          upgraded_at: authenticatedAt * 1000,
          amr: [operation.method === 'email' ? 'otp' : 'webauthn'],
          authTime: authenticatedAt,
        },
        { onlyIfGuestSession: true }
      );
    }
    return c.json({ success: true, user_id: ctx.session.userId, preserve_sub: true });
  } catch {
    return fail(c, 'guest_upgrade_unavailable', 503);
  }
}

/** Recovery is authorized exclusively by an already admitted core operation. */
export async function recoverAccountGuestUpgrade(
  env: Env,
  tenantId: string,
  userId: string,
  operationId: string
) {
  const account = await resolveAccountDataContext(env, { tenantId, accountId: userId });
  const c = new Context<{ Bindings: Env }>(
    new Request('https://internal.invalid/guest-upgrade-recovery'),
    { env }
  );
  const values = c as unknown as { set(key: string, value: unknown): void };
  values.set('tenantId', tenantId);
  values.set('accountDataContext', account);
  const auth = createAccountAuthContextFromHono(c, tenantId);
  const pii = createPIIContextFromHono(c, tenantId);
  const lifecycle = new GuestLifecycleRepository(auth.coreAdapter, tenantId);
  const operations = new GuestUpgradeRepository(pii.defaultPiiAdapter, tenantId);
  const row = await lifecycle.get(userId);
  if (
    !row ||
    row.upgrade_operation_id !== operationId ||
    !['upgrading', 'registered'].includes(row.phase)
  )
    return 'denied';
  return commitGuestUpgrade({
    lifecycle,
    operations,
    userId,
    clientId: row.client_id,
    operationId,
    now: Math.floor(Date.now() / 1000),
    leaseOwner: crypto.randomUUID(),
    isAllowed: async () => false,
    commit: (operation) => writeRegistration(c, { tenantId, userId, auth, pii }, operation),
  });
}
