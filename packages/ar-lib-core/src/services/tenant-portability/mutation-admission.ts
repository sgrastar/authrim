import { sqliteBoundaryClockParameter } from './sqlite-boundary-clock';
import type { DatabaseAdapter } from '../../db/adapter';

type Database = Pick<DatabaseAdapter, 'queryOne' | 'execute'>;
export interface TenantMutationBoundary {
  id: string;
  tenant_id: string;
  operation_id: string;
  inventory_digest: string;
  state: 'draining' | 'held' | 'released' | 'aborted';
  created_at: number;
  deadline_at: number;
  held_at: number | null;
  released_at: number | null;
}
function validate(now: number, ...ids: string[]): void {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - 2000 ||
    ids.some((id) => !/^[A-Za-z0-9_.:-]{1,256}$/.test(id))
  )
    throw new Error('backup_mutation_admission_input');
}

/** Internal Control storage primitive. Callers authenticate tenant and permit capabilities. */
export class TenantBackupMutationAdmission {
  constructor(
    private readonly database: Database,
    private readonly environmentId = 'legacy',
    private readonly databaseClock = false
  ) {
    validate(0, environmentId);
  }

  /** Retry uses the same privately held id. Never share a root permit between independent writers. */
  async acquire(tenantId: string, permitId: string, now: number): Promise<boolean> {
    return this.acquireScope(tenantId, permitId, now, 'tenant');
  }

  async acquireEnvironment(permitId: string, now: number): Promise<boolean> {
    return this.acquireScope('__environment__', permitId, now, 'environment');
  }

  private async acquireScope(
    tenantId: string,
    permitId: string,
    now: number,
    scope: 'tenant' | 'environment'
  ): Promise<boolean> {
    validate(now, tenantId, permitId);
    await this.database.queryOne(
      `INSERT INTO tenant_backup_mutation_permits(id,tenant_id,created_at,environment_id,scope)
       SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM tenant_backup_mutation_boundaries
         WHERE environment_id=? AND (?='environment' OR tenant_id=?)
         AND state IN ('draining','held') AND deadline_at>${sqliteBoundaryClockParameter(this.databaseClock)})
       ON CONFLICT(id) DO NOTHING RETURNING id`,
      [permitId, tenantId, now, this.environmentId, scope, this.environmentId, scope, tenantId, now]
    );
    return !!(await this.database.queryOne(
      `SELECT id FROM tenant_backup_mutation_permits WHERE id=? AND tenant_id=? AND environment_id=? AND scope=? AND completed_at IS NULL AND created_at<=?`,
      [permitId, tenantId, this.environmentId, scope, now]
    ));
  }

  /** Only the root writer may complete after all nested/deferred effects settle. */
  async complete(tenantId: string, permitId: string, now: number): Promise<void> {
    return this.completeScope(tenantId, permitId, now, 'tenant');
  }

  async completeEnvironment(permitId: string, now: number): Promise<void> {
    return this.completeScope('__environment__', permitId, now, 'environment');
  }

  private async completeScope(
    tenantId: string,
    permitId: string,
    now: number,
    scope: 'tenant' | 'environment'
  ): Promise<void> {
    validate(now, tenantId, permitId);
    await this.database.execute(
      `UPDATE tenant_backup_mutation_permits SET completed_at=? WHERE id=? AND tenant_id=? AND environment_id=? AND scope=? AND completed_at IS NULL AND created_at<=?`,
      [now, permitId, tenantId, this.environmentId, scope, now]
    );
  }

  async begin(input: {
    id: string;
    tenantId: string;
    operationId: string;
    inventoryDigest: string;
    now: number;
  }): Promise<TenantMutationBoundary | null> {
    validate(input.now, input.id, input.tenantId, input.operationId);
    if (!/^[a-f0-9]{64}$/.test(input.inventoryDigest))
      throw new Error('backup_mutation_admission_input');
    await this.database.execute(
      `UPDATE tenant_backup_mutation_boundaries SET state='aborted' WHERE tenant_id=? AND environment_id=? AND state IN ('draining','held') AND deadline_at<=${sqliteBoundaryClockParameter(this.databaseClock)}`,
      [input.tenantId, this.environmentId, input.now]
    );
    await this.database.queryOne(
      `INSERT INTO tenant_backup_mutation_boundaries(id,tenant_id,operation_id,inventory_digest,state,created_at,deadline_at,environment_id)
       SELECT ?,?,?,?,'draining',?,?,? WHERE NOT EXISTS (SELECT 1 FROM tenant_backup_mutation_boundaries
         WHERE tenant_id=? AND environment_id=? AND state IN ('draining','held')) ON CONFLICT(id) DO NOTHING RETURNING id`,
      [
        input.id,
        input.tenantId,
        input.operationId,
        input.inventoryDigest,
        input.now,
        input.now + 2000,
        this.environmentId,
        input.tenantId,
        this.environmentId,
      ]
    );
    return this.database.queryOne<TenantMutationBoundary>(
      `SELECT * FROM tenant_backup_mutation_boundaries WHERE id=? AND tenant_id=? AND operation_id=? AND inventory_digest=? AND environment_id=?
       AND state IN ('draining','held') AND created_at<=? AND deadline_at>${sqliteBoundaryClockParameter(this.databaseClock)}`,
      [
        input.id,
        input.tenantId,
        input.operationId,
        input.inventoryDigest,
        this.environmentId,
        input.now,
        input.now,
      ]
    );
  }

  /** A held SQL gate alone is not a cross-store snapshot: participant receipts are still required. */
  async hold(
    tenantId: string,
    boundaryId: string,
    now: number
  ): Promise<TenantMutationBoundary | null> {
    validate(now, tenantId, boundaryId);
    return this.database.queryOne<TenantMutationBoundary>(
      `UPDATE tenant_backup_mutation_boundaries SET state='held',
         held_at=CASE WHEN state='draining' THEN ${sqliteBoundaryClockParameter(this.databaseClock)} ELSE held_at END
       WHERE id=? AND tenant_id=? AND environment_id=?
       AND state IN ('draining','held') AND (state='draining' OR held_at IS NOT NULL)
       AND created_at<=? AND deadline_at>${sqliteBoundaryClockParameter(this.databaseClock)}
       AND NOT EXISTS (SELECT 1 FROM tenant_backup_mutation_permits WHERE ((environment_id=? AND (tenant_id=? OR scope='environment')) OR (?!='legacy' AND environment_id='legacy')) AND completed_at IS NULL)
       RETURNING *`,
      [
        now,
        boundaryId,
        tenantId,
        this.environmentId,
        now,
        now,
        this.environmentId,
        tenantId,
        this.environmentId,
      ]
    );
  }

  async abort(tenantId: string, boundaryId: string, now: number): Promise<void> {
    validate(now, tenantId, boundaryId);
    await this.database.execute(
      `UPDATE tenant_backup_mutation_boundaries SET state='aborted' WHERE id=? AND tenant_id=? AND environment_id=? AND state IN ('draining','held') AND created_at<=?`,
      [boundaryId, tenantId, this.environmentId, now]
    );
  }
}
