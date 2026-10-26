import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';

type RecordValue = Record<string, unknown>;

interface AssignedFlow {
  flow_id: string;
  published_version_id: string | null;
}

interface FlowVersion {
  runtime_snapshot_json: string;
  editor_snapshot_json: string | null;
}

interface LoginClient {
  client_id: string;
  application_type: string | null;
  allowed_channels: string | null;
}

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function unsupported(): never {
  throw new Error('aws_login_flow_profile_unsupported');
}

function empty(value: unknown): boolean {
  const item = record(value);
  return value === undefined || (item !== null && Object.keys(item).length === 0);
}

/**
 * The small DR login page executes the published Flow, but renders only a passkey selector.
 * Reject anything whose policy or user-visible input it cannot represent.
 */
export function assertPasskeyOnlySamlRuntimeProfile(value: unknown): void {
  const runtime = record(value);
  const ui = record(runtime?.ui);
  const steps = ui?.steps;
  if (
    runtime?.flow_kind !== 'login' ||
    !Array.isArray(steps) ||
    ![2, 3].includes(steps.length) ||
    (!empty(runtime.capabilities) &&
      !(Array.isArray(runtime.capabilities) && runtime.capabilities.length === 0)) ||
    !empty(runtime.runtime_bindings)
  ) {
    unsupported();
  }

  const parsed = steps.map(record);
  if (
    parsed.some(
      (step) =>
        !step ||
        (step.capability_ids !== undefined &&
          (!Array.isArray(step.capability_ids) || step.capability_ids.length > 0))
    )
  )
    unsupported();
  const [entry, auth, completion] = parsed.length === 3 ? parsed : [null, parsed[0], parsed[1]];
  if (
    (entry &&
      (entry.component !== 'interaction_context' ||
        entry.render !== false ||
        !empty(entry.content) ||
        !empty(entry.config) ||
        !empty(entry.bindings))) ||
    !auth ||
    auth.component !== 'authentication_method_selector' ||
    auth.render !== true ||
    !empty(auth.content) ||
    !empty(auth.bindings) ||
    !completion ||
    completion.component !== 'completion' ||
    !empty(completion.content) ||
    !empty(completion.bindings)
  ) {
    unsupported();
  }

  const authConfig = record(auth.config);
  const handles = authConfig?.output_handles;
  if (
    !authConfig ||
    Object.keys(authConfig).some((key) => key !== 'output_handles') ||
    !Array.isArray(handles) ||
    handles.length !== 1 ||
    handles[0] !== 'passkey'
  ) {
    unsupported();
  }

  const completionConfig = record(completion.config);
  if (completionConfig && Object.keys(completionConfig).some((key) => key !== 'completion_block')) {
    unsupported();
  }
  if (completionConfig?.completion_block !== undefined) {
    const block = record(completionConfig.completion_block);
    if (!block || block.protocol !== 'saml') unsupported();
  }

  const ids = parsed.map((step) => step?.id);
  const nodes = parsed.map((step) => step?.source_node_id);
  if (
    ids.some((id) => typeof id !== 'string' || id.length === 0) ||
    nodes.some((id) => typeof id !== 'string' || id.length === 0) ||
    new Set(ids).size !== ids.length ||
    new Set(nodes).size !== nodes.length
  ) {
    unsupported();
  }
}

function assertEditorMatchesProfile(runtime: RecordValue, value: unknown): void {
  if (value === null) return;
  const editor = record(value);
  const ui = record(runtime.ui);
  const steps = ui?.steps;
  if (
    !editor ||
    !Array.isArray(editor.nodes) ||
    !Array.isArray(editor.edges) ||
    !Array.isArray(steps)
  ) {
    unsupported();
  }
  const nodes = steps.map((step) => record(step)?.source_node_id);
  const editorNodes = editor.nodes.map((node) => record(node)?.id);
  if (editorNodes.length !== nodes.length || nodes.some((node) => !editorNodes.includes(node))) {
    unsupported();
  }
  if (editor.edges.length !== nodes.length - 1) unsupported();
  for (let index = 0; index < editor.edges.length; index += 1) {
    const edge = record(editor.edges[index]);
    if (
      !edge ||
      edge.source !== nodes[index] ||
      edge.target !== nodes[index + 1] ||
      (index === 0 && nodes.length === 3
        ? edge.source_handle !== 'next' && edge.source_handle !== undefined
        : edge.source_handle !== 'passkey')
    ) {
      unsupported();
    }
  }
}

/** Assert every imported SAML SP resolves to a published Flow the DR UI can execute. */
export async function assertPasskeyOnlySamlFlowReady(
  db: Pick<DatabaseAdapter, 'queryOne'>,
  tenantId: string,
  spEntityIds: readonly string[],
  origin: string
): Promise<void> {
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error('aws_login_origin_invalid');
  }
  if (
    !tenantId ||
    spEntityIds.length === 0 ||
    new Set(spEntityIds).size !== spEntityIds.length ||
    parsedOrigin.protocol !== 'https:' ||
    parsedOrigin.origin !== origin
  ) {
    throw new Error('aws_login_flow_inventory_invalid');
  }
  for (const spEntityId of spEntityIds) {
    if (!spEntityId || spEntityId.length > 512) throw new Error('aws_login_flow_inventory_invalid');
    const specific = await db.queryOne<AssignedFlow>(
      `SELECT a.flow_id, f.published_version_id FROM flow_assignments a
       JOIN flows f ON f.id = a.flow_id AND f.tenant_id = a.tenant_id
       WHERE a.tenant_id = ? AND a.target_type = 'saml_sp' AND a.target_id = ?
         AND a.flow_kind = 'login' AND a.enabled = TRUE
         AND f.status = 'published' AND f.deleted_at IS NULL`,
      [tenantId, spEntityId]
    );
    const assignment =
      specific ??
      (await db.queryOne<AssignedFlow>(
        `SELECT a.flow_id, f.published_version_id FROM flow_assignments a
       JOIN flows f ON f.id = a.flow_id AND f.tenant_id = a.tenant_id
       WHERE a.tenant_id = ? AND a.target_type = 'tenant' AND a.target_id IS NULL
         AND a.flow_kind = 'login' AND a.enabled = TRUE
         AND f.status = 'published' AND f.deleted_at IS NULL`,
        [tenantId]
      ));
    if (!assignment?.published_version_id) throw new Error('aws_login_flow_assignment_missing');
    const version = await db.queryOne<FlowVersion>(
      `SELECT runtime_snapshot_json, editor_snapshot_json FROM flow_versions
       WHERE tenant_id = ? AND flow_id = ? AND id = ?`,
      [tenantId, assignment.flow_id, assignment.published_version_id]
    );
    if (!version) throw new Error('aws_login_flow_version_missing');
    let runtime: unknown;
    let editor: unknown = null;
    try {
      runtime = JSON.parse(version.runtime_snapshot_json);
      if (version.editor_snapshot_json) editor = JSON.parse(version.editor_snapshot_json);
    } catch {
      unsupported();
    }
    assertPasskeyOnlySamlRuntimeProfile(runtime);
    assertEditorMatchesProfile(runtime as RecordValue, editor);
  }

  const client = await db.queryOne<LoginClient>(
    `SELECT client_id, application_type, allowed_channels FROM oauth_clients
     WHERE tenant_id = ? AND client_id = 'login-ui'`,
    [tenantId]
  );
  if (!client || client.application_type === 'native') {
    throw new Error('aws_login_client_unavailable');
  }
  if (client.allowed_channels) {
    let channels: unknown;
    try {
      channels = JSON.parse(client.allowed_channels);
    } catch {
      throw new Error('aws_login_client_channels_invalid');
    }
    if (!Array.isArray(channels) || !channels.includes('browser')) {
      throw new Error('aws_login_client_channel_unavailable');
    }
  }
  const approvedOrigin = await db.queryOne<{ origin: string }>(
    `SELECT origin FROM web_origin_registry
     WHERE tenant_id = ? AND client_id = 'login-ui' AND origin = ?
       AND handoff_allowed = 1 AND is_active = 1`,
    [tenantId, origin]
  );
  if (approvedOrigin?.origin !== origin) {
    throw new Error('aws_login_origin_unavailable');
  }
}
