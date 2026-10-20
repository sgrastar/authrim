import { describe, expect, it } from 'vitest';
import {
  IdentityMappingSelectionError,
  readClientIdentityMappingChoice,
  selectIdentityMapping,
  type IdentityMappingSelection,
} from '../identity-mapping-selection';

/**
 * The order is: the app's own choice, then the tenant's default, then the platform's, then none.
 * Only an unset level falls to the next; a level that is set and unusable fails. The real
 * effective-settings reader runs here over a KV double; there is no database anywhere in this file.
 */

const KEY = 'identity_mapping.oidc_default_set_id';

function kv(documents: Record<string, unknown>): KVNamespace {
  return {
    get: async (key: string) => {
      if (!(key in documents)) return null;
      const value = documents[key];
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
  } as unknown as KVNamespace;
}

type Level = 'unset' | 'set' | 'none' | 'invalid';

function documents(tenant: Level, platform: Level): Record<string, unknown> {
  const docs: Record<string, unknown> = {};
  if (tenant === 'set') docs['settings:tenant:acme:identity-mapping'] = { [KEY]: 'set-T' };
  if (tenant === 'none') docs['settings:tenant:acme:identity-mapping'] = { [KEY]: 'none' };
  if (tenant === 'invalid') docs['settings:tenant:acme:identity-mapping'] = { [KEY]: '' };
  if (platform === 'set') docs['settings:platform:identity-mapping'] = { [KEY]: 'set-P' };
  if (platform === 'invalid') docs['settings:platform:identity-mapping'] = { [KEY]: 'none' };
  return docs;
}

const CLIENTS = {
  unset: null,
  set: { fieldMappingSetId: 'set-A', fieldMappingVersionId: 'ver-1' },
  none: { mode: 'none' },
} as const;

type Outcome =
  | { kind: 'bound'; tier: string; setId: string }
  | { kind: 'none'; reason: string }
  | { error: string; tier: string };

async function select(
  clientSelector: unknown,
  docs: Record<string, unknown>,
  extra: { inspectDefaults?: boolean } = {}
): Promise<IdentityMappingSelection> {
  return selectIdentityMapping({
    env: { SETTINGS: kv(docs) },
    tenantId: 'acme',
    protocol: 'oidc',
    clientSelector,
    ...extra,
  });
}

async function outcome(clientSelector: unknown, docs: Record<string, unknown>): Promise<Outcome> {
  try {
    const selection = await select(clientSelector, docs);
    return selection.kind === 'bound'
      ? { kind: 'bound', tier: selection.tier, setId: selection.setId }
      : { kind: 'none', reason: selection.reason };
  } catch (error) {
    if (error instanceof IdentityMappingSelectionError) {
      return { error: error.code, tier: String(error.tier) };
    }
    throw error;
  }
}

// The order of the design (client, tenant default, platform default, none), written out.
const ALL_TENANT_LEVELS: Level[] = ['unset', 'set', 'none', 'invalid'];
const ALL_PLATFORM_LEVELS: Level[] = ['unset', 'set', 'invalid'];

describe('selectIdentityMapping: the order', () => {
  describe('an app that names a set', () => {
    it.each(
      ALL_TENANT_LEVELS.flatMap((tenant) =>
        ALL_PLATFORM_LEVELS.map((platform) => [tenant, platform] as const)
      )
    )(
      'is bound to it whatever the tenant (%s) and the platform (%s) say',
      async (tenant, platform) => {
        expect(await outcome(CLIENTS.set, documents(tenant, platform))).toEqual({
          kind: 'bound',
          tier: 'client',
          setId: 'set-A',
        });
      }
    );

    it('carries the selector it named (a pinned version)', async () => {
      const selection = await select(CLIENTS.set, {});
      expect(selection).toMatchObject({
        kind: 'bound',
        selector: { fieldMappingSetId: 'set-A', fieldMappingVersionId: 'ver-1' },
      });
    });
  });

  describe('an app that opts out', () => {
    it.each(
      ALL_TENANT_LEVELS.flatMap((tenant) =>
        ALL_PLATFORM_LEVELS.map((platform) => [tenant, platform] as const)
      )
    )('gets none whatever the tenant (%s) and the platform (%s) say', async (tenant, platform) => {
      expect(await outcome(CLIENTS.none, documents(tenant, platform))).toEqual({
        kind: 'none',
        reason: 'client_opt_out',
      });
    });
  });

  describe('an app that names nothing', () => {
    it.each([
      // tenant, platform, expected
      ['unset', 'unset', { kind: 'none', reason: 'no_default' }],
      ['unset', 'set', { kind: 'bound', tier: 'platform_default', setId: 'set-P' }],
      ['set', 'unset', { kind: 'bound', tier: 'tenant_default', setId: 'set-T' }],
      ['set', 'set', { kind: 'bound', tier: 'tenant_default', setId: 'set-T' }],
      ['none', 'unset', { kind: 'none', reason: 'tenant_opt_out' }],
      // The tenant's none stops the platform's default.
      ['none', 'set', { kind: 'none', reason: 'tenant_opt_out' }],
      // A tenant default that is set and unusable fails: it does not fall to the platform's.
      ['invalid', 'unset', { error: 'default_setting_invalid', tier: 'tenant_default' }],
      ['invalid', 'set', { error: 'default_setting_invalid', tier: 'tenant_default' }],
      // A platform default that is set and unusable fails: it does not become "no default".
      ['unset', 'invalid', { error: 'default_setting_invalid', tier: 'platform_default' }],
      // ...unless a level above it decides.
      ['set', 'invalid', { kind: 'bound', tier: 'tenant_default', setId: 'set-T' }],
      ['none', 'invalid', { kind: 'none', reason: 'tenant_opt_out' }],
      ['invalid', 'invalid', { error: 'default_setting_invalid', tier: 'tenant_default' }],
    ] as Array<[Level, Level, Outcome]>)(
      'with the tenant %s and the platform %s',
      async (tenant, platform, expected) => {
        expect(await outcome(null, documents(tenant, platform))).toEqual(expected);
      }
    );

    it('treats an app row that holds nothing (an empty object, no row value) as unset', async () => {
      for (const raw of [undefined, null, '', '  ', {}, { destinationProfileId: 'profile-1' }]) {
        expect(await outcome(raw, documents('set', 'unset'))).toMatchObject({
          kind: 'bound',
          tier: 'tenant_default',
        });
      }
    });
  });

  it('does not take the disabled marker of a tenant default for "unset"', async () => {
    // The settings reader gives false for the marker; the platform's default must not take over.
    expect(
      await outcome(null, {
        'settings:tenant:acme:identity-mapping': { [KEY]: '__DISABLED__' },
        'settings:platform:identity-mapping': { [KEY]: 'set-P' },
      })
    ).toEqual({ error: 'default_setting_invalid', tier: 'tenant_default' });
  });

  it('lets a tenant document that stores null fall to the platform (unset is unset)', async () => {
    expect(
      await outcome(null, {
        'settings:tenant:acme:identity-mapping': { [KEY]: null },
        'settings:platform:identity-mapping': { [KEY]: 'set-P' },
      })
    ).toEqual({ kind: 'bound', tier: 'platform_default', setId: 'set-P' });
  });

  it('uses the platform default of another tenant’s document for no tenant', async () => {
    const docs = {
      'settings:tenant:globex:identity-mapping': { [KEY]: 'set-G' },
      'settings:platform:identity-mapping': { [KEY]: 'set-P' },
    };
    expect(await outcome(null, docs)).toEqual({
      kind: 'bound',
      tier: 'platform_default',
      setId: 'set-P',
    });
  });
});

describe('selectIdentityMapping: the app’s own value', () => {
  it.each([
    ['a set ID that is not a string', { fieldMappingSetId: 7 }],
    ['an empty set ID', { fieldMappingSetId: '' }],
    ['a blank set ID', { fieldMappingSetId: '   ' }],
    ['a padded set ID', { fieldMappingSetId: ' set-A' }],
    ['an over-long set ID', { fieldMappingSetId: 'a'.repeat(201) }],
    ['an unknown mode', { mode: 'inherit' }],
    ['a mode that is not none', { mode: 'set', fieldMappingSetId: 'set-A' }],
    ['none beside a set', { mode: 'none', fieldMappingSetId: 'set-A' }],
    ['a legacy set ID that is not a string', { policySetId: { id: 1 } }],
    ['JSON that does not parse', '{"fieldMappingSetId":'],
    ['JSON that is not an object', '"set-A"'],
    ['an array', ['set-A']],
    ['a number', 3],
  ])('fails for %s, and does not fall to the defaults', async (_name, raw) => {
    const docs = documents('set', 'set');
    await expect(select(raw, docs)).rejects.toMatchObject({
      name: 'IdentityMappingSelectionError',
      code: 'client_selector_invalid',
      tier: 'client',
    });
  });

  it('reads the stored JSON text as the parsed object', async () => {
    expect(await outcome('{"fieldMappingSetId":"set-A"}', {})).toEqual({
      kind: 'bound',
      tier: 'client',
      setId: 'set-A',
    });
    expect(await outcome('{"mode":"none"}', documents('set', 'set'))).toEqual({
      kind: 'none',
      reason: 'client_opt_out',
    });
  });

  it('reads the older spelling policySetId as the set, the new one first', async () => {
    expect(readClientIdentityMappingChoice({ policySetId: 'set-L' })).toMatchObject({
      kind: 'set',
      setId: 'set-L',
    });
    expect(
      readClientIdentityMappingChoice({ fieldMappingSetId: 'set-N', policySetId: 'set-L' })
    ).toMatchObject({ kind: 'set', setId: 'set-N' });
    expect(readClientIdentityMappingChoice({ mode: 'none', policySetId: 'set-L' })).toEqual({
      kind: 'invalid',
    });
  });

  it('keeps only the string fields of the selector it knows', () => {
    expect(
      readClientIdentityMappingChoice({
        fieldMappingSetId: 'set-A',
        fieldMappingVersionId: 'ver-1',
        destinationNamespace: 'oidc.claim',
        sourceProfileId: 5,
        destinationProfileId: '',
        mode: undefined,
        extra: 'ignored',
      })
    ).toEqual({
      kind: 'set',
      setId: 'set-A',
      selector: {
        fieldMappingSetId: 'set-A',
        fieldMappingVersionId: 'ver-1',
        destinationNamespace: 'oidc.claim',
      },
    });
  });
});

describe('selectIdentityMapping: the settings', () => {
  const unreadable = [
    ['a read that throws', { get: async () => Promise.reject(new Error('KV down')) }],
    ['a document that does not parse', { get: async () => '{not json' }],
  ] as const;

  it.each(unreadable)(
    'throws settings_unreadable for %s, and does not say "no default"',
    async (_n, namespace) => {
      const error = await selectIdentityMapping({
        env: { SETTINGS: namespace as unknown as KVNamespace },
        tenantId: 'acme',
        protocol: 'oidc',
        clientSelector: null,
      }).then(
        () => undefined,
        (thrown: unknown) => thrown
      );
      expect(error).toBeInstanceOf(IdentityMappingSelectionError);
      expect(error).toMatchObject({ code: 'settings_unreadable' });
      // Nothing of the failure is kept.
      expect(JSON.stringify(error)).not.toContain('KV down');
      expect(String((error as Error).message)).not.toContain('KV down');
    }
  );

  it('does not read the settings for an app that decides on its own', async () => {
    const reads: string[] = [];
    const namespace = {
      get: async (key: string) => {
        reads.push(key);
        throw new Error('the settings must not be read');
      },
    } as unknown as KVNamespace;
    for (const clientSelector of [CLIENTS.set, CLIENTS.none]) {
      await expect(
        selectIdentityMapping({
          env: { SETTINGS: namespace },
          tenantId: 'acme',
          protocol: 'oidc',
          clientSelector,
        })
      ).resolves.toMatchObject({ kind: expect.any(String) });
    }
    expect(reads).toEqual([]);
  });

  it('is not given the Admin database, and does not touch it', async () => {
    const env = {
      SETTINGS: kv(documents('set', 'set')),
      get DB_ADMIN(): never {
        throw new Error('the selection must not use the database');
      },
      get DB(): never {
        throw new Error('the selection must not use the database');
      },
    };
    await expect(
      selectIdentityMapping({ env, tenantId: 'acme', protocol: 'oidc', clientSelector: null })
    ).resolves.toMatchObject({ kind: 'bound', tier: 'tenant_default', setId: 'set-T' });
    await expect(
      selectIdentityMapping({
        env,
        tenantId: 'acme',
        protocol: 'oidc',
        clientSelector: CLIENTS.set,
      })
    ).resolves.toMatchObject({ kind: 'bound', tier: 'client' });
  });

  it('is decided by the value’s source: the tenant’s own value or the inherited one', async () => {
    // The same value, saved at the platform only, is the platform's...
    const inherited = await select(null, {
      'settings:platform:identity-mapping': { [KEY]: 'set-X' },
    });
    expect(inherited).toMatchObject({ kind: 'bound', tier: 'platform_default', setId: 'set-X' });
    // ...and saved at the tenant, the tenant's.
    const own = await select(null, { 'settings:tenant:acme:identity-mapping': { [KEY]: 'set-X' } });
    expect(own).toMatchObject({ kind: 'bound', tier: 'tenant_default', setId: 'set-X' });
  });
});

describe('selectIdentityMapping: the chain', () => {
  it('shows an inherited platform default as the platform’s and the tenant as unset', async () => {
    const { chain } = await select(null, documents('unset', 'set'));
    expect(chain).toEqual([
      { tier: 'client', state: 'unset' },
      { tier: 'tenant_default', state: 'unset' },
      { tier: 'platform_default', state: 'set', setId: 'set-P', source: 'platform' },
    ]);
  });

  it('shows the tenant’s own default with where it was saved, and the platform as not consulted', async () => {
    const { chain } = await select(null, documents('set', 'set'));
    expect(chain).toEqual([
      { tier: 'client', state: 'unset' },
      { tier: 'tenant_default', state: 'set', setId: 'set-T', source: 'kv' },
      { tier: 'platform_default', state: 'not_consulted' },
    ]);
  });

  it('shows every level when asked, even where the tenant or the app decides', async () => {
    expect((await select(null, documents('set', 'set'), { inspectDefaults: true })).chain).toEqual([
      { tier: 'client', state: 'unset' },
      { tier: 'tenant_default', state: 'set', setId: 'set-T', source: 'kv' },
      { tier: 'platform_default', state: 'set', setId: 'set-P', source: 'platform' },
    ]);
    const byClient = await select(CLIENTS.set, documents('none', 'set'), { inspectDefaults: true });
    expect(byClient).toMatchObject({ kind: 'bound', tier: 'client', setId: 'set-A' });
    expect(byClient.chain).toEqual([
      { tier: 'client', state: 'set', setId: 'set-A' },
      { tier: 'tenant_default', state: 'none', source: 'kv' },
      { tier: 'platform_default', state: 'set', setId: 'set-P', source: 'platform' },
    ]);
  });

  it('does not fail an app’s own answer for a default that is unusable, only shows it', async () => {
    const selection = await select(CLIENTS.none, documents('invalid', 'invalid'), {
      inspectDefaults: true,
    });
    expect(selection).toMatchObject({ kind: 'none', reason: 'client_opt_out' });
    expect(selection.chain.map((entry) => entry.state)).toEqual(['none', 'invalid', 'invalid']);
  });

  it('shows the app’s opt-out and set, and not consulted for the levels below at runtime', async () => {
    expect((await select(CLIENTS.none, {})).chain.map((e) => e.state)).toEqual([
      'none',
      'not_consulted',
      'not_consulted',
    ]);
  });

  it('is on the error of a default that is unusable, with the levels that were reached', async () => {
    const error = await select(null, documents('invalid', 'set')).then(
      () => undefined,
      (thrown: unknown) => thrown as IdentityMappingSelectionError
    );
    expect(error?.chain?.map((entry) => entry.state)).toEqual([
      'unset',
      'invalid',
      'not_consulted',
    ]);
  });

  it('does not fail a view of the app’s own answer when the defaults cannot be read', async () => {
    const selection = await selectIdentityMapping({
      env: { SETTINGS: { get: async () => '{not json' } as unknown as KVNamespace },
      tenantId: 'acme',
      protocol: 'oidc',
      clientSelector: CLIENTS.set,
      inspectDefaults: true,
    });
    expect(selection).toMatchObject({ kind: 'bound', tier: 'client' });
    expect(selection.chain.map((entry) => entry.state)).toEqual([
      'set',
      'not_consulted',
      'not_consulted',
    ]);
  });
});
