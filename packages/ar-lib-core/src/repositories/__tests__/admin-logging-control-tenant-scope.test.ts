import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { AdminLoggingControlRepository } from '../admin/admin-logging-control';

/**
 * The views behind the logging overview are installation-wide. A tenant administrator reaches
 * them too, so what is tenant data in them has to be narrowed in the query itself: after the
 * limit, other tenants' rows would already have pushed the caller's out.
 */

function recordingAdapter() {
  const queries: { sql: string; params: unknown[] }[] = [];
  const adapter = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      return [];
    },
    async queryOne() {
      return null;
    },
  } as unknown as DatabaseAdapter;
  return { adapter, queries };
}

describe('AdminLoggingControlRepository tenant scope', () => {
  it('limits the critical assignments to the tenant when one is given', async () => {
    const { adapter, queries } = recordingAdapter();

    await new AdminLoggingControlRepository(adapter).loadCriticalPolicy('tenant-a');

    const assignments = queries.find(({ sql }) =>
      sql.includes('FROM logging_destination_overrides')
    );
    expect(assignments?.sql).toContain('AND lpa.tenant_id = ?');
    expect(assignments?.params).toEqual(['tenant-a']);
  });

  it('leaves the critical assignments unlimited for the platform', async () => {
    const { adapter, queries } = recordingAdapter();

    await new AdminLoggingControlRepository(adapter).loadCriticalPolicy();

    const assignments = queries.find(({ sql }) =>
      sql.includes('FROM logging_destination_overrides')
    );
    expect(assignments?.sql).not.toContain('lpa.tenant_id = ?');
    expect(assignments?.params).toEqual([]);
  });

  it('limits the sensitive-detail assignments and index summary to the tenant', async () => {
    const { adapter, queries } = recordingAdapter();

    await new AdminLoggingControlRepository(adapter).loadSensitiveDetailPolicy('tenant-a');

    const assignments = queries.find(({ sql }) =>
      sql.includes('FROM logging_destination_overrides')
    );
    const index = queries.find(({ sql }) => sql.includes('FROM sensitive_detail_chunk_index'));
    expect(assignments?.params).toEqual(['tenant-a']);
    expect(index?.sql).toContain('WHERE tenant_id = ?');
    expect(index?.params).toEqual(['tenant-a']);
  });

  it('narrows catalog repair candidates to the tenant key before the limit', async () => {
    const { adapter, queries } = recordingAdapter();

    await new AdminLoggingControlRepository(adapter).detectCatalogRepairFindings({
      now: 1,
      limit: 10,
      pendingTtlMs: 1,
      tenantKey: 'key-a',
    });

    expect(queries).toHaveLength(2);
    for (const { sql, params } of queries) {
      expect(sql).toMatch(/tenant_key = \?\s+ORDER BY[\s\S]*LIMIT \?/);
      expect(params).toEqual(['key-a', 10]);
    }
  });
});
