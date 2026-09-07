import type { D1Database, D1DatabaseSession, D1Result } from '@cloudflare/workers-types';
import { decryptValue, deriveEncryptionKey, encryptValue } from '@authrim/ar-lib-plugin';
import {
  type PluginEncryptionKeyring,
  pluginEncryptionSecretFor,
  validatePluginEncryptionKeyring,
} from './encryption-keyring';

const BATCH_LIMIT = 50;
const GRACE_SECONDS = 7 * 24 * 60 * 60;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

interface RotationRow {
  operation_id: string;
  from_key_id: string;
  to_key_id: string;
  state: string;
  cursor_installation_id: string | null;
  cursor_config_key: string | null;
  cursor_config_version: number | string | null;
  source_count: number | string;
  reencrypted_count: number | string;
  grace_until: number | string | null;
}

interface ConfigRow {
  installation_id: string;
  tenant_id: string;
  plugin_id: string;
  config_key: string;
  config_version: number | string;
  encrypted_value: string;
  nonce_fingerprint: string;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('plugin_config_reencryption_d1_session_required');
  }
  return db.withSession('first-primary');
}

function integer(value: number | string | null, code: string, minimum = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(code);
  return parsed;
}

function aad(input: {
  tenantId: string;
  pluginId: string;
  configKey: string;
  configVersion: number;
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([input.tenantId, input.pluginId, input.configKey, input.configVersion])
  );
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertBatch(results: D1Result<unknown>[], expected: number): void {
  if (
    results.length !== expected ||
    results.some(
      (result) =>
        result.success !== true || result.error !== undefined || (result.meta.changes ?? 0) !== 1
    )
  ) {
    throw new Error('plugin_config_reencryption_batch_failed');
  }
}

export class D1PluginConfigReencryptor {
  private readonly keyring: PluginEncryptionKeyring;

  constructor(
    private readonly db: D1Database,
    keyring: PluginEncryptionKeyring,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)
  ) {
    this.keyring = validatePluginEncryptionKeyring(keyring);
  }

  async start(operationId: unknown): Promise<{ operationId: string; sourceCount: number }> {
    if (typeof operationId !== 'string' || !SAFE_ID.test(operationId) || !this.keyring.previous) {
      throw new Error('plugin_config_reencryption_input_invalid');
    }
    const session = primary(this.db);
    const existing = await session
      .prepare(
        `SELECT operation_id, from_key_id, to_key_id, state,
                cursor_installation_id, cursor_config_key, cursor_config_version,
                source_count, reencrypted_count, grace_until
           FROM plugin_runner_config_key_rotations WHERE active_operation_key = 'active'`
      )
      .bind()
      .first<RotationRow>();
    if (existing) {
      if (
        existing.operation_id !== operationId ||
        existing.from_key_id !== this.keyring.previous.id ||
        existing.to_key_id !== this.keyring.active.id
      ) {
        throw new Error('plugin_config_reencryption_conflict');
      }
      return {
        operationId,
        sourceCount: integer(existing.source_count, 'plugin_config_reencryption_count_invalid'),
      };
    }
    const count = await session
      .prepare(
        `SELECT COUNT(*) AS count FROM plugin_runner_encrypted_configs
          WHERE encryption_key_id = ?`
      )
      .bind(this.keyring.previous.id)
      .first<{ count: number | string }>();
    const sourceCount = integer(count?.count ?? 0, 'plugin_config_reencryption_count_invalid');
    const now = this.now();
    const result = await session
      .prepare(
        `INSERT INTO plugin_runner_config_key_rotations (
           operation_id, active_operation_key, from_key_id, to_key_id, state,
           source_count, reencrypted_count, created_at, updated_at
         ) VALUES (?, 'active', ?, ?, 'reencrypting', ?, 0, ?, ?)`
      )
      .bind(operationId, this.keyring.previous.id, this.keyring.active.id, sourceCount, now, now)
      .run();
    if ((result.meta.changes ?? 0) !== 1)
      throw new Error('plugin_config_reencryption_start_failed');
    return { operationId, sourceCount };
  }

  async ensureActive(): Promise<{ operationId: string; sourceCount: number } | null> {
    if (!this.keyring.previous) return null;
    const session = primary(this.db);
    const existing = await session
      .prepare(
        `SELECT operation_id, from_key_id, to_key_id, state,
                cursor_installation_id, cursor_config_key, cursor_config_version,
                source_count, reencrypted_count, grace_until
           FROM plugin_runner_config_key_rotations WHERE active_operation_key = 'active'`
      )
      .bind()
      .first<RotationRow>();
    if (existing) return this.adoptActive(existing);

    const operationId = `auto:${this.keyring.previous.id}:${this.keyring.active.id}`;
    try {
      return await this.start(operationId);
    } catch (error) {
      const adopted = await session
        .prepare(
          `SELECT operation_id, from_key_id, to_key_id, state,
                  cursor_installation_id, cursor_config_key, cursor_config_version,
                  source_count, reencrypted_count, grace_until
             FROM plugin_runner_config_key_rotations WHERE active_operation_key = 'active'`
        )
        .bind()
        .first<RotationRow>();
      if (adopted) return this.adoptActive(adopted);
      throw error;
    }
  }

  async advanceActive(): Promise<'idle' | 'reencrypting' | 'grace' | 'complete'> {
    const session = primary(this.db);
    const rotation = await session
      .prepare(
        `SELECT operation_id, from_key_id, to_key_id, state,
                cursor_installation_id, cursor_config_key, cursor_config_version,
                source_count, reencrypted_count, grace_until
           FROM plugin_runner_config_key_rotations WHERE active_operation_key = 'active'`
      )
      .bind()
      .first<RotationRow>();
    if (!rotation) return 'idle';
    if (
      !this.keyring.previous ||
      rotation.from_key_id !== this.keyring.previous.id ||
      rotation.to_key_id !== this.keyring.active.id
    ) {
      throw new Error('plugin_config_reencryption_keyring_mismatch');
    }
    const now = this.now();
    if (rotation.state === 'grace') {
      const graceUntil = integer(
        rotation.grace_until,
        'plugin_config_reencryption_grace_invalid',
        1
      );
      if (now < graceUntil) return 'grace';
      const remaining = await this.remaining(session, rotation.from_key_id);
      if (remaining !== 0) throw new Error('plugin_config_reencryption_verification_failed');
      const completed = await session
        .prepare(
          `UPDATE plugin_runner_config_key_rotations
              SET state = 'complete', active_operation_key = 'operation:' || operation_id,
                  completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND active_operation_key = 'active' AND state = 'grace'
              AND grace_until <= ?`
        )
        .bind(now, now, rotation.operation_id, now)
        .run();
      if ((completed.meta.changes ?? 0) !== 1) {
        throw new Error('plugin_config_reencryption_completion_stale');
      }
      return 'complete';
    }
    if (rotation.state !== 'reencrypting') {
      throw new Error('plugin_config_reencryption_state_invalid');
    }
    const cursorVersion =
      rotation.cursor_config_version === null
        ? null
        : integer(rotation.cursor_config_version, 'plugin_config_reencryption_cursor_invalid', 1);
    const rows = await session
      .prepare(
        `SELECT config.installation_id, installation.tenant_id, installation.plugin_id,
                config.config_key, config.config_version, config.encrypted_value,
                config.nonce_fingerprint
           FROM plugin_runner_encrypted_configs config
           JOIN plugin_runner_installations installation
             ON installation.installation_id = config.installation_id
          WHERE config.encryption_key_id = ? AND (
            ? IS NULL OR config.installation_id > ? OR
            (config.installation_id = ? AND config.config_key > ?) OR
            (config.installation_id = ? AND config.config_key = ? AND config.config_version > ?)
          )
          ORDER BY config.installation_id, config.config_key, config.config_version
          LIMIT ?`
      )
      .bind(
        rotation.from_key_id,
        rotation.cursor_installation_id,
        rotation.cursor_installation_id,
        rotation.cursor_installation_id,
        rotation.cursor_config_key,
        rotation.cursor_installation_id,
        rotation.cursor_config_key,
        cursorVersion,
        BATCH_LIMIT
      )
      .all<ConfigRow>();
    if (rows.results.length === 0) {
      if ((await this.remaining(session, rotation.from_key_id)) !== 0) {
        throw new Error('plugin_config_reencryption_verification_failed');
      }
      const grace = await session
        .prepare(
          `UPDATE plugin_runner_config_key_rotations
              SET state = 'grace', grace_until = ?, updated_at = ?
            WHERE operation_id = ? AND active_operation_key = 'active'
              AND state = 'reencrypting'`
        )
        .bind(now + GRACE_SECONDS, now, rotation.operation_id)
        .run();
      if ((grace.meta.changes ?? 0) !== 1) {
        throw new Error('plugin_config_reencryption_grace_stale');
      }
      return 'grace';
    }
    const oldKey = await deriveEncryptionKey(
      pluginEncryptionSecretFor(this.keyring, rotation.from_key_id)
    );
    const newKey = await deriveEncryptionKey(
      pluginEncryptionSecretFor(this.keyring, rotation.to_key_id)
    );
    const transformed = await Promise.all(
      rows.results.map(async (row) => {
        if (!SAFE_ID.test(row.tenant_id) || !SAFE_ID.test(row.plugin_id)) {
          throw new Error('plugin_config_reencryption_row_invalid');
        }
        const version = integer(
          row.config_version,
          'plugin_config_reencryption_version_invalid',
          1
        );
        const additionalData = aad({
          tenantId: row.tenant_id,
          pluginId: row.plugin_id,
          configKey: row.config_key,
          configVersion: version,
        });
        const plaintext = await decryptValue(row.encrypted_value, oldKey, additionalData);
        const encryptedValue = await encryptValue(plaintext, newKey, additionalData);
        if ((await decryptValue(encryptedValue, newKey, additionalData)) !== plaintext) {
          throw new Error('plugin_config_reencryption_verification_failed');
        }
        const parts = encryptedValue.split(':');
        if (parts.length !== 4 || !parts[2]) {
          throw new Error('plugin_config_reencryption_envelope_invalid');
        }
        return {
          ...row,
          version,
          encryptedValue,
          nonceFingerprint: await hmacHex(
            this.keyring.active.secret,
            `${rotation.to_key_id}:${parts[2]}`
          ),
        };
      })
    );
    const last = transformed.at(-1);
    if (!last) throw new Error('plugin_config_reencryption_batch_empty');
    const statements = [
      ...transformed.map((row) =>
        session
          .prepare(
            `UPDATE plugin_runner_encrypted_configs
                SET encryption_key_id = ?, encrypted_value = ?, nonce_fingerprint = ?,
                    reencrypt_state = 'verified', updated_at = ?
              WHERE installation_id = ? AND config_key = ? AND config_version = ?
                AND encryption_key_id = ? AND encrypted_value = ? AND nonce_fingerprint = ?`
          )
          .bind(
            rotation.to_key_id,
            row.encryptedValue,
            row.nonceFingerprint,
            now,
            row.installation_id,
            row.config_key,
            row.version,
            rotation.from_key_id,
            row.encrypted_value,
            row.nonce_fingerprint
          )
      ),
      session
        .prepare(
          `UPDATE plugin_runner_config_key_rotations
              SET cursor_installation_id = ?, cursor_config_key = ?, cursor_config_version = ?,
                  reencrypted_count = reencrypted_count + ?, updated_at = ?
            WHERE operation_id = ? AND active_operation_key = 'active'
              AND state = 'reencrypting' AND reencrypted_count = ?`
        )
        .bind(
          last.installation_id,
          last.config_key,
          last.version,
          transformed.length,
          now,
          rotation.operation_id,
          integer(rotation.reencrypted_count, 'plugin_config_reencryption_count_invalid')
        ),
    ];
    assertBatch(await session.batch(statements), statements.length);
    return 'reencrypting';
  }

  private async remaining(session: D1DatabaseSession, keyId: string): Promise<number> {
    const row = await session
      .prepare(
        `SELECT COUNT(*) AS count FROM plugin_runner_encrypted_configs
          WHERE encryption_key_id = ?`
      )
      .bind(keyId)
      .first<{ count: number | string }>();
    return integer(row?.count ?? 0, 'plugin_config_reencryption_count_invalid');
  }

  private adoptActive(rotation: RotationRow): { operationId: string; sourceCount: number } {
    if (
      !this.keyring.previous ||
      rotation.from_key_id !== this.keyring.previous.id ||
      rotation.to_key_id !== this.keyring.active.id
    ) {
      throw new Error('plugin_config_reencryption_keyring_mismatch');
    }
    return {
      operationId: rotation.operation_id,
      sourceCount: integer(rotation.source_count, 'plugin_config_reencryption_count_invalid'),
    };
  }
}
