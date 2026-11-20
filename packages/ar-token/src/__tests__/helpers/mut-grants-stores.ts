/**
 * Stand-ins for the device code and CIBA request stores the mut-grants-* tests poll, readers of
 * the internal requests made to them, and the account rows and settings the tests start from.
 */
import { vi, type Mock } from 'vitest';

type StoreFetch = Mock<(request: Request) => Promise<Response>>;

/** The paths an internal Durable Object fetch mock was called with, in order. */
export function fetchedPaths(fetch: StoreFetch): string[] {
  return fetch.mock.calls.map(([request]) => new URL(request.url).pathname);
}

/** The JSON bodies and headers an internal fetch mock was sent for one path. */
export async function fetchedRequests(fetch: StoreFetch, path: string) {
  const requests = fetch.mock.calls
    .map(([request]) => request)
    .filter((request) => new URL(request.url).pathname === path);
  return Promise.all(
    requests.map(async (request) => ({
      method: request.method,
      contentType: request.headers.get('Content-Type'),
      tenant: request.headers.get('X-Authrim-Tenant-Id'),
      body: await request.clone().json<Record<string, unknown>>(),
    }))
  );
}

/**
 * An in-memory device code or CIBA request store answering `/poll` like the real one (ownership
 * first) and acknowledging `/mark-token-issued` and `/delete`.
 */
export function pollingStore(
  idKey: 'device_code' | 'auth_req_id',
  metadata: Record<string, unknown>,
  options: {
    tooFast?: boolean;
    markStatus?: number;
    poll?: () => Response | Promise<Response>;
  } = {}
) {
  return vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === '/poll') {
      if (options.poll) return options.poll();
      const { client_id } = await request.clone().json<{ client_id: string }>();
      if (!metadata[idKey]) return Response.json({ result: 'not_found' });
      if (metadata.client_id !== client_id) return Response.json({ result: 'client_mismatch' });
      return Response.json({ result: 'ok', too_fast: options.tooFast === true, metadata });
    }
    if (path === '/mark-token-issued') {
      const status = options.markStatus ?? 200;
      return Response.json({ success: status === 200 }, { status });
    }
    return Response.json({ success: true });
  });
}

/** Settings that make the tenant enforce FAL3 with a pushed, signed request. */
export const FAL3_SETTINGS = {
  'assurance.enabled': true,
  'assurance.default_fal': 'FAL3',
  'assurance.fal3_requires_par': true,
  'assurance.fal2_requires_dpop': false,
};

/** A canonical runtime account row for a user. */
export function canonicalAccount(userId: string) {
  return {
    id: `account-${userId}`,
    tenant_id: 'default',
    subject_id: `subject-${userId}`,
    legacy_user_id: userId,
    account_type: 'end_user',
    lifecycle_state: 'active',
    display_label: null,
    metadata_json: '{}',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/** A canonical runtime user projection row for a user. */
export function canonicalProjection(userId: string) {
  return {
    ...canonicalAccount(userId),
    id: userId,
    account_id: `account-${userId}`,
    email: 'user@example.com',
    email_verified: 1,
    name: 'Test User',
    active: 1,
    custom_attributes_json: null,
  };
}
