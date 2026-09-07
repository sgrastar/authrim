import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { getTenantIdFromContext } from '@authrim/ar-lib-core';
import { getProviderByIdOrSlug } from '../services/provider-store';
import { getAuthStateRequestObject, setAuthStateRequestObject } from '../utils/state';

export async function publishRequestObject(
  env: Env,
  tenantId: string,
  providerId: string,
  state: string,
  requestObject: string
): Promise<void> {
  await setAuthStateRequestObject(env, tenantId, providerId, state, requestObject);
}

export async function handleRequestObject(c: Context<{ Bindings: Env }>): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const providerIdOrSlug = c.req.param('provider');
  if (!providerIdOrSlug) return c.notFound();
  const provider = await getProviderByIdOrSlug(c.env, providerIdOrSlug, tenantId);
  if (!provider || !provider.enabled) return c.notFound();
  const state = c.req.query('id');
  if (!state) return c.notFound();
  const requestObject = await getAuthStateRequestObject(c.env, tenantId, provider.id, state);
  if (!requestObject) return c.notFound();
  return new Response(requestObject, {
    status: 200,
    headers: {
      'Content-Type': 'application/oauth-authz-req+jwt',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
