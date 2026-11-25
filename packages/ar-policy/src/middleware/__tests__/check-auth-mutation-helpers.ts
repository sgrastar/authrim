/**
 * Helpers for the check-auth mutation tests (kept apart from the shared test helpers).
 */

import { vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { CheckAuthContext } from '../check-auth';

export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface StoredKeyRow {
  id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  allowed_operations: string;
  rate_limit_tier: string;
  is_active: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export async function keyRow(
  apiKey: string,
  overrides: Partial<StoredKeyRow> = {}
): Promise<StoredKeyRow> {
  return {
    id: 'key_1',
    tenant_id: 'tenant_a',
    client_id: 'client_a',
    name: 'Test key',
    key_hash: await sha256Hex(apiKey),
    key_prefix: apiKey.substring(0, 8),
    allowed_operations: JSON.stringify(['check', 'subscribe']),
    rate_limit_tier: 'strict',
    is_active: 1,
    expires_at: null,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
    ...overrides,
  };
}

/** A complete DatabaseAdapter whose `query` returns the given rows (or rejects). */
export function fakeAdapter(rows: unknown[], failure?: Error) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => {
    if (failure) throw failure;
    return rows;
  });
  const adapter = {
    query,
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn(),
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
  return { adapter, query };
}

export function fakeKv(
  store: Map<string, string> = new Map(),
  options: { failGet?: boolean; failPut?: boolean } = {}
) {
  const get = vi.fn(async (key: string) => {
    if (options.failGet) throw new Error('kv get failed');
    return store.get(key) ?? null;
  });
  const put = vi.fn(async (key: string, value: string, _options?: { expirationTtl: number }) => {
    if (options.failPut) throw new Error('kv put failed');
    store.set(key, value);
  });
  const cache = { get, put, delete: vi.fn() } as unknown as NonNullable<CheckAuthContext['cache']>;
  return { cache, get, put, store };
}

// -----------------------------------------------------------------------------
// Signed JWTs
// -----------------------------------------------------------------------------

export const ISSUER = 'https://auth.example.com';

export interface SigningKey {
  privateKey: CryptoKey;
  jwk: JWK;
}

export async function newSigningKey(jwkFields: Partial<JWK> = {}): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), ...jwkFields } };
}

/** A real ES256 (EC) signing key, for keys that must not be usable as RSA. */
export async function newEcSigningKey(jwkFields: Partial<JWK> = {}): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), alg: 'ES256', ...jwkFields } };
}

/** Claims of an Authrim access token: a subject, a token_use and a JWT ID. */
export const ACCESS_CLAIMS = {
  sub: 'user_1',
  token_use: 'access',
  jti: 'jti-1',
  client_id: 'client_1',
  tenant_id: 'tenant_1',
};

export async function signJwt(
  signer: CryptoKey,
  claims: Record<string, unknown>,
  options: { kid?: string; issuer?: string; audience?: string; expiresAt?: number | string } = {}
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader(options.kid ? { alg: 'RS256', kid: options.kid } : { alg: 'RS256' })
    .setIssuer(options.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? '1h');
  if (options.audience) jwt.setAudience(options.audience);
  return jwt.sign(signer);
}

export function jwtContext(keys: JWK[], extra: Partial<CheckAuthContext> = {}): CheckAuthContext {
  return {
    db: fakeAdapter([]).adapter,
    issuerUrl: ISSUER,
    jwks: { keys },
    ...extra,
  };
}
