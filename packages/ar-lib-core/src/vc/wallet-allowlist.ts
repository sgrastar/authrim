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
import { recordReplayJti } from '../utils/jti-replay-guard';
import {
  CLIENT_ATTESTATION_HEADER,
  CLIENT_ATTESTATION_POP_HEADER,
  loadWalletAttestationAnchors,
  verifyWalletAttestation,
  type AttestationFailure,
  type WalletAttestationAnchor,
} from './wallet-attestation';

export const WALLET_ALLOWLIST_SCOPES = ['authrim_admin_credential'] as const;
/** The credential scope: only an attestation-authenticated wallet may be granted it. */
export const WALLET_ONLY_SCOPE = 'authrim_admin_credential';
const MAX_ENTRIES = 16;
const MAX_ROOTS_PER_ENTRY = 8;
const MAX_REDIRECT_URIS = 8;

export interface WalletAllowlistEntry {
  /** The wallet type's identifier: the attestation `sub` and the OAuth `client_id`. */
  clientId: string;
  label: string;
  enabled: boolean;
  /** Roots a client attestation's chain may end at. */
  attestationRoots: WalletAttestationAnchor[];
  /** Roots a key attestation's chain may end at (used by the credential endpoint, S3). */
  keyAttestationRoots: WalletAttestationAnchor[];
  /** Redirect URIs the wallet may use (https app links or a registered custom scheme). */
  redirectUris: string[];
}

export interface WalletAllowlist {
  version: 1;
  /** Epoch ms of the last change. */
  updatedAt: number;
  /** Counts changes; an update names the revision it was made against. */
  revision: number;
  entries: WalletAllowlistEntry[];
}

export const EMPTY_WALLET_ALLOWLIST: WalletAllowlist = {
  version: 1,
  updatedAt: 0,
  revision: 0,
  entries: [],
};

const HEX64 = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRoots(value: unknown): WalletAttestationAnchor[] | null {
  if (!Array.isArray(value) || value.length > MAX_ROOTS_PER_ENTRY) return null;
  const roots: WalletAttestationAnchor[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { certificate, sha256, label } = item;
    if (typeof certificate !== 'string' || typeof sha256 !== 'string') return null;
    if (!HEX64.test(sha256) || (label !== undefined && typeof label !== 'string')) return null;
    roots.push({ certificate, sha256, ...(label ? { label: label.slice(0, 100) } : {}) });
  }
  return roots;
}

function validRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    // https app links only: the callback is where an authorization code is delivered.
    const url = new URL(value);
    return url.protocol === 'https:' && !url.hash;
  } catch {
    return false;
  }
}

/** Validates a stored or submitted list; anything unexpected is an error, never dropped. */
export async function parseWalletAllowlist(value: unknown): Promise<WalletAllowlist> {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error('wallet_allowlist_invalid');
  }
  if (value.entries.length > MAX_ENTRIES) throw new Error('wallet_allowlist_too_many_entries');
  const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : 0;
  const revision =
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
      ? value.revision
      : 0;
  const seen = new Set<string>();
  const entries: WalletAllowlistEntry[] = [];
  for (const raw of value.entries) {
    if (!isRecord(raw)) throw new Error('wallet_allowlist_invalid');
    const { clientId, label, enabled } = raw;
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(clientId)) {
      throw new Error('wallet_allowlist_client_id_invalid');
    }
    if (seen.has(clientId)) throw new Error('wallet_allowlist_duplicate_client_id');
    seen.add(clientId);
    const attestationRoots = parseRoots(raw.attestationRoots);
    const keyAttestationRoots = parseRoots(raw.keyAttestationRoots);
    if (
      typeof label !== 'string' ||
      typeof enabled !== 'boolean' ||
      !attestationRoots ||
      !keyAttestationRoots
    ) {
      throw new Error('wallet_allowlist_invalid');
    }
    const redirectUris = raw.redirectUris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.length > MAX_REDIRECT_URIS ||
      !redirectUris.every(validRedirectUri)
    ) {
      throw new Error('wallet_allowlist_redirect_uri_invalid');
    }
    // Every root must be a CA whose DER matches its pinned hash; an entry is all-or-nothing.
    await loadWalletAttestationAnchors([...attestationRoots, ...keyAttestationRoots]);
    if (enabled && attestationRoots.length === 0) throw new Error('wallet_allowlist_no_roots');
    entries.push({
      clientId,
      label: label.slice(0, 100),
      enabled,
      attestationRoots,
      keyAttestationRoots,
      redirectUris: [...redirectUris] as string[],
    });
  }
  return { version: 1, updatedAt, revision, entries };
}

export function walletAllowlistKey(tenantId: string): string {
  return `settings:tenant:${tenantId}:wallet-attestation-allowlist`;
}

/** Where the list lives: the tenant's settings store, which a tenant restore discards with the rest. */
function allowlistStore(env: Env): KVNamespace | undefined {
  return env.SETTINGS ?? env.AUTHRIM_CONFIG;
}

/**
 * The tenant's list. A missing record is the empty list; a stored record that does not validate is
 * an error (the caller refuses wallet authentication), never a silently smaller list.
 */
export async function loadWalletAllowlist(env: Env, tenantId: string): Promise<WalletAllowlist> {
  const kv = allowlistStore(env);
  if (!kv) return EMPTY_WALLET_ALLOWLIST;
  const raw = await kv.get(walletAllowlistKey(tenantId), 'text');
  if (raw === null) return EMPTY_WALLET_ALLOWLIST;
  return parseWalletAllowlist(JSON.parse(raw));
}

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

/** The virtual OAuth client a wallet type stands for. Never stored. */
export function walletEntryToClient(
  entry: WalletAllowlistEntry,
  tenantId: string,
  updatedAt: number
): ClientMetadata {
  return {
    client_id: entry.clientId,
    client_name: entry.label,
    redirect_uris: [...entry.redirectUris],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'attest_jwt_client_auth',
    application_type: 'native',
    require_pkce: true,
    dpop_bound_access_tokens: true,
    scope: WALLET_ALLOWLIST_SCOPES.join(' '),
    enabled: entry.enabled,
    created_at: updatedAt,
    updated_at: updatedAt,
    tenant_id: tenantId,
    subject_type: 'public',
  };
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

/**
 * The virtual client of a wallet type, for the client lookup that found no stored client. Null
 * when the tenant has no such enabled entry or its list cannot be read; a wallet is never
 * resolved from anything but a valid list.
 */
export async function resolveWalletClient(
  env: Env,
  tenantId: string,
  clientId: string,
  options: { includeDisabled?: boolean } = {}
): Promise<ClientMetadata | null> {
  try {
    const allowlist = await loadWalletAllowlist(env, tenantId);
    const entry = allowlist.entries.find((candidate) => candidate.clientId === clientId);
    if (!entry || (!entry.enabled && !options.includeDisabled)) return null;
    return walletEntryToClient(entry, tenantId, allowlist.updatedAt);
  } catch {
    return null;
  }
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
