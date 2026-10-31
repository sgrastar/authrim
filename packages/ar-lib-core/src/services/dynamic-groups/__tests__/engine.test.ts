import { describe, expect, it } from 'vitest';
import { compileGroups, evaluateGroupInputDelta, evaluateGroups, recomputeGroups } from '../engine';
import {
  BUILTIN_GROUP_FIELDS,
  type EvaluationInput,
  type Expression,
  type ServiceGroup,
} from '../model';
const attr = (field: string, value: string): Expression => ({
  op: 'attribute',
  field,
  compare: 'eq',
  value,
});
const member = (groupId: string): Expression => ({ op: 'member', groupId });
const group = (id: string, condition: Expression | null): ServiceGroup => ({
  id,
  tenantId: 't',
  key: id.toLowerCase(),
  displayName: id,
  description: '',
  enabled: true,
  condition,
});
const fields = { ...BUILTIN_GROUP_FIELDS, 'custom.contract': { type: 'string' as const } };
const groups = [
  group('A', attr('email_domain', 'example.com')),
  group('B', { op: 'all', args: [member('A'), attr('country', 'JP')] }),
  group('C', { op: 'all', args: [member('B'), attr('custom.contract', 'active')] }),
  group('D', { op: 'any', args: [member('B'), member('C')] }),
  group('E', { op: 'not', arg: member('D') }),
];
describe('service group condition compilation and incremental evaluation', () => {
  it('matches independent full recomputation across repeated simultaneous changes, branches and joins', () => {
    const plan = compileGroups('t', groups, fields);
    let prior: ReturnType<typeof evaluateGroups> | undefined;
    // Deterministic exhaustive state transitions including missing, malformed and null values.
    const domains = ['example.com', 'EXAMPLE.COM', 'other.com', null, 12, undefined];
    const countries = ['jp', 'US', null, undefined];
    for (let pass = 0; pass < 2; pass++)
      for (const domain of domains)
        for (const country of countries)
          for (const contract of ['active', 'closed', undefined]) {
            const input: EvaluationInput = {
              attributes: { email_domain: domain, country, 'custom.contract': contract },
              sources: {},
            };
            const result = evaluateGroupInputDelta(plan, input, prior);
            expect(result.groups).toEqual(recomputeGroups(plan, input));
            prior = result;
          }
  });
  it('does not let NOT turn unknown or a missing external source into membership', () => {
    const plan = compileGroups(
      't',
      [group('A', attr('country', 'JP')), group('B', { op: 'not', arg: member('A') })],
      fields
    );
    for (const country of [undefined, null, 42, {}, 'invalid']) {
      const result = evaluateGroups(plan, { attributes: { country }, sources: {} });
      expect(result.groups.B.member).toBe('unknown');
      expect(result.groups.B.sources).toEqual([]);
    }
  });
  it('checks scalar types, numeric comparisons and arrays without coercion', () => {
    const schemas = {
      ...fields,
      amount: { type: 'number' as const },
      flags: { type: 'boolean[]' as const },
      active: { type: 'boolean' as const },
    };
    const plan = compileGroups(
      't',
      [
        group('N', { op: 'attribute', field: 'amount', compare: 'gte', value: 10 }),
        group('F', { op: 'attribute', field: 'flags', compare: 'contains', value: true }),
        group('T', { op: 'attribute', field: 'active', compare: 'in', value: [true] }),
      ],
      schemas
    );
    for (const amount of [9, 10, 11, '10', null, NaN, Infinity]) {
      const input = { attributes: { amount, flags: [true, false], active: true }, sources: {} };
      const result = evaluateGroupInputDelta(plan, input);
      expect(result.groups).toEqual(recomputeGroups(plan, input));
      expect(result.groups.N.member).toBe(
        typeof amount !== 'number' || !Number.isFinite(amount) ? 'unknown' : amount >= 10
      );
      expect(result.groups.F.member).toBe(true);
    }
    expect(
      evaluateGroups(plan, { attributes: { flags: [true, 'false'] }, sources: {} }).groups.F.member
    ).toBe('unknown');
  });
  it('preserves manual and SCIM contributions when dynamic conditions become false', () => {
    const plan = compileGroups('t', [group('A', attr('country', 'JP'))], fields);
    const input: EvaluationInput = {
      attributes: { country: 'US' },
      sources: { A: { manual: true, scim: true } },
    };
    expect(evaluateGroups(plan, input).groups.A).toEqual({
      member: true,
      dynamic: false,
      sources: ['manual', 'scim'],
    });
    input.sources.A.manual = false;
    expect(evaluateGroups(plan, input).groups.A.sources).toEqual(['scim']);
    input.sources.A.scim = false;
    expect(evaluateGroups(plan, input).groups.A.member).toBe(false);
  });
  it('does not prune a different changed attribute behind a stable membership path', () => {
    const plan = compileGroups('t', groups, fields);
    const before: EvaluationInput = {
      attributes: { email_domain: 'example.com', country: 'JP', 'custom.contract': 'active' },
      sources: { B: { manual: true, scim: false } },
    };
    const after = {
      ...before,
      attributes: { ...before.attributes, email_domain: 'other.com', 'custom.contract': 'closed' },
    };
    const result = evaluateGroupInputDelta(plan, after, evaluateGroups(plan, before));
    expect(result.groups).toEqual(recomputeGroups(plan, after));
    expect(result.groups.C.member).toBe(false);
  });
  it('skips all nodes for equivalent normalized inputs and shares identical subexpressions', () => {
    const plan = compileGroups(
      't',
      [group('A', attr('country', 'JP')), group('B', attr('country', 'JP'))],
      fields
    );
    expect(Object.keys(plan.nodes)).toHaveLength(1);
    const before = evaluateGroups(plan, { attributes: { country: 'JP' }, sources: {} });
    expect(
      evaluateGroupInputDelta(plan, { attributes: { country: 'jp' }, sources: {} }, before)
        .evaluatedNodes
    ).toBe(0);
  });
  it.each([
    [group('A', member('A'))],
    [group('A', member('B')), group('B', member('A'))],
    [group('A', member('absent'))],
    [group('A', member('B')), { ...group('B', null), enabled: false }],
    [{ ...group('A', null), tenantId: 'other' }],
    [group('A', { op: 'all', args: [] })],
    [group('A', { op: 'attribute', field: 'country', compare: 'gt', value: 2 })],
  ])('rejects invalid graph or expression %#', (...definitions) => {
    expect(() => compileGroups('t', definitions as ServiceGroup[], fields)).toThrow();
  });
  it('rejects oversized/deep expressions and unknown request attributes', () => {
    let expression = attr('country', 'JP');
    for (let n = 0; n < 20; n++) expression = { op: 'not', arg: expression };
    expect(() => compileGroups('t', [group('A', expression)], fields)).toThrow();
    expect(() =>
      compileGroups('t', [group('A', attr('request.arbitrary', 'admin'))], fields)
    ).toThrow();
  });
});
