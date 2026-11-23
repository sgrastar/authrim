/**
 * The read side of the tenant's wallet allowlist (design D, S2): the list's types and validation,
 * loading it from the settings store, and the virtual OAuth client a wallet type stands for.
 *
 * Kept free of the audit log, the replay guard and the attestation verifier, so the client lookup
 * (`utils/kv.ts`) can import it statically. A dynamic import there made the bundler wrap hundreds
 * of modules in lazy initialisers, which broke start-up order of workers that bundle zod.
 */

import type { ClientMetadata } from '../types/oidc';
import type { Env } from '../types/env';
import { loadWalletAttestationAnchors, type WalletAttestationAnchor } from './wallet-attestation';

export const WALLET_ALLOWLIST_SCOPES = ['authrim_admin_credential'] as const;
/** The credential scope: only an attestation-authenticated wallet may be granted it. */
export const WALLET_ONLY_SCOPE = 'authrim_admin_credential';
export const MAX_ENTRIES = 16;
export const MAX_ROOTS_PER_ENTRY = 8;
export const MAX_REDIRECT_URIS = 8;

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
export function allowlistStore(env: Env): KVNamespace | undefined {
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
