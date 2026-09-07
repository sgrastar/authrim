import type { Context } from 'hono';
import type { CIBARequestMetadata, Env } from '@authrim/ar-lib-core';
import {
  arrayBufferToBase64Url,
  buildDOInstanceName,
  getCIBARequestStoreById,
  getLogger,
  parseCIBARequestId,
} from '@authrim/ar-lib-core';
import { sendPingNotification } from '@authrim/ar-lib-core/notifications';
import { resolveAsyncTenantId } from './tenant';

interface ConformanceApprovalCapability {
  type: 'ciba-conformance-approval';
  tenantId: string;
  userId: string;
  sub: string;
  expiresAt: number;
}

async function capabilityKey(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return `ciba-approval:${arrayBufferToBase64Url(digest)}`;
}

/** Short-lived capability endpoint used only by an explicitly prepared OIDF CIBA run. */
export async function cibaConformanceActionHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('CIBA-CONFORMANCE');
  const tenantId = resolveAsyncTenantId(c);
  const secret = c.req.query('secret');
  const authReqId = c.req.query('auth_req_id');
  const action = c.req.query('action');
  if (
    !tenantId ||
    !secret ||
    secret.length < 32 ||
    !authReqId ||
    (action !== 'allow' && action !== 'deny')
  ) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  if (!c.env.INITIAL_ACCESS_TOKENS) {
    return c.json({ error: 'temporarily_unavailable' }, 503);
  }

  const stored = await c.env.INITIAL_ACCESS_TOKENS.get(await capabilityKey(secret));
  if (!stored) return c.json({ error: 'invalid_token' }, 401);

  let capability: ConformanceApprovalCapability;
  try {
    capability = JSON.parse(stored) as ConformanceApprovalCapability;
  } catch {
    return c.json({ error: 'invalid_token' }, 401);
  }
  if (
    capability.type !== 'ciba-conformance-approval' ||
    capability.tenantId !== tenantId ||
    !capability.userId ||
    !capability.sub ||
    capability.expiresAt <= Date.now()
  ) {
    return c.json({ error: 'invalid_token' }, 401);
  }

  const store = parseCIBARequestId(authReqId)
    ? getCIBARequestStoreById(c.env, authReqId, tenantId).stub
    : c.env.CIBA_REQUEST_STORE.get(
        c.env.CIBA_REQUEST_STORE.idFromName(buildDOInstanceName('ciba', tenantId))
      );
  const headers = {
    'Content-Type': 'application/json',
    'X-Authrim-Tenant-Id': tenantId,
  };
  const getResponse = await store.fetch(
    new Request('https://internal/get-by-auth-req-id', {
      method: 'POST',
      headers,
      body: JSON.stringify({ auth_req_id: authReqId }),
    })
  );
  if (!getResponse.ok) return c.json({ error: 'not_found' }, 404);
  const metadata = (await getResponse.json()) as CIBARequestMetadata | null;
  if (!metadata || metadata.status !== 'pending') {
    return c.json({ error: 'invalid_request' }, 400);
  }

  const internalAction = action === 'allow' ? 'approve' : 'deny';
  const actionResponse = await store.fetch(
    new Request(`https://internal/${internalAction}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(
        action === 'allow'
          ? {
              auth_req_id: authReqId,
              user_id: capability.userId,
              sub: capability.sub,
              nonce: null,
              authenticated_acr: metadata.acr_values?.split(/\s+/u).find(Boolean),
            }
          : { auth_req_id: authReqId, reason: 'Conformance test denial' }
      ),
    })
  );
  if (!actionResponse.ok) return c.json({ error: 'server_error' }, 500);

  if (
    metadata.delivery_mode === 'ping' &&
    metadata.client_notification_endpoint &&
    metadata.client_notification_token
  ) {
    try {
      await sendPingNotification(
        metadata.client_notification_endpoint,
        metadata.client_notification_token,
        authReqId
      );
    } catch (error) {
      // The OP must not retry a failed ping. The client may still poll the token endpoint.
      log.warn('CIBA conformance ping notification failed without retry', {}, error as Error);
    }
  }
  return c.json({ success: true }, 200);
}
