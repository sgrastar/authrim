/**
 * Stopping a sign-in of the Login UI runtime and going back to the app
 * (`POST /api/v1/login/interactions/:id/cancel`, see login-runtime-flow.ts).
 *
 * Offered only where the sign-in Flow says so (`on_cancel: error`) and the interaction was
 * started for an app's request: an OIDC authorization request (the app is sent `access_denied`,
 * as when consent is denied) or a SAML request (the person is handed to the IdP, which answers
 * the SP: ar-lib-core `saml-login-cancel.ts`).
 */
import type { Context } from 'hono';
import {
  buildSAMLLoginCancelPath,
  createSAMLLoginCancelGrant,
  getChallengeStoreByChallengeId,
  getLogger,
  isSAMLAuthorizationChallenge,
  resolveProtocolSettings,
  signInOptionsOfRuntime,
  type Env,
} from '@authrim/ar-lib-core';
import { answerFormPostAsData, formPostAnsweredAsData, redirectWithError } from './authorize';
import type { FAPI2MessageSigningConfig } from './fapi-message-signing';

type AuthContext = Context<{ Bindings: Env }>;

/** The app request an interaction was started for, as far as cancelling reads it. */
export interface CancelTarget {
  protocol: string;
  authorizationChallengeId: string | null;
  samlRequestId: string | null;
  clientId: string | null;
  samlSpId: string | null;
  /** The hash of the login nonce the interaction was started with (SAML). */
  samlLoginNonceHash?: string | null;
  /** The runtime imports SAML requests through ports, which cannot cancel (see saml login-cancel). */
  samlRequestPorts?: boolean;
}

/** What kind of app request a cancel would answer; null when the interaction has none. */
export function cancelAppKind(target: CancelTarget): 'saml' | 'oidc' | null {
  if (
    target.protocol === 'saml' &&
    target.samlRequestId &&
    target.samlSpId &&
    // Only the browser the IdP sent to sign in can cancel the request: the interaction was
    // started with the login nonce (an interaction started from a request id alone has none).
    target.samlLoginNonceHash &&
    !target.samlRequestPorts
  ) {
    return 'saml';
  }
  if (
    target.protocol === 'oidc' &&
    !target.samlRequestId &&
    target.authorizationChallengeId &&
    target.clientId
  ) {
    return 'oidc';
  }
  return null;
}

/** Whether a cancel is accepted for a live interaction of this runtime (what the UI is told). */
export function runtimeCancelAvailable(input: {
  /** The Flow's runtime contract (its `flow_kind` and sign-in step). */
  runtime: unknown;
  state: string;
  target: CancelTarget;
}): boolean {
  const flowKind =
    input.runtime && typeof input.runtime === 'object'
      ? (input.runtime as { flow_kind?: unknown }).flow_kind
      : undefined;
  return (
    (input.state === 'created' || input.state === 'active') &&
    flowKind === 'login' &&
    signInOptionsOfRuntime(input.runtime).onCancel === 'error' &&
    cancelAppKind(input.target) !== null
  );
}

/** The part of the challenge store a cancel uses. */
interface ChallengeStoreStub {
  getChallengeRpc(id: string): Promise<unknown>;
  consumeChallengeRpc(input: {
    id: string;
    tenantId: string;
    type: string;
    challenge: string;
    operationId?: string;
  }): Promise<unknown>;
}

async function challengeStoreOf(
  env: Env,
  tenantId: string,
  challengeId: string
): Promise<ChallengeStoreStub> {
  return (await getChallengeStoreByChallengeId(env, challengeId, tenantId)) as ChallengeStoreStub;
}

interface StoredLoginChallenge {
  tenantId?: string;
  type?: string;
  consumed?: boolean;
  consumedBy?: string;
  metadata?: Record<string, unknown>;
}

/** The OIDC authorization request a cancel answers, read without using it up. */
export interface PeekedOidcRequest {
  challengeId: string;
  type: 'login' | 'reauth';
  metadata: Record<string, unknown>;
}

/**
 * Reads the authorization challenge of the interaction. `gone` when it is not there (used,
 * expired), not this tenant's or client's, or not an OIDC request's; `unavailable` when the store
 * cannot be read (nothing is changed, the cancel can be tried again).
 */
export async function peekOidcRequest(
  env: Env,
  tenantId: string,
  challengeId: string,
  clientId: string
): Promise<PeekedOidcRequest | 'gone' | 'unavailable'> {
  let stored: StoredLoginChallenge | null;
  try {
    const store = await challengeStoreOf(env, tenantId, challengeId);
    stored = (await store.getChallengeRpc(challengeId)) as StoredLoginChallenge | null;
  } catch {
    return 'unavailable';
  }
  const metadata = stored?.metadata;
  if (
    !stored ||
    stored.tenantId !== tenantId ||
    stored.consumed === true ||
    (stored.type !== 'login' && stored.type !== 'reauth') ||
    !metadata ||
    isSAMLAuthorizationChallenge(metadata) ||
    metadata.client_id !== clientId ||
    typeof metadata.redirect_uri !== 'string' ||
    !metadata.redirect_uri
  ) {
    return 'gone';
  }
  return { challengeId, type: stored.type, metadata };
}

/** How closing the authorization request of a cancelled sign-in went. */
export type CloseOidcResult =
  /** This cancel used it up: the app may be answered. */
  | 'closed'
  /**
   * Not by this cancel: it was used by another sign-in of the same request (or the store cannot
   * tell that from an expired one), so the cancel must not claim access_denied.
   */
  | 'elsewhere'
  /** The store did not answer, or the request is still there: retryable. */
  | 'unavailable';

/**
 * Uses the authorization request up for this cancel. Only this cancel's own consume (recognised
 * by its operation id on the consumed record, on the first try or a repeat) closes it: a
 * request found already consumed (another interaction continued it) or gone (expired, or not
 * told from consumed) is `elsewhere`, never closed. `types`: the kinds of challenge it may be (a
 * repeat does not know which).
 */
export async function useUpOidcRequest(
  env: Env,
  tenantId: string,
  challengeId: string,
  types: readonly ('login' | 'reauth')[],
  /** This cancel's own operation id: it is kept on the consumed record, to be recognised later. */
  operationId: string
): Promise<CloseOidcResult> {
  let store: ChallengeStoreStub;
  try {
    store = await challengeStoreOf(env, tenantId, challengeId);
  } catch {
    return 'unavailable';
  }
  for (const type of types) {
    try {
      await store.consumeChallengeRpc({
        id: challengeId,
        tenantId,
        type,
        challenge: challengeId,
        operationId,
      });
      return 'closed';
    } catch {
      // Not of this type, used, gone or the store is down: told apart below.
    }
  }
  try {
    const stored = (await store.getChallengeRpc(challengeId)) as StoredLoginChallenge | null;
    // Consumed by this cancel's own operation (the answer or the record of it was lost): closed.
    // By another operation, or gone (expired, or cleaned up after a consume: not told apart, a
    // known limit), the sign-in went on elsewhere.
    if (stored?.consumed === true && stored.consumedBy === operationId) return 'closed';
    if (stored === null || stored === undefined || stored.consumed === true) return 'elsewhere';
    // Still there and not used: the consume was refused for another reason; try again later.
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * What the Login UI is answered for the app's request: the same JSON as a denied consent
 * (`{ redirect_url }`, or `{ form_post: { action, fields } }` for a caller that sends a form
 * itself and asked for it with `X-Authrim-Relay: structured`), carrying `access_denied`, the
 * request's `state` and `iss`; to `cancel_uri` when the request had one, else its redirect_uri.
 * A JWT-secured response mode (JARM) is answered signed.
 */
export async function oidcCancelAnswer(
  c: AuthContext,
  tenantId: string,
  metadata: Record<string, unknown>
): Promise<Response> {
  if (c.req.header('X-Authrim-Relay') === 'structured') answerFormPostAsData(c);
  const log = getLogger(c).module('LOGIN-RUNTIME-FLOW');
  const redirectUri = metadata.redirect_uri as string;
  const state = typeof metadata.state === 'string' && metadata.state ? metadata.state : undefined;
  const cancelUri =
    typeof metadata.cancel_uri === 'string' && metadata.cancel_uri
      ? metadata.cancel_uri
      : undefined;
  const responseType =
    typeof metadata.response_type === 'string' ? metadata.response_type : undefined;
  const responseMode =
    typeof metadata.response_mode === 'string' && metadata.response_mode
      ? metadata.response_mode
      : undefined;
  const clientId = typeof metadata.client_id === 'string' ? metadata.client_id : undefined;
  const description = 'The user cancelled the sign-in';

  const isJarm =
    responseMode === 'jwt' || (responseMode !== undefined && responseMode.endsWith('.jwt'));
  if (isJarm) {
    if (!clientId) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Unable to create JWT-secured authorization error response',
        },
        500
      );
    }
    let messageSigning: FAPI2MessageSigningConfig | undefined;
    try {
      const settings = await resolveProtocolSettings(c.env, tenantId, {
        clientId,
        sections: ['fapi'],
      });
      messageSigning = settings.fapi.messageSigning;
    } catch (error) {
      log.error(
        'Failed to load JARM settings for a cancelled sign-in',
        { action: 'settings_load' },
        error as Error
      );
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'Security profile settings are temporarily unavailable',
        },
        503
      );
    }
    const response = await redirectWithError(c, redirectUri, 'access_denied', description, state, {
      responseMode,
      responseType,
      clientId,
      messageSigning,
      cancelUri,
      isUserCancellation: true,
    });
    const location = response.headers.get('Location');
    return location ? c.json({ redirect_url: location }) : response;
  }

  if (responseMode === 'form_post' && formPostAnsweredAsData(c)) {
    return await redirectWithError(c, redirectUri, 'access_denied', description, state, {
      responseMode,
      cancelUri,
      isUserCancellation: true,
    });
  }

  // Query or fragment (the request's own mode); a form post the caller cannot send is a redirect
  // with the response type's default encoding, as for a denied consent.
  const redirectMode =
    responseMode === 'query' || responseMode === 'fragment' ? responseMode : undefined;
  const response = await redirectWithError(c, redirectUri, 'access_denied', description, state, {
    ...(redirectMode ? { responseMode: redirectMode } : {}),
    responseType,
    cancelUri,
    isUserCancellation: true,
  });
  const location = response.headers.get('Location');
  if (!location) {
    return c.json(
      { error: 'server_error', error_description: 'Unable to build the error response' },
      500
    );
  }
  return c.json({ redirect_url: location });
}

/** The one-time grant for a SAML request's cancel, and the path that answers the SP with it. */
export async function samlCancelGrant(interactionId: string): Promise<{
  context: { token_hash: string; created_at_ms: number };
  redirectPath: string;
}> {
  const grant = await createSAMLLoginCancelGrant();
  return {
    context: grant.context,
    redirectPath: buildSAMLLoginCancelPath({ interactionId, token: grant.token }),
  };
}
