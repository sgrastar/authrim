/**
 * Refuses an app's id_token_signed_response_alg that its tenant does not allow (see
 * resolveIDTokenSigningPolicy): another algorithm than the tenant's while apps may not choose.
 */

import type { Context } from 'hono';
import {
  getLogger,
  idTokenSigningAlgorithmRefusal,
  resolveIDTokenSigningPolicy,
  type Env,
} from '@authrim/ar-lib-core';

/** A 400 response when the value is refused, a 503 when the policy cannot be read, else null. */
export async function refuseIDTokenSigningAlgorithm(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  value: unknown,
  error: 'invalid_client_metadata' | 'invalid_request'
): Promise<Response | null> {
  if (value === undefined || value === null || value === '') return null;
  let refusal: string | null;
  try {
    refusal = idTokenSigningAlgorithmRefusal(
      value,
      await resolveIDTokenSigningPolicy(c.env, tenantId)
    );
  } catch (cause) {
    getLogger(c)
      .module('ID_TOKEN_SIGNING')
      .error('ID token signing policy could not be read', {}, cause as Error);
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'ID token signing settings are temporarily unavailable',
      },
      503
    );
  }
  return refusal ? c.json({ error, error_description: refusal }, 400) : null;
}
