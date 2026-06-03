import type { DatabaseAdapter } from '../../db/adapter';
import { generateId, getCurrentTimestamp } from '../base';
import type { AttributeReleaseConsentMode } from '../../services/identity-release-consent';

export type AttributeReleaseConsentState = 'granted' | 'denied' | 'revoked' | 'expired' | string;

export interface AttributeReleaseConsentRow {
  id: string;
  tenant_id: string;
  subject_id: string;
  account_id: string | null;
  destination_type: string;
  destination_id: string;
  attribute_set_hash: string;
  consent_mode: AttributeReleaseConsentMode;
  consent_state: AttributeReleaseConsentState;
  consent_record_id: string | null;
  first_granted_at: number | null;
  last_confirmed_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface GrantAttributeReleaseConsentInput {
  id?: string;
  tenant_id: string;
  subject_id: string;
  account_id?: string | null;
  destination_type: string;
  destination_id: string;
  attribute_set_hash: string;
  consent_mode: AttributeReleaseConsentMode;
  consent_record_id?: string | null;
  expires_at?: number | null;
}

export class AttributeReleaseConsentRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async findGrantedConsent(input: {
    tenant_id: string;
    subject_id: string;
    destination_type: string;
    destination_id: string;
    attribute_set_hash: string;
    now?: number;
  }): Promise<AttributeReleaseConsentRow | null> {
    const now = input.now ?? getCurrentTimestamp();
    const rows = await this.adapter.query<AttributeReleaseConsentRow>(
      `SELECT *
         FROM attribute_release_consents
        WHERE tenant_id = ?
          AND subject_id = ?
          AND destination_type = ?
          AND destination_id = ?
          AND attribute_set_hash = ?
        LIMIT 1`,
      [
        input.tenant_id,
        input.subject_id,
        input.destination_type,
        input.destination_id,
        input.attribute_set_hash,
      ]
    );
    return (
      rows.find(
        (row) =>
          row.consent_state === 'granted' && (row.expires_at === null || row.expires_at > now)
      ) ?? null
    );
  }

  async grant(input: GrantAttributeReleaseConsentInput): Promise<AttributeReleaseConsentRow> {
    const now = getCurrentTimestamp();
    const row: AttributeReleaseConsentRow = {
      id: input.id ?? generateId(),
      tenant_id: input.tenant_id,
      subject_id: input.subject_id,
      account_id: input.account_id ?? null,
      destination_type: input.destination_type,
      destination_id: input.destination_id,
      attribute_set_hash: input.attribute_set_hash,
      consent_mode: input.consent_mode,
      consent_state: 'granted',
      consent_record_id: input.consent_record_id ?? null,
      first_granted_at: now,
      last_confirmed_at: now,
      expires_at: input.expires_at ?? null,
      revoked_at: null,
      created_at: now,
      updated_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO attribute_release_consents (
        id, tenant_id, subject_id, account_id, destination_type, destination_id,
        attribute_set_hash, consent_mode, consent_state, consent_record_id,
        first_granted_at, last_confirmed_at, expires_at, revoked_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, subject_id, destination_type, destination_id, attribute_set_hash)
      DO UPDATE SET
        consent_mode = excluded.consent_mode,
        consent_state = excluded.consent_state,
        consent_record_id = excluded.consent_record_id,
        last_confirmed_at = excluded.last_confirmed_at,
        expires_at = excluded.expires_at,
        revoked_at = NULL,
        updated_at = excluded.updated_at`,
      [
        row.id,
        row.tenant_id,
        row.subject_id,
        row.account_id,
        row.destination_type,
        row.destination_id,
        row.attribute_set_hash,
        row.consent_mode,
        row.consent_state,
        row.consent_record_id,
        row.first_granted_at,
        row.last_confirmed_at,
        row.expires_at,
        row.revoked_at,
        row.created_at,
        row.updated_at,
      ]
    );
    return (
      (await this.adapter.queryOne<AttributeReleaseConsentRow>(
        `SELECT *
           FROM attribute_release_consents
          WHERE tenant_id = ?
            AND subject_id = ?
            AND destination_type = ?
            AND destination_id = ?
            AND attribute_set_hash = ?
          LIMIT 1`,
        [
          row.tenant_id,
          row.subject_id,
          row.destination_type,
          row.destination_id,
          row.attribute_set_hash,
        ]
      )) ?? row
    );
  }

  async revoke(id: string, tenantId: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      `UPDATE attribute_release_consents
          SET consent_state = ?, revoked_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND consent_state = ?`,
      ['revoked', now, now, id, tenantId, 'granted']
    );
    return result.rowsAffected > 0;
  }
}
