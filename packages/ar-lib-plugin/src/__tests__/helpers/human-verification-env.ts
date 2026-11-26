import { vi } from 'vitest';
import type { HumanVerificationOptions } from '../../builtin/security';

/** Fixtures for the human verification runtime: a KV settings store and a stubbed siteverify. */

export const TURNSTILE = 'human-verification-cloudflare-turnstile';
export const HCAPTCHA = 'human-verification-hcaptcha';
export const RECAPTCHA = 'human-verification-google-recaptcha';

export type HumanVerificationEnv = HumanVerificationOptions['env'];
export type FetchMock = ReturnType<typeof vi.fn>;

export function kv(data: Record<string, string>): KVNamespace & { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async (key: string) => data[key] ?? null),
  } as unknown as KVNamespace & { get: ReturnType<typeof vi.fn> };
}

export interface EnvSpec {
  /** Authentication-methods settings (merged over the login switch). */
  settings?: Record<string, unknown>;
  plugin?: string;
  config?: Record<string, unknown>;
  globalConfig?: Record<string, unknown>;
  /** Extra raw KV entries. */
  extra?: Record<string, string>;
  pluginEnvironment?: Record<string, unknown>;
}

export function humanVerificationEnv(spec: EnvSpec = {}): HumanVerificationEnv {
  const plugin = spec.plugin ?? TURNSTILE;
  return {
    SETTINGS: kv({
      'settings:tenant:t1:authentication-methods': JSON.stringify({
        'authentication-methods.human_verification.provider': plugin,
        'authentication-methods.human_verification.login_enabled': true,
        ...spec.settings,
      }),
      [`plugins:config:${plugin}:tenant:t1`]: JSON.stringify({
        siteKey: 'site',
        secretKey: 'secret',
        ...spec.config,
      }),
      ...(spec.globalConfig
        ? { [`plugins:config:${plugin}`]: JSON.stringify(spec.globalConfig) }
        : {}),
      ...spec.extra,
    }),
    ...spec.pluginEnvironment,
  };
}

/** Stubs fetch with one siteverify answer and returns the mock. */
export function stubSiteverify(body: unknown, init: ResponseInit = {}): FetchMock {
  const fetchMock = vi.fn(async () => Response.json(body, init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The request init of the first fetch call. */
export function firstRequest(fetchMock: FetchMock): RequestInit {
  return (fetchMock.mock.calls[0] as [string, RequestInit])[1];
}

/** The JSON body of the first fetch call. */
export function firstJsonBody<T = Record<string, unknown>>(fetchMock: FetchMock): T {
  return JSON.parse(String(firstRequest(fetchMock).body)) as T;
}
