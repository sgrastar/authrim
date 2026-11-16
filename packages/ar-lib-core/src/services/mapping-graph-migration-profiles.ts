import { z } from 'zod';
import { hashCredentialProfileSnapshot } from './credential-profile-snapshot';

const profileRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  credential_profile_id: z.string(),
  version_number: z.number().int().positive(),
  credential_configuration_id: z.string(),
  issuance_flow_version_id: z.string().nullable(),
  verification_flow_version_id: z.string().nullable(),
  issuance_mapping_set_id: z.string(),
  issuance_mapping_version_id: z.string().nullable(),
  issuance_mapping_snapshot_hash: z.string().nullable(),
  verification_mapping_set_id: z.string().nullable(),
  verification_mapping_version_id: z.string().nullable(),
  verification_mapping_snapshot_hash: z.string().nullable(),
  claim_allowlist_json: z.string(),
  offer_ttl_seconds: z.number(),
  maximum_attribute_age_seconds: z.number(),
  transaction_code_required: z.union([z.literal(0), z.literal(1)]),
  snapshot_hash: z.string().nullable(),
});
export const pinnedCredentialProfilesSql = `SELECT ${Object.keys(profileRow.shape).join(',')}
  FROM credential_profile_versions WHERE issuance_mapping_version_id IS NOT NULL
  OR verification_mapping_version_id IS NOT NULL OR issuance_mapping_snapshot_hash IS NOT NULL
  OR verification_mapping_snapshot_hash IS NOT NULL`;

export interface RecompiledMappingSnapshot {
  tenant_id: string;
  field_mapping_version_id: string;
  field_mapping_set_id: string;
  snapshot_hash: string;
  newHash: string;
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const literal = (value: string | number | null) =>
  value === null ? 'NULL' : typeof value === 'number' ? String(value) : quote(value);

/** Refuse ambiguous or broken pins before changing any mapping or profile snapshots. */
export async function mappingGraphProfileUpdates(
  rows: Record<string, unknown>[],
  snapshots: RecompiledMappingSnapshot[]
): Promise<string[]> {
  const refused: Array<{
    tenant_id: unknown;
    profile_id: unknown;
    version_id: unknown;
    reason: string;
  }> = [];
  const statements: string[] = [];
  for (const row of rows) {
    try {
      const profile = profileRow.parse(row);
      const resolve = (setId: string | null, versionId: string | null, oldHash: string | null) => {
        if (setId === null && versionId === null && oldHash === null) return null;
        const matches = snapshots.filter(
          (snapshot) =>
            snapshot.tenant_id === profile.tenant_id &&
            snapshot.field_mapping_set_id === setId &&
            snapshot.field_mapping_version_id === versionId &&
            snapshot.snapshot_hash === oldHash
        );
        const hashes = new Set(matches.map((snapshot) => snapshot.newHash));
        if (hashes.size !== 1) throw new Error('mapping_pin_missing_or_ambiguous');
        return matches[0].newHash;
      };
      const issuanceHash = resolve(
        profile.issuance_mapping_set_id,
        profile.issuance_mapping_version_id,
        profile.issuance_mapping_snapshot_hash
      );
      const verificationHash = resolve(
        profile.verification_mapping_set_id,
        profile.verification_mapping_version_id,
        profile.verification_mapping_snapshot_hash
      );
      if (
        !issuanceHash ||
        !profile.issuance_mapping_version_id ||
        !profile.issuance_flow_version_id
      )
        throw new Error('issuance_contract_incomplete');
      const claims: unknown = JSON.parse(profile.claim_allowlist_json);
      const claimAllowlist = [
        ...new Set(
          z
            .array(
              z
                .string()
                .trim()
                .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
            )
            .min(1)
            .max(128)
            .parse(claims)
        ),
      ].sort();
      const snapshotHash =
        profile.snapshot_hash === null
          ? null
          : await hashCredentialProfileSnapshot({
              profileId: profile.credential_profile_id,
              versionNumber: profile.version_number,
              credentialConfigurationId: profile.credential_configuration_id,
              issuanceFlowVersionId: profile.issuance_flow_version_id,
              verificationFlowVersionId: profile.verification_flow_version_id,
              issuanceMappingVersionId: profile.issuance_mapping_version_id,
              issuanceMappingSnapshotHash: issuanceHash,
              verificationMappingVersionId: profile.verification_mapping_version_id,
              verificationMappingSnapshotHash: verificationHash,
              claimAllowlist,
              offerTtlSeconds: profile.offer_ttl_seconds,
              maximumAttributeAgeSeconds: profile.maximum_attribute_age_seconds,
              transactionCodeRequired: profile.transaction_code_required === 1,
            });
      const guard = Object.entries(profile)
        .map(([key, value]) => `${key} IS ${literal(value)}`)
        .join(' AND ');
      statements.push(`SELECT CASE WHEN EXISTS(SELECT 1 FROM credential_profile_versions WHERE ${guard})
        THEN 0 ELSE abs(-9223372036854775807 - 1) END AS mapping_graph_migration_concurrent_profile_write;`);
      statements.push(`UPDATE credential_profile_versions SET issuance_mapping_snapshot_hash=${literal(issuanceHash)},
        verification_mapping_snapshot_hash=${literal(verificationHash)},snapshot_hash=${literal(snapshotHash)}
        WHERE tenant_id=${quote(profile.tenant_id)} AND id=${quote(profile.id)};`);
    } catch (error) {
      refused.push({
        tenant_id: row.tenant_id,
        profile_id: row.credential_profile_id,
        version_id: row.id,
        reason:
          error instanceof z.ZodError
            ? 'invalid_profile_contract'
            : error instanceof Error
              ? error.message
              : 'invalid_profile_contract',
      });
    }
  }
  if (refused.length)
    throw new Error(
      `Mapping graph migration refused credential profiles: ${JSON.stringify(refused)}`
    );
  return [
    `SELECT CASE WHEN (SELECT count(*) FROM (${pinnedCredentialProfilesSql}))=${rows.length}
    THEN 0 ELSE abs(-9223372036854775807 - 1) END AS mapping_graph_migration_concurrent_profile_write;`,
    ...statements,
  ];
}
