import {
  buildLookupHmacKeyStateGenerationKey,
  buildLookupHmacKeyStateSnapshotKey,
  signLookupHmacKeyState,
  type LookupHmacKeyClaim,
  type LookupHmacKeySlot,
  type LookupHmacRotationState,
  type LookupHmacWriteMode,
} from '@authrim/ar-lib-core';
import type { ControlEnv } from './types';
import { runtimeRegistryPrivateJwk } from './lookup-registry-publisher';

const PUBLICATION_TTL_SECONDS = 30 * 60;
const REFRESH_WINDOW_SECONDS = 10 * 60;
const MAX_ENVIRONMENTS_PER_RUN = 100;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

interface StateRow {
  environment_id: string;
  state_revision: number;
  rotation_state: LookupHmacRotationState;
  write_mode: LookupHmacWriteMode;
  current_key_generation: number;
  current_key_id: string;
  current_key_slot: LookupHmacKeySlot;
  current_key_fingerprint: string;
  previous_key_generation: number | null;
  previous_key_id: string | null;
  previous_key_slot: LookupHmacKeySlot | null;
  previous_key_fingerprint: string | null;
}

interface PublicationRow {
  environment_id: string;
  publication_generation: number;
  state_revision: number;
  state_digest: string;
  snapshot_jws: string;
  issued_at: number;
  expires_at: number;
  status: 'publishing' | 'active';
}

export interface LookupHmacKeyStatePublishResult {
  environmentId: string;
  generation: number;
  stateRevision: number;
  status: 'published' | 'unchanged' | 'resumed';
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function current(row: StateRow): LookupHmacKeyClaim {
  return {
    generation: row.current_key_generation,
    keyId: row.current_key_id,
    slot: row.current_key_slot,
    fingerprint: row.current_key_fingerprint,
  };
}

function previous(row: StateRow): LookupHmacKeyClaim | null {
  const values = [
    row.previous_key_generation,
    row.previous_key_id,
    row.previous_key_slot,
    row.previous_key_fingerprint,
  ];
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) throw new Error('lookup_hmac_key_state_row_invalid');
  return {
    generation: row.previous_key_generation!,
    keyId: row.previous_key_id!,
    slot: row.previous_key_slot!,
    fingerprint: row.previous_key_fingerprint!,
  };
}

function stateDigestInput(row: StateRow): string {
  return JSON.stringify({
    stateRevision: row.state_revision,
    rotationState: row.rotation_state,
    writeMode: row.write_mode,
    current: current(row),
    previous: previous(row),
  });
}

export class LookupHmacKeyStatePublisher {
  constructor(
    private readonly env: ControlEnv,
    private readonly now: () => number
  ) {}

  async reconcile(): Promise<LookupHmacKeyStatePublishResult[]> {
    if (!this.env.TENANT_RUNTIME_REGISTRY) {
      throw new Error('lookup_hmac_key_state_store_unavailable');
    }
    const rows = await this.env.CONTROL_DB.prepare(
      `SELECT state.environment_id
         FROM control_lookup_hmac_key_states state
         LEFT JOIN control_lookup_hmac_key_state_publications publication
           ON publication.environment_id = state.environment_id
        ORDER BY CASE
                   WHEN publication.environment_id IS NULL THEN 0
                   WHEN publication.status = 'publishing' THEN 1
                   ELSE 2
                 END,
                 publication.expires_at, state.environment_id
        LIMIT ?`
    )
      .bind(MAX_ENVIRONMENTS_PER_RUN)
      .all<{ environment_id: string }>();
    const results: LookupHmacKeyStatePublishResult[] = [];
    for (const row of rows.results) results.push(await this.publishEnvironment(row.environment_id));
    return results;
  }

  async publishEnvironment(environmentId: string): Promise<LookupHmacKeyStatePublishResult> {
    if (!SAFE_ID.test(environmentId)) throw new Error('lookup_hmac_key_state_environment_invalid');
    const store = this.env.TENANT_RUNTIME_REGISTRY;
    if (!store) throw new Error('lookup_hmac_key_state_store_unavailable');
    const desired = await this.state(environmentId);
    if (!desired) throw new Error('lookup_hmac_key_state_not_found');
    const now = this.now();
    const existing = await this.publication(environmentId);
    const digest = await sha256(stateDigestInput(desired));
    if (
      existing?.status === 'publishing' &&
      existing.state_revision === desired.state_revision &&
      existing.state_digest === digest &&
      existing.expires_at > now + REFRESH_WINDOW_SECONDS
    ) {
      await this.publishPrepared(existing, store);
      return {
        environmentId,
        generation: existing.publication_generation,
        stateRevision: existing.state_revision,
        status: 'resumed',
      };
    }
    if (
      existing?.status === 'active' &&
      existing.state_revision === desired.state_revision &&
      existing.state_digest === digest &&
      existing.expires_at > now + REFRESH_WINDOW_SECONDS
    ) {
      if (!(await this.isReflected(existing, store))) {
        await this.publishPrepared(existing, store);
        return {
          environmentId,
          generation: existing.publication_generation,
          stateRevision: existing.state_revision,
          status: 'resumed',
        };
      }
      return {
        environmentId,
        generation: existing.publication_generation,
        stateRevision: existing.state_revision,
        status: 'unchanged',
      };
    }
    const generation = (existing?.publication_generation ?? 0) + 1;
    const issuedAt = now;
    const expiresAt = now + PUBLICATION_TTL_SECONDS;
    const snapshot = await signLookupHmacKeyState({
      state: {
        environmentId,
        generation,
        issuedAt,
        expiresAt,
        rotationState: desired.rotation_state,
        writeMode: desired.write_mode,
        current: current(desired),
        previous: previous(desired),
      },
      privateJwk: runtimeRegistryPrivateJwk(this.env),
    });
    if (existing) {
      const updated = await this.env.CONTROL_DB.prepare(
        `UPDATE control_lookup_hmac_key_state_publications
            SET publication_generation = ?, state_revision = ?, state_digest = ?,
                snapshot_jws = ?, issued_at = ?, expires_at = ?, status = 'publishing',
                updated_at = ?
          WHERE environment_id = ? AND publication_generation = ? AND status = ?`
      )
        .bind(
          generation,
          desired.state_revision,
          digest,
          snapshot,
          issuedAt,
          expiresAt,
          now,
          environmentId,
          existing.publication_generation,
          existing.status
        )
        .run();
      if ((updated.meta.changes ?? 0) !== 1) {
        throw new Error('lookup_hmac_key_state_publication_stale');
      }
    } else {
      const inserted = await this.env.CONTROL_DB.prepare(
        `INSERT OR IGNORE INTO control_lookup_hmac_key_state_publications (
           environment_id, publication_generation, state_revision, state_digest,
           snapshot_jws, issued_at, expires_at, status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'publishing', ?)`
      )
        .bind(
          environmentId,
          generation,
          desired.state_revision,
          digest,
          snapshot,
          issuedAt,
          expiresAt,
          now
        )
        .run();
      if ((inserted.meta.changes ?? 0) !== 1) {
        throw new Error('lookup_hmac_key_state_publication_stale');
      }
    }
    const prepared = await this.publication(environmentId);
    if (!prepared) throw new Error('lookup_hmac_key_state_publication_prepare_failed');
    await this.publishPrepared(prepared, store);
    return {
      environmentId,
      generation: prepared.publication_generation,
      stateRevision: prepared.state_revision,
      status: 'published',
    };
  }

  private async state(environmentId: string): Promise<StateRow | null> {
    return this.env.CONTROL_DB.prepare(
      `SELECT environment_id, state_revision, rotation_state, write_mode,
              current_key_generation, current_key_id, current_key_slot,
              current_key_fingerprint, previous_key_generation, previous_key_id,
              previous_key_slot, previous_key_fingerprint
         FROM control_lookup_hmac_key_states WHERE environment_id = ?`
    )
      .bind(environmentId)
      .first<StateRow>();
  }

  private async publication(environmentId: string): Promise<PublicationRow | null> {
    return this.env.CONTROL_DB.prepare(
      `SELECT environment_id, publication_generation, state_revision, state_digest,
              snapshot_jws, issued_at, expires_at, status
         FROM control_lookup_hmac_key_state_publications WHERE environment_id = ?`
    )
      .bind(environmentId)
      .first<PublicationRow>();
  }

  private async publishPrepared(state: PublicationRow, store: KVNamespace): Promise<void> {
    await store.put(buildLookupHmacKeyStateSnapshotKey(state.environment_id), state.snapshot_jws);
    await store.put(
      buildLookupHmacKeyStateGenerationKey(state.environment_id),
      String(state.publication_generation)
    );
    if (!(await this.isReflected(state, store))) {
      throw new Error('lookup_hmac_key_state_publication_reflection_failed');
    }
    const completed = await this.env.CONTROL_DB.prepare(
      `UPDATE control_lookup_hmac_key_state_publications SET status = 'active', updated_at = ?
        WHERE environment_id = ? AND publication_generation = ? AND state_revision = ?
          AND status = 'publishing' AND snapshot_jws = ?`
    )
      .bind(
        this.now(),
        state.environment_id,
        state.publication_generation,
        state.state_revision,
        state.snapshot_jws
      )
      .run();
    if ((completed.meta.changes ?? 0) !== 1) {
      const adopted = await this.publication(state.environment_id);
      if (
        adopted?.status === 'active' &&
        adopted.publication_generation === state.publication_generation &&
        adopted.state_revision === state.state_revision &&
        adopted.snapshot_jws === state.snapshot_jws
      ) {
        return;
      }
      throw new Error('lookup_hmac_key_state_publication_stale');
    }
  }

  private async isReflected(state: PublicationRow, store: KVNamespace): Promise<boolean> {
    const [snapshot, generation] = await Promise.all([
      store.get(buildLookupHmacKeyStateSnapshotKey(state.environment_id)),
      store.get(buildLookupHmacKeyStateGenerationKey(state.environment_id)),
    ]);
    return snapshot === state.snapshot_jws && generation === String(state.publication_generation);
  }
}
