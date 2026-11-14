/**
 * The statements a person must have agreed to before an app is answered without a Flow: the
 * required statements that any way the request can take through the app's sign-in Flow asks for (see
 * flow-consent-statements.ts). The app's own sign-in Flow is used if it has one, else the
 * tenant's (Default) one; with neither, nothing is required.
 */
import type { DatabaseAdapter } from '../db/adapter';
import type { FlowEditorState, FlowRuntimeContract } from '../schemas/flow-runtime';
import {
  ssoRequiredConsentStatementIds,
  type FlowConsentStatement,
  type FlowSsoContext,
} from './flow-consent-statements';

/** The app an authorization request is for. */
export interface FlowSsoConsentTarget {
  type: 'oidc_client' | 'saml_sp';
  id: string;
}

interface AssignedVersion {
  runtime_snapshot_json: string | null;
  editor_snapshot_json: string | null;
}

const ASSIGNED_VERSION = `SELECT v.runtime_snapshot_json, v.editor_snapshot_json
   FROM flow_assignments a
   JOIN flows f ON f.id = a.flow_id AND f.tenant_id = a.tenant_id
   JOIN flow_versions v
     ON v.id = f.published_version_id AND v.flow_id = f.id AND v.tenant_id = f.tenant_id
  WHERE a.tenant_id = ?
    AND a.flow_kind = 'login'
    AND a.enabled = TRUE
    AND f.status = 'published'
    AND f.deleted_at IS NULL`;

function parse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** The published version of the sign-in Flow assigned to the app (or to the tenant). */
async function assignedSignInVersion(
  db: DatabaseAdapter,
  tenantId: string,
  target: FlowSsoConsentTarget
): Promise<AssignedVersion | null> {
  const specific = await db.queryOne<AssignedVersion>(
    `${ASSIGNED_VERSION} AND a.target_type = ? AND a.target_id = ?`,
    [tenantId, target.type, target.id]
  );
  if (specific) return specific;
  return db.queryOne<AssignedVersion>(
    `${ASSIGNED_VERSION} AND a.target_type = 'tenant' AND a.target_id IS NULL`,
    [tenantId]
  );
}

/**
 * The statements the app's sign-in Flow requires at single sign-on, all required, in the order
 * the Flow asks for them. A published version that cannot be read requires nothing here (the
 * Flow itself refuses it when someone goes through it).
 */
export async function ssoConsentStatementsForTarget(
  db: DatabaseAdapter,
  tenantId: string,
  target: FlowSsoConsentTarget,
  /**
   * Reads the signed-in person's attributes, so a step shown only to some (by a user attribute or
   * an age) requires its statements only of them. Without it such a step's statements are
   * required of everyone.
   */
  userAttributes?: FlowSsoContext['user_attributes']
): Promise<FlowConsentStatement[]> {
  const version = await assignedSignInVersion(db, tenantId, target);
  const runtime = parse<FlowRuntimeContract>(version?.runtime_snapshot_json ?? null);
  if (!runtime?.ui || !Array.isArray(runtime.ui.steps)) return [];
  const editor = parse<FlowEditorState>(version?.editor_snapshot_json ?? null);
  const usableEditor = editor && Array.isArray(editor.edges) ? editor : null;
  const context: FlowSsoContext = {
    ...(target.type === 'saml_sp'
      ? { protocol: 'saml' as const, saml_sp_id: target.id }
      : { protocol: 'oidc' as const, client_id: target.id }),
    ...(userAttributes ? { user_attributes: userAttributes } : {}),
  };
  const ids = await ssoRequiredConsentStatementIds(runtime, usableEditor, context);
  return ids.map((statement_id) => ({ statement_id, required: true }));
}
