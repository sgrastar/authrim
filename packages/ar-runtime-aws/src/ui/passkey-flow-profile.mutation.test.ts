/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- fakes and deliberately malformed inputs are intentionally untyped */
import { describe, expect, it, vi } from 'vitest';
import {
  assertPasskeyOnlySamlFlowReady,
  assertPasskeyOnlySamlRuntimeProfile,
} from './passkey-flow-profile';

type Json = Record<string, any>;
const UNSUPPORTED = 'aws_login_flow_profile_unsupported';

const entry = (): Json => ({
  id: 'step-entry',
  source_node_id: 'node-entry',
  component: 'interaction_context',
  render: false,
});
const auth = (): Json => ({
  id: 'step-auth',
  source_node_id: 'node-auth',
  component: 'authentication_method_selector',
  render: true,
  config: { output_handles: ['passkey'] },
});
const completion = (): Json => ({
  id: 'step-done',
  source_node_id: 'node-done',
  component: 'completion',
});
const runtime3 = (): Json => ({
  flow_kind: 'login',
  capabilities: [],
  ui: { steps: [entry(), auth(), completion()] },
});
const runtime2 = (): Json => ({
  flow_kind: 'login',
  ui: { steps: [auth(), completion()] },
});
const accepts = (value: unknown) =>
  expect(() => assertPasskeyOnlySamlRuntimeProfile(value)).not.toThrow();
const rejects = (value: unknown) =>
  expect(() => assertPasskeyOnlySamlRuntimeProfile(value)).toThrow(UNSUPPORTED);
const edit = (base: () => Json, change: (r: Json) => void): Json => {
  const r = base();
  change(r);
  return r;
};

describe('passkey-only runtime profile (mutation hardening)', () => {
  it('accepts both supported shapes', () => {
    accepts(runtime3());
    accepts(runtime2());
    accepts(edit(runtime3, (r) => delete r.capabilities));
    accepts(edit(runtime3, (r) => (r.capabilities = {})));
    accepts(edit(runtime3, (r) => (r.runtime_bindings = {})));
    accepts(edit(runtime3, (r) => (r.ui.steps[0].content = {})));
    accepts(edit(runtime3, (r) => (r.ui.steps[0].config = {})));
    accepts(edit(runtime3, (r) => (r.ui.steps[0].bindings = {})));
    accepts(edit(runtime3, (r) => (r.ui.steps[1].config.on_cancel = 'stay')));
    accepts(edit(runtime3, (r) => (r.ui.steps[1].config.on_cancel = 'error')));
    accepts(
      edit(runtime3, (r) => (r.ui.steps[2].config = { completion_block: { protocol: 'saml' } }))
    );
    accepts(edit(runtime3, (r) => (r.ui.steps[2].config = {})));
    accepts(edit(runtime3, (r) => (r.ui.steps[2].config = { completion_block: undefined })));
    accepts(edit(runtime3, (r) => (r.ui.steps[1].capability_ids = [])));
  });

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'x'],
    ['number', 5],
    ['empty object', {}],
    ['other flow kind', { ...runtime3(), flow_kind: 'register' }],
    ['no flow kind', edit(runtime3, (r) => delete r.flow_kind)],
    ['no ui', edit(runtime3, (r) => delete r.ui)],
    ['ui array', edit(runtime3, (r) => (r.ui = []))],
    ['steps object', edit(runtime3, (r) => (r.ui.steps = {}))],
    ['no steps', edit(runtime3, (r) => (r.ui.steps = undefined))],
    ['0 steps', edit(runtime3, (r) => (r.ui.steps = []))],
    ['1 step', edit(runtime3, (r) => (r.ui.steps = [auth()]))],
    ['4 steps', edit(runtime3, (r) => r.ui.steps.push(completion()))],
  ])('rejects %s', (_name, value) => rejects(value));

  it('requires empty capabilities and runtime bindings', () => {
    for (const capabilities of [['x'], [1], { a: 1 }, 'x', null, 5])
      rejects(edit(runtime3, (r) => (r.capabilities = capabilities)));
    for (const bindings of [{ a: 1 }, [], null, 'x', 0, ['x']])
      rejects(edit(runtime3, (r) => (r.runtime_bindings = bindings)));
  });

  it('requires every step to be an object with no capability ids', () => {
    for (const bad of [null, 'x', 5, []]) {
      rejects(edit(runtime3, (r) => (r.ui.steps[0] = bad)));
      rejects(edit(runtime3, (r) => (r.ui.steps[1] = bad)));
      rejects(edit(runtime3, (r) => (r.ui.steps[2] = bad)));
      rejects(edit(runtime2, (r) => (r.ui.steps[0] = bad)));
      rejects(edit(runtime2, (r) => (r.ui.steps[1] = bad)));
    }
    for (const ids of [['x'], 'x', null, {}, 0, [[]]])
      for (const index of [0, 1, 2])
        rejects(edit(runtime3, (r) => (r.ui.steps[index].capability_ids = ids)));
  });

  it('pins the entry step', () => {
    const patches: Array<(s: Json) => void> = [
      (s) => (s.component = 'other'),
      (s) => delete s.component,
      (s) => (s.render = true),
      (s) => delete s.render,
      (s) => (s.render = 'false'),
      (s) => (s.content = { a: 1 }),
      (s) => (s.content = null),
      (s) => (s.config = { a: 1 }),
      (s) => (s.config = []),
      (s) => (s.bindings = { a: 1 }),
      (s) => (s.bindings = 'x'),
    ];
    for (const patch of patches) rejects(edit(runtime3, (r) => patch(r.ui.steps[0])));
  });

  it('pins the authentication step in both shapes', () => {
    const patches: Array<(s: Json) => void> = [
      (s) => (s.component = 'completion'),
      (s) => delete s.component,
      (s) => (s.render = false),
      (s) => delete s.render,
      (s) => (s.render = 1),
      (s) => (s.content = { a: 1 }),
      (s) => (s.content = []),
      (s) => (s.bindings = { a: 1 }),
      (s) => (s.bindings = null),
    ];
    for (const patch of patches) {
      rejects(edit(runtime3, (r) => patch(r.ui.steps[1])));
      rejects(edit(runtime2, (r) => patch(r.ui.steps[0])));
    }
  });

  it('pins the completion step in both shapes', () => {
    const patches: Array<(s: Json) => void> = [
      (s) => (s.component = 'authentication_method_selector'),
      (s) => delete s.component,
      (s) => (s.content = { a: 1 }),
      (s) => (s.content = null),
      (s) => (s.bindings = { a: 1 }),
      (s) => (s.bindings = 'x'),
    ];
    for (const patch of patches) {
      rejects(edit(runtime3, (r) => patch(r.ui.steps[2])));
      rejects(edit(runtime2, (r) => patch(r.ui.steps[1])));
    }
    // the entry step is only consulted for three-step flows
    rejects(edit(runtime2, (r) => (r.ui.steps = [entry(), auth()])));
  });

  it('allows only output_handles and on_cancel in the selector config', () => {
    const patches: Array<(c: Json | undefined, s: Json) => void> = [
      (_c, s) => delete s.config,
      (_c, s) => (s.config = null),
      (_c, s) => (s.config = []),
      (_c, s) => (s.config = {}),
      (c) => (c!.extra = 1),
      (c) => (c!.on_cancel = 'other'),
      (c) => (c!.on_cancel = null),
      (c) => (c!.on_cancel = ''),
      (c) => delete c!.output_handles,
      (c) => (c!.output_handles = 'passkey'),
      (c) => (c!.output_handles = []),
      (c) => (c!.output_handles = ['passkey', 'passkey']),
      (c) => (c!.output_handles = ['passkey', 'password']),
      (c) => (c!.output_handles = ['password']),
      (c) => (c!.output_handles = [{ toString: () => 'passkey' }]),
    ];
    for (const patch of patches) {
      rejects(edit(runtime3, (r) => patch(r.ui.steps[1].config, r.ui.steps[1])));
      rejects(edit(runtime2, (r) => patch(r.ui.steps[0].config, r.ui.steps[0])));
    }
  });

  it('allows only a SAML completion block in the completion config', () => {
    for (const config of [
      { other: 1 },
      { completion_block: { protocol: 'saml' }, other: 1 },
      { completion_block: null },
      { completion_block: [] },
      { completion_block: 'saml' },
      { completion_block: {} },
      { completion_block: { protocol: 'oidc' } },
      { completion_block: { protocol: 'SAML' } },
      { completion_block: { protocol: undefined } },
    ]) {
      rejects(edit(runtime3, (r) => (r.ui.steps[2].config = config)));
      rejects(edit(runtime2, (r) => (r.ui.steps[1].config = config)));
    }
    accepts(
      edit(runtime2, (r) => (r.ui.steps[1].config = { completion_block: { protocol: 'saml' } }))
    );
    accepts(edit(runtime3, (r) => (r.ui.steps[2].config = null)));
    accepts(edit(runtime3, (r) => (r.ui.steps[2].config = [])));
  });

  it('requires unique non-empty string step ids and node ids', () => {
    for (const bad of ['', undefined, null, 5, {}, ['a']]) {
      for (const index of [0, 1, 2]) {
        rejects(edit(runtime3, (r) => (r.ui.steps[index].id = bad)));
        rejects(edit(runtime3, (r) => (r.ui.steps[index].source_node_id = bad)));
      }
      rejects(edit(runtime2, (r) => (r.ui.steps[0].id = bad)));
      rejects(edit(runtime2, (r) => (r.ui.steps[1].source_node_id = bad)));
    }
    rejects(edit(runtime3, (r) => (r.ui.steps[1].id = r.ui.steps[0].id)));
    rejects(edit(runtime3, (r) => (r.ui.steps[2].id = r.ui.steps[0].id)));
    rejects(edit(runtime3, (r) => (r.ui.steps[2].source_node_id = r.ui.steps[1].source_node_id)));
    rejects(edit(runtime2, (r) => (r.ui.steps[1].id = r.ui.steps[0].id)));
    rejects(edit(runtime2, (r) => (r.ui.steps[1].source_node_id = r.ui.steps[0].source_node_id)));
    // ids and node ids may coincide with each other
    accepts(edit(runtime2, (r) => (r.ui.steps[0].id = r.ui.steps[0].source_node_id = 'same')));
  });
});

// ---------------------------------------------------------------------------------------------

const ORIGIN = 'https://login.example.test';
const TENANT = 'tenant-a';
const SP = 'https://sp.example.test/entity';

interface World {
  specific?: Record<string, unknown> | null;
  fallback?: Record<string, unknown> | null;
  version?: Record<string, unknown> | null;
  client?: Record<string, unknown> | null;
  origin?: Record<string, unknown> | null;
}
function fakeDb(world: World = {}) {
  const base = {
    specific: { flow_id: 'flow-1', published_version_id: 'ver-1' },
    fallback: null,
    version: {
      runtime_snapshot_json: JSON.stringify(runtime3()),
      editor_snapshot_json: null,
    },
    client: {
      client_id: 'login-ui',
      application_type: 'web',
      allowed_channels: '["browser"]',
      client_secret_hash: null,
      enabled: 1,
    },
    origin: { origin: ORIGIN },
    ...world,
  } as Required<World>;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const queryOne = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("a.target_type = 'saml_sp'")) return base.specific;
    if (sql.includes("a.target_type = 'tenant'")) return base.fallback;
    if (sql.includes('FROM flow_versions')) return base.version;
    if (sql.includes('FROM oauth_clients')) return base.client;
    if (sql.includes('FROM web_origin_registry')) return base.origin;
    throw new Error(`unexpected query ${sql}`);
  });
  return { db: { queryOne } as never, calls, queryOne };
}
const ready = (
  world: World = {},
  sps: readonly string[] = [SP],
  origin = ORIGIN,
  clientId?: string,
  tenant = TENANT
) => assertPasskeyOnlySamlFlowReady(fakeDb(world).db, tenant, sps, origin, clientId);
const editorFor = (nodes: string[], handles: Array<string | undefined>, over: Json = {}): string =>
  JSON.stringify({
    nodes: nodes.map((id) => ({ id })),
    edges: nodes.slice(0, -1).map((source, i) => ({
      source,
      target: nodes[i + 1],
      ...(handles[i] === undefined ? {} : { source_handle: handles[i] }),
    })),
    ...over,
  });
const versionWith = (runtime: Json, editor: string | null) => ({
  runtime_snapshot_json: JSON.stringify(runtime),
  editor_snapshot_json: editor,
});

describe('passkey-only flow readiness (mutation hardening)', () => {
  it('queries the SP assignment, version, client and origin with exact parameters', async () => {
    const { db, calls } = fakeDb();
    await assertPasskeyOnlySamlFlowReady(db, TENANT, [SP], ORIGIN, 'login-ui');
    expect(calls.map((c) => c.params)).toEqual([
      [TENANT, SP],
      [TENANT, 'flow-1', 'ver-1'],
      [TENANT, 'login-ui'],
      [TENANT, 'login-ui', ORIGIN],
    ]);
    expect(calls[0].sql).toContain("a.flow_kind = 'login' AND a.enabled = TRUE");
    expect(calls[0].sql).toContain("f.status = 'published' AND f.deleted_at IS NULL");
    expect(calls[3].sql).toContain('handoff_allowed = 1 AND is_active = 1');
  });

  it('falls back to the tenant default only when no SP-specific flow is assigned', async () => {
    const { db, calls } = fakeDb({
      specific: null,
      fallback: { flow_id: 'flow-d', published_version_id: 'ver-d' },
    });
    await assertPasskeyOnlySamlFlowReady(db, TENANT, [SP], ORIGIN);
    expect(calls.map((c) => c.params)).toEqual([
      [TENANT, SP],
      [TENANT],
      [TENANT, 'flow-d', 'ver-d'],
      [TENANT, 'login-ui'],
      [TENANT, 'login-ui', ORIGIN],
    ]);
    expect(calls[1].sql).toContain('a.target_id IS NULL');
    // a specific assignment is not combined with the fallback
    const specific = fakeDb();
    await assertPasskeyOnlySamlFlowReady(specific.db, TENANT, [SP, `${SP}2`], ORIGIN);
    expect(specific.calls.filter((c) => c.sql.includes("a.target_type = 'tenant'"))).toHaveLength(
      0
    );
    expect(specific.calls.filter((c) => c.sql.includes('FROM flow_versions'))).toHaveLength(2);
  });

  it.each([
    ['no assignment', { specific: null, fallback: null }],
    ['unpublished specific flow', { specific: { flow_id: 'f', published_version_id: null } }],
    ['empty version id', { specific: { flow_id: 'f', published_version_id: '' } }],
  ])('reports a missing assignment: %s', async (_n, world) => {
    await expect(ready(world as World)).rejects.toThrow('aws_login_flow_assignment_missing');
  });

  it('reports a missing flow version and unusable snapshots', async () => {
    await expect(ready({ version: null })).rejects.toThrow('aws_login_flow_version_missing');
    await expect(
      ready({ version: { runtime_snapshot_json: '{bad', editor_snapshot_json: null } })
    ).rejects.toThrow(UNSUPPORTED);
    await expect(ready({ version: versionWith(runtime3(), '{bad') })).rejects.toThrow(UNSUPPORTED);
    await expect(
      ready({
        version: versionWith(
          edit(runtime3, (r) => (r.flow_kind = 'register')),
          null
        ),
      })
    ).rejects.toThrow(UNSUPPORTED);
    // an empty editor snapshot is treated as absent
    await expect(ready({ version: versionWith(runtime3(), '') })).resolves.toBeUndefined();
  });

  it('checks the editor graph against the runtime steps', async () => {
    const three = ['node-entry', 'node-auth', 'node-done'];
    const two = ['node-auth', 'node-done'];
    const ok3 = editorFor(three, ['next', 'passkey']);
    await expect(ready({ version: versionWith(runtime3(), ok3) })).resolves.toBeUndefined();
    await expect(
      ready({ version: versionWith(runtime3(), editorFor(three, [undefined, 'passkey'])) })
    ).resolves.toBeUndefined();
    await expect(
      ready({ version: versionWith(runtime2(), editorFor(two, ['passkey'])) })
    ).resolves.toBeUndefined();
    const bad = async (runtime: Json, editor: string | null) =>
      expect(ready({ version: versionWith(runtime, editor) })).rejects.toThrow(UNSUPPORTED);
    await bad(runtime3(), editorFor(three, ['passkey', 'passkey']));
    await bad(runtime3(), editorFor(three, ['next', 'next']));
    await bad(runtime3(), editorFor(three, ['next', undefined]));
    await bad(runtime3(), editorFor(three, ['next', 'other']));
    await bad(runtime3(), editorFor(three, ['other', 'passkey']));
    await bad(runtime2(), editorFor(two, ['next']));
    await bad(runtime2(), editorFor(two, [undefined]));
    // structure
    await bad(runtime3(), '[]');
    await bad(runtime3(), '"x"');
    await bad(runtime3(), JSON.stringify({ nodes: [], edges: [] }));
    await bad(runtime3(), JSON.stringify({ nodes: three.map((id) => ({ id })) }));
    await bad(runtime3(), JSON.stringify({ edges: [] }));
    await bad(runtime3(), JSON.stringify({ nodes: 'x', edges: [] }));
    await bad(runtime3(), JSON.stringify({ nodes: three.map((id) => ({ id })), edges: 'x' }));
    // node set
    await bad(runtime3(), editorFor(['node-entry', 'node-auth'], ['next']));
    await bad(runtime3(), editorFor([...three, 'extra'], ['next', 'passkey', 'passkey']));
    await bad(runtime3(), editorFor(['node-entry', 'node-auth', 'other'], ['next', 'passkey']));
    await bad(
      runtime3(),
      editorFor(['node-entry', 'node-entry', 'node-done'], ['next', 'passkey'])
    );
    // edges
    await bad(runtime3(), editorFor(three, ['next', 'passkey'], { edges: [] }));
    await bad(
      runtime3(),
      JSON.stringify({ nodes: three.map((id) => ({ id })), edges: [null, null] })
    );
    await bad(
      runtime3(),
      JSON.stringify({
        nodes: three.map((id) => ({ id })),
        edges: [
          { source: 'node-auth', target: 'node-entry', source_handle: 'next' },
          { source: 'node-auth', target: 'node-done', source_handle: 'passkey' },
        ],
      })
    );
    await bad(
      runtime3(),
      JSON.stringify({
        nodes: three.map((id) => ({ id })),
        edges: [
          { source: 'node-entry', target: 'node-done', source_handle: 'next' },
          { source: 'node-auth', target: 'node-done', source_handle: 'passkey' },
        ],
      })
    );
    await bad(
      runtime3(),
      JSON.stringify({
        nodes: three.map((id) => ({ id })),
        edges: [
          { source: 'node-entry', target: 'node-auth', source_handle: 'next' },
          { source: 'node-entry', target: 'node-done', source_handle: 'passkey' },
        ],
      })
    );
    await bad(
      runtime3(),
      JSON.stringify({
        nodes: three.map((id) => ({ id })),
        edges: [
          { source: 'node-entry', target: 'node-auth', source_handle: 'next' },
          { source: 'node-auth', target: 'node-auth', source_handle: 'passkey' },
        ],
      })
    );
  });

  it('validates every SP entity ID', async () => {
    await expect(ready({}, ['a'.repeat(512)])).resolves.toBeUndefined();
    for (const bad of ['', 'a'.repeat(513)])
      await expect(ready({}, [bad])).rejects.toThrow('aws_login_flow_inventory_invalid');
    await expect(ready({}, [SP, ''])).rejects.toThrow('aws_login_flow_inventory_invalid');
  });

  it('validates the inventory, origin and client id before any query', async () => {
    const call = (tenant: string, sps: readonly string[], origin: string, clientId?: string) => {
      const world = fakeDb();
      return {
        run: () => assertPasskeyOnlySamlFlowReady(world.db, tenant, sps, origin, clientId),
        world,
      };
    };
    for (const [args, message] of [
      [['', [SP], ORIGIN], 'aws_login_flow_inventory_invalid'],
      [[TENANT, [], ORIGIN], 'aws_login_flow_inventory_invalid'],
      [[TENANT, [SP, SP], ORIGIN], 'aws_login_flow_inventory_invalid'],
      [[TENANT, [SP], 'http://login.example.test'], 'aws_login_flow_inventory_invalid'],
      [[TENANT, [SP], `${ORIGIN}/`], 'aws_login_flow_inventory_invalid'],
      [[TENANT, [SP], `${ORIGIN}/path`], 'aws_login_flow_inventory_invalid'],
      [[TENANT, [SP], 'https://LOGIN.example.test'], 'aws_login_flow_inventory_invalid'],
      [[TENANT, [SP], ORIGIN, ''], 'aws_login_flow_inventory_invalid'],
      [[TENANT, [SP], ORIGIN, 'a'.repeat(129)], 'aws_login_flow_inventory_invalid'],
      [[TENANT, [SP], ORIGIN, 'bad id'], 'aws_login_flow_inventory_invalid'],
      [[TENANT, [SP], ORIGIN, 'bad!'], 'aws_login_flow_inventory_invalid'],
      [[TENANT, [SP], ORIGIN, 'x\n'], 'aws_login_flow_inventory_invalid'],
      [[TENANT, [SP], 'not a url'], 'aws_login_origin_invalid'],
      [[TENANT, [SP], ''], 'aws_login_origin_invalid'],
    ] as Array<[[string, string[], string, string?], string]>) {
      const { run, world } = call(...args);
      await expect(run(), JSON.stringify(args)).rejects.toThrow(message);
      expect(world.queryOne).not.toHaveBeenCalled();
    }
    for (const clientId of ['a', 'a'.repeat(128), 'A_b.c:d-9']) {
      const world = fakeDb({
        client: {
          client_id: clientId,
          application_type: 'web',
          allowed_channels: '["browser"]',
          client_secret_hash: null,
          enabled: 1,
        },
      });
      await expect(
        assertPasskeyOnlySamlFlowReady(world.db, TENANT, [SP], ORIGIN, clientId)
      ).resolves.toBeUndefined();
    }
  });

  it('requires an enabled public web client', async () => {
    const good = {
      client_id: 'login-ui',
      application_type: 'web',
      allowed_channels: '["browser"]',
      client_secret_hash: null,
      enabled: 1,
    };
    for (const patch of [
      null,
      { enabled: 0 },
      { client_id: 'other' },
      { application_type: 'native' },
      { application_type: null },
      { client_secret_hash: 'hash' },
      { client_secret_hash: '' },
    ])
      await expect(
        ready({ client: patch === null ? null : { ...good, ...patch } })
      ).rejects.toThrow('aws_login_client_unavailable');
    for (const patch of [{ enabled: 2 }, { enabled: true }])
      await expect(ready({ client: { ...good, ...patch } })).resolves.toBeUndefined();
  });

  it('requires the browser channel on the client', async () => {
    const client = (allowed_channels: unknown) => ({
      client_id: 'login-ui',
      application_type: 'web',
      allowed_channels,
      client_secret_hash: null,
      enabled: 1,
    });
    for (const value of [null, '', undefined])
      await expect(ready({ client: client(value) })).rejects.toThrow(
        'aws_login_client_channel_unavailable'
      );
    for (const value of ['{bad', 'browser', '[', '["browser"'])
      await expect(ready({ client: client(value) })).rejects.toThrow(
        'aws_login_client_channels_invalid'
      );
    for (const value of [
      '{"browser":true}',
      '"browser"',
      '5',
      'null',
      '[]',
      '["native"]',
      '["Browser"]',
    ])
      await expect(ready({ client: client(value) })).rejects.toThrow(
        'aws_login_client_channel_unavailable'
      );
    await expect(ready({ client: client('["native","browser"]') })).resolves.toBeUndefined();
  });

  it('requires an active handoff-approved origin registration for exactly this origin', async () => {
    for (const origin of [
      null,
      { origin: 'https://other.example.test' },
      {},
      { origin: `${ORIGIN}/` },
    ])
      await expect(ready({ origin })).rejects.toThrow('aws_login_origin_unavailable');
  });
});
