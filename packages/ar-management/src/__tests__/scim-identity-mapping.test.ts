import * as mappingRuntime from '@authrim/ar-lib-field-mapping/runtime';
import { withExplicitMappingGraphs } from '@authrim/ar-lib-field-mapping/test-support';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeIdentityMappingBinding } from '@authrim/ar-lib-core/services/identity-mapping-runtime-resolver';
import type {
  FieldCatalogEntry,
  MappingRuleEdge,
  MappingRuleGraph,
  MappingTransformStep,
} from '@authrim/ar-lib-field-mapping/contract';

const mocks = vi.hoisted(() => ({
  resolveBinding: vi.fn<(...args: unknown[]) => Promise<RuntimeIdentityMappingBinding | null>>(),
  settings: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  ensureDatabaseAdapter: vi.fn(() => ({})),
}));

vi.mock('@authrim/ar-lib-core/services/identity-mapping-runtime-resolver', () => ({
  resolveRuntimeIdentityMappingBinding: async (...args: unknown[]) => {
    const value = await mocks.resolveBinding(...args);
    return value ? withExplicitMappingGraphs(value) : value;
  },
}));

vi.mock('../scim-settings', () => ({
  getScimInboundSettings: mocks.settings,
}));

import {
  applyScimInboundIdentityMapping,
  ScimIdentityMappingError,
} from '../scim-identity-mapping';

const testEnv = { DB_ADMIN: {} } as never;

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

const ruleOutputCases: Array<{
  label: string;
  sourcePath: string;
  targetPath: string;
  user: Parameters<typeof applyScimInboundIdentityMapping>[0]['user'];
  transforms?: MappingRuleGraph['transforms'];
  output?: MappingRuleGraph['output'];
  expected: Awaited<ReturnType<typeof applyScimInboundIdentityMapping>>;
  custom?: Record<string, unknown>;
  shape: Pick<FieldCatalogEntry, 'valueType' | 'cardinality'>;
}> = [
  {
    label: 'direct boolean into active',
    sourcePath: 'active',
    targetPath: 'active',
    user: { active: false },
    expected: { active: 0 },
    shape: { valueType: 'boolean', cardinality: 'single' },
  },
  {
    label: 'direct object into address',
    sourcePath: 'addresses.primary',
    targetPath: 'address',
    user: { addresses: [{ streetAddress: '1 Example Road', primary: true }] },
    expected: { address_json: JSON.stringify({ streetAddress: '1 Example Road', primary: true }) },
    shape: { valueType: 'json', cardinality: 'single' },
  },
  {
    label: 'direct object array into custom groups',
    sourcePath: 'groups',
    targetPath: 'member_groups',
    user: { groups: [{ value: 'engineering' }, { value: 'reviewers' }] },
    expected: {},
    custom: { member_groups: [{ value: 'engineering' }, { value: 'reviewers' }] },
    shape: { valueType: 'json', cardinality: 'multi' },
  },
  {
    label: 'boolean operation with an unused later step',
    sourcePath: 'displayName',
    targetPath: 'enabled',
    user: { displayName: 'false' },
    expected: {},
    custom: { enabled: false },
    transforms: [
      { id: 'boolean', operation: 'text_to_boolean', inputs: [{ edgeIndex: 0 }] },
      {
        id: 'unused',
        operation: 'json_build',
        inputs: [{ edgeIndex: 0 }],
        parameters: { nullHandling: 'omit' },
      },
    ],
    output: { stepIndex: 0 },
    shape: { valueType: 'boolean', cardinality: 'single' },
  },
  {
    label: 'boolean operation sharing the synthetic edge target',
    sourcePath: 'displayName',
    targetPath: 'input_value',
    user: { displayName: 'false' },
    expected: {},
    custom: { input_value: false },
    transforms: [{ id: 'boolean', operation: 'text_to_boolean', inputs: [{ edgeIndex: 0 }] }],
    shape: { valueType: 'boolean', cardinality: 'single' },
  },
  {
    label: 'object operation',
    sourcePath: 'displayName',
    targetPath: 'preferences',
    user: { displayName: '{"notifications":false}' },
    expected: {},
    custom: { preferences: { notifications: false } },
    transforms: [
      {
        id: 'json',
        operation: 'json_build',
        inputs: [{ edgeIndex: 0 }],
        parameters: { nullHandling: 'omit' },
      },
    ],
    shape: { valueType: 'json', cardinality: 'single' },
  },
  {
    label: 'split array operation',
    sourcePath: 'displayName',
    targetPath: 'tags',
    user: { displayName: 'one,two' },
    expected: {},
    custom: { tags: ['one', 'two'] },
    transforms: [
      {
        id: 'split',
        operation: 'split',
        inputs: [{ edgeIndex: 0 }],
        parameters: { delimiter: ',' },
      },
    ],
    shape: { valueType: 'string', cardinality: 'multi' },
  },
  {
    label: 'array operation following a boolean conversion',
    sourcePath: 'displayName',
    targetPath: 'flags',
    user: { displayName: 'false' },
    expected: {},
    custom: { flags: [false] },
    transforms: [
      { id: 'boolean', operation: 'text_to_boolean', inputs: [{ edgeIndex: 0 }] },
      { id: 'array', operation: 'as_array', inputs: [{ stepIndex: 0 }] },
    ],
    shape: { valueType: 'boolean', cardinality: 'multi' },
  },
  {
    label: 'first operation following a split',
    sourcePath: 'displayName',
    targetPath: 'first_tag',
    user: { displayName: 'one,two' },
    expected: {},
    custom: { first_tag: 'one' },
    transforms: [
      {
        id: 'split',
        operation: 'split',
        inputs: [{ edgeIndex: 0 }],
        parameters: { delimiter: ',' },
      },
      { id: 'first', operation: 'first', inputs: [{ stepIndex: 0 }] },
    ],
    shape: { valueType: 'string', cardinality: 'single' },
  },
  {
    label: 'number extraction operation',
    sourcePath: 'displayName',
    targetPath: 'level',
    user: { displayName: '{"level":3}' },
    expected: {},
    custom: { level: 3 },
    transforms: [
      {
        id: 'number',
        operation: 'json_extract_integer',
        inputs: [{ edgeIndex: 0 }],
        parameters: { path: 'level' },
      },
    ],
    shape: { valueType: 'number', cardinality: 'single' },
  },
  {
    label: 'known string field after array conversion',
    sourcePath: 'displayName',
    targetPath: 'nickname',
    user: { displayName: 'Ada' },
    expected: { nickname: 'Ada' },
    transforms: [{ id: 'array', operation: 'as_array', inputs: [{ edgeIndex: 0 }] }],
    shape: { valueType: 'string', cardinality: 'single' },
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
      env: testEnv,
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

  it('completes the catalog for unused graph edges without supplying their source values', async () => {
    const email = edge('email', 'emails.value');
    const unused = edge('nickname', 'nickName');
    mocks.resolveBinding.mockResolvedValueOnce({
      ...binding,
      edges: [email],
      graphRules: [
        {
          id: 'email-rule',
          edges: [email, unused],
          transforms: [],
          targetRef: email.targetRef,
          output: { edgeIndex: 0 },
        },
      ],
    });
    const execute = vi.spyOn(mappingRuntime, 'executeRuntimeMapping');
    try {
      const mapped = await applyScimInboundIdentityMapping({
        env: testEnv,
        tenantId: 'tenant-a',
        user: { emails: [{ value: 'ada@example.test' }], nickName: 'unused' },
      });
      expect(mapped).toEqual({ email: 'ada@example.test' });
      expect(execute.mock.calls[0]?.[0].sourceValues.map((value) => value.sourceRef.path)).toEqual([
        'emails.value',
      ]);
      expect(execute.mock.calls[0]?.[0].catalog.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ namespace: 'scim.attribute', path: 'nickName' }),
        ])
      );
    } finally {
      execute.mockRestore();
    }
  });

  it('completes a rule target catalog entry independently of edge targets', async () => {
    const input = edge('nickname', 'emails.value');
    mocks.resolveBinding.mockResolvedValueOnce({
      ...binding,
      edges: [input],
      graphRules: [
        {
          id: 'email-rule',
          edges: [input],
          transforms: [],
          targetRef: { side: 'destination', namespace: 'authrim.profile', path: 'email' },
          output: { edgeIndex: 0 },
        },
      ],
    });
    await expect(
      applyScimInboundIdentityMapping({
        env: testEnv,
        tenantId: 'tenant-a',
        user: { emails: [{ value: 'ada@example.test' }] },
      })
    ).resolves.toEqual({ email: 'ada@example.test' });
  });

  it.each(ruleOutputCases)('infers the released target for $label', async (scenario) => {
    const email = edge('email', 'emails.value');
    const input = edge('input_value', scenario.sourcePath);
    const transforms = scenario.transforms ?? [];
    const rule: MappingRuleGraph = {
      id: 'independent-rule',
      edges: [input],
      transforms,
      targetRef: { side: 'destination', namespace: 'authrim.profile', path: scenario.targetPath },
      output:
        scenario.output ??
        (transforms.length ? { stepIndex: transforms.length - 1 } : { edgeIndex: 0 }),
    };
    mocks.resolveBinding.mockResolvedValueOnce({
      ...binding,
      edges: [email, input],
      graphRules: [
        {
          id: 'email-rule',
          edges: [email],
          transforms: [],
          targetRef: email.targetRef,
          output: { edgeIndex: 0 },
        },
        rule,
      ],
    });
    const execute = vi.spyOn(mappingRuntime, 'executeRuntimeMapping');
    try {
      const mapped = await applyScimInboundIdentityMapping({
        env: testEnv,
        tenantId: 'tenant-a',
        user: { emails: [{ value: 'ada@example.test' }], ...scenario.user },
      });
      expect(execute.mock.results[0]?.value).toMatchObject({ status: 'success', reasons: [] });
      const { custom_attributes_json, ...fields } = mapped;
      expect(fields).toEqual({ email: 'ada@example.test', ...scenario.expected });
      expect(custom_attributes_json ? JSON.parse(custom_attributes_json) : undefined).toEqual(
        scenario.custom
      );
      expect(execute.mock.calls[0]?.[0].catalog.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            namespace: 'authrim.profile',
            path: scenario.targetPath,
            ...scenario.shape,
          }),
        ])
      );
    } finally {
      execute.mockRestore();
    }
  });

  it.each(['target catalog', 'target reference', 'edge catalog'])(
    'retains declared boolean validation from the %s for incompatible output',
    async (declaration) => {
      const email = edge('email', 'emails.value');
      const input = edge('input_value', 'displayName');
      const target: MappingRuleEdge['targetRef'] = {
        side: 'destination',
        namespace: 'authrim.profile',
        path: 'enabled',
      };
      if (declaration === 'target reference') target.valueType = 'boolean';
      if (declaration !== 'target reference')
        binding.catalog.entries.push({
          id:
            declaration === 'edge catalog'
              ? 'field.canonical.input_value'
              : 'field.canonical.enabled',
          namespace: 'authrim.profile',
          path: declaration === 'edge catalog' ? 'input_value' : 'enabled',
          valueType: 'boolean',
          cardinality: 'single',
          classification: 'internal',
          targetType: 'canonical',
        });
      mocks.resolveBinding.mockResolvedValueOnce({
        ...binding,
        edges: [email, input],
        graphRules: [
          {
            id: 'email-rule',
            edges: [email],
            transforms: [],
            targetRef: email.targetRef,
            output: { edgeIndex: 0 },
          },
          {
            id: 'independent-rule',
            edges: [input],
            transforms: [],
            targetRef: target,
            output: { edgeIndex: 0 },
          },
        ],
      });
      const execute = vi.spyOn(mappingRuntime, 'executeRuntimeMapping');
      try {
        await applyScimInboundIdentityMapping({
          env: testEnv,
          tenantId: 'tenant-a',
          user: { emails: [{ value: 'ada@example.test' }], displayName: 'false' },
        });
        expect(execute.mock.results[0]?.value).toMatchObject({ status: 'partial' });
        expect(execute.mock.results[0]?.value).toHaveProperty(
          'reasons',
          expect.arrayContaining([expect.objectContaining({ code: 'validation.type_mismatch' })])
        );
        expect(execute.mock.calls[0]?.[0].catalog.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              namespace: 'authrim.profile',
              path: 'enabled',
              valueType: 'boolean',
              cardinality: 'single',
            }),
          ])
        );
      } finally {
        execute.mockRestore();
      }
    }
  );

  it('evaluates a named multi-input chain through the SCIM receiver', async () => {
    const email = edge('email', 'emails.value');
    const given = edge('nickname', 'name.givenName');
    const family = { ...edge('nickname', 'name.familyName'), id: 'edge-family' };
    mocks.resolveBinding.mockResolvedValueOnce({
      ...binding,
      edges: [email, given, family],
      graphRules: [
        {
          id: 'email',
          edges: [email],
          transforms: [],
          targetRef: email.targetRef,
          output: { edgeIndex: 0 },
        },
        {
          id: 'nickname',
          edges: [given, family],
          targetRef: given.targetRef,
          transforms: [
            {
              id: 'concat',
              operation: 'concat',
              parameters: { delimiter: ' ' },
              inputs: [
                { edgeIndex: 0, name: 'given' },
                { edgeIndex: 1, name: 'family' },
              ],
            },
            { id: 'trim', operation: 'trim', inputs: [{ stepIndex: 0 }] },
          ],
          output: { stepIndex: 1 },
        },
      ],
    });
    const mapped = await applyScimInboundIdentityMapping({
      env: testEnv,
      tenantId: 'tenant-a',
      user: {
        emails: [{ value: 'ada@example.test', primary: true }],
        name: { givenName: ' Ada', familyName: 'Lovelace ' },
      },
    });
    expect(mapped).toMatchObject({ email: 'ada@example.test', nickname: 'Ada Lovelace' });
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
      env: testEnv,
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
      env: testEnv,
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
        env: testEnv,
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
