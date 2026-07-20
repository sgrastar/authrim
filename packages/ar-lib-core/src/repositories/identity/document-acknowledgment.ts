import type { DatabaseAdapter, TransactionContext } from '../../db/adapter';
import { requireTenantId } from '../tenant';

export type DocumentAcknowledgmentStatus = 'accepted' | 'withdrawn' | 'expired';

export interface DocumentAcknowledgmentCurrentRow {
  tenant_id: string;
  subject_user_id: string;
  consent_kind: string;
  statement_id: string;
  statement_version: string;
  status: DocumentAcknowledgmentStatus;
  accepted_at: number | null;
  expires_at: number | null;
  withdrawn_at: number | null;
  latest_evidence_record_id: string;
  updated_at: number;
}

type ConsentGateStore = Pick<DatabaseAdapter | TransactionContext, 'queryOne' | 'execute'>;

export class DocumentAcknowledgmentRepository {
  constructor(private readonly store: ConsentGateStore) {}

  async findCurrent(input: {
    tenant_id: string;
    subject_user_id: string;
    consent_kind: string;
    statement_id: string;
    statement_version: string;
  }): Promise<DocumentAcknowledgmentCurrentRow | null> {
    const tenant = requireTenantId(input.tenant_id, 'DocumentAcknowledgmentRepository.findCurrent');
    return this.store.queryOne<DocumentAcknowledgmentCurrentRow>(
      `SELECT *
         FROM document_acknowledgments_current
        WHERE tenant_id = ?
          AND subject_user_id = ?
          AND consent_kind = ?
          AND statement_id = ?
          AND statement_version = ?
        LIMIT 1`,
      [
        tenant,
        input.subject_user_id,
        input.consent_kind,
        input.statement_id,
        input.statement_version,
      ]
    );
  }

  async findActive(input: {
    tenant_id: string;
    subject_user_id: string;
    consent_kind: string;
    statement_id: string;
    statement_version: string;
    now?: number;
  }): Promise<DocumentAcknowledgmentCurrentRow | null> {
    const row = await this.findCurrent(input);
    const now = input.now ?? Math.floor(Date.now() / 1000);
    return row?.status === 'accepted' && (row.expires_at === null || row.expires_at > now)
      ? row
      : null;
  }

  async accept(input: {
    tenant_id: string;
    subject_user_id: string;
    consent_kind: string;
    statement_id: string;
    statement_version: string;
    accepted_at: number;
    expires_at?: number | null;
    evidence_record_id: string;
    updated_at?: number;
  }): Promise<DocumentAcknowledgmentCurrentRow> {
    const tenant = requireTenantId(input.tenant_id, 'DocumentAcknowledgmentRepository.accept');
    const key = { ...input, tenant_id: tenant };
    const existing = await this.findCurrent(key);
    const row: DocumentAcknowledgmentCurrentRow = {
      tenant_id: tenant,
      subject_user_id: input.subject_user_id,
      consent_kind: input.consent_kind,
      statement_id: input.statement_id,
      statement_version: input.statement_version,
      status: 'accepted',
      accepted_at: input.accepted_at,
      expires_at: input.expires_at ?? null,
      withdrawn_at: null,
      latest_evidence_record_id: input.evidence_record_id,
      updated_at: input.updated_at ?? input.accepted_at,
    };
    if (existing) {
      await this.store.execute(
        `UPDATE document_acknowledgments_current
            SET status = ?, accepted_at = ?, expires_at = ?, withdrawn_at = ?,
                latest_evidence_record_id = ?, updated_at = ?
          WHERE tenant_id = ?
            AND subject_user_id = ?
            AND consent_kind = ?
            AND statement_id = ?
            AND statement_version = ?`,
        [
          row.status,
          row.accepted_at,
          row.expires_at,
          row.withdrawn_at,
          row.latest_evidence_record_id,
          row.updated_at,
          row.tenant_id,
          row.subject_user_id,
          row.consent_kind,
          row.statement_id,
          row.statement_version,
        ]
      );
    } else {
      await this.store.execute(
        `INSERT INTO document_acknowledgments_current (
          tenant_id, subject_user_id, consent_kind, statement_id, statement_version,
          status, accepted_at, expires_at, withdrawn_at, latest_evidence_record_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.tenant_id,
          row.subject_user_id,
          row.consent_kind,
          row.statement_id,
          row.statement_version,
          row.status,
          row.accepted_at,
          row.expires_at,
          row.withdrawn_at,
          row.latest_evidence_record_id,
          row.updated_at,
        ]
      );
    }
    return row;
  }

  async withdraw(input: {
    tenant_id: string;
    subject_user_id: string;
    consent_kind: string;
    statement_id: string;
    statement_version: string;
    evidence_record_id: string;
    withdrawn_at: number;
  }): Promise<boolean> {
    const tenant = requireTenantId(input.tenant_id, 'DocumentAcknowledgmentRepository.withdraw');
    const result = await this.store.execute(
      `UPDATE document_acknowledgments_current
          SET status = 'withdrawn', withdrawn_at = ?, latest_evidence_record_id = ?, updated_at = ?
        WHERE tenant_id = ?
          AND subject_user_id = ?
          AND consent_kind = ?
          AND statement_id = ?
          AND statement_version = ?
          AND status = 'accepted'`,
      [
        input.withdrawn_at,
        input.evidence_record_id,
        input.withdrawn_at,
        tenant,
        input.subject_user_id,
        input.consent_kind,
        input.statement_id,
        input.statement_version,
      ]
    );
    return result.rowsAffected > 0;
  }
}
