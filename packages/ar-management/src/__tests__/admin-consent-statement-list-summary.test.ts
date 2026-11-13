import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { openCoreStore } from './helpers/core-schema-sqlite';

const state = vi.hoisted(() => ({
  metadata: null as DatabaseAdapter | null,
  tenantId: 'tenant-a',
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => state.tenantId,
  createAuthContextFromHono: () => ({ coreAdapter: state.metadata }),
  getLogger: () => ({ module: () => ({ error: vi.fn(), info: vi.fn() }) }),
}));

import { adminConsentStatementsListHandler } from '../admin-consent-statements';

const stores: ReturnType<typeof openCoreStore>[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.db.close();
  state.tenantId = 'tenant-a';
});
const context = () =>
  ({ json: (value: unknown, status = 200) => Response.json(value, { status }) }) as never;

describe('consent statement list summary', () => {
  it('adds the current version, draft presence and the shown titles in one response', async () => {
    const store = openCoreStore();
    stores.push(store);
    state.metadata = store.adapter;
    const db = store.db;
    const statement = db.prepare(
      `INSERT INTO consent_statements (id, tenant_id, slug, display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1)`
    );
    statement.run('st-published', 'tenant-a', 'tos', 0);
    statement.run('st-draft', 'tenant-a', 'news', 1);
    statement.run('st-empty', 'tenant-a', 'empty', 2);
    statement.run('st-other', 'tenant-b', 'other', 0);
    const version = db.prepare(
      `INSERT INTO consent_statement_versions (id, tenant_id, statement_id, version, effective_at,
         is_current, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1)`
    );
    version.run('v-old', 'tenant-a', 'st-published', '20260101', 0, 'archived', 1);
    version.run('v-cur', 'tenant-a', 'st-published', '20260201', 1, 'active', 2);
    version.run('v-next', 'tenant-a', 'st-published', '20260301', 0, 'draft', 3);
    version.run('v-d1', 'tenant-a', 'st-draft', '20260101', 0, 'draft', 1);
    version.run('v-d2', 'tenant-a', 'st-draft', '20260102', 0, 'draft', 2);
    version.run('v-other', 'tenant-b', 'st-other', '20260101', 1, 'active', 1);
    const localization = db.prepare(
      `INSERT INTO consent_statement_localizations (id, tenant_id, version_id, language, title,
         description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', 1, 1)`
    );
    localization.run('l1', 'tenant-a', 'v-cur', 'ja', '利用規約');
    localization.run('l2', 'tenant-a', 'v-cur', 'en', 'Terms');
    localization.run('l3', 'tenant-a', 'v-next', 'en', 'Terms (next)');
    localization.run('l4', 'tenant-a', 'v-d1', 'en', 'Old draft');
    localization.run('l5', 'tenant-a', 'v-d2', 'en', 'News');
    localization.run('l6', 'tenant-b', 'v-other', 'en', 'Other tenant');

    const response = await adminConsentStatementsListHandler(context());
    const body = await response.json<{
      statements: {
        id: string;
        current_version: { id: string } | null;
        has_draft: boolean;
        titles: Record<string, string>;
      }[];
    }>();
    expect(
      body.statements.map(({ id, current_version, has_draft, titles }) => ({
        id,
        current: current_version?.id ?? null,
        has_draft,
        titles,
      }))
    ).toEqual([
      {
        id: 'st-published',
        current: 'v-cur',
        has_draft: true,
        titles: { ja: '利用規約', en: 'Terms' },
      },
      { id: 'st-draft', current: null, has_draft: true, titles: { en: 'News' } },
      { id: 'st-empty', current: null, has_draft: false, titles: {} },
    ]);
  });
});
