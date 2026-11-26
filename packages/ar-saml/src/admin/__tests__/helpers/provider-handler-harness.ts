/**
 * Request context and database adapter doubles for exercising the SAML provider admin handlers.
 * The module mocks themselves live in each test file (vi.mock is hoisted per file).
 */

import { vi } from 'vitest';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';

export function createAdapter() {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1, insertId: undefined }),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(),
  };
}

export interface HarnessContextOptions {
  body?: unknown;
  id?: string;
  params?: Record<string, string>;
  permissions?: string[] | null;
  tenantId?: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  env?: Record<string, unknown>;
  query?: Record<string, string | string[]>;
  executionPromises?: Array<Promise<unknown>>;
  /** Receives the headers a handler sets through c.header(). */
  responseHeaders?: Record<string, string>;
}

/** A minimal Hono-like context; the handler type is supplied by the caller through `as never`. */
export function harnessContext(options: HarnessContextOptions = {}): never {
  const tenantId = options.tenantId ?? 'tenant-a';
  const settings = options.settings;
  const headers = Object.fromEntries(
    Object.entries({
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    }).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    env: {
      ...(settings
        ? {
            SETTINGS: {
              get: vi.fn(async (key: string) =>
                key in settings ? JSON.stringify(settings[key]) : null
              ),
            },
          }
        : {}),
      ...(options.env ?? {}),
    },
    req: {
      raw: undefined,
      json: vi.fn(async () => options.body),
      param: vi.fn((name: string) => (name === 'id' ? options.id : options.params?.[name])),
      header: vi.fn((name: string) => headers[name.toLowerCase()]),
      query: vi.fn((name: string) => {
        const value = options.query?.[name];
        return Array.isArray(value) ? value[0] : value;
      }),
      queries: vi.fn((name: string) => {
        const value = options.query?.[name];
        return value === undefined ? undefined : Array.isArray(value) ? value : [value];
      }),
    },
    header: vi.fn((name: string, value: string) => {
      if (options.responseHeaders) options.responseHeaders[name] = value;
    }),
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => {
        options.executionPromises?.push(promise);
      },
    },
    get: vi.fn((name: string) => {
      if (name === 'tenantId') return tenantId;
      if (name === 'adminAuth') {
        return options.permissions === null
          ? undefined
          : { permissions: options.permissions ?? Object.values(ADMIN_PERMISSIONS) };
      }
      return undefined;
    }),
    json: vi.fn(
      (body: unknown, status: number = 200, responseHeaders: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json', ...responseHeaders },
        })
    ),
  } as never;
}

export async function bodyOf<T>(response: Response): Promise<T> {
  return await response.json<T>();
}

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/** Reads a nested property (object key or array index) from untyped JSON. */
export function dig(value: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

export function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'provider-a',
    name: 'Provider A',
    provider_type: 'saml_sp',
    config_json: JSON.stringify({
      entityId: 'https://sp.example.test',
      acsUrl: 'https://sp.example.test/acs',
      allowedBindings: ['post'],
    }),
    enabled: 1,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_001_000,
    ...overrides,
  };
}
