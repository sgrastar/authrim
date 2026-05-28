import type { DatabaseAdapter } from '../../db/adapter';
import type { LoginEntrySettings } from '../../types/settings/login-entry';

export type TenantDiscoveryIndexKind =
  | 'email_domain'
  | 'email_exact'
  | 'external_subject'
  | 'global_subject';

export type TenantDiscoveryIndexStatus = 'active' | 'stale' | 'rotating' | 'disabled' | 'deleted';

export interface TenantDiscoveryIndexRow {
  tenant_id: string;
  subject_id: string;
  index_kind: TenantDiscoveryIndexKind;
  index_value: string;
  index_version: number;
  key_version: number;
  source_updated_at: string | null;
  indexed_at: string;
  status: TenantDiscoveryIndexStatus;
  metadata_json: string | null;
  mapping_snapshot_id: string | null;
  source_projection_version: string | null;
}

export interface TenantDiscoveryIndexInput {
  tenant_id: string;
  subject_id: string;
  index_kind: TenantDiscoveryIndexKind;
  index_value: string;
  index_version?: number;
  key_version?: number;
  source_updated_at?: string | null;
  indexed_at?: string;
  status?: TenantDiscoveryIndexStatus;
  metadata_json?: string | null;
  mapping_snapshot_id?: string | null;
  source_projection_version?: string | null;
}

export type TenantDiscoverySelectionPolicy = LoginEntrySettings['login-entry.selection_policy'];

export interface TenantDiscoveryCandidateSet {
  indexKind: TenantDiscoveryIndexKind;
  indexValues: string[];
  candidates: TenantDiscoveryIndexRow[];
  primary: TenantDiscoveryIndexRow | null;
  selectionPolicy: TenantDiscoverySelectionPolicy;
  result: 'none' | 'single' | 'multiple';
}

function normalizeIndexVersion(value: number | undefined): number {
  return value ?? 1;
}

function normalizeKeyVersion(value: number | undefined): number {
  return value ?? 1;
}

function normalizeIndexedAt(value: string | undefined): string {
  return value ?? new Date().toISOString();
}

function createPlaceholders(length: number): string {
  return Array.from({ length }, () => '?').join(', ');
}

export function selectTenantDiscoveryPrimaryCandidate(
  candidates: TenantDiscoveryIndexRow[],
  selectionPolicy: TenantDiscoverySelectionPolicy
): TenantDiscoveryIndexRow | null {
  if (candidates.length === 0) return null;
  if (selectionPolicy === 'manual_only') return null;
  if (selectionPolicy === 'auto_if_single' || selectionPolicy === 'select_if_multiple') {
    return candidates.length === 1 ? candidates[0] : null;
  }
  return candidates[0];
}

export class TenantDiscoveryIndexRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async upsertIndex(input: TenantDiscoveryIndexInput): Promise<void> {
    await this.adapter.execute(
      `INSERT INTO tenant_discovery_indexes (
        tenant_id, subject_id, index_kind, index_value, index_version, key_version,
        source_updated_at, indexed_at, status, metadata_json, mapping_snapshot_id,
        source_projection_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (
        index_kind, index_value, tenant_id, subject_id, index_version, key_version
      ) DO UPDATE SET
        source_updated_at = excluded.source_updated_at,
        indexed_at = excluded.indexed_at,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        mapping_snapshot_id = excluded.mapping_snapshot_id,
        source_projection_version = excluded.source_projection_version`,
      [
        input.tenant_id,
        input.subject_id,
        input.index_kind,
        input.index_value,
        normalizeIndexVersion(input.index_version),
        normalizeKeyVersion(input.key_version),
        input.source_updated_at ?? null,
        normalizeIndexedAt(input.indexed_at),
        input.status ?? 'active',
        input.metadata_json ?? null,
        input.mapping_snapshot_id ?? null,
        input.source_projection_version ?? null,
      ]
    );
  }

  async upsertIndexForKeyVersions(
    input: TenantDiscoveryIndexInput,
    keyVersions: number[]
  ): Promise<void> {
    const uniqueVersions = Array.from(new Set(keyVersions)).sort((left, right) => left - right);
    for (const keyVersion of uniqueVersions) {
      await this.upsertIndex({ ...input, key_version: keyVersion });
    }
  }

  async findCandidatesByIndexes(options: {
    indexKind: TenantDiscoveryIndexKind;
    indexValues: string[];
    indexVersions?: number[];
    keyVersions?: number[];
    statuses?: TenantDiscoveryIndexStatus[];
    limit?: number;
  }): Promise<TenantDiscoveryIndexRow[]> {
    const indexValues = Array.from(new Set(options.indexValues.filter(Boolean)));
    if (indexValues.length === 0) return [];
    const indexVersions = options.indexVersions?.length ? options.indexVersions : [1];
    const keyVersions = options.keyVersions?.length ? options.keyVersions : [1];
    const statuses = options.statuses?.length ? options.statuses : ['active', 'rotating'];

    return this.adapter.query<TenantDiscoveryIndexRow>(
      `SELECT tenant_id, subject_id, index_kind, index_value, index_version, key_version,
              source_updated_at, indexed_at, status, metadata_json, mapping_snapshot_id,
              source_projection_version
         FROM tenant_discovery_indexes
        WHERE index_kind = ?
          AND index_value IN (${createPlaceholders(indexValues.length)})
          AND index_version IN (${createPlaceholders(indexVersions.length)})
          AND key_version IN (${createPlaceholders(keyVersions.length)})
          AND status IN (${createPlaceholders(statuses.length)})
        ORDER BY
          CASE status WHEN 'active' THEN 0 WHEN 'rotating' THEN 1 ELSE 2 END,
          indexed_at DESC,
          tenant_id ASC,
          subject_id ASC
        LIMIT ?`,
      [
        options.indexKind,
        ...indexValues,
        ...indexVersions,
        ...keyVersions,
        ...statuses,
        options.limit ?? 25,
      ]
    );
  }

  async resolveCandidateSet(options: {
    indexKind: TenantDiscoveryIndexKind;
    indexValues: string[];
    indexVersions?: number[];
    keyVersions?: number[];
    selectionPolicy: TenantDiscoverySelectionPolicy;
    limit?: number;
  }): Promise<TenantDiscoveryCandidateSet> {
    const candidates = await this.findCandidatesByIndexes(options);
    return {
      indexKind: options.indexKind,
      indexValues: Array.from(new Set(options.indexValues.filter(Boolean))),
      candidates,
      primary: selectTenantDiscoveryPrimaryCandidate(candidates, options.selectionPolicy),
      selectionPolicy: options.selectionPolicy,
      result: candidates.length === 0 ? 'none' : candidates.length === 1 ? 'single' : 'multiple',
    };
  }

  async deletePreviousKeyVersionRows(options: {
    indexKind: TenantDiscoveryIndexKind;
    previousKeyVersion: number;
    currentKeyVersion: number;
    indexVersion?: number;
  }): Promise<number> {
    const result = await this.adapter.execute(
      `DELETE FROM tenant_discovery_indexes
        WHERE index_kind = ?
          AND index_version = ?
          AND key_version = ?
          AND EXISTS (
            SELECT 1
              FROM tenant_discovery_indexes current_idx
             WHERE current_idx.index_kind = tenant_discovery_indexes.index_kind
               AND current_idx.index_value = tenant_discovery_indexes.index_value
               AND current_idx.tenant_id = tenant_discovery_indexes.tenant_id
               AND current_idx.subject_id = tenant_discovery_indexes.subject_id
               AND current_idx.index_version = tenant_discovery_indexes.index_version
               AND current_idx.key_version = ?
               AND current_idx.status IN ('active', 'rotating')
          )`,
      [
        options.indexKind,
        options.indexVersion ?? 1,
        options.previousKeyVersion,
        options.currentKeyVersion,
      ]
    );
    return result.rowsAffected ?? 0;
  }

  async countPreviousKeyVersionRows(options: {
    indexKind: TenantDiscoveryIndexKind;
    previousKeyVersion: number;
    indexVersion?: number;
  }): Promise<number> {
    const row = await this.adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count
         FROM tenant_discovery_indexes
        WHERE index_kind = ?
          AND index_version = ?
          AND key_version = ?`,
      [options.indexKind, options.indexVersion ?? 1, options.previousKeyVersion]
    );
    return row?.count ?? 0;
  }

  async countPreviousKeyVersionRowsReadyForDeletion(options: {
    indexKind: TenantDiscoveryIndexKind;
    previousKeyVersion: number;
    currentKeyVersion: number;
    indexVersion?: number;
  }): Promise<number> {
    const row = await this.adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count
         FROM tenant_discovery_indexes previous_idx
        WHERE previous_idx.index_kind = ?
          AND previous_idx.index_version = ?
          AND previous_idx.key_version = ?
          AND EXISTS (
            SELECT 1
              FROM tenant_discovery_indexes current_idx
             WHERE current_idx.index_kind = previous_idx.index_kind
               AND current_idx.index_value = previous_idx.index_value
               AND current_idx.tenant_id = previous_idx.tenant_id
               AND current_idx.subject_id = previous_idx.subject_id
               AND current_idx.index_version = previous_idx.index_version
               AND current_idx.key_version = ?
               AND current_idx.status IN ('active', 'rotating')
          )`,
      [
        options.indexKind,
        options.indexVersion ?? 1,
        options.previousKeyVersion,
        options.currentKeyVersion,
      ]
    );
    return row?.count ?? 0;
  }

  async countPreviousKeyVersionRowsMissingCurrent(options: {
    indexKind: TenantDiscoveryIndexKind;
    previousKeyVersion: number;
    currentKeyVersion: number;
    indexVersion?: number;
  }): Promise<number> {
    const row = await this.adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count
         FROM tenant_discovery_indexes previous_idx
        WHERE previous_idx.index_kind = ?
          AND previous_idx.index_version = ?
          AND previous_idx.key_version = ?
          AND NOT EXISTS (
            SELECT 1
              FROM tenant_discovery_indexes current_idx
             WHERE current_idx.index_kind = previous_idx.index_kind
               AND current_idx.index_value = previous_idx.index_value
               AND current_idx.tenant_id = previous_idx.tenant_id
               AND current_idx.subject_id = previous_idx.subject_id
               AND current_idx.index_version = previous_idx.index_version
               AND current_idx.key_version = ?
               AND current_idx.status IN ('active', 'rotating')
          )`,
      [
        options.indexKind,
        options.indexVersion ?? 1,
        options.previousKeyVersion,
        options.currentKeyVersion,
      ]
    );
    return row?.count ?? 0;
  }
}
