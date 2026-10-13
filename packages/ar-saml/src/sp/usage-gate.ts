/**
 * The answer when the tenant's per-IdP sign-in and sign-up switches
 * (`authentication-methods.external_provider_usage`) cannot be read: the sign-in is refused as
 * temporarily unavailable rather than decided on a guess (as for the SAML enabled switch).
 */
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

export function samlUsageUnavailableResponse(c: Context<{ Bindings: Env }>): Response {
  return c.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'The service is temporarily unavailable. Please try again later.',
    },
    503,
    { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Retry-After': '5' }
  );
}
