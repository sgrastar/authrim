import { describe, expect, it } from 'vitest';
import { createDeterministicId, shortHash } from '../../core/ids';
import {
  filterSafeMetadata,
  findUnsafeMetadata,
  isSafeMetadataKey,
  isSafeMetadataValue,
  SAFE_METADATA_KEYS,
} from '../../core/metadata';
import {
  categoryFromCode,
  REASON_REGISTRY,
  reason,
  validateReasonRegistry,
} from '../../core/reason-registry';
import { statusFromReasons } from '../../core/result';
import { findSourceValue } from '../../core/source-values';
import { buildTraceEntry } from '../../core/trace';
import type {
  FieldRef,
  ReasonCode,
  ReasonCodeName,
  ReasonRegistryEntry,
  SourceValueEnvelope,
} from '../../core/types';

describe('deterministic ids', () => {
  it('pads the hash to eight digits before keeping six', () => {
    // FNV-1a of "cba" is 0x016d9863: the leading zero must survive.
    expect(shortHash(['cba'])).toBe('016d98');
    expect(shortHash([])).toBe('811c9d');
    expect(shortHash(['a'])).toBe('e40c29');
    expect(shortHash(['a', 'b'])).toBe(shortHash(['a|b']));
    expect(shortHash(['a', 1, true])).toBe(shortHash(['a|1|true']));
  });

  it('builds kind.path.hash with a normalised, dot-joined path', () => {
    const id = createDeterministicId({ kind: 'rule', semanticPath: ['Foo Bar', 'x_y'] });
    expect(id).toBe(`rule.foo-bar.x-y.${shortHash(['rule', 'Foo Bar', 'x_y'])}`);
    expect(createDeterministicId({ kind: 'edge', semanticPath: ['a'] })).toBe(
      `edge.a.${shortHash(['edge', 'a'])}`
    );
  });

  it('keeps ASCII letters and digits, and folds every other run into one dash', () => {
    const path = (part: string) =>
      createDeterministicId({ kind: 'rule', semanticPath: [part] }).split('.')[1];
    expect(path('azAZ09')).toBe('azaz09');
    expect(path('  Hello,   World!  ')).toBe('hello-world');
    expect(path('a--b__c')).toBe('a-b-c');
    expect(path('{a`z@[/0:9')).toBe('a-z-0-9');
    expect(path('z')).toBe('z');
    expect(path('日本語abc')).toBe('abc');
    expect(path('abc日本語')).toBe('abc');
    expect(path('a日本b')).toBe('a-b');
    expect(path('-a-')).toBe('a');
    expect(path('7')).toBe('7');
  });

  it('drops empty parts and falls back to unknown', () => {
    const parts = (semanticPath: string[]) =>
      createDeterministicId({ kind: 'rule', semanticPath }).split('.');
    expect(parts(['!!', 'b', ''])[1]).toBe('b');
    expect(parts(['a', '  ', 'b']).slice(1, 3)).toEqual(['a', 'b']);
    expect(createDeterministicId({ kind: 'trace', semanticPath: [] })).toBe(
      `trace.unknown.${shortHash(['trace'])}`
    );
    expect(createDeterministicId({ kind: 'trace', semanticPath: ['!!', ''] })).toBe(
      `trace.unknown.${shortHash(['trace', '!!', ''])}`
    );
  });

  it('hashes the raw path and the content parts, not the normalised path', () => {
    const base = { kind: 'rule' as const, semanticPath: ['Foo'] };
    expect(createDeterministicId({ ...base, semanticPath: ['foo'] })).not.toBe(
      createDeterministicId(base)
    );
    expect(createDeterministicId({ ...base, contentHashParts: ['x'] })).toBe(
      `rule.foo.${shortHash(['rule', 'Foo', 'x'])}`
    );
    expect(createDeterministicId({ ...base, contentHashParts: ['x'] })).not.toBe(
      createDeterministicId(base)
    );
    expect(createDeterministicId({ ...base, contentHashParts: ['x', 2, false] })).toBe(
      `rule.foo.${shortHash(['rule', 'Foo', 'x', 2, false])}`
    );
    expect(createDeterministicId({ ...base, contentHashParts: [] })).toBe(
      createDeterministicId(base)
    );
  });
});

describe('statusFromReasons', () => {
  const code = (severity: ReasonCode['severity']): ReasonCode => ({
    category: 'transform',
    code: 'transform.invalid_output',
    severity,
  });

  it('fails on any critical reason, even beside others', () => {
    expect(statusFromReasons([code('critical')])).toBe('failed');
    expect(statusFromReasons([code('info'), code('error'), code('critical')])).toBe('failed');
  });

  it('is partial for errors and warnings without a critical one', () => {
    expect(statusFromReasons([code('error')])).toBe('partial');
    expect(statusFromReasons([code('warning')])).toBe('partial');
    expect(statusFromReasons([code('info'), code('warning')])).toBe('partial');
    expect(statusFromReasons([code('info'), code('error')])).toBe('partial');
  });

  it('succeeds with no reasons or only informational ones', () => {
    expect(statusFromReasons([])).toBe('success');
    expect(statusFromReasons([code('info')])).toBe('success');
    expect(statusFromReasons([code('info'), code('info')])).toBe('success');
  });
});

describe('metadata safety', () => {
  it('knows the allow-listed keys and nothing else', () => {
    for (const key of SAFE_METADATA_KEYS) expect(isSafeMetadataKey(key)).toBe(true);
    for (const key of ['rawValue', 'email', '', 'toString', '__proto__', 'ROWINDEX'])
      expect(isSafeMetadataKey(key)).toBe(false);
  });

  it.each(['', 'text', 0, 3.5, true, false, [], ['a'], ['a', 'b']])(
    'accepts the plain value %j',
    (value) => {
      expect(isSafeMetadataValue(value)).toBe(true);
    }
  );

  it.each([null, undefined, {}, { a: 1 }, [1], ['a', 1], [null], [['a']], [{}]])(
    'rejects the value %j',
    (value) => {
      expect(isSafeMetadataValue(value)).toBe(false);
    }
  );

  it('keeps only allow-listed keys with plain values', () => {
    expect(filterSafeMetadata(undefined)).toEqual({});
    expect(filterSafeMetadata({})).toEqual({});
    expect(
      filterSafeMetadata({
        rowIndex: 2,
        columnName: 'email',
        recordIndex: false,
        csvHeaderName: ['a', 'b'],
        sourceId: { nested: true },
        scimPath: [1],
        rawValue: 'secret',
        ruleId: null,
      })
    ).toEqual({ rowIndex: 2, columnName: 'email', recordIndex: false, csvHeaderName: ['a', 'b'] });
  });

  it('lists every key that is not allow-listed or has an unsafe value', () => {
    expect(findUnsafeMetadata(undefined)).toEqual([]);
    expect(findUnsafeMetadata({})).toEqual([]);
    expect(findUnsafeMetadata({ rowIndex: 1, ruleId: 'r', edgeId: ['e'] })).toEqual([]);
    expect(
      findUnsafeMetadata({ rowIndex: 1, rawValue: 'x', sourceId: {}, scimPath: [2], edgeId: 'e' })
    ).toEqual(['rawValue', 'sourceId', 'scimPath']);
  });
});

describe('findSourceValue', () => {
  const at = (side: FieldRef['side'], namespace: string, path: string, id?: string): FieldRef => ({
    side,
    namespace,
    path,
    ...(id ? { catalogEntryId: id } : {}),
  });
  const value = (sourceRef: FieldRef, tag: string): SourceValueEnvelope => ({
    value: tag,
    sourceRef,
  });
  const edge = (sourceRef: FieldRef) => ({
    id: 'e',
    sourceRef,
    targetRef: at('destination', 't', 'p'),
  });

  it('matches by catalog entry when both sides name one, ignoring place', () => {
    const values = [
      value(at('source', 'ns', 'one', 'id.1'), 'first'),
      value(at('source', 'ns', 'two', 'id.2'), 'second'),
    ];
    expect(findSourceValue(values, edge(at('source', 'other', 'elsewhere', 'id.2')))?.value).toBe(
      'second'
    );
    expect(findSourceValue(values, edge(at('source', 'ns', 'one', 'id.3')))).toBeUndefined();
  });

  it('matches by side, namespace and path when a catalog entry is missing on either side', () => {
    const values = [
      value(at('source', 'ns', 'one'), 'plain'),
      value(at('source', 'ns', 'two', 'id.2'), 'catalogued'),
    ];
    expect(findSourceValue(values, edge(at('source', 'ns', 'one')))?.value).toBe('plain');
    expect(findSourceValue(values, edge(at('source', 'ns', 'one', 'id.9')))?.value).toBe('plain');
    expect(findSourceValue(values, edge(at('source', 'ns', 'two')))?.value).toBe('catalogued');
  });

  it('needs all three of side, namespace and path to agree', () => {
    const values = [value(at('source', 'ns', 'one'), 'v')];
    expect(findSourceValue(values, edge(at('canonical', 'ns', 'one')))).toBeUndefined();
    expect(findSourceValue(values, edge(at('source', 'other', 'one')))).toBeUndefined();
    expect(findSourceValue(values, edge(at('source', 'ns', 'other')))).toBeUndefined();
    expect(findSourceValue([], edge(at('source', 'ns', 'one')))).toBeUndefined();
  });

  it('returns the first match', () => {
    const values = [
      value(at('source', 'ns', 'one'), 'first'),
      value(at('source', 'ns', 'one'), 'second'),
    ];
    expect(findSourceValue(values, edge(at('source', 'ns', 'one')))?.value).toBe('first');
  });
});

describe('trace ids', () => {
  const base = reason('trace.mapping_evaluated');
  const idPath = (id: string) => id.split('.').slice(0, -1).join('.');
  const field: FieldRef = { side: 'source', namespace: 'csv', path: 'email' };

  it('names the entry after the rule, else the edge, else the validation rule, else the reason', () => {
    expect(
      idPath(
        buildTraceEntry({ reason: base, ruleId: 'r1', edgeId: 'e1', validationRuleId: 'v1' }).id
      )
    ).toBe('trace.r1.none.none');
    expect(idPath(buildTraceEntry({ reason: base, edgeId: 'e1', validationRuleId: 'v1' }).id)).toBe(
      'trace.e1.none.none'
    );
    expect(idPath(buildTraceEntry({ reason: base, validationRuleId: 'v1' }).id)).toBe(
      'trace.v1.none.none'
    );
    expect(idPath(buildTraceEntry({ reason: base }).id)).toBe(
      'trace.trace-mapping-evaluated.none.none'
    );
  });

  it('adds the field namespace and path', () => {
    expect(idPath(buildTraceEntry({ reason: base, ruleId: 'r1', fieldRef: field }).id)).toBe(
      'trace.r1.csv.email'
    );
  });

  it('hashes the reason code and the severity that was actually recorded', () => {
    const entry = buildTraceEntry({ reason: base, ruleId: 'r1' });
    expect(entry.id).toBe(
      `trace.r1.none.none.${shortHash(['trace', 'r1', 'none', 'none', base.code, base.severity])}`
    );
    const unsafe = buildTraceEntry({
      reason: base,
      ruleId: 'r1',
      metadata: { rawValue: 'x' } as Record<string, unknown>,
    });
    expect(unsafe.reason).toEqual(reason('trace.unsafe_metadata'));
    expect(unsafe.id).toBe(
      `trace.r1.none.none.${shortHash(['trace', 'r1', 'none', 'none', base.code, unsafe.reason.severity])}`
    );
  });

  it('keeps the input fields and safe metadata', () => {
    const entry = buildTraceEntry({
      reason: base,
      ruleId: 'r1',
      metadata: { rowIndex: 4 },
    });
    expect(entry.ruleId).toBe('r1');
    expect(entry.reason).toEqual(base);
    expect(entry.metadata).toEqual({ rowIndex: 4 });
    expect(buildTraceEntry({ reason: base }).metadata).toEqual({});
  });
});

describe('reason registry', () => {
  it('gives every code a sentence-style description', () => {
    for (const entry of REASON_REGISTRY) {
      expect(entry.description, entry.code).toMatch(/^[A-Z].{10,}\.$/u);
    }
  });

  it('looks up a registered code', () => {
    const entry = REASON_REGISTRY.find((item) => item.code === 'transform.deferred_output');
    expect(reason('transform.deferred_output')).toEqual({
      category: 'transform',
      code: 'transform.deferred_output',
      severity: entry?.severity,
    });
    expect(Object.keys(reason('transform.deferred_output')).sort()).toEqual([
      'category',
      'code',
      'severity',
    ]);
  });

  it('treats an unregistered code as an error in the category its prefix names', () => {
    expect(reason('validation.not_registered')).toEqual({
      category: 'validation',
      code: 'validation.not_registered',
      severity: 'error',
    });
    expect(categoryFromCode('catalog.anything')).toBe('catalog');
    expect(categoryFromCode('x' as ReasonCodeName)).toBe('x');
  });

  it('reports duplicates and category mismatches by code', () => {
    const entry = (code: string, category: string): ReasonRegistryEntry => ({
      code: code as ReasonCodeName,
      category: category as ReasonRegistryEntry['category'],
      severity: 'error',
      stability: 'stable',
      description: 'd',
    });
    expect(validateReasonRegistry([])).toEqual([]);
    expect(validateReasonRegistry([entry('transform.a', 'transform')])).toEqual([]);
    expect(
      validateReasonRegistry([entry('transform.a', 'transform'), entry('transform.a', 'transform')])
    ).toEqual(['duplicate reason code: transform.a']);
    expect(validateReasonRegistry([entry('transform.a', 'catalog')])).toEqual([
      'category mismatch for transform.a',
    ]);
    expect(
      validateReasonRegistry([
        entry('catalog.b', 'transform'),
        entry('catalog.b', 'transform'),
        entry('transform.c', 'transform'),
      ])
    ).toEqual([
      'category mismatch for catalog.b',
      'duplicate reason code: catalog.b',
      'category mismatch for catalog.b',
    ]);
  });
});
