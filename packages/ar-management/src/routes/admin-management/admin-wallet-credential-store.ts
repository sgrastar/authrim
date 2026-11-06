/**
 * Reads and revocations of admin credentials (`issued_credentials` rows of type
 * `https://authrim.com/credentials/admin/v1` in the admin's home tenant core DB), shared by the
 * self-service router and the admin-user router. Every status change goes through the one
 * ar-lib-core transition.
 */

import type { CredentialStatus, DatabaseAdapter } from '@authrim/ar-lib-core';
import { AdminSecondFactorRepository, transitionCredentialStatus } from '@authrim/ar-lib-core';

export const ADMIN_CREDENTIAL_TYPE = 'https://authrim.com/credentials/admin/v1';

/** Statuses a revocation may start from. */
export const REVOCABLE_STATUSES: CredentialStatus[] = ['pending', 'active', 'suspended'];

export const LIST_LIMIT = 50;

export interface OwnAdminCredential {
  id: string;
  status: 'active' | 'suspended' | 'revoked';
  issuedAt: number;
  expiresAt: number | null;
  holderKeyThumbprint?: string;
}

interface CredentialRow {
  public_id: string;
  status: string;
  holder_binding: string | null;
  created_at: number | string;
  expires_at: number | string | null;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * RFC 7638 SHA-256 thumbprint (base64url) of a public JWK; null when the key has no usable
 * required members. Only the required members are hashed, in lexicographic order.
 */
export async function jwkThumbprint(jwk: unknown): Promise<string | null> {
  if (typeof jwk !== 'object' || jwk === null) return null;
  const key = jwk as Record<string, unknown>;
  const members =
    key.kty === 'EC'
      ? ['crv', 'kty', 'x', 'y']
      : key.kty === 'OKP'
        ? ['crv', 'kty', 'x']
        : key.kty === 'RSA'
          ? ['e', 'kty', 'n']
          : null;
  if (!members) return null;
  const parts: string[] = [];
  for (const name of members) {
    const value = key[name];
    if (typeof value !== 'string' || !value) return null;
    parts.push(`${JSON.stringify(name)}:${JSON.stringify(value)}`);
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`{${parts.join(',')}}`)
  );
  return toBase64Url(new Uint8Array(digest));
}

async function thumbprintOf(holderBinding: string | null): Promise<string | undefined> {
  if (!holderBinding) return undefined;
  try {
    return (await jwkThumbprint(JSON.parse(holderBinding))) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Milliseconds from an epoch stored in seconds or milliseconds, or an ISO string. */
function toMillis(value: number | string | null): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e11 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** The admin's own credentials that were issued (active, suspended, revoked), newest first. */
export async function listOwnAdminCredentials(
  adapter: DatabaseAdapter,
  tenantId: string,
  adminUserId: string
): Promise<OwnAdminCredential[]> {
  const rows = await adapter.query<CredentialRow>(
    `SELECT public_id, status, holder_binding, created_at, expires_at
       FROM issued_credentials
      WHERE tenant_id = ? AND user_id = ? AND credential_type = ?
        AND status IN ('active', 'suspended', 'revoked')
      ORDER BY created_at DESC
      LIMIT ${LIST_LIMIT}`,
    [tenantId, adminUserId, ADMIN_CREDENTIAL_TYPE]
  );
  const items: OwnAdminCredential[] = [];
  for (const row of rows) {
    const holderKeyThumbprint = await thumbprintOf(row.holder_binding);
    items.push({
      id: row.public_id,
      status: row.status as OwnAdminCredential['status'],
      issuedAt: Number(row.created_at),
      expiresAt: toMillis(row.expires_at),
      ...(holderKeyThumbprint ? { holderKeyThumbprint } : {}),
    });
  }
  return items;
}

/** RFC 7638 thumbprint of an admin credential's holder key, or undefined. */
export async function holderThumbprintOfCredential(
  adapter: DatabaseAdapter,
  tenantId: string,
  credentialId: string
): Promise<string | undefined> {
  const row = await adapter.queryOne<{ holder_binding: string | null }>(
    `SELECT holder_binding FROM issued_credentials
      WHERE tenant_id = ? AND public_id = ? AND credential_type = ?`,
    [tenantId, credentialId, ADMIN_CREDENTIAL_TYPE]
  );
  return thumbprintOf(row?.holder_binding ?? null);
}

/**
 * Revoked admin credentials take their Keyring second factors with them: those keys can no
 * longer be presented, and the evidence and receipts they gave must stop counting now. Every
 * revoked credential of the admin is looked at, so a retry finishes what an earlier failure left
 * (an administrator's revocation: not bound by the minimum). Throws when it could not finish.
 */
export async function retireKeyringFactorsOfRevokedCredentials(
  coreAdapter: DatabaseAdapter,
  adminAdapter: DatabaseAdapter,
  tenantId: string,
  adminUserId: string
): Promise<void> {
  const rows = await coreAdapter.query<{ holder_binding: string | null }>(
    `SELECT holder_binding FROM issued_credentials
      WHERE tenant_id = ? AND user_id = ? AND credential_type = ? AND status = 'revoked'`,
    [tenantId, adminUserId, ADMIN_CREDENTIAL_TYPE]
  );
  const repository = new AdminSecondFactorRepository(adminAdapter);
  for (const row of rows) {
    const jkt = await thumbprintOf(row.holder_binding);
    if (jkt) await repository.revokeKeyringHolderKey(adminUserId, jkt);
  }
}

/** True when the credential is an admin credential of exactly this admin in this tenant. */
export async function isOwnAdminCredential(
  adapter: DatabaseAdapter,
  tenantId: string,
  adminUserId: string,
  credentialId: string
): Promise<boolean> {
  const row = await adapter.queryOne<{ public_id: string }>(
    `SELECT public_id FROM issued_credentials
      WHERE tenant_id = ? AND public_id = ? AND user_id = ? AND credential_type = ?`,
    [tenantId, credentialId, adminUserId, ADMIN_CREDENTIAL_TYPE]
  );
  return !!row;
}

/**
 * True when the credential is an active, unexpired admin credential of exactly this admin in this
 * tenant. Its row stays `active` past its expiry (`expires_at`, seconds), which the wallet's
 * presentation would then fail on: an expired credential counts as not active here too.
 */
export async function isActiveOwnAdminCredential(
  adapter: DatabaseAdapter,
  tenantId: string,
  adminUserId: string,
  credentialId: string,
  nowMs: number = Date.now()
): Promise<boolean> {
  const row = await adapter.queryOne<{ status: string; expires_at: number | null }>(
    `SELECT status, expires_at FROM issued_credentials
      WHERE tenant_id = ? AND public_id = ? AND user_id = ? AND credential_type = ?`,
    [tenantId, credentialId, adminUserId, ADMIN_CREDENTIAL_TYPE]
  );
  if (row?.status !== 'active') return false;
  return row.expires_at === null || row.expires_at === undefined
    ? true
    : Number(row.expires_at) * 1000 > nowMs;
}

export type RevocationOutcome =
  | 'revoked'
  | 'unchanged'
  | 'not_found'
  | 'not_allowed'
  | 'conflict'
  | 'error';

export interface RevocationResult {
  id: string;
  outcome: RevocationOutcome;
}

/** Revokes one credential through the single transition; never throws. */
export async function revokeAdminCredential(
  adapter: DatabaseAdapter,
  tenantId: string,
  credentialId: string
): Promise<RevocationOutcome> {
  try {
    const result = await transitionCredentialStatus(adapter, {
      tenantId,
      credentialId,
      from: REVOCABLE_STATUSES,
      to: 'revoked',
    });
    return result.outcome === 'changed' ? 'revoked' : result.outcome;
  } catch {
    return 'error';
  }
}

/** Every pending/active/suspended admin credential of the admin. */
export async function listRevocableAdminCredentialIds(
  adapter: DatabaseAdapter,
  tenantId: string,
  adminUserId: string
): Promise<string[]> {
  const rows = await adapter.query<{ public_id: string }>(
    `SELECT public_id FROM issued_credentials
      WHERE tenant_id = ? AND user_id = ? AND credential_type = ?
        AND status IN ('pending', 'active', 'suspended')`,
    [tenantId, adminUserId, ADMIN_CREDENTIAL_TYPE]
  );
  return rows.map((row) => row.public_id);
}

/** An outcome that leaves the credential revoked. */
export function endedRevoked(outcome: RevocationOutcome): boolean {
  return outcome === 'revoked' || outcome === 'unchanged';
}
