import type { DatabaseAdapter, TransactionContext } from '../../db';
import { lockGroupCatalog } from '../group-catalog';
import {
  authorizationVersionFence,
  raiseAuthorizationVersion,
  readAuthorizationVersion,
} from './role-guard';
import { compileGroups, evaluateGroupInputDelta } from './engine';
import { canonicalDynamicGroupStatements } from './canonical';
import type { Evaluation, EvaluationInput, Field, GroupPlan, ServiceGroup, Scalar } from './model';
import {
  prepareCoreLogPublication,
  type CoreLogPublicationSource,
} from '../log-iceberg-core-publication';
import type { LogIcebergRuntimeEnv } from '../log-iceberg-runtime';

export interface GroupLogPublicationContext {
  env: LogIcebergRuntimeEnv;
  source: CoreLogPublicationSource;
}

const primary = { consistencyClass: 'primary_required' as const };
export interface Catalog {
  revision: number;
  plan: GroupPlan;
}
export interface InputVersion {
  route?: string;
  core: number;
  pii: number;
  metadata: number;
  epoch: number;
}
export interface GroupSnapshot {
  tenantId: string;
  userId: string;
  ruleVersion: number;
  inputVersion: InputVersion;
  generation: number;
  evaluatedAt: number | null;
  freshness: 'fresh' | 'stale' | 'pending' | 'failed';
  evaluation: Evaluation | null;
  error: string | null;
  explanation?: Array<{
    node: string;
    operator: string;
    field?: string;
    compare?: string;
    expected?: Scalar | Scalar[];
    children?: string[];
    groupId?: string;
    result: boolean | 'unknown';
  }>;
}
interface ResultRow {
  route_version: string;
  rule_version: number;
  core_version: number;
  pii_version: number;
  metadata_version: number;
  epoch: number;
  generation: number;
  evaluated_at: number | null;
  result_json: string | null;
  error_code: string | null;
}
export interface GroupInputReader {
  readonly tenantId: string;
  readonly userId: string;
  version(): Promise<InputVersion>;
  load(plan: GroupPlan): Promise<EvaluationInput>;
}
const equalVersion = (a: InputVersion, b: InputVersion) =>
  a.core === b.core &&
  a.pii === b.pii &&
  a.metadata === b.metadata &&
  a.epoch === b.epoch &&
  (a.route ?? '') === (b.route ?? '');

export class DynamicGroupStore {
  constructor(
    readonly db: DatabaseAdapter,
    readonly tenantId: string,
    private readonly publication?: GroupLogPublicationContext
  ) {
    if (!tenantId.trim()) throw new Error('group_tenant_required');
  }
  async prepareAudit(input: {
    id?: string;
    userId: string;
    ruleVersion: number;
    generation: number;
    eventType: string;
    detail: Record<string, unknown>;
    createdAt?: number;
  }) {
    if (!this.publication || this.publication.source.tenantId !== this.tenantId)
      throw new Error('group_audit_publication_context_required');
    const at = input.createdAt ?? Date.now();
    return prepareCoreLogPublication(this.publication.env, this.db, {
      source: this.publication.source,
      tenantId: this.tenantId,
      sourceDataset: 'core.service_group_audit',
      logType: 'audit',
      eventAt: at,
      expiresAt: null,
      overview: { action: input.eventType, subject_id: input.userId || null },
      row: {
        id: input.id ?? crypto.randomUUID(),
        tenant_id: this.tenantId,
        user_id: input.userId,
        rule_version: input.ruleVersion,
        generation: input.generation,
        event_type: input.eventType,
        detail_json: JSON.stringify(input.detail),
        created_at: at,
      },
    });
  }
  async finishAudit(
    prepared: Awaited<ReturnType<DynamicGroupStore['prepareAudit']>>,
    conflict = 'group_version_conflict'
  ) {
    const state = await this.db.queryOne<{ state: string }>(
      'SELECT state FROM log_iceberg_core_publications WHERE id=? AND tenant_id=?',
      [prepared.publicationId, this.tenantId],
      primary
    );
    if (!state || !['committed', 'published'].includes(state.state)) throw new Error(conflict);
    await prepared.dispatch();
  }
  async catalog(): Promise<Catalog | null> {
    const row = await this.db.queryOne<{ revision: number; plan_json: string }>(
      'SELECT revision, plan_json FROM service_group_catalog WHERE tenant_id = ?',
      [this.tenantId],
      primary
    );
    // An empty first row (revision 0, `{}`) a save that lost a race left: no catalog yet.
    if (!row || (Number(row.revision) === 0 && row.plan_json === '{}')) return null;
    const plan = JSON.parse(row.plan_json) as GroupPlan;
    if (plan.tenantId !== this.tenantId) throw new Error('group_tenant_mismatch');
    return { revision: Number(row.revision), plan };
  }
  async save(
    groups: ServiceGroup[],
    fields: Record<string, Field>,
    expected: number,
    actorId: string,
    /**
     * The caller's checks of the change (delegation, roles of affected groups): run right before
     * the write, on PostgreSQL inside its transaction after the group catalog lock.
     */
    check?: (db: Pick<TransactionContext, 'query' | 'queryOne'>) => Promise<void>
  ): Promise<Catalog> {
    if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('group_version_invalid');
    const plan = compileGroups(this.tenantId, groups, fields);
    const old = await this.catalog();
    if ((old?.revision ?? 0) !== expected) throw new Error('group_version_conflict');
    // API-generated group IDs remain stable when names or rules change.
    const json = JSON.stringify(plan);
    if (new TextEncoder().encode(json).length > 512 * 1024) throw new Error('group_catalog_limit');
    const now = Date.now();
    const token = crypto.randomUUID();
    const kept = new Set(plan.groups.map((group) => group.id));
    const removed = (old?.plan.groups ?? []).map((g) => g.id).filter((id) => !kept.has(id));
    if (removed.length > 40) throw new Error('group_catalog_limit');
    // A removed group is a canonical group: like the groups API, it is not removed while another
    // group has it as parent or a group role grant has it as scope. Checked in the catalog write
    // itself, so it holds with the write (a D1 batch is one transaction; on PostgreSQL the write
    // runs under the tenant's group catalog lock, as reparenting and grants do).
    const slots = removed.map(() => '?').join(', ');
    const removalGuard = removed.length
      ? {
          sql: ` AND NOT EXISTS (SELECT 1 FROM "groups" WHERE tenant_id = ? AND parent_group_id IN (${slots}))
            AND NOT EXISTS (SELECT 1 FROM group_role_assignments WHERE tenant_id = ? AND scope_type = 'group' AND scope_target IN (${slots}))`,
          params: [this.tenantId, ...removed, this.tenantId, ...removed.map((id) => `group:${id}`)],
        }
      : { sql: '', params: [] };
    // The tenant authorization version (role-guard's readAuthorizationVersion) the checks read:
    // the catalog write holds only while it is unchanged, and raises it (last statement), so a
    // ReBAC group userset written while these checks ran makes this save conflict, and the other
    // way round (each side's fence fails when the other committed first).
    const tokenFence = {
      sql: 'EXISTS (SELECT 1 FROM service_group_catalog WHERE tenant_id = ? AND write_token = ?)',
      params: [this.tenantId, token],
    };
    const statementsAt = (version: number | null) => [
      // The empty first row the update below fills: only while the version still holds, so a
      // save that loses the race leaves nothing behind.
      {
        sql: `INSERT INTO service_group_catalog(tenant_id, revision, plan_json, updated_at, write_token) SELECT ?, 0, '{}', CAST(? AS BIGINT), '' WHERE ${authorizationVersionFence(this.tenantId, version).sql} ON CONFLICT(tenant_id) DO NOTHING`,
        params: [this.tenantId, now, ...authorizationVersionFence(this.tenantId, version).params],
      },
      {
        sql: `UPDATE service_group_catalog SET revision = ?, plan_json = ?, updated_at = ?, write_token = ? WHERE tenant_id = ? AND revision = ?${removalGuard.sql} AND ${authorizationVersionFence(this.tenantId, version).sql}`,
        params: [
          expected + 1,
          json,
          now,
          token,
          this.tenantId,
          expected,
          ...removalGuard.params,
          ...authorizationVersionFence(this.tenantId, version).params,
        ],
      },
      {
        sql: `INSERT INTO service_group_revisions(tenant_id, revision, plan_json, actor_id, created_at) SELECT tenant_id, revision, plan_json, ?, ? FROM service_group_catalog WHERE tenant_id = ? AND write_token = ?`,
        params: [actorId, now, this.tenantId, token],
      },
      // The canonical `groups` rows (see canonical.ts), in the same batch and fenced by the same
      // token: a conflicting save writes neither the catalog nor them.
      ...canonicalDynamicGroupStatements(
        this.tenantId,
        plan.groups,
        removed,
        expected + 1,
        tokenFence,
        now
      ),
      raiseAuthorizationVersion(this.tenantId, tokenFence),
    ];
    if (this.db.getType() === 'postgres') {
      // One transaction under the tenant's group catalog lock (the one reparenting and grants
      // take): the caller's checks read the state the write is made in.
      await this.db.transaction(async (tx) => {
        await lockGroupCatalog(tx, this.tenantId, 'postgres');
        const version = await readAuthorizationVersion(tx, this.tenantId);
        await check?.(tx);
        for (const statement of statementsAt(version))
          await tx.execute(statement.sql, statement.params);
      });
    } else {
      // D1 takes no lock: the version is read before the checks, and the batch holds only while
      // it is unchanged (see statementsAt).
      const version = await readAuthorizationVersion(this.db, this.tenantId);
      await check?.(this.db);
      await this.db.batch(statementsAt(version));
    }
    const current = await this.db.queryOne<{ write_token: string }>(
      'SELECT write_token FROM service_group_catalog WHERE tenant_id = ?',
      [this.tenantId],
      primary
    );
    if (current?.write_token !== token) throw new Error('group_version_conflict');
    return { revision: expected + 1, plan };
  }
  async snapshot(userId: string, reader: GroupInputReader): Promise<GroupSnapshot> {
    if (reader.tenantId !== this.tenantId || reader.userId !== userId)
      throw new Error('group_tenant_or_subject_mismatch');
    const catalog = await this.catalog();
    const row = await this.db.queryOne<ResultRow>(
      'SELECT * FROM service_group_results WHERE tenant_id = ? AND user_id = ?',
      [this.tenantId, userId],
      primary
    );
    const snapshot: GroupSnapshot = {
      tenantId: this.tenantId,
      userId,
      ruleVersion: Number(row?.rule_version ?? 0),
      inputVersion: {
        ...(row?.route_version ? { route: row.route_version } : {}),
        core: Number(row?.core_version ?? -1),
        pii: Number(row?.pii_version ?? -1),
        metadata: Number(row?.metadata_version ?? -1),
        epoch: Number(row?.epoch ?? -1),
      },
      generation: Number(row?.generation ?? 0),
      evaluatedAt: row?.evaluated_at ?? null,
      freshness: row?.result_json ? 'stale' : 'pending',
      evaluation: row?.result_json ? (JSON.parse(row.result_json) as Evaluation) : null,
      error: row?.error_code ?? null,
    };
    try {
      if (snapshot.error) snapshot.freshness = 'failed';
      else if (
        row?.result_json &&
        catalog?.revision === snapshot.ruleVersion &&
        // Past the time its input changes by itself, the result is stale.
        (snapshot.evaluation?.inputValidUntil === undefined ||
          snapshot.evaluation.inputValidUntil > Math.floor(Date.now() / 1000)) &&
        equalVersion(await reader.version(), snapshot.inputVersion)
      )
        snapshot.freshness = 'fresh';
    } catch (error) {
      snapshot.freshness = 'failed';
      snapshot.error =
        error instanceof Error && /^group_[a-z_]+$/.test(error.message)
          ? error.message
          : 'group_input_unavailable';
    }
    if (snapshot.evaluation && catalog?.revision === snapshot.ruleVersion)
      snapshot.explanation = Object.entries(catalog.plan.nodes).map(([node, definition]) => ({
        node,
        operator: definition.expression.op,
        ...(definition.expression.op === 'attribute'
          ? {
              field: definition.expression.field,
              compare: definition.expression.compare,
              expected: definition.expression.value,
            }
          : {}),
        children: definition.children,
        ...(definition.expression.op === 'member'
          ? { groupId: definition.expression.groupId }
          : {}),
        result: snapshot.evaluation!.nodes[node] ?? 'unknown',
      }));
    return snapshot;
  }
  async evaluate(userId: string, reader: GroupInputReader): Promise<GroupSnapshot> {
    if (reader.tenantId !== this.tenantId || reader.userId !== userId)
      throw new Error('group_tenant_or_subject_mismatch');
    const now = Date.now();
    const lease = crypto.randomUUID();
    await this.db.execute(
      `INSERT INTO service_group_results(tenant_id, user_id) VALUES (?, ?) ON CONFLICT(tenant_id, user_id) DO NOTHING`,
      [this.tenantId, userId]
    );
    const claimed = await this.db.execute(
      `UPDATE service_group_results SET lease_token = ?, lease_until = ?, attempts = attempts + 1 WHERE tenant_id = ? AND user_id = ? AND lease_until <= ?`,
      [lease, now + 60_000, this.tenantId, userId, now]
    );
    if (claimed.rowsAffected !== 1) throw new Error('group_evaluation_busy');
    let committed = false;
    try {
      const catalog = await this.catalog();
      if (!catalog) throw new Error('group_catalog_missing');
      const old = await this.snapshot(userId, reader);
      const before = await reader.version();
      const input = await reader.load(catalog.plan);
      const after = await reader.version();
      if (!equalVersion(before, after)) throw new Error('group_input_changed');
      const evaluation = evaluateGroupInputDelta(
        catalog.plan,
        input,
        old.ruleVersion === catalog.revision ? (old.evaluation ?? undefined) : undefined
      );
      // Valid only until the input changes by itself (a manual membership starting or ending).
      delete evaluation.inputValidUntil;
      if (input.validUntil !== undefined) evaluation.inputValidUntil = input.validUntil;
      if (!equalVersion(after, await reader.version())) throw new Error('group_input_changed');
      const json = JSON.stringify(evaluation);
      const evaluatedAt = Date.now();
      if (!Number.isSafeInteger(old.generation) || old.generation < 0)
        throw new Error('group_generation_invalid');
      const generation = old.generation + 1;
      const audit = await this.prepareAudit({
        userId,
        ruleVersion: catalog.revision,
        generation,
        eventType: 'evaluation',
        createdAt: evaluatedAt,
        detail: {
          before: old.evaluation?.groups ?? null,
          after: evaluation.groups,
          inputVersion: after,
        },
      });
      if (audit.state === 'committed' || audit.state === 'published') {
        await audit.dispatch();
        return this.snapshot(userId, reader);
      }
      if (!equalVersion(after, await reader.version())) throw new Error('group_input_changed');
      const results = await this.db.batch(
        audit.wrapBusinessBatch(
          [
            {
              sql: `UPDATE service_group_results SET generation = generation + 1, rule_version = ?, core_version = ?, pii_version = ?, metadata_version = ?, epoch = ?, result_json = ?, evaluated_at = ?, error_code = NULL, lease_until = 0, route_version = ?
          WHERE tenant_id = ? AND user_id = ? AND lease_token = ? AND lease_until > ?
          AND (route_version <> ? OR (core_version <= ? AND pii_version <= ?)) AND metadata_version <= ? AND epoch <= ?
          AND (SELECT revision FROM service_group_catalog WHERE tenant_id = ?) = ? AND generation = ?`,
              params: [
                catalog.revision,
                after.core,
                after.pii,
                after.metadata,
                after.epoch,
                json,
                evaluatedAt,
                after.route ?? '',
                this.tenantId,
                userId,
                lease,
                Date.now(),
                after.route ?? '',
                after.core,
                after.pii,
                after.metadata,
                after.epoch,
                this.tenantId,
                catalog.revision,
                old.generation,
              ],
            },
          ],
          {
            where: `EXISTS(SELECT 1 FROM service_group_results WHERE tenant_id=? AND user_id=? AND lease_token=? AND lease_until=0 AND error_code IS NULL AND generation=? AND rule_version=? AND route_version=? AND core_version=? AND pii_version=? AND metadata_version=? AND epoch=? AND evaluated_at=?)`,
            params: [
              this.tenantId,
              userId,
              lease,
              generation,
              catalog.revision,
              after.route ?? '',
              after.core,
              after.pii,
              after.metadata,
              after.epoch,
              evaluatedAt,
            ],
          }
        )
      );
      if (results[0].rowsAffected !== 1) throw new Error('group_evaluation_superseded');
      committed = true;
      await this.finishAudit(audit, 'group_evaluation_superseded');
      return await this.snapshot(userId, reader);
    } catch (error) {
      if (committed) throw error;
      const code =
        error instanceof Error && /^group_[a-z_]+$/.test(error.message)
          ? error.message
          : 'group_input_unavailable';
      await this.db.execute(
        'UPDATE service_group_results SET lease_until = 0, error_code = ? WHERE tenant_id = ? AND user_id = ? AND lease_token = ?',
        [code, this.tenantId, userId, lease]
      );
      throw new Error(code);
    }
  }
}
