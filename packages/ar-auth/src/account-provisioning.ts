import type { Context } from 'hono';
import {
  anonymousDeviceLookupSubject,
  getChallengeStoreByChallengeId,
  getTenantIdFromContext,
  isCanonicalAccountIdForUser,
  isValidPersistedUserId,
  passkeyCredentialLookupSubject,
  resolveAccountDataContextFromHono,
  resolveAccountDataContextByIdentifierFromHono,
  type AccountDataContext,
  type AuthAnonymousDeviceProvisioningInput,
  type AuthAccountProvisioningFlow,
  type AuthAccountProvisioningInput,
  type CanonicalRuntimeUserWriteInput,
  type CanonicalSensitiveUserField,
  type Challenge,
  type Env,
  type StoreChallengeRequest,
} from '@authrim/ar-lib-core';

const RESUME_TTL_SECONDS = 5 * 60;
const RESUME_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

type ProvisioningRuntimeUser = Omit<CanonicalRuntimeUserWriteInput, 'userId' | 'tenantId'> & {
  piiFields?: Partial<Record<CanonicalSensitiveUserField, boolean>>;
  sensitiveValues?: Partial<Record<CanonicalSensitiveUserField, unknown>>;
};

export interface ProvisionEmailAccountInput {
  tenantId: string;
  candidateUserId: string;
  flow: AuthAccountProvisioningFlow;
  email: string;
  runtimeUser: ProvisioningRuntimeUser;
}

export type ProvisionEmailAccountResult =
  | { status: 'ready'; accountId: string; userId: string }
  | { status: 'pending'; response: Response };

export interface PublishPasskeyRouteInput {
  tenantId: string;
  userId: string;
  passkeyId: string;
  credentialId: string;
  rpId: string;
}

export interface ProvisionAnonymousAccountInput {
  tenantId: string;
  candidateUserId: string;
  device: Omit<AuthAnonymousDeviceProvisioningInput, 'id'>;
}

export interface RemoveAnonymousDeviceRouteInput {
  tenantId: string;
  userId: string;
  deviceId: string;
  deviceIdHash: string;
}

interface ResumeMetadata {
  schema_version: 1;
  operation_id: string;
  flow: AuthAccountProvisioningFlow;
  account_id: string;
  user_id: string;
}

interface AccountProvisioningChallengeStore {
  storeChallengeRpc(request: StoreChallengeRequest): Promise<{ success: boolean }>;
  getChallengeRpc(challengeId: string): Promise<Challenge | null>;
}

async function accountProvisioningChallengeStore(
  env: Env,
  challengeId: string,
  tenantId: string
): Promise<AccountProvisioningChallengeStore> {
  return (await getChallengeStoreByChallengeId(
    env,
    challengeId,
    tenantId
  )) as unknown as AccountProvisioningChallengeStore;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('account_provisioning_value_invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('account_provisioning_value_invalid');
    ancestors.add(value);
    const encoded = `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    ancestors.delete(value);
    return encoded;
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) throw new Error('account_provisioning_value_invalid');
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const encoded = `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
      .join(',')}}`;
    ancestors.delete(value);
    return encoded;
  }
  throw new Error('account_provisioning_value_invalid');
}

function randomResumeToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function resumeMetadata(value: unknown): ResumeMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (
    metadata.schema_version !== 1 ||
    typeof metadata.operation_id !== 'string' ||
    !SAFE_ID.test(metadata.operation_id) ||
    typeof metadata.flow !== 'string' ||
    ![
      'email_code',
      'passkey',
      'totp',
      'directory_password',
      'external_idp',
      'saml',
      'did',
      'test_stub',
      'anonymous',
      'anonymous_upgrade',
    ].includes(metadata.flow) ||
    !isCanonicalAccountIdForUser(metadata.account_id, metadata.user_id) ||
    Object.keys(metadata).length !== 5
  ) {
    return null;
  }
  return metadata as unknown as ResumeMetadata;
}

export async function resolveEmailAccountRoute(
  c: Context<{ Bindings: Env }>,
  email: string
): Promise<'resolved' | 'not_found'> {
  try {
    await resolveAccountDataContextByIdentifierFromHono(c, {
      indexKind: 'email_exact',
      identifier: email,
    });
    return 'resolved';
  } catch (error) {
    if (error instanceof Error && error.message === 'account_data_route_not_found') {
      return 'not_found';
    }
    throw error;
  }
}

export async function resolvePasskeyAccountRoute(
  c: Context<{ Bindings: Env }>,
  input: { credentialId: string; rpId: string }
): Promise<AccountDataContext | null> {
  return resolveAccountDataContextByIdentifierFromHono(c, {
    indexKind: 'external_subject',
    identifier: passkeyCredentialLookupSubject(input),
  });
}

export async function resolveAnonymousAccountRoute(
  c: Context<{ Bindings: Env }>,
  deviceIdHash: string
): Promise<AccountDataContext | null> {
  return resolveAccountDataContextByIdentifierFromHono(c, {
    indexKind: 'external_subject',
    identifier: anonymousDeviceLookupSubject(deviceIdHash),
  });
}

export async function publishPasskeyRoute(
  c: Context<{ Bindings: Env }>,
  input: PublishPasskeyRouteInput
): Promise<201 | 202> {
  if (!c.env.ACCOUNT_PROVISIONER) throw new Error('account_provisioner_unavailable');
  const account = await resolveAccountDataContextFromHono(c, input.userId);
  if (account.legacyUserId !== input.userId) {
    throw new Error('passkey_route_account_mismatch');
  }
  const stableRequest = canonicalJson({
    schemaVersion: 1,
    tenantId: input.tenantId,
    accountId: account.accountId,
    userId: input.userId,
    passkeyId: input.passkeyId,
    credentialId: input.credentialId,
    rpId: input.rpId,
  });
  const operationId = `passkey-route-${input.passkeyId}`;
  const result = await c.env.ACCOUNT_PROVISIONER.publishAuthPasskeyRoute({
    schemaVersion: 1,
    operationId,
    idempotencyKey: `auth-passkey-route:${await sha256Hex(stableRequest)}`,
    tenantId: input.tenantId,
    accountId: account.accountId,
    userId: input.userId,
    passkeyId: input.passkeyId,
    credentialId: input.credentialId,
    rpId: input.rpId,
  });
  if (
    result.operationId !== operationId ||
    result.accountId !== account.accountId ||
    (result.status !== 201 && result.status !== 202)
  ) {
    throw new Error('passkey_route_publication_result_invalid');
  }
  return result.status;
}

export async function removeAnonymousDeviceRoute(
  c: Context<{ Bindings: Env }>,
  input: RemoveAnonymousDeviceRouteInput
): Promise<201 | 202> {
  if (!c.env.ACCOUNT_PROVISIONER?.removeAuthAnonymousDeviceRoute) {
    throw new Error('account_provisioner_unavailable');
  }
  const account = await resolveAccountDataContextFromHono(c, input.userId);
  if (account.legacyUserId !== input.userId) {
    throw new Error('anonymous_route_removal_account_mismatch');
  }
  anonymousDeviceLookupSubject(input.deviceIdHash);
  const stableRequest = canonicalJson({
    schemaVersion: 1,
    tenantId: input.tenantId,
    accountId: account.accountId,
    userId: input.userId,
    deviceId: input.deviceId,
    deviceIdHash: input.deviceIdHash,
  });
  const operationId = `anonymous-route-remove-${input.deviceId}`;
  const result = await c.env.ACCOUNT_PROVISIONER.removeAuthAnonymousDeviceRoute({
    schemaVersion: 1,
    operationId,
    idempotencyKey: `auth-anonymous-route-remove:${await sha256Hex(stableRequest)}`,
    tenantId: input.tenantId,
    accountId: account.accountId,
    userId: input.userId,
    deviceId: input.deviceId,
    deviceIdHash: input.deviceIdHash,
  });
  if (
    result.operationId !== operationId ||
    result.accountId !== account.accountId ||
    (result.status !== 201 && result.status !== 202)
  ) {
    throw new Error('anonymous_route_removal_result_invalid');
  }
  return result.status;
}

async function provisionAuthAccountWithReconciliation(
  provisioner: NonNullable<Env['ACCOUNT_PROVISIONER']>,
  request: AuthAccountProvisioningInput
) {
  try {
    return await provisioner.provisionAuthAccount(request);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'auth_account_provisioning_internal_error') {
      throw error;
    }
    return provisioner.provisionAuthAccount(request);
  }
}

export async function provisionEmailAccount(
  c: Context<{ Bindings: Env }>,
  input: ProvisionEmailAccountInput
): Promise<ProvisionEmailAccountResult> {
  if (!c.env.ACCOUNT_PROVISIONER) throw new Error('account_provisioner_unavailable');
  const stableRequest = canonicalJson({
    schemaVersion: 1,
    tenantId: input.tenantId,
    flow: input.flow,
    email: input.email,
    runtimeUser: input.runtimeUser,
  });
  const request: AuthAccountProvisioningInput = {
    schemaVersion: 1,
    operationId: `account-create-${crypto.randomUUID()}`,
    idempotencyKey: `auth-account:${await sha256Hex(stableRequest)}`,
    tenantId: input.tenantId,
    candidateUserId: input.candidateUserId,
    flow: input.flow,
    email: input.email,
    runtimeUser: input.runtimeUser,
  };
  const result = await provisionAuthAccountWithReconciliation(c.env.ACCOUNT_PROVISIONER, request);
  if (result.status === 201) {
    return { status: 'ready', accountId: result.accountId, userId: result.userId };
  }

  const token = randomResumeToken();
  const tokenHash = await sha256Hex(token);
  const challengeId = `account_provisioning:${tokenHash}`;
  const challengeStore = await accountProvisioningChallengeStore(
    c.env,
    challengeId,
    input.tenantId
  );
  await challengeStore.storeChallengeRpc({
    id: challengeId,
    tenantId: input.tenantId,
    type: 'account_provisioning_resume',
    userId: result.userId,
    challenge: tokenHash,
    ttl: RESUME_TTL_SECONDS,
    metadata: {
      schema_version: 1,
      operation_id: result.operationId,
      flow: input.flow,
      account_id: result.accountId,
      user_id: result.userId,
    } satisfies ResumeMetadata,
  });
  return {
    status: 'pending',
    response: c.json(
      {
        status: 'provisioning',
        provisioning_token: token,
        status_endpoint: '/api/v1/auth/account-provisioning/status',
        retry_after_ms: 500,
        expires_in: RESUME_TTL_SECONDS,
      },
      202
    ),
  };
}

export async function provisionAnonymousAccount(
  c: Context<{ Bindings: Env }>,
  input: ProvisionAnonymousAccountInput
): Promise<ProvisionEmailAccountResult> {
  if (!c.env.ACCOUNT_PROVISIONER) throw new Error('account_provisioner_unavailable');
  const externalSubject = anonymousDeviceLookupSubject(input.device.deviceIdHash);
  const anonymousDevice: AuthAnonymousDeviceProvisioningInput = {
    id: `anonymous-device-${input.device.deviceIdHash.slice(0, 32)}`,
    ...input.device,
  };
  const runtimeUser: ProvisioningRuntimeUser = {
    active: true,
    emailVerified: false,
    userType: 'anonymous',
    sourceRef: 'auth:anonymous',
    piiFields: {},
    sensitiveValues: {},
  };
  const stableRequest = canonicalJson({
    schemaVersion: 1,
    tenantId: input.tenantId,
    flow: 'anonymous',
    externalSubject,
    anonymousDevice,
    runtimeUser,
  });
  const request: AuthAccountProvisioningInput = {
    schemaVersion: 1,
    operationId: `account-create-${crypto.randomUUID()}`,
    idempotencyKey: `auth-account:${await sha256Hex(stableRequest)}`,
    tenantId: input.tenantId,
    candidateUserId: input.candidateUserId,
    flow: 'anonymous',
    email: null,
    externalSubject,
    anonymousDevice,
    runtimeUser,
  };
  const result = await provisionAuthAccountWithReconciliation(c.env.ACCOUNT_PROVISIONER, request);
  if (result.status === 201) {
    return { status: 'ready', accountId: result.accountId, userId: result.userId };
  }

  const token = randomResumeToken();
  const tokenHash = await sha256Hex(token);
  const challengeId = `account_provisioning:${tokenHash}`;
  const challengeStore = await accountProvisioningChallengeStore(
    c.env,
    challengeId,
    input.tenantId
  );
  await challengeStore.storeChallengeRpc({
    id: challengeId,
    tenantId: input.tenantId,
    type: 'account_provisioning_resume',
    userId: result.userId,
    challenge: tokenHash,
    ttl: RESUME_TTL_SECONDS,
    metadata: {
      schema_version: 1,
      operation_id: result.operationId,
      flow: 'anonymous',
      account_id: result.accountId,
      user_id: result.userId,
    } satisfies ResumeMetadata,
  });
  return {
    status: 'pending',
    response: c.json(
      {
        status: 'provisioning',
        provisioning_token: token,
        status_endpoint: '/api/v1/auth/account-provisioning/status',
        retry_after_ms: 500,
        expires_in: RESUME_TTL_SECONDS,
      },
      202
    ),
  };
}

export async function accountProvisioningStatusHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{ provisioning_token?: unknown }>();
    if (
      !body ||
      typeof body !== 'object' ||
      Object.keys(body).length !== 1 ||
      typeof body.provisioning_token !== 'string' ||
      !RESUME_TOKEN.test(body.provisioning_token)
    ) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const tenantId = getTenantIdFromContext(c);
    const tokenHash = await sha256Hex(body.provisioning_token);
    const challengeId = `account_provisioning:${tokenHash}`;
    const challengeStore = await accountProvisioningChallengeStore(c.env, challengeId, tenantId);
    const challenge = await challengeStore.getChallengeRpc(challengeId);
    const metadata = resumeMetadata(challenge?.metadata);
    if (
      !challenge ||
      challenge.type !== 'account_provisioning_resume' ||
      challenge.tenantId !== tenantId ||
      challenge.userId !== metadata?.user_id ||
      challenge.challenge !== tokenHash ||
      challenge.consumed ||
      !metadata ||
      !c.env.ACCOUNT_PROVISIONER
    ) {
      return c.json({ error: 'invalid_or_expired_provisioning_token' }, 400);
    }
    const status = await c.env.ACCOUNT_PROVISIONER.getAuthAccountProvisioningStatus({
      schemaVersion: 1,
      tenantId,
      operationId: metadata.operation_id,
      flow: metadata.flow,
    });
    if (
      status.operationId !== metadata.operation_id ||
      status.accountId !== metadata.account_id ||
      status.userId !== metadata.user_id
    ) {
      return c.json({ error: 'account_provisioning_state_invalid' }, 500);
    }
    if (status.status === 'failed') {
      return c.json({ status: 'failed' }, 409);
    }
    return c.json({
      status: status.status,
      ...(status.status === 'ready' && metadata.flow === 'anonymous'
        ? { restart_required: true }
        : {}),
      ...(status.status === 'pending' ? { retry_after_ms: 500 } : {}),
    });
  } catch {
    return c.json({ error: 'account_provisioning_status_unavailable' }, 503);
  }
}
