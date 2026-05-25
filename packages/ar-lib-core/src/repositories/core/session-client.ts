/**
 * Session-Client Repository
 *
 * Repository for tracking which clients (RPs) have been issued tokens for each session.
 * Used for Backchannel Logout to determine which RPs to notify when a user logs out.
 *
 * Key features:
 * - Records session-client associations when tokens are issued
 * - Updates last_token_at on token refresh
 * - Updates last_seen_at on RP activity (userinfo, etc.)
 * - Retrieves all clients for a session (for logout notification)
 * - Cascade delete when session is deleted
 *
 * Table: session_clients
 * Schema:
 *   - id: TEXT PRIMARY KEY (UUID)
 *   - tenant_id: TEXT NOT NULL
 *   - session_id: TEXT NOT NULL (FK to sessions)
 *   - client_id: TEXT NOT NULL (FK to oauth_clients)
 *   - first_token_at: INTEGER NOT NULL (timestamp)
 *   - last_token_at: INTEGER NOT NULL (timestamp)
 *   - last_seen_at: INTEGER (timestamp, nullable)
 *
 * @packageDocumentation
 */

import { generateId, getCurrentTimestamp } from '../base';
import type { DatabaseAdapter } from '../../db/adapter';
import type { SessionClientWithWebhook } from '../../types/logout';
import { requireTenantId } from '../tenant';

/**
 * Session-Client association entity
 *
 * Represents the relationship between a user session and a client (RP)
 * that has been issued tokens for that session.
 */
export interface SessionClient {
  /** Unique ID (UUID) */
  id: string;
  /** Tenant ID this association belongs to */
  tenant_id: string;
  /** Session ID this association belongs to */
  session_id: string;
  /** Client ID (RP) that received tokens */
  client_id: string;
  /** Timestamp when first token was issued */
  first_token_at: number;
  /** Timestamp when last token was issued (updated on refresh) */
  last_token_at: number;
  /** Timestamp when RP last showed activity (nullable) */
  last_seen_at: number | null;
}

/**
 * Input for creating a new session-client association
 */
export interface CreateSessionClientInput {
  /** Optional ID (auto-generated if not provided) */
  id?: string;
  /** Tenant ID */
  tenant_id?: string;
  /** Session ID */
  session_id: string;
  /** Client ID (RP) */
  client_id: string;
}

/**
 * Input for updating a session-client association
 */
export interface UpdateSessionClientInput {
  /** Update last_token_at (e.g., on token refresh) */
  last_token_at?: number;
  /** Update last_seen_at (e.g., on userinfo call) */
  last_seen_at?: number;
}

/**
 * Session-Client with additional client information
 * Used for logout notification where we need client details
 */
export interface SessionClientWithDetails extends SessionClient {
  /** Client name (from oauth_clients) */
  client_name: string | null;
  /** Backchannel logout URI (from oauth_clients) */
  backchannel_logout_uri: string | null;
  /** Whether session ID is required in logout token */
  backchannel_logout_session_required: boolean;
  /** Frontchannel logout URI (from oauth_clients) */
  frontchannel_logout_uri: string | null;
  /** Whether session ID is required in frontchannel logout */
  frontchannel_logout_session_required: boolean;
}

/**
 * Database row type for session_clients table
 */
interface SessionClientRow {
  id: string;
  tenant_id: string;
  session_id: string;
  client_id: string;
  first_token_at: number;
  last_token_at: number;
  last_seen_at: number | null;
}

interface SessionClientLogoutDetailsRow {
  client_id: string;
  client_name: string | null;
  backchannel_logout_uri: string | null;
  backchannel_logout_session_required: number;
  frontchannel_logout_uri: string | null;
  frontchannel_logout_session_required: number;
  logout_webhook_uri: string | null;
  logout_webhook_secret_encrypted: string | null;
}

export interface HydratedSessionClientLogoutTargets {
  backchannelClients: SessionClientWithDetails[];
  frontchannelClients: SessionClientWithDetails[];
  webhookClients: SessionClientWithWebhook[];
}

/**
 * Session-Client Repository
 *
 * Provides CRUD operations for session-client associations.
 * Used for tracking which RPs have tokens for each session.
 */
export class SessionClientRepository {
  protected readonly adapter: DatabaseAdapter;
  protected readonly tenantId: string;

  constructor(adapter: DatabaseAdapter, tenantId: string) {
    this.adapter = adapter;
    this.tenantId = requireTenantId(tenantId, 'SessionClientRepository');
  }

  /**
   * Create a new session-client association
   *
   * If an association already exists for the session-client pair,
   * updates the last_token_at timestamp instead.
   *
   * @param input - Session-client creation input
   * @returns Created or updated session-client
   */
  async createOrUpdate(input: CreateSessionClientInput): Promise<SessionClient> {
    const now = getCurrentTimestamp();
    const tenantId = input.tenant_id
      ? requireTenantId(input.tenant_id, 'SessionClientRepository.createOrUpdate')
      : this.tenantId;
    if (tenantId !== this.tenantId) {
      throw new Error('SessionClientRepository tenant mismatch');
    }

    // Check if association already exists
    const existing = await this.findBySessionAndClient(input.session_id, input.client_id, tenantId);

    if (existing) {
      // Update last_token_at
      await this.adapter.execute(
        'UPDATE session_clients SET last_token_at = ? WHERE id = ? AND tenant_id = ?',
        [now, existing.id, tenantId]
      );
      return {
        ...existing,
        last_token_at: now,
      };
    }

    // Create new association
    const id = input.id ?? generateId();
    const sql = `
      INSERT INTO session_clients (id, tenant_id, session_id, client_id, first_token_at, last_token_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `;

    await this.adapter.execute(sql, [id, tenantId, input.session_id, input.client_id, now, now]);

    return {
      id,
      tenant_id: tenantId,
      session_id: input.session_id,
      client_id: input.client_id,
      first_token_at: now,
      last_token_at: now,
      last_seen_at: null,
    };
  }

  /**
   * Find session-client by ID
   *
   * @param id - Session-client ID
   * @returns Session-client or null if not found
   */
  async findById(id: string): Promise<SessionClient | null> {
    const sql = 'SELECT * FROM session_clients WHERE id = ? AND tenant_id = ?';
    const row = await this.adapter.queryOne<SessionClientRow>(sql, [id, this.tenantId]);
    return row ? this.rowToEntity(row) : null;
  }

  /**
   * Find session-client by session ID and client ID
   *
   * @param sessionId - Session ID
   * @param clientId - Client ID
   * @returns Session-client or null if not found
   */
  async findBySessionAndClient(
    sessionId: string,
    clientId: string,
    tenantId = this.tenantId
  ): Promise<SessionClient | null> {
    const normalizedTenantId = requireTenantId(
      tenantId,
      'SessionClientRepository.findBySessionAndClient'
    );
    if (normalizedTenantId !== this.tenantId) {
      throw new Error('SessionClientRepository tenant mismatch');
    }
    const sql =
      'SELECT * FROM session_clients WHERE tenant_id = ? AND session_id = ? AND client_id = ?';
    const row = await this.adapter.queryOne<SessionClientRow>(sql, [
      normalizedTenantId,
      sessionId,
      clientId,
    ]);
    return row ? this.rowToEntity(row) : null;
  }

  /**
   * Find all clients for a session
   *
   * @param sessionId - Session ID
   * @returns Array of session-clients
   */
  async findBySessionId(sessionId: string): Promise<SessionClient[]> {
    const sql =
      'SELECT * FROM session_clients WHERE tenant_id = ? AND session_id = ? ORDER BY first_token_at ASC';
    const rows = await this.adapter.query<SessionClientRow>(sql, [this.tenantId, sessionId]);
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Find all clients for a session with logout URIs
   *
   * This is the primary method used during logout to determine
   * which RPs need to receive logout notifications.
   *
   * @param sessionId - Session ID
   * @returns Array of session-clients with client details
   */
  async findBySessionIdWithLogoutUris(sessionId: string): Promise<SessionClientWithDetails[]> {
    const sql = `
      SELECT
        sc.id,
        sc.session_id,
        sc.client_id,
        sc.first_token_at,
        sc.last_token_at,
        sc.last_seen_at,
        c.client_name,
        c.backchannel_logout_uri,
        c.backchannel_logout_session_required,
        c.frontchannel_logout_uri,
        c.frontchannel_logout_session_required
      FROM session_clients sc
      JOIN oauth_clients c ON sc.tenant_id = c.tenant_id AND sc.client_id = c.client_id
      WHERE sc.tenant_id = ? AND sc.session_id = ?
      ORDER BY sc.first_token_at ASC
    `;

    const rows = await this.adapter.query<
      SessionClientRow & {
        client_name: string | null;
        backchannel_logout_uri: string | null;
        backchannel_logout_session_required: number;
        frontchannel_logout_uri: string | null;
        frontchannel_logout_session_required: number;
      }
    >(sql, [this.tenantId, sessionId]);

    return rows.map((row) => ({
      ...this.rowToEntity(row),
      client_name: row.client_name,
      backchannel_logout_uri: row.backchannel_logout_uri,
      backchannel_logout_session_required: Boolean(row.backchannel_logout_session_required),
      frontchannel_logout_uri: row.frontchannel_logout_uri,
      frontchannel_logout_session_required: Boolean(row.frontchannel_logout_session_required),
    }));
  }

  /**
   * Find all clients with backchannel logout URI for a session
   *
   * Optimized query that only returns clients that have
   * backchannel_logout_uri configured.
   *
   * @param sessionId - Session ID
   * @returns Array of session-clients with backchannel logout configured
   */
  async findBackchannelLogoutClients(sessionId: string): Promise<SessionClientWithDetails[]> {
    const sql = `
      SELECT
        sc.id,
        sc.session_id,
        sc.client_id,
        sc.first_token_at,
        sc.last_token_at,
        sc.last_seen_at,
        c.client_name,
        c.backchannel_logout_uri,
        c.backchannel_logout_session_required,
        c.frontchannel_logout_uri,
        c.frontchannel_logout_session_required
      FROM session_clients sc
      JOIN oauth_clients c ON sc.tenant_id = c.tenant_id AND sc.client_id = c.client_id
      WHERE sc.tenant_id = ? AND sc.session_id = ?
        AND c.backchannel_logout_uri IS NOT NULL
        AND c.backchannel_logout_uri != ''
      ORDER BY sc.first_token_at ASC
    `;

    const rows = await this.adapter.query<
      SessionClientRow & {
        client_name: string | null;
        backchannel_logout_uri: string | null;
        backchannel_logout_session_required: number;
        frontchannel_logout_uri: string | null;
        frontchannel_logout_session_required: number;
      }
    >(sql, [this.tenantId, sessionId]);

    return rows.map((row) => ({
      ...this.rowToEntity(row),
      client_name: row.client_name,
      backchannel_logout_uri: row.backchannel_logout_uri,
      backchannel_logout_session_required: Boolean(row.backchannel_logout_session_required),
      frontchannel_logout_uri: row.frontchannel_logout_uri,
      frontchannel_logout_session_required: Boolean(row.frontchannel_logout_session_required),
    }));
  }

  /**
   * Find all clients with frontchannel logout URI for a session
   *
   * Optimized query that only returns clients that have
   * frontchannel_logout_uri configured.
   *
   * @param sessionId - Session ID
   * @returns Array of session-clients with frontchannel logout configured
   */
  async findFrontchannelLogoutClients(sessionId: string): Promise<SessionClientWithDetails[]> {
    const sql = `
      SELECT
        sc.id,
        sc.session_id,
        sc.client_id,
        sc.first_token_at,
        sc.last_token_at,
        sc.last_seen_at,
        c.client_name,
        c.backchannel_logout_uri,
        c.backchannel_logout_session_required,
        c.frontchannel_logout_uri,
        c.frontchannel_logout_session_required
      FROM session_clients sc
      JOIN oauth_clients c ON sc.tenant_id = c.tenant_id AND sc.client_id = c.client_id
      WHERE sc.tenant_id = ? AND sc.session_id = ?
        AND c.frontchannel_logout_uri IS NOT NULL
        AND c.frontchannel_logout_uri != ''
      ORDER BY sc.first_token_at ASC
    `;

    const rows = await this.adapter.query<
      SessionClientRow & {
        client_name: string | null;
        backchannel_logout_uri: string | null;
        backchannel_logout_session_required: number;
        frontchannel_logout_uri: string | null;
        frontchannel_logout_session_required: number;
      }
    >(sql, [this.tenantId, sessionId]);

    return rows.map((row) => ({
      ...this.rowToEntity(row),
      client_name: row.client_name,
      backchannel_logout_uri: row.backchannel_logout_uri,
      backchannel_logout_session_required: Boolean(row.backchannel_logout_session_required),
      frontchannel_logout_uri: row.frontchannel_logout_uri,
      frontchannel_logout_session_required: Boolean(row.frontchannel_logout_session_required),
    }));
  }

  /**
   * Find all clients with logout webhook URI for a session
   *
   * Optimized query that only returns clients that have
   * logout_webhook_uri configured (Simple Logout Webhook - Authrim Extension).
   *
   * @param sessionId - Session ID
   * @returns Array of session-clients with webhook configuration
   */
  async findWebhookClients(sessionId: string): Promise<SessionClientWithWebhook[]> {
    const sql = `
      SELECT
        sc.id,
        sc.session_id,
        sc.client_id,
        c.client_name,
        c.logout_webhook_uri,
        c.logout_webhook_secret_encrypted
      FROM session_clients sc
      JOIN oauth_clients c ON sc.tenant_id = c.tenant_id AND sc.client_id = c.client_id
      WHERE sc.tenant_id = ? AND sc.session_id = ?
        AND c.logout_webhook_uri IS NOT NULL
        AND c.logout_webhook_uri != ''
      ORDER BY sc.first_token_at ASC
    `;

    const rows = await this.adapter.query<{
      id: string;
      session_id: string;
      client_id: string;
      client_name: string | null;
      logout_webhook_uri: string | null;
      logout_webhook_secret_encrypted: string | null;
    }>(sql, [this.tenantId, sessionId]);

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      client_id: row.client_id,
      client_name: row.client_name,
      logout_webhook_uri: row.logout_webhook_uri,
      logout_webhook_secret_encrypted: row.logout_webhook_secret_encrypted,
    }));
  }

  async hydrateLogoutTargetsFromSessionClients(
    sessionClients: SessionClient[]
  ): Promise<HydratedSessionClientLogoutTargets> {
    const tenantScopedClients = sessionClients.filter(
      (client) => client.tenant_id === this.tenantId
    );
    const clientIds = [...new Set(tenantScopedClients.map((client) => client.client_id))];
    if (clientIds.length === 0) {
      return {
        backchannelClients: [],
        frontchannelClients: [],
        webhookClients: [],
      };
    }

    const placeholders = clientIds.map(() => '?').join(', ');
    const rows = await this.adapter.query<SessionClientLogoutDetailsRow>(
      `
        SELECT
          client_id,
          client_name,
          backchannel_logout_uri,
          backchannel_logout_session_required,
          frontchannel_logout_uri,
          frontchannel_logout_session_required,
          logout_webhook_uri,
          logout_webhook_secret_encrypted
        FROM oauth_clients
        WHERE tenant_id = ? AND client_id IN (${placeholders})
      `,
      [this.tenantId, ...clientIds]
    );
    const detailsByClientId = new Map(rows.map((row) => [row.client_id, row]));
    const withDetails = tenantScopedClients.flatMap((client): SessionClientWithDetails[] => {
      const details = detailsByClientId.get(client.client_id);
      if (!details) {
        return [];
      }
      return [
        {
          ...client,
          client_name: details.client_name,
          backchannel_logout_uri: details.backchannel_logout_uri,
          backchannel_logout_session_required: Boolean(details.backchannel_logout_session_required),
          frontchannel_logout_uri: details.frontchannel_logout_uri,
          frontchannel_logout_session_required: Boolean(
            details.frontchannel_logout_session_required
          ),
        },
      ];
    });

    return {
      backchannelClients: withDetails.filter((client) => Boolean(client.backchannel_logout_uri)),
      frontchannelClients: withDetails.filter((client) => Boolean(client.frontchannel_logout_uri)),
      webhookClients: tenantScopedClients.flatMap((client): SessionClientWithWebhook[] => {
        const details = detailsByClientId.get(client.client_id);
        if (!details?.logout_webhook_uri) {
          return [];
        }
        return [
          {
            id: client.id,
            session_id: client.session_id,
            client_id: client.client_id,
            client_name: details.client_name,
            logout_webhook_uri: details.logout_webhook_uri,
            logout_webhook_secret_encrypted: details.logout_webhook_secret_encrypted,
          },
        ];
      }),
    };
  }

  /**
   * Find all sessions for a client
   *
   * Useful for admin purposes to see all active sessions for a client.
   *
   * @param clientId - Client ID
   * @returns Array of session-clients
   */
  async findByClientId(clientId: string): Promise<SessionClient[]> {
    const sql =
      'SELECT * FROM session_clients WHERE tenant_id = ? AND client_id = ? ORDER BY last_token_at DESC';
    const rows = await this.adapter.query<SessionClientRow>(sql, [this.tenantId, clientId]);
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Update last_seen_at timestamp
   *
   * Called when RP shows activity (e.g., userinfo request, token refresh).
   *
   * @param sessionId - Session ID
   * @param clientId - Client ID
   * @returns True if updated, false if not found
   */
  async updateLastSeen(sessionId: string, clientId: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const sql = `
      UPDATE session_clients
      SET last_seen_at = ?
      WHERE tenant_id = ? AND session_id = ? AND client_id = ?
    `;
    const result = await this.adapter.execute(sql, [now, this.tenantId, sessionId, clientId]);
    return result.rowsAffected > 0;
  }

  /**
   * Update last_token_at timestamp
   *
   * Called when a new token is issued (e.g., token refresh).
   *
   * @param sessionId - Session ID
   * @param clientId - Client ID
   * @returns True if updated, false if not found
   */
  async updateLastToken(sessionId: string, clientId: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const sql = `
      UPDATE session_clients
      SET last_token_at = ?
      WHERE tenant_id = ? AND session_id = ? AND client_id = ?
    `;
    const result = await this.adapter.execute(sql, [now, this.tenantId, sessionId, clientId]);
    return result.rowsAffected > 0;
  }

  /**
   * Delete a session-client association
   *
   * @param id - Session-client ID
   * @returns True if deleted, false if not found
   */
  async delete(id: string): Promise<boolean> {
    const sql = 'DELETE FROM session_clients WHERE id = ? AND tenant_id = ?';
    const result = await this.adapter.execute(sql, [id, this.tenantId]);
    return result.rowsAffected > 0;
  }

  /**
   * Delete all associations for a session
   *
   * Note: This is typically handled by CASCADE delete on the sessions table,
   * but can be called explicitly if needed.
   *
   * @param sessionId - Session ID
   * @returns Number of deleted associations
   */
  async deleteBySessionId(sessionId: string): Promise<number> {
    const sql = 'DELETE FROM session_clients WHERE tenant_id = ? AND session_id = ?';
    const result = await this.adapter.execute(sql, [this.tenantId, sessionId]);
    return result.rowsAffected;
  }

  /**
   * Delete all associations for a client
   *
   * Useful when a client is deleted or revoked.
   *
   * @param clientId - Client ID
   * @returns Number of deleted associations
   */
  async deleteByClientId(clientId: string): Promise<number> {
    const sql = 'DELETE FROM session_clients WHERE tenant_id = ? AND client_id = ?';
    const result = await this.adapter.execute(sql, [this.tenantId, clientId]);
    return result.rowsAffected;
  }

  /**
   * Count clients for a session
   *
   * @param sessionId - Session ID
   * @returns Number of clients
   */
  async countBySessionId(sessionId: string): Promise<number> {
    const sql =
      'SELECT COUNT(*) as count FROM session_clients WHERE tenant_id = ? AND session_id = ?';
    const result = await this.adapter.queryOne<{ count: number }>(sql, [this.tenantId, sessionId]);
    return result?.count ?? 0;
  }

  /**
   * Count sessions for a client
   *
   * @param clientId - Client ID
   * @returns Number of sessions
   */
  async countByClientId(clientId: string): Promise<number> {
    const sql =
      'SELECT COUNT(*) as count FROM session_clients WHERE tenant_id = ? AND client_id = ?';
    const result = await this.adapter.queryOne<{ count: number }>(sql, [this.tenantId, clientId]);
    return result?.count ?? 0;
  }

  /**
   * Find inactive clients (no activity for specified duration)
   *
   * Useful for identifying "dead" RPs that haven't been active
   * and can be skipped during logout notifications.
   *
   * @param sessionId - Session ID
   * @param inactiveDurationMs - Duration in milliseconds
   * @returns Array of inactive session-clients
   */
  async findInactiveClients(
    sessionId: string,
    inactiveDurationMs: number
  ): Promise<SessionClient[]> {
    const cutoff = getCurrentTimestamp() - inactiveDurationMs;
    const sql = `
      SELECT * FROM session_clients
      WHERE tenant_id = ? AND session_id = ?
        AND (last_seen_at IS NULL OR last_seen_at < ?)
      ORDER BY first_token_at ASC
    `;
    const rows = await this.adapter.query<SessionClientRow>(sql, [
      this.tenantId,
      sessionId,
      cutoff,
    ]);
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Convert database row to SessionClient entity
   */
  private rowToEntity(row: SessionClientRow): SessionClient {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      session_id: row.session_id,
      client_id: row.client_id,
      first_token_at: row.first_token_at,
      last_token_at: row.last_token_at,
      last_seen_at: row.last_seen_at,
    };
  }
}
