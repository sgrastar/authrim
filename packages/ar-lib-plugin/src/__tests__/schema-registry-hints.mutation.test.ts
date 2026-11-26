import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthrimPlugin } from '../core/types';
import {
  PluginSchemaRegistry,
  extractFormFieldHints,
  extractPluginSchema,
  zodToJSONSchema,
  type JSONSchema7,
} from '../core/schema';

function plugin(
  id: string,
  options: { category?: string; withMeta?: boolean; name?: string; description?: string } = {}
): AuthrimPlugin<{ key: string }> {
  return {
    id,
    version: '1.2.3',
    capabilities: [`cap.${id}`],
    official: true,
    configSchema: z.object({ key: z.string() }),
    ...(options.withMeta === false
      ? {}
      : {
          meta: {
            name: options.name ?? `Name ${id}`,
            description: options.description ?? `Description ${id}`,
            category: options.category ?? 'security',
          },
        }),
    register: () => undefined,
  } as unknown as AuthrimPlugin<{ key: string }>;
}

describe('extractPluginSchema', () => {
  it('names the schema after the plugin and describes it with the plugin metadata', () => {
    const info = extractPluginSchema(plugin('p1'));
    expect(info.pluginId).toBe('p1');
    expect(info.version).toBe('1.2.3');
    expect(info.official).toBe(true);
    expect(info.capabilities).toEqual(['cap.p1']);
    expect(info.meta?.name).toBe('Name p1');
    expect(info.configSchema.title).toBe('Name p1');
    expect(info.configSchema.description).toBe('Description p1');
    expect(info.configSchema.$ref).toBe('#/definitions/p1-config');
  });

  it('falls back to the plugin id as the title when the plugin has no metadata', () => {
    const info = extractPluginSchema(plugin('bare', { withMeta: false }));
    expect(info.configSchema.title).toBe('bare');
    expect(info.configSchema.description).toBeUndefined();
    expect(info.meta).toBeUndefined();
  });
});

describe('PluginSchemaRegistry', () => {
  it('stores, finds and lists registered plugin schemas', () => {
    const registry = new PluginSchemaRegistry();
    expect(registry.getAll()).toEqual([]);
    expect(registry.has('a')).toBe(false);
    expect(registry.get('a')).toBeUndefined();

    registry.register(plugin('a', { category: 'security' }));
    registry.register(plugin('b', { category: 'notifier' }));
    registry.register(plugin('c', { withMeta: false }));

    expect(registry.has('a')).toBe(true);
    expect(registry.get('a')?.pluginId).toBe('a');
    expect(registry.getAll().map((info) => info.pluginId)).toEqual(['a', 'b', 'c']);
  });

  it('filters by category and skips plugins without metadata', () => {
    const registry = new PluginSchemaRegistry();
    registry.register(plugin('a', { category: 'security' }));
    registry.register(plugin('b', { category: 'notifier' }));
    registry.register(plugin('c', { category: 'security' }));
    registry.register(plugin('d', { withMeta: false }));
    expect(registry.getByCategory('security').map((info) => info.pluginId)).toEqual(['a', 'c']);
    expect(registry.getByCategory('notifier').map((info) => info.pluginId)).toEqual(['b']);
    expect(registry.getByCategory('missing')).toEqual([]);
  });

  it('replaces a schema registered again under the same id', () => {
    const registry = new PluginSchemaRegistry();
    registry.register(plugin('a', { name: 'First' }));
    registry.register(plugin('a', { name: 'Second' }));
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.get('a')?.configSchema.title).toBe('Second');
  });

  it('unregisters one plugin, reporting whether it was there', () => {
    const registry = new PluginSchemaRegistry();
    registry.register(plugin('a'));
    registry.register(plugin('b'));
    expect(registry.unregister('a')).toBe(true);
    expect(registry.unregister('a')).toBe(false);
    expect(registry.has('a')).toBe(false);
    expect(registry.has('b')).toBe(true);
  });

  it('clears every schema', () => {
    const registry = new PluginSchemaRegistry();
    registry.register(plugin('a'));
    registry.register(plugin('b'));
    registry.clear();
    expect(registry.getAll()).toEqual([]);
    expect(registry.has('b')).toBe(false);
  });
});

describe('extractFormFieldHints', () => {
  const object = (properties: Record<string, JSONSchema7>, required?: string[]): JSONSchema7 => ({
    type: 'object',
    properties,
    ...(required ? { required } : {}),
  });

  it('returns no hints for a schema that is not an object with properties', () => {
    expect(extractFormFieldHints({ type: 'string' })).toEqual([]);
    expect(extractFormFieldHints({ type: 'object' })).toEqual([]);
    expect(extractFormFieldHints({ properties: { a: { type: 'string' } } })).toEqual([]);
  });

  it('describes a field with its label, description, default, placeholder and validation', () => {
    const hints = extractFormFieldHints(
      object(
        {
          name: {
            type: 'string',
            title: 'Display name',
            description: 'Shown to people',
            default: 'anon',
            minLength: 2,
            maxLength: 20,
            pattern: '^[a-z]+$',
          },
          plain: { type: 'string' },
        },
        ['name']
      )
    );
    expect(hints).toEqual([
      {
        name: 'name',
        type: 'text',
        required: true,
        label: 'Display name',
        description: 'Shown to people',
        default: 'anon',
        placeholder: 'anon',
        validation: { minLength: 2, maxLength: 20, pattern: '^[a-z]+$' },
      },
      {
        name: 'plain',
        type: 'text',
        required: false,
        label: 'plain',
        description: undefined,
        default: undefined,
        placeholder: undefined,
        validation: undefined,
      },
    ]);
  });

  it.each([
    ['an enum', { type: 'string', enum: ['a', 'b'] }, 'select'],
    ['an enum with a format', { type: 'string', enum: ['a'], format: 'email' }, 'select'],
    ['an email format', { type: 'string', format: 'email' }, 'email'],
    ['a uri format', { type: 'string', format: 'uri' }, 'url'],
    ['a url format', { type: 'string', format: 'url' }, 'url'],
    ['a password format', { type: 'string', format: 'password' }, 'password'],
    ['another format', { type: 'string', format: 'date' }, 'text'],
    ['a short string', { type: 'string', maxLength: 200 }, 'text'],
    ['a long string', { type: 'string', maxLength: 201 }, 'textarea'],
    ['a number', { type: 'number' }, 'number'],
    ['an integer', { type: 'integer' }, 'integer'],
    ['a boolean', { type: 'boolean' }, 'boolean'],
    ['an object', { type: 'object' }, 'json'],
    ['a list of choices', { type: 'array', items: { type: 'string', enum: ['x'] } }, 'multiselect'],
    ['a list of anything', { type: 'array', items: { type: 'string' } }, 'json'],
    ['a list without items', { type: 'array' }, 'json'],
    ['a null type', { type: 'null' }, 'text'],
    ['no type', {}, 'text'],
    ['a type list', { type: ['integer', 'null'] }, 'integer'],
  ] as Array<[string, JSONSchema7, string]>)('maps %s to %s', (_label, schema, expected) => {
    expect(extractFormFieldHints(object({ field: schema }))[0]?.type).toBe(expected);
  });

  it.each([
    ['the first example', { type: 'string', examples: ['first', 'second'], default: 'd' }, 'first'],
    ['an object example', { type: 'object', examples: [{ a: 1 }] }, '{"a":1}'],
    ['a numeric example', { type: 'number', examples: [0] }, '0'],
    ['a null example', { type: 'string', examples: [null] }, 'null'],
    [
      'an empty example list falling back to the default',
      { type: 'string', examples: [], default: 'd' },
      'd',
    ],
    ['an object default', { type: 'object', default: { b: 2 } }, '{"b":2}'],
    ['a null default', { type: 'string', default: null }, 'null'],
    ['a false default', { type: 'boolean', default: false }, 'false'],
    ['nothing', { type: 'string' }, undefined],
  ] as Array<[string, JSONSchema7, string | undefined]>)(
    'takes the placeholder from %s',
    (_label, schema, expected) => {
      expect(extractFormFieldHints(object({ field: schema }))[0]?.placeholder).toBe(expected);
    }
  );

  it.each([
    ['minLength', { minLength: 0 }, { minLength: 0 }],
    ['maxLength', { maxLength: 0 }, { maxLength: 0 }],
    ['minimum', { minimum: 0 }, { minimum: 0 }],
    ['maximum', { maximum: 0 }, { maximum: 0 }],
    ['pattern', { pattern: '' }, { pattern: '' }],
    ['enum', { enum: [] }, { options: [] }],
  ] as Array<[string, JSONSchema7, Record<string, unknown>]>)(
    'reports %s even when it is falsy',
    (_label, schema, expected) => {
      expect(extractFormFieldHints(object({ field: schema }))[0]?.validation).toEqual(expected);
    }
  );
});

describe('zodToJSONSchema object shapes', () => {
  it('closes strict and plain objects and opens loose ones', () => {
    const doc = zodToJSONSchema(
      z.object({
        plain: z.object({ a: z.string() }),
        strict: z.strictObject({ a: z.string() }),
        loose: z.looseObject({ a: z.string() }),
        catchAll: z.object({ a: z.string() }).catchall(z.number()),
      })
    );
    const props = doc.properties ?? {};
    expect(props.plain?.additionalProperties).toBe(false);
    expect(props.strict?.additionalProperties).toBe(false);
    expect(props.loose?.additionalProperties).toBe(true);
    expect(props.catchAll?.additionalProperties).toEqual({ type: 'number' });
  });

  it('opens an object whose catchall is any', () => {
    const doc = zodToJSONSchema(z.object({ a: z.string() }).catchall(z.any()));
    expect(doc.additionalProperties).toBe(true);
  });

  it('drops the implied string key schema of a record but keeps a constrained one', () => {
    const doc = zodToJSONSchema(
      z.object({
        free: z.record(z.string(), z.number()),
        short: z.record(z.string().min(2), z.number()),
      })
    );
    const props = doc.properties as Record<string, Record<string, unknown>>;
    expect(props.free).not.toHaveProperty('propertyNames');
    expect(props.free?.additionalProperties).toEqual({ type: 'number' });
    expect(props.short?.propertyNames).toEqual({ type: 'string', minLength: 2 });
  });

  it('keeps a pattern of a custom regex and drops the one a built-in format implies', () => {
    const doc = zodToJSONSchema(
      z.object({ mail: z.email(), custom: z.string().regex(/^[a-z]+$/u) })
    );
    const props = doc.properties ?? {};
    expect(props.mail?.format).toBe('email');
    expect(props.mail).not.toHaveProperty('pattern');
    expect(props.custom?.pattern).toBe('^[a-z]+$');
  });

  it('lists an integer without the safe integer bounds, but keeps real bounds', () => {
    const doc = zodToJSONSchema(
      z.object({ open: z.number().int(), bounded: z.number().int().min(1).max(9) })
    );
    const props = doc.properties ?? {};
    expect(props.open).toEqual({ type: 'integer' });
    expect(props.bounded).toEqual({ type: 'integer', minimum: 1, maximum: 9 });
  });

  it('shares a repeated schema by reference only when a ref strategy is chosen', () => {
    const leaf = z.object({ a: z.string() });
    const schema = z.object({ x: leaf, y: leaf });
    const inline = JSON.stringify(zodToJSONSchema(schema));
    expect(inline).not.toContain('$ref');
    expect(JSON.stringify(zodToJSONSchema(schema, { $refStrategy: 'none' }))).not.toContain('$ref');
    expect(JSON.stringify(zodToJSONSchema(schema, { $refStrategy: 'root' }))).toContain('$ref');
  });
});

describe('zodToJSONSchema unions and sets', () => {
  const warnings = () => {
    const onWarning = vi.fn();
    return { onWarning, messages: () => onWarning.mock.calls.map((call) => String(call[0])) };
  };

  it('merges literal and enum unions into one enum', () => {
    const doc = zodToJSONSchema(
      z.object({
        lits: z.union([z.literal('a'), z.literal('b')]),
        mixed: z.union([z.literal(1), z.literal('x')]),
        enums: z.union([z.enum(['a', 'b']), z.enum(['b', 'c'])]),
      })
    );
    const props = doc.properties ?? {};
    expect(props.lits).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(props.mixed).toEqual({ type: ['number', 'string'], enum: [1, 'x'] });
    expect(props.enums).toEqual({ type: 'string', enum: ['a', 'b', 'c'] });
  });

  it('keeps anyOf for a union with a described member, or one that is not all literals', () => {
    const doc = zodToJSONSchema(
      z.object({
        described: z.union([z.literal('a').describe('first'), z.literal('b')]),
        withType: z.union([z.literal('a'), z.number()]),
        undefinedLiteral: z.union([z.literal('a'), z.literal(undefined)]),
      })
    );
    const props = doc.properties ?? {};
    expect(props.described?.anyOf).toBeDefined();
    expect(props.withType?.anyOf).toBeDefined();
    expect(props.described).not.toHaveProperty('enum');
    expect(props.withType).not.toHaveProperty('enum');
  });

  it('keeps anyOf for a union of enums that do not all describe plain strings', () => {
    enum Level {
      Low,
      High,
    }
    const doc = zodToJSONSchema(z.object({ level: z.union([z.enum(Level), z.enum(['a'])]) }));
    expect(doc.properties?.level?.anyOf).toHaveLength(2);
    expect(doc.properties?.level).not.toHaveProperty('enum');
  });

  it('keeps set size limits', () => {
    const doc = zodToJSONSchema(
      z.object({
        maxOnly: z.set(z.string()).max(4),
        minOnly: z.set(z.string()).min(2),
        exact: z.set(z.string()).size(3),
      })
    );
    const props = doc.properties ?? {};
    expect(props.maxOnly).toMatchObject({ uniqueItems: true, maxItems: 4 });
    expect(props.maxOnly).not.toHaveProperty('minItems');
    expect(props.minOnly).toMatchObject({ minItems: 2 });
    expect(props.minOnly).not.toHaveProperty('maxItems');
    expect(props.exact).toMatchObject({ minItems: 3, maxItems: 3 });
  });

  function nestedSets(levels: number): z.ZodType {
    let schema: z.ZodType = z.string();
    for (let i = 0; i < levels; i += 1) schema = z.set(schema);
    return schema;
  }

  it('converts sets nested eight deep without a warning, and warns once at nine', () => {
    const ok = warnings();
    zodToJSONSchema(nestedSets(8), { onWarning: ok.onWarning });
    expect(ok.messages()).toEqual([]);

    const deep = warnings();
    zodToJSONSchema(nestedSets(9), { onWarning: deep.onWarning });
    expect(deep.messages()).toEqual([
      'Plugin JSON Schema element left unconstrained: nesting too deep',
    ]);
    expect(deep.onWarning).toHaveBeenCalledWith(
      'Plugin JSON Schema element left unconstrained: nesting too deep',
      { role: 'set element', maxDepth: 8 }
    );
  });

  it('does not accumulate nesting depth across sibling sets', () => {
    const siblings: Record<string, z.ZodType> = {};
    for (let i = 0; i < 12; i += 1) siblings[`s${i}`] = z.set(z.string());
    const sink = warnings();
    zodToJSONSchema(z.object(siblings), { onWarning: sink.onWarning });
    expect(sink.messages()).toEqual([]);
  });
});
