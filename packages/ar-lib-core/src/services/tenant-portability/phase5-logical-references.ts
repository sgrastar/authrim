import type { DatabaseAdapter } from '../../db/adapter.js';

interface FlowReference {
  id: string;
  status: string;
  published_version_id: string | null;
}

interface FlowVersionReference {
  id: string;
  flow_id: string;
}

interface CredentialFlowReference {
  lifecycle_state: string;
  issuance_flow_id: string;
  issuance_flow_version_id: string | null;
  verification_flow_id: string | null;
  verification_flow_version_id: string | null;
}

const MAX_REFERENCES = 10_000;

function missing(): never {
  throw new Error('backup_phase5_logical_reference_missing');
}

/** Verifies Flow version links and the Admin-to-Core credential Flow references after restore. */
export async function verifyPhase5LogicalReferences(input: {
  tenantId: string;
  core: Pick<DatabaseAdapter, 'query'>;
  admin: Pick<DatabaseAdapter, 'query'>;
}): Promise<void> {
  const [flows, versions, credentialVersions] = await Promise.all([
    input.core.query<FlowReference>(
      `SELECT id, status, published_version_id
         FROM flows
        WHERE tenant_id = ?
        LIMIT ?`,
      [input.tenantId, MAX_REFERENCES + 1]
    ),
    input.core.query<FlowVersionReference>(
      `SELECT id, flow_id
         FROM flow_versions
        WHERE tenant_id = ?
        LIMIT ?`,
      [input.tenantId, MAX_REFERENCES + 1]
    ),
    input.admin.query<CredentialFlowReference>(
      `SELECT lifecycle_state, issuance_flow_id, issuance_flow_version_id,
              verification_flow_id, verification_flow_version_id
         FROM credential_profile_versions
        WHERE tenant_id = ?
        LIMIT ?`,
      [input.tenantId, MAX_REFERENCES + 1]
    ),
  ]);
  if (
    flows.length > MAX_REFERENCES ||
    versions.length > MAX_REFERENCES ||
    credentialVersions.length > MAX_REFERENCES
  )
    throw new Error('backup_phase5_logical_reference_limit');

  const flowIds = new Set(flows.map(({ id }) => id));
  const versionFlows = new Map(versions.map(({ id, flow_id }) => [id, flow_id]));
  for (const flow of flows) {
    if (flow.published_version_id === null) {
      if (flow.status === 'published') missing();
      continue;
    }
    if (versionFlows.get(flow.published_version_id) !== flow.id) missing();
  }

  const verifyPair = (flowId: string | null, versionId: string | null, required: boolean) => {
    if (flowId === null) {
      if (versionId !== null || required) missing();
      return;
    }
    if (!flowIds.has(flowId)) missing();
    if (versionId === null) {
      if (required) missing();
      return;
    }
    if (versionFlows.get(versionId) !== flowId) missing();
  };
  for (const credential of credentialVersions) {
    const published = credential.lifecycle_state === 'published';
    verifyPair(credential.issuance_flow_id, credential.issuance_flow_version_id, published);
    verifyPair(
      credential.verification_flow_id,
      credential.verification_flow_version_id,
      published && credential.verification_flow_id !== null
    );
  }
}
