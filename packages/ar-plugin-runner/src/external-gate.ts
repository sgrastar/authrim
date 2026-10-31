/**
 * The tenant gate for external (dynamic worker) plugin code.
 *
 * ar-plugin-runner cannot read tenant settings, so ar-management projects the tenant's
 * `plugin.enabled` into `plugin_runner_tenant_external_gates` (setTenantExternalGate), and every
 * SQL that resolves a dynamic_worker installation for execution carries EXTERNAL_GATE_OPEN. This is
 * where the permission is enforced: it does not matter how an installation became `enabled`
 * (enable API, delayed activation, restore, rollout, a race with the setting being turned off),
 * nothing external starts while the gate is closed. No row means closed. In-process (built-in)
 * installations are never gated.
 *
 * What the gate does not do: it stops work from starting, not work that has started. A hook or
 * sync call that was already launched when the gate closed runs to completion (bounded by its
 * timeout), and a gate check is followed by a short, unfenced step before the Worker Loader call
 * (the last check is made right before it, after the code has been fetched, so the window left is
 * milliseconds). The gate is also a projection, not a lease: ar-management writes it on a change
 * of `plugin.enabled`, and a change that has not been written yet is not seen here. A periodic
 * reconciliation in ar-management (about every two minutes, a rolling pass over the tenants that
 * listTenantExternalGateCandidates returns) puts any gate that drifted from the saved setting
 * back, so a drift (a failed write after a save, a changed PLUGIN_ENABLED, a gate that was never
 * initialized) lasts until its tenant's turn in that pass, not for good.
 *
 * Opening is a compare-and-swap on `generation`: the opener names the generation it read before
 * it read the saved setting, and the gate opens only if nothing was written since. Every close
 * advances `generation`, so an "open" decided before a turn-off cannot reopen the gate after it.
 */

import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

/**
 * SQL predicate for a query that has `plugin_runner_installations` under the alias `installation`:
 * the installation is not external, or its tenant's gate is open.
 */
export const EXTERNAL_GATE_OPEN = `(installation.backend_kind <> 'dynamic_worker' OR EXISTS (
              SELECT 1 FROM plugin_runner_tenant_external_gates external_gate
               WHERE external_gate.tenant_id = installation.tenant_id
                 AND external_gate.allowed = 1))`;

/** The gate was closed (or reopened) after the opener read it: the "open" is stale. */
export const EXTERNAL_GATE_GENERATION_CONFLICT = 'plugin_dynamic_external_gate_generation_conflict';

/** An external installation was about to be launched but its tenant's gate is closed. */
export class ExternalGateClosedError extends Error {
  constructor() {
    super('plugin_dynamic_external_gate_closed');
    this.name = 'ExternalGateClosedError';
  }
}

export interface TenantExternalGate {
  tenantId: string;
  allowed: boolean;
  /** Grows by one for each change of `allowed`; 0 when the tenant has no row (closed). */
  generation: number;
}

interface GateRow {
  tenant_id: string;
  allowed: number | string;
  generation: number | string;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('plugin_dynamic_external_gate_d1_session_required');
  }
  return db.withSession('first-primary');
}

function parseRow(row: GateRow | null, tenantId: string): TenantExternalGate {
  if (!row) return { tenantId, allowed: false, generation: 0 };
  const allowed = Number(row.allowed);
  const generation = Number(row.generation);
  if (
    row.tenant_id !== tenantId ||
    (allowed !== 0 && allowed !== 1) ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    throw new Error('plugin_dynamic_external_gate_state_invalid');
  }
  return { tenantId, allowed: allowed === 1, generation };
}

export interface TenantExternalGateCandidate {
  tenantId: string;
  allowed: boolean;
  generation: number;
}

interface CandidateRow {
  tenant_id: string;
  allowed: number | string;
  generation: number | string;
}

export const GATE_CANDIDATE_DEFAULT_LIMIT = 50;
export const GATE_CANDIDATE_MAX_LIMIT = 200;

export class D1TenantExternalGateStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)
  ) {}

  async get(tenantId: string): Promise<TenantExternalGate> {
    if (!SAFE_ID.test(tenantId)) throw new Error('plugin_dynamic_external_gate_input_invalid');
    const row = await primary(this.db)
      .prepare(
        `SELECT tenant_id, allowed, generation FROM plugin_runner_tenant_external_gates
          WHERE tenant_id = ?`
      )
      .bind(tenantId)
      .first<GateRow>();
    return parseRow(row, tenantId);
  }

  /**
   * Closes the gate (always, and every close advances `generation`, so a request to open that was
   * decided before it is refused), or opens it only if `generation` still is `ifGeneration`
   * (0 for a tenant without a row). Opening an already open gate at that generation changes
   * nothing. A stale open fails with EXTERNAL_GATE_GENERATION_CONFLICT.
   */
  async set(input: {
    tenantId: string;
    allowed: boolean;
    ifGeneration?: number;
  }): Promise<TenantExternalGate> {
    const ifGeneration = input.ifGeneration;
    if (
      !SAFE_ID.test(input.tenantId) ||
      typeof input.allowed !== 'boolean' ||
      (input.allowed
        ? !Number.isSafeInteger(ifGeneration) || (ifGeneration as number) < 0
        : ifGeneration !== undefined)
    ) {
      throw new Error('plugin_dynamic_external_gate_input_invalid');
    }
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 1) {
      throw new Error('plugin_dynamic_external_gate_input_invalid');
    }
    const session = primary(this.db);
    if (!input.allowed) {
      await session
        .prepare(
          `INSERT INTO plugin_runner_tenant_external_gates (
             tenant_id, allowed, generation, updated_at
           ) VALUES (?, 0, 1, ?)
           ON CONFLICT(tenant_id) DO UPDATE SET
             allowed = 0,
             generation = plugin_runner_tenant_external_gates.generation + 1,
             updated_at = excluded.updated_at`
        )
        .bind(input.tenantId, now)
        .run();
    } else if (ifGeneration === 0) {
      await session
        .prepare(
          `INSERT INTO plugin_runner_tenant_external_gates (
             tenant_id, allowed, generation, updated_at
           ) VALUES (?, 1, 1, ?)
           ON CONFLICT(tenant_id) DO NOTHING`
        )
        .bind(input.tenantId, now)
        .run();
    } else {
      await session
        .prepare(
          `UPDATE plugin_runner_tenant_external_gates
              SET allowed = 1, generation = generation + 1, updated_at = ?
            WHERE tenant_id = ? AND generation = ? AND allowed = 0`
        )
        .bind(now, input.tenantId, ifGeneration as number)
        .run();
    }
    const reflected = await session
      .prepare(
        `SELECT tenant_id, allowed, generation FROM plugin_runner_tenant_external_gates
          WHERE tenant_id = ?`
      )
      .bind(input.tenantId)
      .first<GateRow>();
    const gate = parseRow(reflected, input.tenantId);
    if (!input.allowed) {
      if (gate.allowed) throw new Error('plugin_dynamic_external_gate_reflection_invalid');
      return gate;
    }
    // Opened by this request (generation moved on from ifGeneration), or already open at the
    // generation the opener read (an earlier identical open): both are what was asked for.
    const expected = ifGeneration === 0 ? 1 : (ifGeneration as number) + 1;
    if (gate.allowed && (gate.generation === expected || gate.generation === ifGeneration)) {
      return gate;
    }
    throw new Error(EXTERNAL_GATE_GENERATION_CONFLICT);
  }

  /**
   * The tenants whose gate may not match their setting, in tenant id order, after `after`:
   * (a) every tenant with an open gate (the setting may have been turned off since), and (b) every
   * tenant with an enabled external installation but no open gate (a row that is missing or
   * closed, while the setting may allow external plugins). A tenant with neither has no external
   * code that could run, so it is never listed.
   */
  async listCandidates(input: {
    limit?: number;
    after?: string | null;
  }): Promise<TenantExternalGateCandidate[]> {
    const limit = input.limit ?? GATE_CANDIDATE_DEFAULT_LIMIT;
    const after = input.after ?? '';
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > GATE_CANDIDATE_MAX_LIMIT ||
      (after !== '' && !SAFE_ID.test(after))
    ) {
      throw new Error('plugin_dynamic_external_gate_input_invalid');
    }
    const rows = await primary(this.db)
      .prepare(
        `SELECT tenant_id, allowed, generation FROM (
           SELECT tenant_id, allowed, generation
             FROM plugin_runner_tenant_external_gates
            WHERE allowed = 1 AND tenant_id > ?
           UNION ALL
           SELECT installation.tenant_id AS tenant_id,
                  COALESCE(MAX(gate.allowed), 0) AS allowed,
                  COALESCE(MAX(gate.generation), 0) AS generation
             FROM plugin_runner_installations installation
             LEFT JOIN plugin_runner_tenant_external_gates gate
               ON gate.tenant_id = installation.tenant_id
            WHERE installation.backend_kind = 'dynamic_worker'
              AND installation.state = 'enabled'
              AND installation.tenant_id > ?
              AND NOT EXISTS (
                SELECT 1 FROM plugin_runner_tenant_external_gates open_gate
                 WHERE open_gate.tenant_id = installation.tenant_id AND open_gate.allowed = 1)
            GROUP BY installation.tenant_id
         )
         ORDER BY tenant_id
         LIMIT ?`
      )
      .bind(after, after, limit)
      .all<CandidateRow>();
    return (rows.results ?? []).map((row) => {
      const allowed = Number(row.allowed);
      const generation = Number(row.generation);
      if (
        !SAFE_ID.test(row.tenant_id) ||
        (allowed !== 0 && allowed !== 1) ||
        !Number.isSafeInteger(generation) ||
        generation < 0
      ) {
        throw new Error('plugin_dynamic_external_gate_state_invalid');
      }
      return { tenantId: row.tenant_id, allowed: allowed === 1, generation };
    });
  }
}
