import { logProducerFixture } from './log-iceberg-producer-fixture';
import type { DatabaseAdapter } from '../../db/adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortIdentityMappingLevelHistory,
  finalizeIdentityMappingLevelHistoryFromReceipt,
  identityMappingLevelHistoryInsertStatement,
  identityMappingLevelHistoryChoicesEqual,
  listPendingIdentityMappingLevelHistory,
  normalizeIdentityMappingLevelHistoryChoice,
  prepareIdentityMappingLevelHistory,
  readIdentityMappingLevelHistory,
  type IdentityMappingLevelHistoryInput,
  type IdentityMappingLevelHistoryReceipt,
} from '../identity-mapping-level-history';

let fixture: Awaited<ReturnType<typeof logProducerFixture>>;
let admin: DatabaseAdapter;
const input = (
  changes: Partial<IdentityMappingLevelHistoryInput> = {}
): IdentityMappingLevelHistoryInput => ({
  id: 'history-1',
  tenantId: 'tenant-a',
  tier: 'client',
  clientId: 'app-1',
  before: null,
  after: { fieldMappingSetId: 'set-a' },
  actorId: 'admin-1',
  actorType: 'human',
  via: 'client',
  sourceVersion: '10',
  now: 1_800_000_000_000,
  ...changes,
});
const receipt = (
  changes: Partial<IdentityMappingLevelHistoryReceipt> = {}
): IdentityMappingLevelHistoryReceipt => ({
  historyId: 'history-1',
  tenantId: 'tenant-a',
  clientId: 'app-1',
  before: null,
  after: { fieldMappingSetId: 'set-a' },
  expectedSourceVersion: '10',
  sourceVersion: '11',
  ...changes,
});
describe.each(['scheduled', 'pipeline'] as const)('history mode %s', (mode) => {
  beforeEach(async () => {
    fixture = await logProducerFixture(mode, { separateAdmin: true });
    admin = fixture.adminAdapter;
  });
  afterEach(() => fixture.close());

  describe('history intent confirmation', () => {
    it('orders each level by successful INSERT even for equal or backwards clocks', async () => {
      for (const [id, now] of [
        ['z-first', 1_800_000_000_100],
        ['a-second', 1_800_000_000_100],
        ['m-third', 1_800_000_000_000],
      ] as const) {
        const statement = identityMappingLevelHistoryInsertStatement(
          input({ id, now }),
          'committed'
        );
        await admin.execute(statement.sql, statement.params);
      }
      const rows = await admin.query<{
        id: string;
        created_at: number;
        updated_at: number;
        committed_at: number;
      }>(
        'SELECT id,created_at,updated_at,committed_at FROM identity_mapping_level_history ORDER BY created_at,id'
      );
      expect(rows.map((row) => row.id)).toEqual(['z-first', 'a-second', 'm-third']);
      expect(rows.map((row) => row.created_at)).toEqual([
        1_800_000_000_100, 1_800_000_000_101, 1_800_000_000_102,
      ]);
      expect(
        rows.every(
          (row) => row.updated_at === row.created_at && row.committed_at === row.created_at
        )
      ).toBe(true);
      // Another level starts at its own clock, not the previous client's sequence.
      const separate = await prepareIdentityMappingLevelHistory(
        admin,
        input({
          id: 'other-level',
          clientId: 'app-2',
          now: 1_800_000_000_000,
        })
      );
      expect(separate.created_at).toBe(1_800_000_000_000);
    });
    it('requires positive matching source evidence, and confirms the same receipt idempotently', async () => {
      const read = vi.spyOn(admin, 'queryOne');
      await prepareIdentityMappingLevelHistory(admin, input());
      const committed = await finalizeIdentityMappingLevelHistoryFromReceipt(
        fixture.env,
        admin,
        receipt(),
        1_800_000_000_100
      );
      expect(committed).toMatchObject({
        status: 'committed',
        source_version: '11',
        before_json: 'null',
        after_json: '{"fieldMappingSetId":"set-a"}',
        committed_at: 1_800_000_000_100,
      });
      const repeated = await finalizeIdentityMappingLevelHistoryFromReceipt(
        fixture.env,
        admin,
        receipt(),
        1_800_000_000_200
      );
      expect(repeated.committed_at).toBe(committed.committed_at);
      expect(await fixture.rows('admin.identity_mapping_level_history')).toEqual([
        expect.objectContaining({ id: 'history-1', status: 'committed', source_version: '11' }),
      ]);
      expect(
        read.mock.calls.every(([, , options]) => options?.consistencyClass === 'primary_required')
      ).toBe(true);
    });
    it.each([
      { tenantId: 'tenant-b' },
      { clientId: 'other-app' },
      { before: { fieldMappingSetId: 'set-other' } },
      { after: { mode: 'none' } },
      { expectedSourceVersion: '9' },
      { historyId: 'missing' },
    ])('does not confirm mismatching receipt %j', async (changes) => {
      await prepareIdentityMappingLevelHistory(admin, input());
      await expect(
        finalizeIdentityMappingLevelHistoryFromReceipt(fixture.env, admin, receipt(changes))
      ).rejects.toThrow('identity_mapping_history_receipt_mismatch');
      expect(await fixture.rows('admin.identity_mapping_level_history')).toHaveLength(0);
      expect((await readIdentityMappingLevelHistory(admin, 'tenant-a', 'history-1'))?.status).toBe(
        'pending'
      );
    });
    it('does not confirm an aborted intent', async () => {
      await prepareIdentityMappingLevelHistory(admin, input());
      await abortIdentityMappingLevelHistory(admin, 'history-1', 'tenant-a');
      await expect(
        finalizeIdentityMappingLevelHistoryFromReceipt(fixture.env, admin, receipt())
      ).rejects.toThrow('identity_mapping_history_receipt_mismatch');
    });
    it('does not replace the source version of a committed history with another receipt', async () => {
      await prepareIdentityMappingLevelHistory(admin, input());
      await finalizeIdentityMappingLevelHistoryFromReceipt(fixture.env, admin, receipt());
      await expect(
        finalizeIdentityMappingLevelHistoryFromReceipt(
          fixture.env,
          admin,
          receipt({ sourceVersion: '12' })
        )
      ).rejects.toThrow('identity_mapping_history_receipt_mismatch');
      expect(
        (await readIdentityMappingLevelHistory(admin, 'tenant-a', 'history-1'))?.source_version
      ).toBe('11');
    });
    it('adopts a prepared intent after its successful INSERT response was lost', async () => {
      const execute = admin.execute.bind(admin);
      const lost = {
        ...admin,
        execute: async (sql: string, params?: unknown[]) => {
          await execute(sql, params);
          throw new Error('response_lost');
        },
      };
      expect(await prepareIdentityMappingLevelHistory(lost, input())).toMatchObject({
        status: 'pending',
        source_version: '10',
      });
      await expect(
        prepareIdentityMappingLevelHistory(admin, input({ after: { mode: 'none' } }))
      ).rejects.toThrow();
    });
    it('round-robins pending client intents without changing historical timestamps', async () => {
      await prepareIdentityMappingLevelHistory(admin, input());
      await prepareIdentityMappingLevelHistory(
        admin,
        input({ id: 'history-2', now: 1_800_000_000_010 })
      );
      await prepareIdentityMappingLevelHistory(
        admin,
        input({ id: 'history-tenant', tier: 'tenant_default', clientId: null, after: 'none' })
      );
      expect((await listPendingIdentityMappingLevelHistory(admin, 1)).map((r) => r.id)).toEqual([
        'history-1',
      ]);
      await admin.execute(
        'UPDATE identity_mapping_level_history SET last_reconciled_at=? WHERE id=?',
        [1_800_000_000_020, 'history-1']
      );
      expect((await listPendingIdentityMappingLevelHistory(admin, 1)).map((r) => r.id)).toEqual([
        'history-2',
      ]);
      expect(await listPendingIdentityMappingLevelHistory(admin, 25, 'tenant-b')).toEqual([]);
    });
  });

  describe('raw level choices', () => {
    it('preserves the raw own value, not an inherited default, and compares selector key order equally', () => {
      expect(normalizeIdentityMappingLevelHistoryChoice('tenant_default', undefined)).toBeNull();
      expect(normalizeIdentityMappingLevelHistoryChoice('tenant_default', 'none')).toBe('none');
      expect(
        normalizeIdentityMappingLevelHistoryChoice(
          'client',
          '{"fieldMappingSetId":"set-a","fieldMappingVersionId":"v1"}'
        )
      ).toEqual({ fieldMappingSetId: 'set-a', fieldMappingVersionId: 'v1' });
      expect(
        identityMappingLevelHistoryChoicesEqual(
          'client',
          { fieldMappingVersionId: 'v1', fieldMappingSetId: 'set-a' },
          { fieldMappingSetId: 'set-a', fieldMappingVersionId: 'v1' }
        )
      ).toBe(true);
      expect(identityMappingLevelHistoryChoicesEqual('tenant_default', null, 'set-platform')).toBe(
        false
      );
    });
    it.each([false, 42, [], ['set-a']])(
      'rejects a client choice that is not a raw object: %j',
      (value) => {
        expect(() => normalizeIdentityMappingLevelHistoryChoice('client', value)).toThrow(
          'identity_mapping_history_choice_invalid'
        );
      }
    );
  });
});
