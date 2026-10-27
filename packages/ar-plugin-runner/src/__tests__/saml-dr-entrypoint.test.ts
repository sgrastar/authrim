import { describe, expect, it, vi } from 'vitest';
import PluginRunnerWorker, {
  PluginAccountMetadataAccess,
  PluginDynamicOutbound,
  RuntimeSmokeEntrypoint,
  SAML_DR_WRITER_SURFACES,
  SAML_DR_READ_ONLY_SURFACES,
} from '../worker';
import {
  PluginD1ResourceAccess,
  PluginKvResourceAccess,
  PluginR2ResourceAccess,
} from '../resource-bindings';

const context = { waitUntil: vi.fn(), props: {} } as never;
const env = { ENABLE_SAML_DR_EXPORT: 'true' } as never;

describe('Plugin Runner source write boundaries', () => {
  const methods = SAML_DR_WRITER_SURFACES.filter((surface) =>
    surface.startsWith('rpc:PluginRunnerWorker.')
  ).map((surface) => surface.split('.')[1]);
  it('classifies every default public RPC and handler, with no callable helper aliases', () => {
    const names = Object.getOwnPropertyNames(PluginRunnerWorker.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    const classified = [...SAML_DR_WRITER_SURFACES, ...SAML_DR_READ_ONLY_SURFACES]
      .flatMap((surface) =>
        surface === 'fetch' || surface === 'scheduled'
          ? [surface]
          : surface.startsWith('rpc:PluginRunnerWorker.')
            ? [surface.split('.')[1]]
            : []
      )
      .sort();
    expect(names).toEqual(classified);
  });
  it.each(methods)(
    'guards mutation RPC %s before validation or database access',
    async (method) => {
      const worker = new PluginRunnerWorker(context, env);
      const operation = (worker as unknown as Record<string, (input: unknown) => Promise<unknown>>)[
        method
      ];
      await expect(operation.call(worker, {})).rejects.toThrow('saml_dr_writer_unavailable');
    }
  );
  it('does not expose internal loopback factories or the guard as RPC methods', () => {
    const worker = new PluginRunnerWorker(context, env);
    expect(worker).not.toHaveProperty('dynamicOutbound');
    expect(worker).not.toHaveProperty('dynamicHostInterfaces');
    expect(worker).not.toHaveProperty('coveredRpc');
  });
  it('keeps its fixed HTTP rejection available without storage admission', () => {
    expect(
      new PluginRunnerWorker(context, env).fetch(new Request('https://internal.invalid/')).status
    ).toBe(404);
  });
  it('guards scheduled plugin execution and metrics', async () => {
    await expect(new PluginRunnerWorker(context, env).scheduled()).rejects.toThrow(
      'saml_dr_writer_unavailable'
    );
  });
  it('guards an independently invoked outbound loopback', async () => {
    const response = await new PluginDynamicOutbound(context, env).fetch(
      new Request('https://internal.invalid/')
    );
    expect(response.status).toBe(503);
  });
  it('guards the account metadata host interface', async () => {
    await expect(new PluginAccountMetadataAccess(context, env).write({})).rejects.toThrow(
      'saml_dr_writer_unavailable'
    );
  });
  it('guards resource smoke because it persists resource inventory', async () => {
    await expect(
      new RuntimeSmokeEntrypoint(context, env).smokePluginResourceBindings({})
    ).rejects.toThrow('saml_dr_writer_unavailable');
  });
  it.each([
    ['D1.run', () => new PluginD1ResourceAccess(context, env).run('DELETE FROM users')],
    ['KV.put', () => new PluginKvResourceAccess(context, env).put('key', 'value')],
    ['KV.delete', () => new PluginKvResourceAccess(context, env).delete('key')],
    ['R2.put', () => new PluginR2ResourceAccess(context, env).put('key', 'value')],
    ['R2.delete', () => new PluginR2ResourceAccess(context, env).delete('key')],
  ] as const)('guards separately callable resource mutation %s', async (_name, operation) => {
    await expect(operation()).rejects.toThrow('saml_dr_writer_unavailable');
  });
});
