import { describe, expect, it } from 'vitest';
import {
  buildSAMLOutboundLogoutRequestKey,
  buildSAMLIdPLogoutFanoutTransactionKey,
  createSAMLIdPLogoutFanoutTransaction,
  consumeSAMLOutboundLogoutRequest,
  deleteSAMLOutboundLogoutRequest,
  getNextPendingSAMLIdPLogoutFanoutTarget,
  getSAMLIdPLogoutFanoutTransaction,
  getSAMLOutboundLogoutRequest,
  isSAMLIdPLogoutFanoutTransactionComplete,
  markSAMLIdPLogoutFanoutTargetCompleted,
  markSAMLIdPLogoutFanoutTargetSent,
  observeExpiredSAMLIdPLogoutFanoutTransaction,
  observeExpiredSAMLIdPLogoutFanoutTransactions,
  SAMLLogoutResponseCorrelationError,
  storeSAMLOutboundLogoutRequest,
} from '../slo-state';

describe('SAML SLO state', () => {
  it('stores and consumes outbound LogoutRequest records by InResponseTo', async () => {
    const values = new Map<string, string>();
    const store = {
      async put(key: string, value: string) {
        values.set(key, value);
      },
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async delete(key: string) {
        values.delete(key);
      },
    };

    await storeSAMLOutboundLogoutRequest(store, {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.com/saml',
      requestId: '_logout123',
      ttlSeconds: 120,
    });

    await expect(
      consumeSAMLOutboundLogoutRequest(store, {
        tenantId: 'tenant-a',
        spEntityId: 'https://sp.example.com/saml',
        inResponseTo: '_logout123',
      })
    ).resolves.toMatchObject({
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.com/saml',
      requestId: '_logout123',
    });
    expect(values.size).toBe(0);
  });

  it('reads outbound LogoutRequest records without consuming them before signature validation', async () => {
    const values = new Map<string, string>();
    const store = {
      async put(key: string, value: string) {
        values.set(key, value);
      },
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async delete(key: string) {
        values.delete(key);
      },
    };

    await storeSAMLOutboundLogoutRequest(store, {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.com/saml',
      requestId: '_logout123',
      ttlSeconds: 120,
    });

    await expect(
      getSAMLOutboundLogoutRequest(store, {
        tenantId: 'tenant-a',
        spEntityId: 'https://sp.example.com/saml',
        inResponseTo: '_logout123',
      })
    ).resolves.toMatchObject({
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.com/saml',
      requestId: '_logout123',
    });
    expect(values.size).toBe(1);

    await deleteSAMLOutboundLogoutRequest(store, {
      tenantId: 'tenant-a',
      requestId: '_logout123',
    });
    expect(values.size).toBe(0);
  });

  it('isolates outbound LogoutRequest records with the same requestId by tenant', async () => {
    const values = new Map<string, string>();
    const store = {
      async put(key: string, value: string) {
        values.set(key, value);
      },
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async delete(key: string) {
        values.delete(key);
      },
    };

    await storeSAMLOutboundLogoutRequest(store, {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.com/saml',
      requestId: '_sharedLogout123',
      ttlSeconds: 120,
    });
    await storeSAMLOutboundLogoutRequest(store, {
      tenantId: 'tenant-b',
      spEntityId: 'https://sp.example.com/saml',
      requestId: '_sharedLogout123',
      ttlSeconds: 120,
    });

    await expect(
      consumeSAMLOutboundLogoutRequest(store, {
        tenantId: 'tenant-b',
        spEntityId: 'https://sp.example.com/saml',
        inResponseTo: '_sharedLogout123',
      })
    ).resolves.toMatchObject({
      tenantId: 'tenant-b',
      requestId: '_sharedLogout123',
    });

    expect(values.has(buildSAMLOutboundLogoutRequestKey('tenant-a', '_sharedLogout123'))).toBe(
      true
    );
    expect(values.has(buildSAMLOutboundLogoutRequestKey('tenant-b', '_sharedLogout123'))).toBe(
      false
    );

    await expect(
      getSAMLOutboundLogoutRequest(store, {
        tenantId: 'tenant-a',
        spEntityId: 'https://sp.example.com/saml',
        inResponseTo: '_sharedLogout123',
      })
    ).resolves.toMatchObject({
      tenantId: 'tenant-a',
      requestId: '_sharedLogout123',
    });
  });

  it('does not consume an outbound LogoutRequest from another tenant with the same requestId', async () => {
    const values = new Map<string, string>();
    const store = {
      async put(key: string, value: string) {
        values.set(key, value);
      },
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async delete(key: string) {
        values.delete(key);
      },
    };

    await storeSAMLOutboundLogoutRequest(store, {
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.com/saml',
      requestId: '_logout123',
      ttlSeconds: 120,
    });

    await expect(
      consumeSAMLOutboundLogoutRequest(store, {
        tenantId: 'tenant-b',
        spEntityId: 'https://sp.example.com/saml',
        inResponseTo: '_logout123',
      })
    ).rejects.toThrow(SAMLLogoutResponseCorrelationError);
    expect(values.has(buildSAMLOutboundLogoutRequestKey('tenant-a', '_logout123'))).toBe(true);
  });

  it('rejects outbound LogoutRequest records whose payload tenant does not match the scoped key', async () => {
    const now = Date.now();
    const values = new Map<string, string>([
      [
        buildSAMLOutboundLogoutRequestKey('tenant-b', '_logout123'),
        JSON.stringify({
          version: 1,
          tenantId: 'tenant-a',
          spEntityId: 'https://sp.example.com/saml',
          requestId: '_logout123',
          issuedAt: now,
          expiresAt: now + 120_000,
        }),
      ],
    ]);
    const store = {
      async get(key: string) {
        return values.get(key) ?? null;
      },
    };

    await expect(
      getSAMLOutboundLogoutRequest(store, {
        tenantId: 'tenant-b',
        spEntityId: 'https://sp.example.com/saml',
        inResponseTo: '_logout123',
      })
    ).rejects.toThrow(SAMLLogoutResponseCorrelationError);
  });

  it('rejects missing InResponseTo', async () => {
    await expect(
      getSAMLOutboundLogoutRequest(
        {
          async get() {
            return null;
          },
        },
        {
          tenantId: 'tenant-a',
          spEntityId: 'https://sp.example.com/saml',
        }
      )
    ).rejects.toThrow(SAMLLogoutResponseCorrelationError);
  });

  it('builds a scoped outbound LogoutRequest key', () => {
    expect(buildSAMLOutboundLogoutRequestKey('tenant-a', '_logout123')).toBe(
      'saml:logout-request:tenant:tenant-a:id:_logout123'
    );
  });

  it('tracks IdP-initiated multi-SP logout fanout status', async () => {
    const values = new Map<string, string>();
    const store = {
      async put(key: string, value: string) {
        values.set(key, value);
      },
      async get(key: string) {
        return values.get(key) ?? null;
      },
    };

    const transaction = await createSAMLIdPLogoutFanoutTransaction(store, {
      tenantId: 'tenant-a',
      userId: 'user-1',
      sessionIndex: 'sidx_1',
      relayState: 'relay',
      transactionId: 'txn-1',
      targets: ['https://sp-a.example/saml', 'https://sp-b.example/saml'],
      ttlSeconds: 120,
    });

    expect(transaction.transactionId).toBe('txn-1');
    expect(getNextPendingSAMLIdPLogoutFanoutTarget(transaction)).toMatchObject({
      spEntityId: 'https://sp-a.example/saml',
      status: 'pending',
    });

    await markSAMLIdPLogoutFanoutTargetSent(store, {
      tenantId: 'tenant-a',
      transactionId: 'txn-1',
      spEntityId: 'https://sp-a.example/saml',
      requestId: '_logout_a',
    });
    await markSAMLIdPLogoutFanoutTargetCompleted(store, {
      tenantId: 'tenant-a',
      transactionId: 'txn-1',
      spEntityId: 'https://sp-a.example/saml',
      status: 'succeeded',
      statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
    });

    const updated = await getSAMLIdPLogoutFanoutTransaction(store, {
      tenantId: 'tenant-a',
      transactionId: 'txn-1',
    });

    expect(updated?.targets[0]).toMatchObject({
      spEntityId: 'https://sp-a.example/saml',
      status: 'succeeded',
      requestId: '_logout_a',
    });
    expect(getNextPendingSAMLIdPLogoutFanoutTarget(updated!)).toMatchObject({
      spEntityId: 'https://sp-b.example/saml',
      status: 'pending',
    });
    expect(isSAMLIdPLogoutFanoutTransactionComplete(updated!)).toBe(false);
  });

  it('scopes IdP-initiated multi-SP logout transactions by tenant', async () => {
    const values = new Map<string, string>();
    const store = {
      async put(key: string, value: string) {
        values.set(key, value);
      },
      async get(key: string) {
        return values.get(key) ?? null;
      },
    };

    await createSAMLIdPLogoutFanoutTransaction(store, {
      tenantId: 'tenant-a',
      userId: 'user-1',
      transactionId: 'txn-1',
      targets: ['https://sp.example/saml'],
    });

    expect(values.has(buildSAMLIdPLogoutFanoutTransactionKey('tenant-a', 'txn-1'))).toBe(true);
    await expect(
      getSAMLIdPLogoutFanoutTransaction(store, {
        tenantId: 'tenant-b',
        transactionId: 'txn-1',
      })
    ).resolves.toBeNull();
  });

  it('marks expired pending and sent fanout targets as timeout for observation', async () => {
    const observed = observeExpiredSAMLIdPLogoutFanoutTransaction(
      {
        transactionId: 'txn-1',
        tenantId: 'tenant-a',
        userId: 'user-1',
        issuedAt: 1000,
        expiresAt: 2000,
        targets: [
          { spEntityId: 'https://sp-a.example/saml', status: 'succeeded' },
          {
            spEntityId: 'https://sp-b.example/saml',
            status: 'sent',
            requestId: '_logout_b',
            sentAt: 1500,
          },
          { spEntityId: 'https://sp-c.example/saml', status: 'pending' },
        ],
      },
      3000
    );

    expect(observed?.targets).toEqual([
      { spEntityId: 'https://sp-a.example/saml', status: 'succeeded' },
      {
        spEntityId: 'https://sp-b.example/saml',
        status: 'timeout',
        requestId: '_logout_b',
        sentAt: 1500,
        completedAt: 3000,
        failureReason: 'logout_response_timeout',
      },
      {
        spEntityId: 'https://sp-c.example/saml',
        status: 'timeout',
        completedAt: 3000,
        failureReason: 'logout_request_not_sent',
      },
    ]);
  });

  it('observes expired fanout transactions via scoped KV prefix scan', async () => {
    const values = new Map<string, string>();
    const putOptions = new Map<string, { expirationTtl?: number } | undefined>();
    const store = {
      async put(key: string, value: string, options?: { expirationTtl?: number }) {
        values.set(key, value);
        putOptions.set(key, options);
      },
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async delete(key: string) {
        values.delete(key);
      },
      async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
        const keys = Array.from(values.keys())
          .filter((name) => !options?.prefix || name.startsWith(options.prefix))
          .map((name) => ({ name }));
        return { keys, list_complete: true };
      },
    };

    await createSAMLIdPLogoutFanoutTransaction(store, {
      tenantId: 'tenant-a',
      userId: 'user-1',
      transactionId: 'txn-expired',
      targets: ['https://sp.example/saml'],
      ttlSeconds: 1,
    });
    await createSAMLIdPLogoutFanoutTransaction(store, {
      tenantId: 'tenant-a',
      userId: 'user-1',
      transactionId: 'txn-active',
      targets: ['https://active.example/saml'],
      ttlSeconds: 120,
    });

    const result = await observeExpiredSAMLIdPLogoutFanoutTransactions(store, {
      now: Date.now() + 5000,
    });

    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.timedOutTransactions).toHaveLength(1);
    expect(result.timedOutTransactions[0]?.transactionId).toBe('txn-expired');

    const updated = await getSAMLIdPLogoutFanoutTransaction(store, {
      tenantId: 'tenant-a',
      transactionId: 'txn-expired',
    });
    expect(updated?.targets[0]).toMatchObject({
      status: 'timeout',
      failureReason: 'logout_request_not_sent',
    });
    expect(
      putOptions.get(buildSAMLIdPLogoutFanoutTransactionKey('tenant-a', 'txn-expired'))
        ?.expirationTtl
    ).toBeGreaterThan(60);
  });

  it('bounds one observation run and returns a cursor for the remaining records', async () => {
    const listedLimits: number[] = [];
    const store = {
      async put() {},
      async get() {
        return null;
      },
      async delete() {},
      async list(options?: { cursor?: string; limit?: number }) {
        listedLimits.push(options?.limit ?? 0);
        return {
          keys: Array.from({ length: options?.limit ?? 0 }, (_, index) => ({
            name: `missing-${options?.cursor ?? 'first'}-${index}`,
          })),
          list_complete: false,
          cursor: options?.cursor ? 'cursor-2' : 'cursor-1',
        };
      },
    };

    const result = await observeExpiredSAMLIdPLogoutFanoutTransactions(store, {
      now: 1_000,
      limit: 75,
      maxRecords: 100,
    });

    expect(result.scanned).toBe(0);
    expect(result.nextCursor).toBe('cursor-2');
    expect(listedLimits).toEqual([75, 25]);
  });
});
