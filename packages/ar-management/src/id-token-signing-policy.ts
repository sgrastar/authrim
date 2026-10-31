/**
 * An app's ID token signing algorithm under its tenant's policy (see resolveIDTokenSigningPolicy):
 * refusing another algorithm than the tenant's while apps may not choose, and naming the
 * algorithm actually used in what registration answers.
 */

import type { Context } from 'hono';
import {
  getLogger,
  idTokenSigningAlgorithmRefusal,
  resolveIDTokenSigningPolicy,
  type Env,
  type IDTokenSigningPolicy,
} from '@authrim/ar-lib-core';

/** The tenant's policy, or a 503 response when it cannot be read. */
export async function readIDTokenSigningPolicy(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<IDTokenSigningPolicy | Response> {
  try {
    return await resolveIDTokenSigningPolicy(c.env, tenantId);
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
}

/** A 400 response when the value is refused, a 503 when the policy cannot be read, else null. */
export async function refuseIDTokenSigningAlgorithm(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  value: unknown,
  error: 'invalid_client_metadata' | 'invalid_request'
): Promise<Response | null> {
  if (value === undefined || value === null || value === '') return null;
  const policy = await readIDTokenSigningPolicy(c, tenantId);
  if (policy instanceof Response) return policy;
  const refusal = idTokenSigningAlgorithmRefusal(value, policy);
  return refusal ? c.json({ error, error_description: refusal }, 400) : null;
}
