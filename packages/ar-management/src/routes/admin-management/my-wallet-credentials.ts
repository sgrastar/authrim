/**
 * My wallet credential API
 *
 * Self-service issuance of the signed-in admin's own admin credential into a wallet
 * (admin credential design D4/D5). The subject is always the caller.
 *
 * Endpoints:
 * - POST /api/admin/me/wallet-credentials/offers          - Create an offer (fresh authentication)
 * - GET  /api/admin/me/wallet-credentials/offers/:offerId - Offer progress for the console
 * - GET  /api/admin/me/wallet-credentials                 - The caller's own admin credentials
 * - POST /api/admin/me/wallet-credentials/:credentialId/revoke - Revoke one (fresh authentication,
 *   then an L2 step-up: admin_credential.revoke)
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  adminAuthMiddleware,
  createAuthContextFromHono,
  evaluateAdminCredentialEligibility,
  getRateLimitProfileAsync,
  getTenantIdFromContext,
  rateLimitMiddleware,
  requiredIdempotencyMiddleware,
  requireDedicatedAdminDatabaseAdapter,
  ADMIN_SECOND_FACTOR_MINIMUM,
  markIdempotentResponseRetryable,
  AdminSecondFactorRepository,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';
import { isFreshAdminHuman } from '../../agent-fresh-auth';
import { requireAdminStepUp } from '../../admin-step-up-gate';
import { getCanonicalTenantBaseUrlAsync } from '../../request-issuer';
import {
  isOwnAdminCredential,
  listOwnAdminCredentials,
  holderThumbprintOfCredential,
  revokeAdminCredential,
} from './admin-wallet-credential-store';

type WalletContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

interface SessionRow {
  tenant_id: string;
  derived_target_tenant_id: string | null;
}

const CREDENTIAL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const OFFER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export const myWalletCredentialsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

myWalletCredentialsRouter.use('*', adminAuthMiddleware({}));

function secondFactorMinimum(c: WalletContext) {
  c.header('Cache-Control', 'no-store');
  return c.json(
    {
      error: 'second_factor_minimum',
      error_description:
        'This credential is your only second factor: register another one before revoking it',
      minimum: ADMIN_SECOND_FACTOR_MINIMUM,
    },
    409
  );
}

/** Thumbprints of the admin's active Keyring second factors. */
async function activeKeyringFactorThumbprints(
  c: WalletContext,
  adminUserId: string
): Promise<Set<string>> {
  const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-wallet-credential');
  const active = await new AdminSecondFactorRepository(adapter).listActiveByUser(adminUserId);
  return new Set(active.flatMap((factor) => (factor.holder_jkt ? [factor.holder_jkt] : [])));
}

/** Query parameter of the offer link naming the holder keys Keyring should keep when it renews. */
export const RENEW_HOLDER_JKT_PARAM = 'authrim_renew_holder_jkt';

/** The offer link with the renewal hint appended (comma-separated thumbprints), if any. */
export function withRenewalHint(credentialOffer: string, jkts: string[]): string {
  const usable = jkts.filter((jkt) => /^[A-Za-z0-9_-]{43}$/.test(jkt));
  if (usable.length === 0) return credentialOffer;
  const separator = credentialOffer.includes('?') ? '&' : '?';
  return `${credentialOffer}${separator}${RENEW_HOLDER_JKT_PARAM}=${usable.join(',')}`;
}

function refuse(c: WalletContext, error: string, status: 403 | 404 | 503) {
  c.header('Cache-Control', 'no-store');
  return c.json({ error }, status);
}

/**
 * The caller must be a human on a stored, non-derived session whose tenant is the request tenant
 * and the admin's home tenant. `adminAuth.tenantId` is rewritten to the request tenant, so the
 * stored session row is what proves it.
 */
async function resolveHome(
  c: WalletContext
): Promise<{ tenantId: string; adminUserId: string } | Response> {
  const auth = c.get('adminAuth');
  if (
    !auth ||
    auth.authMethod !== 'session' ||
    (auth.actorType && auth.actorType !== 'human') ||
    !auth.sessionId ||
    !auth.userId
  ) {
    return refuse(c, 'wallet_credential_session_required', 403);
  }
  const tenantId = getTenantIdFromContext(c);
  const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-wallet-credential');
  const session = await adapter.queryOne<SessionRow>(
    `SELECT tenant_id, derived_target_tenant_id
       FROM admin_sessions
      WHERE id = ? AND admin_user_id = ? AND expires_at > ?`,
    [auth.sessionId, auth.userId, Date.now()]
  );
  if (!session || session.derived_target_tenant_id !== null || session.tenant_id !== tenantId) {
    return refuse(c, 'wallet_credential_home_session_required', 403);
  }
  const home = await adapter.queryOne<{ tenant_id: string }>(
    'SELECT tenant_id FROM admin_users WHERE id = ?',
    [auth.userId]
  );
  if (!home || home.tenant_id !== tenantId) {
    return refuse(c, 'wallet_credential_home_session_required', 403);
  }
  return { tenantId, adminUserId: auth.userId };
}

myWalletCredentialsRouter.post(
  '/offers',
  async (c, next) => {
    const profile = await getRateLimitProfileAsync(c.env, 'strict');
    return rateLimitMiddleware({
      ...profile,
      endpoints: ['/api/admin/me/wallet-credentials/offers'],
      endpointClass: 'mgmt_admin_wallet_credential_offer',
    })(c as unknown as Context<{ Bindings: Env }>, next);
  },
  // Before the idempotency reservation, so a refusal is never replayed after re-authentication.
  async (c, next) => {
    const auth = c.get('adminAuth');
    if (!auth || !isFreshAdminHuman(auth, Date.now())) {
      return refuse(c, 'wallet_credential_fresh_auth_required', 403);
    }
    return next();
  },
  // Only the identifiers are replayed; the offer URI and the transaction code never are.
  requiredIdempotencyMiddleware({
    ttlSeconds: 900,
    failClosedOnStorageError: true,
    reserveBeforeExecution: true,
    redactFields: ['credentialOffer', 'transactionCode'],
  }) as never,
  async (c) => {
    const home = await resolveHome(c);
    if (home instanceof Response) return home;

    const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-wallet-credential');
    const eligibility = await evaluateAdminCredentialEligibility(adapter, {
      tenantId: home.tenantId,
      adminUserId: home.adminUserId,
      now: Date.now(),
    });
    if (!eligibility.eligible) {
      return refuse(c, 'wallet_credential_not_eligible', 403);
    }
    if (!c.env.VC_ISSUER) {
      return refuse(c, 'wallet_credential_unavailable', 503);
    }
    const canonicalIssuer = new URL(await getCanonicalTenantBaseUrlAsync(c.env, home.tenantId));
    if (canonicalIssuer.protocol !== 'https:') {
      return refuse(c, 'wallet_credential_unavailable', 503);
    }

    const offer = await c.env.VC_ISSUER.createAdminCredentialOffer({
      tenantId: home.tenantId,
      adminUserId: home.adminUserId,
      credentialIssuer: canonicalIssuer.origin,
    });

    // The offer id only: neither the offer URI nor the transaction code is ever logged.
    await writeAdminAuditLog(c, {
      action: 'admin_wallet_credential.offer_created',
      resourceType: 'admin_wallet_credential_offer',
      resourceId: offer.offerId,
      result: 'success',
      metadata: { offer_id: offer.offerId },
    });

    // Keyring renews with the holder key that is already a second factor, so the factor carries
    // over to the new credential. The thumbprints are public-key digests: the wallet only uses a
    // key it already holds for a credential of this issuer, and other wallets ignore the parameter.
    const renewJkts = [...(await activeKeyringFactorThumbprints(c, home.adminUserId))];
    const credentialOffer = withRenewalHint(offer.credentialOffer, renewJkts);

    c.header('Cache-Control', 'no-store');
    return c.json(
      {
        offerId: offer.offerId,
        credentialOffer,
        transactionCode: offer.transactionCode,
        expiresAt: offer.expiresAt,
      },
      201
    );
  }
);

myWalletCredentialsRouter.get('/offers/:offerId', async (c) => {
  const home = await resolveHome(c);
  if (home instanceof Response) return home;
  const offerId = c.req.param('offerId');
  if (!OFFER_ID_PATTERN.test(offerId)) {
    return refuse(c, 'not_found', 404);
  }
  if (!c.env.VC_ISSUER) {
    return refuse(c, 'wallet_credential_unavailable', 503);
  }
  const status = await c.env.VC_ISSUER.getAdminCredentialOfferStatus({
    tenantId: home.tenantId,
    adminUserId: home.adminUserId,
    offerId,
  });
  if (!status) {
    return refuse(c, 'not_found', 404);
  }
  c.header('Cache-Control', 'no-store');
  return c.json(status);
});

myWalletCredentialsRouter.get('/', async (c) => {
  const home = await resolveHome(c);
  if (home instanceof Response) return home;
  const adapter = createAuthContextFromHono(
    c as unknown as Context<{ Bindings: Env }>,
    home.tenantId
  ).coreAdapter;
  const items = await listOwnAdminCredentials(adapter, home.tenantId, home.adminUserId);
  // Which credentials carry a holder key that is one of the admin's active second factors, so the
  // console can warn before one is revoked or replaced.
  const factorJkts = await activeKeyringFactorThumbprints(c, home.adminUserId);
  c.header('Cache-Control', 'no-store');
  return c.json({
    items: items.map((item) => ({
      ...item,
      secondFactor: !!item.holderKeyThumbprint && factorJkts.has(item.holderKeyThumbprint),
    })),
  });
});

myWalletCredentialsRouter.post(
  '/:credentialId/revoke',
  async (c, next) => {
    const profile = await getRateLimitProfileAsync(c.env, 'strict');
    return rateLimitMiddleware({
      ...profile,
      endpoints: ['/api/admin/me/wallet-credentials/*/revoke'],
      endpointClass: 'mgmt_admin_wallet_credential_revoke',
    })(c as unknown as Context<{ Bindings: Env }>, next);
  },
  // Before the idempotency reservation, so a refusal is never replayed after re-authentication.
  async (c, next) => {
    const auth = c.get('adminAuth');
    if (!auth || !isFreshAdminHuman(auth, Date.now())) {
      return refuse(c, 'wallet_credential_fresh_auth_required', 403);
    }
    return next();
  },
  requiredIdempotencyMiddleware({
    ttlSeconds: 900,
    failClosedOnStorageError: true,
    reserveBeforeExecution: true,
  }) as never,
  async (c) => {
    const home = await resolveHome(c);
    if (home instanceof Response) return home;
    const credentialId = c.req.param('credentialId');
    if (!CREDENTIAL_ID_PATTERN.test(credentialId)) {
      return refuse(c, 'not_found', 404);
    }

    const adapter = createAuthContextFromHono(
      c as unknown as Context<{ Bindings: Env }>,
      home.tenantId
    ).coreAdapter;
    // Another admin's credential, or one of another type, is indistinguishable from none.
    if (!(await isOwnAdminCredential(adapter, home.tenantId, home.adminUserId, credentialId))) {
      return refuse(c, 'not_found', 404);
    }

    // A credential registered as one of the admin's second factors takes the factor with it:
    // that is removing a second factor, under the same rules (the minimum, its L2 operation).
    const adminAdapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-wallet-credential');
    const factors = new AdminSecondFactorRepository(adminAdapter);
    const jkt = await holderThumbprintOfCredential(adapter, home.tenantId, credentialId);
    // Revoking any credential that carries a registered holder key revokes that key as a second
    // factor too, even when a renewed credential shares the key: a revocation says the key is no
    // longer trusted, and it always goes through the minimum and the factor's own L2 operation.
    const factor = jkt ? await factors.findActiveKeyringFactor(home.adminUserId, jkt) : null;
    if (
      factor &&
      (await factors.listActiveByUser(home.adminUserId)).length <= ADMIN_SECOND_FACTOR_MINIMUM
    ) {
      return secondFactorMinimum(c);
    }

    // The receipt is spent here, after every check that can still refuse the request.
    const stepUpRefused = await requireAdminStepUp(c as never, {
      operation: 'admin_credential.revoke',
      // Any credential with a holder key can take a factor with it (one registered meanwhile
      // included), so removing a second factor is always covered.
      ...(jkt ? { alsoCovers: ['admin.second_factor.remove' as const] } : {}),
      targetTenantId: home.tenantId,
      targetIds: [home.adminUserId, credentialId],
      params: { scope: 'own_wallet_credential' },
    });
    if (stepUpRefused) return stepUpRefused;

    if (factor) {
      const removed = await factors.revoke(home.adminUserId, factor.id);
      if (!removed.revoked && removed.reason === 'minimum_reached') return secondFactorMinimum(c);
    }

    const outcome = await revokeAdminCredential(adapter, home.tenantId, credentialId);
    if (outcome === 'not_found') return refuse(c, 'not_found', 404);
    if (outcome === 'conflict' || outcome === 'error') {
      // Not the outcome of the request: the same Idempotency-Key may try again.
      markIdempotentResponseRetryable(c as never);
      c.header('Retry-After', '1');
      return refuse(c, 'wallet_credential_unavailable', 503);
    }
    if (outcome === 'not_allowed') {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'wallet_credential_not_revocable' }, 409);
    }

    // A factor of this credential's key that is still active (registered while this request ran)
    // goes with the credential: the revocation wins, as for an administrator's revocation. Only
    // this key: other revoked rows can carry a registered key too (an issuance that failed while
    // renewing with that key is left revoked). A failure here is retried with the same key.
    try {
      if (jkt) await factors.revokeKeyringHolderKey(home.adminUserId, jkt);
    } catch {
      // Not the outcome of the request: the same Idempotency-Key may try again.
      markIdempotentResponseRetryable(c as never);
      c.header('Retry-After', '1');
      return refuse(c, 'wallet_credential_unavailable', 503);
    }

    // Only the credential id: nothing about the key or the claims.
    await writeAdminAuditLog(c, {
      action: 'admin_wallet_credential.revoked',
      resourceType: 'admin_wallet_credential',
      resourceId: credentialId,
      result: 'success',
      metadata: { credential_id: credentialId },
    });

    c.header('Cache-Control', 'no-store');
    return c.json({ id: credentialId, status: 'revoked' });
  }
);
