import { describe, expect, it } from 'vitest';
import { executeRuntimeMapping } from '../../core/runtime';
import { partitionStoredMappingGraph } from '../../core/stored-graph';
import type { FieldRef, MappingTransformStep } from '../../core/types';
import { mappingInput, sourceValue } from '../../test-support';

describe('stored graph compatibility boundary', () => {
  it('keeps an email edge and an identifier with a different target in compatibility evaluation', () => {
    const input = mappingInput([sourceValue('csv', 'email', 'alice@example.com')]);
    input.edges[0].ruleId = 'mixed-targets';
    const sub: FieldRef = { side: 'destination', namespace: 'oidc.claim', path: 'sub' };
    const transforms: MappingTransformStep[] = [
      {
        id: 'identifier',
        ruleId: 'mixed-targets',
        operation: 'persistent_identifier',
        inputEdgeIds: [],
        outputTargetRef: sub,
        parameters: { input: 'account', format: 'plain', algorithm: 'authrim_sha256' },
      },
    ];
    expect(partitionStoredMappingGraph(input.edges, transforms)).toEqual({
      graphRules: [],
      edges: input.edges,
      transforms,
    });
    const result = executeRuntimeMapping({
      ...input,
      catalog: {
        ...input.catalog,
        entries: [
          ...input.catalog.entries,
          {
            id: 'field.oidc.sub',
            namespace: 'oidc.claim',
            path: 'sub',
            valueType: 'string',
            cardinality: 'single',
            classification: 'internal',
            targetType: 'destination-only',
          },
        ],
      },
      transforms,
      runtimeContext: { identifiers: { identifier: 'subject' } },
    });
    expect(result.status).toBe('success');
    expect(result.values.map((value) => [value.sourceRef.path, value.value])).toEqual([
      ['email', 'alice@example.com'],
      ['sub', 'subject'],
    ]);
  });

  it('retains edge writer order when graph candidates compete with legacy groups and ungrouped rows', () => {
    const input = mappingInput([]);
    const original = input.edges[0];
    const edges = [
      { ...original, id: 'a', ruleId: 'a' },
      { ...original, id: 'b1', ruleId: 'b' },
      { ...original, id: 'b2', ruleId: 'b' },
      { ...original, id: 'c' },
    ].map((edge) => ({
      ...edge,
      sourceRef: { ...edge.sourceRef, path: edge.id, catalogEntryId: `field.csv.${edge.id}` },
    }));
    expect(partitionStoredMappingGraph(edges, []).graphRules.map((rule) => rule.id)).toEqual(['a']);
    const result = executeRuntimeMapping({
      ...input,
      edges,
      sourceValues: edges.map((edge) => sourceValue('csv', edge.id, edge.id)),
      catalog: {
        ...input.catalog,
        entries: [
          ...input.catalog.entries,
          ...edges.map((edge) => ({
            ...input.catalog.entries[0],
            id: `field.csv.${edge.id}`,
            path: edge.id,
          })),
        ],
      },
    });
    expect(result.values.map((value) => value.value)).toEqual(['a', 'b1', 'b2', 'c']);
  });

  it('preserves target-based json_build keys when evaluating stored single-edge rows', () => {
    const input = mappingInput([sourceValue('csv', 'department', 'Engineering')]);
    input.edges = [
      {
        id: 'stored-edge',
        ruleId: 'stored-rule',
        sourceRef: { side: 'source', namespace: 'csv', path: 'department' },
        targetRef: { side: 'canonical', namespace: 'authrim.profile', path: 'profile' },
      },
    ];
    input.catalog = {
      ...input.catalog,
      entries: [
        { ...input.catalog.entries[0], id: 'department', path: 'department' },
        { ...input.catalog.entries[1], id: 'profile', path: 'profile', valueType: 'json' },
      ],
    };
    const result = executeRuntimeMapping({
      ...input,
      transforms: [
        {
          id: 'stored-json-build',
          ruleId: 'stored-rule',
          operation: 'json_build',
          parameters: { nullHandling: 'omit' },
          inputEdgeIds: ['stored-edge'],
          outputTargetRef: input.edges[0].targetRef,
        },
      ],
    });
    expect(result.reasons).toEqual([]);
    expect(result.values.map((value) => value.value)).toEqual([{ profile: 'Engineering' }]);
    expect(input.sourceValues[0].sourceRef.path).toBe('department');
  });

  it('retains transform writer order across graph candidates and legacy writers', () => {
    const input = mappingInput([]);
    const target = input.edges[0].targetRef;
    const transforms: MappingTransformStep[] = ['a', 'b', 'c'].map((id) => ({
      id,
      ruleId: id === 'b' ? undefined : id,
      operation: 'persistent_identifier',
      inputEdgeIds: [],
      outputTargetRef: target,
      parameters: { input: 'account', format: 'plain', algorithm: 'authrim_sha256' },
    }));
    // An unrelated graph still exercises the path that combines compatibility and graph results.
    transforms.push({
      ...transforms[0],
      id: 'independent',
      ruleId: 'independent',
      outputTargetRef: { side: 'destination', namespace: 'oidc.claim', path: 'email' },
    });
    const result = executeRuntimeMapping({
      ...input,
      edges: [],
      transforms,
      runtimeContext: { identifiers: { a: 'A', b: 'B', c: 'C', independent: 'D' } },
    });
    expect(result.values.map((value) => value.value)).toEqual(['A', 'B', 'C', 'D']);
  });
});
