import { describe, expect, it } from 'vitest';
import { NAMEID_FORMATS } from '../../common/constants';
import {
  buildSAMLSessionIndexKey,
  buildSAMLTransientNameIDKey,
  buildSAMLPersistentNameIDRegistryKey,
  buildSAMLPairwiseSecretRef,
  buildSAMLPairwiseSectorIdentifier,
  createSAMLSessionIndex,
  resolveSAMLNameIDFormat,
  resolveSAMLNameIDValue,
  resolveSAMLPairwiseSalt,
  resolveSAMLPersistentNameIDRegistryStore,
  resolveSAMLSessionIndexToSessionId,
  resolveSAMLTransientNameIDStore,
  SAMLNameIDPolicyError,
  type SAMLPersistentNameIDRegistryStore,
  type SAMLTransientNameIDStore,
} from '../subject';

describe('resolveSAMLNameIDValue', () => {
  const subject = {
    id: 'user-123',
    email: 'user@example.com',
  };

  it('uses email for emailAddress NameID format', async () => {
    await expect(resolveSAMLNameIDValue(subject, NAMEID_FORMATS.EMAIL)).resolves.toBe(
      'user@example.com'
    );
  });

  it('uses deterministic pairwise id for persistent NameID format', async () => {
    const nameId = await resolveSAMLNameIDValue(subject, NAMEID_FORMATS.PERSISTENT, {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.com/saml',
      pairwiseSalt: 'test-pairwise-salt',
    });

    expect(nameId).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(
      resolveSAMLNameIDValue(subject, NAMEID_FORMATS.PERSISTENT, {
        tenantId: 'tenant-a',
        spEntityId: 'https://sp.example.com/saml',
        pairwiseSalt: 'test-pairwise-salt',
      })
    ).resolves.toBe(nameId);
  });

  it('changes persistent NameID across tenants and SPs', async () => {
    const base = await resolveSAMLNameIDValue(subject, NAMEID_FORMATS.PERSISTENT, {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp-a.example.com/saml',
      pairwiseSalt: 'test-pairwise-salt',
    });
    const otherTenant = await resolveSAMLNameIDValue(subject, NAMEID_FORMATS.PERSISTENT, {
      tenantId: 'tenant-b',
      spEntityId: 'https://sp-a.example.com/saml',
      pairwiseSalt: 'test-pairwise-salt',
    });
    const otherSp = await resolveSAMLNameIDValue(subject, NAMEID_FORMATS.PERSISTENT, {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp-b.example.com/saml',
      pairwiseSalt: 'test-pairwise-salt',
    });

    expect(otherTenant).not.toBe(base);
    expect(otherSp).not.toBe(base);
  });

  it('requires pairwise salt for persistent NameID format', async () => {
    await expect(
      resolveSAMLNameIDValue(subject, NAMEID_FORMATS.PERSISTENT, {
        tenantId: 'tenant-a',
        spEntityId: 'https://sp.example.com/saml',
      })
    ).rejects.toThrow('PAIRWISE_SALT is required');
  });

  it('stores newly-created persistent NameID values in the registry', async () => {
    const writes = new Map<string, string>();
    const registry: SAMLPersistentNameIDRegistryStore = {
      async put(key, value) {
        writes.set(key, value);
      },
      async get(key) {
        return writes.get(key) ?? null;
      },
    };

    const nameId = await resolveSAMLNameIDValue(subject, NAMEID_FORMATS.PERSISTENT, {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.com/saml',
      pairwiseSalt: 'test-pairwise-salt',
      persistentRegistry: registry,
      allowCreate: true,
    });
    const key = buildSAMLPersistentNameIDRegistryKey(
      'tenant-a',
      'https://sp.example.com/saml',
      'user-123'
    );

    expect(JSON.parse(writes.get(key)!)).toMatchObject({
      version: 1,
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.com/saml',
      subjectId: 'user-123',
      nameId,
    });
  });

  it('uses existing persistent NameID registry values when AllowCreate=false', async () => {
    const registry: SAMLPersistentNameIDRegistryStore = {
      async put() {
        throw new Error('should not create a new registry entry');
      },
      async get() {
        return JSON.stringify({
          version: 1,
          nameId: 'existing-persistent-nameid',
        });
      },
    };

    await expect(
      resolveSAMLNameIDValue(subject, NAMEID_FORMATS.PERSISTENT, {
        tenantId: 'tenant-a',
        spEntityId: 'https://sp.example.com/saml',
        pairwiseSalt: 'test-pairwise-salt',
        persistentRegistry: registry,
        allowCreate: false,
      })
    ).resolves.toBe('existing-persistent-nameid');
  });

  it('rejects persistent NameID creation when AllowCreate=false and no registry entry exists', async () => {
    const registry: SAMLPersistentNameIDRegistryStore = {
      async put() {
        throw new Error('should not create a new registry entry');
      },
      async get() {
        return null;
      },
    };

    await expect(
      resolveSAMLNameIDValue(subject, NAMEID_FORMATS.PERSISTENT, {
        tenantId: 'tenant-a',
        spEntityId: 'https://sp.example.com/saml',
        pairwiseSalt: 'test-pairwise-salt',
        persistentRegistry: registry,
        allowCreate: false,
      })
    ).rejects.toThrow(SAMLNameIDPolicyError);
  });

  it('rejects AllowCreate=false when persistent NameID registry is unavailable', async () => {
    await expect(
      resolveSAMLNameIDValue(subject, NAMEID_FORMATS.PERSISTENT, {
        tenantId: 'tenant-a',
        spEntityId: 'https://sp.example.com/saml',
        pairwiseSalt: 'test-pairwise-salt',
        allowCreate: false,
      })
    ).rejects.toThrow(SAMLNameIDPolicyError);
  });

  it('uses random short-lived state for transient NameID format', async () => {
    const writes: Array<{ key: string; value: string; ttl?: number }> = [];
    const transientStore: SAMLTransientNameIDStore = {
      async put(key, value, options) {
        writes.push({ key, value, ttl: options?.expirationTtl });
      },
    };

    const nameId = await resolveSAMLNameIDValue(subject, NAMEID_FORMATS.TRANSIENT, {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.com/saml',
      transientStore,
      transientTtlSeconds: 120,
      sessionId: 'sess-123',
    });

    expect(nameId).toMatch(/^trn_[A-Za-z0-9_-]+$/);
    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe(
      buildSAMLTransientNameIDKey('tenant-a', 'https://sp.example.com/saml', nameId)
    );
    expect(writes[0].ttl).toBe(120);
    expect(JSON.parse(writes[0].value)).toMatchObject({
      version: 1,
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.com/saml',
      subjectId: 'user-123',
      sessionId: 'sess-123',
    });
  });

  it('generates a different transient NameID for each assertion', async () => {
    const transientStore: SAMLTransientNameIDStore = {
      async put() {
        // no-op
      },
    };

    const first = await resolveSAMLNameIDValue(subject, NAMEID_FORMATS.TRANSIENT, {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.com/saml',
      transientStore,
    });
    const second = await resolveSAMLNameIDValue(subject, NAMEID_FORMATS.TRANSIENT, {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.com/saml',
      transientStore,
    });

    expect(second).not.toBe(first);
  });

  it('requires transient state store for transient NameID format', async () => {
    await expect(
      resolveSAMLNameIDValue(subject, NAMEID_FORMATS.TRANSIENT, {
        tenantId: 'tenant-a',
        spEntityId: 'https://sp.example.com/saml',
      })
    ).rejects.toThrow('STATE_STORE is required');
  });

  it('falls back to email for unspecified NameID format', async () => {
    await expect(resolveSAMLNameIDValue(subject, NAMEID_FORMATS.UNSPECIFIED)).resolves.toBe(
      'user@example.com'
    );
  });

  it('resolves pairwise salt from environment', () => {
    expect(resolveSAMLPairwiseSalt({ PAIRWISE_SALT: 'salt' })).toBe('salt');
    expect(resolveSAMLPairwiseSalt({})).toBeUndefined();
  });

  it('resolves transient NameID store from environment', () => {
    const transientStore: SAMLTransientNameIDStore = {
      async put() {
        // no-op
      },
    };

    expect(resolveSAMLTransientNameIDStore({ STATE_STORE: transientStore })).toBe(transientStore);
    expect(resolveSAMLTransientNameIDStore({})).toBeUndefined();
  });

  it('resolves persistent NameID registry from KV before STATE_STORE', () => {
    const kvRegistry: SAMLPersistentNameIDRegistryStore = {
      async put() {
        // no-op
      },
      async get() {
        return null;
      },
    };
    const stateStore: SAMLTransientNameIDStore = {
      async put() {
        // no-op
      },
    };

    expect(resolveSAMLPersistentNameIDRegistryStore({ KV: kvRegistry, STATE_STORE: stateStore })).toBe(
      kvRegistry
    );
    expect(resolveSAMLPersistentNameIDRegistryStore({ STATE_STORE: stateStore })).toBe(stateStore);
    expect(resolveSAMLPersistentNameIDRegistryStore({})).toBeUndefined();
  });

  it('builds an unambiguous SAML pairwise sector identifier', () => {
    expect(buildSAMLPairwiseSectorIdentifier('tenant-a', 'https://sp.example.com/saml')).toBe(
      '["saml","tenant-a","https://sp.example.com/saml"]'
    );
  });

  it('builds a tenant-scoped pairwise secret reference', () => {
    expect(buildSAMLPairwiseSecretRef('tenant-a')).toBe('tenant:tenant-a:saml:pairwise-nameid');
  });

  it('builds a tenant and SP scoped persistent NameID registry key', () => {
    expect(
      buildSAMLPersistentNameIDRegistryKey(
        'tenant-a',
        'https://sp.example.com/saml',
        'user-123'
      )
    ).toBe(
      'saml:persistent-nameid:tenant:tenant-a:sp:https%3A%2F%2Fsp.example.com%2Fsaml:subject:user-123'
    );
  });
});

describe('SAML SessionIndex mapping', () => {
  it('stores opaque SessionIndex values mapped to Authrim session IDs', async () => {
    const writes = new Map<string, string>();
    const store = {
      async put(key: string, value: string) {
        writes.set(key, value);
      },
      async get(key: string) {
        return writes.get(key) ?? null;
      },
      async delete(key: string) {
        writes.delete(key);
      },
    };

    const sessionIndex = await createSAMLSessionIndex(store, {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.com/saml',
      sessionId: 'sess_sharded_123',
      ttlSeconds: 120,
    });

    expect(sessionIndex).toMatch(/^sidx_[A-Za-z0-9_-]+$/);
    expect(
      await resolveSAMLSessionIndexToSessionId(store, {
        tenantId: 'tenant-a',
        spEntityId: 'https://sp.example.com/saml',
        sessionIndex,
      })
    ).toBe('sess_sharded_123');
  });

  it('scopes SessionIndex lookup by tenant and SP', async () => {
    const store = {
      async put() {
        // no-op
      },
      async get() {
        return JSON.stringify({
          tenantId: 'tenant-a',
          spEntityId: 'https://sp.example.com/saml',
          sessionId: 'sess_sharded_123',
          expiresAt: Date.now() + 120_000,
        });
      },
      async delete() {
        // no-op
      },
    };

    await expect(
      resolveSAMLSessionIndexToSessionId(store, {
        tenantId: 'tenant-b',
        spEntityId: 'https://sp.example.com/saml',
        sessionIndex: 'sidx_test',
      })
    ).resolves.toBeNull();
  });

  it('builds an unambiguous SAML SessionIndex key', () => {
    expect(buildSAMLSessionIndexKey('tenant-a', 'https://sp.example.com/saml', 'sidx_123')).toBe(
      'saml:session-index:tenant:tenant-a:sp:https%3A%2F%2Fsp.example.com%2Fsaml:id:sidx_123'
    );
  });
});

describe('resolveSAMLNameIDFormat', () => {
  const spConfig = {
    entityId: 'https://sp.example.com/saml',
    nameIdFormat: NAMEID_FORMATS.EMAIL,
  };

  it('uses the requested NameIDPolicy format when supported', () => {
    expect(
      resolveSAMLNameIDFormat(
        {
          id: '_request123',
          issueInstant: '2024-01-15T10:30:00Z',
          issuer: spConfig.entityId,
          nameIdPolicy: {
            format: NAMEID_FORMATS.PERSISTENT,
          },
        },
        spConfig
      )
    ).toBe(NAMEID_FORMATS.PERSISTENT);
  });

  it('falls back to the SP configured NameID format', () => {
    expect(
      resolveSAMLNameIDFormat(
        {
          id: '_request123',
          issueInstant: '2024-01-15T10:30:00Z',
          issuer: spConfig.entityId,
        },
        spConfig
      )
    ).toBe(NAMEID_FORMATS.EMAIL);
  });

  it('rejects unsupported requested NameIDPolicy formats', () => {
    expect(() =>
      resolveSAMLNameIDFormat(
        {
          id: '_request123',
          issueInstant: '2024-01-15T10:30:00Z',
          issuer: spConfig.entityId,
          nameIdPolicy: {
            format: 'urn:example:unsupported' as never,
          },
        },
        spConfig
      )
    ).toThrow(SAMLNameIDPolicyError);
  });

  it('rejects mismatched SPNameQualifier values', () => {
    expect(() =>
      resolveSAMLNameIDFormat(
        {
          id: '_request123',
          issueInstant: '2024-01-15T10:30:00Z',
          issuer: spConfig.entityId,
          nameIdPolicy: {
            format: NAMEID_FORMATS.EMAIL,
            spNameQualifier: 'https://other-sp.example.com/saml',
          },
        },
        spConfig
      )
    ).toThrow(SAMLNameIDPolicyError);
  });
});
