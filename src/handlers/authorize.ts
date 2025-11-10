import type { Context } from 'hono';
import type { Env } from '../types/env';

/**
 * Authorization Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#AuthorizationEndpoint
 *
 * Handles authorization requests and returns authorization codes
 * Implementation planned for Week 7
 */
export async function authorizeHandler(c: Context<{ Bindings: Env }>) {
  // TODO: Week 7 - Implement authorization logic
  // 1. Parse and validate request parameters (response_type, client_id, redirect_uri, scope, state, nonce)
  // 2. Generate authorization code
  // 3. Store code in KV with metadata
  // 4. Redirect to redirect_uri with code and state

  return c.json(
    {
      error: 'not_implemented',
      error_description: 'Authorization endpoint will be implemented in Week 7',
    },
    501
  );
}
