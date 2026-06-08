import { describe, expect, it } from 'vitest';
import { resolveRuntimeIdentityMappingBinding } from '../identity-mapping-runtime-resolver';
import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  TransactionContext,
} from '../../db/adapter';

describe('resolveRuntimeIdentityMappingBinding', () => {
  it('selects a partner-specific activation before tenant default', async () => {
    const adapter = new ResolverAdapter({
      activations: [
        activationRow('activation-default', {
          kind: 'tenant',
          id: 'tenant_a',
          protocol: 'saml',
          role: 'idp',
        }),
        activationRow('activation-sp', {
          kind: 'tenant',
          id: 'tenant_a',
          protocol: 'saml',
          role: 'idp',
          partnerEntityId: 'https://sp.example.edu/saml',
        }),
      ],
    });

    const binding = await resolveRuntimeIdentityMappingBinding(adapter, {
      tenantId: 'tenant_a',
      protocol: 'saml',
      role: 'idp',
      partnerEntityId: 'https://sp.example.edu/saml',
    });

    expect(binding).toMatchObject({
      id: 'activation-sp',
      fieldMappingSetId: 'field_mapping_sp',
      fieldMappingVersionId: 'version_sp',
    });
    expect(binding?.edges).toEqual([
      {
        id: 'edge_email',
        sourceRef: {
          side: 'source',
          namespace: 'authrim.profile',
          path: 'email',
          catalogEntryId: 'field.profile.email',
        },
        targetRef: {
          side: 'destination',
          namespace: 'saml.attribute',
          path: 'urn:oid:0.9.2342.19200300.100.1.3',
          catalogEntryId: 'field.saml.mail',
        },
      },
    ]);
  });

  it('uses the selected policy set when a provider override is configured', async () => {
    const adapter = new ResolverAdapter({
      activations: [
        activationRow('activation-default', {
          kind: 'tenant',
          id: 'tenant_a',
          protocol: 'saml',
          role: 'idp',
        }),
        activationRow(
          'activation-override',
          {
            kind: 'tenant',
            id: 'tenant_a',
            protocol: 'saml',
            role: 'idp',
          },
          {
            fieldMappingSetId: 'field_mapping_override',
            fieldMappingVersionId: 'version_override',
          }
        ),
      ],
    });

    const binding = await resolveRuntimeIdentityMappingBinding(adapter, {
      tenantId: 'tenant_a',
      protocol: 'saml',
      role: 'idp',
      fieldMappingSetId: 'field_mapping_override',
      partnerEntityId: 'https://sp.example.edu/saml',
    });

    expect(binding).toMatchObject({
      id: 'activation-override',
      fieldMappingSetId: 'field_mapping_override',
      fieldMappingVersionId: 'version_override',
      catalog: {
        identity: {
          id: 'catalog_version_1',
        },
      },
    });
  });
});

interface ResolverAdapterInput {
  activations: Record<string, unknown>[];
}

class ResolverAdapter implements DatabaseAdapter {
  constructor(private readonly input: ResolverAdapterInput) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (sql.includes('FROM field_mapping_activations')) {
      const fieldMappingSetId = params[2];
      return this.input.activations
        .filter((row) => !fieldMappingSetId || row.field_mapping_set_id === fieldMappingSetId)
        .map((row) => row as T);
    }
    if (sql.includes('FROM field_catalog_entries')) {
      return [
        {
          id: 'entry_profile_email',
          stable_field_id: 'field.profile.email',
          namespace: 'authrim.profile',
          path: 'email',
          target_taxonomy: 'canonical',
          value_type: 'string',
          cardinality: 'single',
          classification: 'pii',
          aliases_json: null,
          validation_json: '{}',
        },
        {
          id: 'entry_saml_mail',
          stable_field_id: 'field.saml.mail',
          namespace: 'saml.attribute',
          path: 'urn:oid:0.9.2342.19200300.100.1.3',
          target_taxonomy: 'destination',
          value_type: 'string',
          cardinality: 'single',
          classification: 'pii',
          aliases_json: null,
          validation_json: JSON.stringify({ required: true }),
        },
      ] as T[];
    }
    if (sql.includes('JOIN mapping_rule_edges')) {
      return [
        {
          id: 'edge_email',
          source_ref_json: JSON.stringify({
            side: 'source',
            namespace: 'authrim.profile',
            path: 'email',
            catalogEntryId: 'field.profile.email',
          }),
          target_ref_json: JSON.stringify({
            side: 'destination',
            namespace: 'saml.attribute',
            path: 'urn:oid:0.9.2342.19200300.100.1.3',
            catalogEntryId: 'field.saml.mail',
          }),
          display_order: 0,
        },
      ] as T[];
    }
    if (
      sql.includes('JOIN mapping_transform_steps') ||
      sql.includes('JOIN mapping_validation_rules')
    ) {
      return [] as T[];
    }
    if (sql.includes('FROM mapping_rules')) {
      return [
        {
          id: 'rule_1',
          action: 'allow',
          priority: 0,
          scope_json: JSON.stringify({ kind: 'tenant', id: 'tenant_a' }),
          metadata_json: '{}',
        },
      ] as T[];
    }
    return [] as T[];
  }

  async queryOne<T>(): Promise<T | null> {
    return null;
  }

  async execute(): Promise<ExecuteResult> {
    return { rowsAffected: 0, success: true };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async batch(_statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    return [];
  }

  async isHealthy(): Promise<HealthStatus> {
    return { healthy: true, latencyMs: 0, type: 'test' };
  }

  getType(): string {
    return 'test';
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function activationRow(
  id: string,
  scope: Record<string, unknown>,
  options: { fieldMappingSetId?: string; fieldMappingVersionId?: string } = {}
) {
  const fieldMappingSetId =
    options.fieldMappingSetId ??
    (id === 'activation-sp' ? 'field_mapping_sp' : 'field_mapping_default');
  const fieldMappingVersionId =
    options.fieldMappingVersionId ?? (id === 'activation-sp' ? 'version_sp' : 'version_default');
  return {
    activation_id: id,
    tenant_id: 'tenant_a',
    field_mapping_set_id: fieldMappingSetId,
    field_mapping_version_id: fieldMappingVersionId,
    activation_scope_json: JSON.stringify(scope),
    version_label: 'active',
    field_mapping_hash: `${fieldMappingVersionId}_hash`,
    field_mapping_compatibility_range: '^0.3.0',
    catalog_version_id: 'catalog_version_1',
    catalog_version_label: '2026-06-06',
    catalog_bundle_hash: 'catalog_hash',
    catalog_compatibility_range: '^0.3.0',
  };
}
