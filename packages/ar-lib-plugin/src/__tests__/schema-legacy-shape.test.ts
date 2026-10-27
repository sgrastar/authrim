/**
 * JSON Schema and config-error shapes that the built-in plugin pins do not reach:
 * expectations are what zod-to-json-schema / zod 3 produced for the same schemas.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { validatePluginConfig, zodToJSONSchema } from '../core/schema';

describe('zodToJSONSchema legacy shape', () => {
  it('keeps generated definitions at the root of a named schema', () => {
    const leaf = z.object({ a: z.string() });
    const document = zodToJSONSchema(z.object({ x: leaf, y: leaf }), {
      name: 'shared',
      $refStrategy: 'root',
    });
    expect(document.$ref).toBe('#/definitions/shared');
    const definitions = document.definitions ?? {};
    const shared = definitions.shared;
    const target = (shared.properties?.x as { $ref: string }).$ref;
    expect(target.startsWith('#/definitions/')).toBe(true);
    expect(definitions[target.slice('#/definitions/'.length)]).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
  });

  it('resolves recursive schemas inside a named schema', () => {
    type Node = { name: string; children: Node[] };
    const node: z.ZodType<Node> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(node) })
    );
    const document = zodToJSONSchema(z.object({ tree: node }), { name: 'tree-config' });
    const definitions = document.definitions ?? {};
    const refs = JSON.stringify(document).match(/#\/definitions\/[^"]+/g) ?? [];
    for (const ref of refs) {
      expect(definitions[ref.slice('#/definitions/'.length)]).toBeDefined();
    }
  });

  it('converts dates, bigints and sets like zod-to-json-schema', () => {
    expect(
      zodToJSONSchema(
        z.object({
          when: z.coerce.date(),
          size: z.bigint(),
          tags: z.set(z.string().min(2)).min(1).max(3),
        })
      )
    ).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        when: { type: 'string', format: 'date-time' },
        size: { type: 'integer', format: 'int64' },
        tags: {
          type: 'array',
          uniqueItems: true,
          items: { type: 'string', minLength: 2 },
          minItems: 1,
          maxItems: 3,
        },
      },
      required: ['when', 'size', 'tags'],
      additionalProperties: false,
    });
  });
});

describe('zodToJSONSchema legacy collections and unions', () => {
  const root = (properties: Record<string, unknown>, required: string[]) => ({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  });

  it('converts maps to bounded arrays of key/value pairs', () => {
    expect(zodToJSONSchema(z.object({ m: z.map(z.string(), z.number()) }))).toEqual(
      root(
        {
          m: {
            type: 'array',
            maxItems: 125,
            items: {
              type: 'array',
              items: [{ type: 'string' }, { type: 'number' }],
              minItems: 2,
              maxItems: 2,
            },
          },
        },
        ['m']
      )
    );
  });

  it('keeps the exact size of a set', () => {
    expect(zodToJSONSchema(z.object({ s: z.set(z.string()).size(2) }))).toEqual(
      root(
        {
          s: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string' },
            minItems: 2,
            maxItems: 2,
          },
        },
        ['s']
      )
    );
  });

  it('keeps numeric TypeScript enum unions valid (no reverse-mapping entries)', () => {
    enum Level {
      Off,
      On,
    }
    enum Mode {
      Auto = 2,
    }
    const document = zodToJSONSchema(z.object({ u: z.union([z.enum(Level), z.enum(Mode)]) }));
    const field = (document.properties?.u ?? {}) as { type?: unknown; enum?: unknown[] };
    expect(JSON.stringify(document)).not.toContain('"Off"');
    expect(JSON.stringify(document)).not.toContain('"Auto"');
    expect(field.type).not.toBe('string');
  });

  it('does not overflow on a set of recursive elements', () => {
    type Node = { children: Set<Node> };
    const node: z.ZodType<Node> = z.lazy(() => z.object({ children: z.set(node) }));
    expect(() => zodToJSONSchema(z.object({ tree: node }), { onWarning: () => {} })).not.toThrow();
  });

  it.each([
    [
      'union of enums',
      z.union([z.enum(['a', 'b']), z.enum(['c', 'd'])]),
      { type: 'string', enum: ['a', 'b', 'c', 'd'] },
    ],
    [
      'literals of different types',
      z.union([z.literal('auto'), z.literal(0)]),
      { type: ['string', 'number'], enum: ['auto', 0] },
    ],
    [
      'nullable literal',
      z.union([z.literal('a'), z.literal(null)]),
      { type: ['string', 'null'], enum: ['a', null] },
    ],
    [
      'boolean literals',
      z.union([z.literal(true), z.literal(false)]),
      { type: 'boolean', enum: [true, false] },
    ],
    [
      'enum with a literal',
      z.union([z.enum(['a', 'b']), z.literal('c')]),
      {
        anyOf: [
          { type: 'string', enum: ['a', 'b'] },
          { type: 'string', const: 'c' },
        ],
      },
    ],
  ])('flattens %s like zod-to-json-schema', (_name, union, expected) => {
    expect(zodToJSONSchema(z.object({ u: union }))).toEqual(root({ u: expected }, ['u']));
  });
});

describe('zodToJSONSchema element conversion warnings', () => {
  it('warns once when a recursive element schema hits the depth limit', () => {
    type Node = { children: Set<Node> };
    const node: z.ZodType<Node> = z.lazy(() => z.object({ children: z.set(node) }));
    const onWarning = vi.fn();
    zodToJSONSchema(z.object({ tree: node }), { onWarning });
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(
      'Plugin JSON Schema element left unconstrained: nesting too deep',
      { role: 'set element', maxDepth: 8 }
    );
  });

  it('warns once for a recursive map, not once per branch', () => {
    type Node = { children: Map<string, Node> };
    const node: z.ZodType<Node> = z.lazy(() => z.object({ children: z.map(z.string(), node) }));
    const onWarning = vi.fn();
    zodToJSONSchema(z.object({ tree: node }), { onWarning });
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it('warns with the reason when an element cannot be converted, and keeps the rest', () => {
    // An element whose own conversion pass fails while the enclosing pass succeeds.
    const broken = z.string();
    broken._zod.processJSONSchema = () => {
      throw new Error('boom');
    };
    const onWarning = vi.fn();
    const document = zodToJSONSchema(
      z.object({ name: z.string().min(2), tags: z.set(broken).max(3) }),
      { onWarning }
    );
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(
      'Plugin JSON Schema element left unconstrained: conversion failed',
      { role: 'set element', conversionError: 'boom' }
    );
    expect(document.properties?.name).toEqual({ type: 'string', minLength: 2 });
    expect(document.properties?.tags).toEqual({
      type: 'array',
      uniqueItems: true,
      items: {},
      maxItems: 3,
    });
  });

  it('does not warn for schemas that convert completely', () => {
    const onWarning = vi.fn();
    zodToJSONSchema(z.object({ tags: z.set(z.string()), pairs: z.map(z.string(), z.number()) }), {
      onWarning,
    });
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('logs a structured warning by default, including the exception reason', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const broken = z.string();
      broken._zod.processJSONSchema = () => {
        throw new Error('boom');
      };
      zodToJSONSchema(z.object({ tags: z.set(broken) }));
      expect(warn).toHaveBeenCalledTimes(1);
      const entry = JSON.parse(String(warn.mock.calls[0][0])) as Record<string, unknown>;
      expect(entry).toMatchObject({
        level: 'warn',
        message: 'Plugin JSON Schema element left unconstrained: conversion failed',
        module: 'PluginSchema',
        role: 'set element',
        conversionError: 'boom',
      });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('validatePluginConfig legacy errors', () => {
  it('reports invalid dates with the zod 3 code and message', () => {
    expect(
      validatePluginConfig(z.object({ when: z.coerce.date() }), { when: 'not-a-date' })
    ).toEqual({
      success: false,
      errors: [{ path: 'when', message: 'Invalid date', code: 'invalid_date' }],
    });
  });

  it('reports record-key failures at the key path with zod 3 codes', () => {
    const schema = z.object({ headers: z.record(z.string().regex(/^[A-Z]+$/), z.string()) });
    expect(validatePluginConfig(schema, { headers: { 'bad-key': 'v', GOOD: 'v' } })).toEqual({
      success: false,
      errors: [{ path: 'headers.bad-key', message: 'Invalid', code: 'invalid_string' }],
    });
  });

  it('keeps zod 3 codes for single-value enums', () => {
    const schema = z.object({ mode: z.enum(['only']) });
    expect(validatePluginConfig(schema, { mode: 'other' })).toEqual({
      success: false,
      errors: [
        {
          path: 'mode',
          message: "Invalid enum value. Expected 'only', received 'other'",
          code: 'invalid_enum_value',
        },
      ],
    });
  });
});
