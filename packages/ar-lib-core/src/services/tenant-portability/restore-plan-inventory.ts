import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupLease } from './operation-store';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne'>;
export interface TenantBackupRestorePlanHead {
  operation_id: string;
  tenant_id: string;
  input_inventory_digest: string;
  state: 'building' | 'sealed';
  item_count: number;
  chain_digest: string;
}
export interface TenantBackupRestorePlanItem {
  ordinal: number;
  item_id: string;
  payload_json: string;
  payload_digest: string;
  chain_digest: string;
}
export interface TenantBackupRestorePlanInventoryPort {
  headForLease(lease: TenantBackupLease): Promise<TenantBackupRestorePlanHead>;
  append(ordinal: number, itemId: string, payloadJson: string): Promise<void>;
  seal(expectedCount: number, expectedDigest: string): Promise<TenantBackupRestorePlanHead>;
  readPage(from: number): Promise<TenantBackupRestorePlanItem[]>;
  assertInputValidated(lease: TenantBackupLease): Promise<void>;
}

const EMPTY_DIGEST = '0'.repeat(64);
const LIVE = `EXISTS (SELECT 1 FROM tenant_backup_operations o
  JOIN tenant_backup_execution_inventories e ON e.operation_id=o.id AND e.tenant_id=o.tenant_id
  JOIN tenant_backup_input_validations v ON v.operation_id=o.id AND v.tenant_id=o.tenant_id
  JOIN tenant_backup_validation_sessions s ON s.id=v.session_id AND s.tenant_id=v.tenant_id AND s.operation_id=v.operation_id
  WHERE o.id=p.operation_id AND o.tenant_id=p.tenant_id AND o.kind='import' AND o.state='running'
  AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?
  AND e.state='sealed' AND e.chain_digest=p.input_inventory_digest
  AND v.input_inventory_digest=e.chain_digest AND s.state='sealed' AND s.fencing_token<=o.fencing_token)`;

function fail(code: string): never {
  throw new Error(code);
}
async function sha(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Immutable restore plan metadata, separated from the already sealed input inventory. */
export class DatabaseTenantBackupRestorePlanInventory implements TenantBackupRestorePlanInventoryPort {
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
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail('backup_restore_plan_clock');
    return [
      this.lease.operationId,
      this.lease.tenantId,
      this.lease.owner,
      this.lease.fencingToken,
      timestamp,
      timestamp,
    ];
  }
  async create(inputInventoryDigest: string): Promise<TenantBackupRestorePlanHead> {
    if (!/^[a-f0-9]{64}$/.test(inputInventoryDigest)) fail('backup_restore_plan_invalid_input');
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail('backup_restore_plan_clock');
    const [operationId, tenantId, owner, fence] = this.params();
    await this.database.queryOne(
      `INSERT INTO tenant_backup_restore_plan_inventories
      (operation_id,tenant_id,input_inventory_digest,state,chain_digest,created_at)
      SELECT o.id,o.tenant_id,?,'building',?,? FROM tenant_backup_operations o
      JOIN tenant_backup_execution_inventories e ON e.operation_id=o.id AND e.tenant_id=o.tenant_id
      JOIN tenant_backup_input_validations v ON v.operation_id=o.id AND v.tenant_id=o.tenant_id
      JOIN tenant_backup_validation_sessions s ON s.id=v.session_id AND s.tenant_id=v.tenant_id AND s.operation_id=v.operation_id
      WHERE o.id=? AND o.tenant_id=? AND o.kind='import' AND o.state='running'
      AND o.phase='prepare_restore_plan' AND o.lease_owner=? AND o.fencing_token=?
      AND o.lease_expires_at>? AND o.updated_at<=? AND e.state='sealed' AND e.chain_digest=?
      AND v.input_inventory_digest=e.chain_digest AND s.state='sealed' AND s.fencing_token<=o.fencing_token
      ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id`,
      [
        inputInventoryDigest,
        EMPTY_DIGEST,
        timestamp,
        operationId,
        tenantId,
        owner,
        fence,
        timestamp,
        timestamp,
        inputInventoryDigest,
      ]
    );
    const head = await this.head();
    if (head.input_inventory_digest !== inputInventoryDigest)
      fail('backup_restore_plan_retry_conflict');
    return head;
  }
  private async head(): Promise<TenantBackupRestorePlanHead> {
    const [, , owner, fence, timestamp] = this.params();
    const row = await this.database.queryOne<TenantBackupRestorePlanHead>(
      `SELECT p.* FROM tenant_backup_restore_plan_inventories p
      WHERE p.operation_id=? AND p.tenant_id=? AND ${LIVE}`,
      [this.lease.operationId, this.lease.tenantId, owner, fence, timestamp, timestamp]
    );
    if (!row) fail('backup_restore_plan_fenced');
    return row;
  }
  async headForLease(lease: TenantBackupLease): Promise<TenantBackupRestorePlanHead> {
    if (
      lease.operationId !== this.lease.operationId ||
      lease.tenantId !== this.lease.tenantId ||
      lease.owner !== this.lease.owner ||
      lease.fencingToken !== this.lease.fencingToken
    )
      fail('backup_restore_plan_fenced');
    return this.head();
  }
  async assertInputValidated(lease: TenantBackupLease): Promise<void> {
    await this.headForLease(lease);
  }
  async append(ordinal: number, itemId: string, payloadJson: string): Promise<void> {
    if (
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= 4096 ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(itemId) ||
      new TextEncoder().encode(payloadJson).length > 262144
    )
      fail('backup_restore_plan_invalid_item');
    try {
      JSON.parse(payloadJson);
    } catch {
      fail('backup_restore_plan_invalid_item');
    }
    const payloadDigest = await sha(payloadJson);
    const previous = await this.head();
    if (ordinal < previous.item_count) {
      const existing = (await this.readPage(ordinal))[0];
      if (
        !existing ||
        existing.ordinal !== ordinal ||
        existing.item_id !== itemId ||
        existing.payload_json !== payloadJson
      )
        fail('backup_restore_plan_retry_conflict');
      return;
    }
    if (previous.state !== 'building' || ordinal !== previous.item_count)
      fail('backup_restore_plan_append_conflict');
    const chainDigest = await sha(
      JSON.stringify([
        'authrim-restore-plan-inventory-v1',
        previous.chain_digest,
        ordinal,
        itemId,
        payloadDigest,
      ])
    );
    const [, , owner, fence, timestamp] = this.params();
    const inserted = await this.database.queryOne(
      `INSERT INTO tenant_backup_restore_plan_inventory_items
      (operation_id,tenant_id,ordinal,item_id,payload_json,payload_digest,chain_digest)
      SELECT p.operation_id,p.tenant_id,?,?,?,?,? FROM tenant_backup_restore_plan_inventories p
      WHERE p.operation_id=? AND p.tenant_id=? AND ${LIVE} AND p.state='building'
      AND p.item_count=? AND p.chain_digest=? RETURNING ordinal`,
      [
        ordinal,
        itemId,
        payloadJson,
        payloadDigest,
        chainDigest,
        this.lease.operationId,
        this.lease.tenantId,
        owner,
        fence,
        timestamp,
        timestamp,
        ordinal,
        previous.chain_digest,
      ]
    );
    if (!inserted) fail('backup_restore_plan_append_conflict');
  }
  async seal(expectedCount: number, expectedDigest: string): Promise<TenantBackupRestorePlanHead> {
    if (
      !Number.isSafeInteger(expectedCount) ||
      expectedCount < 0 ||
      expectedCount > 4096 ||
      !/^[a-f0-9]{64}$/.test(expectedDigest)
    )
      fail('backup_restore_plan_invalid_seal');
    const [, , owner, fence, timestamp] = this.params();
    await this.database.queryOne(
      `UPDATE tenant_backup_restore_plan_inventories AS p SET state='sealed'
      WHERE p.operation_id=? AND p.tenant_id=? AND ${LIVE} AND p.state='building'
      AND p.item_count=? AND p.chain_digest=?
      AND (SELECT count(*) FROM tenant_backup_restore_plan_inventory_items i WHERE i.operation_id=p.operation_id)=p.item_count
      RETURNING operation_id`,
      [
        this.lease.operationId,
        this.lease.tenantId,
        owner,
        fence,
        timestamp,
        timestamp,
        expectedCount,
        expectedDigest,
      ]
    );
    const head = await this.head();
    if (
      head.state !== 'sealed' ||
      head.item_count !== expectedCount ||
      head.chain_digest !== expectedDigest
    )
      fail('backup_restore_plan_seal_conflict');
    return head;
  }
  async readPage(from: number): Promise<TenantBackupRestorePlanItem[]> {
    const before = await this.head();
    if (!Number.isSafeInteger(from) || from < 0 || from > before.item_count)
      fail('backup_restore_plan_invalid_cursor');
    const [, , owner, fence, timestamp] = this.params();
    const rows = await this.database.query<TenantBackupRestorePlanItem>(
      `SELECT i.ordinal,i.item_id,i.payload_json,i.payload_digest,i.chain_digest
      FROM tenant_backup_restore_plan_inventory_items i
      JOIN tenant_backup_restore_plan_inventories p ON p.operation_id=i.operation_id AND p.tenant_id=i.tenant_id
      WHERE p.operation_id=? AND p.tenant_id=? AND ${LIVE} AND i.ordinal>=?
      ORDER BY i.ordinal LIMIT 16`,
      [this.lease.operationId, this.lease.tenantId, owner, fence, timestamp, timestamp, from]
    );
    if (rows.length !== Math.min(16, before.item_count - from))
      fail('backup_restore_plan_items_missing');
    let chain = EMPTY_DIGEST;
    if (from > 0 && rows.length) {
      const previous = await this.database.queryOne<{ chain_digest: string }>(
        `SELECT chain_digest FROM tenant_backup_restore_plan_inventory_items
        WHERE operation_id=? AND tenant_id=? AND ordinal=?`,
        [this.lease.operationId, this.lease.tenantId, from - 1]
      );
      if (!previous) fail('backup_restore_plan_items_missing');
      chain = previous.chain_digest;
    }
    for (const [offset, row] of rows.entries()) {
      if (row.ordinal !== from + offset || (await sha(row.payload_json)) !== row.payload_digest)
        fail('backup_restore_plan_integrity');
      chain = await sha(
        JSON.stringify([
          'authrim-restore-plan-inventory-v1',
          chain,
          row.ordinal,
          row.item_id,
          row.payload_digest,
        ])
      );
      if (chain !== row.chain_digest) fail('backup_restore_plan_integrity');
    }
    if (rows.length && from + rows.length === before.item_count && chain !== before.chain_digest)
      fail('backup_restore_plan_integrity');
    await this.head();
    return rows;
  }
}
