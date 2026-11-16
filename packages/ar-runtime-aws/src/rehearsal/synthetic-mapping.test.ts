import { describe, expect, it } from 'vitest';
import type { SAMLSPConfig } from '@authrim/ar-lib-core';
import {
  assertSAMLImportedSPRelease,
  compileSAMLImportedSPRelease,
} from '../../../ar-saml/src/idp/runtime-identity-mapping';
import {
  buildSAMLAttributesForSPWithDiagnostics,
  SAMLIdentityMappingRuntimeError,
} from '../../../ar-saml/src/idp/attributes';
import { createSnapshotAdminAdapter } from '../import/snapshot-admin-db';
import {
  importedMailRelease,
  MAIL_ATTRIBUTE,
  SP,
} from '../__tests__/imported-mail-release-fixture';
import {
  ORIGIN,
  TENANT,
  resolveSyntheticFixtureProfile,
  sourceAdminRows,
  type SyntheticFixtureProfile,
} from './synthetic-fixture';

const browserIssuer = 'https://abcdefghij.execute-api.ap-northeast-1.amazonaws.com';
const profiles: SyntheticFixtureProfile[] = [
  { kind: 'in-process' },
  {
    kind: 'aws-browser',
    issuer: browserIssuer,
    spEntityId: `${browserIssuer}/test-sp/metadata`,
    acsUrl: `${browserIssuer}/test-sp/acs`,
  },
  {
    kind: 'aws-browser',
    issuer: browserIssuer,
    spEntityId: `${browserIssuer}/test-sp/metadata`,
    acsUrl: `${browserIssuer}/test-sp/acs`,
    externalLogin: {
      mode: 'external',
      baseUrl: 'https://login.example.test',
      clientId: 'test-external-ui',
      paths: { login: '/login', reauth: '/reauth' },
    },
  },
];

function spConfig(entityId: string, acsUrl: string): SAMLSPConfig {
  return {
    entityId,
    acsUrl,
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    attributeMapping: {},
    signAssertions: true,
    signResponses: true,
    allowedBindings: ['post'],
  };
}

function releasedMail(
  identityMapping: ReturnType<typeof assertSAMLImportedSPRelease>,
  entityId: string
) {
  return buildSAMLAttributesForSPWithDiagnostics(
    { id: 'synthetic-user', email: 'synthetic-user@example.test' },
    {
      tenantId: TENANT,
      entityId,
      localEntityId: identityMapping.localEntityId,
      attributeMapping: {},
      identityMapping,
    }
  ).attributes;
}

describe('synthetic SAML mapping graph fixtures', () => {
  it.each(profiles)(
    'restores and compiles the stored graph for %j without PostgreSQL',
    async (input) => {
      const profile = resolveSyntheticFixtureProfile(input);
      const adapter = createSnapshotAdminAdapter({
        tenantId: TENANT,
        rows: sourceAdminRows(profile),
      });
      try {
        // Use the same stored rows, resolver and imported-release compiler as offline restore.
        const release = await compileSAMLImportedSPRelease({
          adminAdapter: adapter,
          coreAdapter: adapter,
          tenantId: TENANT,
          idpEntityId: `${profile.issuer}/saml/idp/metadata`,
          spConfig: {
            ...spConfig(profile.spEntityId, profile.acsUrl),
            identityMapping: {
              fieldMappingSetId: 'set-mail',
              destinationProfileId: 'profile-mail',
              destinationFieldPolicies: { [MAIL_ATTRIBUTE]: 'required' },
            },
          },
        });
        const binding = assertSAMLImportedSPRelease(release, {
          tenantId: TENANT,
          spEntityId: profile.spEntityId,
          sourceSelector: release.sourceSelector ?? undefined,
        });
        expect(binding.graphRules).toMatchObject([
          { id: 'rule-mail', targetRef: { path: MAIL_ATTRIBUTE }, output: { edgeIndex: 0 } },
        ]);
        expect(releasedMail(binding, profile.spEntityId)).toEqual([
          { name: MAIL_ATTRIBUTE, values: ['synthetic-user@example.test'] },
        ]);
      } finally {
        await adapter.close();
      }
    }
  );

  it('evaluates the explicit imported release used by the passkey integration test', () => {
    const release = importedMailRelease(TENANT, ORIGIN);
    const binding = assertSAMLImportedSPRelease(release, {
      tenantId: TENANT,
      spEntityId: SP,
      sourceSelector: release.sourceSelector ?? undefined,
    });
    expect(releasedMail(binding, SP)).toEqual([
      { name: MAIL_ATTRIBUTE, values: ['synthetic-user@example.test'] },
    ]);
    // Missing graphs remain an error; the fixture must not rely on the removed evaluator.
    expect(() => releasedMail({ ...binding, graphRules: undefined }, SP)).toThrow(
      SAMLIdentityMappingRuntimeError
    );
  });

  it('still refuses stored rules without an explicit target and output', async () => {
    const rows = sourceAdminRows(resolveSyntheticFixtureProfile());
    rows.mapping_rules = rows.mapping_rules.map((rule) =>
      Object.fromEntries(
        Object.entries(rule).filter(
          ([column]) => !['target_ref_json', 'output_edge_id', 'output_step_id'].includes(column)
        )
      )
    );
    const adapter = createSnapshotAdminAdapter({ tenantId: TENANT, rows });
    try {
      await expect(
        compileSAMLImportedSPRelease({
          adminAdapter: adapter,
          coreAdapter: adapter,
          tenantId: TENANT,
          idpEntityId: `${ORIGIN}/saml/idp/metadata`,
          spConfig: {
            ...spConfig(SP, 'https://sp.example.test/acs'),
            identityMapping: {
              fieldMappingSetId: 'set-mail',
              destinationProfileId: 'profile-mail',
              destinationFieldPolicies: { [MAIL_ATTRIBUTE]: 'required' },
            },
          },
        })
      ).rejects.toThrow('invalid_reference: stored rule target is missing');
    } finally {
      await adapter.close();
    }
  });
});
