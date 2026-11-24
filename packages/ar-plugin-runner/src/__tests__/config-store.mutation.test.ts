import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { decryptValue, deriveEncryptionKey } from '@authrim/ar-lib-plugin';
import { D1PluginConfigStore } from '../config-store';
import { rows, seedInstallation, seedPlugin } from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

const SECRET = 'plugin-encryption-secret-with-32-chars!';
const HMAC = 'plugin-mutation-hmac-secret-with-32-chars';
const INVALID = /^plugin_config_input_invalid$/u;
let database: DatabaseSync;

function store(
  options: D1Options = {},
  now = 1_000,
  keyring: string | { active: { id: string; secret: string } } = SECRET
) {
  const d1 = createD1(database, options);
  return { store: new D1PluginConfigStore(d1.db, keyring, HMAC, () => now), calls: d1.calls };
}
const credential = (over: Record<string, unknown> = {}) => ({
  configKey: 'apiKey',
  destinationHost: 'api.example.com',
  injectionKind: 'bearer',
  injectionName: 'Authorization',
  value: 'secret-value',
  ...over,
});
const request = (over: Record<string, unknown> = {}) => ({
  operationId: 'operation-1',
  tenantId: 'tenant-a',
  installationId: 'installation-a',
  expectedConfigVersion: 1,
  credentials: [credential()],
  ...over,
});
const aad = (key: string, version: number) =>
  new TextEncoder().encode(JSON.stringify(['tenant-a', 'plugin-a', key, version]));

async function dynamicInstallation(state: 'enabled' | 'disabled' = 'disabled') {
  seedPlugin(database, { slots: [{ configKey: 'apiKey', required: true }] });
  const id = await seedInstallation(database, { installationId: 'installation-a', state });
  if (state === 'enabled') {
    database.exec(
      `INSERT INTO plugin_runner_dynamic_worker_artifacts (artifact_id, installation_id, plugin_id, version_digest, state, activated_at, updated_at) VALUES ('art-1', '${id}', 'plugin-a', '${'1'.repeat(64)}', 'active', 1, 1)`
    );
  }
}
async function builtinInstallation() {
  await seedInstallation(database, {
    installationId: 'installation-a',
    pluginId: 'plugin-a',
    backendKind: 'in_process',
    state: 'disabled',
  });
  database.exec(
    "INSERT INTO plugin_runner_egress_allowed_hosts (plugin_id, rule_id, match_kind, host_pattern, created_at) VALUES ('plugin-a', 'r1', 'exact', 'api.example.com', 1)"
  );
}

beforeEach(() => {
  database = openRunnerDatabase();
});

describe('construction', () => {
  it('requires a mutation secret of at least 32 characters', () => {
    const db = createD1(database).db;
    expect(() => new D1PluginConfigStore(db, SECRET, 'a'.repeat(31))).toThrow(
      /^plugin_config_hmac_key_invalid$/u
    );
    expect(() => new D1PluginConfigStore(db, SECRET, 'a'.repeat(32))).not.toThrow();
  });
  it('validates the encryption keyring, accepting a bare secret as key v1', () => {
    const db = createD1(database).db;
    expect(() => new D1PluginConfigStore(db, 'short', HMAC)).toThrow(
      /^plugin_encryption_keyring_invalid$/u
    );
    expect(
      () => new D1PluginConfigStore(db, { active: { id: 'v2', secret: SECRET } }, HMAC)
    ).not.toThrow();
  });
});

describe('input', () => {
  const run = (input: unknown) => store().store.replaceCredentials(input);
  it.each([
    ['null', null],
    ['an array', []],
    ['an extra key', request({ extra: 1 })],
    ['a missing key', request({ operationId: undefined })],
    ['an unsafe operation', request({ operationId: '-x' })],
    ['a numeric operation', request({ operationId: 5 })],
    ['an unsafe tenant', request({ tenantId: '' })],
    ['an unsafe installation', request({ installationId: ' ' })],
    ['a zero version', request({ expectedConfigVersion: 0 })],
    ['a fractional version', request({ expectedConfigVersion: 1.5 })],
    ['a textual version', request({ expectedConfigVersion: '1' })],
    ['non-array credentials', request({ credentials: {} })],
    [
      'seventeen credentials',
      request({
        credentials: Array.from({ length: 17 }, (_, i) =>
          credential({
            configKey: `k${i}`,
            destinationHost: `h${i}.example.com`,
            injectionName: `H-${i}`,
            injectionKind: 'header',
          })
        ),
      }),
    ],
    ['a null credential', request({ credentials: [null] })],
    ['a credential with an extra key', request({ credentials: [credential({ extra: 1 })] })],
    ['a credential without a value', request({ credentials: [credential({ value: undefined })] })],
    ['an unsafe config key', request({ credentials: [credential({ configKey: '1key' })] })],
    ['an unsafe host', request({ credentials: [credential({ destinationHost: 'localhost' })] })],
    [
      'an uppercase host',
      request({ credentials: [credential({ destinationHost: 'API.example.com' })] }),
    ],
    [
      'a host with a path',
      request({ credentials: [credential({ destinationHost: 'api.example.com/x' })] }),
    ],
    [
      'an unknown injection kind',
      request({ credentials: [credential({ injectionKind: 'cookie' })] }),
    ],
    [
      'an unsafe field name',
      request({ credentials: [credential({ injectionKind: 'json_field', injectionName: '1x' })] }),
    ],
    [
      'a bearer credential for another header',
      request({ credentials: [credential({ injectionName: 'X-Token' })] }),
    ],
    [
      'a header credential for Authorization',
      request({
        credentials: [credential({ injectionKind: 'header', injectionName: 'Authorization' })],
      }),
    ],
    [
      'a header credential for Content-Type',
      request({
        credentials: [credential({ injectionKind: 'header', injectionName: 'content-type' })],
      }),
    ],
    [
      'a header name with a dot',
      request({ credentials: [credential({ injectionKind: 'header', injectionName: 'X.Key' })] }),
    ],
    ['an empty value', request({ credentials: [credential({ value: '' })] })],
    ['a numeric value', request({ credentials: [credential({ value: 5 })] })],
    ['an oversized value', request({ credentials: [credential({ value: 'v'.repeat(8_193) })] })],
    [
      'a repeated config key',
      request({
        credentials: [
          credential(),
          credential({
            destinationHost: 'b.example.com',
            injectionKind: 'header',
            injectionName: 'X-Other',
          }),
        ],
      }),
    ],
    [
      'a repeated injection target',
      request({
        credentials: [
          credential(),
          credential({ configKey: 'second', injectionName: 'authorization' }),
        ],
      }),
    ],
  ])('rejects %s', async (_label, input) => {
    await expect(run(input)).rejects.toThrow(INVALID);
    expect(rows(database, 'SELECT * FROM plugin_runner_config_mutations')).toEqual([]);
  });
  it('accepts sixteen credentials, a value of 8192 characters and each injection kind', async () => {
    await builtinInstallation();
    const kinds = [
      credential({ configKey: 'bearerKey', value: 'v'.repeat(8_192) }),
      credential({ configKey: 'headerKey', injectionKind: 'header', injectionName: 'X-Key' }),
      credential({ configKey: 'jsonKey', injectionKind: 'json_field', injectionName: 'secret' }),
      credential({ configKey: 'formKey', injectionKind: 'form_field', injectionName: 'secret2' }),
    ];
    await expect(run(request({ credentials: kinds }))).resolves.toMatchObject({
      credentialCount: 4,
      configVersion: 2,
    });
  });
  it('needs the sessions API', async () => {
    await expect(
      store({ withoutSession: true }).store.replaceCredentials(request())
    ).rejects.toThrow(/^plugin_config_d1_session_required$/u);
  });
});

describe('replacement', () => {
  it('encrypts under the active key with context-bound data and records the mutation', async () => {
    await dynamicInstallation();
    await expect(store().store.replaceCredentials(request())).resolves.toEqual({
      operationId: 'operation-1',
      installationId: 'installation-a',
      configVersion: 2,
      credentialCount: 1,
    });
    const config = rows<Record<string, unknown>>(
      database,
      'SELECT * FROM plugin_runner_encrypted_configs'
    )[0] as Record<string, string | number>;
    expect(config).toMatchObject({
      installation_id: 'installation-a',
      config_key: 'apiKey',
      config_version: 2,
      injection_kind: 'bearer',
      injection_name: 'Authorization',
      destination_host: 'api.example.com',
      encryption_key_id: 'v1',
      reencrypt_state: 'current',
      created_at: 1_000,
      updated_at: 1_000,
    });
    expect(config.nonce_fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    const key = await deriveEncryptionKey(SECRET);
    await expect(decryptValue(String(config.encrypted_value), key, aad('apiKey', 2))).resolves.toBe(
      'secret-value'
    );
    await expect(
      decryptValue(String(config.encrypted_value), key, aad('apiKey', 3))
    ).rejects.toThrow();
    expect(
      rows(
        database,
        'SELECT operation_id, installation_id, tenant_id, fingerprint_key_id, target_config_version, state, created_at, applied_at, updated_at FROM plugin_runner_config_mutations'
      )
    ).toEqual([
      {
        operation_id: 'operation-1',
        installation_id: 'installation-a',
        tenant_id: 'tenant-a',
        fingerprint_key_id: 'mutation-v1',
        target_config_version: 2,
        state: 'applied',
        created_at: 1_000,
        applied_at: 1_000,
        updated_at: 1_000,
      },
    ]);
    expect(
      rows(database, 'SELECT config_version, updated_at FROM plugin_runner_installations')
    ).toEqual([{ config_version: 2, updated_at: 1_000 }]);
  });
  it('labels the stored key with the configured active key id', async () => {
    await dynamicInstallation();
    await store({}, 1_000, { active: { id: 'v7', secret: SECRET } }).store.replaceCredentials(
      request()
    );
    expect(rows(database, 'SELECT encryption_key_id FROM plugin_runner_encrypted_configs')).toEqual(
      [{ encryption_key_id: 'v7' }]
    );
  });
  it('replaces the whole credential set for the next version without touching the previous one', async () => {
    await dynamicInstallation();
    await store().store.replaceCredentials(request());
    await store({}, 2_000).store.replaceCredentials(
      request({
        operationId: 'operation-2',
        expectedConfigVersion: 2,
        credentials: [credential({ value: 'rotated' })],
      })
    );
    expect(
      rows(
        database,
        'SELECT config_version FROM plugin_runner_encrypted_configs ORDER BY config_version'
      )
    ).toEqual([{ config_version: 2 }, { config_version: 3 }]);
  });
  it('works for an enabled installation and a built-in one', async () => {
    await dynamicInstallation('enabled');
    await expect(store().store.replaceCredentials(request())).resolves.toMatchObject({
      configVersion: 2,
    });
    database = openRunnerDatabase();
    await builtinInstallation();
    await expect(store().store.replaceCredentials(request())).resolves.toMatchObject({
      configVersion: 2,
    });
  });
  it.each([
    ['a blocked installation', "UPDATE plugin_runner_installations SET state = 'blocked'"],
    ['another tenant', "UPDATE plugin_runner_installations SET tenant_id = 'tenant-b'"],
  ])('refuses %s', async (_label, sql) => {
    await dynamicInstallation();
    database.exec(sql);
    await expect(store().store.replaceCredentials(request())).rejects.toThrow(
      /^plugin_config_installation_unavailable$/u
    );
  });
  it('refuses a missing installation, an unsafe plugin id or an unknown backend', async () => {
    await expect(store().store.replaceCredentials(request())).rejects.toThrow(
      /^plugin_config_installation_unavailable$/u
    );
    await dynamicInstallation();
    for (const patch of [{ plugin_id: 'bad id' }, { backend_kind: 'wasm' }]) {
      await expect(
        store({
          rewrite: (call, value) =>
            call.kind === 'first' && call.sql.includes('NULL AS dynamic_version_digest') && value
              ? { ...value, ...patch }
              : value,
        }).store.replaceCredentials(request())
      ).rejects.toThrow(/^plugin_config_installation_unavailable$/u);
    }
  });
  it('refuses a stale expected version', async () => {
    await dynamicInstallation();
    await expect(
      store().store.replaceCredentials(request({ expectedConfigVersion: 2 }))
    ).rejects.toThrow(/^plugin_config_version_conflict$/u);
    await expect(
      store().store.replaceCredentials(request({ expectedConfigVersion: 3 }))
    ).rejects.toThrow(/^plugin_config_version_conflict$/u);
  });
  it('refuses an unreadable stored version', async () => {
    await dynamicInstallation();
    await expect(
      store({
        rewrite: (call, value) =>
          call.kind === 'first' && call.sql.includes('NULL AS dynamic_version_digest') && value
            ? { ...value, config_version: 'x' }
            : value,
      }).store.replaceCredentials(request())
    ).rejects.toThrow(/^plugin_config_version_invalid$/u);
  });
  it('refuses a dynamic installation whose release is not available', async () => {
    await dynamicInstallation();
    database.exec("UPDATE plugin_runner_dynamic_worker_manifests SET state = 'revoked'");
    await expect(store().store.replaceCredentials(request())).rejects.toThrow(
      /^plugin_config_installation_unavailable$/u
    );
  });
  it('refuses a destination host the policy does not approve', async () => {
    await dynamicInstallation();
    await expect(
      store().store.replaceCredentials(
        request({ credentials: [credential({ destinationHost: 'evil.example.com' })] })
      )
    ).rejects.toThrow(/^plugin_config_host_not_approved$/u);
  });
  it('refuses a policy with more than 100 approved hosts', async () => {
    await dynamicInstallation();
    await expect(
      store({
        rewrite: (call, value) =>
          call.kind === 'all' && call.sql.includes('host_pattern')
            ? {
                ...(value as object),
                results: Array.from({ length: 101 }, () => ({ host_pattern: 'api.example.com' })),
              }
            : value,
      }).store.replaceCredentials(request())
    ).rejects.toThrow(/^plugin_config_host_policy_invalid$/u);
  });
  it.each([
    ['an undeclared key', { configKey: 'other' }],
    ['another host', { destinationHost: 'api2.example.com' }],
    ['another kind', { injectionKind: 'header', injectionName: 'X-Key' }],
    ['another name', { injectionKind: 'bearer', injectionName: 'Authorization2' }],
  ])('refuses a credential for %s of the release slot', async (_label, patch) => {
    await dynamicInstallation();
    database.exec(
      "INSERT INTO plugin_runner_dynamic_worker_egress_allowed_hosts (plugin_id, version_digest, rule_id, match_kind, host_pattern, created_at) VALUES ('plugin-a', '" +
        '1'.repeat(64) +
        "', 'extra', 'exact', 'api2.example.com', 1)"
    );
    await expect(
      store().store.replaceCredentials(request({ credentials: [credential(patch)] }))
    ).rejects.toThrow(/^plugin_config_(credential_slot_mismatch|input_invalid)$/u);
  });
  it('compares the injection name against the slot case-insensitively', async () => {
    await dynamicInstallation();
    await expect(
      store().store.replaceCredentials(
        request({ credentials: [credential({ injectionName: 'authorization' })] })
      )
    ).resolves.toMatchObject({ credentialCount: 1 });
  });
  it('refuses a replacement that omits a required slot', async () => {
    await dynamicInstallation();
    await expect(store().store.replaceCredentials(request({ credentials: [] }))).rejects.toThrow(
      /^plugin_config_required_credential_missing$/u
    );
  });
  it('refuses more than sixteen slots in the release policy', async () => {
    await dynamicInstallation();
    await expect(
      store({
        rewrite: (call, value) =>
          call.kind === 'all' && call.sql.includes('credential_slots')
            ? {
                ...(value as object),
                results: Array.from({ length: 17 }, () => ({ config_key: 'x', required: 0 })),
              }
            : value,
      }).store.replaceCredentials(request())
    ).rejects.toThrow(/^plugin_config_credential_policy_invalid$/u);
  });
  it.each([0, -1, 1.5, Number.NaN])('refuses a clock value of %s', async (now) => {
    await dynamicInstallation();
    await expect(store({}, now).store.replaceCredentials(request())).rejects.toThrow(
      /^plugin_config_now_invalid$/u
    );
    expect(rows(database, 'SELECT * FROM plugin_runner_config_mutations')).toEqual([]);
  });
  it.each([
    ['a short batch', [{ success: true, results: [], meta: { changes: 1 } }]],
    [
      'an unsuccessful statement',
      [1, 2, 3, 4].map((i) => ({ success: i !== 2, results: [], meta: { changes: 1 } })),
    ],
    [
      'a statement error',
      [1, 2, 3, 4].map((i) => ({
        success: true,
        error: i === 4 ? 'x' : undefined,
        results: [],
        meta: { changes: 1 },
      })),
    ],
    [
      'an unchanged statement',
      [1, 2, 3, 4].map((i) => ({ success: true, results: [], meta: { changes: i === 3 ? 0 : 1 } })),
    ],
    [
      'a statement without a count',
      [1, 2, 3, 4].map((i) => ({
        success: true,
        results: [],
        meta: i === 1 ? {} : { changes: 1 },
      })),
    ],
  ])('reports %s as a failed batch', async (_label, results) => {
    await dynamicInstallation();
    await expect(
      store({
        intercept: (call) => (call.kind === 'batch' ? { value: results } : undefined),
      }).store.replaceCredentials(request())
    ).rejects.toThrow(/^plugin_config_batch_failed$/u);
  });
  it('reports a version bump that did not apply as a failed batch', async () => {
    await dynamicInstallation();
    await expect(
      store({
        intercept: (call) => {
          if (call.kind === 'batch')
            database.exec('UPDATE plugin_runner_installations SET config_version = 5');
          return undefined;
        },
      }).store.replaceCredentials(request())
    ).rejects.toThrow(/^plugin_config_batch_failed$/u);
  });
});

describe('idempotency', () => {
  it('returns the stored result for an identical retry without writing again', async () => {
    await dynamicInstallation();
    await store().store.replaceCredentials(request());
    const { store: s, calls } = store({}, 5_000);
    await expect(s.replaceCredentials(request())).resolves.toEqual({
      operationId: 'operation-1',
      installationId: 'installation-a',
      configVersion: 2,
      credentialCount: 1,
    });
    expect(calls.filter((c) => c.kind === 'batch' || c.kind === 'run')).toEqual([]);
  });
  it('treats the order of credentials as irrelevant to the fingerprint', async () => {
    await builtinInstallation();
    const a = credential({ configKey: 'aKey' });
    const b = credential({ configKey: 'bKey', injectionKind: 'header', injectionName: 'X-Key' });
    await store().store.replaceCredentials(request({ credentials: [a, b] }));
    await expect(
      store().store.replaceCredentials(request({ credentials: [b, a] }))
    ).resolves.toMatchObject({ credentialCount: 2 });
  });
  it.each([
    ['another value', { credentials: [credential({ value: 'other' })] }],
    ['another installation', { installationId: 'installation-b' }],
    ['another tenant', { tenantId: 'tenant-b' }],
    ['another expected version', { expectedConfigVersion: 2 }],
  ])('refuses a retry with %s', async (_label, over) => {
    await dynamicInstallation();
    await store().store.replaceCredentials(request());
    await expect(store().store.replaceCredentials(request(over))).rejects.toThrow(
      /^plugin_config_idempotency_conflict$/u
    );
  });
  it('refuses a stored mutation fingerprinted with an unknown key or not yet applied', async () => {
    await dynamicInstallation();
    await store().store.replaceCredentials(request());
    for (const patch of [{ fingerprint_key_id: 'mutation-v0' }, { state: 'applying' }]) {
      const original = rows<Record<string, unknown>>(
        database,
        'SELECT * FROM plugin_runner_config_mutations'
      )[0];
      await expect(
        store({
          rewrite: (call, value) =>
            call.kind === 'first' && call.sql.includes('FROM plugin_runner_config_mutations')
              ? { ...(original as object), ...patch }
              : value,
        }).store.replaceCredentials(request())
      ).rejects.toThrow(/^plugin_config_idempotency_conflict$/u);
    }
  });
  it('refuses a mutation fingerprinted under another secret', async () => {
    await dynamicInstallation();
    await store().store.replaceCredentials(request());
    const d1 = createD1(database);
    await expect(
      new D1PluginConfigStore(
        d1.db,
        SECRET,
        'another-mutation-secret-with-32-chars!',
        () => 1
      ).replaceCredentials(request())
    ).rejects.toThrow(/^plugin_config_idempotency_conflict$/u);
  });
  it('refuses an unreadable stored target version', async () => {
    await dynamicInstallation();
    await store().store.replaceCredentials(request());
    const original = rows<Record<string, unknown>>(
      database,
      'SELECT * FROM plugin_runner_config_mutations'
    )[0];
    await expect(
      store({
        rewrite: (call, value) =>
          call.kind === 'first' && call.sql.includes('FROM plugin_runner_config_mutations')
            ? { ...(original as object), target_config_version: 0 }
            : value,
      }).store.replaceCredentials(request())
    ).rejects.toThrow(/^plugin_config_version_invalid$/u);
  });
});
