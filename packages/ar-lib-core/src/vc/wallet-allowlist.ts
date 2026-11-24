/**
 * The tenant's wallet allowlist (design D, S2): which wallet types may authenticate at the
 * issuer's PAR and token endpoints with a wallet attestation, and which attestation roots they are
 * trusted through.
 *
 * Each entry stands for one wallet type. Its `client_id` is the attestation's `sub`; the OP
 * derives a virtual OAuth client from it, so no client record exists to be edited around the list.
 * With no list, or no enabled entry, no wallet is accepted (fail closed).
 *
 * Changing the list is a security change: the caller must prove an administrator step-up and the
 * change is audited before it is stored (see `saveWalletAllowlist`).
 */

import type { ClientMetadata } from '../types/oidc';
import type { Env } from '../types/env';
import { createAuditLog } from '../utils/audit-log';
import {
  allowlistStore,
  loadWalletAllowlist,
  parseWalletAllowlist,
  walletAllowlistKey,
  walletEntryToClient,
  WALLET_ALLOWLIST_SCOPES,
  type WalletAllowlist,
  type WalletAllowlistEntry,
} from './wallet-allowlist-read';
import { recordReplayJti } from '../utils/jti-replay-guard';
import {
  CLIENT_ATTESTATION_HEADER,
  CLIENT_ATTESTATION_POP_HEADER,
  verifyWalletAttestation,
  type AttestationFailure,
} from './wallet-attestation';

/** SHA-256 (base64url) of the list's entries: what an administrator's step-up is bound to. */
export async function walletAllowlistDigest(
  entries: readonly WalletAllowlistEntry[]
): Promise<string> {
  const canonical = JSON.stringify(
    entries.map((entry) => ({
      clientId: entry.clientId,
      label: entry.label,
      enabled: entry.enabled,
      attestationRoots: entry.attestationRoots.map((root) => root.sha256).sort(),
      keyAttestationRoots: entry.keyAttestationRoots.map((root) => root.sha256).sort(),
      redirectUris: [...entry.redirectUris].sort(),
    }))
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  );
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export interface SaveWalletAllowlistInput {
  tenantId: string;
  allowlist: unknown;
  /** The administrator making the change. */
  actorId: string;
  /** The revision the change was made against; any other current revision refuses it. */
  expectedRevision: number;
  /**
   * The Admin API route that calls this has passed the admin step-up gate for
   * `wallet_allowlist.update`, bound to the list's digest and the expected revision. Nothing
   * else may call this function.
   */
  gate: 'admin_step_up';
}

/**
 * Replaces the tenant's list. Audits the attempt first (a change that cannot be audited is not
 * made) and the application after, and records which wallet types and roots were added or
 * removed, not the roots' contents. KV is eventually consistent: the revision check narrows
 * concurrent updates to a window of KV propagation, it does not close it, and a revocation takes
 * effect in other regions after the same propagation.
 */
export async function saveWalletAllowlist(
  env: Env,
  input: SaveWalletAllowlistInput
): Promise<WalletAllowlist> {
  if (input.gate !== 'admin_step_up') throw new Error('wallet_allowlist_step_up_required');
  const kv = allowlistStore(env);
  if (!kv) throw new Error('wallet_allowlist_storage_unavailable');
  const next = await parseWalletAllowlist(input.allowlist);
  const before = await loadWalletAllowlist(env, input.tenantId);
  if (before.revision !== input.expectedRevision)
    throw new Error('wallet_allowlist_revision_conflict');
  const now = Date.now();
  const summary = (list: WalletAllowlist) =>
    list.entries.map((entry) => ({
      clientId: entry.clientId,
      label: entry.label,
      enabled: entry.enabled,
      attestationRoots: entry.attestationRoots.map((root) => root.sha256),
      keyAttestationRoots: entry.keyAttestationRoots.map((root) => root.sha256),
      redirectUris: entry.redirectUris,
    }));
  const stored: WalletAllowlist = { ...next, updatedAt: now, revision: before.revision + 1 };
  const operationId = crypto.randomUUID();
  const audit = (action: string, durable: boolean) =>
    createAuditLog(env, {
      tenantId: input.tenantId,
      userId: input.actorId,
      action,
      resource: 'wallet_allowlist',
      resourceId: input.tenantId,
      severity: 'critical',
      requireDurableFanout: durable,
      ipAddress: '',
      userAgent: '',
      metadata: JSON.stringify({
        // Ties the attempt to its application when both are read back.
        operationId,
        revision: stored.revision,
        before: summary(before),
        after: summary(next),
      }),
    });
  await audit('wallet_allowlist.update', true);
  try {
    await kv.put(walletAllowlistKey(input.tenantId), JSON.stringify(stored));
  } catch (error) {
    await audit('wallet_allowlist.update.failed', false).catch(() => undefined);
    throw error;
  }
  // The change is made; a failure to say so must not undo or hide it from the caller.
  await audit('wallet_allowlist.update.applied', false).catch(() => undefined);
  return stored;
}

export type WalletClientAuthentication =
  | {
      ok: true;
      client: ClientMetadata;
      entry: WalletAllowlistEntry;
      instanceKeyThumbprint: string;
      anchorSha256: string;
    }
  | {
      ok: false;
      error: AttestationFailure | 'wallet_not_allowed' | 'wallet_allowlist_unavailable';
    };

export interface AuthenticateWalletClientInput {
  env: Env;
  tenantId: string;
  /** The request's headers. */
  headers: { get(name: string): string | null };
  /** The issuer identifier the PoP must name. */
  issuer: string;
  /** The `client_id` the request names; the wallet type whose roots are tried. */
  clientId: string;
  now?: number;
}

/** Whether a request carries either attestation header (so it is attempting this method). */
export function hasWalletAttestationHeaders(headers: {
  get(name: string): string | null;
}): boolean {
  return (
    headers.get(CLIENT_ATTESTATION_HEADER) !== null ||
    headers.get(CLIENT_ATTESTATION_POP_HEADER) !== null
  );
}

async function consumeReplay(
  env: Env,
  tenantId: string,
  jti: string,
  ttlSeconds: number
): Promise<boolean> {
  // The runtime's fixed-shard store, keyed by the proof's own jti so every presentation of one
  // proof reaches the same record whatever the region configuration does meanwhile.
  const key = `client-attestation-pop:${jti}`;
  const outcome = await recordReplayJti(env, {
    tenantId,
    shardKey: key,
    jti: key,
    issuedAt: Math.floor(Date.now() / 1000),
    ttlSeconds,
  });
  return outcome === 'recorded';
}

/**
 * Authenticates a wallet at PAR or the token endpoint: both headers present, the attestation's
 * chain on the tenant's allowlist for an enabled wallet type, the proof addressed to this issuer
 * and fresh and unused. The result carries the virtual client to continue the request with.
 */
export async function authenticateWalletClient(
  input: AuthenticateWalletClientInput
): Promise<WalletClientAuthentication> {
  const attestation = input.headers.get(CLIENT_ATTESTATION_HEADER);
  const pop = input.headers.get(CLIENT_ATTESTATION_POP_HEADER);
  if (!attestation || !pop) return { ok: false, error: 'attestation_malformed' };
  let allowlist: WalletAllowlist;
  try {
    allowlist = await loadWalletAllowlist(input.env, input.tenantId);
  } catch {
    return { ok: false, error: 'wallet_allowlist_unavailable' };
  }
  // The wallet type the request names picks the roots, and only its own roots are tried: another
  // wallet type's root never vouches for it, and the order of entries cannot matter.
  const candidate = allowlist.entries.find(
    (entry) => entry.enabled && entry.clientId === input.clientId
  );
  if (!candidate) return { ok: false, error: 'wallet_not_allowed' };
  const roots = candidate.attestationRoots;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const result = await verifyWalletAttestation({
    attestation,
    pop,
    audience: input.issuer,
    anchors: roots,
    now,
    clientId: input.clientId,
    consumeJti: (jti, ttl) => consumeReplay(input.env, input.tenantId, jti, ttl),
  });
  if (!result.ok) return { ok: false, error: result.error };
  // The wallet type must be on the list, and the chain must end at one of *its own* roots: a root
  // trusted for one wallet type does not vouch for another.
  const entry = allowlist.entries.find(
    (candidate) => candidate.enabled && candidate.clientId === result.clientId
  );
  if (!entry || !entry.attestationRoots.some((root) => root.sha256 === result.anchorSha256)) {
    return { ok: false, error: 'wallet_not_allowed' };
  }
  return {
    ok: true,
    client: walletEntryToClient(entry, input.tenantId, allowlist.updatedAt),
    entry,
    instanceKeyThumbprint: result.instanceKeyThumbprint,
    anchorSha256: result.anchorSha256,
  };
}

/** Whether a resolved client is a wallet type (authenticates by attestation only). */
export function isWalletClient(
  client: Pick<ClientMetadata, 'token_endpoint_auth_method'>
): boolean {
  return client.token_endpoint_auth_method === 'attest_jwt_client_auth';
}

/** Whether `scope` asks only for scopes a wallet may ask for (and at least one). */
export function walletScopeAllowed(scope: string | undefined): boolean {
  const scopes = (scope ?? '').split(' ').filter(Boolean);
  return (
    scopes.length > 0 &&
    scopes.every((value) => (WALLET_ALLOWLIST_SCOPES as readonly string[]).includes(value))
  );
}

// The read side lives in its own module (see its header); everything stays exported from here.
export * from './wallet-allowlist-read';
