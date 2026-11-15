import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeIdentityMappingBinding } from '@authrim/ar-lib-core/services/identity-mapping-runtime-resolver';
import type { MappingRuleEdge, MappingTransformStep } from '@authrim/ar-lib-field-mapping/contract';

const mocks = vi.hoisted(() => ({
  resolveBinding: vi.fn(),
  settings: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  ensureDatabaseAdapter: vi.fn(() => ({})),
}));

vi.mock('@authrim/ar-lib-core/services/identity-mapping-runtime-resolver', () => ({
  resolveRuntimeIdentityMappingBinding: mocks.resolveBinding,
}));

vi.mock('../scim-settings', () => ({
  getScimInboundSettings: mocks.settings,
}));

import {
  applyScimInboundIdentityMapping,
  ScimIdentityMappingError,
} from '../scim-identity-mapping';

const enterpriseSchema = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

const stringOutputCases: Array<{
  label: string;
  operation?: MappingTransformStep['operation'];
  displayName: string;
  expectedNickname?: string;
  valueType?: string;
  cardinality?: string;
  fails?: boolean;
}> = [
  { label: 'camelCase enterprise attributes', displayName: 'Ada Lovelace' },
  {
    label: 'required nickname rejects an array containing only empty text',
    operation: 'as_array',
    displayName: '',
    fails: true,
  },
  {
    label: 'array output becomes one string before type and cardinality validation',
    operation: 'as_array',
    displayName: 'Ada',
    expectedNickname: 'Ada',
    valueType: 'string',
    cardinality: 'single',
  },
  {
    label: 'string output cannot satisfy multi cardinality',
    operation: 'as_array',
    displayName: 'Ada',
    cardinality: 'multi',
    fails: true,
  },
  {
    label: 'boolean output becomes text before string type validation',
    operation: 'text_to_boolean',
    displayName: 'true',
    expectedNickname: 'true',
    valueType: 'string',
  },
  {
    label: 'string output cannot satisfy boolean type validation',
    operation: 'text_to_boolean',
    displayName: 'true',
    valueType: 'boolean',
    fails: true,
  },
];

describe('SCIM inbound identity mapping', () => {
  let binding: RuntimeIdentityMappingBinding;
  beforeEach(() => {
    mocks.settings.mockReset().mockResolvedValue({ mappingSetId: 'mapping-scim' });
    binding = {
      id: 'activation-scim',
      tenantId: 'tenant-a',
      fieldMappingSetId: 'mapping-scim',
      fieldMappingVersionId: 'mapping-version-1',
      mappingSnapshotHash: 'snapshot-hash',
      catalog: {
        identity: {
          id: 'catalog-1',
          version: '1',
          contentHash: 'hash',
          compatibilityRange: '*',
        },
        entries: [],
      },
      edges: [
        edge('email', 'emails.value'),
        edge('preferred_username', 'userName'),
        edge('employee_number', 'enterprise.employeeNumber'),
        edge('cost_center', 'enterprise.costCenter'),
      ],
      transforms: [],
      validationRules: [],
      fieldMappingSet: { id: 'mapping-version-1', rules: [] },
      activationScope: { protocol: 'scim', role: 'receiver' },
      destinationProfileIds: [],
    };
    mocks.resolveBinding.mockReset().mockResolvedValue(binding);
  });

  it.each(stringOutputCases)('$label', async (scenario) => {
    if (scenario.operation) {
      const nickname = edge('nickname', 'displayName');
      nickname.ruleId = 'nickname-rule';
      binding.edges.push(nickname);
      binding.catalog.entries.push({
        id: 'field.canonical.nickname',
        namespace: 'authrim.profile',
        path: 'nickname',
        aliases: [{ namespace: 'scim.attribute', path: 'displayName' }],
        valueType: 'unknown',
        cardinality: 'multi',
        classification: 'internal',
        targetType: 'canonical',
      });
      binding.transforms.push({
        id: 'nickname-transform',
        ruleId: nickname.ruleId,
        operation: scenario.operation,
        inputEdgeIds: [nickname.id],
        outputTargetRef: nickname.targetRef,
      });
      binding.validationRules.push({
        id: 'required',
        kind: 'required',
        targetRef: nickname.targetRef,
      });
      if (scenario.valueType) {
        binding.validationRules.push({
          id: 'type',
          kind: 'type',
          defaultSeverity: 'critical',
          targetRef: nickname.targetRef,
          parameters: { valueType: scenario.valueType },
        });
      }
      if (scenario.cardinality) {
        binding.validationRules.push({
          id: 'cardinality',
          kind: 'cardinality',
          defaultSeverity: 'critical',
          targetRef: nickname.targetRef,
          parameters: { cardinality: scenario.cardinality },
        });
      }
    }
    const request = applyScimInboundIdentityMapping({
      env: { DB_ADMIN: {} } as never,
      tenantId: 'tenant-a',
      user: {
        userName: 'ada',
        displayName: scenario.displayName,
        emails: [{ value: 'ada@example.test', primary: true }],
        [enterpriseSchema]: {
          employeeNumber: 'E-001',
          costCenter: 'R&D-42',
        },
      },
    });

    if (scenario.fails) {
      await expect(request).rejects.toMatchObject({ code: 'mapping_failed' });
      return;
    }
    const result = await request;
    expect(result.email).toBe('ada@example.test');
    expect(result.preferred_username).toBe('ada');
    expect(result.nickname).toBe(scenario.expectedNickname);
    expect(JSON.parse(result.custom_attributes_json ?? '{}')).toEqual({
      employee_number: 'E-001',
      cost_center: 'R&D-42',
    });
    expect(mocks.resolveBinding).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        protocol: 'scim',
        role: 'receiver',
        fieldMappingSetId: 'mapping-scim',
      })
    );
  });

  it('maps the SCIM auto-map catalog targets to writable user fields', async () => {
    mocks.resolveBinding.mockResolvedValueOnce({
      id: 'activation-scim',
      tenantId: 'tenant-a',
      fieldMappingSetId: 'mapping-scim',
      fieldMappingVersionId: 'mapping-version-1',
      mappingSnapshotHash: 'snapshot-hash',
      catalog: {
        identity: {
          id: 'catalog-1',
          version: '1',
          contentHash: 'hash',
          compatibilityRange: '*',
        },
        entries: [],
      },
      edges: [
        edge('email', 'emails.value'),
        edge('preferred_username', 'userName'),
        edge('display_name', 'displayName'),
        edge('picture_url', 'photos.value'),
        edge('scim_active', 'active'),
        edge('scim_external_id', 'externalId'),
      ],
      transforms: [],
      validationRules: [],
      fieldMappingSet: { id: 'mapping-version-1', rules: [] },
      activationScope: { protocol: 'scim', role: 'receiver' },
      destinationProfileIds: [],
    });

    const result = await applyScimInboundIdentityMapping({
      env: { DB_ADMIN: {} } as never,
      tenantId: 'tenant-a',
      user: {
        userName: 'ada',
        externalId: 'external-ada',
        active: false,
        displayName: 'Ada Lovelace',
        photos: [{ value: 'https://example.test/ada.png', primary: true }],
        emails: [{ value: 'ada@example.test', primary: true }],
      },
    });

    expect(result).toMatchObject({
      email: 'ada@example.test',
      preferred_username: 'ada',
      name: 'Ada Lovelace',
      picture: 'https://example.test/ada.png',
      active: 0,
      external_id: 'external-ada',
    });
    expect(result.custom_attributes_json).toBeUndefined();
  });

  it('ignores enterprise and unknown attributes that are not connected by the selected Mapping Set', async () => {
    mocks.resolveBinding.mockResolvedValueOnce({
      id: 'activation-scim',
      tenantId: 'tenant-a',
      fieldMappingSetId: 'mapping-scim',
      fieldMappingVersionId: 'mapping-version-1',
      mappingSnapshotHash: 'snapshot-hash',
      catalog: {
        identity: {
          id: 'catalog-1',
          version: '1',
          contentHash: 'hash',
          compatibilityRange: '*',
        },
        entries: [],
      },
      edges: [edge('email', 'emails.value'), edge('preferred_username', 'userName')],
      transforms: [],
      validationRules: [],
      fieldMappingSet: { id: 'mapping-version-1', rules: [] },
      activationScope: { protocol: 'scim', role: 'receiver' },
      destinationProfileIds: [],
    });

    const result = await applyScimInboundIdentityMapping({
      env: { DB_ADMIN: {} } as never,
      tenantId: 'tenant-a',
      user: {
        userName: 'unicode-user',
        emails: [
          { value: 'fallback@example.test' },
          { value: 'primary.é@example.test', primary: true },
        ],
        [enterpriseSchema]: {
          employeeNumber: '未接続-E-001',
          costCenter: '未接続-CC-001',
        },
        unknownAttribute: 'must-not-map',
      } as never,
    });

    expect(result).toEqual({
      email: 'primary.é@example.test',
      preferred_username: 'unicode-user',
    });
  });

  it('fails closed when no inbound Mapping Set is selected', async () => {
    mocks.settings.mockResolvedValueOnce({ mappingSetId: null });

    await expect(
      applyScimInboundIdentityMapping({
        env: { DB_ADMIN: {} } as never,
        tenantId: 'tenant-a',
        user: { userName: 'ada', emails: [{ value: 'ada@example.test' }] },
      })
    ).rejects.toMatchObject({
      code: 'mapping_not_configured',
    } satisfies Partial<ScimIdentityMappingError>);
  });
});

function edge(targetPath: string, sourcePath: string): MappingRuleEdge {
  return {
    id: `edge-${targetPath}`,
    sourceRef: { side: 'source', namespace: 'scim.attribute', path: sourcePath },
    targetRef: {
      side: 'destination',
      namespace: 'authrim.profile',
      path: targetPath,
      catalogEntryId: `field.canonical.${targetPath}`,
    },
  };
}
