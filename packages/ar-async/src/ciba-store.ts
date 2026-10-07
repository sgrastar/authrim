/**
 * Reading and changing a CIBA request in the CIBARequestStore, with the answers the API gives:
 * a request that does not exist is 404, a store that cannot answer is 503. The two must never be
 * mixed up. The page keeps a request it could not decide when it gets 503, and drops it on 404.
 */

import type { Context } from 'hono';
import type { CIBARequestMetadata, Env } from '@authrim/ar-lib-core';

/** What the store holds for an auth_req_id. */
export type CibaStoreRead =
  | { kind: 'found'; metadata: CIBARequestMetadata }
  /** The store answered that there is no such request (it never existed, or it expired). */
  | { kind: 'missing' }
  /** The store could not answer: a non-2xx status, a thrown error or a body that is not JSON. */
  | { kind: 'unavailable'; error?: unknown };

interface CibaStoreStub {
  fetch(request: Request): Promise<Response>;
}

/** POST /get-by-auth-req-id. The store answers 200 with JSON `null` only for a missing request. */
export async function readCibaRequest(
  store: CibaStoreStub,
  headers: Record<string, string>,
  authReqId: string
): Promise<CibaStoreRead> {
  try {
    const response = await store.fetch(
      new Request('https://internal/get-by-auth-req-id', {
        method: 'POST',
        headers,
        body: JSON.stringify({ auth_req_id: authReqId }),
      })
    );
    if (!response.ok) return { kind: 'unavailable' };
    const body: unknown = await response.json();
    if (body === null) return { kind: 'missing' };
    if (typeof body !== 'object' || Array.isArray(body)) return { kind: 'unavailable' };
    return { kind: 'found', metadata: body as CIBARequestMetadata };
  } catch (error) {
    return { kind: 'unavailable', error };
  }
}

/**
 * POST a decision (/approve, /deny). The store answers 2xx only when it saved the decision. The
 * request was read as pending just before, so any other answer is a store failure; the caller does
 * not know whether it was saved, and says so with 503.
 */
export async function sendCibaDecision(
  store: CibaStoreStub,
  headers: Record<string, string>,
  action: 'approve' | 'deny',
  payload: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; error?: unknown }> {
  try {
    const response = await store.fetch(
      new Request(`https://internal/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })
    );
    return response.ok ? { ok: true } : { ok: false };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 503 for a store that cannot answer. */
export function cibaStoreUnavailable(c: Context<{ Bindings: Env }>, description: string) {
  return c.json({ error: 'temporarily_unavailable', error_description: description }, 503);
}
