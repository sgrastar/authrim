/**
 * The profiles a Flow's sign-in or sign-up step names: its authentication method profile
 * (`authentication_profile_ref`) and its session profile (`session_profile_ref`), `default`
 * where it names none. Read from the version an interaction runs, or from the sign-in Flow
 * assigned to an app (or the tenant) for what is decided before any interaction exists.
 */
import type { DatabaseAdapter } from '../db/adapter';
import { readPublishedRuntime } from './registration/interaction-policy';
import { readFlowCompletion, type RegistrationCompletion } from '../types/registration-policy';

/** The runtime components of the steps that hold the profiles. */
const PROFILE_STEP_COMPONENTS = new Set([
  'authentication_method_selector',
  'registration_method_selector',
]);

export interface FlowProfileRefs {
  methodProfileRef: string;
  sessionProfileRef: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refOf(value: unknown): string {
  return typeof value === 'string' && value.trim() && value.length <= 200
    ? value.trim()
    : 'default';
}

function profileStepConfig(runtime: unknown): Record<string, unknown> {
  const steps = isRecord(runtime) && isRecord(runtime.ui) ? runtime.ui.steps : undefined;
  if (!Array.isArray(steps)) return {};
  const step = steps.find(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate.component === 'string' &&
      PROFILE_STEP_COMPONENTS.has(candidate.component)
  ) as Record<string, unknown> | undefined;
  return step && isRecord(step.config) ? step.config : {};
}

/** The profiles of a runtime contract: the first sign-in or sign-up step's. */
export function flowProfileRefsOfRuntime(runtime: unknown): FlowProfileRefs {
  const config = profileStepConfig(runtime);
  return {
    methodProfileRef: refOf(config.authentication_profile_ref),
    sessionProfileRef: refOf(config.session_profile_ref),
  };
}

/**
 * Where a sign-in Flow sends the person once signed in (its sign-in step's `completion`), or
 * null for the tenant's destination. One that does not read as a completion is null too: it was
 * checked when published, and the tenant's own destination is the safe one.
 */
export function loginCompletionOfRuntime(runtime: unknown): RegistrationCompletion | null {
  const steps = isRecord(runtime) && isRecord(runtime.ui) ? runtime.ui.steps : undefined;
  if (!Array.isArray(steps)) return null;
  const step = steps.find(
    (candidate) => isRecord(candidate) && candidate.component === 'authentication_method_selector'
  ) as Record<string, unknown> | undefined;
  const config = step && isRecord(step.config) ? step.config : {};
  const read = readFlowCompletion(config.completion);
  return read.ok ? read.completion : null;
}

/**
 * The profiles of the Flow version an interaction runs. Null when there is no such interaction or
 * its version has no runtime; an unreadable runtime is thrown (a broken Flow sets nothing up).
 */
export async function loadInteractionFlowProfileRefs(
  db: DatabaseAdapter,
  tenantId: string,
  interactionId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<
  | (FlowProfileRefs & {
      flowKind: string;
      /** A sign-in Flow's destination once signed in (null: the tenant's). */
      completion: RegistrationCompletion | null;
      /** The interaction is live (created or active, not expired). */
      live: boolean;
    })
  | null
> {
  const row = await db.queryOne<{
    runtime_snapshot_json: string | null;
    kind: string | null;
    state: string | null;
    expires_at: number | null;
  }>(
    `SELECT v.runtime_snapshot_json AS runtime_snapshot_json, f.kind AS kind,
            i.state AS state, i.expires_at AS expires_at
       FROM flow_interactions i
       JOIN flow_versions v ON v.id = i.flow_version_id AND v.tenant_id = i.tenant_id
       JOIN flows f ON f.id = v.flow_id AND f.tenant_id = v.tenant_id
      WHERE i.tenant_id = ? AND i.id = ?`,
    [tenantId, interactionId]
  );
  if (!row) return null;
  const runtime = readPublishedRuntime(row.runtime_snapshot_json);
  if (!runtime) return null;
  return {
    ...flowProfileRefsOfRuntime(runtime),
    flowKind: row.kind ?? '',
    completion: row.kind === 'login' ? loginCompletionOfRuntime(runtime) : null,
    live:
      (row.state === 'created' || row.state === 'active') && Number(row.expires_at) > nowSeconds,
  };
}

/**
 * The profiles of the sign-in Flow an app signs people in with: the one assigned to the app (an
 * OIDC client or a SAML service provider), else the tenant's. Null when neither has one published
 * (then the tenant's settings hold).
 */
export async function loadAssignedLoginFlowProfileRefs(
  db: DatabaseAdapter,
  tenantId: string,
  target: { clientId?: string | null; samlSpId?: string | null }
): Promise<FlowProfileRefs | null> {
  const specific = target.clientId
    ? { type: 'oidc_client', id: target.clientId }
    : target.samlSpId
      ? { type: 'saml_sp', id: target.samlSpId }
      : null;
  const select = `SELECT v.runtime_snapshot_json AS runtime_snapshot_json
       FROM flow_assignments a
       JOIN flows f ON f.id = a.flow_id AND f.tenant_id = a.tenant_id
       JOIN flow_versions v ON v.id = f.published_version_id AND v.tenant_id = f.tenant_id
      WHERE a.tenant_id = ? AND a.flow_kind = 'login' AND a.enabled = TRUE
        AND f.status = 'published' AND f.deleted_at IS NULL`;
  let row: { runtime_snapshot_json: string | null } | null = null;
  if (specific) {
    row = await db.queryOne<{ runtime_snapshot_json: string | null }>(
      `${select} AND a.target_type = ? AND a.target_id = ?`,
      [tenantId, specific.type, specific.id]
    );
  }
  row ??= await db.queryOne<{ runtime_snapshot_json: string | null }>(
    `${select} AND a.target_type = 'tenant' AND a.target_id IS NULL`,
    [tenantId]
  );
  const runtime = row ? readPublishedRuntime(row.runtime_snapshot_json) : null;
  return runtime ? flowProfileRefsOfRuntime(runtime) : null;
}
