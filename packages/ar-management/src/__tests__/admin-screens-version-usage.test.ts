import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { openCoreStore } from './helpers/core-schema-sqlite';
import type { SQLiteDatabase } from './test-sqlite';

/**
 * Screens against real SQL: the version a change must name (If-Match), and where a screen is
 * used (flow drafts and published versions, account pages), which blocks its deletion.
 */
const state = vi.hoisted(() => ({
  adapter: null as unknown as DatabaseAdapter,
  loginUi: null as string | null,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: state.adapter })),
    createAuditLogFromContext: vi.fn(async () => undefined),
    getLogger: vi.fn(() => ({
      module: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })),
    })),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
  };
});

import {
  adminScreenCreateHandler,
  adminScreenDeleteHandler,
  adminScreenGetHandler,
  adminScreensListHandler,
  adminScreenUpdateHandler,
} from '../admin-screens';
import { flowUsages, screenRefsInFlowDocument } from '../admin-screen-usage';

const MIGRATION = new URL(
  '../../../../migrations/core/d1/004_screens_version.sql',
  import.meta.url
);

let db: SQLiteDatabase;
/** The tenant's creation-time settings copy (AUTHRIM_CONFIG), or null. */
const legacyConfig = { value: null as string | null };

interface Call {
  id?: string;
  body?: Record<string, unknown>;
  ifMatch?: string;
}

function context({ id, body, ifMatch }: Call = {}) {
  const headers = new Map<string, string>();
  return {
    env: {
      SETTINGS: { get: vi.fn(async () => state.loginUi) },
      AUTHRIM_CONFIG: { get: vi.fn(async () => legacyConfig.value) },
    },
    header: vi.fn((name: string, value: string) => headers.set(name.toLowerCase(), value)),
    headers,
    req: {
      json: vi.fn(async () => body ?? {}),
      param: vi.fn(() => id),
      header: vi.fn((name: string) => (name.toLowerCase() === 'if-match' ? ifMatch : undefined)),
    },
    json: vi.fn(
      (payload: unknown, status?: number) =>
        new Response(JSON.stringify(payload), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        })
    ),
  };
}

async function call(
  handler: (c: never) => Promise<Response>,
  input: Call = {}
): Promise<{ status: number; body: Record<string, unknown>; etag?: string }> {
  const c = context(input);
  const response = await handler(c as never);
  return {
    status: response.status,
    body: await response.json<Record<string, unknown>>(),
    etag: c.headers.get('etag'),
  };
}

const field = { field: 'given_name', label: 'Given name', required: false };

async function createScreen(key: string): Promise<{ id: string; version: number }> {
  const created = await call(adminScreenCreateHandler, {
    body: {
      screen_key: key,
      display_name: `Screen ${key}`,
      screen_kind: 'profile_completion',
      fields: [field],
    },
  });
  expect(created.status).toBe(201);
  const screen = created.body.screen as { id: string; version: number };
  return screen;
}

function insertFlow(input: {
  id: string;
  name: string;
  draft?: unknown;
  published?: unknown;
  deleted?: boolean;
}) {
  const versionId = input.published ? `${input.id}-v1` : null;
  db.prepare(
    `INSERT INTO flows (id, tenant_id, profile_id, name, graph_definition, created_at, updated_at,
                        display_name, draft_editor_json, published_version_id, deleted_at)
     VALUES (?, 'tenant-a', 'human-basic', ?, '{}', 1, 1, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.name,
    input.name,
    input.draft ? JSON.stringify(input.draft) : null,
    versionId,
    input.deleted ? 5 : null
  );
  if (versionId) {
    db.prepare(
      `INSERT INTO flow_versions (id, tenant_id, flow_id, version_number, schema_version,
                                  runtime_snapshot_json, validation_result_json, published_at,
                                  created_at)
       VALUES (?, 'tenant-a', ?, 1, '1', ?, '{}', 1, 1)`
    ).run(versionId, input.id, JSON.stringify(input.published));
  }
}

const editorNode = (id: string, title: string, screenRef: string) => ({
  nodes: [{ id, type: 'screen', title, config: { screen_ref: screenRef } }],
});
const runtimeStep = (nodeId: string, screenRef: string) => ({
  ui: {
    steps: [
      {
        id: `${nodeId}:step`,
        source_node_id: nodeId,
        component: 'screen',
        config: { screen_ref: screenRef },
      },
    ],
  },
});

beforeEach(() => {
  const store = openCoreStore('tenant-a');
  db = store.db;
  db.exec(readFileSync(MIGRATION, 'utf8'));
  state.adapter = store.adapter;
  state.loginUi = null;
  legacyConfig.value = null;
});

describe('screen versions', () => {
  it('starts at 1 and names it in the ETag', async () => {
    const screen = await createScreen('profile_extra');
    expect(screen.version).toBe(1);
    const read = await call(adminScreenGetHandler, { id: screen.id });
    expect(read.status).toBe(200);
    expect((read.body.screen as { version: number }).version).toBe(1);
    expect(read.etag).toBe('"1"');
  });

  it('requires If-Match on update', async () => {
    const screen = await createScreen('profile_extra');
    const missing = await call(adminScreenUpdateHandler, {
      id: screen.id,
      body: { display_name: 'Renamed' },
    });
    expect(missing.status).toBe(428);
    const unreadable = await call(adminScreenUpdateHandler, {
      id: screen.id,
      ifMatch: '"latest"',
      body: { display_name: 'Renamed' },
    });
    expect(unreadable.status).toBe(400);
  });

  it('raises the version on update and refuses a change made from an older one', async () => {
    const screen = await createScreen('profile_extra');
    const first = await call(adminScreenUpdateHandler, {
      id: screen.id,
      ifMatch: '"1"',
      body: { display_name: 'First' },
    });
    expect(first.status).toBe(200);
    expect((first.body.screen as { version: number }).version).toBe(2);
    expect(first.etag).toBe('"2"');

    // A second admin still on version 1.
    const stale = await call(adminScreenUpdateHandler, {
      id: screen.id,
      ifMatch: '"1"',
      body: { display_name: 'Second' },
    });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain('"current_version":2');
    const row = db.prepare('SELECT display_name, version FROM screens WHERE id = ?').get(screen.id);
    expect(row).toMatchObject({ display_name: 'First', version: 2 });
  });

  it('refuses a key that another screen has', async () => {
    await createScreen('profile_extra');
    const again = await call(adminScreenCreateHandler, {
      body: {
        screen_key: 'profile_extra',
        display_name: 'Again',
        screen_kind: 'profile_completion',
        fields: [field],
      },
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('screen_key_taken');
  });

  it('keeps the built-in keys for the system screens', async () => {
    const taken = await call(adminScreenCreateHandler, {
      body: {
        screen_key: 'profile_completion',
        display_name: 'Mine',
        screen_kind: 'profile_completion',
        fields: [field],
      },
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe('screen_key_taken');
  });

  it('raises the version when a system screen is brought up to date', async () => {
    await call(adminScreensListHandler);
    // An older copy of the system login screen: its localizations are missing.
    db.prepare(
      "UPDATE screens SET localizations_json = '{}' WHERE tenant_id = 'tenant-a' AND screen_key = 'login'"
    ).run();
    await call(adminScreensListHandler);
    const row = db
      .prepare("SELECT version FROM screens WHERE tenant_id = 'tenant-a' AND screen_key = 'login'")
      .get() as { version: number };
    expect(row.version).toBeGreaterThan(1);
  });
});

describe('screen usage', () => {
  it('counts the flows and account pages that use a screen, by id or by key', async () => {
    const screen = await createScreen('profile_extra');
    insertFlow({
      id: 'flow-draft',
      name: 'Onboarding',
      draft: editorNode('ask', 'Ask more', 'profile_extra'),
    });
    insertFlow({
      id: 'flow-live',
      name: 'Live signup',
      published: runtimeStep('collect', screen.id),
    });
    insertFlow({
      id: 'flow-gone',
      name: 'Deleted',
      draft: editorNode('ask', 'Ask more', 'profile_extra'),
      deleted: true,
    });
    state.loginUi = JSON.stringify({
      'login-ui.account_pages': JSON.stringify({
        schema_version: 'authrim.account_pages.v1',
        pages: [
          { id: 'main', name: 'Main', draft: { screens: [{ screen_key: 'profile_extra' }] } },
          { id: 'other', name: 'Other', draft: { screens: [{ screen_key: 'account_profile' }] } },
        ],
      }),
    });

    const list = await call(adminScreensListHandler);
    const listed = (list.body.screens as { id: string; usage: unknown }[]).find(
      (entry) => entry.id === screen.id
    );
    expect(listed?.usage).toEqual({ flows: 2, account_pages: 1 });

    const read = await call(adminScreenGetHandler, { id: screen.id });
    expect(read.body.usages).toEqual([
      {
        kind: 'flow',
        flow_id: 'flow-draft',
        flow_name: 'Onboarding',
        node_id: 'ask',
        node_title: 'Ask more',
        stage: 'draft',
      },
      {
        kind: 'flow',
        flow_id: 'flow-live',
        flow_name: 'Live signup',
        node_id: 'collect',
        node_title: null,
        stage: 'published',
      },
      { kind: 'account_page', page_id: 'main', page_name: 'Main' },
    ]);
  });

  it('refuses to delete a screen in use, and deletes it once nothing uses it', async () => {
    const screen = await createScreen('profile_extra');
    insertFlow({
      id: 'flow-draft',
      name: 'Onboarding',
      draft: editorNode('ask', 'Ask', screen.id),
    });

    const refused = await call(adminScreenDeleteHandler, { id: screen.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('screen_in_use');
    expect((refused.body.usages as unknown[]).length).toBe(1);
    expect(db.prepare('SELECT id FROM screens WHERE id = ?').get(screen.id)).toBeTruthy();

    db.prepare("UPDATE flows SET deleted_at = 9 WHERE id = 'flow-draft'").run();
    const stale = await call(adminScreenDeleteHandler, { id: screen.id, ifMatch: '"7"' });
    expect(stale.status).toBe(409);
    const deleted = await call(adminScreenDeleteHandler, { id: screen.id, ifMatch: '"1"' });
    expect(deleted.status).toBe(200);
    expect(db.prepare('SELECT id FROM screens WHERE id = ?').get(screen.id)).toBeUndefined();
  });
});

describe('screen usage while sign-ins are in progress', () => {
  it('counts an older published version that a sign-in in progress still runs', async () => {
    const screen = await createScreen('profile_extra');
    // v1 showed the screen; v2 (now published) and the draft no longer do.
    insertFlow({ id: 'flow-1', name: 'Signup', published: runtimeStep('other', 'consent') });
    db.prepare(
      `INSERT INTO flow_versions (id, tenant_id, flow_id, version_number, schema_version,
                                  runtime_snapshot_json, validation_result_json, published_at,
                                  created_at)
       VALUES ('flow-1-old', 'tenant-a', 'flow-1', 0, '1', ?, '{}', 1, 1)`
    ).run(JSON.stringify(runtimeStep('collect', screen.id)));
    const interaction = (state: string, expiresAt: number) =>
      db
        .prepare(
          `INSERT INTO flow_interactions (id, tenant_id, flow_id, flow_version_id, state,
                                          contract_hash, signature, expires_at, created_at,
                                          updated_at)
           VALUES (?, 'tenant-a', 'flow-1', 'flow-1-old', ?, 'h', 's', ?, 1, 1)`
        )
        .run(`i-${state}-${expiresAt}`, state, expiresAt);
    const now = Math.floor(Date.now() / 1000);
    // Finished or expired sign-ins do not keep the old version in use.
    interaction('completed', now + 600);
    interaction('active', now - 10);
    expect((await call(adminScreenGetHandler, { id: screen.id })).body.usages).toEqual([]);

    interaction('active', now + 600);
    const read = await call(adminScreenGetHandler, { id: screen.id });
    expect(read.body.usages).toEqual([
      {
        kind: 'flow',
        flow_id: 'flow-1',
        flow_name: 'Signup',
        node_id: 'collect',
        node_title: null,
        stage: 'running',
      },
    ]);
    expect((await call(adminScreenDeleteHandler, { id: screen.id })).status).toBe(409);
  });

  it('does not delete a screen when a flow document cannot be read', async () => {
    const screen = await createScreen('profile_extra');
    db.prepare(
      `INSERT INTO flows (id, tenant_id, profile_id, name, graph_definition, created_at, updated_at,
                          draft_editor_json)
       VALUES ('flow-broken', 'tenant-a', 'human-basic', 'Broken', '{}', 1, 1, '{not json')`
    ).run();
    const refused = await call(adminScreenDeleteHandler, { id: screen.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('screen_usage_unknown');
    const read = await call(adminScreenGetHandler, { id: screen.id });
    expect(read.body.usages_complete).toBe(false);
    expect((await call(adminScreensListHandler)).body.usages_complete).toBe(false);
  });

  it('finds a reference in a step config written as a JSON string', async () => {
    const screen = await createScreen('profile_extra');
    insertFlow({
      id: 'flow-1',
      name: 'Signup',
      published: {
        ui: {
          steps: [
            {
              id: 'collect:step',
              source_node_id: 'collect',
              component: 'screen',
              config: JSON.stringify({ screen_ref: 'profile_extra' }),
            },
          ],
        },
      },
    });
    const read = await call(adminScreenGetHandler, { id: screen.id });
    expect(read.body.usages).toHaveLength(1);
  });

  it('reads account pages from the creation-time copy when nothing else has them', async () => {
    const screen = await createScreen('profile_extra');
    legacyConfig.value = JSON.stringify({
      'login-ui.account_pages': JSON.stringify({
        pages: [
          { id: 'main', name: 'Main', draft: { screens: [{ screen_key: 'profile_extra' }] } },
        ],
      }),
    });
    const read = await call(adminScreenGetHandler, { id: screen.id });
    expect(read.body.usages).toEqual([
      { kind: 'account_page', page_id: 'main', page_name: 'Main' },
    ]);
  });
});

describe('flow references', () => {
  it('takes basic_profile as a use of the built-in keys it falls back to', () => {
    const { usages } = flowUsages(
      [
        {
          id: 'flow-1',
          name: 'Flow',
          display_name: null,
          graph_definition: null,
          compiled_plan: null,
          draft_editor_json: JSON.stringify(editorNode('ask', 'Ask', 'basic_profile')),
          draft_runtime_base_json: null,
          runtime_snapshot_json: null,
          editor_snapshot_json: null,
        },
      ],
      [
        { id: 'screen-1', screen_key: 'profile_completion' },
        { id: 'screen-2', screen_key: 'profile_extra' },
      ]
    );
    expect(usages.get('screen-1')).toHaveLength(1);
    expect(usages.get('screen-2')).toEqual([]);
  });

  it('takes the node a reference sits in, and counts a node once per stage', () => {
    const draft = editorNode('ask', 'Ask more', 'profile_extra');
    expect(screenRefsInFlowDocument(draft)).toEqual([
      { ref: 'profile_extra', nodeId: 'ask', nodeTitle: 'Ask more' },
    ]);
    const usages = flowUsages(
      [
        {
          id: 'flow-1',
          name: 'Flow',
          display_name: null,
          graph_definition: null,
          compiled_plan: null,
          // The editor document and the runtime base name the same node.
          draft_editor_json: JSON.stringify(draft),
          draft_runtime_base_json: JSON.stringify(runtimeStep('ask', 'profile_extra')),
          runtime_snapshot_json: null,
          editor_snapshot_json: null,
        },
      ],
      [{ id: 'screen-1', screen_key: 'profile_extra' }]
    );
    expect(usages.complete).toBe(true);
    expect(usages.usages.get('screen-1')).toHaveLength(1);
  });

  it('marks the result incomplete when a document is not JSON', () => {
    const usages = flowUsages(
      [
        {
          id: 'flow-1',
          name: 'Flow',
          display_name: null,
          graph_definition: '{not json',
          compiled_plan: null,
          draft_editor_json: null,
          draft_runtime_base_json: null,
          runtime_snapshot_json: null,
          editor_snapshot_json: null,
        },
      ],
      [{ id: 'screen-1', screen_key: 'profile_extra' }]
    );
    expect(usages.complete).toBe(false);
    expect(usages.usages.get('screen-1')).toEqual([]);
  });
});
