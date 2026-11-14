import { describe, expect, it } from 'vitest';
import { dryRunMapping } from '../../core/dry-run';
import { executeRuntimeMapping } from '../../core/runtime';
import { validateTransformStep } from '../../core/transforms';
import type { MappingInput, MappingTransformStep } from '../../core/types';
import { mappingInput, sourceValue } from '../../test-support';

/** The email edge feeds an identifier written to the same target: the email must not go out. */
function withIdentifier(
  identifiers: Record<string, unknown> | undefined,
  overrides: Partial<MappingTransformStep> = {}
): MappingInput {
  const input = mappingInput([sourceValue('csv', 'email', 'jdoe@example.test', 'pii')]);
  const [edge] = input.edges;
  input.transforms = [
    {
      id: 'step.identifier',
      operation: 'persistent_identifier',
      inputEdgeIds: [edge.id],
      parameters: { format: 'plain', algorithm: 'authrim_sha256' },
      outputTargetRef: edge.targetRef,
      ...overrides,
    },
  ];
  input.runtimeContext = identifiers ? { identifiers } : undefined;
  return input;
}

describe('persistent_identifier', () => {
  it('releases the prepared identifier and never the value it was made from', () => {
    const result = executeRuntimeMapping(withIdentifier({ 'step.identifier': 'PAIRWISE-1' }));

    expect(result.status).toBe('success');
    expect(result.values.map((value) => value.value)).toEqual(['PAIRWISE-1']);
    expect(JSON.stringify(result)).not.toContain('jdoe@example.test');
  });

  it('fails the whole mapping when no identifier was prepared', () => {
    const result = executeRuntimeMapping(withIdentifier(undefined));

    expect(result.status).toBe('failed');
    expect(result.reasons.map((reason) => reason.code)).toContain(
      'transform.identifier_unavailable'
    );
    expect(result.values).toEqual([]);
  });

  it('fails when the identifier is empty or not text', () => {
    expect(executeRuntimeMapping(withIdentifier({ 'step.identifier': '' })).status).toBe('failed');
    expect(executeRuntimeMapping(withIdentifier({ 'step.identifier': ['a'] })).status).toBe(
      'failed'
    );
  });

  it('fails when its input is missing, even if a value was prepared', () => {
    const input = withIdentifier({ 'step.identifier': 'PAIRWISE-1' });
    input.sourceValues = [];
    const result = executeRuntimeMapping(input);

    expect(result.status).toBe('failed');
    expect(result.values).toEqual([]);
  });

  it('needs exactly one input', () => {
    const none = executeRuntimeMapping(
      withIdentifier({ 'step.identifier': 'PAIRWISE-1' }, { inputEdgeIds: [] })
    );
    expect(none.status).toBe('failed');
  });

  it('fails on settings that cannot make an identifier, even with a value prepared', () => {
    for (const parameters of [
      { algorithm: 'authrim_sha256' },
      { format: 'plain', algorithm: 'md5' },
      { format: 'plain', algorithm: 'authrim_sha256', salt: 'Bad Name' },
      // An identifier that is the same for every recipient, released as a per-recipient one.
      { format: 'saml_pairwise_id', algorithm: 'simplesamlphp_subject_id', scope: 'example.org' },
      { format: 'saml_subject_id', algorithm: 'shibboleth', scope: 'example.org' },
      { format: 'plain', algorithm: 'authrim_sha256', stored: 'prefer' },
      { format: 'saml_pairwise_id', algorithm: 'shibboleth' },
    ]) {
      const result = executeRuntimeMapping(
        withIdentifier({ 'step.identifier': 'PAIRWISE-1' }, { parameters })
      );
      expect(result.status, JSON.stringify(parameters)).toBe('failed');
      expect(result.values).toEqual([]);
    }
  });

  it('releases nothing when another step reads the same input', () => {
    const input = withIdentifier({ 'step.identifier': 'PAIRWISE-1' });
    const [edge] = input.edges;
    input.transforms = [
      ...(input.transforms ?? []),
      {
        id: 'step.trim',
        operation: 'trim',
        inputEdgeIds: [edge.id],
        parameters: {},
        outputTargetRef: edge.targetRef,
      },
    ];
    const result = executeRuntimeMapping(input);
    expect(result.status).toBe('failed');
    expect(result.values).toEqual([]);
    expect(JSON.stringify(result.values)).not.toContain('jdoe@example.test');
  });

  it("releases nothing when another edge writes into the identifier's output", () => {
    const input = withIdentifier({ 'step.identifier': 'PAIRWISE-1' });
    const [edge] = input.edges;
    input.edges = [...input.edges, { ...edge, id: 'edge.raw' }];
    const result = executeRuntimeMapping(input);
    expect(result.status).toBe('failed');
    expect(result.values).toEqual([]);
  });

  it('keeps the input out of a dry run as well', () => {
    const result = dryRunMapping(withIdentifier({ 'step.identifier': 'PAIRWISE-1' }));
    expect(result.summary.mappedCount).toBe(1);
  });

  it('checks its settings', () => {
    const step = (parameters: Record<string, unknown>): MappingTransformStep => ({
      id: 's',
      operation: 'persistent_identifier',
      inputEdgeIds: ['e'],
      parameters,
      outputTargetRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
    });
    expect(
      validateTransformStep(step({ format: 'plain', algorithm: 'shibboleth' })).reasons
    ).toEqual([]);
    const codes = (parameters: Record<string, unknown>) =>
      validateTransformStep(step(parameters)).reasons.map((reason) => reason.code);
    expect(codes({ algorithm: 'shibboleth' })).toContain('transform.missing_parameter');
    expect(codes({ format: 'plain', algorithm: 'md5' })).toContain('transform.invalid_parameter');
    expect(codes({ format: 'plain', algorithm: 'shibboleth', secret: 'x' })).toContain(
      'transform.unknown_parameter'
    );
  });
});
