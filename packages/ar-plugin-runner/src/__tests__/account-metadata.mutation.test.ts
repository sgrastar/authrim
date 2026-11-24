import { createHmac } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isPluginAccountMetadataRequest,
  PLUGIN_ACCOUNT_METADATA_URL,
  PluginAccountMetadataService,
} from '../account-metadata';
import type { PluginEgressContext, PluginRunnerEnv } from '../types';
import {
  createD1,
  openCoreDatabase,
  openRunnerDatabase,
  type D1Options,
} from './helpers/sqlite-d1';

const SECRET = 'plugin-mutation-hmac-secret-with-32-chars';
const BINDING = 'TEST_TDB_USERS_JP_0001_CORE';
const CONTEXT: PluginEgressContext = {
  contractVersion: 1,
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  capability: 'notifier.send',
  requestId: 'request-a',
  executionScope: {
    accountId: 'account-a',
    bindingRef: BINDING,
    dataRole: 'tenant_core/users',
    residencyPartition: 'jp',
  },
};
const MUTATION = {
  operationId: 'operation-a',
  accountId: 'account-a',
  metadataKey: 'delivery.preference',
  value: { channel: 'email', enabled: true },
  expectedVersion: null,
};
const INVALID = /^plugin_data_input_invalid$/u;
const DENIED = /^plugin_data_scope_denied$/u;

let runner: DatabaseSync;
let tenant: DatabaseSync;
let tenantOptions: D1Options;
let runnerOptions: D1Options;
let tenantCalls: ReturnType<typeof createD1>['calls'];

function env(extra: Record<string, unknown> = {}): PluginRunnerEnv {
  const runnerD1 = createD1(runner, runnerOptions);
  const tenantD1 = createD1(tenant, tenantOptions);
  tenantCalls = tenantD1.calls;
  return {
    PLUGIN_RUNNER_DB: runnerD1.db,
    [BINDING]: tenantD1.db,
    PLUGIN_MUTATION_HMAC_KEY: SECRET,
    ...extra,
  } as unknown as PluginRunnerEnv;
}
const service = (now = 1_000, extra: Record<string, unknown> = {}) =>
  new PluginAccountMetadataService(env(extra), SECRET, () => now);
const write = (input: unknown = MUTATION, now = 1_000, context: unknown = CONTEXT) =>
  service(now).write(context as PluginEgressContext, input);
const metadata = () => tenant.prepare('SELECT * FROM plugin_account_metadata').all();

beforeEach(() => {
  runner = openRunnerDatabase();
  tenant = openCoreDatabase();
  tenantOptions = {};
  runnerOptions = {};
  runner.exec(
    `INSERT INTO plugin_runner_tenant_external_gates (tenant_id, allowed, generation, updated_at) VALUES ('tenant-a', 1, 1, 1);
     INSERT INTO plugin_runner_installations (installation_id, tenant_id, plugin_id, backend_kind, script_name, state, config_version, created_at, updated_at) VALUES ('installation-a', 'tenant-a', 'plugin-a', 'dynamic_worker', 'plugin-a', 'enabled', 1, 1, 1);
     INSERT INTO plugin_runner_approved_mutation_scopes (plugin_id, mutation_scope, approved_at) VALUES ('plugin-a', 'account.metadata.write', 1);
     INSERT INTO plugin_runner_installation_mutation_scopes (installation_id, mutation_scope, state, updated_at) VALUES ('installation-a', 'account.metadata.write', 'enabled', 1);`
  );
  tenant.exec(
    `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, metadata_json, created_at, updated_at) VALUES ('account-a', 'tenant-a', 'human', 'active', '{}', 1, 1)`
  );
});

describe('request recognition', () => {
  it('matches only the fixed internal URL', () => {
    const request = (url: string) => new Request(url, { method: 'PUT' });
    expect(isPluginAccountMetadataRequest(request(PLUGIN_ACCOUNT_METADATA_URL))).toBe(true);
    for (const url of [
      `${PLUGIN_ACCOUNT_METADATA_URL}?x=1`,
      `${PLUGIN_ACCOUNT_METADATA_URL}#x`,
      `${PLUGIN_ACCOUNT_METADATA_URL}/`,
      'http://authrim.invalid/internal/authrim-data/account-metadata',
      'https://authrim.invalid:8443/internal/authrim-data/account-metadata',
      'https://other.invalid/internal/authrim-data/account-metadata',
      'https://authrim.invalid/internal/authrim-data/other',
    ]) {
      expect(isPluginAccountMetadataRequest(request(url))).toBe(false);
    }
  });
});

describe('construction', () => {
  it.each([
    ['empty', ''],
    ['31 characters', 'a'.repeat(31)],
    ['not a string', 5],
  ])('refuses a %s fingerprint secret', (_label, secret) => {
    expect(() => new PluginAccountMetadataService(env(), secret as never, () => 1)).toThrow(
      /^plugin_data_hmac_key_invalid$/u
    );
  });
  it('accepts a 32-character secret and defaults to the environment key', () => {
    expect(() => new PluginAccountMetadataService(env(), 'a'.repeat(32))).not.toThrow();
    expect(() => new PluginAccountMetadataService(env())).not.toThrow();
    expect(
      () => new PluginAccountMetadataService({ ...env(), PLUGIN_MUTATION_HMAC_KEY: 'short' })
    ).toThrow(/^plugin_data_hmac_key_invalid$/u);
  });
  it('defaults the clock to the current time in seconds', async () => {
    const original = Date.now;
    Date.now = () => 1_700_000_333_900;
    try {
      await new PluginAccountMetadataService(env(), SECRET).write(CONTEXT, MUTATION);
    } finally {
      Date.now = original;
    }
    expect(metadata()).toMatchObject([{ created_at: 1_700_000_333, updated_at: 1_700_000_333 }]);
  });
});

describe('handle', () => {
  const put = (body: BodyInit | null, headers: Record<string, string> = {}, method = 'PUT') =>
    new Request(PLUGIN_ACCOUNT_METADATA_URL, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  const handle = (request: Request, extra: Record<string, unknown> = {}, ctx?: unknown) =>
    new PluginAccountMetadataService(
      env(extra),
      SECRET,
      () => 1_000,
      ctx as PluginEgressContext
    ).handle(request);
  it('answers with the result as uncacheable JSON', async () => {
    const response = await handle(put(JSON.stringify(MUTATION)), {}, CONTEXT);
    expect(response.status).toBe(200);
    expect(Object.fromEntries([...response.headers.entries()].sort())).toEqual({
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'x-content-type-options': 'nosniff',
    });
    await expect(response.json()).resolves.toEqual({
      operationId: 'operation-a',
      accountId: 'account-a',
      metadataKey: 'delivery.preference',
      version: 1,
    });
  });
  it('takes the context from the environment when none was injected', async () => {
    const response = await handle(put(JSON.stringify(MUTATION)), {
      AUTHRIM_PLUGIN_EGRESS_CONTEXT: CONTEXT,
    });
    expect(response.status).toBe(200);
  });
  it('prefers the injected context over the environment one', async () => {
    await expect(
      handle(put(JSON.stringify(MUTATION)), { AUTHRIM_PLUGIN_EGRESS_CONTEXT: { bad: 1 } }, CONTEXT)
    ).resolves.toBeInstanceOf(Response);
  });
  it('refuses without any valid context', async () => {
    await expect(handle(put(JSON.stringify(MUTATION)))).rejects.toThrow(
      /^plugin_egress_context_invalid$/u
    );
  });
  it.each(['POST', 'GET', 'PATCH', 'DELETE'])('refuses the %s method', async (method) => {
    const request = put(method === 'GET' ? null : '{}', {}, method);
    await expect(handle(request, {}, CONTEXT)).rejects.toThrow(/^plugin_data_method_denied$/u);
  });
  it.each([
    ['text/plain', 'text/plain'],
    ['a prefix match', 'application/jsonx'],
    ['a different subtype', 'application/ld+json'],
    ['an empty type', ''],
  ])('refuses the content type %s', async (_label, type) => {
    await expect(
      handle(put(JSON.stringify(MUTATION), { 'Content-Type': type }), {}, CONTEXT)
    ).rejects.toThrow(INVALID);
  });
  it.each(['application/json; charset=utf-8', 'application/json ;x=y', ' application/json'])(
    'accepts the media type %j with parameters or whitespace',
    async (type) => {
      await expect(
        handle(put(JSON.stringify(MUTATION), { 'Content-Type': type }), {}, CONTEXT)
      ).resolves.toBeInstanceOf(Response);
    }
  );
  it('refuses a request without a content type', async () => {
    const request = new Request(PLUGIN_ACCOUNT_METADATA_URL, { method: 'PUT', body: '{}' });
    request.headers.delete('Content-Type');
    await expect(handle(request, {}, CONTEXT)).rejects.toThrow(INVALID);
  });
  it.each([
    ['text that is not JSON', '{nope'],
    ['a truncated document', '{"operationId":'],
  ])('refuses %s', async (_label, body) => {
    await expect(handle(put(body), {}, CONTEXT)).rejects.toThrow(INVALID);
  });
  it('refuses a body that is not valid UTF-8', async () => {
    await expect(handle(put(new Uint8Array([0x7b, 0xff, 0x7d])), {}, CONTEXT)).rejects.toThrow(
      INVALID
    );
  });
  it('refuses a valid document one byte above 20 KiB', async () => {
    const json = JSON.stringify(MUTATION);
    const body = `${json}${' '.repeat(20 * 1024 + 1 - json.length)}`;
    expect(new TextEncoder().encode(body).byteLength).toBe(20 * 1024 + 1);
    await expect(handle(put(body), {}, CONTEXT)).rejects.toThrow(INVALID);
    expect(tenantCalls).toEqual([]);
  });
  it('refuses a valid document whose declared length is above 20 KiB', async () => {
    await expect(
      handle(
        put(JSON.stringify(MUTATION), { 'Content-Length': String(20 * 1024 + 1) }),
        {},
        CONTEXT
      )
    ).rejects.toThrow(INVALID);
    expect(tenantCalls).toEqual([]);
  });
  it('accepts a body of exactly 20 KiB made of valid JSON whitespace', async () => {
    const json = JSON.stringify(MUTATION);
    const body = `${json}${' '.repeat(20 * 1024 - json.length)}`;
    expect(new TextEncoder().encode(body).byteLength).toBe(20 * 1024);
    await expect(handle(put(body), {}, CONTEXT)).resolves.toBeInstanceOf(Response);
  });
});

describe('write input', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['an extra key', { ...MUTATION, extra: 1 }],
    ['a missing key', { ...MUTATION, value: undefined }],
    ['an uppercase metadata key', { ...MUTATION, metadataKey: 'Key' }],
    ['a metadata key starting with a digit', { ...MUTATION, metadataKey: '1key' }],
    ['a numeric metadata key', { ...MUTATION, metadataKey: 5 }],
    ['an over-long metadata key', { ...MUTATION, metadataKey: `a${'b'.repeat(64)}` }],
    ['a zero expected version', { ...MUTATION, expectedVersion: 0 }],
    ['a fractional expected version', { ...MUTATION, expectedVersion: 1.5 }],
    ['a textual expected version', { ...MUTATION, expectedVersion: '1' }],
    ['an undefined expected version', { ...MUTATION, expectedVersion: undefined }],
    ['an unsafe operation id', { ...MUTATION, operationId: '-x' }],
    ['a numeric operation id', { ...MUTATION, operationId: 5 }],
    ['an unsafe account id', { ...MUTATION, accountId: ' ' }],
  ])('rejects %s', async (_label, input) => {
    await expect(write(input)).rejects.toThrow(INVALID);
    expect(metadata()).toEqual([]);
  });
  it('accepts a metadata key of exactly 64 characters', async () => {
    await expect(write({ ...MUTATION, metadataKey: `a${'b'.repeat(63)}` })).resolves.toMatchObject({
      version: 1,
    });
  });
  const nest = (depth: number): unknown => (depth === 0 ? 1 : [nest(depth - 1)]);
  it('accepts moderately nested values and refuses ones nested beyond the limit', async () => {
    await expect(write({ ...MUTATION, value: nest(7) })).resolves.toMatchObject({ version: 1 });
    await expect(write({ ...MUTATION, operationId: 'op-2', value: nest(9) })).rejects.toThrow(
      INVALID
    );
    await expect(write({ ...MUTATION, operationId: 'op-3', value: nest(40) })).rejects.toThrow(
      INVALID
    );
  });
  it('refuses a value with more than 256 nodes and accepts a few hundred bytes of nodes', async () => {
    const flat = (count: number) => Array.from({ length: count }, () => 1);
    await expect(
      write({ ...MUTATION, value: [flat(60), flat(60), flat(60)] })
    ).resolves.toMatchObject({ version: 1 });
    await expect(
      write({
        ...MUTATION,
        operationId: 'op-2',
        value: [flat(60), flat(60), flat(60), flat(60), flat(60)],
      })
    ).rejects.toThrow(INVALID);
  });
  it.each([
    ['sixty-five array entries', Array.from({ length: 65 }, () => 1)],
    [
      'sixty-five object keys',
      Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 1])),
    ],
    ['a key with a control character', { 'a\u0001b': 1 }],
    ['a non-ASCII key', { ключ: 1 }],
    ['an empty key', { '': 1 }],
    ['an over-long key', { [`k${'x'.repeat(128)}`]: 1 }],
    ['an infinite number', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
    ['a bigint', 1n],
    ['a function', () => 1],
    ['a symbol', Symbol('x')],
    ['undefined', undefined],
    ['a nested undefined', { a: undefined }],
    ['an oversized document', 'x'.repeat(16 * 1024)],
  ])('rejects a value that is %s', async (_label, value) => {
    await expect(write({ ...MUTATION, value })).rejects.toThrow(INVALID);
  });
  it('accepts sixty-four entries, sixty-four keys and keys of 1 and 128 characters', async () => {
    await expect(
      write({ ...MUTATION, operationId: 'o1', value: Array.from({ length: 64 }, () => 1) })
    ).resolves.toBeTruthy();
    await expect(
      write({
        ...MUTATION,
        operationId: 'o2',
        metadataKey: 'second',
        value: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, 1])),
      })
    ).resolves.toBeTruthy();
    await expect(
      write({
        ...MUTATION,
        operationId: 'o3',
        metadataKey: 'third',
        value: { a: 1, [`k${'x'.repeat(127)}`]: 2, ' ': 3 },
      })
    ).resolves.toBeTruthy();
  });
  it('refuses a circular value and accepts a shared one', async () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    await expect(write({ ...MUTATION, value: loop })).rejects.toThrow(INVALID);
    const shared = { x: 1 };
    await expect(write({ ...MUTATION, value: { a: shared, b: shared } })).resolves.toBeTruthy();
  });
  it('limits the canonical value to 16 KiB', async () => {
    const text = (length: number) => 'x'.repeat(length);
    await expect(write({ ...MUTATION, value: text(16 * 1024 - 2) })).resolves.toBeTruthy();
    await expect(
      write({ ...MUTATION, operationId: 'op-2', metadataKey: 'other', value: text(16 * 1024 - 1) })
    ).rejects.toThrow(INVALID);
    await expect(
      write({ ...MUTATION, operationId: 'op-3', metadataKey: 'wide', value: '€'.repeat(5_500) })
    ).rejects.toThrow(INVALID);
  });
  it('stores the value with sorted keys and canonical numbers', async () => {
    await write({ ...MUTATION, value: { b: [1, 2.5, null, true], a: 'x', c: { z: 1, y: 2 } } });
    expect(metadata()).toMatchObject([
      { value_json: '{"a":"x","b":[1,2.5,null,true],"c":{"y":2,"z":1}}' },
    ]);
  });
});

describe('write input edges', () => {
  const nestObject = (depth: number): unknown => (depth === 0 ? 1 : { k: nestObject(depth - 1) });
  it('refuses deeply nested objects as well as arrays', async () => {
    await expect(write({ ...MUTATION, value: nestObject(5) })).resolves.toMatchObject({
      version: 1,
    });
    await expect(
      write({ ...MUTATION, operationId: 'op-2', metadataKey: 'second', value: nestObject(9) })
    ).rejects.toThrow(INVALID);
    await expect(
      write({ ...MUTATION, operationId: 'op-3', metadataKey: 'third', value: nestObject(40) })
    ).rejects.toThrow(INVALID);
  });
  it('refuses an object with any invalid key, not only when every key is invalid', async () => {
    await expect(write({ ...MUTATION, value: { ok: 1, 'bad\u0001': 2 } })).rejects.toThrow(INVALID);
    await expect(write({ ...MUTATION, value: { 'bad\u0001': 2, ok: 1 } })).rejects.toThrow(INVALID);
  });
  it('accepts the smallest clock value', async () => {
    await expect(write(MUTATION, 1)).resolves.toMatchObject({ version: 1 });
    expect(metadata()).toMatchObject([{ created_at: 1, updated_at: 1 }]);
  });
  it('reads both databases from the primary', async () => {
    const runnerD1 = createD1(runner);
    const tenantD1 = createD1(tenant);
    const e = {
      PLUGIN_RUNNER_DB: runnerD1.db,
      [BINDING]: tenantD1.db,
      PLUGIN_MUTATION_HMAC_KEY: SECRET,
    } as unknown as PluginRunnerEnv;
    await new PluginAccountMetadataService(e, SECRET, () => 1_000).write(CONTEXT, MUTATION);
    expect(runnerD1.calls.filter((c) => c.kind === 'session').map((c) => c.sql)).toEqual([
      'first-primary',
    ]);
    expect(tenantD1.calls.filter((c) => c.kind === 'session').map((c) => c.sql)).toEqual([
      'first-primary',
    ]);
  });
  it('refuses a request body with invalid UTF-8 inside a string rather than repairing it', async () => {
    const prefix = new TextEncoder().encode(
      '{"operationId":"operation-a","accountId":"account-a","metadataKey":"k","expectedVersion":null,"value":"a'
    );
    const suffix = new TextEncoder().encode('b"}');
    const body = new Uint8Array([...prefix, 0xff, ...suffix]);
    const request = new Request(PLUGIN_ACCOUNT_METADATA_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    await expect(
      new PluginAccountMetadataService(env(), SECRET, () => 1_000, CONTEXT).handle(request)
    ).rejects.toThrow(INVALID);
    expect(metadata()).toEqual([]);
  });
});

describe('write scope', () => {
  it.each([
    ['no scope at all', (({ executionScope: _scope, ...rest }) => rest)(CONTEXT)],
    [
      'the default data role',
      {
        ...CONTEXT,
        executionScope: { ...CONTEXT.executionScope, dataRole: 'tenant_core/default' },
      },
    ],
    [
      'another account',
      { ...CONTEXT, executionScope: { ...CONTEXT.executionScope, accountId: 'account-b' } },
    ],
    [
      'no account',
      {
        ...CONTEXT,
        executionScope: {
          bindingRef: BINDING,
          dataRole: 'tenant_core/users',
          residencyPartition: 'jp',
        },
      },
    ],
  ])('denies %s', async (_label, context) => {
    await expect(write(MUTATION, 1_000, context)).rejects.toThrow(DENIED);
    expect(metadata()).toEqual([]);
  });
  it('rejects a context that is not well-formed', async () => {
    for (const context of [null, [], { ...CONTEXT, extra: 1 }, { ...CONTEXT, tenantId: '' }]) {
      await expect(write(MUTATION, 1_000, context)).rejects.toThrow(
        /^plugin_egress_context_invalid$/u
      );
    }
  });
  it.each([0, -1, 1.5, Number.NaN])('refuses a clock value of %s', async (now) => {
    await expect(write(MUTATION, now)).rejects.toThrow(/^plugin_data_internal_error$/u);
  });
  it('checks the account scope before the clock and before reading storage', async () => {
    const calls = () => tenantCalls.length;
    await expect(
      write(MUTATION, 0, {
        ...CONTEXT,
        executionScope: { ...CONTEXT.executionScope, accountId: 'x' },
      })
    ).rejects.toThrow(DENIED);
    expect(calls()).toBe(0);
  });
  describe('installation authorization', () => {
    it.each([
      ['a disabled installation', "UPDATE plugin_runner_installations SET state = 'disabled'"],
      ['a blocked installation', "UPDATE plugin_runner_installations SET state = 'blocked'"],
      ['another tenant', "UPDATE plugin_runner_installations SET tenant_id = 'tenant-b'"],
      [
        'a disabled scope',
        "UPDATE plugin_runner_installation_mutation_scopes SET state = 'disabled'",
      ],
      ['an unapproved scope', 'DELETE FROM plugin_runner_approved_mutation_scopes'],
      ['a closed tenant gate', 'UPDATE plugin_runner_tenant_external_gates SET allowed = 0'],
      ['no tenant gate', 'DELETE FROM plugin_runner_tenant_external_gates'],
    ])('denies %s', async (_label, sql) => {
      runner.exec(sql);
      await expect(write()).rejects.toThrow(DENIED);
      expect(metadata()).toEqual([]);
    });
    it('does not apply the tenant gate to a built-in installation', async () => {
      runner.exec('DELETE FROM plugin_runner_tenant_external_gates');
      runner.exec(
        "UPDATE plugin_runner_installations SET backend_kind = 'in_process', script_name = NULL"
      );
      await expect(write()).resolves.toMatchObject({ version: 1 });
    });
    it('refuses a plugin id the store would not accept', async () => {
      runnerOptions = {
        intercept: (call) =>
          call.kind === 'first' && call.sql.includes('plugin_runner_installations')
            ? { value: { plugin_id: 'Bad Plugin' } }
            : undefined,
      };
      await expect(write()).rejects.toThrow(DENIED);
    });
    it('binds the installation and tenant of the context', async () => {
      const runnerD1 = createD1(runner);
      const e = {
        PLUGIN_RUNNER_DB: runnerD1.db,
        [BINDING]: createD1(tenant).db,
        PLUGIN_MUTATION_HMAC_KEY: SECRET,
      } as unknown as PluginRunnerEnv;
      await new PluginAccountMetadataService(e, SECRET, () => 1_000).write(CONTEXT, MUTATION);
      expect(runnerD1.calls.find((c) => c.kind === 'first')?.values).toEqual([
        'installation-a',
        'tenant-a',
      ]);
    });
  });
  describe('tenant database', () => {
    it.each([
      ['a missing binding', undefined],
      ['a non-database binding', {}],
      ['one without prepare', { withSession: () => undefined }],
      ['one without sessions', { prepare: () => undefined }],
    ])('refuses %s', async (_label, binding) => {
      const e = env();
      (e as unknown as Record<string, unknown>)[BINDING] = binding;
      await expect(
        new PluginAccountMetadataService(e, SECRET, () => 1_000).write(CONTEXT, MUTATION)
      ).rejects.toThrow(/^plugin_data_binding_unavailable$/u);
    });
    it('refuses a binding name outside the tenant database pattern', async () => {
      const context = {
        ...CONTEXT,
        executionScope: { ...CONTEXT.executionScope, bindingRef: 'plain_binding' },
      };
      await expect(write(MUTATION, 1_000, context)).rejects.toThrow(
        /^plugin_egress_context_invalid$/u
      );
    });
    it('needs the sessions API on both databases', async () => {
      runnerOptions = { withoutSession: true };
      await expect(write()).rejects.toThrow(/^plugin_data_d1_session_required$/u);
      runnerOptions = {};
      tenantOptions = { withoutSession: true };
      const e = env();
      (e as unknown as Record<string, unknown>)[BINDING] = {
        prepare: () => undefined,
        withSession: undefined,
      };
      await expect(
        new PluginAccountMetadataService(e, SECRET, () => 1_000).write(CONTEXT, MUTATION)
      ).rejects.toThrow(/^plugin_data_binding_unavailable$/u);
    });
    it('refuses a missing or inactive account', async () => {
      tenant.exec("UPDATE identity_accounts SET lifecycle_state = 'disabled'");
      await expect(write()).rejects.toThrow(/^plugin_data_account_unavailable$/u);
      tenant.exec('DELETE FROM identity_accounts');
      await expect(write()).rejects.toThrow(/^plugin_data_account_unavailable$/u);
    });
    it('does not see accounts of another tenant', async () => {
      tenant.exec("UPDATE identity_accounts SET tenant_id = 'tenant-b'");
      await expect(write()).rejects.toThrow(/^plugin_data_account_unavailable$/u);
    });
  });
});

describe('documented value limits and wire contract', () => {
  const nest = (depth: number): unknown => (depth === 0 ? 1 : [nest(depth - 1)]);
  const nestObject = (depth: number): unknown => (depth === 0 ? 1 : { k: nestObject(depth - 1) });
  // 1 root + 3 arrays of 63 numbers (64 nodes each) + one array of `last` numbers.
  const nodes = (last: number) => [
    ...Array.from({ length: 3 }, () => Array.from({ length: 63 }, () => 1)),
    Array.from({ length: last }, () => 1),
  ];
  it('allows exactly eight levels of nesting and refuses a ninth', async () => {
    await expect(write({ ...MUTATION, value: nest(8) })).resolves.toMatchObject({ version: 1 });
    await expect(
      write({ ...MUTATION, operationId: 'op-2', metadataKey: 'two', value: nestObject(8) })
    ).resolves.toMatchObject({ version: 1 });
    await expect(
      write({ ...MUTATION, operationId: 'op-3', metadataKey: 'three', value: nest(9) })
    ).rejects.toThrow(INVALID);
    await expect(
      write({ ...MUTATION, operationId: 'op-4', metadataKey: 'four', value: nestObject(9) })
    ).rejects.toThrow(INVALID);
  });
  it('allows exactly 256 JSON nodes and refuses 257', async () => {
    await expect(write({ ...MUTATION, value: nodes(62) })).resolves.toMatchObject({ version: 1 });
    await expect(
      write({ ...MUTATION, operationId: 'op-2', metadataKey: 'two', value: nodes(63) })
    ).rejects.toThrow(INVALID);
    expect(metadata()).toHaveLength(1);
  });
  it('fingerprints the same canonical envelope as before the limits were decoupled', async () => {
    await write();
    const payload =
      '{"accountId":"account-a","expectedVersion":null,"installationId":"installation-a","metadataKey":"delivery.preference","operationId":"operation-a","pluginId":"plugin-a","tenantId":"tenant-a","value":{"channel":"email","enabled":true}}';
    const expected = createHmac('sha256', SECRET)
      .update(`authrim-plugin-account-metadata-v1\0${payload}`)
      .digest('hex');
    expect(
      tenant.prepare('SELECT request_fingerprint FROM plugin_account_metadata_mutations').get()
    ).toEqual({ request_fingerprint: expected });
  });
  it('refuses a request body that starts with a byte order mark', async () => {
    const request = new Request(PLUGIN_ACCOUNT_METADATA_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode(JSON.stringify(MUTATION)),
      ]),
    });
    await expect(
      new PluginAccountMetadataService(env(), SECRET, () => 1_000, CONTEXT).handle(request)
    ).rejects.toThrow(INVALID);
    expect(metadata()).toEqual([]);
  });
});
