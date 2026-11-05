/**
 * Step-up for the SAML Admin API: every change to who the tenant trusts (providers, their
 * metadata and certificates, the signing keys the tenant publishes) is `federation.trust.update`.
 *
 * The gate spends the receipt, so each handler calls `requireSAMLTrustStepUp` once, after it has
 * validated the request and just before the state change. Params carry only the request's own
 * inputs; certificates, keys and metadata go in as SHA-256 digests.
 */

import type { Context } from 'hono';
import { requireAdminStepUp } from '@authrim/ar-lib-core';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';

type StepUpContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

/** Lower-case hex SHA-256 of a value's JSON form (strings are hashed as they are). */
export async function sha256Digest(value: unknown): Promise<string> {
  const text = typeof value === 'string' ? value : (JSON.stringify(value ?? null) ?? 'null');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Returns null when the request may go ahead, or the response refusing it. */
export function requireSAMLTrustStepUp(
  c: unknown,
  input: { tenantId: string; targetIds?: string[]; params?: Record<string, unknown> }
): Promise<Response | null> {
  return requireAdminStepUp(c as StepUpContext, {
    operation: 'federation.trust.update',
    targetTenantId: input.tenantId,
    ...(input.targetIds ? { targetIds: input.targetIds } : {}),
    ...(input.params ? { params: input.params } : {}),
  });
}
