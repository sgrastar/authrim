import { afterEach, describe, expect, it, vi } from 'vitest';

// Simulate a plugin schema whose conversion reports an unconstrained element, so the
// registration plumbing is tested without depending on a particular zod schema.
vi.mock('../core/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/schema')>();
  return {
    ...actual,
    zodToJSONSchema: vi.fn((schema, options) => {
      options?.onWarning?.('Plugin JSON Schema element left unconstrained: nesting too deep', {
        role: 'set element',
      });
      return actual.zodToJSONSchema(schema, options);
    }),
  };
});

import { getBuiltinPlugins, registerBuiltinPlugins } from '../core/builtin-registry';

function memoryKV() {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => values.set(key, value)),
  } as unknown as KVNamespace;
}

describe('builtin registration schema warnings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('hands each warning to the dedicated sink with the plugin id', async () => {
    const onSchemaWarning = vi.fn();
    const log = vi.fn();
    await registerBuiltinPlugins(memoryKV(), { force: true, log, onSchemaWarning });

    const plugins = getBuiltinPlugins();
    expect(onSchemaWarning).toHaveBeenCalledTimes(plugins.length);
    for (const plugin of plugins) {
      expect(onSchemaWarning).toHaveBeenCalledWith(
        'Plugin JSON Schema element left unconstrained: nesting too deep',
        { role: 'set element', pluginId: plugin.id }
      );
    }
    // Progress logging stays separate: the warning is not routed through `log`.
    expect(log.mock.calls.map(([message]) => String(message)).join('\n')).not.toContain(
      'left unconstrained'
    );
  });

  it('logs a structured warn entry when no sink is given, even without a progress log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await registerBuiltinPlugins(memoryKV(), { force: true });

    const entries = warn.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>
    );
    expect(entries).toHaveLength(getBuiltinPlugins().length);
    expect(entries.map((entry) => entry.pluginId).sort()).toEqual(
      getBuiltinPlugins()
        .map((plugin) => plugin.id)
        .sort()
    );
    expect(entries[0]).toMatchObject({
      level: 'warn',
      message: 'Plugin JSON Schema element left unconstrained: nesting too deep',
    });
  });
});
