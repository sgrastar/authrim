import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { createLogger, type Logger } from '../utils/logger';

const SESSION_CLIENT_PREFIX = 'session-client:';
const SESSION_CLIENT_TENANT_KEY = 'session-client-context:tenant-id';
const SESSION_CLIENT_SESSION_KEY = 'session-client-context:session-id';
const OIDC_SID_ALIAS_TENANT_KEY = 'oidc-sid-alias:tenant-id';
const OIDC_SID_ALIAS_SID_KEY = 'oidc-sid-alias:oidc-sid';
const OIDC_SID_ALIAS_SESSION_KEY = 'oidc-sid-alias:session-id';

export interface SessionClientRecord {
  id: string;
  tenant_id: string;
  session_id: string;
  client_id: string;
  oidc_sid?: string;
  first_token_at: number;
  last_token_at: number;
  last_seen_at: number | null;
}

export interface RegisterSessionClientRequest {
  tenantId: string;
  sessionId: string;
  clientId: string;
  oidcSid?: string;
  now?: number;
}

export interface UpdateSessionClientActivityRequest {
  tenantId: string;
  sessionId: string;
  clientId: string;
  now?: number;
}

interface SessionClientStorageTransaction {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
}

function normalizeRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`session_client_store_missing_${field}`);
  }
  return normalized;
}

function clientKey(clientId: string): string {
  return `${SESSION_CLIENT_PREFIX}${clientId}`;
}

export class SessionClientStore extends DurableObject<Env> {
  private readonly log: Logger = createLogger().module('SessionClientStore');

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async registerClientRpc(input: RegisterSessionClientRequest): Promise<SessionClientRecord> {
    const tenantId = normalizeRequired(input.tenantId, 'tenant_id');
    const sessionId = normalizeRequired(input.sessionId, 'session_id');
    const clientId = normalizeRequired(input.clientId, 'client_id');
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const key = clientKey(clientId);

    return this.ctx.storage.transaction(async (txn) => {
      await this.ensurePinnedContext(txn, tenantId, sessionId);

      const existing = await txn.get<SessionClientRecord>(key);
      if (existing) {
        const updated: SessionClientRecord = {
          ...existing,
          last_token_at: now,
          ...(input.oidcSid ? { oidc_sid: normalizeRequired(input.oidcSid, 'oidc_sid') } : {}),
        };
        await txn.put(key, updated);
        return updated;
      }

      const created: SessionClientRecord = {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        session_id: sessionId,
        client_id: clientId,
        ...(input.oidcSid ? { oidc_sid: normalizeRequired(input.oidcSid, 'oidc_sid') } : {}),
        first_token_at: now,
        last_token_at: now,
        last_seen_at: null,
      };
      await txn.put(key, created);
      return created;
    });
  }

  async listClientsRpc(input: {
    tenantId: string;
    sessionId: string;
  }): Promise<SessionClientRecord[]> {
    const tenantId = normalizeRequired(input.tenantId, 'tenant_id');
    const sessionId = normalizeRequired(input.sessionId, 'session_id');
    await this.assertPinnedContext(tenantId, sessionId);

    const entries = await this.ctx.storage.list<SessionClientRecord>({
      prefix: SESSION_CLIENT_PREFIX,
    });
    return [...entries.values()].sort((left, right) => left.first_token_at - right.first_token_at);
  }

  async updateLastSeenRpc(input: UpdateSessionClientActivityRequest): Promise<boolean> {
    const tenantId = normalizeRequired(input.tenantId, 'tenant_id');
    const sessionId = normalizeRequired(input.sessionId, 'session_id');
    const clientId = normalizeRequired(input.clientId, 'client_id');
    const now = input.now ?? Math.floor(Date.now() / 1000);
    await this.assertPinnedContext(tenantId, sessionId);

    const key = clientKey(clientId);
    const existing = await this.ctx.storage.get<SessionClientRecord>(key);
    if (!existing) {
      return false;
    }

    await this.ctx.storage.put(key, {
      ...existing,
      last_seen_at: now,
    });
    return true;
  }

  async deleteSessionRpc(input: { tenantId: string; sessionId: string }): Promise<number> {
    const tenantId = normalizeRequired(input.tenantId, 'tenant_id');
    const sessionId = normalizeRequired(input.sessionId, 'session_id');
    await this.assertPinnedContext(tenantId, sessionId);

    const entries = await this.ctx.storage.list<SessionClientRecord>({
      prefix: SESSION_CLIENT_PREFIX,
    });
    const deleted = await this.ctx.storage.delete([...entries.keys()]);
    return typeof deleted === 'number' ? deleted : entries.size;
  }

  async registerOidcSidAliasRpc(input: {
    tenantId: string;
    oidcSid: string;
    sessionId: string;
  }): Promise<void> {
    const tenantId = normalizeRequired(input.tenantId, 'tenant_id');
    const oidcSid = normalizeRequired(input.oidcSid, 'oidc_sid');
    const sessionId = normalizeRequired(input.sessionId, 'session_id');

    await this.ctx.storage.transaction(async (txn) => {
      const [storedTenantId, storedOidcSid, storedSessionId] = await Promise.all([
        txn.get<string>(OIDC_SID_ALIAS_TENANT_KEY),
        txn.get<string>(OIDC_SID_ALIAS_SID_KEY),
        txn.get<string>(OIDC_SID_ALIAS_SESSION_KEY),
      ]);
      if (
        (storedTenantId && storedTenantId !== tenantId) ||
        (storedOidcSid && storedOidcSid !== oidcSid) ||
        (storedSessionId && storedSessionId !== sessionId)
      ) {
        throw new Error('session_client_store_oidc_sid_alias_mismatch');
      }
      await txn.put({
        [OIDC_SID_ALIAS_TENANT_KEY]: tenantId,
        [OIDC_SID_ALIAS_SID_KEY]: oidcSid,
        [OIDC_SID_ALIAS_SESSION_KEY]: sessionId,
      });
    });
  }

  async resolveOidcSidAliasRpc(input: {
    tenantId: string;
    oidcSid: string;
  }): Promise<string | null> {
    const tenantId = normalizeRequired(input.tenantId, 'tenant_id');
    const oidcSid = normalizeRequired(input.oidcSid, 'oidc_sid');
    const [storedTenantId, storedOidcSid, storedSessionId] = await Promise.all([
      this.ctx.storage.get<string>(OIDC_SID_ALIAS_TENANT_KEY),
      this.ctx.storage.get<string>(OIDC_SID_ALIAS_SID_KEY),
      this.ctx.storage.get<string>(OIDC_SID_ALIAS_SESSION_KEY),
    ]);
    if (storedTenantId !== tenantId || storedOidcSid !== oidcSid) {
      return null;
    }
    return storedSessionId ?? null;
  }

  private async ensurePinnedContext(
    txn: SessionClientStorageTransaction,
    tenantId: string,
    sessionId: string
  ): Promise<void> {
    const [storedTenantId, storedSessionId] = await Promise.all([
      txn.get<string>(SESSION_CLIENT_TENANT_KEY),
      txn.get<string>(SESSION_CLIENT_SESSION_KEY),
    ]);

    if (storedTenantId && storedTenantId !== tenantId) {
      this.log.error('SessionClientStore tenant mismatch', { tenantId, storedTenantId });
      throw new Error('session_client_store_tenant_mismatch');
    }
    if (storedSessionId && storedSessionId !== sessionId) {
      this.log.error('SessionClientStore session mismatch', { sessionId, storedSessionId });
      throw new Error('session_client_store_session_mismatch');
    }

    if (!storedTenantId || !storedSessionId) {
      await txn.put({
        [SESSION_CLIENT_TENANT_KEY]: tenantId,
        [SESSION_CLIENT_SESSION_KEY]: sessionId,
      });
    }
  }

  private async assertPinnedContext(tenantId: string, sessionId: string): Promise<void> {
    const [storedTenantId, storedSessionId] = await Promise.all([
      this.ctx.storage.get<string>(SESSION_CLIENT_TENANT_KEY),
      this.ctx.storage.get<string>(SESSION_CLIENT_SESSION_KEY),
    ]);

    if (!storedTenantId && !storedSessionId) {
      return;
    }
    if (storedTenantId !== tenantId || storedSessionId !== sessionId) {
      throw new Error('session_client_store_context_mismatch');
    }
  }
}
