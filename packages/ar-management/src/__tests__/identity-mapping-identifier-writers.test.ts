import { describe, expect, it } from 'vitest';
import { resolveRuntimeIdentityMappingBinding } from '@authrim/ar-lib-core';
import { buildSAMLAttributesForSPWithDiagnostics } from '@authrim/ar-saml/src/idp/attributes';
import {
  IdentityMappingControlPlaneRepository,
  type FieldMappingVersionRuleInput,
} from '../identity-mapping-control-plane';
import { openAdminDatabase, sqliteAdapter } from './helpers/admin-authority-fixture';

function identifierRule(
  graph: boolean,
  target: Record<string, unknown>
): FieldMappingVersionRuleInput {
  return {
    ruleKey: 'identifier',
    ruleKind: 'mapping',
    action: 'allow',
    ...(graph ? { targetRef: { ...target }, output: { stepIndex: 0 } } : {}),
    transforms: [
      {
        operation: 'persistent_identifier',
        parameters: { input: 'account', format: 'plain', algorithm: 'authrim_sha256' },
        ...(graph ? { inputs: [] } : { targetRef: { ...target } }),
      },
    ],
  };
}

function copyRule(graph: boolean, target: Record<string, unknown>): FieldMappingVersionRuleInput {
  return {
    ruleKey: 'copy',
    ruleKind: 'mapping',
    action: 'allow',
    priority: 1,
    ...(graph ? { targetRef: { ...target }, output: { stepIndex: 0 } } : {}),
    edges: [
      {
        sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'email' },
        targetRef: { ...target },
      },
    ],
    transforms: [
      graph
        ? { operation: 'copy', inputs: [{ edgeIndex: 0 }] }
        : { operation: 'copy', inputs: [{ edgeIndex: 0 }] },
    ],
    conflictRules: [
      { targetRef: { ...target }, conflictStrategy: 'prefer_source', sourcePriority: [] },
    ],
  };
}

describe('identifier target exclusivity across request shapes', () => {
  it.each([
    { identifierGraph: false, copyGraph: false },
    { identifierGraph: false, copyGraph: true },
    { identifierGraph: true, copyGraph: false },
    { identifierGraph: true, copyGraph: true },
  ])(
    'refuses another writer despite a conflict policy ($identifierGraph/$copyGraph)',
    async ({ identifierGraph, copyGraph }) => {
      const db = openAdminDatabase();
      try {
        const adapter = sqliteAdapter(db);
        const repository = new IdentityMappingControlPlaneRepository(adapter);
        const set = await repository.createFieldMappingSet('tenant', {
          fieldMappingKey: 'identifiers',
          displayName: 'Identifiers',
        });
        const target = { side: 'destination', namespace: 'oidc.claim', path: 'sub' };
        await expect(
          repository.createFieldMappingVersion('tenant', set.id, {
            versionLabel: 'v1',
            rules: [identifierRule(identifierGraph, target), copyRule(copyGraph, target)],
          })
        ).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
        expect(
          await adapter.queryOne<{ count: number }>(
            'SELECT COUNT(*) AS count FROM field_mapping_versions'
          )
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    }
  );

  it.each([false, true])(
    'keeps the saved identifier in release after refusing a replacement (graph=%s)',
    async (graph) => {
      const db = openAdminDatabase();
      try {
        const adapter = sqliteAdapter(db);
        const repository = new IdentityMappingControlPlaneRepository(adapter);
        const catalog = await repository.createCatalog('tenant', {
          catalogKey: 'identifier',
          displayName: 'Identifier',
          versionLabel: 'v1',
          entries: [
            {
              id: 'identifier',
              namespace: 'saml.attribute',
              path: 'eptid',
              valueType: 'string',
              cardinality: 'single',
              classification: 'internal',
              targetType: 'destination-only',
            },
          ],
        });
        const set = await repository.createFieldMappingSet('tenant', {
          fieldMappingKey: 'identifiers',
          displayName: 'Identifiers',
        });
        const target = { side: 'destination', namespace: 'saml.attribute', path: 'eptid' };
        const version = await repository.createFieldMappingVersion('tenant', set.id, {
          versionLabel: 'v1',
          rules: [identifierRule(graph, target)],
        });
        await repository.publishFieldMappingVersion('tenant', set.id, version.id);
        const snapshot = await repository.compileFieldMappingVersion('tenant', set.id, version.id, {
          catalogVersionId: catalog.activeVersion.id,
        });
        await repository.activateFieldMappingVersion('tenant', set.id, version.id, {
          snapshotId: snapshot.id,
          activationScope: { protocol: 'saml', role: 'idp' },
        });
        await expect(
          repository.createFieldMappingVersion('tenant', set.id, {
            versionLabel: 'v2',
            rules: [identifierRule(graph, target), copyRule(true, target)],
          })
        ).rejects.toMatchObject({ status: 400 });
        const binding = await resolveRuntimeIdentityMappingBinding(adapter, {
          tenantId: 'tenant',
          fieldMappingSetId: set.id,
          protocol: 'saml',
          role: 'idp',
        });
        if (!binding) throw new Error('Saved identifier binding was not loaded');
        expect(binding.fieldMappingVersionId).toBe(version.id);
        const step = binding.transforms.find((step) => step.operation === 'persistent_identifier');
        if (!step) throw new Error('Saved identifier step was not loaded');
        const release = buildSAMLAttributesForSPWithDiagnostics(
          { id: 'user', email: 'raw@example.test' },
          {
            tenantId: 'tenant',
            attributeMapping: {},
            identityMapping: {
              ...binding,
              runtimeContext: { identifiers: { [step.id]: 'prepared-identifier' } },
            },
          }
        );
        expect(release.attributes.flatMap((attribute) => attribute.values)).toEqual([
          'prepared-identifier',
        ]);
        expect(JSON.stringify(release)).not.toContain('raw@example.test');
      } finally {
        db.close();
      }
    }
  );
});
