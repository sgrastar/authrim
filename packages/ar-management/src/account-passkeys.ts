import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  PasskeyRepository,
  createAuthContextFromHono,
  generateId,
  getChallengeStoreByChallengeId,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';
import { requireAccountSession, type AccountSession } from './account-page';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type {
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

const MAX_DEVICE_NAME_LENGTH = 100;
const REAUTH_TTL_SECONDS = 5 * 60;
const RP_NAME = 'Authrim';
type AccountAuthenticatorTransport = 'usb' | 'nfc' | 'ble' | 'internal' | 'hybrid';

const VALID_TRANSPORTS: AccountAuthenticatorTransport[] = [
  'usb',
  'nfc',
  'ble',
  'internal',
  'hybrid',
];

type AccountPasskeyRecord = {
  id: string;
  user_id: string;
  device_name: string | null;
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

function setNoStore(c: Context<{ Bindings: Env }>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function sanitizePasskey(passkey: AccountPasskeyRecord) {
  return {
    id: passkey.id,
    device_name: passkey.device_name,
    created_at: passkey.created_at,
    last_used_at: passkey.last_used_at,
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
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    return url.origin === 'null' ? null : url.origin;
  } catch {
    return null;
  }
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

  const origin = normalizeOrigin(c.req.header('Origin'));
  if (!origin) {
    return c.json({ error: 'invalid_request', error_description: 'Origin header is required' }, 400);
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
    return c.json({ error: 'invalid_request', error_description: 'Request body must be JSON' }, 400);
  }

  if (typeof body.challenge_id !== 'string' || !body.passkey_response) {
    return c.json(
      { error: 'invalid_request', error_description: 'challenge_id and passkey_response are required' },
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
    normalizeOrigin(c.req.header('Origin')) !== expectedOrigin
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
    public_key: Buffer.from(toUint8Array(credentialPublicKey)).toString('base64'),
    counter,
    transports,
    device_name:
      requestedDeviceName || challengeData.metadata?.deviceName || `Passkey ${Date.now()}`,
  });

  return c.json(
    {
      ok: true,
      passkey: sanitizePasskey(passkey),
    },
    201
  );
}

export async function listAccountPasskeysHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
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
    return c.json({ error: 'invalid_request', error_description: 'Request body must be JSON' }, 400);
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
  const authCtx = createAuthContextFromHono(c, tenantId);
  const passkeyRepo = new PasskeyRepository(authCtx.coreAdapter, tenantId);
  const existing = passkeyId ? await passkeyRepo.findById(passkeyId) : null;
  if (!existing || existing.user_id !== accountSession.userId) {
    return c.json({ error: 'not_found', error_description: 'Passkey was not found' }, 404);
  }

  const result = await authCtx.coreAdapter.execute(
    `DELETE FROM passkeys
      WHERE id = ? AND tenant_id = ? AND user_id = ?
        AND (SELECT COUNT(*) FROM passkeys WHERE tenant_id = ? AND user_id = ?) > 1`,
    [existing.id, tenantId, accountSession.userId, tenantId, accountSession.userId]
  );

  if (result.rowsAffected <= 0) {
    return c.json(
      {
        error: 'last_passkey',
        error_description: 'Cannot delete the last passkey.',
      },
      400
    );
  }

  return c.json({
    ok: true,
    passkey: {
      id: existing.id,
      deleted: true,
    },
  });
}
