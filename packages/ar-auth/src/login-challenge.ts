/**
 * Login Challenge Handler
 * Returns login challenge data including client metadata for login page display
 *
 * This endpoint is used by the UI to fetch client information (logo, policy, ToS)
 * to display on the login page during the OAuth authorization flow.
 *
 * Flow:
 * 1. GET /auth/login-challenge?challenge_id=xxx - Get challenge data
 *
 * OIDC Dynamic OP Conformance:
 * - oidcc-registration-logo-uri: Login page should display client logo
 * - oidcc-registration-policy-uri: Login page should display privacy policy link
 * - oidcc-registration-tos-uri: Login page should display ToS link
 */

import { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  getChallengeStoreByChallengeId,
  getTenantIdFromContext,
  getLogger,
  getWebOriginRegistry,
  isIframeOidcAuthEnabled,
  type WebOriginRegistryDocument,
} from '@authrim/ar-lib-core';

/**
 * Login challenge metadata stored in ChallengeStore
 */
interface LoginChallengeMetadata {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  allowed_redirect_origins?: string[];
  scope?: string;
  state?: string;
  nonce?: string;
  login_hint?: string;
  prompt?: string;
  max_age?: string;
  acr_values?: string;
  claims?: unknown;
  session_mode?: LoginChallengeSessionMode;
  handoff_methods?: LoginChallengeHandoffMethod[];
  iframe_allowed?: boolean;
  tenant_id?: string;
  // Client metadata for login page display
  client_name?: string;
  logo_uri?: string;
  policy_uri?: string;
  tos_uri?: string;
  client_uri?: string;
}

export type LoginChallengeSessionMode =
  | 'managed_browser_session'
  | 'cookie_session'
  | 'token_session';

export type LoginChallengeHandoffMethod = 'cookie_session_finalize' | 'dpop_token_verify';

export interface LoginChallengeWebOrigin {
  origin: string;
  client_ids: string[];
  cors: {
    allowed: boolean;
  };
  csp: {
    frame_ancestors?: string[];
  };
  handoff_allowed: boolean;
  iframe_allowed: boolean;
  environment?: string;
}

/**
 * Login challenge response data
 */
export interface LoginChallengeData {
  challenge_id: string;
  client: {
    client_id: string;
    client_name: string;
    logo_uri?: string;
    client_uri?: string;
    policy_uri?: string;
    tos_uri?: string;
  };
  scope?: string;
  login_hint?: string;
  oidc?: {
    prompt?: string;
    max_age?: number;
    acr_values?: string[];
    nonce_present: boolean;
    claims_present: boolean;
  };
  session_mode: LoginChallengeSessionMode;
  handoff_methods: LoginChallengeHandoffMethod[];
  web_origin_registry: {
    origins: LoginChallengeWebOrigin[];
  };
}

function normalizeSessionMode(value: unknown): LoginChallengeSessionMode {
  if (
    value === 'managed_browser_session' ||
    value === 'cookie_session' ||
    value === 'token_session'
  ) {
    return value;
  }
  return 'managed_browser_session';
}

function normalizeHandoffMethods(
  value: unknown,
  sessionMode: LoginChallengeSessionMode
): LoginChallengeHandoffMethod[] {
  if (Array.isArray(value)) {
    const methods = value.filter(
      (method): method is LoginChallengeHandoffMethod =>
        method === 'cookie_session_finalize' || method === 'dpop_token_verify'
    );
    if (methods.length > 0) {
      return [...new Set(methods)];
    }
  }

  return sessionMode === 'token_session' ? ['dpop_token_verify'] : ['cookie_session_finalize'];
}

function originFromUri(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function normalizeOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function buildFallbackWebOriginRegistry(
  metadata: LoginChallengeMetadata,
  iframeFeatureEnabled: boolean
): WebOriginRegistryDocument {
  const origins = new Set<string>();
  const redirectOrigin = originFromUri(metadata.redirect_uri);
  if (redirectOrigin) {
    origins.add(redirectOrigin);
  }
  for (const origin of metadata.allowed_redirect_origins ?? []) {
    const normalized = normalizeOrigin(origin);
    if (normalized) {
      origins.add(normalized);
    }
  }

  const iframeAllowed = iframeFeatureEnabled && metadata.iframe_allowed === true;
  return {
    origins: [...origins].map((origin) => ({
      origin,
      client_ids: metadata.client_id ? [metadata.client_id] : [],
      cors: { allowed: true },
      csp: iframeAllowed ? { frame_ancestors: [origin] } : {},
      handoff_allowed: true,
      iframe_allowed: iframeAllowed,
    })),
  };
}

function applyIframePolicy(
  registry: WebOriginRegistryDocument,
  iframeFeatureEnabled: boolean
): WebOriginRegistryDocument {
  return {
    origins: registry.origins.map((entry) => {
      const iframeAllowed = iframeFeatureEnabled && entry.iframe_allowed === true;
      return {
        ...entry,
        csp: iframeAllowed ? entry.csp : {},
        iframe_allowed: iframeAllowed,
      };
    }),
  };
}

async function resolveWebOriginRegistry(
  env: Env,
  metadata: LoginChallengeMetadata,
  tenantId: string
): Promise<WebOriginRegistryDocument> {
  const iframeFeatureEnabled = await isIframeOidcAuthEnabled(env, tenantId);

  if (env.DB && metadata.client_id) {
    try {
      const registry = await getWebOriginRegistry(env, tenantId, metadata.client_id);
      if (registry.origins.length > 0) {
        return applyIframePolicy(registry, iframeFeatureEnabled);
      }
    } catch {
      // Fall back to challenge metadata so older deployments continue to render LoginUI.
    }
  }

  return buildFallbackWebOriginRegistry(metadata, iframeFeatureEnabled);
}

function buildOidcMetadata(metadata: LoginChallengeMetadata): LoginChallengeData['oidc'] {
  const maxAge =
    typeof metadata.max_age === 'string' && /^\d+$/u.test(metadata.max_age)
      ? Number(metadata.max_age)
      : undefined;
  const acrValues =
    typeof metadata.acr_values === 'string'
      ? metadata.acr_values.split(/\s+/u).filter(Boolean)
      : undefined;

  if (
    !metadata.prompt &&
    maxAge === undefined &&
    !acrValues?.length &&
    !metadata.nonce &&
    metadata.claims === undefined
  ) {
    return undefined;
  }

  return {
    prompt: metadata.prompt,
    max_age: maxAge,
    acr_values: acrValues?.length ? acrValues : undefined,
    nonce_present: Boolean(metadata.nonce),
    claims_present: metadata.claims !== undefined,
  };
}

/**
 * Get login challenge data
 * GET /auth/login-challenge?challenge_id=xxx
 *
 * Returns client metadata for login page display
 */
export async function loginChallengeGetHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('LOGIN-CHALLENGE');

  try {
    const challenge_id = c.req.query('challenge_id');

    if (!challenge_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Missing challenge_id parameter',
        },
        400
      );
    }

    // Retrieve login challenge from ChallengeStore (RPC)
    // Use challengeId-based sharding
    const requestTenantId = getTenantIdFromContext(c);
    const challengeStore = await getChallengeStoreByChallengeId(
      c.env,
      challenge_id,
      requestTenantId
    );

    const challengeData = await challengeStore.getChallengeRpc(challenge_id);

    if (!challengeData) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid or expired challenge',
        },
        400
      );
    }

    const typedChallengeData = challengeData as {
      id: string;
      type: string;
      userId: string;
      metadata?: LoginChallengeMetadata;
    };

    // LoginUI reuses this read-only metadata endpoint for authentication and consent prompts.
    if (
      typedChallengeData.type !== 'login' &&
      typedChallengeData.type !== 'reauth' &&
      typedChallengeData.type !== 'consent'
    ) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid challenge type',
        },
        400
      );
    }

    const metadata: LoginChallengeMetadata = typedChallengeData.metadata || {};

    if (metadata.tenant_id && metadata.tenant_id !== requestTenantId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Challenge tenant does not match request tenant',
        },
        400
      );
    }

    // Type guard: ensure client_id exists
    if (!metadata.client_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Challenge is missing client_id',
        },
        400
      );
    }

    // Build response with client info from challenge metadata
    // After the type guard above, client_id is guaranteed to be a string
    const sessionMode = normalizeSessionMode(metadata.session_mode);
    const responseData: LoginChallengeData = {
      challenge_id,
      client: {
        client_id: metadata.client_id,
        client_name: metadata.client_name || metadata.client_id,
        logo_uri: metadata.logo_uri,
        client_uri: metadata.client_uri,
        policy_uri: metadata.policy_uri,
        tos_uri: metadata.tos_uri,
      },
      scope: metadata.scope,
      login_hint: metadata.login_hint,
      oidc: buildOidcMetadata(metadata),
      session_mode: sessionMode,
      handoff_methods: normalizeHandoffMethods(metadata.handoff_methods, sessionMode),
      web_origin_registry: await resolveWebOriginRegistry(c.env, metadata, requestTenantId),
    };

    return c.json(responseData);
  } catch (error) {
    log.error('Login challenge get error', { action: 'get_challenge' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve login challenge data',
      },
      500
    );
  }
}
