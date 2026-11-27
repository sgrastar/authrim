/**
 * The answer to a Check API request that did not authenticate, shared by `/api/check`,
 * `/api/check/batch`, `/api/check/subscribe` and its stats:
 *
 * - a valid token the API refuses for what it is (`non_account_subject`,
 *   `elevated_token_not_allowed`): 401 `invalid_token` with that `error_code`;
 * - an infrastructure failure (verification data, the client, the account, the consent state or
 *   the revocation store could not be read; an API key lookup that failed): 503
 *   `temporarily_unavailable`, never 500;
 * - anything else (invalid, expired, revoked, another audience or tenant): 401.
 */

import type { Context } from 'hono';
import { createErrorResponse, AR_ERROR_CODES, type Env as SharedEnv } from '@authrim/ar-lib-core';
import type { CheckAuthResult } from '../middleware/check-auth';

const DISTINCT_TOKEN_REFUSALS: ReadonlySet<string> = new Set([
  'non_account_subject',
  'elevated_token_not_allowed',
]);

export function checkAuthenticationFailure<TBindings extends SharedEnv>(
  c: Context<{ Bindings: TBindings }>,
  auth: CheckAuthResult
): Response | Promise<Response> {
  if (auth.error && DISTINCT_TOKEN_REFUSALS.has(auth.error)) {
    return c.json(
      {
        error: 'invalid_token',
        error_code: auth.error,
        error_description: auth.errorDescription,
      },
      401,
      { 'WWW-Authenticate': 'Bearer error="invalid_token"', 'Cache-Control': 'no-store' }
    );
  }
  if ((auth.statusCode ?? 0) >= 500) {
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'The service is temporarily unavailable. Please try again later.',
      },
      503,
      { 'Cache-Control': 'no-store' }
    );
  }
  return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
}
