import type { DatabaseAdapter } from '../../db';
import { compileGroups, evaluateGroupInputDelta } from './engine';
import type { Evaluation, EvaluationInput, Field, GroupPlan, ServiceGroup, Scalar } from './model';

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
    readonly tenantId: string
  ) {
    if (!tenantId.trim()) throw new Error('group_tenant_required');
  }
  async catalog(): Promise<Catalog | null> {
    const row = await this.db.queryOne<{ revision: number; plan_json: string }>(
      'SELECT revision, plan_json FROM service_group_catalog WHERE tenant_id = ?',
      [this.tenantId],
      primary
    );
    if (!row) return null;
    const plan = JSON.parse(row.plan_json) as GroupPlan;
    if (plan.tenantId !== this.tenantId) throw new Error('group_tenant_mismatch');
    return { revision: Number(row.revision), plan };
  }
  async save(
    groups: ServiceGroup[],
    fields: Record<string, Field>,
    expected: number,
    actorId: string
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
    await this.db.batch([
      {
        sql: `INSERT INTO service_group_catalog(tenant_id, revision, plan_json, updated_at, write_token) VALUES (?, 0, '{}', ?, '') ON CONFLICT(tenant_id) DO NOTHING`,
        params: [this.tenantId, now],
      },
      {
        sql: 'UPDATE service_group_catalog SET revision = ?, plan_json = ?, updated_at = ?, write_token = ? WHERE tenant_id = ? AND revision = ?',
        params: [expected + 1, json, now, token, this.tenantId, expected],
      },
      {
        sql: `INSERT INTO service_group_revisions(tenant_id, revision, plan_json, actor_id, created_at) SELECT tenant_id, revision, plan_json, ?, ? FROM service_group_catalog WHERE tenant_id = ? AND write_token = ?`,
        params: [actorId, now, this.tenantId, token],
      },
    ]);
    const current = await this.db.queryOne<{ write_token: string }>(
      'SELECT write_token FROM service_group_catalog WHERE tenant_id = ?',
      [this.tenantId],
      primary
    );
    if (current?.write_token !== token) throw new Error('group_version_conflict');
    return { revision: expected + 1, plan };
  }
  async setManual(
    userId: string,
    groupId: string,
    present: boolean,
    actorId: string
  ): Promise<void> {
    const catalog = await this.catalog();
    if (!catalog?.plan.groups.some((g) => g.id === groupId && g.enabled))
      throw new Error('group_not_found');
    await this.db.batch([
      present
        ? {
            sql: `INSERT INTO service_group_manual(tenant_id, user_id, group_id) VALUES (?, ?, ?) ON CONFLICT(tenant_id, user_id, group_id) DO NOTHING`,
            params: [this.tenantId, userId, groupId],
          }
        : {
            sql: 'DELETE FROM service_group_manual WHERE tenant_id = ? AND user_id = ? AND group_id = ?',
            params: [this.tenantId, userId, groupId],
          },
      {
        sql: `INSERT INTO service_group_audit(id, tenant_id, user_id, rule_version, generation, event_type, detail_json, created_at) VALUES (?, ?, ?, ?, 0, 'manual', ?, ?)`,
        params: [
          crypto.randomUUID(),
          this.tenantId,
          userId,
          catalog.revision,
          JSON.stringify({ actorId, groupId, present }),
          Date.now(),
        ],
      },
    ]);
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
      if (!equalVersion(after, await reader.version())) throw new Error('group_input_changed');
      const json = JSON.stringify(evaluation);
      const results = await this.db.batch([
        {
          sql: `UPDATE service_group_results SET generation = generation + 1, rule_version = ?, core_version = ?, pii_version = ?, metadata_version = ?, epoch = ?, result_json = ?, evaluated_at = ?, error_code = NULL, lease_until = 0, route_version = ?
          WHERE tenant_id = ? AND user_id = ? AND lease_token = ? AND lease_until > ?
          AND (route_version <> ? OR (core_version <= ? AND pii_version <= ?)) AND metadata_version <= ? AND epoch <= ?
          AND (SELECT revision FROM service_group_catalog WHERE tenant_id = ?) = ?`,
          params: [
            catalog.revision,
            after.core,
            after.pii,
            after.metadata,
            after.epoch,
            json,
            Date.now(),
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
          ],
        },
        {
          sql: `INSERT INTO service_group_audit(id, tenant_id, user_id, rule_version, generation, event_type, detail_json, created_at)
          SELECT ?, tenant_id, user_id, rule_version, generation, 'evaluation', ?, ? FROM service_group_results
          WHERE tenant_id = ? AND user_id = ? AND lease_token = ? AND lease_until = 0 AND error_code IS NULL`,
          params: [
            crypto.randomUUID(),
            JSON.stringify({
              before: old.evaluation?.groups ?? null,
              after: evaluation.groups,
              inputVersion: after,
            }),
            Date.now(),
            this.tenantId,
            userId,
            lease,
          ],
        },
      ]);
      if (results[0].rowsAffected !== 1) throw new Error('group_evaluation_superseded');
      return await this.snapshot(userId, reader);
    } catch (error) {
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
