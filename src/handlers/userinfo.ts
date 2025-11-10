import type { Context } from 'hono';
import type { Env } from '../types/env';

/**
 * UserInfo Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#UserInfo
 *
 * Returns claims about the authenticated user
 * Implementation planned for Week 9
 */
export async function userinfoHandler(c: Context<{ Bindings: Env }>) {
  // TODO: Week 9 - Implement userinfo logic
  // 1. Parse Authorization header (Bearer token)
  // 2. Verify access token signature and expiration
  // 3. Extract subject (sub) from token
  // 4. Return user claims based on scope
  //    - openid: sub
  //    - profile: name, etc.
  //    - email: email, email_verified

  return c.json(
    {
      error: 'not_implemented',
      error_description: 'UserInfo endpoint will be implemented in Week 9',
    },
    501
  );
}
