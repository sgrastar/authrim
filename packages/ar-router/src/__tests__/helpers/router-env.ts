import { vi } from 'vitest';

export const createMockFetcher = (name: string) => ({
  fetch: vi.fn(async (request: Request) => {
    return new Response(JSON.stringify({ worker: name, path: new URL(request.url).pathname }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
});

export const createMockKV = (data: Record<string, string> = {}) => ({
  get: vi.fn(async (key: string) => data[key] ?? null),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  getWithMetadata: vi.fn(),
});

export const createMockCache = () => {
  const store = new Map<string, Response>();
  return {
    store,
    match: vi.fn(async (request: Request) => store.get(request.url)?.clone()),
    put: vi.fn(async (request: Request, response: Response) => {
      store.set(request.url, response.clone());
    }),
  };
};

export const createMockEnv = () => ({
  OP_DISCOVERY: createMockFetcher('OP_DISCOVERY'),
  OP_VC: createMockFetcher('OP_VC'),
  OP_AUTH: createMockFetcher('OP_AUTH'),
  OP_TOKEN: createMockFetcher('OP_TOKEN'),
  OP_USERINFO: createMockFetcher('OP_USERINFO'),
  OP_MANAGEMENT: createMockFetcher('OP_MANAGEMENT'),
  OP_CONTROL: createMockFetcher('OP_CONTROL'),
  OP_AGENT_ACCESS: createMockFetcher('OP_AGENT_ACCESS'),
  OP_ASYNC: createMockFetcher('OP_ASYNC'),
  OP_SAML: createMockFetcher('OP_SAML'),
  EXTERNAL_IDP: createMockFetcher('EXTERNAL_IDP'),
});

export type MockEnv = ReturnType<typeof createMockEnv> & Record<string, unknown>;

/** Remove / restore the global Cache API so tests control it explicitly. */
export function isolateGlobalCaches(): () => void {
  const original = (globalThis as { caches?: unknown }).caches;
  delete (globalThis as { caches?: unknown }).caches;
  return () => {
    if (original === undefined) delete (globalThis as { caches?: unknown }).caches;
    else (globalThis as { caches?: unknown }).caches = original;
  };
}
