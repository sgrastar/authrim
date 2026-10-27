import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../import/postgres-restore-table-contract';
import { createDsqlSubsetFixture, type DsqlSubsetFixture } from './subset-fixture';

export type DsqlConfigurationFixture = DsqlSubsetFixture;
const TENANT = 'dsql-synthetic-configuration';
const PRECISE_JSON =
  '{"purpose":"DSQL設定適合試験","preciseInteger":9007199254740993,"fraction":0.125,"exponent":1e-3}';

/** Synthetic storage data only: no usable certificate, credential, or executable Flow. */
export function createDsqlConfigurationFixture(
  options: { spCount?: number } = {}
): Promise<DsqlConfigurationFixture> {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('dsql_configuration_fixture_invalid');
  const count = options.spCount ?? 101;
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'spCount') ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 2_000
  ) {
    throw new Error('dsql_configuration_fixture_invalid');
  }
  return createDsqlSubsetFixture({
    kind: 'configuration',
    tenantId: TENANT,
    issuer: 'https://configuration.example.test',
    expectedRows: {
      'core.identity_providers': count,
      'core.flows': count,
      'core.flow_versions': count,
      'core.flow_assignments': count + 1,
    },
    row(datasetId, index, now): PortableSqliteRow {
      const spec = POSTGRES_RESTORE_TABLE_CONTRACTS.find((item) => item.datasetId === datasetId);
      if (!spec) throw new Error('dsql_configuration_fixture_invalid');
      const suffix = String(index).padStart(6, '0');
      const flowId = `synthetic-flow-${suffix}`;
      const fields: Record<string, string | number | null> = {
        id: flowId,
        tenant_id: TENANT,
        created_at: now,
        updated_at: now,
      };
      if (datasetId === 'core.identity_providers') {
        Object.assign(fields, {
          id: `synthetic-sp-${suffix}`,
          name: `合成接続先 ${suffix}`,
          provider_type: 'saml_sp',
          enabled: 1,
          config_json: `{"entityId":"https://sp-${suffix}.example.test/entity","acsUrl":"https://sp-${suffix}.example.test/acs","synthetic":${PRECISE_JSON}}`,
        });
      } else if (datasetId === 'core.flows') {
        Object.assign(fields, {
          name: `合成フロー ${suffix}`,
          slug: `synthetic-${suffix}`,
          version: '1.0.0',
          is_active: 1,
          is_builtin: 0,
          kind: 'login',
          status: 'published',
          published_version_id: `synthetic-version-${suffix}`,
          graph_definition: PRECISE_JSON,
          draft_editor_json: PRECISE_JSON,
        });
      } else if (datasetId === 'core.flow_versions') {
        Object.assign(fields, {
          id: `synthetic-version-${suffix}`,
          flow_id: flowId,
          version_number: 1,
          schema_version: 'synthetic-storage-evaluation-v1',
          runtime_snapshot_json: PRECISE_JSON,
          editor_snapshot_json: PRECISE_JSON,
          validation_result_json: '{"synthetic":true}',
          published_at: now,
        });
      } else if (datasetId === 'core.flow_assignments') {
        Object.assign(fields, {
          id: `synthetic-assignment-${suffix}`,
          flow_id: index === count ? 'synthetic-flow-000000' : flowId,
          target_type: index === count ? 'tenant' : 'saml_sp',
          target_id: index === count ? null : `https://sp-${suffix}.example.test/entity`,
          flow_kind: 'login',
          enabled: 1,
        });
      } else throw new Error('dsql_configuration_fixture_invalid');
      return Object.fromEntries(
        spec.columns.map((column) => {
          const value = fields[column] ?? null;
          return [
            column,
            value === null
              ? ['null', null]
              : [spec.sqliteIntegerColumns.includes(column) ? 'integer' : 'text', String(value)],
          ];
        })
      );
    },
  });
}
