import { afterEach, describe, expect, it } from 'vitest';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import {
  createDsqlConfigurationFixture,
  type DsqlConfigurationFixture,
} from './configuration-fixture';

const fixtures: DsqlConfigurationFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('encrypted portable configuration fixture', () => {
  it('uses the verified production reader and preserves exact JSON and integer/boolean source tags', async () => {
    const fixture = await createDsqlConfigurationFixture({ spCount: 2 });
    fixtures.push(fixture);
    expect(fixture.trustedReceiptDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(fixture.expectedRows).toMatchObject({
      'core.identity_providers': 2,
      'core.flows': 2,
      'core.flow_versions': 2,
      'core.flow_assignments': 3,
      'core.users_core': 0,
    });
    const read = async (id: string): Promise<PortableSqliteRow> => {
      const next = await fixture.backup.dataset(id).readNextRow(null);
      if (!next) throw new Error('missing_fixture_row');
      return JSON.parse(next.rowJson) as PortableSqliteRow;
    };
    const sp = await read('core.identity_providers');
    const flow = await read('core.flows');
    const version = await read('core.flow_versions');
    expect(sp.enabled).toEqual(['integer', '1']);
    expect(flow.is_active).toEqual(['integer', '1']);
    expect(sp.config_json[1]).toContain('9007199254740993');
    expect(version.runtime_snapshot_json[1]).toContain('9007199254740993');
    expect(version.runtime_snapshot_json[1]).toContain('1e-3');
    expect(version.flow_id).toEqual(flow.id);
    expect(flow.published_version_id).toEqual(version.id);
    expect(flow.tenant_id).toEqual(['text', fixture.tenantId]);
    await fixture.backup.close();
    const reopened = await fixture.reopen();
    expect(reopened.manifest).toEqual(fixture.backup.manifest);
    await fixture.close();
    await expect(fixture.reopen()).rejects.toThrow('dsql_configuration_fixture_invalid');
  });

  it.each([0, -1, 2_001, 1.5, NaN])('rejects an unbounded fixture count %s', (spCount) => {
    expect(() => createDsqlConfigurationFixture({ spCount })).toThrow(
      'dsql_configuration_fixture_invalid'
    );
  });
});
