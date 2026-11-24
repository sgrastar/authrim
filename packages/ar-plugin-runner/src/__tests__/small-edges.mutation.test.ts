import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { D1AccountEventInstallationResolver } from '../account-event-installations';
import { readBoundedRequestBody, readBoundedResponseBody } from '../bounded-response';
import { D1PluginDispatchLimiter } from '../dispatch-limiter';
import { DynamicWorkerPluginBackend } from '../dynamic-worker-backend';
import { authorizePluginEgressUrl, type PluginEgressRule } from '../egress-policy';
import { parsePluginExecutionContext } from '../execution-context';
import { D1TenantExternalGateStore } from '../external-gate';
import { localLogNotifierHandler } from '../local-log-notifier';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

const bodyOf = (text: string, headers: Record<string, string> = {}) =>
  new Request('https://example.test/', { method: 'POST', body: text, headers });
const CODE = 'plugin_test_limit';

describe('bounded bodies', () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a limit of %s',
    async (limit) => {
      await expect(readBoundedRequestBody(bodyOf('x'), limit, CODE)).rejects.toThrow(
        /^plugin_response_limit_invalid$/u
      );
    }
  );
  it('reads a body up to the limit exactly and refuses one byte more', async () => {
    await expect(
      readBoundedRequestBody(bodyOf('abc'), 3, CODE).then((b) => new TextDecoder().decode(b))
    ).resolves.toBe('abc');
    await expect(readBoundedRequestBody(bodyOf('abcd'), 3, CODE)).rejects.toThrow(
      new RegExp(`^${CODE}$`, 'u')
    );
  });
  it('accepts a zero limit for an empty body', async () => {
    await expect(
      readBoundedRequestBody(new Request('https://example.test/', { method: 'POST' }), 0, CODE)
    ).resolves.toHaveProperty('byteLength', 0);
    await expect(readBoundedRequestBody(bodyOf('x'), 0, CODE)).rejects.toThrow(
      new RegExp(`^${CODE}$`, 'u')
    );
  });
  it('reads a request without a body as empty', async () => {
    const empty = await readBoundedRequestBody(new Request('https://example.test/'), 10, CODE);
    expect(empty.byteLength).toBe(0);
  });
  it.each(['11', 'x', '-1', '1.5'])(
    'judges the declared length %s before reading',
    async (declared) => {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), {
        headers: { 'Content-Length': declared },
      });
      await expect(readBoundedResponseBody(response, 10, CODE)).rejects.toThrow(
        new RegExp(`^${CODE}$`, 'u')
      );
      expect(cancel).toHaveBeenCalled();
    }
  );
  it('accepts a declared length equal to the limit', async () => {
    await expect(
      readBoundedResponseBody(
        new Response('0123456789', { headers: { 'Content-Length': '10' } }),
        10,
        CODE
      ).then((b) => b.byteLength)
    ).resolves.toBe(10);
  });
  it('cancels a stream that outgrows the limit and reports a read failure otherwise', async () => {
    const cancel = vi.fn();
    const big = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
      cancel,
    });
    await expect(readBoundedResponseBody(new Response(big), 10, CODE)).rejects.toThrow(
      new RegExp(`^${CODE}$`, 'u')
    );
    expect(cancel).toHaveBeenCalled();
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error('stream broke'));
      },
    });
    await expect(readBoundedResponseBody(new Response(broken), 10, CODE)).rejects.toThrow(
      /^plugin_response_read_failed$/u
    );
  });
  it('joins chunks in order', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('ab'));
        controller.enqueue(new TextEncoder().encode('cd'));
        controller.close();
      },
    });
    expect(
      new TextDecoder().decode(await readBoundedResponseBody(new Response(stream), 10, CODE))
    ).toBe('abcd');
  });
});

describe('egress policy', () => {
  const exact = (host: string): PluginEgressRule => ({ kind: 'exact', host });
  const wildcard = (suffix: string): PluginEgressRule => ({ kind: 'suffix_wildcard', suffix });
  it('allows an exact host and the hosts under a wildcard suffix, but not the suffix itself', () => {
    expect(
      authorizePluginEgressUrl('https://api.example.com/x?y=1', [exact('api.example.com')]).href
    ).toBe('https://api.example.com/x?y=1');
    expect(
      authorizePluginEgressUrl('https://a.b.example.com/', [wildcard('*.example.com')]).hostname
    ).toBe('a.b.example.com');
    expect(() =>
      authorizePluginEgressUrl('https://example.com/', [wildcard('*.example.com')])
    ).toThrow(/^plugin_egress_host_denied$/u);
    expect(() =>
      authorizePluginEgressUrl('https://evilexample.com/', [wildcard('*.example.com')])
    ).toThrow(/^plugin_egress_host_denied$/u);
    expect(() =>
      authorizePluginEgressUrl('https://api.example.com/', [exact('other.example.com')])
    ).toThrow(/^plugin_egress_host_denied$/u);
    expect(() => authorizePluginEgressUrl('https://api.example.com/', [])).toThrow(
      /^plugin_egress_host_denied$/u
    );
  });
  it('accepts port 443 and normalises host case', () => {
    expect(
      authorizePluginEgressUrl('https://API.Example.com:443/', [exact('api.example.com')]).hostname
    ).toBe('api.example.com');
  });
  it.each([
    ['http', 'http://api.example.com/'],
    ['credentials', 'https://user:pass@api.example.com/'],
    ['a username only', 'https://user@api.example.com/'],
    ['another port', 'https://api.example.com:8443/'],
    ['a fragment', 'https://api.example.com/#frag'],
    ['no scheme', 'api.example.com/path'],
    ['a scheme without an authority', 'https:///path'],
    ['percent encoding in the authority', 'https://api.example.com%2e/'],
    ['a non-ASCII authority', 'https://ａpi.example.com/'],
    ['a malformed URL', 'https://exa mple.com/'],
  ])('refuses %s', (_label, url) => {
    expect(() => authorizePluginEgressUrl(url, [exact('api.example.com')])).toThrow(
      /^plugin_egress_url_invalid$/u
    );
  });
  it('refuses oversized input and too many rules', () => {
    expect(() =>
      authorizePluginEgressUrl(`https://api.example.com/${'a'.repeat(4_096)}`, [
        exact('api.example.com'),
      ])
    ).toThrow(/^plugin_egress_request_invalid$/u);
    expect(() =>
      authorizePluginEgressUrl(
        'https://api.example.com/',
        Array.from({ length: 101 }, () => exact('api.example.com'))
      )
    ).toThrow(/^plugin_egress_request_invalid$/u);
    expect(
      authorizePluginEgressUrl(
        `https://api.example.com/${'a'.repeat(4_000)}`,
        Array.from({ length: 100 }, () => exact('api.example.com'))
      )
    ).toBeInstanceOf(URL);
  });
  it.each([
    ['a trailing dot', exact('api.example.com.')],
    ['a local suffix', exact('printer.local')],
    ['an internal suffix', exact('db.internal')],
    ['localhost', exact('localhost')],
    ['an IPv4 address', exact('10.0.0.1')],
    ['punycode', exact('xn--e1afmkfd.example.com')],
    ['an empty host', exact('')],
    ['a host with a port', exact('api.example.com:443')],
    ['a host with an underscore', exact('a_b.example.com')],
  ])('refuses an exact rule with %s', (_label, rule) => {
    expect(() => authorizePluginEgressUrl('https://api.example.com/', [rule])).toThrow(
      /^plugin_egress_host_invalid$/u
    );
  });
  it.each([
    [
      'an unknown rule kind',
      { kind: 'regex', host: 'a.com' } as never,
      'plugin_egress_rule_invalid',
    ],
    ['a wildcard without a star', wildcard('example.com'), 'plugin_egress_rule_invalid'],
    ['a wildcard of a single label', wildcard('*.com'), 'plugin_egress_rule_too_broad'],
    ['a wildcard of a forbidden suffix', wildcard('*.internal'), 'plugin_egress_host_invalid'],
  ])('refuses %s', (_label, rule, code) => {
    expect(() => authorizePluginEgressUrl('https://api.example.com/', [rule])).toThrow(
      new RegExp(`^${code}$`, 'u')
    );
  });
});

describe('execution context', () => {
  const base = {
    contractVersion: 1,
    tenantId: 'tenant-a',
    pluginInstallationId: 'installation-a',
    capability: 'notifier.send',
    requestId: 'req-a',
  };
  const scope = {
    bindingRef: 'TEST_TDB_USERS_JP_0001_CORE',
    dataRole: 'tenant_core/users',
    residencyPartition: 'jp',
  };
  it('keeps a context without a scope and returns a normalised copy of one with a scope', () => {
    expect(parsePluginExecutionContext(base)).toEqual(base);
    expect(
      parsePluginExecutionContext({ ...base, executionScope: { ...scope, accountId: 'account-a' } })
    ).toEqual({ ...base, executionScope: { ...scope, accountId: 'account-a' } });
    expect(parsePluginExecutionContext({ ...base, executionScope: scope })).toEqual({
      ...base,
      executionScope: scope,
    });
  });
  it.each([
    ['null', null],
    ['an array', []],
    ['an extra key', { ...base, extra: 1 }],
    ['another contract version', { ...base, contractVersion: 2 }],
    ['a numeric tenant', { ...base, tenantId: 5 }],
    ['an unsafe tenant', { ...base, tenantId: '-a' }],
    ['an unsafe installation', { ...base, pluginInstallationId: '' }],
    ['an uppercase capability', { ...base, capability: 'Notifier' }],
    ['a request id with a space', { ...base, requestId: 'a b' }],
    ['an empty request id', { ...base, requestId: '' }],
    ['a null scope', { ...base, executionScope: null }],
    ['an array scope', { ...base, executionScope: [] }],
    ['a scope with an extra key', { ...base, executionScope: { ...scope, extra: 1 } }],
    [
      'a scope with an unsafe binding',
      { ...base, executionScope: { ...scope, bindingRef: 'plain' } },
    ],
    [
      'a scope with another data role',
      { ...base, executionScope: { ...scope, dataRole: 'tenant_core/other' } },
    ],
    [
      'a scope with an unsafe partition',
      { ...base, executionScope: { ...scope, residencyPartition: 'JP' } },
    ],
    ['a scope with an unsafe account', { ...base, executionScope: { ...scope, accountId: '-a' } }],
    ['a scope with a numeric account', { ...base, executionScope: { ...scope, accountId: 5 } }],
  ])('rejects %s', (_label, input) => {
    expect(() => parsePluginExecutionContext(input)).toThrow(/^plugin_egress_context_invalid$/u);
  });
  it('accepts the default data role and a request id of 256 printable characters', () => {
    expect(
      parsePluginExecutionContext({
        ...base,
        requestId: '!'.repeat(256),
        executionScope: { ...scope, dataRole: 'tenant_core/default' },
      }).requestId
    ).toHaveLength(256);
    expect(() => parsePluginExecutionContext({ ...base, requestId: '!'.repeat(257) })).toThrow(
      /^plugin_egress_context_invalid$/u
    );
  });
});

describe('dispatch limiter and account event resolver', () => {
  let database: DatabaseSync;
  beforeEach(() => {
    database = openRunnerDatabase();
  });
  const limiter = (options: D1Options = {}) =>
    new D1PluginDispatchLimiter(createD1(database, options).db);
  const lease = (over: Record<string, unknown> = {}) =>
    ({
      installationId: 'installation-a',
      tenantId: 'tenant-a',
      capability: 'notifier.send',
      concurrencyCap: 2,
      ratePerMinute: 10,
      now: 1_000,
      ...over,
    }) as never;
  it('needs the sessions API', async () => {
    await expect(limiter({ withoutSession: true }).acquire(lease())).rejects.toThrow(
      /^plugin_dispatch_limiter_d1_session_required$/u
    );
  });
  it.each([
    ['an unsafe installation', { installationId: '-x' }],
    ['an unsafe tenant', { tenantId: '' }],
    ['an unsafe capability', { capability: 'X' }],
    ['an unsafe destination host', { destinationHost: 'Bad_Host' }],
    ['a zero concurrency cap', { concurrencyCap: 0 }],
    ['a concurrency cap above 32', { concurrencyCap: 33 }],
    ['a zero rate', { ratePerMinute: 0 }],
    ['a rate above 10000', { ratePerMinute: 10_001 }],
    ['a zero clock', { now: 0 }],
    ['a fractional clock', { now: 1.5 }],
  ])('rejects %s', async (_label, over) => {
    await expect(limiter().acquire(lease(over))).rejects.toThrow(
      /^plugin_dispatch_limiter_input_invalid$/u
    );
  });
  it('resolves account event installations only for the fixed event type and a safe tenant', async () => {
    const resolver = new D1AccountEventInstallationResolver(createD1(database).db);
    await expect(
      resolver.resolve({ tenantId: '-x', eventType: 'account.created' })
    ).rejects.toThrow(/^plugin_sync_account_event_input_invalid$/u);
    await expect(
      resolver.resolve({ tenantId: 'tenant-a', eventType: 'account.deleted' as never })
    ).rejects.toThrow(/^plugin_sync_account_event_input_invalid$/u);
    await expect(
      new D1AccountEventInstallationResolver(
        createD1(database, { withoutSession: true }).db
      ).resolve({ tenantId: 'tenant-a', eventType: 'account.created' })
    ).rejects.toThrow(/^plugin_sync_account_event_d1_session_required$/u);
    await expect(
      resolver.resolve({ tenantId: 'tenant-a', eventType: 'account.created' })
    ).resolves.toEqual([]);
  });
  it('refuses an unreadable stored tenant gate and a clock that cannot stamp it', async () => {
    const gates = (options: D1Options = {}, now = 1_000) =>
      new D1TenantExternalGateStore(createD1(database, options).db, () => now);
    await gates().set({ tenantId: 'tenant-a', allowed: false });
    for (const patch of [
      { tenant_id: 'other' },
      { allowed: 2 },
      { generation: 0 },
      { generation: 'x' },
    ]) {
      await expect(
        gates({
          rewrite: (call, v) =>
            call.kind === 'first' && call.sql.includes('plugin_runner_tenant_external_gates') && v
              ? { ...v, ...patch }
              : v,
        }).get('tenant-a')
      ).rejects.toThrow(/^plugin_dynamic_external_gate_state_invalid$/u);
    }
    await expect(gates({}, 0).set({ tenantId: 'tenant-b', allowed: false })).rejects.toThrow(
      /^plugin_dynamic_external_gate_input_invalid$/u
    );
    await expect(gates({}, 1.5).set({ tenantId: 'tenant-b', allowed: false })).rejects.toThrow(
      /^plugin_dynamic_external_gate_input_invalid$/u
    );
  });
});

describe('dynamic worker backend lookups', () => {
  const invocation = {
    pluginInstallationId: 'installation-a',
    tenantId: 'tenant-a',
    capability: 'notifier.send',
    eventType: 'account.created',
    eventVersion: 1,
    idempotencyKey: 'k',
    payload: {
      tenantId: 'tenant-a',
      accountId: 'account-a',
      eventType: 'account.created',
      eventVersion: 1,
    },
  } as never;
  const backend = (resolve: () => Promise<unknown>) =>
    new DynamicWorkerPluginBackend(
      { get: vi.fn() } as never,
      { resolve, isExternalGateOpen: vi.fn(async () => true) } as never,
      { resolve: vi.fn() },
      vi.fn() as never
    );
  it.each([
    ['plugin_installation_lookup_invalid', 'plugin_hook_rejected'],
    ['plugin_installation_script_invalid', 'plugin_hook_provider_rejected'],
    ['plugin_installation_timeout_invalid', 'plugin_hook_provider_rejected'],
    ['plugin_installation_other', 'plugin_hook_transient_failure'],
  ])('maps the lookup failure %s to %s', async (message, code) => {
    await expect(
      backend(() => Promise.reject(new Error(message))).invoke(invocation)
    ).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
  });
  it.each([
    ['no target', null],
    ['an unsafe script', { scriptName: 'Bad', timeoutMs: 1_000 }],
    ['a zero timeout', { scriptName: 'plugin-a', timeoutMs: 0 }],
    ['an oversized timeout', { scriptName: 'plugin-a', timeoutMs: 30_001 }],
    ['a fractional timeout', { scriptName: 'plugin-a', timeoutMs: 1.5 }],
  ])('rejects %s as a provider rejection', async (_label, target) => {
    await expect(backend(async () => target).invoke(invocation)).rejects.toThrow(
      /^plugin_hook_provider_rejected$/u
    );
  });
});

describe('local log notifier', () => {
  it('rejects anything but a notifier delivery with a payload', async () => {
    const handler = localLogNotifierHandler();
    const call = (capability: string, payload: unknown) =>
      handler({ capability, payload } as never, {} as never);
    await expect(call('hook.other', { delivery: {} })).rejects.toThrow(
      /^plugin_in_process_message_rejected$/u
    );
    await expect(call('notifier.send', { accountId: 'a' })).rejects.toThrow(
      /^plugin_in_process_message_rejected$/u
    );
  });
});
