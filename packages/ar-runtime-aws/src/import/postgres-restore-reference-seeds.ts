import { createHash } from 'node:crypto';
import type { Client } from 'pg';

/** Canonical Core PostgreSQL seed content, excluding installation-time timestamps. */
const referenceSeeds: Readonly<Record<string, { rows: number; sha256: string }>> = {
  flows: {
    rows: 3,
    sha256: '85ba6a007140fde4b0c6a778331144b84eed80af4354238465ad7a73d939d6c7',
  },
  flow_versions: {
    rows: 3,
    sha256: '9ada84797794f4a932165c5c0becaff4a5ff3790ec81c05019bad51e6ee68cdd',
  },
  flow_assignments: {
    rows: 2,
    sha256: '2900364219faa19ea7b1806b31a21fb59c57a277d15389b7f501cf940662bbd7',
  },
  oidc_scopes: {
    rows: 4,
    sha256: '68ea8328a7b59a8cb266fd1bf09a75f32f604ddc32b0bf266cc98d56be2ef35e',
  },
  screens: {
    rows: 4,
    sha256: 'e6143abf08624b9b718ec0b32d90f01ecc9bc22f0a880903bbaa580edcacf841',
  },
};

export function hasPostgresReferenceSeed(datasetId: string): boolean {
  return datasetId.startsWith('core.') && Object.hasOwn(referenceSeeds, datasetId.slice(5));
}

export async function verifyPostgresReferenceSeed(client: Client, table: string): Promise<void> {
  const expected = referenceSeeds[table];
  if (!expected) throw new Error('aws_postgres_restore_seed_invalid');
  const result = await client.query<{ payload: string }>(
    `SELECT (to_jsonb(t)-'created_at'-'updated_at'-'published_at')::text AS payload
     FROM "${table}" t WHERE tenant_id='default' ORDER BY id LIMIT $1`,
    [expected.rows + 1]
  );
  const digest = createHash('sha256')
    .update(result.rows.map((row) => row.payload).join('\n'))
    .digest('hex');
  if (result.rows.length !== expected.rows || digest !== expected.sha256)
    throw new Error('aws_postgres_restore_seed_invalid');
}

/** Replace only exact fresh-install seeds when restoring the real default tenant. */
export async function preparePostgresReferenceSeeds(
  client: Client,
  tenantId: string,
  selectedDatasetIds: ReadonlySet<string>
): Promise<void> {
  for (const table of Object.keys(referenceSeeds)) await verifyPostgresReferenceSeed(client, table);
  if (tenantId !== 'default') return;
  // Reverse foreign-key order. Constraints and all trigger guards remain enabled.
  for (const table of ['flow_assignments', 'flow_versions', 'flows', 'oidc_scopes', 'screens'])
    if (selectedDatasetIds.has(`core.${table}`))
      await client.query(`DELETE FROM "${table}" WHERE tenant_id='default'`);
}
