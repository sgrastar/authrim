import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  falRequiresSignedPushedRequest,
  getLogger,
  resolveEffectiveSettings,
} from '@authrim/ar-lib-core';

/**
 * The refusal of a flow that cannot meet the tenant's required FAL, or null when it may go on.
 * FAL3 (with fal3_requires_par) needs a pushed, signed authorization request, which neither the
 * device flow nor CIBA has. Settings that cannot be read stop the request.
 */
export async function fal3Refusal(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<Response | null> {
  let settings: Record<string, unknown>;
  try {
    settings = await resolveEffectiveSettings(c.env, 'assurance', { tenantId });
  } catch (error) {
    getLogger(c)
      .module('ASSURANCE')
      .error('Failed to load assurance settings', { action: 'assurance_settings' }, error as Error);
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'Assurance settings are temporarily unavailable',
      },
      503
    );
  }
  if (falRequiresSignedPushedRequest(settings)) {
    return c.json(
      {
        error: 'unauthorized_client',
        error_description: 'This flow does not meet the required federation assurance level (FAL3)',
      },
      400
    );
  }
  return null;
}
