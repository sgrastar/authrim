/**
 * Shared request/context builders for the mut-session-par-* tests (PAR endpoint).
 * The module mocks themselves live in each test file (vi.mock is hoisted per file).
 */
import { vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { systemSettingsPlatformDocuments } from '@authrim/ar-lib-core/utils/system-settings-fields';

export const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
export const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const CALLBACK = 'https://client.example.com/callback';

export const baseBody = {
  client_id: 'client-123',
  response_type: 'code',
  redirect_uri: CALLBACK,
  scope: 'openid profile',
};

/** A SETTINGS binding holding an older `system_settings` document's values as platform values. */
export function platformSettings(
  document: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): KVNamespace {
  const documents = systemSettingsPlatformDocuments(document);
  return {
    get: vi.fn(async (key: string) => {
      if (key in extra) return JSON.stringify(extra[key]);
      return key in documents ? JSON.stringify(documents[key]) : null;
    }),
  } as unknown as KVNamespace;
}

export function createParContext(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  env?: Partial<Env>;
}) {
  const headers = Object.fromEntries(
    Object.entries({ ...FORM, ...(options.headers ?? {}) }).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ])
  );

  const env = {
    ISSUER_URL: 'https://op.example.com',
    SETTINGS: { get: vi.fn().mockResolvedValue(null) } as unknown as KVNamespace,
    PAR_REQUEST_STORE: {} as Env['PAR_REQUEST_STORE'],
    DPOP_JTI_STORE: {} as DurableObjectNamespace,
    ...options.env,
  } as Env;

  return {
    req: {
      method: options.method ?? 'POST',
      header: (name: string) => headers[name.toLowerCase()],
      parseBody: vi.fn().mockResolvedValue({ ...(options.body ?? baseBody) }),
    },
    env,
    json: vi.fn(
      (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
    get: vi.fn((key: string) => (key === 'tenantId' ? 'default' : undefined)),
  };
}

export function basicHeader(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}
