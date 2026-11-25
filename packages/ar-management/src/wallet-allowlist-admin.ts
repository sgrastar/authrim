/**
 * Admin API for the tenant's wallet allowlist (HAIP wallet attestation, design D / S2):
 * - GET /api/admin/wallet-attestation-allowlist : the list (roots by hash and label, not contents)
 * - PUT /api/admin/wallet-attestation-allowlist : replace it; an L2 admin step-up bound to the
 *   new list's digest and the revision it was made against, audited before and after.
 */
import type { Context } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  getLogger,
  getTenantIdFromContext,
  loadWalletAllowlist,
  parseWalletAllowlist,
  saveWalletAllowlist,
  walletAllowlistDigest,
  type WalletAllowlist,
} from '@authrim/ar-lib-core';
import { requireAdminStepUp } from './admin-step-up-gate';

function view(list: WalletAllowlist) {
  return {
    revision: list.revision,
    updated_at: list.updatedAt,
    entries: list.entries.map((entry) => ({
      client_id: entry.clientId,
      label: entry.label,
      enabled: entry.enabled,
      redirect_uris: entry.redirectUris,
      attestation_roots: entry.attestationRoots.map(({ sha256, label }) => ({ sha256, label })),
      attestation_leaf_sha256: entry.attestationLeafSha256,
      key_attestation_roots: entry.keyAttestationRoots.map(({ sha256, label }) => ({
        sha256,
        label,
      })),
    })),
  };
}

export async function adminWalletAllowlistGetHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('WALLET_ALLOWLIST');
  try {
    return c.json(view(await loadWalletAllowlist(c.env, getTenantIdFromContext(c))));
  } catch (error) {
    log.error('Failed to read the wallet allowlist', { action: 'get' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'The allowlist is unreadable' }, 500);
  }
}

export async function adminWalletAllowlistPutHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('WALLET_ALLOWLIST');
  const tenantId = getTenantIdFromContext(c);
  const auth = (
    c as unknown as Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>
  ).get('adminAuth');
  if (!auth?.userId) return c.json({ error: 'unauthorized' }, 401);
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'invalid_request', error_description: 'Invalid JSON' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json(
      { error: 'invalid_request', error_description: 'A JSON object is required' },
      400
    );
  }
  const expectedRevision = body.expected_revision;
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    return c.json(
      { error: 'invalid_request', error_description: 'expected_revision is required' },
      400
    );
  }
  let next: WalletAllowlist;
  try {
    // The submitted entries use the stored (camelCase) shape: roots carry their certificate.
    next = await parseWalletAllowlist({ version: 1, entries: body.entries });
  } catch (error) {
    return c.json({ error: 'invalid_request', error_description: (error as Error).message }, 400);
  }
  let current: WalletAllowlist;
  try {
    current = await loadWalletAllowlist(c.env, tenantId);
  } catch {
    return c.json({ error: 'server_error', error_description: 'The allowlist is unreadable' }, 500);
  }
  if (current.revision !== expectedRevision) {
    return c.json({ error: 'conflict', error_description: 'The allowlist has changed' }, 409);
  }
  // A wallet type's id is a client id nothing else may hold: a stored client of the same id would
  // be resolved instead of the wallet at authorize and token.
  try {
    const stored = createAuthContextFromHono(c, tenantId).coreAdapter;
    for (const entry of next.entries) {
      const row = await stored.queryOne<{ client_id: string }>(
        'SELECT client_id FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
        [tenantId, entry.clientId]
      );
      if (row) {
        return c.json(
          {
            error: 'conflict',
            error_description: 'A registered client already uses this client id',
          },
          409
        );
      }
    }
  } catch {
    return c.json(
      { error: 'server_error', error_description: 'Clients could not be checked' },
      500
    );
  }
  // The receipt is spent here, after every check that can still refuse the request.
  const refused = await requireAdminStepUp(c as never, {
    operation: 'wallet_allowlist.update',
    targetTenantId: tenantId,
    targetIds: [tenantId],
    resourceVersion: current.revision,
    params: { entries_sha256: await walletAllowlistDigest(next.entries) },
  });
  if (refused) return refused;
  try {
    const saved = await saveWalletAllowlist(c.env, {
      tenantId,
      allowlist: { version: 1, entries: next.entries },
      actorId: auth.userId,
      expectedRevision,
      gate: 'admin_step_up',
    });
    return c.json(view(saved));
  } catch (error) {
    const message = (error as Error).message;
    if (message === 'wallet_allowlist_revision_conflict') {
      return c.json({ error: 'conflict', error_description: 'The allowlist has changed' }, 409);
    }
    log.error('Failed to save the wallet allowlist', { action: 'put' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'The allowlist was not saved' }, 500);
  }
}
