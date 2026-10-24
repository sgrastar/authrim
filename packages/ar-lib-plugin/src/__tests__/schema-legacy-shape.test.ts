/**
 * JSON Schema and config-error shapes that the built-in plugin pins do not reach:
 * expectations are what zod-to-json-schema / zod 3 produced for the same schemas.
 */

import { describe, expect, it } from 'vitest';
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

describe('validatePluginConfig legacy errors', () => {
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
