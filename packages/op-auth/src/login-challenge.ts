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
import type { Env } from '@authrim/shared';

/**
 * Login challenge metadata stored in ChallengeStore
 */
interface LoginChallengeMetadata {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  nonce?: string;
  login_hint?: string;
  // Client metadata for login page display
  client_name?: string;
  logo_uri?: string;
  policy_uri?: string;
  tos_uri?: string;
  client_uri?: string;
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
}

/**
 * Get login challenge data
 * GET /auth/login-challenge?challenge_id=xxx
 *
 * Returns client metadata for login page display
 */
export async function loginChallengeGetHandler(c: Context<{ Bindings: Env }>) {
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

    // Retrieve login challenge from ChallengeStore
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

    const challengeResponse = await challengeStore.fetch(
      new Request(`https://challenge-store/challenge/${challenge_id}`, {
        method: 'GET',
      })
    );

    if (!challengeResponse.ok) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid or expired challenge',
        },
        400
      );
    }

    const challengeData = (await challengeResponse.json()) as {
      id: string;
      type: string;
      userId: string;
      metadata?: LoginChallengeMetadata;
    };

    // Only allow 'login' type challenges
    if (challengeData.type !== 'login') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid challenge type',
        },
        400
      );
    }

    const metadata: LoginChallengeMetadata = challengeData.metadata || {};

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
    };

    return c.json(responseData);
  } catch (error) {
    console.error('Login challenge get error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve login challenge data',
      },
      500
    );
  }
}
