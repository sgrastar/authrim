/** Admin account reads include suspended and locked accounts without an authentication route. */
import type { Context } from 'hono';
import {
  CanonicalRuntimeUserStore,
  CanonicalRuntimeUserProjectionRepository,
  CanonicalSensitiveValueResolver,
  createAuthContextFromHono,
  ensureDatabaseAdapter,
  getTenantMetadataContextFromHono,
  isDatabaseSource,
  type DatabaseAdapter,
  type DatabaseSource,
  type Env,
} from '@authrim/ar-lib-core';
import { accountStoreHolding } from './rbac-account-stores';
import { CrossShardAccountExactSearchService } from './cross-shard-account-list';
import { usesRoutedAccountStorage } from './tenant-routed-storage';
import { AdminContactReadBatch } from './admin-contact-read-batch';

/** Core-only operations must remain available when an account has no readable PII. */
export async function adminAccountCoreAdapter(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userId: string
): Promise<DatabaseAdapter | null> {
  const metadata = createAuthContextFromHono(c, tenantId).coreAdapter;
  return usesRoutedAccountStorage(getTenantMetadataContextFromHono(c))
    ? accountStoreHolding(c.env, tenantId, userId)
    : metadata;
}

export interface AdminAccountContact {
  email: string | null;
  name: string | null;
  /** Each disclosed user's PII access audit belongs to this same PII database. */
  store: { key: string; adapter: DatabaseAdapter };
}

function sourceAt(env: Env, bindingRef: string): DatabaseSource {
  const source: unknown = Reflect.get(env, bindingRef);
  if (!isDatabaseSource(source)) throw new Error('admin_account_binding_unavailable');
  return source;
}

/**
 * Read only the named user's contact, from its admin-view route. No request AccountDataContext
 * is mutated: a tenant-wide session page may name users in different account/PII stores.
 */
export async function adminAccountContact(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userId: string
): Promise<AdminAccountContact | null> {
  const metadata = createAuthContextFromHono(c, tenantId).coreAdapter;
  let coreAdapter: DatabaseAdapter;
  let piiAdapter: DatabaseAdapter;
  let piiKey: string;
  if (usesRoutedAccountStorage(getTenantMetadataContextFromHono(c))) {
    let matches;
    try {
      matches = await new CrossShardAccountExactSearchService(c.env).find({
        tenantId,
        identifier: userId,
        indexKind: 'account_id',
        purpose: 'admin_view',
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'cross_shard_account_pii_owner_invalid') {
        return null;
      }
      throw error;
    }
    if (matches.length === 0) return null;
    const match = matches[0];
    if (
      matches.length !== 1 ||
      !match ||
      match.tenantId !== tenantId ||
      match.legacyUserId !== userId
    ) {
      throw new Error('admin_account_contact_route_invalid');
    }
    coreAdapter = ensureDatabaseAdapter(
      sourceAt(c.env, match.coreBindingRef),
      'admin-contact-core'
    );
    piiAdapter = ensureDatabaseAdapter(sourceAt(c.env, match.piiBindingRef), 'admin-contact-pii');
    piiKey = match.piiBindingRef;
  } else {
    // Only the explicit nonrouted topology keeps accounts in metadata and PII in DB_PII.
    // Verify tenant ownership before accessing the PII binding.
    const account = await metadata.queryOne<{ id: string }>(
      `SELECT id FROM identity_accounts
        WHERE tenant_id = ? AND legacy_user_id = ? AND lifecycle_state NOT IN ('deleting', 'deleted')`,
      [tenantId, userId]
    );
    if (!account) return null;
    if (!isDatabaseSource(c.env.DB_PII)) throw new Error('admin_account_pii_unavailable');
    coreAdapter = metadata;
    piiAdapter = ensureDatabaseAdapter(c.env.DB_PII, 'admin-contact-pii');
    piiKey = 'tenant-default';
  }
  const user = await new CanonicalRuntimeUserStore({ coreAdapter, piiAdapter, tenantId }).findById(
    userId,
    { includeInactive: true }
  );
  return user
    ? { email: user.email, name: user.name, store: { key: piiKey, adapter: piiAdapter } }
    : null;
}

/** A bounded page's contacts, with no cross-user request context or PII adapter reuse. */
export async function adminAccountContacts(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userIds: readonly string[]
): Promise<Map<string, AdminAccountContact>> {
  const contacts = new Map<string, AdminAccountContact>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length > 500) throw new Error('admin_account_contacts_limit_exceeded');
  if (!ids.length) return contacts;
  const reads = new AdminContactReadBatch();
  const metadata = createAuthContextFromHono(c, tenantId).coreAdapter;
  const routed = usesRoutedAccountStorage(getTenantMetadataContextFromHono(c));
  const routes = routed
    ? await new CrossShardAccountExactSearchService(c.env).findAdminContacts({
        tenantId,
        userIds: ids,
      })
    : null;
  await Promise.all(
    ids.map(async (userId) => {
      const route = routes?.get(userId);
      if (routed && !route) return;
      const core = route
        ? sourceAt(c.env, route.coreBindingRef)
        : (getTenantMetadataContextFromHono(c)?.coreDb ??
          (isDatabaseSource(c.env.DB) ? c.env.DB : metadata));
      if (!route) {
        const account = await reads.adapter(core).queryOne<{ id: string }>(
          `SELECT id FROM identity_accounts
          WHERE tenant_id = ? AND legacy_user_id = ? AND lifecycle_state NOT IN ('deleting', 'deleted')`,
          [tenantId, userId]
        );
        if (!account) return;
      }
      const pii = route ? sourceAt(c.env, route.piiBindingRef) : c.env.DB_PII;
      if (!isDatabaseSource(pii)) throw new Error('admin_account_pii_unavailable');
      const user = await new CanonicalRuntimeUserProjectionRepository(
        reads.adapter(core),
        tenantId,
        new CanonicalSensitiveValueResolver(reads.adapter(pii))
      ).findByLegacyUserId(userId, { includeInactive: true, claimNames: ['email', 'name'] });
      if (user)
        contacts.set(userId, {
          email: user.email,
          name: user.name,
          store: {
            key: route?.piiBindingRef ?? 'tenant-default',
            adapter: ensureDatabaseAdapter(pii, 'admin-contact-pii'),
          },
        });
    })
  );
  return contacts;
}
