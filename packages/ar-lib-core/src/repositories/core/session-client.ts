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

/**
 * Session-Client association entity
 *
 * Represents the relationship between a user session and a client (RP)
 * that has been issued tokens for that session.
 */
export interface SessionClient {
  /** Unique ID (UUID) */
  id: string;
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
  session_id: string;
  client_id: string;
  first_token_at: number;
  last_token_at: number;
  last_seen_at: number | null;
}

/**
 * Session-Client Repository
 *
 * Provides CRUD operations for session-client associations.
 * Used for tracking which RPs have tokens for each session.
 */
export class SessionClientRepository {
  protected readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
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

    // Check if association already exists
    const existing = await this.findBySessionAndClient(input.session_id, input.client_id);

    if (existing) {
      // Update last_token_at
      await this.adapter.execute('UPDATE session_clients SET last_token_at = ? WHERE id = ?', [
        now,
        existing.id,
      ]);
      return {
        ...existing,
        last_token_at: now,
      };
    }

    // Create new association
    const id = input.id ?? generateId();
    const sql = `
      INSERT INTO session_clients (id, session_id, client_id, first_token_at, last_token_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `;

    await this.adapter.execute(sql, [id, input.session_id, input.client_id, now, now]);

    return {
      id,
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
    const sql = 'SELECT * FROM session_clients WHERE id = ?';
    const row = await this.adapter.queryOne<SessionClientRow>(sql, [id]);
    return row ? this.rowToEntity(row) : null;
  }

  /**
   * Find session-client by session ID and client ID
   *
   * @param sessionId - Session ID
   * @param clientId - Client ID
   * @returns Session-client or null if not found
   */
  async findBySessionAndClient(sessionId: string, clientId: string): Promise<SessionClient | null> {
    const sql = 'SELECT * FROM session_clients WHERE session_id = ? AND client_id = ?';
    const row = await this.adapter.queryOne<SessionClientRow>(sql, [sessionId, clientId]);
    return row ? this.rowToEntity(row) : null;
  }

  /**
   * Find all clients for a session
   *
   * @param sessionId - Session ID
   * @returns Array of session-clients
   */
  async findBySessionId(sessionId: string): Promise<SessionClient[]> {
    const sql = 'SELECT * FROM session_clients WHERE session_id = ? ORDER BY first_token_at ASC';
    const rows = await this.adapter.query<SessionClientRow>(sql, [sessionId]);
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
      JOIN oauth_clients c ON sc.client_id = c.client_id
      WHERE sc.session_id = ?
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
    >(sql, [sessionId]);

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
      JOIN oauth_clients c ON sc.client_id = c.client_id
      WHERE sc.session_id = ?
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
    >(sql, [sessionId]);

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
      JOIN oauth_clients c ON sc.client_id = c.client_id
      WHERE sc.session_id = ?
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
    >(sql, [sessionId]);

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
      JOIN oauth_clients c ON sc.client_id = c.client_id
      WHERE sc.session_id = ?
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
    }>(sql, [sessionId]);

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      client_id: row.client_id,
      client_name: row.client_name,
      logout_webhook_uri: row.logout_webhook_uri,
      logout_webhook_secret_encrypted: row.logout_webhook_secret_encrypted,
    }));
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
    const sql = 'SELECT * FROM session_clients WHERE client_id = ? ORDER BY last_token_at DESC';
    const rows = await this.adapter.query<SessionClientRow>(sql, [clientId]);
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
      WHERE session_id = ? AND client_id = ?
    `;
    const result = await this.adapter.execute(sql, [now, sessionId, clientId]);
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
      WHERE session_id = ? AND client_id = ?
    `;
    const result = await this.adapter.execute(sql, [now, sessionId, clientId]);
    return result.rowsAffected > 0;
  }

  /**
   * Delete a session-client association
   *
   * @param id - Session-client ID
   * @returns True if deleted, false if not found
   */
  async delete(id: string): Promise<boolean> {
    const sql = 'DELETE FROM session_clients WHERE id = ?';
    const result = await this.adapter.execute(sql, [id]);
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
    const sql = 'DELETE FROM session_clients WHERE session_id = ?';
    const result = await this.adapter.execute(sql, [sessionId]);
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
    const sql = 'DELETE FROM session_clients WHERE client_id = ?';
    const result = await this.adapter.execute(sql, [clientId]);
    return result.rowsAffected;
  }

  /**
   * Count clients for a session
   *
   * @param sessionId - Session ID
   * @returns Number of clients
   */
  async countBySessionId(sessionId: string): Promise<number> {
    const sql = 'SELECT COUNT(*) as count FROM session_clients WHERE session_id = ?';
    const result = await this.adapter.queryOne<{ count: number }>(sql, [sessionId]);
    return result?.count ?? 0;
  }

  /**
   * Count sessions for a client
   *
   * @param clientId - Client ID
   * @returns Number of sessions
   */
  async countByClientId(clientId: string): Promise<number> {
    const sql = 'SELECT COUNT(*) as count FROM session_clients WHERE client_id = ?';
    const result = await this.adapter.queryOne<{ count: number }>(sql, [clientId]);
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
      WHERE session_id = ?
        AND (last_seen_at IS NULL OR last_seen_at < ?)
      ORDER BY first_token_at ASC
    `;
    const rows = await this.adapter.query<SessionClientRow>(sql, [sessionId, cutoff]);
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Convert database row to SessionClient entity
   */
  private rowToEntity(row: SessionClientRow): SessionClient {
    return {
      id: row.id,
      session_id: row.session_id,
      client_id: row.client_id,
      first_token_at: row.first_token_at,
      last_token_at: row.last_token_at,
      last_seen_at: row.last_seen_at,
    };
  }
}
