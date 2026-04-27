import type { DatabaseAdapter } from '../db/adapter';
import type { DatabaseSource } from '../db/adapter-source';
import { ensureOptionalDatabaseAdapter } from '../db/adapter-source';
import type { CIBARequestMetadata, CIBARequestRow } from '../types/oidc';

function mapCIBARequestRow(row: CIBARequestRow | null): CIBARequestMetadata | null {
  if (!row) {
    return null;
  }

  return {
    ...row,
    token_issued: row.token_issued === 1,
  };
}

export interface CIBARequestPersistenceAdapter {
  storeRequest(metadata: CIBARequestMetadata): Promise<void>;
  getByAuthReqId(authReqId: string): Promise<CIBARequestMetadata | null>;
  getByUserCode(userCode: string): Promise<CIBARequestMetadata | null>;
  getByLoginHint(loginHint: string, clientId: string): Promise<CIBARequestMetadata | null>;
  approveRequest(authReqId: string, userId: string, sub: string, nonce?: string): Promise<void>;
  denyRequest(authReqId: string): Promise<void>;
  updatePoll(authReqId: string, lastPollAt: number, pollCount: number): Promise<void>;
  markTokenIssued(authReqId: string, tokenIssuedAt: number): Promise<void>;
  deleteRequest(authReqId: string): Promise<void>;
  deleteExpired(nowMs: number): Promise<number>;
  getType(): string;
}

class DatabaseCIBARequestPersistenceAdapter implements CIBARequestPersistenceAdapter {
  constructor(private readonly db: DatabaseAdapter) {}

  async storeRequest(metadata: CIBARequestMetadata): Promise<void> {
    const updated = await this.db.execute(
      `UPDATE ciba_requests
          SET client_id = ?, scope = ?, login_hint = ?, login_hint_token = ?, id_token_hint = ?,
              binding_message = ?, user_code = ?, acr_values = ?, requested_expiry = ?, status = ?,
              delivery_mode = ?, client_notification_token = ?, client_notification_endpoint = ?,
              created_at = ?, expires_at = ?, last_poll_at = ?, poll_count = ?, interval = ?,
              user_id = ?, sub = ?, nonce = ?, token_issued = ?, token_issued_at = ?
        WHERE auth_req_id = ?`,
      [
        metadata.client_id,
        metadata.scope,
        metadata.login_hint ?? null,
        metadata.login_hint_token ?? null,
        metadata.id_token_hint ?? null,
        metadata.binding_message ?? null,
        metadata.user_code ?? null,
        metadata.acr_values ?? null,
        metadata.requested_expiry ?? null,
        metadata.status,
        metadata.delivery_mode,
        metadata.client_notification_token ?? null,
        metadata.client_notification_endpoint ?? null,
        metadata.created_at,
        metadata.expires_at,
        metadata.last_poll_at ?? null,
        metadata.poll_count ?? 0,
        metadata.interval,
        metadata.user_id ?? null,
        metadata.sub ?? null,
        metadata.nonce ?? null,
        metadata.token_issued ? 1 : 0,
        metadata.token_issued_at ?? null,
        metadata.auth_req_id,
      ]
    );

    if (updated.rowsAffected > 0) {
      return;
    }

    await this.db.execute(
      `INSERT INTO ciba_requests (
         auth_req_id, client_id, scope, login_hint, login_hint_token, id_token_hint,
         binding_message, user_code, acr_values, requested_expiry, status, delivery_mode,
         client_notification_token, client_notification_endpoint, created_at, expires_at,
         last_poll_at, poll_count, interval, user_id, sub, nonce, token_issued, token_issued_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        metadata.auth_req_id,
        metadata.client_id,
        metadata.scope,
        metadata.login_hint ?? null,
        metadata.login_hint_token ?? null,
        metadata.id_token_hint ?? null,
        metadata.binding_message ?? null,
        metadata.user_code ?? null,
        metadata.acr_values ?? null,
        metadata.requested_expiry ?? null,
        metadata.status,
        metadata.delivery_mode,
        metadata.client_notification_token ?? null,
        metadata.client_notification_endpoint ?? null,
        metadata.created_at,
        metadata.expires_at,
        metadata.last_poll_at ?? null,
        metadata.poll_count ?? 0,
        metadata.interval,
        metadata.user_id ?? null,
        metadata.sub ?? null,
        metadata.nonce ?? null,
        metadata.token_issued ? 1 : 0,
        metadata.token_issued_at ?? null,
      ]
    );
  }

  async getByAuthReqId(authReqId: string): Promise<CIBARequestMetadata | null> {
    const row = await this.db.queryOne<CIBARequestRow>(
      `SELECT auth_req_id, client_id, scope, login_hint, login_hint_token, id_token_hint,
              binding_message, user_code, acr_values, requested_expiry, status, delivery_mode,
              client_notification_token, client_notification_endpoint, created_at, expires_at,
              last_poll_at, poll_count, interval, user_id, sub, nonce, token_issued, token_issued_at
         FROM ciba_requests
        WHERE auth_req_id = ?`,
      [authReqId]
    );

    return mapCIBARequestRow(row);
  }

  async getByUserCode(userCode: string): Promise<CIBARequestMetadata | null> {
    const row = await this.db.queryOne<CIBARequestRow>(
      `SELECT auth_req_id, client_id, scope, login_hint, login_hint_token, id_token_hint,
              binding_message, user_code, acr_values, requested_expiry, status, delivery_mode,
              client_notification_token, client_notification_endpoint, created_at, expires_at,
              last_poll_at, poll_count, interval, user_id, sub, nonce, token_issued, token_issued_at
         FROM ciba_requests
        WHERE user_code = ?`,
      [userCode]
    );

    return mapCIBARequestRow(row);
  }

  async getByLoginHint(loginHint: string, clientId: string): Promise<CIBARequestMetadata | null> {
    const row = await this.db.queryOne<CIBARequestRow>(
      `SELECT auth_req_id, client_id, scope, login_hint, login_hint_token, id_token_hint,
              binding_message, user_code, acr_values, requested_expiry, status, delivery_mode,
              client_notification_token, client_notification_endpoint, created_at, expires_at,
              last_poll_at, poll_count, interval, user_id, sub, nonce, token_issued, token_issued_at
         FROM ciba_requests
        WHERE login_hint = ? AND client_id = ? AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1`,
      [loginHint, clientId]
    );

    return mapCIBARequestRow(row);
  }

  async approveRequest(
    authReqId: string,
    userId: string,
    sub: string,
    nonce?: string
  ): Promise<void> {
    await this.db.execute(
      `UPDATE ciba_requests
          SET status = ?, user_id = ?, sub = ?, nonce = ?
        WHERE auth_req_id = ?`,
      ['approved', userId, sub, nonce ?? null, authReqId]
    );
  }

  async denyRequest(authReqId: string): Promise<void> {
    await this.db.execute('UPDATE ciba_requests SET status = ? WHERE auth_req_id = ?', [
      'denied',
      authReqId,
    ]);
  }

  async updatePoll(authReqId: string, lastPollAt: number, pollCount: number): Promise<void> {
    await this.db.execute(
      'UPDATE ciba_requests SET last_poll_at = ?, poll_count = ? WHERE auth_req_id = ?',
      [lastPollAt, pollCount, authReqId]
    );
  }

  async markTokenIssued(authReqId: string, tokenIssuedAt: number): Promise<void> {
    await this.db.execute(
      'UPDATE ciba_requests SET token_issued = ?, token_issued_at = ? WHERE auth_req_id = ?',
      [1, tokenIssuedAt, authReqId]
    );
  }

  async deleteRequest(authReqId: string): Promise<void> {
    await this.db.execute('DELETE FROM ciba_requests WHERE auth_req_id = ?', [authReqId]);
  }

  async deleteExpired(nowMs: number): Promise<number> {
    const result = await this.db.execute('DELETE FROM ciba_requests WHERE expires_at < ?', [nowMs]);
    return result.rowsAffected;
  }

  getType(): string {
    return this.db.getType();
  }
}

export function createCIBARequestPersistenceAdapter(
  source: DatabaseSource | null | undefined,
  partition: string = 'ciba-request-store'
): CIBARequestPersistenceAdapter | null {
  const adapter = ensureOptionalDatabaseAdapter(source, partition);
  if (!adapter) {
    return null;
  }

  return new DatabaseCIBARequestPersistenceAdapter(adapter);
}
