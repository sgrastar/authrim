import type { Context } from 'hono';
import { vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

export const TENANT_ID = 'tenant-a';
export const OPERATION_ID = 'account-create-11111111-1111-4111-8111-111111111111';
export const TOKEN = 'T'.repeat(43);

type Fn = ReturnType<typeof vi.fn>;

export interface AccountContextOptions {
  provision?: Fn;
  publishPasskey?: Fn;
  publishDirectory?: Fn;
  status?: Fn;
  store?: Fn;
  getChallenge?: Fn;
  body?: unknown;
  bodyError?: Error;
  tenantId?: string;
  withoutProvisioner?: boolean;
}

/** A minimal Hono context with a challenge store and Account Provisioner stand-in. */
export function accountContext(options: AccountContextOptions = {}) {
  const challenge = {
    storeChallengeRpc: options.store ?? vi.fn().mockResolvedValue({ success: true }),
    getChallengeRpc: options.getChallenge ?? vi.fn().mockResolvedValue(null),
  };
  const provisioner = {
    provisionAuthAccount:
      options.provision ??
      vi.fn().mockResolvedValue({
        status: 202,
        operationId: OPERATION_ID,
        accountId: 'account:user-a',
        userId: 'user-a',
      }),
    getAuthAccountProvisioningStatus:
      options.status ??
      vi.fn().mockResolvedValue({
        status: 'pending',
        operationId: OPERATION_ID,
        accountId: 'account:user-a',
        userId: 'user-a',
      }),
    publishAuthPasskeyRoute: options.publishPasskey ?? vi.fn(),
    publishAuthDirectoryRoute: options.publishDirectory ?? vi.fn(),
  };
  const env = {
    ...(options.withoutProvisioner ? {} : { ACCOUNT_PROVISIONER: provisioner }),
    CHALLENGE_STORE: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => challenge),
    },
  } as unknown as Env;
  const json = options.bodyError
    ? vi.fn().mockRejectedValue(options.bodyError)
    : vi.fn().mockResolvedValue(options.body);
  const c = {
    env,
    req: { json },
    get: vi.fn((key: string) => (key === 'tenantId' ? (options.tenantId ?? TENANT_ID) : undefined)),
    set: vi.fn(),
    json: vi.fn((body: unknown, status = 200) => Response.json(body, { status: status as number })),
  } as unknown as Context<{ Bindings: Env }>;
  return { c, env, challenge, provisioner };
}

export async function sha256HexOf(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function resumeMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    operation_id: OPERATION_ID,
    flow: 'email_code',
    account_id: 'account:user-a',
    user_id: 'user-a',
    ...overrides,
  };
}

/** A stored resume challenge that matches TOKEN for tenant-a. */
export async function resumeChallenge(
  overrides: Record<string, unknown> = {},
  token = TOKEN
): Promise<Record<string, unknown>> {
  const tokenHash = await sha256HexOf(token);
  return {
    id: `account_provisioning:${tokenHash}`,
    tenantId: TENANT_ID,
    type: 'account_provisioning_resume',
    userId: 'user-a',
    challenge: tokenHash,
    metadata: resumeMetadata(),
    consumed: false,
    ...overrides,
  };
}
