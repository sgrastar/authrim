import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { openCoreStore } from './helpers/core-schema-sqlite';
import type { SQLiteDatabase } from './test-sqlite';

/**
 * The screen parts a save accepts, against real SQL: the choice and checkbox parts, the answers
 * that are not stored to the profile, and what the tenant's Identity Schema allows them to answer.
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
  adminScreenGetHandler,
  adminScreenUpdateHandler,
} from '../admin-screens';

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

function addAttribute(
  key: string,
  type: string,
  options: { cardinality?: 'single' | 'multi'; active?: boolean; rules?: unknown } = {}
) {
  db.prepare(
    `INSERT INTO custom_claim_schemas (id, tenant_id, field_key, display_label, field_type,
                                       is_active, validation_rules, cardinality, created_at, updated_at)
     VALUES (?, 'tenant-a', ?, ?, ?, ?, ?, ?, 1, 1)`
  ).run(
    `s-${key}`,
    key,
    key,
    type,
    options.active === false ? 0 : 1,
    options.rules === undefined ? null : JSON.stringify(options.rules),
    options.cardinality ?? 'single'
  );
}

function save(fields: unknown[], extra: Record<string, unknown> = {}) {
  return call(adminScreenCreateHandler, {
    body: {
      screen_key: `s_${Math.random().toString(36).slice(2, 10)}`,
      display_name: 'A screen',
      screen_kind: 'profile_completion',
      fields,
      ...extra,
    },
  });
}

const savedFields = (result: { body: Record<string, unknown> }) =>
  (result.body.screen as { fields: Array<Record<string, unknown>> }).fields;

beforeEach(() => {
  const store = openCoreStore('tenant-a');
  db = store.db;
  db.exec(readFileSync(MIGRATION, 'utf8'));
  state.adapter = store.adapter;
  state.loginUi = null;
  legacyConfig.value = null;
  addAttribute('department', 'enum', { rules: { enum_values: ['Sales', 'Engineering'] } });
  addAttribute('newsletter', 'boolean');
  addAttribute('skills', 'enum', { cardinality: 'multi', rules: { enum_values: ['a', 'b'] } });
  addAttribute('retired_choice', 'enum', { active: false, rules: { enum_values: ['x'] } });
});

describe('choice and checkbox parts stored to the profile', () => {
  it('saves a select, a radio and a checkbox on attributes of their type', async () => {
    const result = await save([
      { field: 'department', label: 'Department', block_type: 'select', required: true },
      { field: 'field.canonical.department', label: 'Department', block_type: 'radio' },
      { field: 'newsletter', label: 'Newsletter', block_type: 'checkbox', show_label: false },
    ]);
    expect(result.status).toBe(201);
    const fields = savedFields(result);
    expect(fields.map((field) => field.block_type)).toEqual(['select', 'radio', 'checkbox']);
    // Stored to the profile: no options of their own (the Identity Schema has them).
    expect(fields[0]).not.toHaveProperty('options');
    expect(fields[0]).not.toHaveProperty('answer_targets');
    expect(fields[2].show_label).toBe(false);
    expect(fields[0]).not.toHaveProperty('show_label');
  });

  it.each([
    [{ field: 'newsletter', label: 'N', block_type: 'select' }, 'type enum'],
    [{ field: 'department', label: 'D', block_type: 'checkbox' }, 'type boolean'],
    [{ field: 'skills', label: 'S', block_type: 'radio' }, 'multi-valued'],
    [{ field: 'retired_choice', label: 'R', block_type: 'select' }, 'no active attribute'],
    [{ field: 'nowhere', label: 'N', block_type: 'select' }, 'no active attribute'],
    [
      { field: 'department', label: 'D', block_type: 'select', options: [{ value: 'x' }] },
      'Identity Schema',
    ],
    [
      { field: 'department', label: 'D', block_type: 'select', answer_targets: ['record'] },
      'answer_targets',
    ],
  ])('refuses %j', async (part, reason) => {
    const result = await save([part]);
    expect(result.status).toBe(400);
    expect(String(result.body.error_description)).toContain(reason);
  });

  it('refuses a part type it does not know, instead of reading it as a text input', async () => {
    const result = await save([{ field: 'department', label: 'D', block_type: 'slider' }]);
    expect(result.status).toBe(400);
    expect(String(result.body.error_description)).toContain('unknown block_type');
  });

  it('keeps the legacy yes/no text input as it is (the run time reads both forms)', async () => {
    const result = await save([
      { field: 'newsletter', label: 'Newsletter', value_type: 'boolean', required: false },
    ]);
    expect(result.status).toBe(201);
    expect(savedFields(result)[0]).toMatchObject({
      block_type: 'identity_field',
      value_type: 'boolean',
    });
  });
});

describe('an attribute with an inactive row beside its active one', () => {
  it('reads the active row for a part, and every row for an answer of its own', async () => {
    db.prepare(
      `INSERT INTO custom_claim_schemas (id, tenant_id, field_key, display_label, field_type,
                                         is_active, cardinality, created_at, updated_at)
       VALUES ('s-department-old', 'tenant-a', 'department', 'department', 'string', 0, 'single', 2, 2)`
    ).run();
    db.exec('ANALYZE');
    const part = await save([{ field: 'department', label: 'D', block_type: 'select' }]);
    expect(part.status).toBe(201);
    db.prepare(
      `INSERT INTO custom_claim_schemas (id, tenant_id, field_key, display_label, field_type,
                                         is_active, cardinality, created_at, updated_at)
       VALUES ('s-gone', 'tenant-a', 'gone_attr', 'gone_attr', 'string', 0, 'single', 2, 2)`
    ).run();
    const answer = await save([
      {
        field: 'gone_attr',
        label: 'G',
        block_type: 'checkbox',
        store_to_profile: false,
        answer_targets: ['record'],
      },
    ]);
    expect(answer.status).toBe(400);
    expect(String(answer.body.error_description)).toContain("an attribute's key");
  });
});

describe('answers not stored to the profile', () => {
  const survey = {
    field: 'heard_from',
    label: 'How did you hear of us?',
    block_type: 'radio',
    store_to_profile: false,
    answer_targets: ['record', 'flow_event', 'record'],
    options: [
      { value: 'friend', label: 'A friend' },
      { value: ' web ', label: '' },
    ],
  };

  it('saves a part with its own options and where its answer goes', async () => {
    const result = await save([survey]);
    expect(result.status).toBe(201);
    expect(savedFields(result)[0]).toMatchObject({
      block_type: 'radio',
      store_to_profile: false,
      // Without repeats, in a fixed order.
      answer_targets: ['flow_event', 'record'],
      // Values trimmed; a missing label is the value.
      options: [
        { value: 'friend', label: 'A friend' },
        { value: 'web', label: 'web' },
      ],
    });
  });

  it('saves a text input and a checkbox whose answers stay off the profile', async () => {
    const result = await save([
      { field: 'note', label: 'Note', store_to_profile: false, answer_targets: ['record'] },
      {
        field: 'agreed_rules',
        label: 'I agree',
        block_type: 'checkbox',
        store_to_profile: false,
        answer_targets: ['flow_event'],
      },
    ]);
    expect(result.status).toBe(201);
    expect(savedFields(result).map((field) => field.store_to_profile)).toEqual([false, false]);
  });

  it.each([
    [{ ...survey, answer_targets: [] }, 'answer_targets'],
    [{ ...survey, answer_targets: ['webhook'] }, 'answer_targets'],
    [{ ...survey, options: [] }, 'at least one choice'],
    [{ ...survey, options: [{ value: 'a' }, { value: 'a' }] }, 'listed twice'],
    [{ ...survey, options: [{ value: 'x'.repeat(129) }] }, 'at most 128'],
    [{ ...survey, options: [{ value: 'a', label: 'x'.repeat(101) }] }, 'at most 100'],
    [
      { ...survey, options: Array.from({ length: 101 }, (_, i) => ({ value: `v${i}` })) },
      'at most 100 options',
    ],
    [{ ...survey, field: 'department' }, "an attribute's key"],
    [{ ...survey, field: 'email' }, "standard claim's name"],
    [{ ...survey, field: 'sub' }, "standard claim's name"],
    [{ ...survey, field: 'iss' }, "standard claim's name"],
    [{ ...survey, field: 'auth_time' }, "standard claim's name"],
    [{ ...survey, field: 'verified_claims' }, "standard claim's name"],
    [{ ...survey, field: 'authrim_flag' }, "standard claim's name"],
    [{ ...survey, field: 'profile.nickname' }, 'must be a letter'],
    [
      {
        field: 'agreed',
        label: 'A',
        block_type: 'checkbox',
        store_to_profile: false,
        answer_targets: ['record'],
        options: [{ value: 'yes' }],
      },
      'only a select or radio',
    ],
  ])('refuses %j', async (part, reason) => {
    const result = await save([part]);
    expect(result.status).toBe(400);
    expect(String(result.body.error_description)).toContain(reason);
  });

  it.each([
    [
      'an attribute first',
      [
        { field: 'survey', label: 'S' },
        { ...survey, field: 'survey' },
      ],
    ],
    [
      'the answer first',
      [
        { ...survey, field: 'survey' },
        { field: 'survey', label: 'S' },
      ],
    ],
    [
      'the canonical spelling',
      [
        { field: 'field.canonical.survey', label: 'S' },
        { ...survey, field: 'survey' },
      ],
    ],
  ])(
    'refuses an answer that shares its key with an attribute the screen asks (%s)',
    async (_, parts) => {
      const result = await save(parts);
      expect(result.status).toBe(400);
      expect(String(result.body.error_description)).toContain('shares its key');
    }
  );

  it('refuses two parts that answer under the same key, in any case', async () => {
    const result = await save([survey, { ...survey, field: 'Heard_From', block_type: 'select' }]);
    expect(result.status).toBe(400);
    expect(String(result.body.error_description)).toContain('same answer key');
  });

  it('refuses two parts that answer under the same key', async () => {
    const result = await save([survey, { ...survey, block_type: 'select' }]);
    expect(result.status).toBe(400);
    expect(String(result.body.error_description)).toContain('same answer key');
  });

  it('checks a change of the parts as it checks a new screen', async () => {
    const created = await save([{ field: 'given_name', label: 'Given name' }]);
    const screen = created.body.screen as { id: string; version: number };
    const refused = await call(adminScreenUpdateHandler, {
      id: screen.id,
      ifMatch: `"${screen.version}"`,
      body: { fields: [{ field: 'newsletter', label: 'N', block_type: 'select' }] },
    });
    expect(refused.status).toBe(400);
    expect(String(refused.body.error_description)).toContain('type enum');
    const saved = await call(adminScreenUpdateHandler, {
      id: screen.id,
      ifMatch: `"${screen.version}"`,
      body: { fields: [survey] },
    });
    expect(saved.status).toBe(200);
  });
});

describe("translations of a part's own options", () => {
  it('keeps the labels by option value, and drops what is not a label', async () => {
    const result = await save(
      [
        {
          ...{ field: 'heard_from', label: 'H', block_type: 'select' },
          store_to_profile: false,
          answer_targets: ['record'],
          options: [{ value: 'friend' }],
          block_id: 'b1',
        },
      ],
      {
        localizations: {
          ja: {
            fields: {
              b1: {
                label: '知ったきっかけ',
                options: { friend: ' 友人 ', web: '', ['__proto__']: 'x', other: 7 },
              },
            },
          },
        },
      }
    );
    expect(result.status).toBe(201);
    const localizations = (result.body.screen as { localizations: Record<string, unknown> })
      .localizations;
    expect(localizations).toEqual({
      ja: { fields: { b1: { label: '知ったきっかけ', options: { friend: '友人' } } } },
    });
  });
});

describe('reading a stored screen', () => {
  it('opens a screen saved before the checks, reading an unknown part as a text input', async () => {
    const created = await save([{ field: 'given_name', label: 'Given name' }]);
    const screen = created.body.screen as { id: string };
    db.prepare('UPDATE screens SET fields_json = ? WHERE id = ?').run(
      JSON.stringify([{ field: 'old', label: 'Old', block_type: 'slider' }]),
      screen.id
    );
    const read = await call(adminScreenGetHandler, { id: screen.id });
    expect(read.status).toBe(200);
    expect(savedFields(read)[0]).toMatchObject({ field: 'old', block_type: 'identity_field' });
  });
});
