import type { DatabaseAdapter } from '../db/adapter';

export interface GuestUpgradeOperation {
  operation_id: string;
  tenant_id: string;
  user_id: string;
  client_id: string;
  initiating_session_id: string;
  request_token_hash: string;
  method: 'email' | 'passkey';
  state: 'awaiting_proof' | 'verified' | 'committing' | 'completed' | 'canceled';
  proof_payload_json: string | null;
  challenge_verifier: string | null;
  reservation_publication_json: string | null;
  attempt_count: number;
  expires_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Uses the account PII adapter. Raw proof payload must never be copied to core storage or logs. */
export class GuestUpgradeRepository {
  constructor(
    private readonly pii: DatabaseAdapter,
    private readonly tenantId: string
  ) {}

  get(operationId: string): Promise<GuestUpgradeOperation | null> {
    return this.pii.queryOne<GuestUpgradeOperation>(
      'SELECT * FROM guest_upgrade_operations WHERE tenant_id = ? AND operation_id = ?',
      [this.tenantId, operationId],
      { consistencyClass: 'primary_required' }
    );
  }

  async create(input: {
    operationId: string;
    userId: string;
    clientId: string;
    sessionId: string;
    requestTokenHash: string;
    method: 'email' | 'passkey';
    payloadJson: string;
    verifier: string;
    now: number;
    expiresAt: number;
  }): Promise<void> {
    if (
      !/^[a-f0-9]{64}$/.test(input.requestTokenHash) ||
      !Number.isSafeInteger(input.now) ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.now < 0 ||
      input.expiresAt <= input.now ||
      input.expiresAt > input.now + 600 ||
      input.payloadJson.length > 65536 ||
      !input.verifier
    )
      throw new Error('invalid_guest_upgrade_operation');
    await this.pii.execute(
      `INSERT INTO guest_upgrade_operations
       (operation_id, tenant_id, user_id, client_id, initiating_session_id, request_token_hash,
        method, proof_payload_json, challenge_verifier, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.operationId,
        this.tenantId,
        input.userId,
        input.clientId,
        input.sessionId,
        input.requestTokenHash,
        input.method,
        input.payloadJson,
        input.verifier,
        input.expiresAt,
        input.now,
        input.now,
      ]
    );
  }

  /** Atomic bounded OTP verification. A malformed caller must be rejected before this method. */
  async verifyEmail(input: {
    operationId: string;
    userId: string;
    sessionId: string;
    requestTokenHash: string;
    verifier: string;
    now: number;
  }): Promise<boolean> {
    const result = await this.pii.execute(
      `UPDATE guest_upgrade_operations
       SET attempt_count = attempt_count + 1,
           state = CASE WHEN challenge_verifier = ? THEN 'verified'
                        WHEN attempt_count = 4 THEN 'canceled' ELSE 'awaiting_proof' END,
           updated_at = ?
       WHERE tenant_id = ? AND operation_id = ? AND user_id = ? AND initiating_session_id = ?
         AND request_token_hash = ? AND method = 'email' AND state = 'awaiting_proof'
         AND expires_at > ? AND attempt_count < 5`,
      [
        input.verifier,
        input.now,
        this.tenantId,
        input.operationId,
        input.userId,
        input.sessionId,
        input.requestTokenHash,
        input.now,
      ]
    );
    if (result.rowsAffected !== 1) return false;
    const row = await this.get(input.operationId);
    return row?.state === 'verified' && row.challenge_verifier === input.verifier;
  }

  /** Caller must cryptographically verify the WebAuthn response before passing its stored challenge. */
  async verifyPasskey(input: {
    operationId: string;
    userId: string;
    sessionId: string;
    requestTokenHash: string;
    challenge: string;
    verifiedPayloadJson: string;
    now: number;
  }): Promise<boolean> {
    if (input.verifiedPayloadJson.length > 65536)
      throw new Error('guest_upgrade_payload_too_large');
    const result = await this.pii.execute(
      `UPDATE guest_upgrade_operations SET state = 'verified', proof_payload_json = ?, updated_at = ?
       WHERE tenant_id = ? AND operation_id = ? AND user_id = ? AND initiating_session_id = ?
         AND request_token_hash = ? AND method = 'passkey' AND state = 'awaiting_proof'
         AND challenge_verifier = ? AND expires_at > ?`,
      [
        input.verifiedPayloadJson,
        input.now,
        this.tenantId,
        input.operationId,
        input.userId,
        input.sessionId,
        input.requestTokenHash,
        input.challenge,
        input.now,
      ]
    );
    return result.rowsAffected === 1;
  }

  /** Called only for the winning core lifecycle operation. Expired leases permit deterministic retry. */
  async leaseCommit(operationId: string, owner: string, now: number): Promise<boolean> {
    const result = await this.pii.execute(
      `UPDATE guest_upgrade_operations SET state = 'committing', lease_owner = ?, lease_expires_at = ?, updated_at = ?
       WHERE tenant_id = ? AND operation_id = ? AND state IN ('verified', 'committing')
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      [owner, now + 60, now, this.tenantId, operationId, now]
    );
    return result.rowsAffected === 1;
  }

  async complete(operationId: string, owner: string, now: number): Promise<boolean> {
    const result = await this.pii.execute(
      `UPDATE guest_upgrade_operations SET state = 'completed', proof_payload_json = NULL, reservation_publication_json = NULL,
         challenge_verifier = NULL, lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
       WHERE tenant_id = ? AND operation_id = ? AND state = 'committing' AND lease_owner = ?`,
      [now, now, this.tenantId, operationId, owner]
    );
    return result.rowsAffected === 1;
  }

  /** Immutable reservation indexes survive HMAC key rotation and partial publication. */
  async pinReservation(operationId: string, publicationJson: string): Promise<string | null> {
    if (publicationJson.length > 65536) throw new Error('guest_reservation_too_large');
    await this.pii.execute(
      `UPDATE guest_upgrade_operations SET reservation_publication_json = ?
       WHERE tenant_id = ? AND operation_id = ? AND state = 'verified' AND reservation_publication_json IS NULL`,
      [publicationJson, this.tenantId, operationId]
    );
    const row = await this.get(operationId);
    return row?.state === 'verified' ? row.reservation_publication_json : null;
  }

  listExpired(userId: string, now: number, limit = 20): Promise<GuestUpgradeOperation[]> {
    return this.pii.query<GuestUpgradeOperation>(
      `SELECT * FROM guest_upgrade_operations WHERE tenant_id = ? AND user_id = ? AND expires_at <= ?
       AND state IN ('awaiting_proof', 'verified', 'canceled')
       AND (proof_payload_json IS NOT NULL OR challenge_verifier IS NOT NULL OR reservation_publication_json IS NOT NULL)
       ORDER BY expires_at, operation_id LIMIT ?`,
      [this.tenantId, userId, now, limit],
      { consistencyClass: 'primary_required' }
    );
  }

  /** Caller must first acquire the core expired-proof admission fence. */
  async eraseFencedProof(operationId: string, now: number): Promise<void> {
    await this.pii.execute(
      `UPDATE guest_upgrade_operations SET state = 'canceled', proof_payload_json = NULL,
       challenge_verifier = NULL, reservation_publication_json = NULL, updated_at = ?
       WHERE tenant_id = ? AND operation_id = ? AND expires_at <= ? AND state IN ('awaiting_proof', 'verified', 'canceled')`,
      [now, this.tenantId, operationId, now]
    );
  }

  async cancelUncommitted(operationId: string, now: number): Promise<boolean> {
    const result = await this.pii.execute(
      `UPDATE guest_upgrade_operations SET state = 'canceled', proof_payload_json = NULL,
         challenge_verifier = NULL, updated_at = ?
       WHERE tenant_id = ? AND operation_id = ? AND state IN ('awaiting_proof', 'canceled')`,
      [now, this.tenantId, operationId]
    );
    return result.rowsAffected === 1;
  }
}
