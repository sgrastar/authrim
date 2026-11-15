import { describe, expect, it } from 'vitest';
import type { MappingTransformStep } from '@authrim/ar-lib-field-mapping/contract';
import { computeIdentifier } from '../identifier-algorithms';
import {
  createIdentifierExceptionReader,
  prepareMappedIdentifiers,
  resolveIdentifierException,
  type IdentifierException,
  type IdentifierExceptionRow,
} from '../mapped-identifiers';

const row = (
  account_id: string,
  audience: string,
  action: 'salt' | 'block',
  salt_name: string | null = null
): IdentifierExceptionRow => ({ account_id, audience, action, salt_name });

describe('resolveIdentifierException (Shibboleth’s exception map)', () => {
  it.each<[string, IdentifierExceptionRow[], IdentifierException]>([
    ['nothing: the default', [], { action: 'default' }],
    [
      'the principal’s own entry for the recipient',
      [row('usr_1', 'app.example', 'salt', 'own'), row('*', 'app.example', 'block')],
      { action: 'salt', saltName: 'own' },
    ],
    [
      'the principal’s own entry for any recipient',
      [row('usr_1', '*', 'block'), row('*', 'app.example', 'salt', 'star')],
      { action: 'block' },
    ],
    [
      'the principal’s exact recipient before its `*` recipient',
      [row('usr_1', '*', 'block'), row('usr_1', 'app.example', 'salt', 'exact')],
      { action: 'salt', saltName: 'exact' },
    ],
    [
      'the `*` principal when the account has no entry at all',
      [row('*', 'app.example', 'salt', 'star')],
      { action: 'salt', saltName: 'star' },
    ],
    [
      'the `*` principal’s exact recipient before its `*` recipient',
      [row('*', '*', 'block'), row('*', 'app.example', 'salt', 'star-exact')],
      { action: 'salt', saltName: 'star-exact' },
    ],
    [
      'no fall-through: the account has an entry for another recipient only, so the default (not the `*` principal)',
      [row('usr_1', 'other.example', 'block'), row('*', 'app.example', 'block')],
      { action: 'default' },
    ],
    [
      'no fall-through for a `*` recipient entry of the account either',
      [row('usr_1', 'other.example', 'salt', 'x'), row('*', '*', 'block')],
      { action: 'default' },
    ],
    [
      'another account’s entries are not read',
      [row('usr_2', 'app.example', 'block')],
      { action: 'default' },
    ],
  ])('%s', (_name, rows, expected) => {
    expect(resolveIdentifierException(rows, 'usr_1', 'app.example')).toEqual(expected);
  });

  it('fails (never the default) on a row that says neither a salt nor a block', () => {
    expect(() =>
      resolveIdentifierException(
        [row('usr_1', 'app.example', 'salt', null)],
        'usr_1',
        'app.example'
      )
    ).toThrow();
  });
});

describe('createIdentifierExceptionReader', () => {
  it('asks for every row of the account and of `*` (the recipient is decided after)', async () => {
    const calls: unknown[][] = [];
    const reader = createIdentifierExceptionReader(
      {
        query: async <T>(_sql: string, params: unknown[]) => {
          calls.push(params);
          return [row('usr_1', 'app.example', 'block')] as unknown as T[];
        },
      },
      'tenant-a'
    );
    await expect(reader('list-a', 'usr_1', 'app.example')).resolves.toEqual({ action: 'block' });
    expect(calls).toEqual([['tenant-a', 'list-a', 'usr_1', '*']]);
  });
});

const sub = { side: 'destination', namespace: 'oidc.claim', path: 'sub' } as const;
const step = (parameters: Record<string, unknown> = {}): MappingTransformStep => ({
  id: 'step.id',
  operation: 'persistent_identifier',
  inputEdgeIds: [],
  parameters: {
    input: 'account',
    format: 'plain',
    algorithm: 'authrim_sha256',
    audience: 'sector',
    exceptions: 'list-a',
    ...parameters,
  },
  outputTargetRef: sub,
});
const encode = (text: string) => new TextEncoder().encode(text);
const b64 = (text: string) => btoa(text);

async function prepare(options: {
  exception?: IdentifierException | Error;
  stored?: string | null;
  storedParams?: Record<string, unknown>;
  importedSalts?: Record<string, string>;
  withoutLookup?: boolean;
}) {
  const asked: string[] = [];
  const result = await prepareMappedIdentifiers({
    transforms: [step(options.storedParams)],
    accountId: 'usr_1',
    recipient: { protocol: 'oidc', clientId: 'client-1', sector: 'app.example' },
    loadDefaultSalt: async () => 'tenant-salt',
    loadImportedSalt: async (name) => options.importedSalts?.[name] ?? null,
    lookupStoredIdentifier: async () => options.stored ?? null,
    ...(options.withoutLookup
      ? {}
      : {
          lookupException: async (list: string, accountId: string, audience: string) => {
            asked.push(`${list}|${accountId}|${audience}`);
            if (options.exception instanceof Error) throw options.exception;
            return options.exception ?? { action: 'default' };
          },
        }),
  });
  return { ...result, asked };
}

const made = (salt: string) =>
  computeIdentifier({
    algorithm: 'authrim_sha256',
    value: 'usr_1',
    audience: 'app.example',
    salt: encode(salt),
  });

describe('prepareMappedIdentifiers with exceptions', () => {
  it('makes it with the default salt when no exception applies, asking for the sector', async () => {
    const { identifiers, suppressed, asked } = await prepare({});
    expect(identifiers['step.id']).toBe(await made('tenant-salt'));
    expect(suppressed).toEqual({});
    expect(asked).toEqual(['list-a|usr_1|app.example']);
  });

  it('makes it with the override salt (an imported one, by name)', async () => {
    const { identifiers, failures } = await prepare({
      exception: { action: 'salt', saltName: 'old-idp' },
      importedSalts: { 'old-idp': b64('override-salt') },
    });
    expect(failures).toEqual({});
    expect(identifiers['step.id']).toBe(await made('override-salt'));
  });

  it('suppresses it on a block: neither made nor failed', async () => {
    const { identifiers, suppressed, failures } = await prepare({ exception: { action: 'block' } });
    expect(identifiers).toEqual({});
    expect(failures).toEqual({});
    expect(suppressed).toEqual({ 'step.id': true });
  });

  it('fails (never suppresses) when the override salt is missing', async () => {
    const { identifiers, suppressed, failures } = await prepare({
      exception: { action: 'salt', saltName: 'gone' },
      importedSalts: {},
    });
    expect(identifiers).toEqual({});
    expect(suppressed).toEqual({});
    expect(failures['step.id']).toBe('identifier.salt_missing');
  });

  it('fails (never suppresses) when the exceptions cannot be read', async () => {
    const { suppressed, failures } = await prepare({ exception: new Error('D1 down') });
    expect(suppressed).toEqual({});
    expect(failures['step.id']).toBe('identifier.exceptions_unavailable');
    const noReader = await prepare({ withoutLookup: true });
    expect(noReader.failures['step.id']).toBe('identifier.exceptions_unavailable');
    expect(noReader.suppressed).toEqual({});
  });

  it('lets a kept (stored) value win over an exception, a block included', async () => {
    const { identifiers, suppressed, kept, asked } = await prepare({
      stored: 'kept-value',
      storedParams: { stored: 'prefer', store: 'old-idp' },
      exception: { action: 'block' },
    });
    expect(identifiers['step.id']).toBe('kept-value');
    expect(kept['step.id']).toBe(true);
    expect(suppressed).toEqual({});
    expect(asked).toEqual([]);
  });

  it('applies an override salt over the step’s own imported salt', async () => {
    const { identifiers } = await prepare({
      storedParams: { salt: 'step-salt' },
      exception: { action: 'salt', saltName: 'old-idp' },
      importedSalts: { 'step-salt': b64('step'), 'old-idp': b64('override-salt') },
    });
    expect(identifiers['step.id']).toBe(await made('override-salt'));
  });
});
