import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { D1HumanVerificationInstallationStore } from '../human-verification-installations';
import { rows } from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

const ENCRYPTION = 'human-verification-encryption-secret-value';
const MUTATION = 'human-verification-mutation-secret-value';
const IDS = {
  turnstile: 'human-verification-cloudflare-turnstile',
  hcaptcha: 'human-verification-hcaptcha',
  recaptcha: 'human-verification-google-recaptcha',
} as const;
const HOSTS = {
  turnstile: ['challenges.cloudflare.com', 'json_field'],
  hcaptcha: ['api.hcaptcha.com', 'form_field'],
  recaptcha: ['www.google.com', 'form_field'],
} as const;
const INVALID = /^plugin_human_verification_input_invalid$/u;
const CONFIG_INVALID = /^plugin_human_verification_config_invalid$/u;

let database: DatabaseSync;
function store(options: D1Options = {}, now = 1_000) {
  const d1 = createD1(database, options);
  return {
    store: new D1HumanVerificationInstallationStore(d1.db, ENCRYPTION, MUTATION, () => now),
    calls: d1.calls,
  };
}
const enable = (
  provider: keyof typeof IDS = 'turnstile',
  config: Record<string, unknown> = {},
  over: Record<string, unknown> = {}
) => ({
  operationId: 'operation-1',
  installationId: 'installation-a',
  tenantId: 'tenant-a',
  pluginId: IDS[provider],
  enabled: true,
  config: { siteKey: 'site-key', secretKey: 'secret-key', ...config },
  ...over,
});
const disable = (provider: keyof typeof IDS = 'turnstile') => ({
  operationId: 'operation-0',
  installationId: 'installation-a',
  tenantId: 'tenant-a',
  pluginId: IDS[provider],
  enabled: false,
});
const installation = () =>
  database.prepare('SELECT * FROM plugin_runner_installations').get() as
    | Record<string, unknown>
    | undefined;
const configRows = () =>
  rows<Record<string, unknown>>(
    database,
    'SELECT * FROM plugin_runner_human_verification_configs ORDER BY config_version'
  );

beforeEach(() => {
  database = openRunnerDatabase();
});

describe('input', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['an extra key', { ...disable(), extra: 1 }],
    ['a missing key', { ...disable(), operationId: undefined }],
    ['an unsafe operation', { ...disable(), operationId: '-x' }],
    ['a numeric operation', { ...disable(), operationId: 5 }],
    ['an unsafe installation', { ...disable(), installationId: '' }],
    ['an unsafe tenant', { ...disable(), tenantId: ' ' }],
    ['an unknown plugin', { ...disable(), pluginId: 'human-verification-other' }],
    ['a numeric plugin', { ...disable(), pluginId: 5 }],
    ['a textual enabled flag', { ...disable(), enabled: 'false' }],
    ['an enabled request without configuration', { ...disable(), enabled: true }],
    ['a configuration with an unexpected shape key', { ...enable(), config: undefined, extra: 1 }],
  ])('rejects %s', async (_label, input) => {
    await expect(store().store.configure(input)).rejects.toThrow(INVALID);
    expect(installation()).toBeUndefined();
  });
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'does not accept the object property %s as a provider',
    async (pluginId) => {
      for (const request of [
        { ...disable(), pluginId },
        { ...enable(), pluginId },
      ]) {
        const { store: subject, calls } = store();
        await expect(subject.configure(request)).rejects.toThrow(INVALID);
        // The guard must stop the request before any database call, not a later binding error.
        expect(calls).toEqual([]);
        expect(installation()).toBeUndefined();
      }
    }
  );
  it.each([0, -1, 1.5, Number.NaN])('refuses a clock value of %s', async (now) => {
    await expect(store({}, now).store.configure(disable())).rejects.toThrow(
      /^plugin_human_verification_now_invalid$/u
    );
    expect(installation()).toBeUndefined();
  });
  it('needs the sessions API', async () => {
    await expect(store({ withoutSession: true }).store.configure(disable())).rejects.toThrow(
      /^plugin_human_verification_d1_session_required$/u
    );
  });
  it('accepts a disabled request that also carries a configuration', async () => {
    await expect(
      store().store.configure({ ...disable(), config: { siteKey: 'a', secretKey: 'b' } })
    ).resolves.toMatchObject({ state: 'disabled' });
  });
});

describe('disabling', () => {
  it('creates the built-in installation disabled, with its policy and the provider host approved', async () => {
    await expect(store().store.configure(disable('hcaptcha'))).resolves.toEqual({
      installationId: 'installation-a',
      tenantId: 'tenant-a',
      pluginId: IDS.hcaptcha,
      state: 'disabled',
      configVersion: 1,
    });
    expect(installation()).toMatchObject({
      installation_id: 'installation-a',
      tenant_id: 'tenant-a',
      plugin_id: IDS.hcaptcha,
      backend_kind: 'in_process',
      script_name: null,
      state: 'disabled',
      config_version: 1,
      platform_concurrency_cap: 8,
      platform_rate_per_minute: 120,
      created_at: 1_000,
      updated_at: 1_000,
    });
    expect(rows(database, 'SELECT * FROM plugin_runner_hook_policies')).toEqual([
      {
        plugin_id: IDS.hcaptcha,
        capability: 'human_verification.verify',
        timeout_ms: 10_000,
        failure_policy: 'fail_closed',
        max_attempts: 1,
        async_retry_budget_seconds: 60,
        circuit_breaker_threshold: 5,
        circuit_breaker_cooldown_seconds: 60,
        updated_at: 1_000,
      },
    ]);
    expect(rows(database, 'SELECT * FROM plugin_runner_egress_allowed_hosts')).toEqual([
      {
        plugin_id: IDS.hcaptcha,
        rule_id: 'siteverify',
        match_kind: 'exact',
        host_pattern: 'api.hcaptcha.com',
        created_at: 1_000,
      },
    ]);
  });
  it.each(Object.entries(HOSTS))(
    'approves the verification host of %s',
    async (provider, [host]) => {
      await store().store.configure(disable(provider as keyof typeof IDS));
      expect(rows(database, 'SELECT host_pattern FROM plugin_runner_egress_allowed_hosts')).toEqual(
        [{ host_pattern: host }]
      );
    }
  );
  it('disables an enabled installation without touching its stored configuration', async () => {
    await store().store.configure(enable());
    await expect(store({}, 2_000).store.configure(disable())).resolves.toMatchObject({
      state: 'disabled',
      configVersion: 2,
    });
    expect(installation()).toMatchObject({
      state: 'disabled',
      updated_at: 2_000,
      created_at: 1_000,
    });
    expect(configRows()).toHaveLength(1);
  });
  it('refuses an installation id already used by another tenant or plugin', async () => {
    await store().store.configure(disable());
    await expect(store().store.configure({ ...disable(), tenantId: 'tenant-b' })).rejects.toThrow(
      /^plugin_human_verification_reflection_invalid$/u
    );
    await expect(store().store.configure(disable('hcaptcha'))).rejects.toThrow(
      /^plugin_human_verification_reflection_invalid$/u
    );
    expect(rows(database, 'SELECT tenant_id, plugin_id FROM plugin_runner_installations')).toEqual([
      { tenant_id: 'tenant-a', plugin_id: IDS.turnstile },
    ]);
  });
  it('refuses an installation that is not a built-in one', async () => {
    database.exec(
      `INSERT INTO plugin_runner_installations (installation_id, tenant_id, plugin_id, backend_kind, script_name, state, config_version, created_at, updated_at) VALUES ('installation-a', 'tenant-a', '${IDS.turnstile}', 'dynamic_worker', 'script', 'disabled', 1, 1, 1)`
    );
    await expect(store().store.configure(disable())).rejects.toThrow(
      /^plugin_human_verification_reflection_invalid$/u
    );
  });
  it('refuses a blocked installation', async () => {
    database.exec(
      `INSERT INTO plugin_runner_installations (installation_id, tenant_id, plugin_id, backend_kind, script_name, state, config_version, created_at, updated_at) VALUES ('installation-a', 'tenant-a', '${IDS.turnstile}', 'in_process', NULL, 'blocked', 1, 1, 1)`
    );
    await expect(store().store.configure(disable())).rejects.toThrow(
      /^plugin_human_verification_reflection_invalid$/u
    );
  });
  it('reports a disable that did not apply', async () => {
    await expect(
      store({
        intercept: (call) =>
          call.kind === 'run' && call.sql.includes("SET state = 'disabled'")
            ? { value: { success: true, results: [], meta: { changes: 0 } } }
            : undefined,
      }).store.configure(disable())
    ).rejects.toThrow(/^plugin_human_verification_reflection_invalid$/u);
  });
});

describe('enabling', () => {
  it.each(Object.entries(HOSTS))(
    'stores the %s configuration and an encrypted secret for its host',
    async (provider, [host, kind]) => {
      const key = provider as keyof typeof IDS;
      await expect(store().store.configure(enable(key))).resolves.toEqual({
        installationId: 'installation-a',
        tenantId: 'tenant-a',
        pluginId: IDS[key],
        state: 'enabled',
        configVersion: 2,
      });
      expect(configRows()).toMatchObject([
        {
          installation_id: 'installation-a',
          config_version: 2,
          provider,
          site_key: 'site-key',
          expected_hostname: null,
          widget_mode: provider === 'turnstile' ? 'managed' : 'checkbox',
          score_threshold: 0.5,
          config_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown,
          created_at: 1_000,
          updated_at: 1_000,
        },
      ]);
      expect(
        rows(
          database,
          'SELECT config_key, config_version, injection_kind, injection_name, destination_host FROM plugin_runner_encrypted_configs'
        )
      ).toEqual([
        {
          config_key: 'secretKey',
          config_version: 2,
          injection_kind: kind,
          injection_name: 'secret',
          destination_host: host,
        },
      ]);
      expect(
        JSON.stringify(
          rows(database, 'SELECT encrypted_value FROM plugin_runner_encrypted_configs')
        )
      ).not.toContain('secret-key');
      expect(installation()).toMatchObject({
        state: 'enabled',
        config_version: 2,
        updated_at: 1_000,
      });
    }
  );
  it('trims keys, lowercases the expected hostname and keeps the chosen mode and threshold', async () => {
    await store().store.configure(
      enable('recaptcha', {
        siteKey: '  site  ',
        secretKey: '  secret  ',
        expectedHostname: '  Login.Example.TEST ',
        widgetMode: 'score',
        scoreThreshold: 0.7,
      })
    );
    expect(configRows()).toMatchObject([
      {
        site_key: 'site',
        expected_hostname: 'login.example.test',
        widget_mode: 'score',
        score_threshold: 0.7,
      },
    ]);
  });
  it.each(['', '   '])('treats the expected hostname %j as unset', async (expectedHostname) => {
    await store().store.configure(enable('turnstile', { expectedHostname }));
    expect(configRows()).toMatchObject([{ expected_hostname: null }]);
  });
  it.each([0, 1])('accepts a score threshold of %i', async (scoreThreshold) => {
    await store().store.configure(enable('recaptcha', { scoreThreshold, widgetMode: 'score' }));
    expect(configRows()).toMatchObject([{ score_threshold: scoreThreshold }]);
  });
  it('fingerprints the configuration so another site key changes it', async () => {
    await store().store.configure(enable());
    const first = configRows()[0]?.config_fingerprint;
    database = openRunnerDatabase();
    await store().store.configure(enable('turnstile', { siteKey: 'other-key' }));
    expect(configRows()[0]?.config_fingerprint).not.toBe(first);
  });
  it('is idempotent for the same operation and advances for a new one', async () => {
    await store().store.configure(enable());
    await expect(store({}, 2_000).store.configure(enable())).resolves.toMatchObject({
      state: 'enabled',
      configVersion: 2,
    });
    expect(configRows()).toHaveLength(1);
    await expect(
      store({}, 3_000).store.configure(enable('turnstile', {}, { operationId: 'operation-2' }))
    ).resolves.toMatchObject({ configVersion: 3 });
    expect(configRows().map((row) => row.config_version)).toEqual([2, 3]);
  });
  it('replaces the stored secret when the operation changes', async () => {
    await store().store.configure(enable());
    await store().store.configure(
      enable('turnstile', { secretKey: 'rotated' }, { operationId: 'operation-2' })
    );
    expect(
      rows(
        database,
        'SELECT config_version FROM plugin_runner_encrypted_configs ORDER BY config_version'
      )
    ).toEqual([{ config_version: 2 }, { config_version: 3 }]);
  });
  it.each([
    ['a non-object configuration', 5],
    ['an array configuration', []],
    ['a missing secret', { siteKey: 'a' }],
    ['a missing site key', { secretKey: 'a' }],
    ['an unknown key', { siteKey: 'a', secretKey: 'b', failurePolicy: 'fail_open' }],
    ['a blank site key', { siteKey: '   ', secretKey: 'b' }],
    ['a blank secret', { siteKey: 'a', secretKey: '  ' }],
    ['a numeric site key', { siteKey: 5, secretKey: 'b' }],
    ['an over-long site key', { siteKey: 'k'.repeat(2_049), secretKey: 'b' }],
    ['an over-long secret', { siteKey: 'a', secretKey: 's'.repeat(8_193) }],
    [
      'a hostname with a scheme',
      { siteKey: 'a', secretKey: 'b', expectedHostname: 'https://login.example.test' },
    ],
    ['a hostname without a dot', { siteKey: 'a', secretKey: 'b', expectedHostname: 'localhost' }],
    ['a widget mode the provider lacks', { siteKey: 'a', secretKey: 'b', widgetMode: 'score' }],
    ['an unknown widget mode', { siteKey: 'a', secretKey: 'b', widgetMode: 'rainbow' }],
    ['a threshold below zero', { siteKey: 'a', secretKey: 'b', scoreThreshold: -0.1 }],
    ['a threshold above one', { siteKey: 'a', secretKey: 'b', scoreThreshold: 1.1 }],
    ['a NaN threshold', { siteKey: 'a', secretKey: 'b', scoreThreshold: Number.NaN }],
    ['a textual threshold', { siteKey: 'a', secretKey: 'b', scoreThreshold: '0.5' }],
  ])('rejects %s', async (_label, config) => {
    await expect(store().store.configure({ ...enable(), config })).rejects.toThrow(CONFIG_INVALID);
    expect(configRows()).toEqual([]);
  });
  it('accepts keys of exactly the permitted length', async () => {
    await expect(
      store().store.configure(
        enable('turnstile', { siteKey: 'k'.repeat(2_048), secretKey: 's'.repeat(8_192) })
      )
    ).resolves.toMatchObject({ state: 'enabled' });
  });
  it('refuses a hostname longer than the pattern allows', async () => {
    await expect(
      store().store.configure(
        enable('turnstile', { expectedHostname: `${'a'.repeat(64)}.example.test` })
      )
    ).rejects.toThrow(CONFIG_INVALID);
  });
  it('refuses a stored configuration of that version that differs', async () => {
    database.exec(
      `INSERT INTO plugin_runner_installations (installation_id, tenant_id, plugin_id, backend_kind, script_name, state, config_version, created_at, updated_at) VALUES ('installation-a', 'tenant-a', '${IDS.turnstile}', 'in_process', NULL, 'disabled', 1, 1, 1);
       INSERT INTO plugin_runner_human_verification_configs (installation_id, config_version, provider, site_key, expected_hostname, widget_mode, score_threshold, config_fingerprint, created_at, updated_at) VALUES ('installation-a', 2, 'turnstile', 'another-key', NULL, 'managed', 0.5, '${'a'.repeat(64)}', 1, 1)`
    );
    await expect(store().store.configure(enable())).rejects.toThrow(
      /^plugin_human_verification_config_conflict$/u
    );
  });
  it('refuses a prior operation that points below the first config version', async () => {
    await store().store.configure(disable());
    database.exec(
      `INSERT INTO plugin_runner_config_mutations (operation_id, installation_id, tenant_id, request_fingerprint, fingerprint_key_id, target_config_version, state, created_at, applied_at, updated_at) VALUES ('operation-1', 'installation-a', 'tenant-a', '${'a'.repeat(64)}', 'mutation-v1', 1, 'applied', 1, 1, 1)`
    );
    await expect(store().store.configure(enable())).rejects.toThrow(
      /^plugin_human_verification_version_invalid$/u
    );
  });
  it('reports an enable that did not apply', async () => {
    await expect(
      store({
        intercept: (call) =>
          call.kind === 'run' && call.sql.includes("SET state = 'enabled'")
            ? { value: { success: true, results: [], meta: {} } }
            : undefined,
      }).store.configure(enable())
    ).rejects.toThrow(/^plugin_human_verification_reflection_invalid$/u);
  });
  it('binds the first batch statement to the installation, tenant, plugin and clock', async () => {
    const { store: s, calls } = store();
    await s.configure(disable());
    const batch = calls.find((c) => c.kind === 'batch');
    expect(batch?.values.slice(0, 5)).toEqual([
      'installation-a',
      'tenant-a',
      IDS.turnstile,
      1_000,
      1_000,
    ]);
  });
});

describe('identifier and boundary edges', () => {
  it.each([
    ['an operation id with trailing text', { operationId: 'a b' }],
    ['an installation id with trailing text', { installationId: 'a b' }],
    ['a tenant id with trailing text', { tenantId: 'a b' }],
    ['a numeric enabled flag', { enabled: 1 }],
    ['a null enabled flag', { enabled: null }],
  ])('rejects %s', async (_label, over) => {
    await expect(store().store.configure({ ...enable(), ...over })).rejects.toThrow(INVALID);
    expect(installation()).toBeUndefined();
  });
  it('accepts single-character keys and the smallest clock value', async () => {
    await expect(
      store({}, 1).store.configure(enable('turnstile', { siteKey: 'k', secretKey: 's' }))
    ).resolves.toMatchObject({ state: 'enabled' });
    expect(configRows()).toMatchObject([{ site_key: 'k', created_at: 1 }]);
  });
  it('rejects a non-numeric threshold even for a provider that ignores it', async () => {
    await expect(
      store().store.configure(enable('turnstile', { scoreThreshold: 'high' }))
    ).rejects.toThrow(CONFIG_INVALID);
  });
  it('reads from the primary and defaults the clock to seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_333_900);
    try {
      const d1 = createD1(database);
      await new D1HumanVerificationInstallationStore(d1.db, ENCRYPTION, MUTATION).configure(
        disable()
      );
      expect(d1.calls.find((c) => c.kind === 'session')?.sql).toBe('first-primary');
      expect(installation()).toMatchObject({ created_at: 1_700_000_333 });
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    ['provider', "provider = 'recaptcha'"],
    ['hostname', "expected_hostname = 'other.example.test'"],
    ['widget mode', "widget_mode = 'invisible'"],
    ['threshold', 'score_threshold = 0.9'],
    ['fingerprint', `config_fingerprint = '${'b'.repeat(64)}'`],
  ])(
    'refuses a stored configuration of that version whose %s differs',
    async (_label, assignment) => {
      await store().store.configure(enable('hcaptcha', { expectedHostname: 'login.example.test' }));
      database.exec(`UPDATE plugin_runner_human_verification_configs SET ${assignment}`);
      database.exec(
        'DELETE FROM plugin_runner_encrypted_configs; DELETE FROM plugin_runner_config_mutations'
      );
      database.exec(
        "UPDATE plugin_runner_installations SET config_version = 1, state = 'disabled'"
      );
      await expect(
        store().store.configure(enable('hcaptcha', { expectedHostname: 'login.example.test' }))
      ).rejects.toThrow(/^plugin_human_verification_config_conflict$/u);
    }
  );
});
