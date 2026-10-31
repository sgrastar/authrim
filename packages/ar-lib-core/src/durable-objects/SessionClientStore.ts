import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { SESSION_MAX_TTL_DEFINITION } from '../services/session-ttl';
import { createLogger, type Logger } from '../utils/logger';

const SESSION_CLIENT_PREFIX = 'session-client:';
const SESSION_CLIENT_TENANT_KEY = 'session-client-context:tenant-id';
const SESSION_CLIENT_SESSION_KEY = 'session-client-context:session-id';
const OIDC_SID_ALIAS_TENANT_KEY = 'oidc-sid-alias:tenant-id';
const OIDC_SID_ALIAS_SID_KEY = 'oidc-sid-alias:oidc-sid';
const OIDC_SID_ALIAS_SESSION_KEY = 'oidc-sid-alias:session-id';
const EXPIRES_AT_KEY = 'session-client-store:expires-at';

/**
 * How long an instance keeps its data after the last registration (milliseconds). No session lasts
 * longer than session.max_ttl from sign-in, and every registration comes after sign-in, so a
 * session has ended by then. The highest value session.max_ttl accepts is used rather than the
 * tenant's: a tenant can raise it while sessions are live, and removing a live session's records
 * would leave its relying parties without a logout notice. A day is added because a logout reads
 * the records after its response, so one made just before the session's expiry still finds them.
 */
export const SESSION_CLIENT_STORE_RETENTION_MS =
  SESSION_MAX_TTL_DEFINITION.maxMs + 24 * 60 * 60 * 1000;

export interface SessionClientRecord {
  id: string;
  tenant_id: string;
  session_id: string;
  client_id: string;
  oidc_sid?: string;
  /** The sub the client's ID token carried (its identity mapping may issue a per-client one). */
  oidc_sub?: string;
  first_token_at: number;
  last_token_at: number;
  last_seen_at: number | null;
}

export interface RegisterSessionClientRequest {
  tenantId: string;
  sessionId: string;
  clientId: string;
  oidcSid?: string;
  /** The sub of the ID token just issued to the client, when one was. */
  oidcSub?: string;
  now?: number;
}

export interface UpdateSessionClientActivityRequest {
  tenantId: string;
  sessionId: string;
  clientId: string;
  now?: number;
}

export interface DeletedSessionClients {
  /** How many client records were removed. */
  deleted: number;
  /** The RP-facing sids those records carried: their alias instances point at the session. */
  oidcSids: string[];
}

interface SessionClientStorageTransaction {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
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
      await this.extendExpiry(txn);

      const existing = await txn.get<SessionClientRecord>(key);
      if (existing) {
        const updated: SessionClientRecord = {
          ...existing,
          last_token_at: now,
          ...(input.oidcSid ? { oidc_sid: normalizeRequired(input.oidcSid, 'oidc_sid') } : {}),
          ...(input.oidcSub ? { oidc_sub: input.oidcSub } : {}),
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
        ...(input.oidcSub ? { oidc_sub: input.oidcSub } : {}),
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
    await this.ensureExpiryScheduled();

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
    await this.extendExpiry(this.ctx.storage);
    return true;
  }

  /**
   * Remove everything this session's instance holds (client records, pinned context, expiry) once
   * the session has ended and its relying parties have been told. Returns the sids the records
   * carried, so the caller can remove their alias instances too.
   */
  async deleteSessionRpc(input: {
    tenantId: string;
    sessionId: string;
  }): Promise<DeletedSessionClients> {
    const tenantId = normalizeRequired(input.tenantId, 'tenant_id');
    const sessionId = normalizeRequired(input.sessionId, 'session_id');
    await this.assertPinnedContext(tenantId, sessionId);

    const entries = await this.ctx.storage.list<SessionClientRecord>({
      prefix: SESSION_CLIENT_PREFIX,
    });
    const oidcSids = [
      ...new Set(
        [...entries.values()]
          .map((record) => record.oidc_sid)
          .filter((oidcSid): oidcSid is string => typeof oidcSid === 'string' && oidcSid !== '')
      ),
    ];
    await this.removeAll();
    return { deleted: entries.size, oidcSids };
  }

  /**
   * Remove an oidc sid alias instance, only when it points at `sessionId`: an alias of another
   * session is left alone. Returns whether it was removed.
   */
  async deleteOidcSidAliasRpc(input: {
    tenantId: string;
    oidcSid: string;
    sessionId: string;
  }): Promise<boolean> {
    const tenantId = normalizeRequired(input.tenantId, 'tenant_id');
    const oidcSid = normalizeRequired(input.oidcSid, 'oidc_sid');
    const sessionId = normalizeRequired(input.sessionId, 'session_id');
    const [storedTenantId, storedOidcSid, storedSessionId] = await Promise.all([
      this.ctx.storage.get<string>(OIDC_SID_ALIAS_TENANT_KEY),
      this.ctx.storage.get<string>(OIDC_SID_ALIAS_SID_KEY),
      this.ctx.storage.get<string>(OIDC_SID_ALIAS_SESSION_KEY),
    ]);
    if (storedTenantId !== tenantId || storedOidcSid !== oidcSid || storedSessionId !== sessionId) {
      return false;
    }
    await this.removeAll();
    return true;
  }

  /**
   * Expiry: remove the instance's data once the retention after its last registration has passed.
   * A registration made after this alarm was set moved the expiry later; the alarm is then set
   * again for it instead.
   */
  async alarm(): Promise<void> {
    const expiresAt = await this.ctx.storage.get<number>(EXPIRES_AT_KEY);
    if (typeof expiresAt === 'number' && expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(expiresAt);
      return;
    }
    await this.removeAll();
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
      await this.extendExpiry(txn);
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
    await this.ensureExpiryScheduled();
    return storedSessionId ?? null;
  }

  /** Move the expiry to the retention from now (never earlier) and set the alarm for it. */
  private async extendExpiry(storage: SessionClientStorageTransaction): Promise<void> {
    const stored = await storage.get<number>(EXPIRES_AT_KEY);
    const expiresAt = Math.max(
      Date.now() + SESSION_CLIENT_STORE_RETENTION_MS,
      typeof stored === 'number' ? stored : 0
    );
    await storage.put(EXPIRES_AT_KEY, expiresAt);
    await storage.setAlarm(expiresAt);
  }

  /**
   * Data written before the store had an expiry has none: give it one when it is read, so it
   * does not stay forever. A read never moves an existing expiry.
   */
  private async ensureExpiryScheduled(): Promise<void> {
    if ((await this.ctx.storage.get<number>(EXPIRES_AT_KEY)) !== undefined) {
      return;
    }
    const keys = await this.ctx.storage.list({ limit: 1 });
    if (keys.size === 0) {
      return;
    }
    await this.extendExpiry(this.ctx.storage);
  }

  /**
   * Data first, alarm last: when removing the data fails, the alarm is still set and removes it
   * later. An alarm left after the data is gone finds no expiry and removes nothing more.
   */
  private async removeAll(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
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
