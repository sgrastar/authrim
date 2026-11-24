import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinHumanVerificationRegistry } from '../builtin-human-verification';
import type { HumanVerificationHookInput } from '../sync-hooks';
import type { PluginRunnerEnv } from '../types';
import { callsTo, must, outcomes, resetKit } from './helpers/mock-kit';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

vi.mock('../outbound-gateway', async () => ({
  PluginOutboundGateway: (await import('./helpers/mock-kit')).mockClass('PluginOutboundGateway', [
    'fetch',
  ]),
}));

const INPUT: HumanVerificationHookInput = {
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  requestId: 'request-a',
  action: 'login',
  responseToken: 'token-value',
  remoteIp: '203.0.113.9',
};
const IDS = {
  turnstile: 'human-verification-cloudflare-turnstile',
  hcaptcha: 'human-verification-hcaptcha',
  recaptcha: 'human-verification-google-recaptcha',
} as const;
const URLS = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
  recaptcha: 'https://www.google.com/recaptcha/api/siteverify',
};
let database: DatabaseSync;

function seed(
  provider: keyof typeof IDS,
  over: {
    host?: string | null;
    mode?: string;
    threshold?: number;
    pluginId?: string;
    siteKey?: string;
  } = {}
) {
  database
    .prepare(
      `INSERT INTO plugin_runner_installations (installation_id, tenant_id, plugin_id, backend_kind, script_name, state, config_version, created_at, updated_at) VALUES ('installation-a', 'tenant-a', ?, 'in_process', NULL, 'enabled', 3, 1, 1)`
    )
    .run(over.pluginId ?? IDS[provider]);
  database
    .prepare(
      `INSERT INTO plugin_runner_human_verification_configs (installation_id, config_version, provider, site_key, expected_hostname, widget_mode, score_threshold, config_fingerprint, created_at, updated_at) VALUES ('installation-a', 3, ?, ?, ?, ?, ?, ?, 1, 1)`
    )
    .run(
      provider,
      over.siteKey ?? 'site-key',
      over.host === undefined ? 'login.example.test' : over.host,
      over.mode ?? 'managed',
      over.threshold ?? 0.5,
      'a'.repeat(64)
    );
}
function handler(
  provider: keyof typeof IDS,
  options: D1Options = {},
  extra: Record<string, unknown> = {}
) {
  const env = {
    PLUGIN_RUNNER_DB: createD1(database, options).db,
    MARKER: 'env',
    ...extra,
  } as unknown as PluginRunnerEnv;
  return must(
    createBuiltinHumanVerificationRegistry(env).resolve(IDS[provider], 'human_verification.verify')
  );
}
const run = (
  provider: keyof typeof IDS,
  payload: unknown = INPUT,
  options: D1Options = {},
  signal = new AbortController().signal
) => handler(provider, options)(payload as HumanVerificationHookInput, signal);
const answer = (body: unknown, status = 200) =>
  outcomes.set(
    'PluginOutboundGateway.fetch',
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  );
const sentRequest = (): Request =>
  callsTo('PluginOutboundGateway.fetch').map((args) => args[0] as Request)[0];
const ALLOW = { decision: 'allow', reasonCode: 'verification_succeeded' };
const DENY = { decision: 'deny', reasonCode: 'verification_failed' };

beforeEach(() => {
  resetKit();
  database = openRunnerDatabase();
});

describe('registry', () => {
  it('registers the three providers for the verification capability only', () => {
    const registry = createBuiltinHumanVerificationRegistry({
      PLUGIN_RUNNER_DB: createD1(database).db,
    } as never);
    for (const id of Object.values(IDS)) {
      expect(registry.resolve(id, 'human_verification.verify')).toBeTypeOf('function');
      expect(registry.resolve(id, 'policy.decision')).toBeNull();
    }
    expect(registry.resolve('human-verification-other', 'human_verification.verify')).toBeNull();
  });
});

describe('configuration', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
  ])('rejects a payload that is %s', async (_label, payload) => {
    seed('turnstile');
    await expect(run('turnstile', payload)).rejects.toThrow(/^plugin_sync_rejected$/u);
  });
  it('rejects when the installation has no configuration, is disabled or belongs to another tenant', async () => {
    await expect(run('turnstile')).rejects.toThrow(/^plugin_sync_rejected$/u);
    seed('turnstile');
    database.exec("UPDATE plugin_runner_installations SET state = 'disabled'");
    await expect(run('turnstile')).rejects.toThrow(/^plugin_sync_rejected$/u);
    database.exec(
      "UPDATE plugin_runner_installations SET state = 'enabled', tenant_id = 'tenant-b'"
    );
    await expect(run('turnstile')).rejects.toThrow(/^plugin_sync_rejected$/u);
  });
  it('only uses the configuration of the installation current config version', async () => {
    seed('turnstile');
    database.exec('UPDATE plugin_runner_installations SET config_version = 4');
    await expect(run('turnstile')).rejects.toThrow(/^plugin_sync_rejected$/u);
  });
  it('rejects a handler used for an installation of another provider', async () => {
    seed('hcaptcha');
    await expect(run('turnstile')).rejects.toThrow(/^plugin_sync_rejected$/u);
  });
  it('rejects an installation whose plugin is not a known provider or whose provider disagrees', async () => {
    seed('turnstile', { pluginId: 'human-verification-hcaptcha' });
    await expect(run('turnstile')).rejects.toThrow(/^plugin_sync_rejected$/u);
    await expect(run('hcaptcha')).rejects.toThrow(/^plugin_sync_rejected$/u);
  });
  it.each([
    ['an empty site key', { site_key: '' }],
    ['a numeric site key', { site_key: 5 }],
    ['a numeric hostname', { expected_hostname: 5 }],
    ['an unknown plugin', { plugin_id: 'constructor' }],
  ])('rejects a stored row with %s', async (_label, patch) => {
    seed('turnstile');
    await expect(
      run('turnstile', INPUT, {
        rewrite: (call, value) => (call.kind === 'first' && value ? { ...value, ...patch } : value),
      })
    ).rejects.toThrow(/^plugin_sync_rejected$/u);
  });
  it('needs the sessions API', async () => {
    seed('turnstile');
    await expect(run('turnstile', INPUT, { withoutSession: true })).rejects.toThrow(
      /^plugin_human_verification_d1_session_required$/u
    );
  });
  it('binds the installation and tenant of the payload', async () => {
    seed('turnstile');
    answer({ success: true });
    const d1 = createD1(database);
    const env = { PLUGIN_RUNNER_DB: d1.db } as unknown as PluginRunnerEnv;
    await must(
      createBuiltinHumanVerificationRegistry(env).resolve(
        IDS.turnstile,
        'human_verification.verify'
      )
    )(INPUT, new AbortController().signal);
    expect(must(d1.calls.find((c) => c.kind === 'first')).values).toEqual([
      'installation-a',
      'tenant-a',
    ]);
  });
});

describe('provider requests', () => {
  it('asks Turnstile with a JSON body carrying a fresh idempotency key', async () => {
    seed('turnstile');
    answer({ success: true, hostname: 'login.example.test', action: 'authrim-login' });
    await run('turnstile');
    const request = sentRequest();
    expect(request.method).toBe('POST');
    expect(request.url).toBe(URLS.turnstile);
    expect(request.headers.get('Content-Type')).toBe('application/json');
    const body = await request.json<Record<string, string>>();
    expect(body).toEqual({
      response: 'token-value',
      remoteip: '203.0.113.9',
      idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown,
    });
    resetKit();
    answer({ success: true, hostname: 'login.example.test', action: 'authrim-login' });
    await run('turnstile');
    const second = await sentRequest().json<Record<string, string>>();
    expect(second.idempotency_key).not.toBe(body.idempotency_key);
  });
  it('omits the remote address when none was given', async () => {
    seed('turnstile');
    answer({ success: true, hostname: 'login.example.test', action: 'authrim-login' });
    await run('turnstile', { ...INPUT, remoteIp: undefined });
    expect(Object.keys(await sentRequest().json<object>()).sort()).toEqual([
      'idempotency_key',
      'response',
    ]);
  });
  it('asks hCaptcha with a form body carrying the site key', async () => {
    seed('hcaptcha');
    answer({ success: true, hostname: 'login.example.test' });
    await run('hcaptcha');
    const request = sentRequest();
    expect(request.url).toBe(URLS.hcaptcha);
    expect(request.headers.get('Content-Type')).toContain('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
      response: 'token-value',
      sitekey: 'site-key',
      remoteip: '203.0.113.9',
    });
  });
  it('asks reCAPTCHA without a site key and without a remote address when none was given', async () => {
    seed('recaptcha');
    answer({ success: true, hostname: 'login.example.test' });
    await run('recaptcha', { ...INPUT, remoteIp: undefined });
    const request = sentRequest();
    expect(request.url).toBe(URLS.recaptcha);
    expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
      response: 'token-value',
    });
  });
  it('sends the request through the egress gateway scoped to this verification', async () => {
    seed('hcaptcha');
    answer({ success: true, hostname: 'login.example.test' });
    const signal = new AbortController().signal;
    await run('hcaptcha', INPUT, {}, signal);
    expect(must(callsTo('PluginOutboundGateway.new')[0])[0]).toMatchObject({
      AUTHRIM_PLUGIN_EGRESS_CONTEXT: {
        contractVersion: 1,
        tenantId: 'tenant-a',
        pluginInstallationId: 'installation-a',
        capability: 'human_verification.verify',
        requestId: 'request-a',
      },
    });
    expect(
      Object.keys(
        (
          must(callsTo('PluginOutboundGateway.new')[0])[0] as {
            AUTHRIM_PLUGIN_EGRESS_CONTEXT: object;
          }
        ).AUTHRIM_PLUGIN_EGRESS_CONTEXT
      ).sort()
    ).toEqual(['capability', 'contractVersion', 'pluginInstallationId', 'requestId', 'tenantId']);
    expect(sentRequest().signal.aborted).toBe(false);
  });
});

describe('provider answers', () => {
  it.each([429, 500, 502, 599])('treats status %i as transient', async (status) => {
    seed('turnstile');
    answer({ success: true }, status);
    await expect(run('turnstile')).rejects.toThrow(/^plugin_sync_transient_failure$/u);
  });
  it.each(['turnstile', 'hcaptcha', 'recaptcha'] as const)(
    'denies %s on a non-2xx answer even when the body says success',
    async (provider) => {
      seed(provider);
      for (const status of [300, 302, 400, 403, 499]) {
        resetKit();
        answer({ success: true, hostname: 'login.example.test' }, status);
        await expect(run(provider)).resolves.toEqual(DENY);
      }
    }
  );
  it.each([200, 201, 299])('reads the verdict of a %i answer', async (status) => {
    seed('hcaptcha');
    answer({ success: false }, status);
    await expect(run('hcaptcha')).resolves.toEqual(DENY);
    resetKit();
    answer({ success: true, hostname: 'login.example.test' }, status);
    await expect(run('hcaptcha')).resolves.toEqual(ALLOW);
  });
  it.each([
    ['text that is not JSON', '{nope'],
    ['an oversized body', JSON.stringify({ pad: 'x'.repeat(16 * 1024) })],
  ])('treats %s as transient', async (_label, body) => {
    seed('hcaptcha');
    answer(body);
    await expect(run('hcaptcha')).rejects.toThrow(/^plugin_sync_transient_failure$/u);
  });
  it('treats a failed verification, or one for another hostname, as a denial', async () => {
    seed('hcaptcha');
    for (const result of [
      { success: false, hostname: 'login.example.test' },
      { success: 'true', hostname: 'login.example.test' },
      { hostname: 'login.example.test' },
      { success: true, hostname: 'evil.example.test' },
      { success: true },
    ]) {
      resetKit();
      answer(result);
      await expect(run('hcaptcha')).resolves.toEqual(DENY);
    }
  });
  it('does not check the hostname when none is configured', async () => {
    seed('hcaptcha', { host: null });
    answer({ success: true });
    await expect(run('hcaptcha')).resolves.toEqual(ALLOW);
  });
  it.each([
    ['login', 'authrim-login', true],
    ['signup', 'authrim-signup', true],
    ['reauth', 'authrim-reauth', true],
    ['login', 'authrim-signup', false],
    ['login', 'authrim_login', false],
    ['login', undefined, false],
  ])('checks the Turnstile action for %s against %s', async (action, reported, allowed) => {
    seed('turnstile');
    answer({ success: true, hostname: 'login.example.test', action: reported });
    await expect(run('turnstile', { ...INPUT, action })).resolves.toEqual(allowed ? ALLOW : DENY);
  });
  describe('reCAPTCHA score mode', () => {
    const verdict = (
      result: unknown,
      over: Parameters<typeof seed>[1] = {},
      action: string = 'login'
    ) => {
      resetKit();
      database = openRunnerDatabase();
      seed('recaptcha', { mode: 'score', ...over });
      answer(result);
      return run('recaptcha', { ...INPUT, action });
    };
    it('allows a score at or above the threshold with the matching action', async () => {
      await expect(
        verdict({
          success: true,
          hostname: 'login.example.test',
          action: 'authrim_login',
          score: 0.5,
        })
      ).resolves.toEqual(ALLOW);
      await expect(
        verdict({
          success: true,
          hostname: 'login.example.test',
          action: 'authrim_login',
          score: 0.9,
        })
      ).resolves.toEqual(ALLOW);
      await expect(
        verdict(
          { success: true, hostname: 'login.example.test', action: 'authrim_signup', score: 1 },
          {},
          'signup'
        )
      ).resolves.toEqual(ALLOW);
    });
    it.each([
      [
        'a score below the threshold',
        { success: true, hostname: 'login.example.test', action: 'authrim_login', score: 0.49 },
      ],
      [
        'another action',
        { success: true, hostname: 'login.example.test', action: 'authrim-login', score: 0.9 },
      ],
      ['no action', { success: true, hostname: 'login.example.test', score: 0.9 }],
      ['no score', { success: true, hostname: 'login.example.test', action: 'authrim_login' }],
      [
        'a textual score',
        { success: true, hostname: 'login.example.test', action: 'authrim_login', score: '0.9' },
      ],
      [
        'a failed verification',
        { success: false, hostname: 'login.example.test', action: 'authrim_login', score: 0.9 },
      ],
    ])('denies %s', async (_label, result) => {
      await expect(verdict(result)).resolves.toEqual(DENY);
    });
    it('accepts the extreme thresholds', async () => {
      await expect(
        verdict(
          { success: true, hostname: 'login.example.test', action: 'authrim_login', score: 0 },
          { threshold: 0 }
        )
      ).resolves.toEqual(ALLOW);
      await expect(
        verdict(
          { success: true, hostname: 'login.example.test', action: 'authrim_login', score: 1 },
          { threshold: 1 }
        )
      ).resolves.toEqual(ALLOW);
      await expect(
        verdict(
          { success: true, hostname: 'login.example.test', action: 'authrim_login', score: 0.99 },
          { threshold: 1 }
        )
      ).resolves.toEqual(DENY);
    });
    it('denies when the stored threshold is not a usable probability', async () => {
      for (const threshold of [-0.1, 1.1, 'x']) {
        resetKit();
        database = openRunnerDatabase();
        seed('recaptcha', { mode: 'score' });
        answer({
          success: true,
          hostname: 'login.example.test',
          action: 'authrim_login',
          score: 0.9,
        });
        await expect(
          run('recaptcha', INPUT, {
            rewrite: (call, value) =>
              call.kind === 'first' && value ? { ...value, score_threshold: threshold } : value,
          })
        ).resolves.toEqual(DENY);
      }
    });
    it('does not check the score outside score mode', async () => {
      resetKit();
      database = openRunnerDatabase();
      seed('recaptcha', { mode: 'managed' });
      answer({ success: true, hostname: 'login.example.test' });
      await expect(run('recaptcha')).resolves.toEqual(ALLOW);
    });
  });
});

describe('provider edges', () => {
  it('accepts a single-character site key', async () => {
    seed('hcaptcha', { siteKey: 'k' });
    answer({ success: true, hostname: 'login.example.test' });
    await expect(run('hcaptcha')).resolves.toEqual(ALLOW);
  });
  it('reads the session constraint from the primary', async () => {
    seed('hcaptcha');
    answer({ success: true, hostname: 'login.example.test' });
    const d1 = createD1(database);
    const env = { PLUGIN_RUNNER_DB: d1.db } as unknown as PluginRunnerEnv;
    await must(
      createBuiltinHumanVerificationRegistry(env).resolve(IDS.hcaptcha, 'human_verification.verify')
    )(INPUT, new AbortController().signal);
    expect(d1.calls.find((c) => c.kind === 'session')?.sql).toBe('first-primary');
  });
  it('does not apply score rules to a provider that has none, whatever its stored mode', async () => {
    seed('hcaptcha', { mode: 'score' });
    answer({ success: true, hostname: 'login.example.test' });
    await expect(run('hcaptcha')).resolves.toEqual(ALLOW);
  });
  it.each([
    ['a threshold above one', 1.1, 5],
    ['a negative threshold', -0.1, 0],
  ])('denies %s even when the score satisfies it', async (_label, threshold, score) => {
    seed('recaptcha', { mode: 'score' });
    answer({ success: true, hostname: 'login.example.test', action: 'authrim_login', score });
    await expect(
      run('recaptcha', INPUT, {
        rewrite: (call, value) =>
          call.kind === 'first' && value ? { ...value, score_threshold: threshold } : value,
      })
    ).resolves.toEqual(DENY);
  });
  it('sends hCaptcha and reCAPTCHA requests as form posts', async () => {
    seed('recaptcha');
    answer({ success: true, hostname: 'login.example.test' });
    await run('recaptcha');
    expect(sentRequest().headers.get('Content-Type')).toContain(
      'application/x-www-form-urlencoded'
    );
  });
});
