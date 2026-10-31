/** Actual migrated SQLite, screen/decision helpers and DELETE handler; no SQL is mocked. */
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { singleDatabaseStatementConsent } from '@authrim/ar-lib-core';
import {
  getConsentItemsForScreen,
  processConsentItemDecisions,
} from '@authrim/ar-lib-core/utils/consent-statements';
import { adminConsentStatementDeleteHandler } from '../admin-consent-statements';
import { openCoreStore } from './helpers/core-schema-sqlite';
import type { SQLiteDatabase } from './test-sqlite';

let NOW = Date.now();
const TENANT = 'consent-disabled-a';
const STATEMENT = 'consent-statement-a';
const VERSION = 'consent-version-a';
const POSITIVE_USER = 'consent-user-positive';
const DELAYED_USER = 'consent-user-delayed';
const EVIDENCE = { client_id: 'consent-client', user_agent: 'synthetic-consent-test' };
const opened: SQLiteDatabase[] = [];

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
  vi.restoreAllMocks();
});

async function seed(adapter: DatabaseAdapter) {
  await adapter.execute(
    `INSERT INTO consent_statements
     (id, tenant_id, slug, is_active, created_at, updated_at,
      record_retention_days, reconsent_interval_days)
     VALUES (?, ?, 'consent-compatibility', 1, ?, ?, 30, 7)`,
    [STATEMENT, TENANT, NOW, NOW]
  );
  await adapter.execute(
    `INSERT INTO consent_statement_versions
     (id, tenant_id, statement_id, version, effective_at, is_current, status, created_at, updated_at)
     VALUES (?, ?, ?, '20261025', ?, 1, 'active', ?, ?)`,
    [VERSION, TENANT, STATEMENT, NOW, NOW, NOW]
  );
}

async function state(adapter: DatabaseAdapter) {
  const params = [TENANT, STATEMENT];
  return {
    statements: await adapter.query(
      'SELECT * FROM consent_statements WHERE tenant_id=? AND id=?',
      params
    ),
    versions: await adapter.query(
      'SELECT * FROM consent_statement_versions WHERE tenant_id=? AND statement_id=?',
      params
    ),
    records: await adapter.query<Record<string, unknown>>(
      'SELECT * FROM user_consent_records WHERE tenant_id=? AND statement_id=? ORDER BY id',
      params
    ),
    history: await adapter.query<Record<string, unknown>>(
      'SELECT * FROM consent_item_history WHERE tenant_id=? AND statement_id=? ORDER BY id',
      params
    ),
    orphanGranted: await adapter.query(
      `SELECT r.id FROM user_consent_records r
       LEFT JOIN consent_statements s ON s.id=r.statement_id
       LEFT JOIN consent_statement_versions v ON v.id=r.version_id
       WHERE r.tenant_id=? AND r.statement_id=? AND r.status='granted'
         AND (s.id IS NULL OR v.id IS NULL)`,
      params
    ),
  };
}

describe('disabled consent split: preserve the existing delayed-grant safeguard', () => {
  it('accepts a live grant, then rejects old screen targets after the actual statement DELETE', async () => {
    NOW = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, adapter: sqlite } = openCoreStore(TENANT);
    const adapter = { ...sqlite, getType: () => 'd1' as const };
    opened.push(db);
    expect(await adapter.queryOne('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    const schemaSql = `SELECT type,name,sql FROM sqlite_schema
      WHERE tbl_name IN ('user_consent_records','consent_item_history') ORDER BY type,name`;
    const beforeSchema = await adapter.query(schemaSql);
    await seed(adapter);

    const page = await getConsentItemsForScreen(
      singleDatabaseStatementConsent(adapter),
      TENANT,
      null,
      DELAYED_USER,
      'en'
    );
    expect(page).toHaveLength(1);
    const item = page[0];
    expect(item).toMatchObject({
      statement_id: STATEMENT,
      version_id: VERSION,
      version: '20261025',
    });
    const targets = {
      [item.statement_id]: {
        version_id: item.version_id,
        version: item.version,
        withdrawal_allowed: item.withdrawal_allowed,
      },
    };
    const grant = (userId: string) =>
      processConsentItemDecisions(
        singleDatabaseStatementConsent(adapter),
        TENANT,
        userId,
        { [STATEMENT]: 'granted' },
        EVIDENCE,
        'synthetic-ip-hash',
        targets
      );
    await grant(POSITIVE_USER);
    const positive = await state(adapter);
    expect(positive.records).toHaveLength(1);
    expect(positive.history).toHaveLength(1);
    expect(positive.records[0]).toMatchObject({
      user_id: POSITIVE_USER,
      statement_id: STATEMENT,
      version_id: VERSION,
      status: 'granted',
      granted_at: NOW,
      consent_settings_snapshot_at: NOW,
      record_retention_days_snapshot: 30,
      reconsent_interval_days_snapshot: 7,
    });
    expect(positive.history[0]).toMatchObject({
      user_id: POSITIVE_USER,
      action: 'granted',
      status_after: 'granted',
      version_id_after: VERSION,
    });
    expect(positive.orphanGranted).toEqual([]);
    // Preserve the existing same-version replay behavior as a positive control.
    await grant(POSITIVE_USER);
    expect(await state(adapter)).toEqual(positive);

    const messages = { info: vi.fn(), error: vi.fn() };
    type Variables = {
      tenantId: string;
      tenantMetadataContext: { tenantId: string; coreDb: DatabaseAdapter };
      logger: unknown;
    };
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (context, next) => {
      context.set('tenantId', TENANT);
      context.set('tenantMetadataContext', { tenantId: TENANT, coreDb: adapter });
      context.set('logger', { module: () => messages });
      await next();
    });
    app.delete('/api/admin/consent-statements/:id', adminConsentStatementDeleteHandler);
    const response = await app.request(`/api/admin/consent-statements/${STATEMENT}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, disposition: 'retired' });
    expect(messages.error).not.toHaveBeenCalled();
    const retired = await state(adapter);
    expect(retired.statements).toHaveLength(1);
    expect(retired.statements[0]).toMatchObject({ is_active: 0, retired_at: NOW });
    expect(retired.versions).toEqual(positive.versions);
    expect(retired.records).toEqual(positive.records);
    expect(retired.history).toEqual(positive.history);
    expect(retired.orphanGranted).toEqual([]);

    // The unmodified producer receives exactly the targets obtained before retirement.
    await expect(grant(DELAYED_USER)).rejects.toThrow(/document_changed/iu);
    expect(await state(adapter)).toEqual(retired);
    expect(await adapter.query('PRAGMA foreign_key_check')).toEqual([]);
    expect(await adapter.queryOne('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    expect(await adapter.query(schemaSql)).toEqual(beforeSchema);
  });
});
