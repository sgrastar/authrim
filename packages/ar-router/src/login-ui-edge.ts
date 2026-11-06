/**
 * The Router → Login UI trust boundary.
 *
 * The Router rewrites a proxied request's Origin and Referer to the Login UI's own origin (so
 * SvelteKit's CSRF check accepts it), which leaves the Login UI unable to see what the browser
 * sent. When the Login UI's edge entrypoint is bound (`LOGIN_UI_EDGE`, entrypoint
 * `LoginUiEdgeEntrypoint`), the Router checks the original request here, at its public edge, and
 * passes the result as RPC arguments: never as a header a visitor could also send.
 */

/** The internal header the Login UI's edge entrypoint sets; never forwarded from a visitor. */
export const LOGIN_UI_EDGE_CONTEXT_HEADER = 'x-authrim-edge-context';

export interface LoginUiEdgeContext {
  /**
   * For an unsafe method: whether the browser's Origin was the origin the browser used for this
   * request (a request without Origin is not: SvelteKit refuses such a form POST anyway). Null for
   * a safe method.
   */
  originVerified: boolean | null;
  /** The visitor's IP at the Router's edge (`CF-Connecting-IP`). */
  clientIp: string | null;
  /** The origin the browser used. */
  publicOrigin: string;
}

/** The Login UI's `LoginUiEdgeEntrypoint`, bound with `entrypoint = "LoginUiEdgeEntrypoint"`. */
export interface LoginUiEdgeBinding {
  /** Answers `ok`: whether the deployed Login UI has this entrypoint yet. */
  ping(): Promise<string>;
  handle(request: Request, context: LoginUiEdgeContext): Promise<Response>;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The origin of an Origin or Referer value; null for `null`, a malformed or a non-HTTP one. */
export function headerOrigin(value: string | null): string | null {
  if (!value || value === 'null') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Whether a state-changing request came from a page on the origin it was sent to. */
export function requestOriginVerified(request: Request): boolean | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  return headerOrigin(request.headers.get('origin')) === new URL(request.url).origin;
}

export function buildLoginUiEdgeContext(request: Request): LoginUiEdgeContext {
  return {
    originVerified: requestOriginVerified(request),
    clientIp: request.headers.get('cf-connecting-ip'),
    publicOrigin: new URL(request.url).origin,
  };
}

/**
 * Whether the bound Login UI has the edge entrypoint. The Router can be deployed before the Login
 * UI that adds it (an update deploys the Router first), and an RPC to a missing entrypoint fails
 * every request. Until the entrypoint answers, Login UI requests go through the plain service
 * binding, which is equivalent for the Origin (the Router rewrites only a same-origin Origin, so
 * the UI's own check of it gives the same answer); the Login UI's lite pages need the edge
 * context's public origin and fail closed without it. Asked once per isolate: a present
 * entrypoint is remembered for EDGE_PRESENT_TTL_MS, a missing one for EDGE_MISSING_TTL_MS.
 */
const EDGE_PRESENT_TTL_MS = 10 * 60_000;
const EDGE_MISSING_TTL_MS = 30_000;
/** A ping that does not answer in time counts as missing (and is not waited on again). */
export const EDGE_PING_TIMEOUT_MS = 1_000;
// Only answers are kept, never a pending ping: a promise started by one request is not awaited by
// another (if that request is cancelled, its I/O may never settle). Concurrent requests before the
// first answer each ask; that happens once per isolate and TTL.
const edgeProbes = new WeakMap<LoginUiEdgeBinding, { present: boolean; checkedAt: number }>();

async function pingWithin(edge: LoginUiEdgeBinding, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      edge.ping().then(
        (answer) => answer === 'ok',
        () => false
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function loginUiEdgeAvailable(edge: LoginUiEdgeBinding): Promise<boolean> {
  const probe = edgeProbes.get(edge);
  if (probe) {
    const ttl = probe.present ? EDGE_PRESENT_TTL_MS : EDGE_MISSING_TTL_MS;
    if (Date.now() - probe.checkedAt < ttl) return probe.present;
  }
  const present = await pingWithin(edge, EDGE_PING_TIMEOUT_MS);
  edgeProbes.set(edge, { present, checkedAt: Date.now() });
  return present;
}

/**
 * Forgets that the entrypoint answered: an RPC to it failed (the Login UI may have been rolled
 * back to a version without it). The next request asks again.
 */
export function forgetLoginUiEdge(edge: LoginUiEdgeBinding): void {
  edgeProbes.delete(edge);
}
