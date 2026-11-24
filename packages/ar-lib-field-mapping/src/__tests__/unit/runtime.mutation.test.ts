import { describe, expect, it, vi } from 'vitest';
import {
  executePreparedRuntimeMapping,
  executeRuntimeMapping,
  lastWriterMappingValues,
} from '../../core/runtime';
import { TEST_CATALOG, sourceValue } from '../../test-support';
import type {
  FieldRef,
  MappingEvaluationValue,
  MappingGraphTransform,
  MappingInput,
  MappingRuleGraph,
  MappingValueReference,
  SourceValueEnvelope,
  TransformOperation,
  ValidationRule,
} from '../../core/types';

const emailSource: FieldRef = { side: 'source', namespace: 'csv', path: 'email' };
const numberSource: FieldRef = { side: 'source', namespace: 'csv', path: 'employeeNumber' };
const unknownSource: FieldRef = { side: 'source', namespace: 'nowhere', path: 'field' };
const emailTarget: FieldRef = { side: 'canonical', namespace: 'authrim.profile', path: 'email' };
const mailTarget: FieldRef = { side: 'destination', namespace: 'saml.attribute', path: 'mail' };
const unknownTarget: FieldRef = { side: 'destination', namespace: 'nowhere', path: 'target' };

function step(
  id: string,
  operation: TransformOperation,
  inputs: MappingValueReference[],
  parameters?: Record<string, unknown>
): MappingGraphTransform {
  return { id, operation, inputs, ...(parameters ? { parameters } : {}) };
}

function rule(
  id: string,
  sources: FieldRef[],
  targetRef: FieldRef,
  transforms: MappingGraphTransform[] = [],
  output: MappingValueReference = { edgeIndex: 0 },
  extra: Partial<MappingRuleGraph> = {}
): MappingRuleGraph {
  return {
    id,
    targetRef,
    edges: sources.map((sourceRef, index) => ({ id: `${id}.e${index}`, sourceRef, targetRef })),
    transforms,
    output,
    ...extra,
  };
}

function input(
  graphRules: MappingRuleGraph[] | undefined,
  sourceValues: SourceValueEnvelope[] = [],
  extra: Partial<MappingInput> = {}
): MappingInput {
  return { catalog: TEST_CATALOG, sourceValues, edges: [], graphRules, ...extra };
}

function released(result: { values: SourceValueEnvelope[] }): unknown[] {
  return result.values.map((value) => value.value);
}

function codes(result: { reasons: Array<{ code: string }> }): string[] {
  return result.reasons.map((item) => item.code);
}

describe('lastWriterMappingValues', () => {
  const ref = (side: FieldRef['side'], namespace: string, path: string): FieldRef => ({
    side,
    namespace,
    path,
  });

  it('keeps one value per side, namespace and path, with the last writer winning', () => {
    const values: SourceValueEnvelope[] = [
      { value: 'a1', sourceRef: ref('source', 'ns', 'a') },
      { value: 'b', sourceRef: ref('source', 'ns', 'b') },
      { value: 'other-side', sourceRef: ref('destination', 'ns', 'a') },
      { value: 'other-ns', sourceRef: ref('source', 'other', 'a') },
      { value: 'a2', sourceRef: ref('source', 'ns', 'a') },
    ];
    expect(lastWriterMappingValues(values).map((value) => value.value)).toEqual([
      'a2',
      'b',
      'other-side',
      'other-ns',
    ]);
  });

  it('does not merge references whose joined parts would look alike', () => {
    const values: SourceValueEnvelope[] = [
      { value: 1, sourceRef: ref('source', 'a', 'b.c') },
      { value: 2, sourceRef: ref('source', 'a.b', 'c') },
    ];
    expect(lastWriterMappingValues(values).map((value) => value.value)).toEqual([1, 2]);
  });

  it('returns nothing for no values', () => {
    expect(lastWriterMappingValues([])).toEqual([]);
  });
});

describe('executeRuntimeMapping graph requirements', () => {
  it('maps a rule graph to the released target value', () => {
    const result = executeRuntimeMapping(
      input(
        [rule('r', [emailSource], emailTarget)],
        [sourceValue('csv', 'email', 'a@example.test')]
      )
    );
    expect(result.status).toBe('success');
    expect(result.reasons).toEqual([]);
    expect(result.values).toHaveLength(1);
    expect(result.values[0]).toMatchObject({ value: 'a@example.test', sourceRef: emailTarget });
    expect('deferredTargets' in result).toBe(false);
  });

  it('succeeds without graph rules when nothing is bound', () => {
    const result = executeRuntimeMapping(input(undefined, [sourceValue('csv', 'email', 'a')]));
    expect(result.status).toBe('success');
    expect(result.reasons).toEqual([]);
    expect(result.values).toEqual([]);
    expect(result.ruleTrace).toEqual([]);
  });

  it('succeeds with an empty transform list and no graph rules', () => {
    const result = executeRuntimeMapping({ ...input(undefined), transforms: [] });
    expect(result.status).toBe('success');
    expect(result.values).toEqual([]);
  });

  it('refuses flat edges without explicit graph rules', () => {
    const result = executeRuntimeMapping({
      ...input(undefined),
      edges: [{ id: 'flat', sourceRef: emailSource, targetRef: emailTarget }],
    });
    expect(result).toEqual({
      status: 'failed',
      values: [],
      reasons: [
        { category: 'transform', code: 'transform.invalid_reference', severity: 'critical' },
      ],
      ruleTrace: [],
    });
  });

  it('refuses flat transforms without explicit graph rules', () => {
    const result = executeRuntimeMapping({
      ...input(undefined),
      transforms: [
        { id: 'flat', inputEdgeIds: [], operation: 'trim', outputTargetRef: emailTarget },
      ],
    });
    expect(result.status).toBe('failed');
    expect(codes(result)).toEqual(['transform.invalid_reference']);
  });

  it('ignores flat edges when explicit graph rules are present', () => {
    const result = executeRuntimeMapping({
      ...input([rule('r', [emailSource], emailTarget)], [sourceValue('csv', 'email', 'a')]),
      edges: [{ id: 'flat', sourceRef: emailSource, targetRef: emailTarget }],
    });
    expect(result.status).toBe('success');
    expect(released(result)).toEqual(['a']);
  });
});

describe('executeRuntimeMapping persistent identifiers', () => {
  const identifier = step('pid', 'persistent_identifier', [], {
    input: 'account',
    format: 'plain',
    algorithm: 'authrim_sha256',
  });
  const identifierRule = (target: FieldRef, id = 'pid-rule') =>
    rule(id, [], target, [identifier], { stepIndex: 0 });
  const runtimeContext = { identifiers: { pid: 'identifier-value' } };

  it('releases an identifier rule without inputs on a unique target', () => {
    const result = executeRuntimeMapping(
      input([identifierRule(emailTarget)], [], { runtimeContext })
    );
    expect(result.status).toBe('success');
    expect(released(result)).toEqual(['identifier-value']);
  });

  it('refuses an identifier step that reads inputs', () => {
    const withInput = rule(
      'pid-rule',
      [emailSource],
      emailTarget,
      [step('pid', 'persistent_identifier', [{ edgeIndex: 0 }], identifier.parameters)],
      { stepIndex: 0 }
    );
    const result = executeRuntimeMapping(
      input([withInput], [sourceValue('csv', 'email', 'a')], { runtimeContext })
    );
    expect(result.status).toBe('failed');
    expect(result.values).toEqual([]);
    expect(codes(result)).toContain('transform.identifier_unavailable');
  });

  it('refuses an identifier step that reads inputs even next to other steps', () => {
    const mixed = rule(
      'pid-rule',
      [emailSource],
      emailTarget,
      [
        step('pid', 'persistent_identifier', [{ edgeIndex: 0 }], identifier.parameters),
        step('other', 'trim', [{ edgeIndex: 0 }]),
      ],
      { stepIndex: 1 }
    );
    const result = executeRuntimeMapping(
      input([mixed], [sourceValue('csv', 'email', 'a')], { runtimeContext })
    );
    expect(result.status).toBe('failed');
    expect(codes(result)).toEqual(['transform.identifier_unavailable']);
  });

  it('allows steps after an identifier step that reads nothing', () => {
    const followed = rule(
      'pid-rule',
      [],
      emailTarget,
      [identifier, step('after', 'trim', [{ stepIndex: 0 }])],
      { stepIndex: 1 }
    );
    const result = executeRuntimeMapping(input([followed], [], { runtimeContext }));
    expect(result.status).toBe('success');
    expect(released(result)).toEqual(['identifier-value']);
  });

  it('refuses an identifier rule that shares its target with another rule', () => {
    const other = rule('other', [emailSource], emailTarget);
    for (const rules of [
      [identifierRule(emailTarget), other],
      [other, identifierRule(emailTarget)],
    ]) {
      const result = executeRuntimeMapping(
        input(rules, [sourceValue('csv', 'email', 'a')], { runtimeContext })
      );
      expect(result.status).toBe('failed');
      expect(result.values).toEqual([]);
      expect(codes(result)).toEqual(['transform.identifier_unavailable']);
    }
  });

  it('allows an identifier rule next to a rule for another target', () => {
    const result = executeRuntimeMapping(
      input(
        [identifierRule(emailTarget), rule('other', [emailSource], mailTarget)],
        [sourceValue('csv', 'email', 'a')],
        { runtimeContext }
      )
    );
    expect(result.status).toBe('success');
    expect(released(result)).toEqual(['identifier-value', 'a']);
  });
});

describe('executeRuntimeMapping targets', () => {
  const values = [
    sourceValue('csv', 'email', 'first'),
    sourceValue('csv', 'employeeNumber', 'second'),
  ];

  it('refuses two rules writing the same target without a writer order', () => {
    const result = executeRuntimeMapping(
      input(
        [rule('one', [emailSource], emailTarget), rule('two', [numberSource], emailTarget)],
        values
      )
    );
    expect(result.status).toBe('failed');
    expect(result.values).toEqual([]);
    expect(codes(result)).toEqual(['transform.duplicate_target']);
  });

  it('lets the last writer win when later rules carry a writer order', () => {
    const result = executeRuntimeMapping(
      input(
        [
          rule('one', [emailSource], emailTarget),
          rule('two', [numberSource], emailTarget, [], { edgeIndex: 0 }, { writerOrder: 1 }),
        ],
        values
      )
    );
    expect(result.status).toBe('success');
    expect(released(result)).toEqual(['first', 'second']);
    expect(result.values.map((value) => value.sourceRef)).toEqual([emailTarget, emailTarget]);
  });

  it('accepts rules whose targets differ in side, namespace or path only', () => {
    const sameNamespace: FieldRef = { ...emailTarget, path: 'name' };
    const otherSide: FieldRef = { ...emailTarget, side: 'destination' };
    const result = executeRuntimeMapping(
      input(
        [
          rule('one', [emailSource], emailTarget),
          rule('two', [emailSource], mailTarget),
          rule('three', [emailSource], sameNamespace),
          rule('four', [emailSource], otherSide),
        ],
        values
      )
    );
    expect(codes(result)).not.toContain('transform.duplicate_target');
    expect(result.status).not.toBe('failed');
  });

  it('keeps independent targets', () => {
    const result = executeRuntimeMapping(
      input(
        [rule('one', [emailSource], emailTarget), rule('two', [numberSource], mailTarget)],
        values
      )
    );
    expect(result.status).toBe('success');
    expect(result.values.map((value) => [value.sourceRef, value.value])).toEqual([
      [emailTarget, 'first'],
      [mailTarget, 'second'],
    ]);
  });
});

describe('executeRuntimeMapping catalog checks', () => {
  const email = [sourceValue('csv', 'email', 'a')];

  it('flags a target that is not in the catalog and releases nothing for it', () => {
    const result = executeRuntimeMapping(input([rule('r', [emailSource], unknownTarget)], email));
    expect(codes(result)).toEqual(['catalog.invalid_entry']);
    expect(result.values).toEqual([]);
    expect(result.status).toBe('partial');
  });

  it('flags a source edge that is not in the catalog by default', () => {
    const result = executeRuntimeMapping(
      input([rule('r', [unknownSource], emailTarget)], [sourceValue('nowhere', 'field', 'a')])
    );
    expect(codes(result)).toContain('catalog.invalid_entry');
    expect(result.values).toEqual([]);
  });

  it('treats the catalog source mode like the default', () => {
    const result = executeRuntimeMapping(
      input([rule('r', [unknownSource], emailTarget)], [], { sourceCatalogValidation: 'catalog' })
    );
    expect(codes(result)).toContain('catalog.invalid_entry');
    expect(result.values).toEqual([]);
  });

  it('lets receivers read sources the catalog does not know', () => {
    const result = executeRuntimeMapping(
      input([rule('r', [unknownSource], emailTarget)], [sourceValue('nowhere', 'field', 'a')], {
        sourceCatalogValidation: 'receiver',
      })
    );
    expect(released(result)).toEqual(['a']);
    expect(codes(result)).toEqual(['catalog.invalid_entry']);
  });

  it('still refuses unknown targets for receivers', () => {
    const result = executeRuntimeMapping(
      input([rule('r', [emailSource], unknownTarget)], email, {
        sourceCatalogValidation: 'receiver',
      })
    );
    expect(result.values).toEqual([]);
    expect(codes(result)).toContain('catalog.invalid_entry');
  });

  it('flags every unknown source among several edges', () => {
    const result = executeRuntimeMapping(
      input(
        [rule('r', [emailSource, unknownSource], emailTarget)],
        [sourceValue('csv', 'email', 'a')]
      )
    );
    expect(result.values).toEqual([]);
    expect(codes(result)).toContain('catalog.invalid_entry');
  });
});

describe('executeRuntimeMapping classification', () => {
  it('applies catalog classifications of absent source edges to the result', () => {
    const combine = rule(
      'r',
      [numberSource, emailSource],
      mailTarget,
      [step('join', 'concat', [{ edgeIndex: 0 }, { edgeIndex: 1 }])],
      { stepIndex: 0 }
    );
    const result = executeRuntimeMapping(input([combine], [sourceValue('csv', 'email', 'a')]));
    expect(result.values[0]).toMatchObject({ value: 'a', classificationHint: 'regulated' });
  });

  it('strengthens a value hint with the catalog classification', () => {
    const result = executeRuntimeMapping(
      input([rule('r', [emailSource], emailTarget)], [sourceValue('csv', 'email', 'a', 'secret')])
    );
    expect(result.values[0]).toMatchObject({ classificationHint: 'secret' });
    const plain = executeRuntimeMapping(
      input([rule('r', [emailSource], emailTarget)], [sourceValue('csv', 'email', 'a', 'public')])
    );
    expect(plain.values[0]).toMatchObject({ classificationHint: 'pii' });
  });
});

describe('executeRuntimeMapping deferred outputs', () => {
  const deferredRule = rule(
    'r',
    [emailSource],
    emailTarget,
    [step('consent', 'copy', [{ edgeIndex: 0 }])],
    { stepIndex: 0 }
  );
  const prepared = new Map<string, MappingEvaluationValue>([['consent', { kind: 'deferred' }]]);
  const email = [sourceValue('csv', 'email', 'a')];

  it('reports a deferred output as an error unless deferral is allowed', () => {
    const result = executeRuntimeMapping(input([deferredRule], email, { preparedSteps: prepared }));
    expect(result.status).toBe('failed');
    expect(codes(result)).toEqual(['transform.deferred_output']);
    expect(result.values).toEqual([]);
    expect(result.deferredTargets).toEqual([emailTarget]);
  });

  it('keeps a deferred output pending when deferral is allowed', () => {
    const result = executeRuntimeMapping(
      input([deferredRule], email, { preparedSteps: prepared, allowDeferredOutputs: true })
    );
    expect(result.status).toBe('success');
    expect(result.reasons).toEqual([]);
    expect(result.values).toEqual([]);
    expect(result.deferredTargets).toEqual([emailTarget]);
  });

  it('skips validation of deferred targets but keeps validating everything else', () => {
    const rules: ValidationRule[] = [
      { id: 'required.target', kind: 'required', targetRef: emailTarget },
      { id: 'required.other', kind: 'required', targetRef: mailTarget },
    ];
    const result = executeRuntimeMapping(
      input([deferredRule], email, {
        preparedSteps: prepared,
        allowDeferredOutputs: true,
        validationRules: rules,
      })
    );
    expect(codes(result)).toEqual(['validation.required_missing']);
    expect(
      result.ruleTrace.filter((entry) => entry.reason.code === 'validation.required_missing')
    ).toHaveLength(1);
  });
});

describe('executeRuntimeMapping validation of released values', () => {
  const required = (targetRef: FieldRef): ValidationRule => ({
    id: `required.${targetRef.path}`,
    kind: 'required',
    targetRef,
  });

  it('does not let original values of an output target satisfy its validation', () => {
    const original: SourceValueEnvelope = {
      value: 'original',
      sourceRef: emailTarget,
    };
    const result = executeRuntimeMapping(
      input(
        [rule('one', [emailSource], emailTarget), rule('two', [numberSource], mailTarget)],
        [original, { ...original, sourceRef: mailTarget }],
        { validationRules: [required(emailTarget), required(mailTarget)] }
      )
    );
    expect(codes(result).filter((code) => code === 'validation.required_missing')).toHaveLength(2);
  });

  it('keeps original values that are not an output target', () => {
    const result = executeRuntimeMapping(
      input(
        [rule('one', [emailSource], emailTarget), rule('two', [numberSource], mailTarget)],
        [
          sourceValue('csv', 'email', 'a'),
          sourceValue('csv', 'employeeNumber', 'n'),
          {
            value: 'kept',
            sourceRef: { side: 'canonical', namespace: 'saml.attribute', path: 'mail' },
          },
        ],
        { validationRules: [required(emailTarget), required(mailTarget), required(emailSource)] }
      )
    );
    expect(codes(result)).toEqual([]);
  });

  it('records validation traces next to the rule traces', () => {
    const result = executeRuntimeMapping(
      input([rule('r', [emailSource], emailTarget)], [], {
        validationRules: [required(emailTarget)],
      })
    );
    expect(codes(result)).toEqual(['validation.required_missing']);
    expect(result.status).toBe('failed');
    expect(result.ruleTrace.map((entry) => entry.reason.code)).toContain(
      'validation.required_missing'
    );
  });

  it('lets a custom resolver choose the values that validation sees', () => {
    const result = executeRuntimeMapping(
      input(
        [
          rule('one', [emailSource], emailTarget),
          rule('two', [numberSource], emailTarget, [], { edgeIndex: 0 }, { writerOrder: 1 }),
        ],
        [sourceValue('csv', 'email', 'a'), sourceValue('csv', 'employeeNumber', '')],
        {
          validationRules: [required(emailTarget)],
          resolveValidationValues: (values) => values.slice(0, 1),
        }
      )
    );
    expect(codes(result)).toEqual([]);
    const defaulted = executeRuntimeMapping(
      input(
        [
          rule('one', [emailSource], emailTarget),
          rule('two', [numberSource], emailTarget, [], { edgeIndex: 0 }, { writerOrder: 1 }),
        ],
        [sourceValue('csv', 'email', 'a'), sourceValue('csv', 'employeeNumber', '')],
        { validationRules: [required(emailTarget)] }
      )
    );
    expect(codes(defaulted)).toEqual(['validation.required_missing']);
  });
});

describe('executePreparedRuntimeMapping', () => {
  const hashRule = rule(
    'r',
    [emailSource],
    emailTarget,
    [step('digest', 'hash', [{ edgeIndex: 0 }], { encoding: 'hex' })],
    { stepIndex: 0 }
  );

  it('releases the prepared value of an asynchronous step', async () => {
    const prepare = vi.fn(
      async (): Promise<MappingEvaluationValue> => ({
        kind: 'value',
        envelope: { value: 'digest-value', sourceRef: emailSource },
      })
    );
    const result = await executePreparedRuntimeMapping(
      input([hashRule], [sourceValue('csv', 'email', 'a')]),
      prepare
    );
    expect(result.status).toBe('success');
    expect(released(result)).toEqual(['digest-value']);
    expect(result.values[0]).toMatchObject({ sourceRef: emailTarget, classificationHint: 'pii' });
  });

  it('reports an unavailable hash when preparation fails', async () => {
    const result = await executePreparedRuntimeMapping(
      input([hashRule], [sourceValue('csv', 'email', 'a')]),
      async () => ({ kind: 'failed' })
    );
    expect(result.status).toBe('failed');
    expect(codes(result)).toContain('transform.hash_unavailable');
    expect(result.values).toEqual([]);
  });

  it('evaluates every rule once and applies the runtime checks', async () => {
    const seen: string[] = [];
    const rules = [
      hashRule,
      rule(
        'second',
        [numberSource],
        mailTarget,
        [step('digest2', 'hash', [{ edgeIndex: 0 }], { encoding: 'hex' })],
        { stepIndex: 0 }
      ),
    ];
    const result = await executePreparedRuntimeMapping(
      input(rules, [sourceValue('csv', 'email', 'a'), sourceValue('csv', 'employeeNumber', 'n')]),
      async ({ step: prepared }) => {
        seen.push(prepared.id);
        return { kind: 'value', envelope: { value: `h:${prepared.id}`, sourceRef: emailSource } };
      }
    );
    expect(seen).toEqual(['digest', 'digest2']);
    expect(released(result)).toEqual(['h:digest', 'h:digest2']);
    const duplicate = await executePreparedRuntimeMapping(
      input([hashRule, { ...hashRule, id: 'again' }], [sourceValue('csv', 'email', 'a')]),
      async () => ({ kind: 'failed' })
    );
    expect(duplicate.status).toBe('failed');
    expect(duplicate.values).toEqual([]);
    expect(codes(duplicate)).toContain('transform.duplicate_target');
  });

  it('passes the runtime context and prepared steps to the evaluation', async () => {
    const identifierRule = rule(
      'pid-rule',
      [],
      emailTarget,
      [
        step('pid', 'persistent_identifier', [], {
          input: 'account',
          format: 'plain',
          algorithm: 'authrim_sha256',
        }),
      ],
      { stepIndex: 0 }
    );
    const fromContext = await executePreparedRuntimeMapping(
      input([identifierRule], [], { runtimeContext: { identifiers: { pid: 'ctx' } } }),
      async () => ({ kind: 'failed' })
    );
    expect(released(fromContext)).toEqual(['ctx']);
    const suppressed = await executePreparedRuntimeMapping(
      input([identifierRule], [], {
        runtimeContext: { identifiers: { pid: 'ctx' }, suppressedIdentifiers: { pid: true } },
      }),
      async () => ({ kind: 'failed' })
    );
    expect(suppressed.values).toEqual([]);
    const preparedStep = await executePreparedRuntimeMapping(
      input([hashRule], [sourceValue('csv', 'email', 'a')], {
        preparedSteps: new Map<string, MappingEvaluationValue>([
          ['digest', { kind: 'value', envelope: { value: 'from-map', sourceRef: emailSource } }],
        ]),
      }),
      async () => ({ kind: 'failed' })
    );
    expect(released(preparedStep)).toEqual(['from-map']);
  });

  it('uses edge target references when the rule asks for them', async () => {
    const targetKeyed = {
      ...hashRule,
      edgeValueReferences: 'target' as const,
    };
    let seenRef: FieldRef | undefined;
    await executePreparedRuntimeMapping(
      input([targetKeyed], [sourceValue('csv', 'email', 'a')]),
      async ({ inputs }) => {
        const first = inputs[0];
        if (first?.kind === 'value') seenRef = first.envelope.sourceRef;
        return { kind: 'failed' };
      }
    );
    expect(seenRef).toEqual(emailTarget);
  });

  it('succeeds without graph rules', async () => {
    const result = await executePreparedRuntimeMapping(input(undefined), async () => ({
      kind: 'failed',
    }));
    expect(result.status).toBe('success');
    expect(result.values).toEqual([]);
  });
});
