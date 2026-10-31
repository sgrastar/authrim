import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupLease } from './operation-store';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import {
  openTenantBackupContentKey,
  type TenantBackupKeyHandoffContext,
} from './operation-key-handoff';

type Database = Pick<DatabaseAdapter, 'queryOne' | 'execute'>;
interface KeyRow {
  id: string;
  tenant_id: string;
  operation_id: string;
  input_upload_id: string | null;
  request_digest: string;
  encryption_key_id: string;
  private_ciphertext: string;
  created_at: number;
  submit_expires_at: number;
  key_expires_at: number;
  state: 'pending' | 'accepted';
  envelope: string | null;
  handoff: string | null;
}
const SUBMIT_MS = 10 * 60_000;
const KEY_MS = 24 * 60 * 60_000;
function fail(): never {
  throw new Error('backup_operation_key_unavailable');
}
function time(now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - KEY_MS) fail();
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!value || value.length > 20000 || !/^(?:[a-f0-9]{2})+$/.test(value)) fail();
  return Uint8Array.from(value.match(/../g) ?? fail(), (b) => parseInt(b, 16));
}
function context(row: KeyRow): TenantBackupKeyHandoffContext {
  const value: TenantBackupKeyHandoffContext = {
    tenantId: row.tenant_id,
    operationId: row.operation_id,
    requestDigest: row.request_digest,
    challengeId: row.id,
    expiresAt: row.key_expires_at,
  };
  if (row.input_upload_id) value.inputId = row.input_upload_id;
  return value;
}
function aad(row: KeyRow): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    new TextEncoder().encode(
      JSON.stringify([
        'authrim-backup-private-key-v1',
        context(row),
        row.encryption_key_id,
        row.created_at,
        row.submit_expires_at,
      ])
    )
  );
}

/** The caller supplies a dedicated wrapping key from trusted environment configuration. */
export class TenantBackupOperationKeyStore {
  constructor(
    private readonly db: Database,
    private readonly wrapping: { id: string; key: CryptoKey }
  ) {
    if (
      !wrapping.id ||
      wrapping.key.algorithm.name !== 'AES-GCM' ||
      (wrapping.key.algorithm as { length?: number }).length !== 256
    )
      fail();
  }

  async issue(
    tenantId: string,
    operationId: string,
    actorId: string,
    now: number,
    inputId?: string
  ) {
    time(now);
    const op = await this.db.queryOne<{ request_digest: string; kind: 'export' | 'import' }>(
      `SELECT request_digest,kind FROM tenant_backup_operations WHERE tenant_id=? AND id=? AND created_by=?
       AND state IN ('queued','waiting') AND updated_at<=?
       AND (SELECT count(*) FROM tenant_backup_key_handoffs k WHERE k.operation_id=tenant_backup_operations.id
       AND k.tenant_id=tenant_backup_operations.tenant_id AND k.key_expires_at>?
       AND (k.state='accepted' OR k.submit_expires_at>?))<32`,
      [tenantId, operationId, actorId, now, now, now]
    );
    if (!op) fail();
    if (inputId && !/^[A-Za-z0-9_.:-]{1,256}$/.test(inputId)) fail();
    if (op.kind === 'export' ? inputId !== undefined : inputId === undefined) fail();
    if (
      inputId &&
      !(await this.db.queryOne(
        `SELECT 1 AS authorized FROM tenant_backup_operation_inputs
         WHERE operation_id=? AND tenant_id=? AND upload_id=?`,
        [operationId, tenantId, inputId]
      ))
    )
      fail();
    const pair = (await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['encrypt', 'decrypt']
    )) as { publicKey: CryptoKey; privateKey: CryptoKey };
    const row: KeyRow = {
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      operation_id: operationId,
      input_upload_id: inputId ?? null,
      request_digest: op.request_digest,
      encryption_key_id: this.wrapping.id,
      private_ciphertext: '',
      created_at: now,
      submit_expires_at: now + SUBMIT_MS,
      key_expires_at: now + KEY_MS,
      state: 'pending',
      envelope: null,
      handoff: null,
    };
    const exported = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
    if (!(exported instanceof ArrayBuffer)) fail();
    const raw = new Uint8Array(exported);
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: aad(row) },
          this.wrapping.key,
          raw
        )
      );
      row.private_ciphertext = hex(iv) + hex(sealed);
    } finally {
      raw.fill(0);
    }
    const saved = await this.db.queryOne<{ id: string }>(
      `INSERT INTO tenant_backup_key_handoffs
       (id,tenant_id,operation_id,input_upload_id,request_digest,encryption_key_id,private_ciphertext,created_at,submit_expires_at,key_expires_at)
       SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM tenant_backup_operations
       WHERE tenant_id=? AND id=? AND created_by=? AND request_digest=? AND state IN ('queued','waiting') AND updated_at<=?)
       AND (SELECT count(*) FROM tenant_backup_key_handoffs WHERE tenant_id=? AND operation_id=?
       AND key_expires_at>? AND (state='accepted' OR submit_expires_at>?))<32 RETURNING id`,
      [
        row.id,
        tenantId,
        operationId,
        row.input_upload_id,
        row.request_digest,
        row.encryption_key_id,
        row.private_ciphertext,
        now,
        row.submit_expires_at,
        row.key_expires_at,
        tenantId,
        operationId,
        actorId,
        row.request_digest,
        now,
        tenantId,
        operationId,
        now,
        now,
      ]
    );
    if (!saved) fail();
    return {
      publicKey: (await crypto.subtle.exportKey('jwk', pair.publicKey)) as {
        kty: string;
        n: string;
        e: string;
        alg?: string;
        ext?: boolean;
        key_ops?: string[];
      },
      context: context(row),
      submitExpiresAt: row.submit_expires_at,
    };
  }

  private async privateKey(row: KeyRow): Promise<CryptoKey> {
    let raw: Uint8Array<ArrayBuffer> | undefined;
    try {
      if (row.encryption_key_id !== this.wrapping.id) fail();
      const sealed = bytes(row.private_ciphertext);
      raw = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: sealed.slice(0, 12), additionalData: aad(row) },
          this.wrapping.key,
          sealed.slice(12)
        )
      );
      return await crypto.subtle.importKey(
        'pkcs8',
        raw,
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['decrypt']
      );
    } catch {
      return fail();
    } finally {
      raw?.fill(0);
    }
  }

  async accept(
    tenantId: string,
    operationId: string,
    actorId: string,
    challengeId: string,
    envelope: Uint8Array,
    handoff: Uint8Array,
    now: number
  ): Promise<void> {
    time(now);
    const row = await this.db.queryOne<KeyRow>(
      `SELECT k.* FROM tenant_backup_key_handoffs k
      JOIN tenant_backup_operations o ON o.id=k.operation_id AND o.tenant_id=k.tenant_id
      WHERE k.id=? AND k.tenant_id=? AND k.operation_id=? AND k.state='pending'
      AND k.created_at<=? AND k.submit_expires_at>? AND o.created_by=? AND o.request_digest=k.request_digest
      AND o.state IN ('queued','waiting') AND o.updated_at<=?`,
      [challengeId, tenantId, operationId, now, now, actorId, now]
    );
    if (!row) fail();
    if (
      !(envelope instanceof Uint8Array) ||
      envelope.length !== 93 ||
      !(handoff instanceof Uint8Array) ||
      handoff.length !== 256
    )
      fail();
    // Own copies prevent mutation between authentication and durable acceptance.
    const savedEnvelope = new Uint8Array(envelope),
      savedHandoff = new Uint8Array(handoff);
    await openTenantBackupContentKey(
      savedHandoff,
      savedEnvelope,
      await this.privateKey(row),
      context(row),
      now
    );
    const accepted = await this.db.queryOne<{ id: string }>(
      `UPDATE tenant_backup_key_handoffs
      SET state='accepted',envelope=?,handoff=?,accepted_at=? WHERE id=? AND tenant_id=? AND state='pending'
      AND submit_expires_at>? AND EXISTS (SELECT 1 FROM tenant_backup_operations o
      WHERE o.id=operation_id AND o.tenant_id=tenant_backup_key_handoffs.tenant_id AND o.created_by=?
      AND o.request_digest=tenant_backup_key_handoffs.request_digest AND o.state IN ('queued','waiting') AND o.updated_at<=?) RETURNING id`,
      [hex(savedEnvelope), hex(savedHandoff), now, challengeId, tenantId, now, actorId, now]
    );
    if (!accepted) fail();
  }

  async load(
    lease: TenantBackupLease,
    challengeId: string,
    now: number
  ): Promise<TenantBundleKeyEnvelope> {
    time(now);
    const row = await this.db.queryOne<KeyRow>(
      `SELECT k.* FROM tenant_backup_key_handoffs k
      JOIN tenant_backup_operations o ON o.id=k.operation_id AND o.tenant_id=k.tenant_id
      WHERE k.id=? AND k.tenant_id=? AND k.operation_id=? AND k.state='accepted'
      AND k.created_at<=? AND k.key_expires_at>? AND o.request_digest=k.request_digest
      AND o.state='running' AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?`,
      [
        challengeId,
        lease.tenantId,
        lease.operationId,
        now,
        now,
        lease.owner,
        lease.fencingToken,
        now,
        now,
      ]
    );
    if (!row || !row.envelope || !row.handoff) fail();
    return openTenantBackupContentKey(
      bytes(row.handoff),
      bytes(row.envelope),
      await this.privateKey(row),
      context(row),
      now
    );
  }

  /** Resolve the key selected by start, never a caller-selected accepted challenge. */
  async loadActive(lease: TenantBackupLease, now: () => number): Promise<TenantBundleKeyEnvelope> {
    const selected = async () => {
      const timestamp = now();
      time(timestamp);
      const row = await this.db.queryOne<{ active_key_challenge_id: string }>(
        `SELECT o.active_key_challenge_id FROM tenant_backup_operations o
         JOIN tenant_backup_key_handoffs k ON k.id=o.active_key_challenge_id
           AND k.operation_id=o.id AND k.tenant_id=o.tenant_id AND k.request_digest=o.request_digest
         WHERE o.id=? AND o.tenant_id=? AND o.state='running' AND o.lease_owner=?
           AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?
           AND k.state='accepted' AND k.created_at<=? AND k.key_expires_at>?`,
        [
          lease.operationId,
          lease.tenantId,
          lease.owner,
          lease.fencingToken,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
        ]
      );
      if (!row?.active_key_challenge_id) fail();
      return row.active_key_challenge_id;
    };
    const id = await selected();
    const key = await this.load(lease, id, now());
    // RSA/decryption awaits may outlive the lease or race cancellation/rotation.
    if ((await selected()) !== id) fail();
    return key;
  }

  /** Load every input key in the immutable request order selected by the atomic import start. */
  async loadActiveInputs(
    lease: TenantBackupLease,
    now: () => number
  ): Promise<{ inputId: string; key: TenantBundleKeyEnvelope }[]> {
    const selected = async () => {
      const timestamp = now();
      time(timestamp);
      const row = await this.db.queryOne<{
        active_input_key_challenges_json: string;
        input_count: number;
      }>(
        `SELECT o.active_input_key_challenges_json,
          (SELECT count(*) FROM tenant_backup_operation_inputs i WHERE i.operation_id=o.id AND i.tenant_id=o.tenant_id) input_count
         FROM tenant_backup_operations o WHERE o.id=? AND o.tenant_id=? AND o.kind='import'
           AND o.state='running' AND o.lease_owner=? AND o.fencing_token=?
           AND o.lease_expires_at>? AND o.updated_at<=?`,
        [lease.operationId, lease.tenantId, lease.owner, lease.fencingToken, timestamp, timestamp]
      );
      if (!row?.active_input_key_challenges_json) fail();
      let value: unknown;
      try {
        value = JSON.parse(row.active_input_key_challenges_json);
      } catch {
        return fail();
      }
      if (!Array.isArray(value) || value.length !== row.input_count || value.length > 32) fail();
      const items: unknown[] = value;
      const entries = items.map((item) => {
        if (
          !item ||
          typeof item !== 'object' ||
          Array.isArray(item) ||
          Object.keys(item).sort().join(',') !== 'challengeId,inputId'
        )
          fail();
        const entry = item as Record<string, unknown>;
        if (
          typeof entry.inputId !== 'string' ||
          typeof entry.challengeId !== 'string' ||
          !/^[A-Za-z0-9_.:-]{1,256}$/.test(entry.inputId) ||
          !/^[A-Za-z0-9_.:-]{1,256}$/.test(entry.challengeId)
        )
          fail();
        return { inputId: entry.inputId, challengeId: entry.challengeId };
      });
      if (
        new Set(entries.map((entry) => entry.inputId)).size !== entries.length ||
        new Set(entries.map((entry) => entry.challengeId)).size !== entries.length
      )
        fail();
      return { json: row.active_input_key_challenges_json, entries };
    };
    const fixed = await selected();
    const result: { inputId: string; key: TenantBundleKeyEnvelope }[] = [];
    for (const entry of fixed.entries) {
      const timestamp = now();
      time(timestamp);
      if (
        !(await this.db.queryOne(
          `SELECT 1 AS authorized FROM tenant_backup_operation_inputs i
           JOIN tenant_backup_key_handoffs k ON k.id=? AND k.operation_id=i.operation_id
             AND k.tenant_id=i.tenant_id AND k.input_upload_id=i.upload_id
           JOIN tenant_backup_operations o ON o.id=i.operation_id AND o.tenant_id=i.tenant_id
           WHERE i.operation_id=? AND i.tenant_id=? AND i.upload_id=? AND k.state='accepted'
             AND k.request_digest=o.request_digest AND k.key_expires_at>?`,
          [entry.challengeId, lease.operationId, lease.tenantId, entry.inputId, timestamp]
        ))
      )
        fail();
      result.push({
        inputId: entry.inputId,
        key: await this.load(lease, entry.challengeId, now()),
      });
    }
    if ((await selected()).json !== fixed.json) fail();
    return result;
  }

  /** Bounded GC; state/expiry is checked in the DELETE, including pending submission expiry. */
  async cleanupPage(now: number): Promise<number> {
    time(now);
    const result = await this.db.execute(
      `DELETE FROM tenant_backup_key_handoffs WHERE id IN
      (SELECT k.id FROM tenant_backup_key_handoffs k JOIN tenant_backup_operations o
      ON o.id=k.operation_id AND o.tenant_id=k.tenant_id WHERE k.key_expires_at<=?
      OR (k.state='pending' AND k.submit_expires_at<=?) OR o.state IN ('ready','cancelling','cancelled','failed','completed')
      ORDER BY k.key_expires_at,k.id LIMIT 100)`,
      [now, now]
    );
    return result.rowsAffected;
  }
}
