import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import type {
  AgentMcpExpiredSession,
  AgentMcpSessionRegistration,
  AgentMcpSessionRegistryPort,
} from '../ports';

interface ExpiredSessionRow {
  session_id: string;
  tenant_id: string;
  grant_id: string;
  client_id: string;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** DB_ADMIN-backed registry used to coordinate limits across per-session McpAgent objects. */
export class CloudflareAgentMcpSessionRegistry implements AgentMcpSessionRegistryPort {
  constructor(private readonly database: DatabaseAdapter) {}

  async register(
    input: AgentMcpSessionRegistration
  ): Promise<'registered' | 'limit_exceeded' | 'conflict'> {
    if (
      !input.sessionId ||
      !input.tenantId ||
      !input.grantId ||
      !input.clientId ||
      !input.actorSub ||
      !validTimestamp(input.createdAt) ||
      !validTimestamp(input.idleExpiresAt) ||
      !validTimestamp(input.absoluteExpiresAt) ||
      input.idleExpiresAt <= input.createdAt ||
      input.absoluteExpiresAt < input.idleExpiresAt ||
      !Number.isSafeInteger(input.maxConcurrentSessions) ||
      input.maxConcurrentSessions < 1
    ) {
      throw new TypeError('Invalid Agent MCP session registration');
    }

    const result = await this.database.execute(
      `INSERT OR IGNORE INTO admin_agent_mcp_sessions (
        session_id, tenant_id, grant_id, client_id, actor_sub,
        created_at, last_active_at, expires_at, absolute_expires_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (
        SELECT COUNT(*) FROM admin_agent_mcp_sessions
        WHERE tenant_id = ? AND grant_id = ? AND client_id = ? AND expires_at > ?
      ) < ?`,
      [
        input.sessionId,
        input.tenantId,
        input.grantId,
        input.clientId,
        input.actorSub,
        input.createdAt,
        input.createdAt,
        input.idleExpiresAt,
        input.absoluteExpiresAt,
        input.tenantId,
        input.grantId,
        input.clientId,
        input.createdAt,
        input.maxConcurrentSessions,
      ]
    );
    if (result.rowsAffected === 1) return 'registered';
    const conflictingId = await this.database.queryOne<{ session_id: string }>(
      'SELECT session_id FROM admin_agent_mcp_sessions WHERE session_id = ?',
      [input.sessionId]
    );
    return conflictingId ? 'conflict' : 'limit_exceeded';
  }

  async touch(input: {
    sessionId: string;
    tenantId: string;
    grantId: string;
    clientId: string;
    now: number;
    idleExpiresAt: number;
  }): Promise<boolean> {
    if (
      !input.sessionId ||
      !input.tenantId ||
      !input.grantId ||
      !input.clientId ||
      !validTimestamp(input.now) ||
      !validTimestamp(input.idleExpiresAt) ||
      input.idleExpiresAt <= input.now
    ) {
      throw new TypeError('Invalid Agent MCP session touch');
    }
    const result = await this.database.execute(
      `UPDATE admin_agent_mcp_sessions
       SET last_active_at = ?, expires_at = MIN(absolute_expires_at, ?)
       WHERE session_id = ? AND tenant_id = ? AND grant_id = ? AND client_id = ?
         AND expires_at > ? AND absolute_expires_at > ?`,
      [
        input.now,
        input.idleExpiresAt,
        input.sessionId,
        input.tenantId,
        input.grantId,
        input.clientId,
        input.now,
        input.now,
      ]
    );
    return result.rowsAffected === 1;
  }

  async delete(input: {
    sessionId: string;
    tenantId: string;
    grantId: string;
    clientId: string;
  }): Promise<void> {
    await this.database.execute(
      `DELETE FROM admin_agent_mcp_sessions
       WHERE session_id = ? AND tenant_id = ? AND grant_id = ? AND client_id = ?`,
      [input.sessionId, input.tenantId, input.grantId, input.clientId]
    );
  }

  async listExpired(now: number, limit: number): Promise<AgentMcpExpiredSession[]> {
    if (!validTimestamp(now) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError('Invalid Agent MCP expired-session query');
    }
    const rows = await this.database.query<ExpiredSessionRow>(
      `SELECT session_id, tenant_id, grant_id, client_id
       FROM admin_agent_mcp_sessions
       WHERE expires_at <= ? OR absolute_expires_at <= ?
       ORDER BY expires_at ASC
       LIMIT ?`,
      [now, now, limit]
    );
    return rows.map((row) => ({
      sessionId: row.session_id,
      tenantId: row.tenant_id,
      grantId: row.grant_id,
      clientId: row.client_id,
    }));
  }
}
