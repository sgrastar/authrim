import { describe, expect, it } from 'vitest';
import type { MappingTransformStep } from '@authrim/ar-lib-field-mapping/contract';
import { computeIdentifier } from '../identifier-algorithms';
import {
  createIdentifierSourceReader,
  createStoredIdentifierLookup,
  prepareMappedIdentifiers,
  resolvePairwiseSector,
  type IdentifierRecipient,
} from '../mapped-identifiers';

const target = { side: 'destination', namespace: 'oidc.claim', path: 'sub' } as const;
/** A step takes no input edge: it is made from the account ID or an identifier source. */
const step = (
  parameters: Record<string, unknown>,
  inputEdgeIds: string[] = []
): MappingTransformStep => ({
  id: 'step.id',
  operation: 'persistent_identifier',
  inputEdgeIds,
  parameters: { input: 'account', ...parameters },
  outputTargetRef: target,
});
const oidc: IdentifierRecipient = { protocol: 'oidc', clientId: 'client-1', sector: 'app.example' };
const saml: IdentifierRecipient = {
  protocol: 'saml',
  spEntityId: 'https://sp.example.org',
  idpEntityId: 'https://idp.example.org',
};

async function prepare(
  parameters: Record<string, unknown>,
  options: {
    accountId?: string | null;
    sourceValue?: string | null | (() => Promise<string | null>);
    recipient?: IdentifierRecipient;
    salt?: string | null;
    placeholder?: string;
    inputEdgeIds?: string[];
  } = {}
) {
  let saltReads = 0;
  const result = await prepareMappedIdentifiers({
    transforms: [step(parameters, options.inputEdgeIds)],
    accountId: 'accountId' in options ? (options.accountId ?? null) : 'usr_1',
    lookupSourceValue:
      options.sourceValue === undefined
        ? undefined
        : async () =>
            typeof options.sourceValue === 'function'
              ? options.sourceValue()
              : (options.sourceValue ?? null),
    recipient: options.recipient ?? oidc,
    loadDefaultSalt: async () => {
      saltReads++;
      return options.salt === undefined ? 'tenant-salt' : options.salt;
    },
    placeholder: options.placeholder,
  });
  return { ...result, saltReads };
}

describe('prepareMappedIdentifiers', () => {
  it('makes an OIDC pairwise sub for the client from the account ID', async () => {
    const { identifiers, failures } = await prepare({
      format: 'plain',
      algorithm: 'authrim_sha256',
    });
    expect(failures).toEqual({});
    expect(identifiers['step.id']).toBe(
      await computeIdentifier({
        algorithm: 'authrim_sha256',
        value: 'usr_1',
        audience: 'client-1',
        salt: new TextEncoder().encode('tenant-salt'),
      })
    );
  });

  it('uses the sector, and never falls back to the client ID without one', async () => {
    const sector = await prepare({
      format: 'plain',
      algorithm: 'keycloak_sha256',
      audience: 'sector',
    });
    expect(sector.identifiers['step.id']).toBe(
      await computeIdentifier({
        algorithm: 'keycloak_sha256',
        value: 'usr_1',
        audience: 'app.example',
        salt: new TextEncoder().encode('tenant-salt'),
      })
    );
    const none = await prepare(
      { format: 'plain', algorithm: 'keycloak_sha256', audience: 'sector' },
      { recipient: { ...oidc, sector: null } }
    );
    expect(none.identifiers).toEqual({});
    expect(none.failures['step.id']).toBe('identifier.sector_missing');
  });

  it('frames SAML identifiers: eduPersonTargetedID and a scoped pairwise-id', async () => {
    const targeted = await prepare(
      { format: 'saml_targeted_id', algorithm: 'shibboleth' },
      { recipient: saml }
    );
    expect(targeted.identifiers['step.id']).toMatch(
      /^https:\/\/idp\.example\.org!https:\/\/sp\.example\.org!.+=$/
    );
    const pairwise = await prepare(
      {
        format: 'saml_pairwise_id',
        algorithm: 'shibboleth',
        encoding: 'base32',
        scope: 'example.org',
      },
      { recipient: saml }
    );
    expect(pairwise.identifiers['step.id']).toMatch(/^[A-Z2-7]+=*@example\.org$/);
    const ssp = await prepare(
      { format: 'saml_pairwise_id', algorithm: 'simplesamlphp_pairwise_id', scope: 'example.org' },
      { recipient: saml }
    );
    expect(ssp.identifiers['step.id']).toMatch(/^[0-9a-f]{64}@example\.org$/);
  });

  it('refuses a pairwise-id that breaks the OASIS grammar (base64 with "+" or "/")', async () => {
    const result = await prepare(
      { format: 'saml_pairwise_id', algorithm: 'shibboleth', scope: 'example.org' },
      { recipient: saml, accountId: 'someone-whose-base64-has-a-slash' }
    );
    // Base64 may or may not hold "+" or "/" for a given value; when it does, it is refused.
    const made = result.identifiers['step.id'];
    if (made) expect(made).toMatch(/^[A-Za-z0-9][A-Za-z0-9=-]*@example\.org$/);
    else expect(result.failures['step.id']).toBe('identifier.invalid_subject_identifier');
  });

  it('refuses settings that cannot make a valid identifier', async () => {
    const cases: Array<[Record<string, unknown>, IdentifierRecipient, string]> = [
      [
        { format: 'saml_targeted_id', algorithm: 'shibboleth' },
        oidc,
        'identifier.invalid_settings',
      ],
      [
        { format: 'plain', algorithm: 'shibboleth', audience: 'sector' },
        saml,
        'identifier.invalid_settings',
      ],
      [
        { format: 'plain', algorithm: 'authrim_sha256', encoding: 'base32' },
        oidc,
        'identifier.invalid_settings',
      ],
      [
        { format: 'plain', algorithm: 'simplesamlphp_persistent_nameid' },
        oidc,
        'identifier.invalid_settings',
      ],
      // The same identifier for every SP must not go out as a per-SP one.
      [
        { format: 'saml_pairwise_id', algorithm: 'simplesamlphp_subject_id', scope: 'example.org' },
        saml,
        'identifier.invalid_settings',
      ],
      [
        { format: 'saml_pairwise_id', algorithm: 'shibboleth', encoding: 'base32' },
        saml,
        'identifier.scope_missing',
      ],
      [
        { format: 'saml_pairwise_id', algorithm: 'shibboleth', scope: '-bad' },
        saml,
        'identifier.invalid_scope',
      ],
      [
        { format: 'plain', algorithm: 'authrim_sha256', salt: 'imported' },
        oidc,
        'identifier.salt_missing',
      ],
    ];
    for (const [parameters, recipient, code] of cases) {
      const result = await prepare(parameters, { recipient });
      expect(result.identifiers, JSON.stringify(parameters)).toEqual({});
      expect(result.failures['step.id'], JSON.stringify(parameters)).toBe(code);
    }
  });

  it('makes nothing without an account ID, or from a step that still has an input edge', async () => {
    for (const accountId of [null, '']) {
      const result = await prepare({ format: 'plain', algorithm: 'authrim_sha256' }, { accountId });
      expect(result.identifiers).toEqual({});
      expect(result.failures['step.id']).toBe('identifier.account_missing');
    }
    const withEdge = await prepare(
      { format: 'plain', algorithm: 'authrim_sha256' },
      { inputEdgeIds: ['edge.uid'] }
    );
    expect(withEdge.identifiers).toEqual({});
    expect(withEdge.failures['step.id']).toBe('identifier.input_edge_not_allowed');
  });

  it('makes the identifier from the identifier source, never from the account ID', async () => {
    const parameters = {
      format: 'plain',
      algorithm: 'authrim_sha256',
      input: 'source',
      source: 'staff',
    };
    const fromSource = await prepare(parameters, { sourceValue: 'E-1001' });
    expect(fromSource.failures).toEqual({});
    expect(fromSource.identifiers['step.id']).toBe(
      await computeIdentifier({
        algorithm: 'authrim_sha256',
        value: 'E-1001',
        audience: 'client-1',
        salt: new TextEncoder().encode('tenant-salt'),
      })
    );
    // No row for the account: the step fails, and the account ID does not stand in for it.
    const none = await prepare(parameters, { sourceValue: null });
    expect(none.identifiers).toEqual({});
    expect(none.failures['step.id']).toBe('identifier.source_missing');
    const empty = await prepare(parameters, { sourceValue: '' });
    expect(empty.failures['step.id']).toBe('identifier.source_missing');
    const broken = await prepare(parameters, {
      sourceValue: async () => {
        throw new Error('database down');
      },
    });
    expect(broken.failures['step.id']).toBe('identifier.source_unavailable');
    // No reader at all.
    const unreadable = await prepare(parameters, {});
    expect(unreadable.failures['step.id']).toBe('identifier.source_unavailable');
    // The source is asked for by its name and the account.
    const asked: Array<[string, string]> = [];
    await prepareMappedIdentifiers({
      transforms: [step(parameters)],
      accountId: 'acct-7',
      recipient: oidc,
      loadDefaultSalt: async () => 'tenant-salt',
      lookupSourceValue: async (name, account) => {
        asked.push([name, account]);
        return 'E-1';
      },
    });
    expect(asked).toEqual([['staff', 'acct-7']]);
  });

  it('reads a source value and a stored identifier by tenant, name and account only', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const adapter = {
      async queryOne<T>(sql: string, params: unknown[]): Promise<T | null> {
        calls.push([sql, params]);
        return null;
      },
    };
    await createIdentifierSourceReader(adapter, 'tenant-a')('staff', 'acct-1');
    await createStoredIdentifierLookup(adapter, 'tenant-a')('shibpid', 'https://sp', 'acct-1');
    expect(calls[0][1]).toEqual(['tenant-a', 'staff', 'acct-1']);
    expect(calls[0][0]).toMatch(/identifier_source_values[\s\S]*account_id = \?/);
    expect(calls[1][1]).toEqual(['tenant-a', 'shibpid', 'https://sp', 'acct-1']);
    expect(calls[1][0]).toMatch(/mapped_identifier_values[\s\S]*account_id = \?/);
  });

  it('makes a migrated identifier with an imported salt, read as bytes, never made up', async () => {
    const run = (name: string, stored: string | null) =>
      prepareMappedIdentifiers({
        transforms: [step({ format: 'plain', algorithm: 'shibboleth', salt: name })],
        accountId: 'jdoe',
        recipient: { ...oidc, clientId: 'https://sp.example.org/shibboleth' },
        loadDefaultSalt: async () => 'tenant-salt',
        loadImportedSalt: async (requested) => (requested === name ? stored : null),
      });
    // The salt's bytes: base64 of "0123456789abcdef-salt".
    const imported = await run('shib', btoa('0123456789abcdef-salt'));
    expect(imported.identifiers['step.id']).toBe('iXw0A3ZJeWL04PK1adRXebjDCVI=');
    const missing = await run('shib', null);
    expect(missing.failures['step.id']).toBe('identifier.salt_missing');
    const broken = await run('shib', '***');
    expect(broken.failures['step.id']).toBe('identifier.salt_missing');
    const badName = await run('Bad Name', btoa('x'));
    expect(badName.failures['step.id']).toBe('identifier.invalid_settings');
  });

  it('releases a kept identifier first, and never computes one when the lookup fails', async () => {
    const lookups: Array<[string, string, string]> = [];
    const run = (stored: string, lookup: () => Promise<string | null>) =>
      prepareMappedIdentifiers({
        transforms: [
          step({
            format: 'saml_pairwise_id',
            algorithm: 'shibboleth',
            encoding: 'base32',
            scope: 'example.org',
            stored,
            store: 'shibpid',
          }),
        ],
        accountId: 'jdoe',
        recipient: saml,
        loadDefaultSalt: async () => 'tenant-salt',
        lookupStoredIdentifier: async (store, audience, account) => {
          lookups.push([store, audience, account]);
          return lookup();
        },
      });
    const kept = await run('prefer', async () => 'KEPTVALUE');
    expect(kept.identifiers['step.id']).toBe('KEPTVALUE@example.org');
    // By the account the identifier was imported for.
    expect(lookups[0]).toEqual(['shibpid', 'https://sp.example.org', 'jdoe']);
    const computed = await run('prefer', async () => null);
    expect(computed.identifiers['step.id']).toMatch(/^[A-Z2-7]+=*@example\.org$/);
    const required = await run('require', async () => null);
    expect(required.failures['step.id']).toBe('identifier.stored_missing');
    const broken = await run('prefer', async () => {
      throw new Error('database down');
    });
    expect(broken.identifiers).toEqual({});
    expect(broken.failures['step.id']).toBe('identifier.stored_unavailable');
  });

  it('makes nothing without the salt, and reads no salt for a placeholder', async () => {
    const noSalt = await prepare({ format: 'plain', algorithm: 'authrim_sha256' }, { salt: null });
    expect(noSalt.failures['step.id']).toBe('identifier.salt_missing');
    const deferred = await prepare(
      { format: 'plain', algorithm: 'authrim_sha256' },
      { placeholder: 'deferred' }
    );
    expect(deferred.identifiers['step.id']).toBe('deferred');
    expect(deferred.saltReads).toBe(0);
  });

  it('never puts the salt or the input into a failure', async () => {
    const result = await prepare(
      { format: 'saml_targeted_id', algorithm: 'shibboleth' },
      { accountId: 'secret-user', salt: 'secret-salt' }
    );
    expect(JSON.stringify(result.failures)).not.toMatch(/secret-(user|salt)/);
  });
});

describe('resolvePairwiseSector', () => {
  it('takes the sector URI host, else the one redirect host', () => {
    expect(
      resolvePairwiseSector({ sectorIdentifierUri: 'https://Sector.Example:8443/x.json' })
    ).toBe('sector.example');
    expect(
      resolvePairwiseSector({
        redirectUris: ['https://app.example/cb', 'https://app.example:444/other'],
      })
    ).toBe('app.example');
  });

  it('cannot tell one sector from several hosts, none, or a broken URI', () => {
    expect(
      resolvePairwiseSector({ redirectUris: ['https://a.example/cb', 'https://b.example/cb'] })
    ).toBeNull();
    expect(resolvePairwiseSector({ redirectUris: [] })).toBeNull();
    expect(resolvePairwiseSector({ redirectUris: ['not a url'] })).toBeNull();
    expect(resolvePairwiseSector({ sectorIdentifierUri: 'nope' })).toBeNull();
  });

  it('punycodes an international host', () => {
    expect(resolvePairwiseSector({ redirectUris: ['https://例え.テスト/cb'] })).toBe(
      'xn--r8jz45g.xn--zckzah'
    );
  });
});
