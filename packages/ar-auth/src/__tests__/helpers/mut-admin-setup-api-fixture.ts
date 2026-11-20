/**
 * Doubles for admin-setup-api.ts (mut-admin-* tests). Free of '@authrim/ar-lib-core' imports so it
 * can be loaded from vi.hoisted.
 */
import { vi } from 'vitest';
import type { WebAuthnArgs } from './mut-admin-enrollment-fixture';

export function createSetupApiFixture() {
  const adapter = {
    queryOne: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown> => null),
    execute: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rowsAffected: 1 })),
  };
  const users = {
    findById: vi.fn(async (_id: string): Promise<Record<string, unknown> | null> => null),
  };
  const passkeys = {
    createPasskey: vi.fn(async (_input: Record<string, unknown>) => ({})),
    getPasskeysByUser: vi.fn(async (_id: string): Promise<unknown[]> => []),
    findByCredentialId: vi.fn(async (_id: string): Promise<Record<string, unknown> | null> => null),
    updateCounter: vi.fn(async (_id: string, _counter: number) => {}),
  };
  const sessions = {
    createSession: vi.fn(async (_input: Record<string, unknown>) => ({})),
    tenantIds: [] as string[],
  };
  type WebAuthnFn = (options: WebAuthnArgs) => Promise<unknown>;
  const webauthn = {
    generateRegistrationOptions: vi.fn<WebAuthnFn>(),
    verifyRegistrationResponse: vi.fn<WebAuthnFn>(),
    generateAuthenticationOptions: vi.fn<WebAuthnFn>(),
    verifyAuthenticationResponse: vi.fn<WebAuthnFn>(),
  };
  const audit = vi.fn();
  const requireAdapter = vi.fn((_env: unknown, _name: string) => adapter);

  function createKv(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      values,
      get: vi.fn(async (key: string): Promise<string | null> => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string, _opts?: unknown) => {
        values.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    };
  }

  return { adapter, users, passkeys, sessions, webauthn, audit, requireAdapter, createKv };
}

export type SetupApiKv = ReturnType<ReturnType<typeof createSetupApiFixture>['createKv']>;
