import type { Context } from 'hono';
import {
  createAuthContextFromHono,
  deriveOidcSid,
  ensureDatabaseAdapter,
  normalizeDeviceSecretLogoutScope,
  resolveAccountCoreDataContext,
  revokeDeviceSecretsForLogoutScope,
  type DatabaseAdapter,
  type Env,
  type RevokeDeviceSecretsForLogoutScopeInput,
  type RevokeDeviceSecretsForLogoutScopeResult,
} from '@authrim/ar-lib-core';
import { usesRoutedAccountStorage } from './account-provisioning';

export interface RevokeSessionDeviceSecretsInput extends Omit<
  RevokeDeviceSecretsForLogoutScopeInput,
  'adapter' | 'sessionIds'
> {
  /** The OP session the logout ends (the internal session key). */
  sessionId: string;
  /** The issuer the session's ID tokens were issued under: it derives their RP-specific sids. */
  issuer: string;
}

function noRevocation(
  input: RevokeSessionDeviceSecretsInput
): RevokeDeviceSecretsForLogoutScopeResult {
  return {
    scope: normalizeDeviceSecretLogoutScope(input.scope),
    tenantId: input.tenantId,
    userId: input.userId,
    clientId: input.clientId,
    trustGroupId: input.trustGroupId,
    sessionIds: [input.sessionId],
    revokedDeviceSecrets: 0,
    revokedInstallations: 0,
    matchedInstallations: 0,
    callerAuthMode: input.callerAuthMode,
  };
}

interface SessionDeviceSecretTarget {
  clientId: string | undefined;
  trustGroupId: string | undefined;
  /** The identifiers this target's rows carry (the session key and/or RP-specific sids). */
  sessionIds: Set<string>;
}

/**
 * The apps (with their trust groups) the session's device secrets and installations belong to,
 * revoked or not (so that a retry, after a failure kept the session, finds the same ones again).
 *
 * ar-token records a device secret under the ID token's `sid`, which is RP-specific
 * (deriveOidcSid of the session, the client and the issuer), not the OP session key; secrets from
 * before that derivation carry the key itself. An app that signed in through Native SSO has an
 * installation of its own (its client, its trust group) carrying the sid of the app that issued
 * the secret, and no secret of its own. The user's rows are read and matched here, so no query
 * binds more than a few identifiers whatever the user's history, and a target keeps only its own.
 */
async function sessionDeviceSecretTargets(
  adapter: DatabaseAdapter,
  input: RevokeSessionDeviceSecretsInput & { userId: string }
): Promise<SessionDeviceSecretTarget[]> {
  type Row = {
    session_id: string | null;
    client_id: string | null;
    trust_group_id: string | null;
    source_client_id?: string | null;
  };
  const secrets = await adapter.query<Row>(
    `SELECT DISTINCT session_id, client_id, trust_group_id FROM device_secrets
      WHERE tenant_id = ? AND user_id = ?`,
    [input.tenantId, input.userId]
  );
  const installations = await adapter
    .query<Row>(
      `SELECT DISTINCT session_id, client_id, trust_group_id, source_client_id
         FROM device_installations WHERE tenant_id = ? AND user_id = ?`,
      [input.tenantId, input.userId]
    )
    .catch((error: unknown) => {
      // A deployment without the installations table has none.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('device_installations') || message.includes('no such table')) {
        return [] as Row[];
      }
      throw error;
    });
  const rows = [...secrets, ...installations];

  // The identifiers the session's rows can carry: its key, and its sid for each app that
  // issued a secret to the user.
  const candidates = new Set([input.sessionId]);
  const issuers = new Set(
    rows.flatMap((row) => [row.client_id, row.source_client_id]).filter(Boolean) as string[]
  );
  for (const clientId of issuers) {
    candidates.add(await deriveOidcSid(input.sessionId, clientId, input.issuer));
  }

  const targets = new Map<string, SessionDeviceSecretTarget>();
  for (const row of rows) {
    if (!row.session_id || !candidates.has(row.session_id)) continue;
    if (input.clientId && row.client_id !== input.clientId) continue;
    const key = JSON.stringify([row.client_id, row.trust_group_id]);
    const target = targets.get(key) ?? {
      clientId: row.client_id ?? undefined,
      trustGroupId: row.trust_group_id ?? undefined,
      sessionIds: new Set<string>(),
    };
    target.sessionIds.add(row.session_id);
    targets.set(key, target);
  }
  return [...targets.values()];
}

/**
 * Revoke the Native SSO device secrets (and their installations) a logout of one session ends,
 * in the database ar-token issues and validates them in.
 *
 * Where accounts are routed (shared_pool and tenant_exclusive), a user's device secrets are in the
 * account's own Core database, not the tenant metadata database: they are revoked in the database
 * of the session's user (`userId`). A session without a known user has no database to look in,
 * nor has a user without an account route (ar-token refuses their secrets). Where accounts are not
 * routed, the secrets are in the metadata database.
 *
 * Call it before the session ends: a failure is thrown, and the caller can then keep the session
 * (and its user) for a retry instead of answering a logout that left the secrets usable.
 */
export async function revokeSessionDeviceSecrets(
  c: Context<{ Bindings: Env }>,
  input: RevokeSessionDeviceSecretsInput
): Promise<RevokeDeviceSecretsForLogoutScopeResult> {
  const { sessionId: _sessionId, issuer: _issuer, ...scope } = input;
  let adapter: DatabaseAdapter;
  if (!usesRoutedAccountStorage(c)) {
    adapter = createAuthContextFromHono(c, input.tenantId).coreAdapter;
  } else {
    if (!input.userId) return noRevocation(input);
    let account: Awaited<ReturnType<typeof resolveAccountCoreDataContext>>;
    try {
      account = await resolveAccountCoreDataContext(c.env, {
        tenantId: input.tenantId,
        accountId: input.userId,
      });
    } catch (error) {
      // No account route, no device secret: ar-token refuses a secret whose account it cannot
      // route to, so there is nothing of this user's left to revoke.
      if (error instanceof Error && error.message === 'account_data_route_not_found') {
        return noRevocation(input);
      }
      throw error;
    }
    if (account.legacyUserId !== input.userId) {
      throw new Error('logout_device_secret_owner_mismatch');
    }
    adapter = ensureDatabaseAdapter(account.coreDb, 'logout-device-secrets-account-core');
  }
  // Without the session's user, its secrets are not found by app: one revocation by the
  // session's identifiers, which infers the app from them (the metadata database only).
  if (!input.userId) {
    return revokeDeviceSecretsForLogoutScope({ ...scope, adapter, sessionIds: [input.sessionId] });
  }
  const targets = await sessionDeviceSecretTargets(adapter, { ...input, userId: input.userId });
  if (targets.length === 0) {
    targets.push({
      clientId: input.clientId,
      trustGroupId: input.trustGroupId,
      sessionIds: new Set([input.sessionId]),
    });
  }
  const logoutScope = normalizeDeviceSecretLogoutScope(input.scope);
  let merged: RevokeDeviceSecretsForLogoutScopeResult | undefined;
  const revoke = async (part: Partial<RevokeDeviceSecretsForLogoutScopeInput>) => {
    merged = mergeDeviceSecretLogoutResults(
      merged,
      await revokeDeviceSecretsForLogoutScope({ ...scope, adapter, sessionIds: [], ...part })
    );
  };
  // The session's own secrets, app by app: one revocation takes a single app (it infers one
  // from the session's secrets when given none), so a session with several apps keeps the others'.
  // Each call binds only the identifiers its app's rows carry.
  const sessionIdsByClient = new Map<string | undefined, Set<string>>();
  for (const target of targets) {
    const ids = sessionIdsByClient.get(target.clientId) ?? new Set<string>();
    target.sessionIds.forEach((id) => ids.add(id));
    sessionIdsByClient.set(target.clientId, ids);
  }
  for (const [clientId, ids] of sessionIdsByClient) {
    await revoke({ scope: 'local', clientId, sessionIds: [...ids] });
  }
  if (logoutScope === 'group') {
    // Each app's group: its trust group, or (an app in none) the app itself. Named explicitly, so
    // that the group is not inferred from another of the session's rows.
    for (const target of targets) {
      const trustGroupId = input.trustGroupId ?? target.trustGroupId;
      if (trustGroupId) {
        await revoke({ scope: 'group', clientId: target.clientId, trustGroupId });
      } else if (target.clientId) {
        await revoke({ scope: 'group', clientId: target.clientId });
      }
    }
  }
  // An account-wide revocation names the user, and needs none of the session's identifiers.
  if (logoutScope === 'global') await revoke({ scope: 'global' });
  return { ...(merged ?? noRevocation(input)), scope: logoutScope };
}

/** The revocations of several ended sessions as one, for the logout's audit record. */
export function mergeDeviceSecretLogoutResults(
  previous: RevokeDeviceSecretsForLogoutScopeResult | undefined,
  next: RevokeDeviceSecretsForLogoutScopeResult
): RevokeDeviceSecretsForLogoutScopeResult {
  if (!previous) return next;
  return {
    ...previous,
    sessionIds: [...previous.sessionIds, ...next.sessionIds],
    revokedDeviceSecrets: previous.revokedDeviceSecrets + next.revokedDeviceSecrets,
    revokedInstallations: previous.revokedInstallations + next.revokedInstallations,
    matchedInstallations: previous.matchedInstallations + next.matchedInstallations,
  };
}
