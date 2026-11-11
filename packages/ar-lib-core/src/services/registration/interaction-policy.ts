import type { DatabaseAdapter } from '../../db/adapter';
import {
  registrationPolicyOfRuntime,
  registrationProfileRefOfRuntime,
  type RegistrationPolicy,
} from '../../types/registration-policy';

/**
 * A published version's runtime: null when there is none (no Flow), else the runtime, checked to
 * be one (an object whose `ui.steps` is a list). One that cannot be read, or reads as something
 * else, is thrown: a broken Flow is not a Flow without a policy, and the sign-up is not taken.
 */
function readPublishedRuntime(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value === '') return null;
  let runtime: unknown;
  try {
    runtime = JSON.parse(value);
  } catch {
    throw new Error('registration_flow_runtime_unreadable');
  }
  const ui =
    runtime && typeof runtime === 'object' && !Array.isArray(runtime)
      ? (runtime as Record<string, unknown>).ui
      : undefined;
  if (
    !ui ||
    typeof ui !== 'object' ||
    Array.isArray(ui) ||
    !Array.isArray((ui as Record<string, unknown>).steps)
  ) {
    throw new Error('registration_flow_runtime_unreadable');
  }
  return runtime as Record<string, unknown>;
}

/** The registration Flow an interaction runs, as far as its policy needs it. */
export interface InteractionRegistrationPolicy {
  policy: RegistrationPolicy;
  /** The authentication method profile it signs people up with (`default`: the tenant's). */
  profileRef: string;
  flowId: string;
  flowVersionId: string;
  /** The interaction is live (created or active, not expired). */
  live: boolean;
}

/**
 * The policy of the registration Flow the interaction runs, read from its published version.
 * Null when there is no such interaction, or it runs no registration Flow (then the tenant's
 * behaviour holds, `LEGACY_REGISTRATION_POLICY`).
 */
export async function loadInteractionRegistrationPolicy(
  db: DatabaseAdapter,
  tenantId: string,
  interactionId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<InteractionRegistrationPolicy | null> {
  const interaction = await db.queryOne<{
    flow_id: string;
    flow_version_id: string;
    state: string;
    expires_at: number;
  }>(
    `SELECT flow_id, flow_version_id, state, expires_at FROM flow_interactions
      WHERE tenant_id = ? AND id = ?`,
    [tenantId, interactionId]
  );
  if (!interaction) return null;
  const version = await db.queryOne<{ runtime_snapshot_json: string | null; kind: string | null }>(
    `SELECT v.runtime_snapshot_json AS runtime_snapshot_json, f.kind AS kind
       FROM flow_versions v JOIN flows f ON f.id = v.flow_id AND f.tenant_id = v.tenant_id
      WHERE v.tenant_id = ? AND v.flow_id = ? AND v.id = ?`,
    [tenantId, interaction.flow_id, interaction.flow_version_id]
  );
  if (!version || version.kind !== 'registration') return null;
  const runtime = readPublishedRuntime(version.runtime_snapshot_json);
  // No runtime: no Flow to hold the sign-up to (the tenant's own then).
  if (!runtime) return null;
  return {
    policy: registrationPolicyOfRuntime(runtime),
    profileRef: registrationProfileRefOfRuntime(runtime),
    flowId: interaction.flow_id,
    flowVersionId: interaction.flow_version_id,
    live:
      (interaction.state === 'created' || interaction.state === 'active') &&
      Number(interaction.expires_at) > nowSeconds,
  };
}

/**
 * The policy of the tenant's own registration Flow (the one assigned to the tenant, published):
 * what a sign-up that names no interaction is held to, so a client cannot leave the Flow out to
 * skip who may sign up. Null when the tenant has none (then its behaviour as it was holds).
 */
export async function loadTenantRegistrationPolicy(
  db: DatabaseAdapter,
  tenantId: string
): Promise<{ policy: RegistrationPolicy; profileRef: string } | null> {
  const row = await db.queryOne<{ runtime_snapshot_json: string | null }>(
    `SELECT v.runtime_snapshot_json AS runtime_snapshot_json
       FROM flow_assignments a
       JOIN flows f ON f.id = a.flow_id AND f.tenant_id = a.tenant_id
       JOIN flow_versions v ON v.id = f.published_version_id AND v.tenant_id = f.tenant_id
      WHERE a.tenant_id = ?
        AND a.target_type = 'tenant'
        AND a.target_id IS NULL
        AND a.flow_kind = 'registration'
        AND a.enabled = TRUE
        AND f.status = 'published'
        AND f.deleted_at IS NULL`,
    [tenantId]
  );
  const runtime = row ? readPublishedRuntime(row.runtime_snapshot_json) : null;
  if (!runtime) return null;
  return {
    policy: registrationPolicyOfRuntime(runtime),
    profileRef: registrationProfileRefOfRuntime(runtime),
  };
}
