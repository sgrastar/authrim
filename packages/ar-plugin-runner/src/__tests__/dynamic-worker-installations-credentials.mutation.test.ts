import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1DynamicPluginInstallationStore } from '../dynamic-worker-installations';
import {
  seedArtifact,
  seedInstallation,
  seedPlugin,
  VERSION_1,
  VERSION_2,
} from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

let database: DatabaseSync;
function store(options: D1Options = {}) {
  const d1 = createD1(database, options);
  return { store: new D1DynamicPluginInstallationStore(d1.db, 'test', () => 500), calls: d1.calls };
}
const target = { tenantId: 'tenant-a', pluginId: 'plugin-a' };

beforeEach(() => {
  database = openRunnerDatabase();
});

describe('credentialInputs', () => {
  beforeEach(() => {
    seedPlugin(database, {
      slots: [
        { configKey: 'apiKey', required: true },
        {
          configKey: 'webhook',
          required: false,
          destinationHost: 'hooks.example.com',
          injectionKind: 'header',
          injectionName: 'X-Secret',
        },
      ],
    });
  });
  const input = (credentials: unknown, over: Record<string, unknown> = {}) => ({
    ...target,
    credentials,
    ...over,
  });
  const run = (value: unknown, options: D1Options = {}) =>
    store(options).store.credentialInputs(value);
  const CREDS_INVALID = /^plugin_dynamic_credentials_input_invalid$/u;
  const MISMATCH = /^plugin_dynamic_credentials_policy_mismatch$/u;

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'x'],
    ['missing credentials', target],
    ['extra key', input({ apiKey: 'v' }, { enabled: true })],
    ['null credentials', input(null)],
    ['array credentials', input([])],
    ['string credentials', input('x')],
    ['numeric credentials', input(5)],
    ['boolean credentials', input(true)],
    [
      'seventeen credentials',
      input(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']))),
    ],
    ['key starting with a digit', input({ '1a': 'v' })],
    ['key with a space', input({ 'a b': 'v' })],
    ['key too long', input({ [`a${'b'.repeat(128)}`]: 'v' })],
    ['numeric value', input({ apiKey: 5 })],
    ['null value', input({ apiKey: null })],
    ['empty value', input({ apiKey: '' })],
    ['oversized value', input({ apiKey: 'x'.repeat(8193) })],
  ])('rejects %s', async (_label, value) => {
    await expect(run(value)).rejects.toThrow(CREDS_INVALID);
  });

  it('rejects an invalid tenant or plugin with the installation code', async () => {
    await expect(run(input({ apiKey: 'v' }, { tenantId: '' }))).rejects.toThrow(
      /^plugin_dynamic_installation_input_invalid$/u
    );
    await expect(run(input({ apiKey: 'v' }, { pluginId: 'P' }))).rejects.toThrow(
      /^plugin_dynamic_installation_input_invalid$/u
    );
  });

  it('maps supplied values to their slots in the order supplied', async () => {
    await expect(run(input({ webhook: 'w', apiKey: 'a' }))).resolves.toEqual({
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      values: [
        {
          configKey: 'webhook',
          destinationHost: 'hooks.example.com',
          injectionKind: 'header',
          injectionName: 'X-Secret',
          value: 'w',
        },
        {
          configKey: 'apiKey',
          destinationHost: 'api.example.com',
          injectionKind: 'bearer',
          injectionName: 'Authorization',
          value: 'a',
        },
      ],
    });
  });

  it('accepts a value of exactly 8192 characters and a key of exactly 128', async () => {
    const long = 'x'.repeat(8192);
    await expect(run(input({ apiKey: long }))).resolves.toMatchObject({
      values: [{ value: long }],
    });
    const key = `a${'b'.repeat(127)}`;
    await expect(run(input({ apiKey: 'v', [key]: 'v' }))).rejects.toThrow(MISMATCH);
  });

  it('accepts exactly sixteen entries syntactically, refusing them as unknown keys', async () => {
    const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v']));
    await expect(run(input(sixteen))).rejects.toThrow(MISMATCH);
  });

  it('omits optional slots', async () => {
    await expect(run(input({ apiKey: 'a' }))).resolves.toMatchObject({
      values: [{ configKey: 'apiKey' }],
    });
  });

  it.each([
    ['an unknown key', { apiKey: 'a', unknown: 'v' }],
    ['a missing required key', { webhook: 'w' }],
    ['no keys at all', {}],
  ])('refuses %s', async (_label, credentials) => {
    await expect(run(input(credentials))).rejects.toThrow(MISMATCH);
  });

  it('refuses when the plugin has no approved release', async () => {
    await expect(run(input({ apiKey: 'a' }, { pluginId: 'unknown' }))).rejects.toThrow(MISMATCH);
  });

  it('uses the pinned release for an enabled installation', async () => {
    const id = await seedInstallation(database, { state: 'enabled' });
    seedArtifact(database, id, VERSION_1);
    seedPlugin(database, {
      version: VERSION_2,
      slots: [{ configKey: 'next', required: true }],
    });
    await expect(run(input({ apiKey: 'a' }))).resolves.toMatchObject({
      values: [{ configKey: 'apiKey' }],
    });
    await expect(run(input({ next: 'n' }))).rejects.toThrow(MISMATCH);
  });

  it('uses the manifest for a disabled installation', async () => {
    const id = await seedInstallation(database, { state: 'disabled' });
    seedArtifact(database, id, VERSION_1);
    seedPlugin(database, {
      version: VERSION_2,
      slots: [{ configKey: 'next', required: true }],
    });
    await expect(run(input({ next: 'n' }))).resolves.toMatchObject({
      values: [{ configKey: 'next' }],
    });
    await expect(run(input({ apiKey: 'a' }))).rejects.toThrow(MISMATCH);
  });

  it('refuses an enabled installation that holds no pin', async () => {
    await seedInstallation(database, { state: 'enabled' });
    await expect(run(input({ apiKey: 'a' }))).rejects.toThrow(MISMATCH);
  });

  it('refuses a slot whose injection kind is not one the runtime can inject', async () => {
    await expect(
      run(input({ apiKey: 'a' }), {
        intercept: (call) =>
          call.kind === 'all' && call.sql.includes('credential_slots')
            ? {
                value: {
                  success: true,
                  results: [
                    {
                      config_key: 'apiKey',
                      required: 1,
                      destination_host: 'h',
                      injection_kind: 'json_field',
                      injection_name: 'n',
                    },
                  ],
                  meta: {},
                },
              }
            : undefined,
      })
    ).rejects.toThrow(MISMATCH);
  });
});
