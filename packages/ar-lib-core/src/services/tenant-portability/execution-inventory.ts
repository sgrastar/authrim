import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupLease } from './operation-store';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne'>;
interface InventoryHead {
  operation_id: string;
  tenant_id: string;
  request_digest: string;
  state: 'building' | 'sealed';
  item_count: number;
  chain_digest: string;
}
interface InventoryItem {
  ordinal: number;
  item_id: string;
  payload_json: string;
  payload_digest: string;
  chain_digest: string;
}
const EMPTY_DIGEST = '0'.repeat(64);
const LIVE = `EXISTS (SELECT 1 FROM tenant_backup_operations o WHERE o.id=p.operation_id
  AND o.tenant_id=p.tenant_id AND o.request_digest=p.request_digest AND o.state='running'
  AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?)`;
async function sha(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Internal planner metadata only, never secret material or uploaded executable SQL.
 * A sealed inventory survives worker takeover unchanged. Its consumers must still establish
 * and verify snapshot boundaries; sealing proves a fixed list, not a consistent capture.
 */
export class TenantBackupExecutionInventory {
  private readonly lease: TenantBackupLease;
  constructor(
    private readonly database: Database,
    lease: TenantBackupLease,
    private readonly now: () => number
  ) {
    this.lease = { ...lease };
  }
  private params(): unknown[] {
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      throw new Error('backup_inventory_clock');
    return [
      this.lease.tenantId,
      this.lease.operationId,
      this.lease.owner,
      this.lease.fencingToken,
      timestamp,
      timestamp,
    ];
  }
  async create(): Promise<InventoryHead> {
    const [tenant, operation, owner, fence, timestamp] = this.params();
    await this.database.queryOne(
      `INSERT INTO tenant_backup_execution_inventories
      (operation_id,tenant_id,request_digest,state,chain_digest,created_at)
      SELECT id,tenant_id,request_digest,'building',?,? FROM tenant_backup_operations
      WHERE tenant_id=? AND id=? AND state='running' AND lease_owner=? AND fencing_token=?
      AND lease_expires_at>? AND updated_at<=?
      ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id`,
      [EMPTY_DIGEST, timestamp, tenant, operation, owner, fence, timestamp, timestamp]
    );
    return this.head();
  }
  async head(): Promise<InventoryHead> {
    const row = await this.database.queryOne<InventoryHead>(
      `SELECT p.* FROM tenant_backup_execution_inventories p
      WHERE p.tenant_id=? AND p.operation_id=? AND ${LIVE}`,
      this.params()
    );
    if (!row) throw new Error('backup_inventory_fenced');
    return row;
  }
  /** Bind a supplied execution context to this inventory's actual lease, not just its operation ID. */
  async headForLease(lease: TenantBackupLease): Promise<InventoryHead> {
    if (
      lease.tenantId !== this.lease.tenantId ||
      lease.operationId !== this.lease.operationId ||
      lease.owner !== this.lease.owner ||
      lease.fencingToken !== this.lease.fencingToken
    )
      throw new Error('backup_inventory_fenced');
    return this.head();
  }
  /** Restore consumers require completed input validation for this exact sealed inventory. */
  async assertInputValidated(lease: TenantBackupLease): Promise<void> {
    const head = await this.headForLease(lease);
    if (head.state !== 'sealed') throw new Error('backup_input_not_validated');
    const validated = await this.database.queryOne(
      `SELECT v.operation_id FROM tenant_backup_input_validations v
      JOIN tenant_backup_execution_inventories p ON p.operation_id=v.operation_id AND p.tenant_id=v.tenant_id
      JOIN tenant_backup_validation_sessions s ON s.id=v.session_id AND s.tenant_id=v.tenant_id AND s.operation_id=v.operation_id
      WHERE p.tenant_id=? AND p.operation_id=? AND ${LIVE} AND p.state='sealed'
      AND v.input_inventory_digest=p.chain_digest AND s.state='sealed'
      AND s.fencing_token<=?`,
      [...this.params(), lease.fencingToken]
    );
    if (!validated) throw new Error('backup_input_not_validated');
  }

  /** Caller uses the same ordinal/itemId/payload on retry. Never replace a committed item. */
  async append(ordinal: number, itemId: string, payloadJson: string): Promise<void> {
    if (
      !Number.isInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= 4096 ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(itemId) ||
      typeof payloadJson !== 'string' ||
      new TextEncoder().encode(payloadJson).length > 262144
    )
      throw new Error('backup_inventory_invalid_item');
    try {
      JSON.parse(payloadJson);
    } catch {
      throw new Error('backup_inventory_invalid_item');
    }
    const payloadDigest = await sha(payloadJson);
    const previous = await this.head();
    if (ordinal < previous.item_count) {
      const rows = await this.items(ordinal, false);
      const existing = rows[0];
      if (
        !existing ||
        existing.ordinal !== ordinal ||
        existing.item_id !== itemId ||
        existing.payload_json !== payloadJson
      )
        throw new Error('backup_inventory_retry_conflict');
      return;
    }
    if (previous.state !== 'building' || ordinal !== previous.item_count)
      throw new Error('backup_inventory_append_conflict');
    const chainDigest = await sha(
      JSON.stringify([
        'authrim-execution-inventory-v1',
        previous.chain_digest,
        ordinal,
        itemId,
        payloadDigest,
      ])
    );
    const inserted = await this.database.queryOne<{ ordinal: number }>(
      `INSERT INTO tenant_backup_execution_inventory_items
      (operation_id,tenant_id,ordinal,item_id,payload_json,payload_digest,chain_digest)
      SELECT p.operation_id,p.tenant_id,?,?,?,?,? FROM tenant_backup_execution_inventories p
      WHERE p.tenant_id=? AND p.operation_id=? AND ${LIVE} AND p.state='building' AND p.item_count=? AND p.chain_digest=?
      RETURNING ordinal`,
      [
        ordinal,
        itemId,
        payloadJson,
        payloadDigest,
        chainDigest,
        ...this.params(),
        ordinal,
        previous.chain_digest,
      ]
    );
    if (!inserted) throw new Error('backup_inventory_append_conflict');
  }
  async seal(expectedCount: number, expectedDigest: string): Promise<InventoryHead> {
    if (
      !Number.isInteger(expectedCount) ||
      expectedCount < 0 ||
      expectedCount > 4096 ||
      !/^[a-f0-9]{64}$/.test(expectedDigest)
    )
      throw new Error('backup_inventory_invalid_seal');
    await this.database.queryOne(
      `UPDATE tenant_backup_execution_inventories AS p SET state='sealed'
      WHERE p.tenant_id=? AND p.operation_id=? AND ${LIVE} AND p.state='building' AND p.item_count=? AND p.chain_digest=?
      AND (SELECT count(*) FROM tenant_backup_execution_inventory_items i WHERE i.operation_id=p.operation_id)=p.item_count
      RETURNING operation_id`,
      [...this.params(), expectedCount, expectedDigest]
    );
    const head = await this.head();
    if (
      head.state !== 'sealed' ||
      head.item_count !== expectedCount ||
      head.chain_digest !== expectedDigest
    )
      throw new Error('backup_inventory_seal_conflict');
    return head;
  }
  /** Bounded reads; a lost lease cannot be mistaken for the end of an inventory. */
  private async items(from: number, sealed: boolean): Promise<InventoryItem[]> {
    const before = await this.head();
    if (from > before.item_count) throw new Error('backup_inventory_invalid_cursor');
    if (sealed && before.state !== 'sealed') throw new Error('backup_inventory_not_sealed');
    const rows = await this.database.query<InventoryItem>(
      `SELECT i.ordinal,i.item_id,i.payload_json,i.payload_digest,i.chain_digest
      FROM tenant_backup_execution_inventory_items i JOIN tenant_backup_execution_inventories p
      ON p.operation_id=i.operation_id AND p.tenant_id=i.tenant_id
      WHERE p.tenant_id=? AND p.operation_id=? AND ${LIVE} AND i.ordinal>=?
      ORDER BY i.ordinal LIMIT 16`,
      [...this.params(), from]
    );
    if (rows.length !== Math.min(16, Math.max(0, before.item_count - from)))
      throw new Error('backup_inventory_items_missing');
    let chain = EMPTY_DIGEST;
    if (rows.length && from > 0) {
      const previous = await this.database.queryOne<{ chain_digest: string }>(
        `SELECT i.chain_digest
        FROM tenant_backup_execution_inventory_items i JOIN tenant_backup_execution_inventories p
        ON p.operation_id=i.operation_id AND p.tenant_id=i.tenant_id
        WHERE p.tenant_id=? AND p.operation_id=? AND ${LIVE} AND i.ordinal=?`,
        [...this.params(), from - 1]
      );
      if (!previous) throw new Error('backup_inventory_items_missing');
      chain = previous.chain_digest;
    }
    for (const [index, item] of rows.entries()) {
      if (item.ordinal !== from + index || (await sha(item.payload_json)) !== item.payload_digest)
        throw new Error('backup_inventory_integrity');
      chain = await sha(
        JSON.stringify([
          'authrim-execution-inventory-v1',
          chain,
          item.ordinal,
          item.item_id,
          item.payload_digest,
        ])
      );
      if (chain !== item.chain_digest) throw new Error('backup_inventory_integrity');
    }
    if (rows.length && from + rows.length === before.item_count && chain !== before.chain_digest)
      throw new Error('backup_inventory_integrity');
    await this.head();
    return rows;
  }
  /** Compare the complete physical DB set without scanning thousands of table-plan entries. */
  async assertDatabaseResources(
    expected: readonly { id: string; payload: string }[]
  ): Promise<void> {
    if (
      !expected.length ||
      expected.length > 70 ||
      new Set(expected.map((entry) => entry.id)).size !== expected.length ||
      expected.some((entry) => !/^(database|fixed-database):[A-Za-z0-9_-]{1,128}$/.test(entry.id))
    )
      throw new Error('backup_resource_invalid_inventory');
    const before = await this.head();
    if (before.state !== 'sealed') throw new Error('backup_inventory_not_sealed');
    const rows = await this.database.query<InventoryItem>(
      `SELECT ordinal,item_id,payload_json,payload_digest,chain_digest
       FROM tenant_backup_execution_inventory_items
       WHERE operation_id=? AND tenant_id=? AND (item_id LIKE 'database:%' OR item_id LIKE 'fixed-database:%')
       ORDER BY ordinal LIMIT 71`,
      [this.lease.operationId, this.lease.tenantId]
    );
    const descriptions = new Map(expected.map((entry) => [entry.id, entry.payload]));
    if (rows.length !== expected.length) throw new Error('backup_resource_inventory_changed');
    for (const row of rows) {
      if (
        descriptions.get(row.item_id) !== row.payload_json ||
        (await sha(row.payload_json)) !== row.payload_digest
      )
        throw new Error('backup_resource_inventory_changed');
      descriptions.delete(row.item_id);
    }
    if (descriptions.size) throw new Error('backup_resource_inventory_changed');
    await this.head();
  }

  async readPage(from = 0): Promise<InventoryItem[]> {
    if (!Number.isInteger(from) || from < 0 || from > 4096)
      throw new Error('backup_inventory_invalid_cursor');
    return this.items(from, true);
  }
}
