import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  accountDirectoryRemovalOutboxId,
  CanonicalRuntimeUserStore,
  PasskeyRepository,
  passkeyCredentialLookupSubject,
  createAuthContextFromHono,
  createPIIContextFromHono,
  buildDOKey,
  generateId,
  getChallengeStoreByChallengeId,
  getLogger,
  getTenantMetadataContextFromHono,
  markAccountDirectoryRemovalReady,
  produceNotificationDelivery,
  resolveAccountDataContextFromHono,
  getSessionStoreBySessionId,
  getSessionRevocationStore,
  advancePasskeyAuthenticationState,
  isAccountAuthenticationDeniedError,
  getTenantIdFromContext,
  type AccountDirectoryRemovalPublication,
  type ExecuteResult,
} from '@authrim/ar-lib-core';
import { resolveAaguidAuthenticator } from '@authrim/ar-lib-core/webauthn/aaguid-metadata';
import { requireAccountSession, type AccountSession } from './account-page';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { recordAccountOperation } from './account-operation-log';
import {
  prepareAccountExternalSubjectRemoval,
  publishAccountExternalSubjectAddition,
} from './account-identifier-addition';
import { attemptImmediateAccountDirectoryRemovals } from './account-directory-removal-producer';

const MAX_DEVICE_NAME_LENGTH = 100;
const REAUTH_TTL_SECONDS = 5 * 60;
const EMAIL_REAUTH_TTL_SECONDS = 5 * 60;
const RP_NAME = 'Authrim';
const AUTHENTICATION_METHODS_CATEGORY = 'authentication-methods';
type AccountAuthenticatorTransport = 'usb' | 'nfc' | 'ble' | 'internal' | 'hybrid';
type AuthenticationMethodUsage = 'login' | 'signup' | 'reauth' | 'account_link';
type BuiltInAuthenticationMethod = 'passkey' | 'email_otp';

const VALID_TRANSPORTS: AccountAuthenticatorTransport[] = [
  'usb',
  'nfc',
  'ble',
  'internal',
  'hybrid',
];

function usesTenantD1AccountStorage(c: Context<{ Bindings: Env }>): boolean {
  return getTenantMetadataContextFromHono(c)?.storageProfileId === 'builtin:storage:tenant-d1';
}

type AccountPasskeyRecord = {
  id: string;
  user_id: string;
  credential_id: string;
  device_name: string | null;
  aaguid: string | null;
  created_at: number;
  last_used_at: number | null;
};

type CredentialIDLike = string | ArrayBuffer | ArrayBufferView;

type RegistrationInfoCompat = {
  credentialID?: CredentialIDLike;
  credentialPublicKey?: Uint8Array | ArrayBuffer;
  counter?: number;
  credential?: {
    id?: CredentialIDLike;
    publicKey?: Uint8Array | ArrayBuffer;
    counter?: number;
  };
  aaguid?: string;
};

type AccountPasskeyReauthChallenge = {
  userId?: string;
  sessionId?: string;
  challenge: string;
  metadata?: {
    rpID?: string;
    origin?: string;
    sessionId?: string;
  };
};

type AccountEmailReauthChallenge = {
  userId?: string;
  email?: string;
  challenge: string;
  metadata?: {
    sessionId?: string;
    issuedAt?: number;
  };
};

function setNoStore(c: Context<{ Bindings: Env }>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function sanitizePasskey(passkey: AccountPasskeyRecord) {
  const provider = resolveAaguidAuthenticator(passkey.aaguid);
  return {
    id: passkey.id,
    device_name: passkey.device_name,
    aaguid: provider?.aaguid ?? passkey.aaguid ?? null,
    provider,
    created_at: passkey.created_at,
    last_used_at: passkey.last_used_at,
  };
}

function getRequestRpId(c: Context<{ Bindings: Env }>): string {
  const origin = getAccountWebAuthnOrigin(c);
  if (origin) {
    return new URL(origin).hostname;
  }
  return new URL(c.req.url).hostname;
}

function buildWebAuthnSignalDetails(
  c: Context<{ Bindings: Env }>,
  accountSession: AccountSession,
  passkeys: AccountPasskeyRecord[]
) {
  return {
    rp_id: getRequestRpId(c),
    user_id: toBase64URLString(new TextEncoder().encode(accountSession.userId)),
    credential_ids: passkeys.map((passkey) => toBase64URLString(passkey.credential_id)),
  };
}

function reauthRequired(c: Context<{ Bindings: Env }>): Response {
  return c.json(
    {
      error: 'reauth_required',
      error_description: 'Recent authentication is required for this operation',
      reauth_required: true,
    },
    403
  );
}

function isRecentlyAuthenticated(accountSession: AccountSession): boolean {
  return Math.floor(Date.now() / 1000) < accountSession.authTime + REAUTH_TTL_SECONDS;
}

function normalizeOrigin(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') {
      return url.origin === 'null' ? null : url.origin;
    }
    if (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    ) {
      return url.origin === 'null' ? null : url.origin;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeExpectedOrigin(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    return url.origin === 'null' ? null : url.origin;
  } catch {
    return null;
  }
}

function originForHost(host: string): string[] {
  const normalizedHost = host.trim().toLowerCase();
  if (!normalizedHost) {
    return [];
  }

  const hostname = normalizedHost.split(':')[0];
  const origins = [`https://${normalizedHost}`];
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
    origins.push(`http://${normalizedHost}`);
  }
  return origins;
}

function isSameOriginAccountRequest(
  c: Context<{ Bindings: Env }>,
  originHeader: string | undefined
): boolean {
  const normalizedOrigin = normalizeExpectedOrigin(originHeader);
  if (!normalizedOrigin) {
    return false;
  }

  const candidateOrigins = new Set<string>();
  try {
    const requestOrigin = normalizeExpectedOrigin(new URL(c.req.url).origin);
    if (requestOrigin) {
      candidateOrigins.add(requestOrigin);
    }
  } catch {
    // Ignore malformed or unavailable request URLs and fall back to headers.
  }

  for (const headerName of ['x-authrim-forwarded-host', 'x-forwarded-host', 'host']) {
    const headerValue = c.req.header(headerName)?.split(',')[0]?.trim();
    if (!headerValue) {
      continue;
    }
    for (const origin of originForHost(headerValue)) {
      candidateOrigins.add(origin);
    }
  }

  return candidateOrigins.has(normalizedOrigin);
}

function getAccountWebAuthnOrigin(c: Context<{ Bindings: Env }>): string | null {
  const originHeader = c.req.header('Origin');
  const origin = normalizeOrigin(originHeader);
  if (!origin) {
    return null;
  }

  const browserOriginHeader = c.req.header('x-authrim-browser-origin');
  const isLoginUiProxy = c.req.header('x-authrim-ui-proxy') === 'login-ui';
  if (isLoginUiProxy && browserOriginHeader && isSameOriginAccountRequest(c, originHeader)) {
    const browserOrigin = normalizeOrigin(browserOriginHeader);
    if (browserOrigin) {
      return browserOrigin;
    }
  }

  return origin;
}

function toBase64URLString(input: CredentialIDLike): string {
  if (typeof input === 'string') {
    if (/^[A-Za-z0-9+/]+=*$/.test(input)) {
      return input.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }
    return input;
  }

  let bytes: Uint8Array;
  if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }

  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof ArrayBuffer ? new Uint8Array(input) : input;
}

function isAccountAuthenticatorTransport(value: string): value is AccountAuthenticatorTransport {
  return VALID_TRANSPORTS.includes(value as AccountAuthenticatorTransport);
}

async function requireRecentAccountSession(
  c: Context<{ Bindings: Env }>
): Promise<AccountSession | Response> {
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }
  if (!isRecentlyAuthenticated(accountSession)) {
    return reauthRequired(c);
  }
  return accountSession;
}

function normalizeDeviceName(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized || null;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function getAuthenticationMethodSettingKey(
  method: BuiltInAuthenticationMethod,
  usage: AuthenticationMethodUsage
): string {
  return usage === 'account_link'
    ? `authentication-methods.${method}.account_link_enabled`
    : `authentication-methods.${method}.${usage}_enabled`;
}

async function getLegacyAuthenticationMethodDefault(
  env: Env,
  method: BuiltInAuthenticationMethod
): Promise<boolean> {
  let legacyDefault = method === 'passkey';
  try {
    const rawSystemSettings = await env.SETTINGS?.get('system_settings');
    if (!rawSystemSettings) {
      return legacyDefault;
    }
    const systemSettings = JSON.parse(rawSystemSettings) as Record<string, unknown>;
    const advanced =
      systemSettings.advanced &&
      typeof systemSettings.advanced === 'object' &&
      !Array.isArray(systemSettings.advanced)
        ? (systemSettings.advanced as Record<string, unknown>)
        : {};
    legacyDefault =
      method === 'passkey' ? advanced.passkeyEnabled !== false : advanced.magicLinkEnabled === true;
  } catch {
    legacyDefault = method === 'passkey';
  }
  return legacyDefault;
}

async function isAuthenticationMethodUsageAvailable(
  env: Env,
  tenantId: string,
  method: BuiltInAuthenticationMethod,
  usage: AuthenticationMethodUsage
): Promise<boolean> {
  const legacyDefault = await getLegacyAuthenticationMethodDefault(env, method);
  try {
    const raw = await env.SETTINGS?.get(
      `settings:tenant:${tenantId}:${AUTHENTICATION_METHODS_CATEGORY}`
    );
    if (!raw) {
      return legacyDefault;
    }
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const legacyEnabled = normalizeBoolean(
      settings[`authentication-methods.${method}.enabled`],
      legacyDefault
    );
    return normalizeBoolean(
      settings[getAuthenticationMethodSettingKey(method, usage)],
      legacyEnabled
    );
  } catch {
    return legacyDefault;
  }
}

function generateEmailCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return (array[0] % 1_000_000).toString().padStart(6, '0');
}

async function hashEmailCode(
  code: string,
  email: string,
  sessionId: string,
  issuedAt: number,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${code}:${email.toLowerCase()}:${sessionId}:${issuedAt}`);
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, data);
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifyEmailCodeHash(
  code: string,
  email: string,
  sessionId: string,
  issuedAt: number,
  storedHash: string,
  secret: string
): Promise<boolean> {
  const computedHash = await hashEmailCode(code, email, sessionId, issuedAt, secret);
  return timingSafeStringEqual(computedHash, storedHash);
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const masked =
    local.length <= 2 ? `${local.charAt(0)}***` : `${local.charAt(0)}***${local.slice(-1)}`;
  return `${masked}@${domain}`;
}

function getEmailReauthHtml(data: {
  name?: string | null;
  email: string;
  code: string;
  expiresInMinutes: number;
}): string {
  const greeting = data.name ? `Hi ${escapeHtml(data.name)},` : 'Hi,';
  return `<!doctype html><html><body><p>${greeting}</p><p>Use this verification code to re-authenticate your Authrim account.</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${escapeHtml(data.code)}</p><p>This code expires in ${data.expiresInMinutes} minutes.</p><p>If you did not request this code, you can ignore this email.</p></body></html>`;
}

function getEmailReauthText(data: {
  name?: string | null;
  email: string;
  code: string;
  expiresInMinutes: number;
}): string {
  const greeting = data.name ? `Hi ${data.name},` : 'Hi,';
  return `${greeting}\n\nUse this verification code to re-authenticate your Authrim account: ${data.code}\n\nThis code expires in ${data.expiresInMinutes} minutes.\n\nIf you did not request this code, you can ignore this email.`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function refreshAccountReauthSession(
  c: Context<{ Bindings: Env }>,
  accountSession: AccountSession,
  method: string,
  authenticatedAtMs = Date.now()
): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const authTime = Math.floor(authenticatedAtMs / 1000);
  const reauthMethods = Array.from(new Set([...(accountSession.amr ?? []), method]));
  const { stub: sessionStore } = getSessionStoreBySessionId(
    c.env,
    accountSession.sessionId,
    tenantId
  );
  const updatedSession = await sessionStore.updateSessionDataRpc(accountSession.sessionId, {
    authTime,
    acr: accountSession.acr ?? 'urn:mace:incommon:iap:bronze',
    amr: reauthMethods,
  });
  if (!updatedSession) {
    return c.json({ error: 'server_error', error_description: 'Failed to update session' }, 500);
  }

  return c.json({
    ok: true,
    reauth: {
      authenticated_at: authTime,
      expires_at: authTime + REAUTH_TTL_SECONDS,
      methods: reauthMethods,
    },
  });
}

export async function createAccountPasskeyReauthOptionsHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const origin = getAccountWebAuthnOrigin(c);
  if (!origin) {
    return c.json(
      { error: 'invalid_request', error_description: 'Origin header is required' },
      400
    );
  }

  const rpID = new URL(origin).hostname;
  const tenantId = getTenantIdFromContext(c);
  if (!(await isAuthenticationMethodUsageAvailable(c.env, tenantId, 'passkey', 'reauth'))) {
    return c.json(
      {
        error: 'no_reauth_method',
        error_description: 'Passkey is not enabled for re-authentication',
      },
      403
    );
  }
  const authCtx = createAuthContextFromHono(c, tenantId);
  const passkeyRepo = new PasskeyRepository(authCtx.coreAdapter, tenantId);
  const passkeys = await passkeyRepo.findByUserId(accountSession.userId);
  if (passkeys.length === 0) {
    return c.json(
      {
        error: 'no_reauth_method',
        error_description: 'No passkey is available for re-authentication',
      },
      400
    );
  }

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: passkeys.map((passkey) => ({
      id: toBase64URLString(passkey.credential_id),
      type: 'public-key' as const,
      transports:
        passkey.transports.length > 0
          ? (passkey.transports as AuthenticatorTransportFuture[])
          : undefined,
    })),
  });

  const challengeId = generateId();
  const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId, tenantId);
  await challengeStore.storeChallengeRpc({
    id: `account_passkey_reauth:${challengeId}`,
    tenantId,
    type: 'passkey_reauth',
    userId: accountSession.userId,
    challenge: options.challenge,
    ttl: 300,
    metadata: {
      rpID,
      origin,
      sessionId: accountSession.sessionId,
    },
  });

  return c.json({
    options,
    challenge_id: challengeId,
  });
}

export async function completeAccountPasskeyReauthHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  let body: {
    challenge_id?: unknown;
    credential?: AuthenticationResponseJSON;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: 'invalid_request', error_description: 'Request body must be JSON' },
      400
    );
  }

  if (typeof body.challenge_id !== 'string' || !body.credential) {
    return c.json(
      { error: 'invalid_request', error_description: 'challenge_id and credential are required' },
      400
    );
  }

  const tenantId = getTenantIdFromContext(c);
  if (!(await isAuthenticationMethodUsageAvailable(c.env, tenantId, 'passkey', 'reauth'))) {
    return c.json(
      {
        error: 'no_reauth_method',
        error_description: 'Passkey is not enabled for re-authentication',
      },
      403
    );
  }
  const challengeStore = await getChallengeStoreByChallengeId(c.env, body.challenge_id, tenantId);
  let challengeData: AccountPasskeyReauthChallenge;
  try {
    challengeData = (await challengeStore.consumeChallengeRpc({
      id: `account_passkey_reauth:${body.challenge_id}`,
      tenantId,
      type: 'passkey_reauth',
    })) as AccountPasskeyReauthChallenge;
  } catch {
    return c.json(
      { error: 'invalid_challenge', error_description: 'Challenge not found or expired' },
      400
    );
  }

  const expectedOrigin = challengeData.metadata?.origin;
  const expectedRPID = challengeData.metadata?.rpID;
  const expectedSessionId = challengeData.metadata?.sessionId;
  if (
    challengeData.userId !== accountSession.userId ||
    expectedSessionId !== accountSession.sessionId ||
    !expectedOrigin ||
    !expectedRPID ||
    getAccountWebAuthnOrigin(c) !== expectedOrigin
  ) {
    return c.json(
      { error: 'invalid_challenge', error_description: 'Challenge does not match this session' },
      400
    );
  }

  const credentialId = toBase64URLString(body.credential.id);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const passkeyRepo = new PasskeyRepository(authCtx.coreAdapter, tenantId);
  const passkey = await passkeyRepo.findByCredentialId(credentialId);
  if (!passkey || passkey.user_id !== accountSession.userId) {
    return c.json(
      { error: 'verification_failed', error_description: 'Passkey was not verified' },
      400
    );
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.credential,
      expectedChallenge: challengeData.challenge,
      expectedOrigin,
      expectedRPID,
      credential: {
        id: toBase64URLString(passkey.credential_id),
        publicKey: Uint8Array.from(Buffer.from(passkey.public_key, 'base64')),
        counter: passkey.counter,
      },
      requireUserVerification: true,
    });
  } catch {
    return c.json(
      { error: 'verification_failed', error_description: 'Passkey verification failed' },
      400
    );
  }

  if (!verification.verified) {
    return c.json(
      { error: 'verification_failed', error_description: 'Passkey was not verified' },
      400
    );
  }
  const proofVerifiedAtMs = Date.now();

  const runtimeUsers = new CanonicalRuntimeUserStore({
    coreAdapter: authCtx.coreAdapter,
    piiAdapter: createPIIContextFromHono(c, tenantId).defaultPiiAdapter,
    tenantId,
  });
  try {
    await advancePasskeyAuthenticationState(
      c.env,
      {
        tenantId,
        userId: accountSession.userId,
        credentialId: passkey.id,
        storedCounter: passkey.counter,
        observedCounter: verification.authenticationInfo.newCounter,
        observedAtMs: proofVerifiedAtMs,
      },
      () => runtimeUsers.findAccountAuthenticationState(accountSession.userId)
    );
  } catch (error) {
    if (isAccountAuthenticationDeniedError(error)) {
      return c.json(
        { error: 'verification_failed', error_description: 'Passkey was not verified' },
        400
      );
    }
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'Authentication state unavailable.',
      },
      503,
      { 'Retry-After': '1' }
    );
  }
  c.executionCtx.waitUntil(
    passkeyRepo
      .mirrorCounterAfterAuth(passkey.id, verification.authenticationInfo.newCounter)
      .catch((error: unknown) => {
        getLogger(c)
          .module('ACCOUNT-REAUTH')
          .error('Failed to mirror Passkey counter', {
            action: 'passkey_state_mirror',
            errorType: error instanceof Error ? error.name : 'Unknown',
          });
      })
  );
  return refreshAccountReauthSession(c, accountSession, 'passkey', proofVerifiedAtMs);
}

export async function sendAccountEmailCodeReauthHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const log = getLogger(c).module('ACCOUNT-REAUTH');
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const tenantId = getTenantIdFromContext(c);
  if (!(await isAuthenticationMethodUsageAvailable(c.env, tenantId, 'email_otp', 'reauth'))) {
    return c.json(
      {
        error: 'no_reauth_method',
        error_description: 'Email code is not enabled for re-authentication',
      },
      403
    );
  }

  const authCtx = createAuthContextFromHono(c, tenantId);
  const piiCtx = createPIIContextFromHono(c, tenantId);
  const runtimeUsers = new CanonicalRuntimeUserStore({
    coreAdapter: authCtx.coreAdapter,
    piiAdapter: piiCtx.defaultPiiAdapter,
    tenantId,
  });
  const user = await runtimeUsers.findById(accountSession.userId);
  const normalizedEmail = user?.email?.trim().toLowerCase();
  if (!user || !normalizedEmail || user.email_verified !== 1) {
    return c.json(
      {
        error: 'no_reauth_method',
        error_description: 'A verified email address is required for email code re-authentication',
      },
      400
    );
  }

  const hmacSecret = c.env.OTP_HMAC_SECRET;
  if (!hmacSecret) {
    log.error('OTP_HMAC_SECRET must be configured for account email-code re-authentication', {
      action: 'account_email_reauth_send',
    });
    return c.json(
      { error: 'server_error', error_description: 'Email code is not configured' },
      500
    );
  }

  const rateLimiter = c.env.RATE_LIMITER.get(
    c.env.RATE_LIMITER.idFromName(buildDOKey('rate-limit', 'account-email-reauth', tenantId))
  );
  const rateLimitResult = await rateLimiter.incrementRpc(`send:${accountSession.userId}`, {
    windowSeconds: 15 * 60,
    maxRequests: 3,
  });
  if (!rateLimitResult.allowed) {
    return c.json(
      {
        error: 'rate_limited',
        error_description: 'Too many email code requests. Please try again later.',
        retry_after: rateLimitResult.retryAfter,
      },
      429
    );
  }

  const challengeId = crypto.randomUUID();
  const code = generateEmailCode();
  const issuedAt = Date.now();
  const codeHash = await hashEmailCode(code, normalizedEmail, challengeId, issuedAt, hmacSecret);
  const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId, tenantId);
  await challengeStore.storeChallengeRpc({
    id: `account_email_reauth:${challengeId}`,
    tenantId,
    type: 'account_email_reauth',
    userId: accountSession.userId,
    challenge: codeHash,
    ttl: EMAIL_REAUTH_TTL_SECONDS,
    email: normalizedEmail,
    metadata: {
      sessionId: accountSession.sessionId,
      issuedAt,
    },
  });

  const delivery = await produceNotificationDelivery(c.env, {
    owner: { owner: 'tenant', tenantId },
    intentId: `account-email-reauth:${challengeId}`,
    outboxId: `notification:${challengeId}`,
    notificationKind: 'account.email-reauth',
    idempotencyKey: `account-email-reauth:${challengeId}`,
    expiresAt: Math.floor(issuedAt / 1000) + EMAIL_REAUTH_TTL_SECONDS,
    payload: {
      channel: 'email',
      to: normalizedEmail,
      from: c.env.EMAIL_FROM || 'noreply@authrim.dev',
      subject: 'Your re-authentication code',
      body: getEmailReauthHtml({
        name: user.name,
        email: normalizedEmail,
        code,
        expiresInMinutes: EMAIL_REAUTH_TTL_SECONDS / 60,
      }),
      metadata: {
        textBody: getEmailReauthText({
          name: user.name,
          email: normalizedEmail,
          code,
          expiresInMinutes: EMAIL_REAUTH_TTL_SECONDS / 60,
        }),
      },
    },
  });
  if (delivery.delivery === 'permanent_failure') {
    log.error('Failed to send account email-code re-authentication', {
      action: 'account_email_reauth_send',
    });
    return c.json({ error: 'server_error', error_description: 'Email delivery failed' }, 500);
  }

  return c.json({
    challenge_id: challengeId,
    expires_in: EMAIL_REAUTH_TTL_SECONDS,
    masked_email: maskEmail(normalizedEmail),
  });
}

export async function completeAccountEmailCodeReauthHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const log = getLogger(c).module('ACCOUNT-REAUTH');
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  let body: {
    challenge_id?: unknown;
    code?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: 'invalid_request', error_description: 'Request body must be JSON' },
      400
    );
  }

  if (typeof body.challenge_id !== 'string' || typeof body.code !== 'string') {
    return c.json(
      { error: 'invalid_request', error_description: 'challenge_id and code are required' },
      400
    );
  }
  const code = body.code.trim();
  if (!/^\d{6}$/.test(code)) {
    return c.json(
      { error: 'invalid_request', error_description: 'code must be a 6 digit value' },
      400
    );
  }

  const tenantId = getTenantIdFromContext(c);
  if (!(await isAuthenticationMethodUsageAvailable(c.env, tenantId, 'email_otp', 'reauth'))) {
    return c.json(
      {
        error: 'no_reauth_method',
        error_description: 'Email code is not enabled for re-authentication',
      },
      403
    );
  }

  const rateLimiter = c.env.RATE_LIMITER.get(
    c.env.RATE_LIMITER.idFromName(buildDOKey('rate-limit', 'account-email-reauth', tenantId))
  );
  const attemptResult = await rateLimiter.incrementRpc(`verify:${body.challenge_id}`, {
    windowSeconds: EMAIL_REAUTH_TTL_SECONDS,
    maxRequests: 5,
  });
  if (!attemptResult.allowed) {
    const challengeStore = await getChallengeStoreByChallengeId(c.env, body.challenge_id, tenantId);
    await challengeStore
      .deleteChallengeRpc(`account_email_reauth:${body.challenge_id}`)
      .catch(() => {});
    return c.json(
      {
        error: 'rate_limited',
        error_description: 'Too many verification attempts. Please request a new code.',
        retry_after: attemptResult.retryAfter,
      },
      429
    );
  }

  const challengeStore = await getChallengeStoreByChallengeId(c.env, body.challenge_id, tenantId);
  let challengeData: AccountEmailReauthChallenge;
  try {
    challengeData = (await challengeStore.consumeChallengeRpc({
      id: `account_email_reauth:${body.challenge_id}`,
      tenantId,
      type: 'account_email_reauth',
    })) as AccountEmailReauthChallenge;
  } catch {
    return c.json(
      { error: 'invalid_code', error_description: 'The verification code is invalid or expired' },
      400
    );
  }

  if (
    challengeData.userId !== accountSession.userId ||
    challengeData.metadata?.sessionId !== accountSession.sessionId ||
    !challengeData.email ||
    typeof challengeData.metadata?.issuedAt !== 'number'
  ) {
    return c.json(
      { error: 'invalid_challenge', error_description: 'Challenge does not match this session' },
      400
    );
  }

  const hmacSecret = c.env.OTP_HMAC_SECRET;
  if (!hmacSecret) {
    log.error('OTP_HMAC_SECRET must be configured for account email-code re-authentication', {
      action: 'account_email_reauth_complete',
    });
    return c.json(
      { error: 'server_error', error_description: 'Email code is not configured' },
      500
    );
  }

  const isValidCode = await verifyEmailCodeHash(
    code,
    challengeData.email,
    body.challenge_id,
    challengeData.metadata.issuedAt,
    challengeData.challenge,
    hmacSecret
  );
  if (!isValidCode) {
    return c.json(
      { error: 'invalid_code', error_description: 'The verification code is invalid or expired' },
      400
    );
  }

  return refreshAccountReauthSession(c, accountSession, 'email_code', Date.now());
}

async function isEmailCodeLoginAvailable(env: Env, tenantId: string): Promise<boolean> {
  return isAuthenticationMethodUsageAvailable(env, tenantId, 'email_otp', 'login');
}

async function hasVerifiedEmailLoginMethod(
  c: Context<{ Bindings: Env }>,
  accountSession: AccountSession,
  tenantId: string
): Promise<boolean> {
  if (!(await isEmailCodeLoginAvailable(c.env, tenantId))) {
    return false;
  }

  try {
    const authCtx = createAuthContextFromHono(c, tenantId);
    const piiCtx = createPIIContextFromHono(c, tenantId);
    const runtimeUsers = new CanonicalRuntimeUserStore({
      coreAdapter: authCtx.coreAdapter,
      piiAdapter: piiCtx.defaultPiiAdapter,
      tenantId,
    });
    const user = await runtimeUsers.findById(accountSession.userId);
    return Boolean(user?.email && user.email_verified === 1);
  } catch {
    return false;
  }
}

export async function createAccountPasskeyOptionsHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireRecentAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  let body: { device_name?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const deviceName = normalizeDeviceName(body.device_name);
  if (deviceName && deviceName.length > MAX_DEVICE_NAME_LENGTH) {
    return c.json(
      { error: 'invalid_request', error_description: 'device_name must not exceed 100 characters' },
      400
    );
  }

  const origin = getAccountWebAuthnOrigin(c);
  if (!origin) {
    return c.json(
      { error: 'invalid_request', error_description: 'Origin header is required' },
      400
    );
  }
  const rpID = new URL(origin).hostname;
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const passkeyRepo = new PasskeyRepository(authCtx.coreAdapter, tenantId);
  const existingPasskeys = await passkeyRepo.findByUserId(accountSession.userId);
  const excludeCredentials = existingPasskeys.map((passkey) => ({
    id: passkey.credential_id,
    type: 'public-key' as const,
    transports:
      passkey.transports.length > 0
        ? (passkey.transports as AuthenticatorTransportFuture[])
        : undefined,
  }));

  const userName = accountSession.userId;
  const encoder = new TextEncoder();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName,
    userDisplayName: userName,
    // @ts-ignore SimpleWebAuthn accepts Uint8Array user IDs.
    userID: encoder.encode(accountSession.userId),
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
    timeout: 60000,
    excludeCredentials,
  });

  const challengeId = generateId();
  const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId, tenantId);
  await challengeStore.storeChallengeRpc({
    id: `account_passkey_registration:${challengeId}`,
    tenantId,
    type: 'passkey_registration',
    userId: accountSession.userId,
    challenge: options.challenge,
    ttl: 300,
    metadata: {
      rpID,
      origin,
      ...(deviceName && { deviceName }),
    },
  });

  return c.json({
    options,
    challenge_id: challengeId,
  });
}

export async function completeAccountPasskeyRegistrationHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireRecentAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  let body: {
    challenge_id?: unknown;
    passkey_response?: RegistrationResponseJSON;
    device_name?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: 'invalid_request', error_description: 'Request body must be JSON' },
      400
    );
  }

  if (typeof body.challenge_id !== 'string' || !body.passkey_response) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'challenge_id and passkey_response are required',
      },
      400
    );
  }

  const tenantId = getTenantIdFromContext(c);
  const challengeStore = await getChallengeStoreByChallengeId(c.env, body.challenge_id, tenantId);
  let challengeData: {
    userId?: string;
    challenge: string;
    metadata?: {
      rpID?: string;
      origin?: string;
      deviceName?: string;
    };
  };
  try {
    challengeData = (await challengeStore.consumeChallengeRpc({
      id: `account_passkey_registration:${body.challenge_id}`,
      tenantId,
      type: 'passkey_registration',
    })) as typeof challengeData;
  } catch {
    return c.json(
      { error: 'invalid_challenge', error_description: 'Challenge not found or expired' },
      400
    );
  }

  const expectedOrigin = challengeData.metadata?.origin;
  const expectedRPID = challengeData.metadata?.rpID;
  if (
    challengeData.userId !== accountSession.userId ||
    !expectedOrigin ||
    !expectedRPID ||
    getAccountWebAuthnOrigin(c) !== expectedOrigin
  ) {
    return c.json(
      { error: 'invalid_challenge', error_description: 'Challenge does not match this session' },
      400
    );
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.passkey_response,
      expectedChallenge: challengeData.challenge,
      expectedOrigin,
      expectedRPID,
      requireUserVerification: true,
    });
  } catch {
    return c.json(
      { error: 'verification_failed', error_description: 'Passkey verification failed' },
      400
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json(
      { error: 'verification_failed', error_description: 'Passkey was not verified' },
      400
    );
  }

  const registrationInfo = verification.registrationInfo as unknown as RegistrationInfoCompat;
  const credentialID = registrationInfo.credentialID || registrationInfo.credential?.id;
  const credentialPublicKey =
    registrationInfo.credentialPublicKey || registrationInfo.credential?.publicKey;
  const counter = registrationInfo.counter ?? registrationInfo.credential?.counter ?? 0;
  if (!credentialID || !credentialPublicKey) {
    return c.json(
      { error: 'verification_failed', error_description: 'Invalid credential data' },
      400
    );
  }

  const credentialId = toBase64URLString(credentialID);
  const accountDataContext = usesTenantD1AccountStorage(c)
    ? await resolveAccountDataContextFromHono(c, accountSession.userId)
    : null;
  const authCtx = createAuthContextFromHono(c, tenantId);
  const passkeyRepo = new PasskeyRepository(authCtx.coreAdapter, tenantId);
  const existing = await passkeyRepo.findByCredentialId(credentialId);
  if (existing) {
    return c.json(
      { error: 'credential_exists', error_description: 'This passkey is already registered' },
      409
    );
  }

  const requestedDeviceName = normalizeDeviceName(body.device_name);
  if (requestedDeviceName && requestedDeviceName.length > MAX_DEVICE_NAME_LENGTH) {
    return c.json(
      { error: 'invalid_request', error_description: 'device_name must not exceed 100 characters' },
      400
    );
  }
  const transports = (body.passkey_response.response.transports || []).filter(
    isAccountAuthenticatorTransport
  );
  const passkey = await passkeyRepo.create({
    user_id: accountSession.userId,
    credential_id: credentialId,
    rp_id: expectedRPID,
    public_key: Buffer.from(toUint8Array(credentialPublicKey)).toString('base64'),
    counter,
    transports,
    device_name:
      requestedDeviceName || challengeData.metadata?.deviceName || `Passkey ${Date.now()}`,
    aaguid: registrationInfo.aaguid ?? null,
  });
  if (accountDataContext) {
    if (!c.env.ACCOUNT_DIRECTORY) throw new Error('account_passkey_directory_unavailable');
    await publishAccountExternalSubjectAddition(
      c.env,
      {
        operationId: `account-passkey-route-${passkey.id}`,
        idempotencyKey: `account-passkey-route:${passkey.id}`,
        tenantId,
        accountId: accountDataContext.accountId,
        externalSubject: passkeyCredentialLookupSubject({
          rpId: expectedRPID,
          credentialId,
        }),
        routeProjection: accountDataContext.membership.routeProjection,
      },
      {
        tenantCoreUsers: authCtx.coreAdapter,
        directory: c.env.ACCOUNT_DIRECTORY,
      }
    );
  }

  await recordAccountOperation(c, {
    userId: accountSession.userId,
    action: 'account.passkey.created',
    resourceType: 'passkey',
    resourceId: passkey.id,
  });

  const acceptedPasskeys = await passkeyRepo.findByUserId(accountSession.userId);
  const signalPasskeys = acceptedPasskeys.some((accepted) => accepted.id === passkey.id)
    ? acceptedPasskeys
    : [...acceptedPasskeys, passkey];

  return c.json(
    {
      ok: true,
      passkey: sanitizePasskey(passkey),
      webauthn_signal: buildWebAuthnSignalDetails(c, accountSession, signalPasskeys),
    },
    201
  );
}

export async function listAccountPasskeysHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const passkeyRepo = new PasskeyRepository(authCtx.coreAdapter, tenantId);
  const passkeys = await passkeyRepo.findByUserId(accountSession.userId);

  return c.json({
    passkeys: passkeys.map(sanitizePasskey),
    total: passkeys.length,
    webauthn_signal: buildWebAuthnSignalDetails(c, accountSession, passkeys),
  });
}

export async function updateAccountPasskeyHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  let body: { device_name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: 'invalid_request', error_description: 'Request body must be JSON' },
      400
    );
  }

  if (typeof body.device_name !== 'string') {
    return c.json({ error: 'invalid_request', error_description: 'device_name is required' }, 400);
  }
  const deviceName = body.device_name.trim().replace(/\s+/g, ' ');
  if (deviceName.length === 0) {
    return c.json(
      { error: 'invalid_request', error_description: 'device_name must not be empty' },
      400
    );
  }
  if (deviceName.length > MAX_DEVICE_NAME_LENGTH) {
    return c.json(
      { error: 'invalid_request', error_description: 'device_name must not exceed 100 characters' },
      400
    );
  }

  const passkeyId = c.req.param('id');
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const passkeyRepo = new PasskeyRepository(authCtx.coreAdapter, tenantId);
  const existing = passkeyId ? await passkeyRepo.findById(passkeyId) : null;
  if (!existing || existing.user_id !== accountSession.userId) {
    return c.json({ error: 'not_found', error_description: 'Passkey was not found' }, 404);
  }

  const updated = await passkeyRepo.rename(existing.id, deviceName);
  await recordAccountOperation(c, {
    userId: accountSession.userId,
    action: 'account.passkey.updated',
    resourceType: 'passkey',
    resourceId: existing.id,
    metadata: {
      fields: ['device_name'],
    },
  });
  return c.json({
    passkey: sanitizePasskey(updated ?? { ...existing, device_name: deviceName }),
  });
}

export async function deleteAccountPasskeyHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }
  if (!isRecentlyAuthenticated(accountSession)) {
    return reauthRequired(c);
  }

  const passkeyId = c.req.param('id');
  const tenantId = getTenantIdFromContext(c);
  const accountDataContext = usesTenantD1AccountStorage(c)
    ? await resolveAccountDataContextFromHono(c, accountSession.userId)
    : null;
  const authCtx = createAuthContextFromHono(c, tenantId);
  const passkeyRepo = new PasskeyRepository(authCtx.coreAdapter, tenantId);
  const existing = passkeyId ? await passkeyRepo.findById(passkeyId) : null;
  if (!existing || existing.user_id !== accountSession.userId) {
    return c.json({ error: 'not_found', error_description: 'Passkey was not found' }, 404);
  }

  const registeredPasskeys = await passkeyRepo.findByUserId(accountSession.userId);
  const hasAnotherPasskey = registeredPasskeys.some((passkey) => passkey.id !== existing.id);
  const hasOtherLoginMethod =
    hasAnotherPasskey || (await hasVerifiedEmailLoginMethod(c, accountSession, tenantId));

  if (!hasOtherLoginMethod) {
    return c.json(
      {
        error: 'remaining_login_method_required',
        error_description: 'Cannot delete the last available login method.',
      },
      400
    );
  }

  const deleteSql = hasAnotherPasskey
    ? `DELETE FROM passkeys
        WHERE id = ? AND tenant_id = ? AND user_id = ?
          AND (SELECT COUNT(*) FROM passkeys WHERE tenant_id = ? AND user_id = ?) > 1`
    : `DELETE FROM passkeys WHERE id = ? AND tenant_id = ? AND user_id = ?`;
  const deleteParams = hasAnotherPasskey
    ? [existing.id, tenantId, accountSession.userId, tenantId, accountSession.userId]
    : [existing.id, tenantId, accountSession.userId];
  let result: ExecuteResult;
  let removal: AccountDirectoryRemovalPublication | null = null;
  if (accountDataContext) {
    if (!existing.rp_id) throw new Error('account_passkey_route_authority_missing');
    const now = Math.floor(Date.now() / 1000);
    removal = await prepareAccountExternalSubjectRemoval(
      c.env,
      {
        operationId: `account-passkey-remove-${existing.id}`,
        idempotencyKey: `account-passkey-remove:${existing.id}`,
        tenantId,
        accountId: accountDataContext.accountId,
        externalSubject: passkeyCredentialLookupSubject({
          rpId: existing.rp_id,
          credentialId: existing.credential_id,
        }),
        routeProjection: accountDataContext.membership.routeProjection,
      },
      authCtx.coreAdapter,
      now
    );
    const outboxId = accountDirectoryRemovalOutboxId(removal.operationId);
    const results = await authCtx.coreAdapter.batch([
      { sql: deleteSql, params: deleteParams },
      {
        sql: `UPDATE account_routing_outbox
                SET status = 'pending', next_attempt_at = ?, updated_at = ?
              WHERE outbox_id = ? AND status = 'prepared'
                AND NOT EXISTS (
                  SELECT 1 FROM passkeys WHERE id = ? AND tenant_id = ? AND user_id = ?
                )`,
        params: [now, now, outboxId, existing.id, tenantId, accountSession.userId],
      },
    ]);
    result = results[0];
    if (results.length !== 2 || !results[1].success || results[1].rowsAffected !== 1) {
      if (result?.rowsAffected > 0) {
        await markAccountDirectoryRemovalReady(authCtx.coreAdapter, removal.operationId, now);
      } else {
        await authCtx.coreAdapter.execute(
          `DELETE FROM account_routing_outbox WHERE outbox_id = ? AND status = 'prepared'`,
          [outboxId]
        );
      }
    }
  } else {
    result = await authCtx.coreAdapter.execute(deleteSql, deleteParams);
  }

  if (!result || result.rowsAffected <= 0) {
    return c.json({ error: 'not_found', error_description: 'Passkey was not found' }, 404);
  }
  if (removal) {
    await attemptImmediateAccountDirectoryRemovals(c.env.ACCOUNT_DIRECTORY, [removal]);
  }
  c.executionCtx.waitUntil(
    getSessionRevocationStore(c.env, tenantId, accountSession.userId)
      .deleteCredentialStateRpc(
        tenantId,
        accountSession.userId,
        `account:${accountSession.userId}`,
        'passkey',
        existing.id
      )
      .catch((error: unknown) => {
        getLogger(c)
          .module('ACCOUNT_PASSKEY')
          .error('Failed to clean Passkey DO state', {
            action: 'passkey_state_cleanup',
            errorType: error instanceof Error ? error.name : 'Unknown',
          });
      })
  );

  await recordAccountOperation(c, {
    userId: accountSession.userId,
    action: 'account.passkey.deleted',
    resourceType: 'passkey',
    resourceId: existing.id,
  });

  return c.json({
    ok: true,
    passkey: {
      id: existing.id,
      deleted: true,
    },
    webauthn_signal: buildWebAuthnSignalDetails(
      c,
      accountSession,
      registeredPasskeys.filter((passkey) => passkey.id !== existing.id)
    ),
  });
}
