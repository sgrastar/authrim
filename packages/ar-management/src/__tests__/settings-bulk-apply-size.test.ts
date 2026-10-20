import { describe, expect, it } from 'vitest';
import {
  capMessage,
  estimateResponseBytes,
  jsonBytes,
  MESSAGE_CAP,
  RESULT_VALUE_CAP,
  summarizeValue,
} from '../routes/settings-v2/bulk-apply-size';

/** What the size of a bulk apply answer is counted in: bytes of the JSON, not characters. */

const SAMPLES: Array<[string, string]> = [
  ['plain', 'a'.repeat(1000)],
  ['kanji', '漢'.repeat(1000)],
  ['quotes', '"'.repeat(1000)],
  ['backslashes', '\\'.repeat(1000)],
  ['control characters', '\u0001'.repeat(1000)],
  ['surrogate pairs', '😀'.repeat(1000)],
  ['a lone surrogate', '\ud800'.repeat(1000)],
  ['combining marks', 'é'.repeat(1000)],
  ['mixed', 'a"\\\n漢😀\u0000\ud800'.repeat(200)],
];

describe('jsonBytes', () => {
  it('counts the UTF-8 bytes of the JSON text, escapes included', () => {
    expect(jsonBytes('a')).toBe(3);
    expect(jsonBytes('漢')).toBe(5);
    expect(jsonBytes('😀')).toBe(6);
    expect(jsonBytes('"')).toBe(4);
    expect(jsonBytes('\u0001')).toBe(8);
    expect(jsonBytes('\ud800')).toBe(8);
    expect(jsonBytes(undefined)).toBe(0);
  });
});

describe('summarizeValue', () => {
  it('keeps a value of up to 256 bytes and summarises a longer one by its type and size in bytes', () => {
    expect(summarizeValue('x'.repeat(254))).toBe('x'.repeat(254));
    expect(summarizeValue('x'.repeat(255))).toEqual({
      value_too_large: true,
      type: 'string',
      length: 257,
    });
    // 85 kanji are 85 characters and 257 bytes as JSON.
    expect(summarizeValue('漢'.repeat(84))).toBe('漢'.repeat(84));
    expect(summarizeValue('漢'.repeat(85))).toMatchObject({ value_too_large: true, length: 257 });
    expect(summarizeValue(Array.from({ length: 100 }, (_, i) => i))).toMatchObject({
      type: 'array',
    });
    expect(summarizeValue(7)).toBe(7);
  });

  it.each(SAMPLES)('never shows more than the cap for %s', (_name, value) => {
    expect(jsonBytes(summarizeValue(value))).toBeLessThanOrEqual(RESULT_VALUE_CAP);
  });
});

describe('capMessage', () => {
  it.each(SAMPLES)('cuts %s to at most the cap as a JSON string', (_name, text) => {
    expect(jsonBytes(capMessage(text))).toBeLessThanOrEqual(MESSAGE_CAP);
  });

  it('leaves a short message alone', () => {
    expect(capMessage('x is not valid')).toBe('x is not valid');
  });
});

describe('estimateResponseBytes', () => {
  const changes = [
    { category: 'discovery', set: { 'discovery.claims_supported': 'a' }, clear: [] },
  ];

  it('grows with the tenants, using the real length of each ID', () => {
    const short = estimateResponseBytes('preview', ['a'], changes);
    const long = estimateResponseBytes('preview', ['a'.repeat(128)], changes);
    expect(long - short).toBe(127);
    expect(estimateResponseBytes('preview', ['a', 'b'], changes)).toBeGreaterThan(short);
  });

  it('counts a proposed value as it will be shown: summarised when long', () => {
    const small = estimateResponseBytes(
      'apply',
      ['a'],
      [{ category: 'discovery', set: { 'discovery.claims_supported': 'a' }, clear: [] }]
    );
    const big = estimateResponseBytes(
      'apply',
      ['a'],
      [
        {
          category: 'discovery',
          set: { 'discovery.claims_supported': '漢'.repeat(600) },
          clear: [],
        },
      ]
    );
    expect(big - small).toBeLessThan(RESULT_VALUE_CAP + 60);
  });
});

describe('estimateResponseBytes as a bound', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `${i}`.padStart(128, 't'));
  const keys = ['discovery.claims_supported', 'discovery.acr_values_supported'];
  const changes = [
    {
      category: 'discovery',
      set: Object.fromEntries(keys.map((key) => [key, 'x'.repeat(254)])),
      clear: [],
    },
  ];
  /** The longest of everything an entry can hold, written out by hand. */
  const own = 'x'.repeat(RESULT_VALUE_CAP - 2);
  const message = 'x'.repeat(MESSAGE_CAP - 2);
  const preview = (id: string): Record<string, unknown> => ({
    tenant_id: id,
    status: 'nothing_to_do',
    changes: keys.map((key) => ({
      category: 'discovery',
      key,
      current: { overridden: true, own, effective: own, source: 'platform' },
      proposed: 'x'.repeat(254),
      action: 'would_reject',
      reason: 'x'.repeat(40),
      validation: { ok: false, errors: [{ code: 'x'.repeat(30), message }] },
      version: 'sha256:0123456789abcdef',
    })),
    impact: { discovery: { available: false, reason: 'core_database_unavailable' } },
  });
  const apply = (id: string): Record<string, unknown> => ({
    tenant_id: id,
    status: 'conflict',
    changes: keys.map((key) => ({
      category: 'discovery',
      key,
      status: 'conflict',
      reason: 'x'.repeat(40),
      message,
      previous: own,
      new: 'x'.repeat(254),
      version_before: 'sha256:0123456789abcdef',
      version_after: 'sha256:0123456789abcdef',
      warnings: ['external_plugin_gate_pending'],
    })),
  });
  const frame = (mode: string, results: unknown[]) => ({
    bulk_id: '00000000-0000-0000-0000-000000000000',
    mode,
    on_existing_override: 'overwrite',
    limits: { max_tenants_per_request: 100, max_keys_per_request: 100 },
    summary: {
      tenants: results.length,
      by_status: { applied: 1, cleared: 1, skipped: 1, rejected: 1, conflict: 1, failed: 1 },
    },
    results,
  });

  it.each([
    ['preview', preview],
    ['apply', apply],
  ] as const)('is not below an answer with the longest of everything, in a %s', (mode, entry) => {
    const answer = frame(mode, ids.map(entry));
    expect(jsonBytes(answer)).toBeLessThanOrEqual(estimateResponseBytes(mode, ids, changes));
  });
});
