import { Hono } from 'hono';
import { vi, type Mock } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  handleExternalProvisioningResume,
  handleExternalProvisioningStatus,
} from '../../handlers/callback';
import { encrypt } from '../../utils/crypto';

export const ENCRYPTION_KEY = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
export const TOKEN = 'A'.repeat(43);
export const TENANT = 'tenant-a';
export const NOW = 1_800_000_000_000;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface Continuation {
  schemaVersion: number;
  authState: Record<string, unknown>;
  providerId: string;
  upstreamAcr?: unknown;
  upstreamIdToken?: string;
  userInfo: Record<string, unknown>;
  result: Record<string, unknown>;
  [key: string]: unknown;
}

export function defaultContinuation(): Continuation {
  return {
    schemaVersion: 1,
    authState: {
      id: 'auth-state-a',
      tenantId: TENANT,
      clientId: 'client-a',
      providerId: 'provider-a',
      state: 'client-state-a',
      codeChallenge: 'code-challenge-a',
      redirectUri: 'https://login.example.com/callback',
      enableSso: false,
      expiresAt: NOW + 60_000,
      createdAt: NOW,
    },
    providerId: 'provider-a',
    upstreamAcr: 'urn:mace:incommon:iap:silver',
    userInfo: { sub: 'provider-user-a', email: 'person@example.com', email_verified: true },
    result: {
      status: 'pending',
      userId: 'user-a',
      isNewUser: true,
      stitchedFromExisting: false,
      accountId: 'account:user-a',
      operationId: 'account-create-operation-a',
      providerId: 'provider-a',
      providerUserId: 'provider-user-a',
    },
  };
}

export interface FixtureOptions {
  mutate?: (continuation: Continuation) => void;
  /** The decrypted payload as text (replaces the continuation). */
  payloadText?: string;
  /** Fields of the stored challenge to change, or null for none stored. */
  challenge?: Record<string, unknown> | null;
  status?: Record<string, unknown>;
  cookie?: 'ok' | 'none' | 'wrong';
  resume?: boolean;
  /** Raw request body of the status call. */
  rawBody?: string;
  token?: string;
  tenant?: string;
  env?: Record<string, unknown>;
  consumed?: { userId: string } | Error;
  executionContext?: { waitUntil: Mock };
}

export interface FixtureMocks {
  getChallengeStore: Mock;
}

export async function runProvisioning(mocks: FixtureMocks, options: FixtureOptions = {}) {
  const token = options.token ?? TOKEN;
  const digest = await sha256Hex(TOKEN);
  const continuation = defaultContinuation();
  options.mutate?.(continuation);
  const payloadText = options.payloadText ?? JSON.stringify(continuation);
  const challenge =
    options.challenge === null
      ? null
      : {
          id: `external_idp_provisioning:${digest}`,
          tenantId: TENANT,
          type: 'external_idp_provisioning_resume',
          userId: 'user-a',
          challenge: digest,
          consumed: false,
          expiresAt: NOW + 60_000,
          metadata: { encrypted_payload: await encrypt(payloadText, ENCRYPTION_KEY) },
          ...options.challenge,
        };
  const consume = vi.fn(async () => {
    if (options.consumed instanceof Error) throw options.consumed;
    return options.consumed ?? { userId: 'user-a' };
  });
  const store = {
    getChallengeRpc: vi.fn(async () => challenge),
    consumeChallengeRpc: consume,
    storeChallengeRpc: vi.fn().mockResolvedValue(undefined),
  };
  mocks.getChallengeStore.mockResolvedValue(store);
  const getStatus = vi.fn().mockResolvedValue({
    status: 'pending',
    operationId: 'account-create-operation-a',
    accountId: 'account:user-a',
    userId: 'user-a',
    ...options.status,
  });
  const app = new Hono<{ Bindings: Env }>();
  app.post('/status', handleExternalProvisioningStatus);
  app.get('/resume', handleExternalProvisioningResume);
  const cookieName = `authrim_external_provisioning_${digest.slice(0, 24)}`;
  const cookie =
    options.cookie === 'none'
      ? undefined
      : `${cookieName}=${options.cookie === 'wrong' ? 'x'.repeat(64) : digest}`;
  const tenant = options.tenant ?? TENANT;
  const env = {
    RP_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    ISSUER_URL: 'https://auth.example.com',
    EXTERNAL_IDP_ACCOUNT_PROVISIONER: { getExternalIdpAccountProvisioningStatus: getStatus },
    ...options.env,
  } as unknown as Env;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const response = await app.request(
    options.resume ? `/resume?token=${token}&tenant=${tenant}` : '/status',
    options.resume
      ? { method: 'GET', headers }
      : {
          method: 'POST',
          headers,
          body: options.rawBody ?? JSON.stringify({ provisioning_token: token, tenant_id: tenant }),
        },
    env,
    options.executionContext as unknown as ExecutionContext
  );
  return { response, getStatus, consume, store, digest, cookieName };
}
