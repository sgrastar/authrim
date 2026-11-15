import { describe, expect, it } from 'vitest';
import { dryRunMapping } from '../../core/dry-run';
import { executeRuntimeMapping } from '../../core/runtime';
import { persistentIdentifierSettingsProblem, validateTransformStep } from '../../core/transforms';
import type { MappingInput, MappingTransformStep } from '../../core/types';
import { mappingInput, sourceValue } from '../../test-support';

const BASE = { input: 'account', format: 'plain', algorithm: 'authrim_sha256' };

/**
 * The step takes no input edge: it writes into the OIDC email claim, which the catalog lists, and
 * the mapping's own email edge goes to another target.
 */
function withIdentifier(
  identifiers: Record<string, unknown> | undefined,
  overrides: Partial<MappingTransformStep> = {}
): MappingInput {
  const input = mappingInput([sourceValue('csv', 'email', 'jdoe@example.test', 'pii')]);
  input.transforms = [
    {
      id: 'step.identifier',
      operation: 'persistent_identifier',
      inputEdgeIds: [],
      parameters: BASE,
      outputTargetRef: {
        side: 'destination',
        namespace: 'oidc.claim',
        path: 'email',
        catalogEntryId: 'field.oidc.email',
      },
      ...overrides,
    },
  ];
  input.runtimeContext = identifiers ? { identifiers } : undefined;
  return input;
}

const released = (input: MappingInput) =>
  executeRuntimeMapping(input).values.filter((value) => value.sourceRef.namespace === 'oidc.claim');

describe('persistent_identifier', () => {
  it('releases the prepared identifier, with no value it was made from in the result', () => {
    const result = executeRuntimeMapping(withIdentifier({ 'step.identifier': 'PAIRWISE-1' }));

    expect(result.status).toBe('success');
    expect(
      released(withIdentifier({ 'step.identifier': 'PAIRWISE-1' })).map((v) => v.value)
    ).toEqual(['PAIRWISE-1']);
    expect(
      JSON.stringify(released(withIdentifier({ 'step.identifier': 'PAIRWISE-1' })))
    ).not.toContain('jdoe@example.test');
  });

  it('fails the whole mapping when no identifier was prepared', () => {
    const result = executeRuntimeMapping(withIdentifier(undefined));

    expect(result.status).toBe('failed');
    expect(result.reasons.map((reason) => reason.code)).toContain(
      'transform.identifier_unavailable'
    );
    expect(released(withIdentifier(undefined))).toEqual([]);
  });

  it('fails when the identifier is empty or not text', () => {
    expect(executeRuntimeMapping(withIdentifier({ 'step.identifier': '' })).status).toBe('failed');
    expect(executeRuntimeMapping(withIdentifier({ 'step.identifier': ['a'] })).status).toBe(
      'failed'
    );
  });

  it('refuses a step that still has an input edge', () => {
    const input = withIdentifier({ 'step.identifier': 'PAIRWISE-1' });
    input.transforms![0].inputEdgeIds = [input.edges[0].id];
    expect(executeRuntimeMapping(input).status).toBe('failed');
    expect(released(input)).toEqual([]);
  });

  it('fails on settings that cannot make an identifier, even with a value prepared', () => {
    for (const parameters of [
      { input: 'account', algorithm: 'authrim_sha256' },
      { input: 'account', format: 'plain', algorithm: 'md5' },
      { ...BASE, salt: 'Bad Name' },
      // An identifier that is the same for every recipient, released as a per-recipient one.
      {
        ...BASE,
        format: 'saml_pairwise_id',
        algorithm: 'simplesamlphp_subject_id',
        scope: 'a.org',
      },
      { ...BASE, format: 'saml_subject_id', algorithm: 'shibboleth', scope: 'example.org' },
      { ...BASE, stored: 'prefer' },
      { ...BASE, format: 'saml_pairwise_id', algorithm: 'shibboleth' },
      // What it is made from.
      { format: 'plain', algorithm: 'authrim_sha256' },
      { ...BASE, input: 'email' },
      { ...BASE, input: 'source' },
      { ...BASE, input: 'source', source: 'Bad Name' },
      { ...BASE, input: 'account', source: 'employee-ids' },
    ]) {
      const result = executeRuntimeMapping(
        withIdentifier({ 'step.identifier': 'PAIRWISE-1' }, { parameters })
      );
      expect(result.status, JSON.stringify(parameters)).toBe('failed');
      expect(released(withIdentifier({ 'step.identifier': 'PAIRWISE-1' }, { parameters }))).toEqual(
        []
      );
    }
  });

  it('takes an identifier source by name', () => {
    expect(
      persistentIdentifierSettingsProblem({ ...BASE, input: 'source', source: 'employee-ids' })
    ).toBeNull();
    expect(persistentIdentifierSettingsProblem(BASE)).toBeNull();
  });

  it("releases nothing when another edge writes into the identifier's output", () => {
    const input = withIdentifier({ 'step.identifier': 'PAIRWISE-1' });
    const [edge] = input.edges;
    input.edges = [
      ...input.edges,
      {
        ...edge,
        id: 'edge.raw',
        targetRef: {
          side: 'destination',
          namespace: 'oidc.claim',
          path: 'email',
          catalogEntryId: 'field.oidc.email',
        },
      },
    ];
    const result = executeRuntimeMapping(input);
    expect(result.status).toBe('failed');
    expect(result.values).toEqual([]);
  });

  it('runs in a dry run as well', () => {
    const result = dryRunMapping(withIdentifier({ 'step.identifier': 'PAIRWISE-1' }));
    expect(result.summary.mappedCount).toBeGreaterThanOrEqual(1);
  });

  it('checks its settings', () => {
    const step = (parameters: Record<string, unknown>): MappingTransformStep => ({
      id: 's',
      operation: 'persistent_identifier',
      inputEdgeIds: [],
      parameters,
      outputTargetRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
    });
    expect(
      validateTransformStep(step({ input: 'account', format: 'plain', algorithm: 'shibboleth' }))
        .reasons
    ).toEqual([]);
    const codes = (parameters: Record<string, unknown>) =>
      validateTransformStep(step(parameters)).reasons.map((reason) => reason.code);
    expect(codes({ input: 'account', algorithm: 'shibboleth' })).toContain(
      'transform.missing_parameter'
    );
    expect(codes({ format: 'plain', algorithm: 'shibboleth' })).toContain(
      'transform.missing_parameter'
    );
    expect(codes({ input: 'account', format: 'plain', algorithm: 'md5' })).toContain(
      'transform.invalid_parameter'
    );
    expect(codes({ ...BASE, secret: 'x' })).toContain('transform.unknown_parameter');
  });

  it('names its list of exceptions, by the same name pattern as a salt', () => {
    expect(persistentIdentifierSettingsProblem({ ...BASE, exceptions: 'old-idp-list' })).toBeNull();
    for (const bad of ['', 'Has Space', 'UPPER', 5, '-x']) {
      expect(persistentIdentifierSettingsProblem({ ...BASE, exceptions: bad })).toBe('exceptions');
    }
    // A step that is made without a salt cannot read a list of salts (every algorithm takes one).
    expect(
      validateTransformStep({
        id: 's',
        operation: 'persistent_identifier',
        inputEdgeIds: [],
        parameters: { ...BASE, exceptions: 'list-a' },
        outputTargetRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
      }).reasons
    ).toEqual([]);
  });

  it('releases nothing, and does not fail, for a step an exception suppressed', () => {
    const input = withIdentifier(undefined);
    input.runtimeContext = { suppressedIdentifiers: { 'step.identifier': true } };
    const result = executeRuntimeMapping(input);

    expect(result.status).toBe('success');
    expect(result.reasons.map((reason) => reason.code)).not.toContain(
      'transform.identifier_unavailable'
    );
    expect(released(input)).toEqual([]);
  });

  it('still fails a step that was neither made nor suppressed', () => {
    const input = withIdentifier(undefined);
    input.runtimeContext = { suppressedIdentifiers: { 'another.step': true } };
    expect(executeRuntimeMapping(input).status).toBe('failed');
  });

  it('reports the same for a dry run as the runtime does, when another step writes a suppressed target', () => {
    const outputTargetRef = {
      side: 'destination' as const,
      namespace: 'oidc.claim',
      path: 'email',
      catalogEntryId: 'field.oidc.email',
    };
    const step = (id: string): MappingTransformStep => ({
      id,
      operation: 'persistent_identifier',
      inputEdgeIds: [],
      parameters: BASE,
      outputTargetRef,
    });
    const input = withIdentifier(undefined);
    input.transforms = [step('blocked'), step('made')];
    const withoutSteps = { ...input, transforms: [] };
    input.runtimeContext = {
      identifiers: { made: 'MADE-FOR-ANOTHER-RULE' },
      suppressedIdentifiers: { blocked: true },
    };

    expect(released(input)).toEqual([]);
    // The dry run counts what the mapping's own edges made, and nothing for the suppressed target.
    expect(dryRunMapping(input).summary.mappedCount).toBe(
      dryRunMapping(withoutSteps).summary.mappedCount
    );
    // Not suppressed: both make the value.
    input.runtimeContext = { identifiers: { made: 'MADE', blocked: 'BLOCKED' } };
    expect(released(input)).not.toEqual([]);
    expect(dryRunMapping(input).summary.mappedCount).toBe(
      dryRunMapping(withoutSteps).summary.mappedCount + 2
    );
  });
});
