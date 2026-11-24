import { vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';

export const NOW = 1_700_000_000_000;

export interface Stmt {
  sql: string;
  params: unknown[];
}

export interface Handlers {
  query?: (sql: string, params: unknown[]) => unknown[];
  queryOne?: (sql: string, params: unknown[]) => unknown;
  execute?: (sql: string, params: unknown[]) => unknown;
  batch?: (statements: Stmt[]) => unknown;
}

export function makeAdapter(handlers: Handlers = {}) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) =>
    handlers.query ? handlers.query(sql, params) : []
  );
  const queryOne = vi.fn(async (sql: string, params: unknown[] = []) =>
    handlers.queryOne ? handlers.queryOne(sql, params) : null
  );
  const execute = vi.fn(async (sql: string, params: unknown[] = []) =>
    handlers.execute ? handlers.execute(sql, params) : { success: true, rowsAffected: 1 }
  );
  const batch = vi.fn(async (statements: Stmt[]) =>
    handlers.batch ? handlers.batch(statements) : []
  );
  const adapter = { query, queryOne, execute, batch } as unknown as DatabaseAdapter;
  return { adapter, query, queryOne, execute, batch };
}

export function principalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'amp_1',
    client_id: 'client-1',
    display_name: 'Principal One',
    description: 'desc',
    principal_type: 'automation',
    status: 'active',
    default_audience: 'aud-x',
    token_ttl_seconds: 123,
    created_by_actor_type: 'admin',
    created_by_actor_id: 'a-1',
    created_at: 11,
    updated_at: 12,
    disabled_at: 13,
    disabled_by_actor_type: 'dt',
    disabled_by_actor_id: 'di',
    ...overrides,
  };
}

export function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'amk_1',
    principal_id: 'amp_1',
    kid: 'kid-1',
    public_jwk_json: '{"kty":"EC"}',
    alg: 'ES256',
    display_name: 'Key One',
    description: 'cdesc',
    status: 'active',
    not_before: 21,
    expires_at: 22,
    last_used_at: 23,
    last_used_ip: '10.0.0.1',
    last_used_user_agent: 'ua',
    created_by_actor_type: 'cat',
    created_by_actor_id: 'cai',
    created_at: 24,
    updated_at: 25,
    revoked_at: 26,
    revoked_by_actor_type: 'rat',
    revoked_by_actor_id: 'rai',
    revoke_reason: 'because',
    ...overrides,
  };
}

export const PRINCIPAL_MODEL = {
  id: 'amp_1',
  clientId: 'client-1',
  displayName: 'Principal One',
  description: 'desc',
  principalType: 'automation',
  status: 'active',
  defaultAudience: 'aud-x',
  tokenTtlSeconds: 123,
  createdByActorType: 'admin',
  createdByActorId: 'a-1',
  createdAt: 11,
  updatedAt: 12,
  disabledAt: 13,
  disabledByActorType: 'dt',
  disabledByActorId: 'di',
};

export const CREDENTIAL_MODEL = {
  id: 'amk_1',
  principalId: 'amp_1',
  kid: 'kid-1',
  publicJwkJson: '{"kty":"EC"}',
  alg: 'ES256',
  displayName: 'Key One',
  description: 'cdesc',
  status: 'active',
  notBefore: 21,
  expiresAt: 22,
  lastUsedAt: 23,
  lastUsedIp: '10.0.0.1',
  lastUsedUserAgent: 'ua',
  createdByActorType: 'cat',
  createdByActorId: 'cai',
  createdAt: 24,
  updatedAt: 25,
  revokedAt: 26,
  revokedByActorType: 'rat',
  revokedByActorId: 'rai',
  revokeReason: 'because',
};
