import type { DatabaseAdapter } from '../db/adapter';

// The authoritative clock is the same Admin database used by every guarded write.
export const LOG_ICEBERG_DB_NOW = "(CAST(strftime('%s','now') AS INTEGER)*1000)";
export class LogIcebergTableLease {
  readonly token = crypto.randomUUID();
  readonly taskId: string;
  constructor(
    readonly admin: DatabaseAdapter,
    tableUuid: string
  ) {
    this.taskId = `log_iceberg:${tableUuid}`;
  }
  get predicate(): string {
    return `EXISTS(SELECT 1 FROM scheduled_task_leases WHERE task_id=? AND lease_token=? AND lease_until>${LOG_ICEBERG_DB_NOW})`;
  }
  get params(): string[] {
    return [this.taskId, this.token];
  }
  async acquire(): Promise<boolean> {
    try {
      await this.admin.execute(
        `INSERT INTO scheduled_task_leases(task_id,lease_token,lease_until,updated_at)
        VALUES(?,?,${LOG_ICEBERG_DB_NOW}+60000,${LOG_ICEBERG_DB_NOW})
        ON CONFLICT(task_id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until,updated_at=excluded.updated_at
        WHERE scheduled_task_leases.lease_until<=${LOG_ICEBERG_DB_NOW}`,
        this.params
      );
    } catch (error) {
      // A lost reply is reconciled with the SAME private token, never a new lease.
      if (!(await this.isActive())) throw error;
    }
    return this.isActive();
  }
  async isActive(): Promise<boolean> {
    return Boolean(
      await this.admin.queryOne<{ active: number }>(
        `SELECT 1 AS active WHERE ${this.predicate}`,
        this.params,
        { consistencyClass: 'primary_required' }
      )
    );
  }
  async assert(): Promise<void> {
    if (!(await this.isActive())) throw new Error('log_iceberg_stale_fence');
  }
  async release(): Promise<void> {
    await this.admin.execute(
      'DELETE FROM scheduled_task_leases WHERE task_id=? AND lease_token=?',
      this.params
    );
  }
}
