import { describe, expect, it, vi } from 'vitest';
import {
  createSAMLSessionIndex,
  readSAMLSessionIndexNameID,
  resolveEffectiveSAMLNameIDFormat,
  resolveSAMLNameIDFormat,
  resolveSAMLNameIDValue,
  SAMLNameIDPolicyError,
} from '../subject';

const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' as const;
const UNSPECIFIED = 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified' as const;
const EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' as const;
const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient' as const;
const SP = { entityId: 'https://sp.example.org', nameIdFormat: EMAIL };
const request = (format?: string) => ({ nameIdPolicy: format ? { format } : undefined }) as never;

describe('the NameID format of an SP whose mapping makes its NameID', () => {
  it('is persistent when none, unspecified or persistent is asked for', () => {
    for (const format of [undefined, UNSPECIFIED, PERSISTENT]) {
      expect(resolveSAMLNameIDFormat(request(format), SP, { mappedNameID: true })).toBe(PERSISTENT);
    }
  });

  it('refuses any other requested format: emailAddress cannot bypass the mapped identifier', () => {
    for (const format of [EMAIL, TRANSIENT, 'urn:example:made-up']) {
      expect(() => resolveSAMLNameIDFormat(request(format), SP, { mappedNameID: true })).toThrow(
        SAMLNameIDPolicyError
      );
    }
  });

  it('is persistent for an IdP-initiated sign-in whatever the SP is configured with', () => {
    expect(resolveEffectiveSAMLNameIDFormat({ spConfig: SP, mappedNameID: true })).toBe(PERSISTENT);
    expect(
      resolveEffectiveSAMLNameIDFormat({
        spConfig: { nameIdFormat: TRANSIENT },
        mappedNameID: true,
      })
    ).toBe(PERSISTENT);
  });

  it('still refuses another SP qualifier', () => {
    expect(() =>
      resolveSAMLNameIDFormat(
        { nameIdPolicy: { spNameQualifier: 'https://other.example' } } as never,
        SP,
        { mappedNameID: true }
      )
    ).toThrow(SAMLNameIDPolicyError);
  });
});

describe('the NameID format of an SP with no mapped NameID', () => {
  it('is the requested format, else the configured one, else emailAddress', () => {
    expect(resolveSAMLNameIDFormat(request(TRANSIENT), SP)).toBe(TRANSIENT);
    expect(resolveSAMLNameIDFormat(request(UNSPECIFIED), SP)).toBe(UNSPECIFIED);
    expect(resolveSAMLNameIDFormat(request(), { ...SP, nameIdFormat: PERSISTENT })).toBe(
      PERSISTENT
    );
    expect(resolveSAMLNameIDFormat(request(), { entityId: SP.entityId } as never)).toBe(EMAIL);
    expect(() => resolveSAMLNameIDFormat(request('urn:example:made-up'), SP)).toThrow(
      SAMLNameIDPolicyError
    );
  });
});

describe('a mapped persistent NameID on every sign-in', () => {
  const registry = (stored: string | null) => ({
    get: vi.fn(async () => (stored ? JSON.stringify({ nameId: stored }) : null)),
    put: vi.fn(async () => undefined),
  });
  const context = (overrides: Record<string, unknown>) => ({
    tenantId: 'tenant-a',
    spEntityId: 'https://sp.example.org',
    pairwiseSalt: 'salt',
    ...overrides,
  });

  it('releases the NameID issued before, once the mapping has been evaluated', async () => {
    const mapped = vi.fn(async () => ({ value: 'from-mapping', kept: false }));
    const value = await resolveSAMLNameIDValue(
      { id: 'user-a' },
      PERSISTENT,
      context({
        persistentRegistry: registry('issued-before'),
        mappedNameID: mapped,
      })
    );
    expect(value).toBe('issued-before');
    expect(mapped).toHaveBeenCalledTimes(1);
  });

  it('stops the sign-in when the mapping fails, also for a NameID issued before', async () => {
    const failing = vi.fn(async () => {
      throw new Error('policy.persistent_identifier_unavailable');
    });
    await expect(
      resolveSAMLNameIDValue(
        { id: 'user-a' },
        PERSISTENT,
        context({
          persistentRegistry: registry('issued-before'),
          mappedNameID: failing,
        })
      )
    ).rejects.toThrow('persistent_identifier_unavailable');
  });

  it('records the mapped value when none was issued', async () => {
    const store = registry(null);
    const value = await resolveSAMLNameIDValue(
      { id: 'user-a' },
      PERSISTENT,
      context({
        persistentRegistry: store,
        mappedNameID: async () => ({ value: 'from-mapping', kept: true }),
      })
    );
    expect(value).toBe('from-mapping');
    expect(store.put).toHaveBeenCalledTimes(1);
  });
});

describe('the NameID recorded with a session index', () => {
  const memory = () => {
    const map = new Map<string, string>();
    return {
      put: async (key: string, value: string) => void map.set(key, value),
      get: async (key: string) => map.get(key) ?? null,
      delete: async (key: string) => void map.delete(key),
    };
  };
  const ids = { tenantId: 'tenant-a', spEntityId: 'https://sp.example.org' };

  it('keeps the issued format, and the value of a persistent one only', async () => {
    const store = memory();
    const persistent = await createSAMLSessionIndex(store, {
      ...ids,
      sessionId: 's1',
      nameId: { format: PERSISTENT, value: 'issued-id' },
    });
    const email = await createSAMLSessionIndex(store, {
      ...ids,
      sessionId: 's1',
      nameId: { format: EMAIL },
    });
    expect(await readSAMLSessionIndexNameID(store, { ...ids, sessionIndex: persistent })).toEqual({
      format: PERSISTENT,
      value: 'issued-id',
    });
    const kept = await readSAMLSessionIndexNameID(store, { ...ids, sessionIndex: email });
    expect(kept).toEqual({ format: EMAIL });
    // Another SP's record, and one made before the NameID was kept, are not read.
    expect(
      await readSAMLSessionIndexNameID(store, {
        tenantId: 'tenant-a',
        spEntityId: 'https://other.example',
        sessionIndex: persistent,
      })
    ).toBeNull();
    const old = await createSAMLSessionIndex(store, { ...ids, sessionId: 's1' });
    expect(await readSAMLSessionIndexNameID(store, { ...ids, sessionIndex: old })).toBeNull();
  });
});
