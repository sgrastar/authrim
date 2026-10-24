import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { ClientRepository } from '../core/client';
import { sqliteAdapter } from './sqlite-core-schema';
import {
  ACK_TTL_SECONDS,
  UNACKNOWLEDGED_EXPIRES_AT,
  ackIdentityMappingClientHistoryReceipt,
  identityMappingClientHistoryReceiptId,
  readIdentityMappingClientHistoryReceipt,
  type IdentityMappingClientHistoryReceiptInput,
} from '../../services/identity-mapping-client-history-receipt';

describe('client CAS and immutable history evidence (real SQLite)', () => {
  let db: {
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: Array<string | number | null>): unknown;
      all(...params: Array<string | number | null>): unknown[];
      run(...params: Array<string | number | null>): unknown;
    };
  };
  let adapter: DatabaseAdapter;
  let repository: ClientRepository;
  let version: number;
  let receipt: IdentityMappingClientHistoryReceiptInput;

  beforeEach(async () => {
    const store = sqliteAdapter();
    db = store.db as unknown as typeof db;
    adapter = store.adapter;
    adapter.getType = () => 'sqlite';
    repository = new ClientRepository(adapter, 'default');
    const client = await repository.create({
      client_id: 'client-a',
      client_name: 'App',
      redirect_uris: [],
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
    version = client.updated_at;
    receipt = {
      historyId: 'history-0001',
      tenantId: 'default',
      clientId: 'client-a',
      beforeJson: 'null',
      afterJson: '{"mode":"none"}',
      actorId: 'admin-a',
      actorType: 'human',
      via: 'client',
      bulkId: null,
      createdAt: Date.now(),
    };
  });
  afterEach(() => db.close());

  const update = () => ({ identity_mapping: { mode: 'none' as const }, client_name: 'Changed' });
  const entries = () =>
    Number((db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get() as { n: number }).n);

  it('commits the body and receipt together, and keeps unacknowledged evidence beyond cleanup', async () => {
    const changed = await repository.update('client-a', update(), {
      expectedUpdatedAt: version,
      identityMappingHistoryReceipt: receipt,
    });
    expect(changed?.client_name).toBe('Changed');
    const evidence = await readIdentityMappingClientHistoryReceipt(
      adapter,
      'default',
      receipt.historyId
    );
    expect(evidence?.sourceVersion).toBe(String(changed?.updated_at));
    expect(
      await readIdentityMappingClientHistoryReceipt(adapter, 'other', receipt.historyId)
    ).toBeNull();
    const expiry = () =>
      (db.prepare('SELECT expires_at FROM idempotency_keys').get() as { expires_at: number })
        .expires_at;
    expect(expiry()).toBe(UNACKNOWLEDGED_EXPIRES_AT);
    db.prepare('DELETE FROM idempotency_keys WHERE expires_at < ?').run(
      Math.floor(Date.now() / 1000) + 86_400
    );
    expect(entries()).toBe(1);
    await ackIdentityMappingClientHistoryReceipt(adapter, 'default', receipt.historyId, 2_000_000);
    expect(expiry()).toBe(2000 + ACK_TTL_SECONDS);
    await ackIdentityMappingClientHistoryReceipt(adapter, 'default', receipt.historyId, 3_000_000);
    expect(expiry()).toBe(2000 + ACK_TTL_SECONDS);
  });

  it('records neither history nor body fields when the version changes immediately before the batch', async () => {
    const batch = adapter.batch.bind(adapter);
    adapter.batch = async (statements) => {
      db.prepare('UPDATE oauth_clients SET updated_at = updated_at + 1 WHERE client_id = ?').run(
        'client-a'
      );
      return batch(statements);
    };
    expect(
      await repository.update('client-a', update(), {
        expectedUpdatedAt: version,
        identityMappingHistoryReceipt: receipt,
      })
    ).toBeNull();
    expect((await repository.findByClientId('client-a'))?.client_name).toBe('App');
    expect(entries()).toBe(0);
  });

  it('rolls the inserted receipt back when the client UPDATE fails', async () => {
    db.exec(
      "CREATE TRIGGER reject_client_update BEFORE UPDATE ON oauth_clients BEGIN SELECT RAISE(ABORT,'injected_failure'); END"
    );
    await expect(
      repository.update('client-a', update(), {
        expectedUpdatedAt: version,
        identityMappingHistoryReceipt: receipt,
      })
    ).rejects.toThrow('injected_failure');
    expect(entries()).toBe(0);
    expect((await repository.findByClientId('client-a'))?.client_name).toBe('App');
  });

  it('preserves evidence after a committed batch loses its response and refuses a replay', async () => {
    const batch = adapter.batch.bind(adapter);
    adapter.batch = async (statements) => {
      await batch(statements);
      throw new Error('reply_lost');
    };
    await expect(
      repository.update('client-a', update(), {
        expectedUpdatedAt: version,
        identityMappingHistoryReceipt: receipt,
      })
    ).rejects.toThrow('reply_lost');
    expect((await repository.findByClientId('client-a'))?.client_name).toBe('Changed');
    expect(
      (await readIdentityMappingClientHistoryReceipt(adapter, 'default', receipt.historyId))
        ?.historyId
    ).toBe(receipt.historyId);
    adapter.batch = batch;
    expect(
      await repository.update('client-a', update(), {
        expectedUpdatedAt: version,
        identityMappingHistoryReceipt: receipt,
      })
    ).toBeNull();
    expect(entries()).toBe(1);
  });

  it('refuses a receipt ID collision atomically and never replaces the old immutable payload', async () => {
    await repository.update('client-a', update(), {
      expectedUpdatedAt: version,
      identityMappingHistoryReceipt: receipt,
    });
    const existing = await repository.findByClientId('client-a');
    if (!existing) throw new Error('fixture_client_missing');
    await expect(
      repository.update(
        'client-a',
        { identity_mapping: null, client_name: 'Collision' },
        {
          expectedUpdatedAt: existing.updated_at,
          identityMappingHistoryReceipt: {
            ...receipt,
            beforeJson: receipt.afterJson,
            afterJson: 'null',
          },
        }
      )
    ).rejects.toThrow();
    expect((await repository.findByClientId('client-a'))?.client_name).toBe('Changed');
    expect(
      (await readIdentityMappingClientHistoryReceipt(adapter, 'default', receipt.historyId))
        ?.afterJson
    ).toBe(receipt.afterJson);
  });

  it('rejects cross-tenant metadata and malformed receipt evidence', async () => {
    await expect(
      repository.update('client-a', update(), {
        expectedUpdatedAt: version,
        identityMappingHistoryReceipt: { ...receipt, tenantId: 'other' },
      })
    ).rejects.toThrow('history_receipt_update_mismatch');
    expect(entries()).toBe(0);
    await repository.update('client-a', update(), {
      expectedUpdatedAt: version,
      identityMappingHistoryReceipt: receipt,
    });
    db.prepare("UPDATE idempotency_keys SET response_body='{}' WHERE id=?").run(
      identityMappingClientHistoryReceiptId(receipt.historyId)
    );
    await expect(
      readIdentityMappingClientHistoryReceipt(adapter, 'default', receipt.historyId)
    ).rejects.toThrow();
  });
});
