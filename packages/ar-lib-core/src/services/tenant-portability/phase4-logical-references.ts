import type { DatabaseAdapter } from '../../db/adapter.js';

interface CredentialProfileVersionReference {
  credential_configuration_id: string;
  lifecycle_state: string;
}

interface CredentialConfigurationReference {
  configuration_id: string;
  is_active: number | boolean | null;
}

const MAX_REFERENCES = 10_000;

/** Verifies cross-database VC references that cannot be represented by a physical foreign key. */
export async function verifyPhase4LogicalReferences(input: {
  tenantId: string;
  core: Pick<DatabaseAdapter, 'query'>;
  admin: Pick<DatabaseAdapter, 'query'>;
}): Promise<void> {
  const versions = await input.admin.query<CredentialProfileVersionReference>(
    `SELECT credential_configuration_id, lifecycle_state
       FROM credential_profile_versions
      WHERE tenant_id = ?
      LIMIT ?`,
    [input.tenantId, MAX_REFERENCES + 1]
  );
  if (versions.length > MAX_REFERENCES) throw new Error('backup_phase4_logical_reference_limit');
  const configurationIds = [...new Set(versions.map((row) => row.credential_configuration_id))];
  if (configurationIds.length === 0) return;

  const configurations = await input.core.query<CredentialConfigurationReference>(
    `SELECT configuration_id, is_active
       FROM credential_configurations
      WHERE tenant_id = ?
      LIMIT ?`,
    [input.tenantId, MAX_REFERENCES + 1]
  );
  if (configurations.length > MAX_REFERENCES)
    throw new Error('backup_phase4_logical_reference_limit');
  const byId = new Map(configurations.map((row) => [row.configuration_id, row.is_active]));
  for (const version of versions) {
    const active = byId.get(version.credential_configuration_id);
    if (
      active === undefined ||
      (version.lifecycle_state === 'published' && active !== 1 && active !== true)
    )
      throw new Error('backup_phase4_logical_reference_missing');
  }
}
