/**
 * An in-memory stand-in for the SAMLRequestStore Durable Object namespace, serving the four
 * `/authn/*` endpoints the SAML IdP uses with the same rules as the real one
 * (ar-lib-core's SAMLRequestStore): a request is created once (a known id is refused, even after
 * it was answered), and only a waiting request of that SP can be read, updated or completed;
 * update and complete at a revision only when it matches, and a complete with a login nonce hash
 * only when the stored context holds that hash.
 *
 * `waiting` holds the requests that are waiting, so a test can assert "nothing is waiting" by its
 * size; an answered request leaves it and is remembered in `known`, so it cannot be created again.
 */
import type { SAMLRequestContext, SAMLRequestData } from '@authrim/ar-lib-core';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export interface SamlRequestStoreFake {
  /** Requests that are waiting (not completed), by id. */
  waiting: Map<string, SAMLRequestData>;
  /** Every id ever created, waiting or completed. */
  known: Set<string>;
  /** The namespace stub's fetch. */
  fetch: (url?: string, init?: { body?: string }) => Promise<Response>;
  /** Put a request into the store as if it had been created (revision 1 unless it has one). */
  seed: (request: Partial<SAMLRequestData> & { requestId: string }) => SAMLRequestData;
  /** The endpoints called, in order (`create`, `read`, `update`, `complete`). */
  calls: string[];
  reset: () => void;
}

export function createSamlRequestStoreFake(): SamlRequestStoreFake {
  const waiting = new Map<string, SAMLRequestData>();
  const known = new Set<string>();
  const calls: string[] = [];

  const waitingOf = (requestId: string, spEntityId: string): SAMLRequestData | null => {
    const request = waiting.get(requestId);
    if (!request || request.type !== 'authn_request' || request.issuer !== spEntityId) return null;
    return request;
  };

  const fake: SamlRequestStoreFake = {
    waiting,
    known,
    calls,
    async fetch(url = '', init) {
      const operation = new URL(url).pathname.replace(/^\/authn\//u, '');
      calls.push(operation);
      const body = JSON.parse(init?.body ?? '{}') as {
        spEntityId: string;
        requestId?: string;
        request?: SAMLRequestData;
        expectedRevision?: number;
        context?: SAMLRequestContext;
        loginNonceHash?: string;
      };
      if (operation === 'create') {
        const request = body.request as SAMLRequestData;
        if (known.has(request.requestId)) return json({ created: false }, 409);
        known.add(request.requestId);
        waiting.set(request.requestId, structuredClone({ ...request, used: false, revision: 1 }));
        return json({ created: true }, 201);
      }
      const request = waitingOf(body.requestId ?? '', body.spEntityId);
      if (operation === 'read') {
        return request ? json(request, 200) : json({ error: 'not_waiting' }, 404);
      }
      if (operation === 'update') {
        if (!request || request.revision !== body.expectedRevision) {
          return json({ error: 'not_waiting' }, 409);
        }
        request.context = body.context;
        request.revision = (body.expectedRevision as number) + 1;
        return json(request, 200);
      }
      if (operation === 'complete') {
        const held = request?.context?.loginNonceHash;
        if (
          !request ||
          (body.expectedRevision !== undefined && request.revision !== body.expectedRevision) ||
          (body.loginNonceHash !== undefined && (!held || held !== body.loginNonceHash))
        ) {
          return json({ error: 'not_waiting' }, 409);
        }
        waiting.delete(request.requestId);
        return json({ ...request, used: true }, 200);
      }
      return json({ error: 'unknown_operation' }, 404);
    },
    seed(partial) {
      const request = {
        type: 'authn_request',
        issuer: 'https://sp.example.test/entity',
        used: false,
        revision: 1,
        ...partial,
      } as SAMLRequestData;
      waiting.set(request.requestId, request);
      known.add(request.requestId);
      return request;
    },
    reset() {
      waiting.clear();
      known.clear();
      calls.length = 0;
    },
  };
  return fake;
}
