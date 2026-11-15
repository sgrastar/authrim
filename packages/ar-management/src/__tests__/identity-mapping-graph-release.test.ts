import { describe, expect, it } from 'vitest';
import { resolveRuntimeIdentityMappingBinding } from '@authrim/ar-lib-core';
import { executeRuntimeMapping } from '@authrim/ar-lib-field-mapping/runtime';
import { buildSAMLAttributesForSPWithDiagnostics } from '@authrim/ar-saml/src/idp/attributes';
import { IdentityMappingControlPlaneRepository } from '../identity-mapping-control-plane';
import { openAdminDatabase, sqliteAdapter } from './helpers/admin-authority-fixture';

describe('saved competing graph outputs at SAML release', () => {
  it.each([false, true])(
    'releases only public JSON fields after saving, compiling and loading two rules (reverse priority=%s)',
    async (reversePriority) => {
      const db = openAdminDatabase();
      try {
        const adapter = sqliteAdapter(db);
        const repository = new IdentityMappingControlPlaneRepository(adapter);
        const tenantId = 'graph-release-tenant';
        const catalog = await repository.createCatalog(tenantId, {
          catalogKey: 'json-sources',
          displayName: 'JSON sources',
          versionLabel: 'v1',
          entries: [
            {
              id: 'first-json',
              namespace: 'authrim.profile',
              path: 'attributes.first_json',
              valueType: 'string',
              cardinality: 'single',
              classification: 'internal',
              targetType: 'canonical',
            },
            {
              id: 'second-json',
              namespace: 'authrim.profile',
              path: 'attributes.second_json',
              valueType: 'string',
              cardinality: 'single',
              classification: 'internal',
              targetType: 'canonical',
            },
            {
              id: 'public-attribute',
              namespace: 'saml.attribute',
              path: 'public_value',
              valueType: 'string',
              cardinality: 'multi',
              classification: 'internal',
              targetType: 'destination-only',
            },
          ],
        });
        const profile = await repository.createDestinationProfile(tenantId, {
          destinationType: 'saml',
          profileKey: 'public-values',
          displayName: 'Public values',
          schema: {
            destinationType: 'saml',
            nameId: {
              format: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
              source: 'email',
            },
            attributes: [{ name: 'public_value', classification: 'internal' }],
          },
        });
        const set = await repository.createFieldMappingSet(tenantId, {
          fieldMappingKey: 'public-json',
          displayName: 'Public JSON fields',
        });
        const targetRef = {
          side: 'destination',
          namespace: 'saml.attribute',
          path: 'public_value',
          profileId: `destination-profile-${profile.id}`,
        };
        const version = await repository.createFieldMappingVersion(tenantId, set.id, {
          versionLabel: 'v1',
          rules: ['first', 'second'].map((key, index) => ({
            ruleKey: key,
            ruleKind: 'mapping',
            action: 'allow',
            priority: reversePriority ? -index : index,
            targetRef: { ...targetRef },
            edges: [
              {
                sourceRef: {
                  side: 'source',
                  namespace: 'authrim.profile',
                  path: `attributes.${key}_json`,
                },
                targetRef: { ...targetRef },
              },
            ],
            transforms: [
              { operation: 'trim', inputs: [{ edgeIndex: 0 }] },
              {
                operation: 'json_extract_text',
                parameters: { path: 'public' },
                inputs: [{ stepIndex: 0, name: 'json' }],
              },
            ],
            output: { stepIndex: 1 },
            conflictRules: [
              {
                targetRef: { ...targetRef },
                conflictStrategy: 'prefer_source',
                sourcePriority: [],
              },
            ],
          })),
        });
        await repository.publishFieldMappingVersion(tenantId, set.id, version.id);
        const snapshot = await repository.compileFieldMappingVersion(tenantId, set.id, version.id, {
          catalogVersionId: catalog.activeVersion.id,
        });
        await repository.activateFieldMappingVersion(tenantId, set.id, version.id, {
          snapshotId: snapshot.id,
          activationScope: { protocol: 'saml', role: 'idp' },
        });
        const binding = await resolveRuntimeIdentityMappingBinding(adapter, {
          tenantId,
          fieldMappingSetId: set.id,
          protocol: 'saml',
          role: 'idp',
        });
        if (!binding) throw new Error('Saved mapping was not loaded');
        expect(binding.edges).toHaveLength(2);
        expect(binding.transforms).toHaveLength(4);
        const subject = {
          id: 'user',
          attributes: {
            first_json: ' {"public":"one","hidden":"first-hidden"} ',
            second_json: ' {"public":"two","hidden":"second-hidden"} ',
          },
        };
        const expected = reversePriority ? ['two', 'one'] : ['one', 'two'];
        const evaluated = executeRuntimeMapping({
          ...binding,
          sourceValues: binding.edges.map((edge) => ({
            sourceRef: edge.sourceRef,
            value: edge.sourceRef.path.endsWith('first_json')
              ? subject.attributes.first_json
              : subject.attributes.second_json,
          })),
        });
        expect(evaluated.values.map((value) => value.value)).toEqual(expected);
        const release = buildSAMLAttributesForSPWithDiagnostics(subject, {
          tenantId,
          attributeMapping: {},
          identityMapping: binding,
        });
        expect(release.attributes.flatMap((attribute) => attribute.values)).toEqual(expected);
        expect(JSON.stringify(release)).not.toContain('hidden');
      } finally {
        db.close();
      }
    }
  );
});
