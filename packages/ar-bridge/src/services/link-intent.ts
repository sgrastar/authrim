/**
 * Linking an external account from the account page.
 *
 * The account page asks for a link with a same-origin POST (CSRF-checked, re-authenticated), which
 * issues a one-use intent naming the account, its session and the provider. The external start
 * only enters linking mode by consuming that intent, so a cross-site navigation to the start URL
 * can never attach someone else's external account to a signed-in victim.
 *
 * The outcome returns to the account page, never to a client: linking signs no one in.
 */

import type { Context } from 'hono';
import type {
  ConsumeChallengeRequest,
  ConsumeChallengeResponse,
  Env,
  StoreChallengeRequest,
} from '@authrim/ar-lib-core';
import {
  buildIssuerUrl,
  createAuditLog,
  getChallengeStoreByChallengeId,
  getDefaultTenantId,
  getLogger,
  getTenantIdFromContext,
  getUIConfig,
} from '@authrim/ar-lib-core';

/** The challenge store calls this module makes (the sharded stub is untyped). */
interface LinkIntentStore {
  storeChallengeRpc(request: StoreChallengeRequest): Promise<unknown>;
  consumeChallengeRpc(request: ConsumeChallengeRequest): Promise<ConsumeChallengeResponse>;
}

async function linkIntentStore(
  env: Env,
  token: string,
  tenantId: string
): Promise<LinkIntentStore> {
  return (await getChallengeStoreByChallengeId(env, token, tenantId)) as LinkIntentStore;
}

/** How long the account page has to reach the provider after asking to link. */
export const LINK_INTENT_TTL_SECONDS = 5 * 60;

export interface LinkIntent {
  userId: string;
  sessionId: string;
  providerId: string;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createLinkIntent(
  env: Env,
  tenantId: string,
  intent: LinkIntent
): Promise<string> {
  const token = randomToken();
  const store = await linkIntentStore(env, token, tenantId);
  await store.storeChallengeRpc({
    id: token,
    tenantId,
    type: 'external_idp_link_intent',
    userId: intent.userId,
    challenge: token,
    ttl: LINK_INTENT_TTL_SECONDS,
    metadata: { sessionId: intent.sessionId, providerId: intent.providerId },
  });
  return token;
}

/** The intent `token` names, consumed (null when unknown, expired or already used). */
export async function consumeLinkIntent(
  env: Env,
  tenantId: string,
  token: string
): Promise<LinkIntent | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  try {
    const store = await linkIntentStore(env, token, tenantId);
    const consumed = await store.consumeChallengeRpc({
      id: token,
      tenantId,
      type: 'external_idp_link_intent',
      challenge: token,
    });
    const sessionId = consumed.metadata?.sessionId;
    const providerId = consumed.metadata?.providerId;
    if (!consumed.userId || typeof sessionId !== 'string' || typeof providerId !== 'string') {
      return null;
    }
    return { userId: consumed.userId, sessionId, providerId };
  } catch {
    return null;
  }
}

/** Why a link did not complete, as the account page explains it. */
export type LinkFailureReason =
  | 'already_linked'
  | 'email_not_verified'
  | 'session_expired'
  | 'cancelled'
  | 'failed';

/** The account page, with the outcome of a link. */
export async function accountPageLinkResultUrl(
  env: Env,
  tenantId: string,
  outcome: { linked: true } | { linked: false; reason: LinkFailureReason }
): Promise<string> {
  const uiConfig = await getUIConfig(env, tenantId);
  const url = new URL('/account', uiConfig?.baseUrl || buildIssuerUrl(env, tenantId));
  if (outcome.linked) {
    url.searchParams.set('social_link', 'linked');
  } else {
    url.searchParams.set('social_link', 'error');
    url.searchParams.set('reason', outcome.reason);
  }
  if (tenantId !== getDefaultTenantId(env)) url.searchParams.set('tenant_hint', tenantId);
  return url.toString();
}

/** An entry in the account's activity (the account.* audit actions the account page lists). */
export async function recordSocialAccountActivity(
  c: Context<{ Bindings: Env }>,
  userId: string,
  action: 'account.social_account.linked' | 'account.social_account.unlinked',
  metadata: { linkedIdentityId: string; providerId: string }
): Promise<void> {
  try {
    await createAuditLog(c.env, {
      tenantId: getTenantIdFromContext(c),
      userId,
      action,
      resource: 'linked_identity',
      resourceId: metadata.linkedIdentityId,
      ipAddress:
        c.req.header('CF-Connecting-IP') ||
        c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
        'unknown',
      userAgent: c.req.header('User-Agent') || 'unknown',
      metadata: JSON.stringify(metadata),
      severity: 'info',
    });
  } catch (error) {
    getLogger(c)
      .module('EXTERNAL-IDP')
      .warn('Failed to record the account activity', {
        action,
        errorName: error instanceof Error ? error.name : 'Unknown',
      });
  }
}
