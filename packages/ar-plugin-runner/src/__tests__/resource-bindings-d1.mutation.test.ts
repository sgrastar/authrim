import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginD1ResourceAccess, type PluginResourceBindingProps } from '../resource-bindings';
import {
  createResourceWorld,
  entrypoint,
  HOST,
  insertResource,
  propsFor,
} from './helpers/resource-fixture';
import { rejectOpaque } from './helpers/mock-kit';

vi.mock('@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer', () => ({
  runSamlDrCoveredOperation: (
    env: unknown,
    ctx: unknown,
    op: (env: unknown, ctx: unknown) => unknown
  ) => op(env, ctx),
}));

let world: ReturnType<typeof createResourceWorld>;
let props: PluginResourceBindingProps;

const d1 = (over: Partial<PluginResourceBindingProps> = {}) =>
  entrypoint(PluginD1ResourceAccess, world.env, { ...props, ...over });
const DENIED = /^plugin_dynamic_resource_scope_denied$/u;

beforeEach(async () => {
  world = createResourceWorld();
  props = await propsFor('d1');
  insertResource(world.runner, props);
});

describe('D1 resource authorization', () => {
  it('authorizes against exactly the active row of this installation', async () => {
    await expect(d1().all('SELECT 1 AS one')).resolves.toEqual({ results: [{ one: 1 }] });
    const query = world.calls.find((call) =>
      call.sql.includes('FROM plugin_runner_dynamic_worker_resources')
    );
    expect(query?.values).toEqual([
      props.installationId,
      props.tenantId,
      props.pluginId,
      props.logicalResourceId,
    ]);
    expect(world.calls.find((call) => call.kind === 'session')?.sql).toBe('first-primary');
  });

  it.each([
    ['another tenant', { tenantId: 'tenant-b' }],
    ['another plugin', { pluginId: 'plugin-b' }],
    ['another installation', { installationId: 'installation-b' }],
    ['another logical resource', { logicalResourceId: 'other' }],
  ])('denies %s', async (_label, over) => {
    await expect(d1(over).all('SELECT 1')).rejects.toThrow(DENIED);
  });

  it.each([
    ['another binding name', { binding: 'OTHER_BINDING' }],
    ['another access mode', { access: 'read_only' as const }],
    ['another fingerprint', { ownershipFingerprint: 'e'.repeat(64) }],
    ['another host binding', { hostBindingRef: `PRES_D1_${'D'.repeat(24)}` }],
  ])('denies props with %s', async (_label, over) => {
    await expect(d1(over).all('SELECT 1')).rejects.toThrow(DENIED);
  });

  it.each([
    ['installation', { installation_id: 'other' }],
    ['tenant', { tenant_id: 'other' }],
    ['plugin', { plugin_id: 'other' }],
    ['logical resource', { logical_resource_id: 'other' }],
    ['kind', { resource_kind: 'kv_namespace' }],
    ['state', { state: 'disabled' }],
    ['binding', { logical_binding_name: 'OTHER' }],
    ['host reference', { host_binding_ref: HOST.kv_namespace }],
    ['access', { access_mode: 'read_only' }],
    ['fingerprint', { ownership_fingerprint: 'f'.repeat(64) }],
  ])('denies a stored row that disagrees about the %s', async (_label, patch) => {
    const real = world.runner
      .prepare('SELECT * FROM plugin_runner_dynamic_worker_resources')
      .get() as Record<string, unknown>;
    world = createResourceWorld({
      intercept: (call) => (call.kind === 'first' ? { value: { ...real, ...patch } } : undefined),
    });
    await expect(d1().all('SELECT 1')).rejects.toThrow(DENIED);
  });

  it('denies a disabled resource', async () => {
    world.runner.exec("UPDATE plugin_runner_dynamic_worker_resources SET state = 'disabled'");
    await expect(d1().all('SELECT 1')).rejects.toThrow(DENIED);
  });

  it('denies a props kind other than the entrypoint kind before reading storage', async () => {
    const kv = await propsFor('kv_namespace');
    await expect(entrypoint(PluginD1ResourceAccess, world.env, kv).all('SELECT 1')).rejects.toThrow(
      /^plugin_dynamic_resource_kind_denied$/u
    );
    expect(world.calls).toEqual([]);
  });

  it('refuses when the runner database has no sessions API', async () => {
    world = createResourceWorld({ withoutSession: true });
    await expect(d1().all('SELECT 1')).rejects.toThrow(
      /^plugin_dynamic_resource_state_unavailable$/u
    );
  });

  it.each([
    ['missing', undefined],
    ['not a record', 'string'],
    ['without prepare', { withSession: () => undefined }],
    ['without sessions', { prepare: () => undefined }],
  ])('refuses a host binding that is %s', async (_label, binding) => {
    (world.env as unknown as Record<string, unknown>)[HOST.d1] = binding;
    await expect(d1().all('SELECT 1')).rejects.toThrow(
      /^plugin_dynamic_resource_binding_unavailable$/u
    );
  });

  describe('props shape', () => {
    const PROPS_INVALID = /^plugin_dynamic_resource_props_invalid$/u;
    const INPUT_INVALID = /^plugin_dynamic_resource_input_invalid$/u;
    const run = (value: unknown) =>
      entrypoint(PluginD1ResourceAccess, world.env, value).all('SELECT 1');
    it.each([
      ['null', null],
      ['array', []],
      ['extra key', { extra: 1 }],
      ['missing key', { tenantId: 'tenant-a' }],
    ])('rejects %s props', async (_label, value) => {
      const base =
        value && !Array.isArray(value) && 'extra' in value ? { ...props, ...value } : value;
      await expect(run(base)).rejects.toThrow(PROPS_INVALID);
    });
    it.each([
      ['tenant', { tenantId: '' }],
      ['tenant start', { tenantId: '-a' }],
      ['plugin', { pluginId: 'Plugin' }],
      ['numeric plugin', { pluginId: 5 }],
      ['installation', { installationId: ' ' }],
    ])('rejects a bad %s', async (_label, over) => {
      await expect(run({ ...props, ...over })).rejects.toThrow(PROPS_INVALID);
    });
    it.each([
      ['kind', { kind: 'queue' }],
      ['access', { access: 'admin' }],
      ['host reference', { hostBindingRef: 'PRES_D1_short' }],
      ['lowercase host reference', { hostBindingRef: `PRES_D1_${'a'.repeat(24)}` }],
      ['host reference suffix', { hostBindingRef: `PRES_D1_${'A'.repeat(24)}X` }],
      ['host reference prefix', { hostBindingRef: `XPRES_D1_${'A'.repeat(24)}` }],
      ['numeric host reference', { hostBindingRef: 5 }],
      ['kind prefix mismatch', { hostBindingRef: HOST.kv_namespace }],
      ['kind prefix mismatch with R2', { hostBindingRef: HOST.r2_bucket }],
      ['logical id', { logicalResourceId: 'State' }],
      ['numeric logical id', { logicalResourceId: 5 }],
      ['binding', { binding: 'plugin_state' }],
      ['numeric binding', { binding: 5 }],
      ['fingerprint', { ownershipFingerprint: 'A'.repeat(64) }],
      ['short fingerprint', { ownershipFingerprint: 'a'.repeat(63) }],
      ['fingerprint with a prefix', { ownershipFingerprint: `0${'a'.repeat(64)}` }],
      ['fingerprint with a suffix', { ownershipFingerprint: `${'a'.repeat(64)}0` }],
      ['numeric fingerprint', { ownershipFingerprint: 5 }],
    ])('rejects a bad %s', async (_label, over) => {
      await expect(run({ ...props, ...over })).rejects.toThrow(INPUT_INVALID);
    });
    it('accepts boundary identifiers', async () => {
      const long = `a${'b'.repeat(127)}`;
      await expect(
        run({
          ...props,
          tenantId: 'T'.repeat(256),
          pluginId: long,
          logicalResourceId: long,
          binding: `A${'B'.repeat(127)}`,
        })
      ).rejects.toThrow(DENIED);
    });
    it('rejects over-long identifiers', async () => {
      await expect(run({ ...props, tenantId: 'a'.repeat(257) })).rejects.toThrow(PROPS_INVALID);
      await expect(run({ ...props, pluginId: 'a'.repeat(129) })).rejects.toThrow(PROPS_INVALID);
      await expect(run({ ...props, logicalResourceId: 'a'.repeat(129) })).rejects.toThrow(
        INPUT_INVALID
      );
      await expect(run({ ...props, binding: `A${'B'.repeat(128)}` })).rejects.toThrow(
        INPUT_INVALID
      );
    });
  });
});

describe('D1 reads', () => {
  const SQL_INVALID = /^plugin_dynamic_resource_sql_invalid$/u;
  const SQL_DENIED = /^plugin_dynamic_resource_sql_denied$/u;
  beforeEach(() => {
    world.resourceCalls.length = 0;
  });

  it('runs one SELECT with bound parameters and returns the rows', async () => {
    const result = await d1().all('SELECT ? AS a, ? AS b, ? AS c, ? AS d', ['x', 2, true, null]);
    expect(result).toEqual({ results: [{ a: 'x', b: 2, c: 1, d: null }] });
    const prepared = world.resourceCalls.find((call) => call.kind === 'all');
    expect(prepared?.sql).toBe('SELECT ? AS a, ? AS b, ? AS c, ? AS d');
  });

  it.each([
    ['lowercase', 'select 1'],
    ['mixed case', 'SeLeCt 1'],
    ['leading whitespace', '  \n SELECT 1'],
    ['leading line comment', '-- note\nSELECT 1'],
    ['leading line comment at end of input', '-- note\n   \nSELECT 1'],
    ['leading block comment', '/* note */ SELECT 1'],
    ['trailing semicolon', 'SELECT 1;'],
  ])('accepts a SELECT with %s', async (_label, sql) => {
    await expect(d1().all(sql)).resolves.toEqual({ results: [{ '1': 1 }] });
  });

  it.each([
    ['a number', 5],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['two statements', 'SELECT 1; SELECT 2'],
    ['only a comment', '-- nothing'],
    ['an oversized statement', `SELECT '${'x'.repeat(64 * 1024)}'`],
  ])('rejects %s as invalid SQL', async (_label, sql) => {
    await expect(d1().all(sql)).rejects.toThrow(SQL_INVALID);
  });

  it.each([
    ['an INSERT', 'INSERT INTO plugin_state VALUES (1, 2)'],
    ['an UPDATE', 'UPDATE plugin_state SET value = 1'],
    ['a DELETE', 'DELETE FROM plugin_state'],
    ['a WITH', 'WITH x AS (SELECT 1) SELECT * FROM x'],
    ['a PRAGMA', 'PRAGMA table_info(plugin_state)'],
    ['a digit-led statement', '1 SELECT'],
    ['a comment-hidden DROP', '/* SELECT */ DROP TABLE plugin_state'],
  ])('denies %s on the read path', async (_label, sql) => {
    await expect(d1().all(sql)).rejects.toThrow(SQL_DENIED);
  });

  it('accepts a statement of exactly 64 KiB and rejects one byte more', async () => {
    const overhead = "SELECT '' AS v".length;
    const sql = `SELECT '${'x'.repeat(64 * 1024 - overhead)}' AS v`;
    expect(new TextEncoder().encode(sql).byteLength).toBe(64 * 1024);
    const result = (await d1().all(sql)) as { results: Array<{ v: string }> };
    expect(result.results[0]?.v).toHaveLength(64 * 1024 - overhead);
    await expect(d1().all(`${sql} `)).rejects.toThrow(SQL_INVALID);
  });

  describe('parameters', () => {
    const PARAMS_INVALID = /^plugin_dynamic_resource_params_invalid$/u;
    it('treats missing parameters as none and keeps a bound array of any supported type', async () => {
      await expect(d1().all('SELECT 1 AS one', undefined)).resolves.toEqual({
        results: [{ one: 1 }],
      });
      await expect(d1().all('SELECT ? AS blob', [new Uint8Array([1, 2])])).resolves.toEqual({
        results: [{ blob: new Uint8Array([1, 2]) }],
      });
    });
    it.each([
      ['an object', { a: 1 }],
      ['a string', 'x'],
      ['null', null],
      ['101 entries', Array.from({ length: 101 }, () => 1)],
      ['an object entry', [{}]],
      ['an undefined entry', [undefined]],
      ['a bigint entry', [1n]],
      ['a function entry', [() => 1]],
      ['NaN', [Number.NaN]],
      ['Infinity', [Number.POSITIVE_INFINITY]],
      ['-Infinity', [Number.NEGATIVE_INFINITY]],
      ['an oversized total', ['x'.repeat(1024 * 1024), 'y']],
      ['an oversized blob total', [new Uint8Array(1024 * 1024), 'y']],
    ])('rejects %s', async (_label, params) => {
      await expect(d1().all('SELECT 1', params)).rejects.toThrow(PARAMS_INVALID);
    });
    it('accepts 100 entries and a total of exactly 1 MiB', async () => {
      await expect(
        d1().all(
          `SELECT ${Array.from({ length: 100 }, () => '?').join(' + ')} AS total`,
          Array.from({ length: 100 }, () => 1)
        )
      ).resolves.toEqual({ results: [{ total: 100 }] });
      await expect(d1().all('SELECT length(?) AS n', ['x'.repeat(1024 * 1024)])).resolves.toEqual({
        results: [{ n: 1024 * 1024 }],
      });
    });
    it('counts booleans, numbers and null by their JSON length toward the total', async () => {
      const filler = 'x'.repeat(1024 * 1024 - 4);
      await expect(d1().all('SELECT length(?) AS n', [filler])).resolves.toBeDefined();
      await expect(
        d1().all('SELECT length(?) AS n, ? AS m', [filler, true])
      ).resolves.toBeDefined();
      await expect(d1().all('SELECT length(?) AS n, ? AS m', [filler, false])).rejects.toThrow(
        PARAMS_INVALID
      );
      await expect(
        d1().all('SELECT length(?) AS n, ? AS m', [filler, null])
      ).resolves.toBeDefined();
      await expect(d1().all('SELECT length(?) AS n, ? AS m', [filler, 12345])).rejects.toThrow(
        PARAMS_INVALID
      );
    });
  });

  describe('results', () => {
    const answer = (value: unknown) => {
      world = createResourceWorld();
      const target = world.env as unknown as Record<string, unknown>;
      target[HOST.d1] = {
        prepare: () => undefined,
        withSession: () => ({
          prepare: () => ({ bind: () => ({ all: async () => value }) }),
        }),
      };
      insertResource(world.runner, props);
      return d1().all('SELECT 1');
    };
    it('rejects a failed query', async () => {
      await expect(answer({ success: false, results: [] })).rejects.toThrow(
        /^plugin_dynamic_resource_query_failed$/u
      );
    });
    it('rejects a result without a rows array', async () => {
      await expect(answer({ success: true, results: 'x' })).rejects.toThrow(
        /^plugin_dynamic_resource_query_failed$/u
      );
      await expect(answer({ success: true })).rejects.toThrow(
        /^plugin_dynamic_resource_query_failed$/u
      );
    });
    it('rejects an unserializable result', async () => {
      await expect(answer({ success: true, results: [{ big: 1n }] })).rejects.toThrow(
        /^plugin_dynamic_resource_result_invalid$/u
      );
    });
    it('rejects a result larger than 1 MiB and accepts one that fits', async () => {
      await expect(answer({ success: true, results: ['x'.repeat(1024 * 1024)] })).rejects.toThrow(
        /^plugin_dynamic_resource_result_too_large$/u
      );
      const fits = 'x'.repeat(1024 * 1024 - '{"results":[""]}'.length);
      await expect(answer({ success: true, results: [fits] })).resolves.toEqual({
        results: [fits],
      });
    });
    it('counts result size in bytes, not characters', async () => {
      const wide = '€'.repeat(400_000);
      await expect(answer({ success: true, results: [wide] })).rejects.toThrow(
        /^plugin_dynamic_resource_result_too_large$/u
      );
    });
  });
});

describe('D1 writes', () => {
  beforeEach(() => {
    world.resourceCalls.length = 0;
  });
  const prepare = async () => {
    const binding = world.env[HOST.d1] as {
      prepare: (sql: string) => { bind: () => { run: () => Promise<unknown> } };
    };
    await binding
      .prepare('CREATE TABLE IF NOT EXISTS plugin_state (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
      .bind()
      .run();
  };
  it.each([
    ['INSERT', "INSERT INTO plugin_state (id, value) VALUES ('a', 'x')"],
    ['REPLACE', "REPLACE INTO plugin_state (id, value) VALUES ('a', 'x')"],
    ['insert lower-case', "insert into plugin_state (id, value) values ('a', 'x')"],
  ])('runs a %s and reports the change count', async (_label, sql) => {
    await expect(d1().run(sql)).resolves.toEqual({ changes: 1 });
  });
  it('updates and deletes with bound parameters', async () => {
    await d1().run('INSERT INTO plugin_state (id, value) VALUES (?, ?)', ['a', 'x']);
    await expect(
      d1().run('UPDATE plugin_state SET value = ? WHERE id = ?', ['y', 'a'])
    ).resolves.toEqual({
      changes: 1,
    });
    await expect(d1().run('DELETE FROM plugin_state WHERE id = ?', ['a'])).resolves.toEqual({
      changes: 1,
    });
    await expect(d1().run('DELETE FROM plugin_state WHERE id = ?', ['a'])).resolves.toEqual({
      changes: 0,
    });
  });
  it.each([
    ['SELECT', 'SELECT 1'],
    ['DROP', 'DROP TABLE plugin_state'],
    ['CREATE', 'CREATE TABLE x (a)'],
    ['PRAGMA', 'PRAGMA foreign_keys = OFF'],
  ])('denies %s on the write path', async (_label, sql) => {
    await prepare();
    await expect(d1().run(sql)).rejects.toThrow(/^plugin_dynamic_resource_sql_denied$/u);
  });
  it('denies writes to a read-only resource before touching the binding', async () => {
    world = createResourceWorld();
    props = await propsFor('d1', 'read_only');
    insertResource(world.runner, props);
    await expect(
      d1({ access: 'read_only' }).run("INSERT INTO plugin_state VALUES ('a', 'x')")
    ).rejects.toThrow(/^plugin_dynamic_resource_write_denied$/u);
    expect(world.resourceCalls).toEqual([]);
  });
  it('still serves reads on a read-only resource', async () => {
    world = createResourceWorld();
    props = await propsFor('d1', 'read_only');
    insertResource(world.runner, props);
    await expect(d1({ access: 'read_only' }).all('SELECT 1 AS one')).resolves.toEqual({
      results: [{ one: 1 }],
    });
  });
  it('validates the statement and parameters on the write path too', async () => {
    await expect(d1().run(5)).rejects.toThrow(/^plugin_dynamic_resource_sql_invalid$/u);
    await expect(d1().run("INSERT INTO plugin_state VALUES ('a', 'x')", 'x')).rejects.toThrow(
      /^plugin_dynamic_resource_params_invalid$/u
    );
  });
  describe('driver answers', () => {
    const answer = (value: unknown) => {
      world = createResourceWorld();
      (world.env as unknown as Record<string, unknown>)[HOST.d1] = {
        prepare: () => undefined,
        withSession: () => ({ prepare: () => ({ bind: () => ({ run: async () => value }) }) }),
      };
      insertResource(world.runner, props);
      return d1().run("DELETE FROM plugin_state WHERE id = 'a'");
    };
    const FAILED = /^plugin_dynamic_resource_query_failed$/u;
    it('reads a missing change count as zero and numeric strings as numbers', async () => {
      await expect(answer({ success: true })).resolves.toEqual({ changes: 0 });
      await expect(answer({ success: true, meta: {} })).resolves.toEqual({ changes: 0 });
      await expect(answer({ success: true, meta: { changes: '3' } })).resolves.toEqual({
        changes: 3,
      });
      await expect(answer({ success: true, meta: { changes: 0 } })).resolves.toEqual({
        changes: 0,
      });
    });
    it.each([
      ['an unsuccessful run', { success: false, meta: { changes: 1 } }],
      ['a negative count', { success: true, meta: { changes: -1 } }],
      ['a fractional count', { success: true, meta: { changes: 1.5 } }],
      ['an unreadable count', { success: true, meta: { changes: 'x' } }],
      ['an unsafe count', { success: true, meta: { changes: 2 ** 53 } }],
    ])('rejects %s', async (_label, value) => {
      await expect(answer(value)).rejects.toThrow(FAILED);
    });
    it('propagates a storage failure unchanged', async () => {
      world = createResourceWorld();
      (world.env as unknown as Record<string, unknown>)[HOST.d1] = {
        prepare: () => undefined,
        withSession: () => ({
          prepare: () => ({ bind: () => ({ run: () => rejectOpaque(new Error('disk full')) }) }),
        }),
      };
      insertResource(world.runner, props);
      await expect(d1().run("DELETE FROM plugin_state WHERE id = 'a'")).rejects.toThrow(
        /^disk full$/u
      );
    });
  });
});
