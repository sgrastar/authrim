/** OpenID4VCI 1.0 Nonce Endpoint. */

import type { Context } from 'hono';
import { getTenantIdFromContext } from '@authrim/ar-lib-core';
import type { Env } from '../../types';
import { sha256Base64url } from '../../utils/crypto';
import { generateProofNonce } from '../../utils/credential-offer-sharding';

const DEFAULT_EXPIRY_SECONDS = 300;

export async function vciNonceRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const { nonce, nonceId, stub } = await generateProofNonce(c.env, tenantId);
  const parsedExpiry = Number(c.env.C_NONCE_EXPIRY_SECONDS);
  const expiresIn =
    Number.isInteger(parsedExpiry) && parsedExpiry > 0 && parsedExpiry <= 3600
      ? parsedExpiry
      : DEFAULT_EXPIRY_SECONDS;
  const now = Date.now();
  const response = await stub.fetch(
    new Request('https://internal/nonce/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: nonceId,
        tenantId,
        nonceHash: await sha256Base64url(nonce),
        createdAt: now,
        expiresAt: now + expiresIn * 1000,
      }),
    })
  );
  if (!response.ok) throw new Error('vci_nonce_create_failed');
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({ c_nonce: nonce });
}
