/**
 * List Providers Handler
 * GET /auth/external/providers - List available external IdP providers
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import { listEnabledProviders } from '../services/provider-store';
import type { ProviderListResponse } from '../types';

/**
 * List available providers for login UI
 * Returns only enabled providers with public information (no secrets)
 */
export async function handleListProviders(c: Context<{ Bindings: Env }>): Promise<Response> {
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
    console.error('Failed to list providers:', error);
    return c.json({ error: 'internal_error', message: 'Failed to list providers' }, 500);
  }
}
