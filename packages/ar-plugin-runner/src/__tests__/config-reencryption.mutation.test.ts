import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptValue, deriveEncryptionKey } from '@authrim/ar-lib-plugin';
import { D1PluginConfigStore } from '../config-store';
import { D1PluginConfigReencryptor } from '../config-reencryption';
import type { PluginEncryptionKeyring } from '../encryption-keyring';
import { D1DynamicPluginInstallationStore } from '../dynamic-worker-installations';
import { must } from './helpers/mock-kit';
import { rows, seedPlugin } from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

const OLD_SECRET = 'old-plugin-encryption-secret-value-0123456789';
const NEW_SECRET = 'new-plugin-encryption-secret-value-0123456789';
const MUTATION_KEY = 'plugin-runner-mutation-hmac-key-value';
const ROTATED: PluginEncryptionKeyring = {
  active: { id: 'v2', secret: NEW_SECRET },
  previous: { id: 'v1', secret: OLD_SECRET },
};
const GRACE = 7 * 24 * 60 * 60;

let database: DatabaseSync;
const ids: string[] = [];

async function seedTenant(tenantId: string, value: string): Promise<string> {
  const d1 = createD1(database);
  const installations = new D1DynamicPluginInstallationStore(d1.db, 'test', () => 5);
  const created = await installations.configure({ tenantId, pluginId: 'plugin-a', enabled: false });
  await new D1PluginConfigStore(d1.db, OLD_SECRET, MUTATION_KEY, () => 6).replaceCredentials({
    operationId: `credential-${tenantId}`,
    tenantId,
    installationId: created.installationId,
    expectedConfigVersion: 1,
    credentials: [
      {
        configKey: 'apiKey',
        destinationHost: 'api.example.com',
        injectionKind: 'bearer',
        injectionName: 'Authorization',
        value,
      },
    ],
  });
  ids.push(created.installationId);
  return created.installationId;
}

function reencryptor(options: D1Options = {}, now = 1_000, keyring = ROTATED) {
  const d1 = createD1(database, options);
  return { rotation: new D1PluginConfigReencryptor(d1.db, keyring, () => now), calls: d1.calls };
}
const rotationRow = () =>
  database.prepare('SELECT * FROM plugin_runner_config_key_rotations').get() as
    | Record<string, unknown>
    | undefined;
const configRows = () =>
  rows<Record<string, unknown>>(
    database,
    'SELECT * FROM plugin_runner_encrypted_configs ORDER BY installation_id'
  );

beforeEach(async () => {
  database = openRunnerDatabase();
  seedPlugin(database, { slots: [{ configKey: 'apiKey', required: true }] });
  ids.length = 0;
});

describe('construction', () => {
  it('validates the keyring', () => {
    const db = createD1(database).db;
    expect(
      () => new D1PluginConfigReencryptor(db, { active: { id: 'v1', secret: 'short' } })
    ).toThrow(/^plugin_encryption_keyring_invalid$/u);
    expect(() => new D1PluginConfigReencryptor(db, ROTATED)).not.toThrow();
  });
});

describe('start', () => {
  const start = (operationId: unknown, options: D1Options = {}, now = 1_000, keyring = ROTATED) =>
    reencryptor(options, now, keyring).rotation.start(operationId);
  it.each([
    ['a number', 5],
    ['null', null],
    ['an empty id', ''],
    ['an unsafe id', '-x'],
    ['an id with a space', 'a b'],
    ['an over-long id', 'a'.repeat(257)],
  ])('rejects %s', async (_label, operationId) => {
    await expect(start(operationId)).rejects.toThrow(/^plugin_config_reencryption_input_invalid$/u);
    expect(rotationRow()).toBeUndefined();
  });
  it('needs a previous key to rotate from', async () => {
    await expect(
      start('op-1', {}, 1_000, { active: { id: 'v2', secret: NEW_SECRET } })
    ).rejects.toThrow(/^plugin_config_reencryption_input_invalid$/u);
  });
  it('needs the sessions API', async () => {
    await expect(start('op-1', { withoutSession: true })).rejects.toThrow(
      /^plugin_config_reencryption_d1_session_required$/u
    );
  });
  it('records the rotation with the number of rows still under the previous key', async () => {
    await seedTenant('tenant-a', 'secret-a');
    await seedTenant('tenant-b', 'secret-b');
    await expect(start('op-1')).resolves.toEqual({ operationId: 'op-1', sourceCount: 2 });
    expect(rotationRow()).toMatchObject({
      operation_id: 'op-1',
      active_operation_key: 'active',
      from_key_id: 'v1',
      to_key_id: 'v2',
      state: 'reencrypting',
      source_count: 2,
      reencrypted_count: 0,
      created_at: 1_000,
      updated_at: 1_000,
      cursor_installation_id: null,
    });
  });
  it('counts only rows under the previous key and accepts an empty store', async () => {
    await expect(start('op-1')).resolves.toEqual({ operationId: 'op-1', sourceCount: 0 });
  });
  it('is idempotent for the same operation and keyring', async () => {
    await seedTenant('tenant-a', 'secret-a');
    await start('op-1');
    await seedTenant('tenant-b', 'secret-b');
    await expect(start('op-1', {}, 2_000)).resolves.toEqual({
      operationId: 'op-1',
      sourceCount: 1,
    });
    expect(rotationRow()).toMatchObject({ created_at: 1_000 });
  });
  it.each([
    ['another operation', 'op-2', ROTATED],
    [
      'another previous key',
      'op-1',
      {
        active: ROTATED.active,
        previous: { id: 'v0', secret: 'zero-plugin-encryption-secret-value-0123456789' },
      },
    ],
    [
      'another active key',
      'op-1',
      { active: { id: 'v3', secret: NEW_SECRET }, previous: ROTATED.previous },
    ],
  ] as const)(
    'refuses to start over an active rotation for %s',
    async (_label, operationId, keyring) => {
      await start('op-1');
      await expect(
        start(operationId, {}, 1_000, keyring as PluginEncryptionKeyring)
      ).rejects.toThrow(/^plugin_config_reencryption_conflict$/u);
    }
  );
  it('reports a rotation that was not recorded', async () => {
    await expect(
      start('op-1', {
        intercept: (call) =>
          call.kind === 'run'
            ? { value: { success: true, results: [], meta: { changes: 0 } } }
            : undefined,
      })
    ).rejects.toThrow(/^plugin_config_reencryption_start_failed$/u);
    await expect(
      start('op-1', {
        intercept: (call) =>
          call.kind === 'run' ? { value: { success: true, results: [], meta: {} } } : undefined,
      })
    ).rejects.toThrow(/^plugin_config_reencryption_start_failed$/u);
  });
  it.each([
    ['an unreadable count', { count: 'x' }],
    ['a negative count', { count: -1 }],
    ['a fractional count', { count: 1.5 }],
  ])('refuses %s', async (_label, value) => {
    await expect(
      start('op-1', {
        intercept: (call) =>
          call.kind === 'first' && call.sql.includes('COUNT(*)') ? { value } : undefined,
      })
    ).rejects.toThrow(/^plugin_config_reencryption_count_invalid$/u);
  });
  it('treats a missing count row as zero and reads a numeric string', async () => {
    await expect(
      start('op-1', {
        intercept: (call) =>
          call.kind === 'first' && call.sql.includes('COUNT(*)') ? { value: null } : undefined,
      })
    ).resolves.toEqual({ operationId: 'op-1', sourceCount: 0 });
    database.exec('DELETE FROM plugin_runner_config_key_rotations');
    await expect(
      start('op-2', {
        intercept: (call) =>
          call.kind === 'first' && call.sql.includes('COUNT(*)')
            ? { value: { count: '3' } }
            : undefined,
      })
    ).resolves.toEqual({ operationId: 'op-2', sourceCount: 3 });
  });
  it('reports a count of an adopted rotation that cannot be read', async () => {
    await start('op-1');
    database.exec('UPDATE plugin_runner_config_key_rotations SET source_count = 0');
    await expect(
      start('op-1', {
        intercept: (call) =>
          call.kind === 'first' && call.sql.includes('FROM plugin_runner_config_key_rotations')
            ? { value: { ...rotationRow(), source_count: 'x' } }
            : undefined,
      })
    ).rejects.toThrow(/^plugin_config_reencryption_count_invalid$/u);
  });
});

describe('ensureActive', () => {
  it('does nothing without a previous key', async () => {
    const { rotation } = reencryptor({}, 1_000, { active: { id: 'v2', secret: NEW_SECRET } });
    await expect(rotation.ensureActive()).resolves.toBeNull();
    expect(rotationRow()).toBeUndefined();
  });
  it('starts the automatic rotation for the configured keys', async () => {
    await seedTenant('tenant-a', 'secret-a');
    await expect(reencryptor().rotation.ensureActive()).resolves.toEqual({
      operationId: 'auto:v1:v2',
      sourceCount: 1,
    });
    expect(rotationRow()).toMatchObject({ operation_id: 'auto:v1:v2' });
  });
  it('adopts the rotation that is already active', async () => {
    await reencryptor().rotation.start('manual-op');
    await expect(reencryptor().rotation.ensureActive()).resolves.toEqual({
      operationId: 'manual-op',
      sourceCount: 0,
    });
  });
  it('refuses an active rotation between other keys', async () => {
    await reencryptor().rotation.start('manual-op');
    await expect(
      reencryptor({}, 1_000, {
        active: { id: 'v3', secret: NEW_SECRET },
        previous: { id: 'v2', secret: OLD_SECRET },
      }).rotation.ensureActive()
    ).rejects.toThrow(/^plugin_config_reencryption_keyring_mismatch$/u);
  });
  it('adopts a rotation another instance started in the meantime', async () => {
    let calls = 0;
    const { rotation } = reencryptor({
      intercept: (call) => {
        if (
          call.kind === 'run' &&
          call.sql.includes('INSERT INTO plugin_runner_config_key_rotations')
        ) {
          calls += 1;
          database.exec(
            "INSERT INTO plugin_runner_config_key_rotations (operation_id, active_operation_key, from_key_id, to_key_id, state, source_count, reencrypted_count, created_at, updated_at) VALUES ('auto:v1:v2', 'active', 'v1', 'v2', 'reencrypting', 4, 0, 1, 1)"
          );
          throw new Error('unique constraint');
        }
        return undefined;
      },
    });
    await expect(rotation.ensureActive()).resolves.toEqual({
      operationId: 'auto:v1:v2',
      sourceCount: 4,
    });
    expect(calls).toBe(1);
  });
  it('surfaces the start failure when nothing is active afterwards', async () => {
    const { rotation } = reencryptor({
      intercept: (call) => {
        if (call.kind === 'run') throw new Error('d1 down');
        return undefined;
      },
    });
    await expect(rotation.ensureActive()).rejects.toThrow(/^d1 down$/u);
  });
});

describe('adoption and clock edges', () => {
  const KEYRINGS: Array<[string, PluginEncryptionKeyring]> = [
    [
      'another previous key only',
      {
        active: ROTATED.active,
        previous: { id: 'v0', secret: 'zero-plugin-encryption-secret-value-0123456789' },
      },
    ],
    [
      'another active key only',
      { active: { id: 'v3', secret: NEW_SECRET }, previous: ROTATED.previous },
    ],
  ];
  it.each(KEYRINGS)('refuses to adopt or advance a rotation under %s', async (_label, keyring) => {
    await reencryptor().rotation.start('op-1');
    await expect(reencryptor({}, 1_000, keyring).rotation.ensureActive()).rejects.toThrow(
      /^plugin_config_reencryption_keyring_mismatch$/u
    );
    await expect(reencryptor({}, 1_000, keyring).rotation.advanceActive()).rejects.toThrow(
      /^plugin_config_reencryption_keyring_mismatch$/u
    );
  });
  it('refuses an unreadable source count when adopting a rotation', async () => {
    await reencryptor().rotation.start('op-1');
    const row = rotationRow();
    await expect(
      reencryptor({
        rewrite: (call, value) =>
          call.kind === 'first' && call.sql.includes('FROM plugin_runner_config_key_rotations')
            ? { ...(row as object), source_count: 'x' }
            : value,
      }).rotation.ensureActive()
    ).rejects.toThrow(/^plugin_config_reencryption_count_invalid$/u);
  });
  it('reads from the primary and defaults the clock to the current time in seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_777_900);
    try {
      const d1 = createD1(database);
      await new D1PluginConfigReencryptor(d1.db, ROTATED).start('op-1');
      expect(d1.calls.find((c) => c.kind === 'session')?.sql).toBe('first-primary');
      expect(rotationRow()).toMatchObject({ created_at: 1_700_000_777, updated_at: 1_700_000_777 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('advanceActive', () => {
  const advance = (options: D1Options = {}, now = 2_000, keyring = ROTATED) =>
    reencryptor(options, now, keyring).rotation.advanceActive();
  it('is idle without a rotation', async () => {
    await expect(advance()).resolves.toBe('idle');
  });
  it.each([
    ['no previous key', { active: ROTATED.active }],
    [
      'another previous key',
      {
        active: ROTATED.active,
        previous: { id: 'v0', secret: 'zero-plugin-encryption-secret-value-0123456789' },
      },
    ],
    [
      'another active key',
      { active: { id: 'v3', secret: NEW_SECRET }, previous: ROTATED.previous },
    ],
  ])('refuses to advance with %s', async (_label, keyring) => {
    await reencryptor().rotation.start('op-1');
    await expect(advance({}, 2_000, keyring as PluginEncryptionKeyring)).rejects.toThrow(
      /^plugin_config_reencryption_keyring_mismatch$/u
    );
  });
  it('re-encrypts every row, binding each ciphertext to its tenant, plugin, key and version', async () => {
    const first = await seedTenant('tenant-a', 'secret-a');
    const second = await seedTenant('tenant-b', 'secret-b');
    const before = configRows();
    await reencryptor().rotation.start('op-1');
    await expect(advance()).resolves.toBe('reencrypting');
    const after = configRows();
    expect(after.map((row) => row.encryption_key_id)).toEqual(['v2', 'v2']);
    expect(after.map((row) => row.reencrypt_state)).toEqual(['verified', 'verified']);
    expect(after.map((row) => row.updated_at)).toEqual([2_000, 2_000]);
    const newKey = await deriveEncryptionKey(NEW_SECRET);
    for (const [index, installationId] of [first, second].entries()) {
      const row = must(after.find((candidate) => candidate.installation_id === installationId));
      const tenant = index === 0 ? 'tenant-a' : 'tenant-b';
      const aadFor = (t: string, v: number) =>
        new TextEncoder().encode(JSON.stringify([t, 'plugin-a', 'apiKey', v]));
      await expect(
        decryptValue(String(row.encrypted_value), newKey, aadFor(tenant, 2))
      ).resolves.toBe(index === 0 ? 'secret-a' : 'secret-b');
      await expect(
        decryptValue(String(row.encrypted_value), newKey, aadFor(tenant, 3))
      ).rejects.toThrow();
      expect(row.encrypted_value).not.toBe(
        before.find((b) => b.installation_id === installationId)?.encrypted_value
      );
      const nonce = String(row.encrypted_value).split(':')[2];
      expect(row.nonce_fingerprint).toBe(await hmac(NEW_SECRET, `v2:${nonce}`));
    }
    const sorted = [first, second].sort();
    expect(rotationRow()).toMatchObject({
      state: 'reencrypting',
      reencrypted_count: 2,
      cursor_installation_id: sorted[1],
      cursor_config_key: 'apiKey',
      cursor_config_version: 2,
      updated_at: 2_000,
    });
  });
  async function hmac(secret: string, value: string): Promise<string> {
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
  it('selects at most fifty rows of the previous key after the cursor', async () => {
    await seedTenant('tenant-a', 'secret-a');
    await reencryptor().rotation.start('op-1');
    const { rotation, calls } = reencryptor();
    await rotation.advanceActive();
    const query = must(calls.find((c) => c.kind === 'all'));
    expect(query.values).toEqual(['v1', null, null, null, null, null, null, null, 50]);
    const cursor = rotationRow();
    const second = reencryptor();
    await second.rotation.advanceActive();
    expect(must(second.calls.find((c) => c.kind === 'all')).values).toEqual([
      'v1',
      cursor?.cursor_installation_id,
      cursor?.cursor_installation_id,
      cursor?.cursor_installation_id,
      'apiKey',
      cursor?.cursor_installation_id,
      'apiKey',
      2,
      50,
    ]);
  });
  it('moves to the grace period once nothing is left and completes it only after the grace', async () => {
    await seedTenant('tenant-a', 'secret-a');
    await reencryptor().rotation.start('op-1');
    await advance();
    await expect(advance({}, 3_000)).resolves.toBe('grace');
    expect(rotationRow()).toMatchObject({
      state: 'grace',
      grace_until: 3_000 + GRACE,
      updated_at: 3_000,
    });
    await expect(advance({}, 3_000 + GRACE - 1)).resolves.toBe('grace');
    expect(rotationRow()).toMatchObject({ state: 'grace' });
    await expect(advance({}, 3_000 + GRACE)).resolves.toBe('complete');
    expect(rotationRow()).toMatchObject({
      state: 'complete',
      active_operation_key: 'operation:op-1',
      completed_at: 3_000 + GRACE,
      updated_at: 3_000 + GRACE,
    });
    await expect(advance({}, 3_000 + GRACE + 1)).resolves.toBe('idle');
  });
  it('completes an empty rotation straight through the grace period', async () => {
    await reencryptor().rotation.start('op-1');
    await expect(advance()).resolves.toBe('grace');
    expect(rotationRow()).toMatchObject({ grace_until: 2_000 + GRACE });
  });
  it('refuses to complete while rows still use the previous key', async () => {
    await reencryptor().rotation.start('op-1');
    await advance();
    await seedTenant('tenant-late', 'late');
    await expect(advance({}, 2_000 + GRACE)).rejects.toThrow(
      /^plugin_config_reencryption_verification_failed$/u
    );
    expect(rotationRow()).toMatchObject({ state: 'grace' });
  });
  it('refuses to start the grace while rows remain behind the cursor', async () => {
    await seedTenant('tenant-b', 'b');
    await reencryptor().rotation.start('op-1');
    await advance();
    // A row of the previous key appears behind the cursor, where the scan never looks again.
    await seedTenant('tenant-a', 'a');
    database.exec(
      `UPDATE plugin_runner_config_key_rotations SET cursor_installation_id = 'zzz', cursor_config_key = 'zzz', cursor_config_version = 9`
    );
    await expect(advance()).rejects.toThrow(/^plugin_config_reencryption_verification_failed$/u);
  });
  it.each([
    ['a blocked rotation', "UPDATE plugin_runner_config_key_rotations SET state = 'blocked'"],
  ])('refuses %s', async (_label, sql) => {
    await reencryptor().rotation.start('op-1');
    database.exec(sql);
    await expect(advance()).rejects.toThrow(/^plugin_config_reencryption_state_invalid$/u);
  });
  it('reports a grace period without a deadline', async () => {
    await reencryptor().rotation.start('op-1');
    await advance();
    const row = rotationRow();
    await expect(
      advance({
        intercept: (call) =>
          call.kind === 'first' && call.sql.includes('FROM plugin_runner_config_key_rotations')
            ? { value: { ...row, state: 'grace', grace_until: 0 } }
            : undefined,
      })
    ).rejects.toThrow(/^plugin_config_reencryption_grace_invalid$/u);
  });
  it('reports a stale completion or grace transition', async () => {
    await reencryptor().rotation.start('op-1');
    const stale = {
      intercept: (call: { kind: string }) =>
        call.kind === 'run'
          ? { value: { success: true, results: [], meta: { changes: 0 } } }
          : undefined,
    };
    await expect(advance(stale)).rejects.toThrow(/^plugin_config_reencryption_grace_stale$/u);
    await advance();
    await expect(advance(stale, 2_000 + GRACE)).rejects.toThrow(
      /^plugin_config_reencryption_completion_stale$/u
    );
  });
  it('refuses an unreadable cursor version', async () => {
    await reencryptor().rotation.start('op-1');
    const row = rotationRow();
    for (const version of [0, 'x', 1.5]) {
      await expect(
        advance({
          intercept: (call) =>
            call.kind === 'first' && call.sql.includes('FROM plugin_runner_config_key_rotations')
              ? {
                  value: {
                    ...row,
                    cursor_installation_id: 'i',
                    cursor_config_key: 'k',
                    cursor_config_version: version,
                  },
                }
              : undefined,
        })
      ).rejects.toThrow(/^plugin_config_reencryption_cursor_invalid$/u);
    }
  });
  it('refuses a row whose tenant or plugin could not have been encrypted for', async () => {
    const id = await seedTenant('tenant-a', 'a');
    await reencryptor().rotation.start('op-1');
    database.exec(
      `UPDATE plugin_runner_installations SET tenant_id = 'bad tenant' WHERE installation_id = '${id}'`
    );
    await expect(advance()).rejects.toThrow(/^plugin_config_reencryption_row_invalid$/u);
    database.exec(
      `UPDATE plugin_runner_installations SET tenant_id = 'tenant-a' WHERE installation_id = '${id}'`
    );
  });
  it('refuses a ciphertext that does not belong to its tenant', async () => {
    const id = await seedTenant('tenant-a', 'a');
    await reencryptor().rotation.start('op-1');
    database.exec(
      `UPDATE plugin_runner_installations SET tenant_id = 'tenant-z' WHERE installation_id = '${id}'`
    );
    await expect(advance()).rejects.toThrow();
    expect(configRows()[0]).toMatchObject({ encryption_key_id: 'v1' });
  });
  it('refuses an unreadable row version', async () => {
    await seedTenant('tenant-a', 'a');
    await reencryptor().rotation.start('op-1');
    const real = configRows()[0];
    for (const version of [0, 'x']) {
      await expect(
        advance({
          intercept: (call) =>
            call.kind === 'all' && call.sql.includes('JOIN plugin_runner_installations')
              ? {
                  value: {
                    success: true,
                    meta: {},
                    results: [
                      {
                        ...real,
                        tenant_id: 'tenant-a',
                        plugin_id: 'plugin-a',
                        config_version: version,
                      },
                    ],
                  },
                }
              : undefined,
        })
      ).rejects.toThrow(/^plugin_config_reencryption_version_invalid$/u);
    }
  });
  it('refuses a batch that the database did not apply entirely', async () => {
    await seedTenant('tenant-a', 'a');
    await reencryptor().rotation.start('op-1');
    const ok = { success: true, results: [], meta: { changes: 1 } };
    for (const results of [
      [ok],
      [ok, ok, ok],
      [{ ...ok, success: false }, ok],
      [ok, { ...ok, error: 'x' }],
      [ok, { ...ok, meta: { changes: 0 } }],
      [ok, { ...ok, meta: {} }],
    ]) {
      await expect(
        advance({ intercept: (call) => (call.kind === 'batch' ? { value: results } : undefined) })
      ).rejects.toThrow(/^plugin_config_reencryption_batch_failed$/u);
    }
  });
  it('refuses a batch when another worker advanced the rotation meanwhile', async () => {
    await seedTenant('tenant-a', 'a');
    await reencryptor().rotation.start('op-1');
    await expect(
      advance({
        intercept: (call) => {
          if (call.kind === 'batch') {
            database.exec('UPDATE plugin_runner_config_key_rotations SET reencrypted_count = 7');
          }
          return undefined;
        },
      })
    ).rejects.toThrow(/^plugin_config_reencryption_batch_failed$/u);
    expect(rotationRow()).toMatchObject({ reencrypted_count: 7, cursor_installation_id: null });
  });
  it('refuses a rotation whose counters are unreadable', async () => {
    await seedTenant('tenant-a', 'a');
    await reencryptor().rotation.start('op-1');
    const row = rotationRow();
    await expect(
      advance({
        intercept: (call) =>
          call.kind === 'first' && call.sql.includes('FROM plugin_runner_config_key_rotations')
            ? { value: { ...row, reencrypted_count: 'x' } }
            : undefined,
      })
    ).rejects.toThrow(/^plugin_config_reencryption_count_invalid$/u);
  });
  it('reads a missing remaining-count row as zero', async () => {
    await reencryptor().rotation.start('op-1');
    await expect(
      advance({
        intercept: (call) =>
          call.kind === 'first' && call.sql.includes('COUNT(*)') ? { value: null } : undefined,
      })
    ).resolves.toBe('grace');
  });
});
