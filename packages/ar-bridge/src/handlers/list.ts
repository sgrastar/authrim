/**
 * List Providers Handler
 * GET /auth/external/providers - List available external IdP providers
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { createErrorResponse, AR_ERROR_CODES, getLogger } from '@authrim/ar-lib-core';
import { listEnabledProviders } from '../services/provider-store';
import type { ProviderListResponse } from '../types';

/**
 * List available providers for login UI
 * Returns only enabled providers with public information (no secrets)
 */
export async function handleListProviders(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('EXTERNAL-IDP');
  try {
    const tenantId = c.req.query('tenant_id') || 'default';
    const providers = await listEnabledProviders(c.env, tenantId);

    const response: ProviderListResponse = {
      providers: providers.map((p) => ({
        id: p.id,
        slug: p.slug, // For user-friendly callback URLs
        name: p.name,
        providerType: p.providerType,
        iconUrl: p.iconUrl,
        buttonColor: p.buttonColor,
        buttonText: p.buttonText,
        enabled: true, // All providers from listEnabledProviders are enabled
      })),
    };

    return c.json(response);
  } catch (error) {
    log.error('Failed to list providers', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
