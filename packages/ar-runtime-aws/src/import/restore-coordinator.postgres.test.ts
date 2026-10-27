import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';
import {
  assertAwsRestoreActivationReady,
  coordinateAwsRestore,
  type AwsRestoreSourceEvidence,
} from './restore-coordinator';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
const postgresIt = databaseUrl ? it : it.skip;
const NOW = 1_800_000_000_000;

function source(tenantId = 'tenant-a'): AwsRestoreSourceEvidence {
  return {
    tenantId,
    issuer: `https://${tenantId}.example.test`,
    bundleId: 'a'.repeat(32),
    snapshotId: 'snapshot-a',
    inventoryDigestSha256: 'b'.repeat(64),
    boundaryUnixMs: NOW - 1000,
    backupReceiptSha256: 'c'.repeat(64),
    supplementFileSha256: 'd'.repeat(64),
    maxSnapshotAgeMs: 60_000,
  };
}

function committed() {
  return {
    coreTargetId: randomUUID(),
    piiTargetId: randomUUID(),
    coreReceiptSha256: '1'.repeat(64),
    piiReceiptSha256: '2'.repeat(64),
    stateReceiptSha256: '3'.repeat(64),
    configurationSha256: '4'.repeat(64),
  };
}

async function withDatabase(run: (client: Client) => Promise<void>) {
  const client = new Client({ connectionString: databaseUrl });
  const schema = `aws_activation_${randomUUID().replaceAll('-', '')}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(
      await readFile(new URL('../storage/restore-activation-schema.sql', import.meta.url), 'utf8')
    );
    await run(client);
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  }
}

postgresIt(
  'publishes only after validation; runtime and restart checks reject revoked evidence',
  async () => {
    await withDatabase(async (stateDb) => {
      let clock = NOW;
      const assertCommittedTargets = vi.fn(async () => undefined);
      const restored = await coordinateAwsRestore({
        stateDb,
        restoreId: randomUUID(),
        source: source(),
        now: () => clock,
        stage: async () => ({
          committed: committed(),
          assertCommittedTargets,
          createRuntime: async (assertSnapshotReady) => ({ assertReady: assertSnapshotReady }),
        }),
      });
      expect(
        (await stateDb.query('SELECT status FROM authrim_aws_restore_activations')).rows
      ).toEqual([{ status: 'active' }]);
      // AWS-only operation may continue after the original DR import freshness window.
      clock += 86_400_000;
      await expect(restored.runtime.assertReady()).resolves.toBeUndefined();
      await expect(
        assertAwsRestoreActivationReady({
          stateDb,
          evidence: restored.evidence,
          assertCommittedTargets,
        })
      ).resolves.toBeUndefined();
      await expect(
        assertAwsRestoreActivationReady({
          stateDb,
          evidence: { ...restored.evidence, tenantId: 'tenant-b' },
          assertCommittedTargets,
        })
      ).rejects.toThrow('aws_restore_activation_invalid');
      await stateDb.query(
        "UPDATE authrim_aws_restore_activations SET evidence_sha256 = repeat('0',64)"
      );
      await expect(restored.runtime.assertReady()).rejects.toThrow(
        'aws_restore_activation_invalid'
      );
    });
  }
);

postgresIt(
  'leaves partial family commits unpublished and refuses reuse or missing target evidence',
  async () => {
    await withDatabase(async (stateDb) => {
      const stage = vi.fn(async () => {
        // A real family importer may already have committed when the second family fails.
        throw new Error('sensitive-postgres-row-must-not-escape');
      });
      await expect(
        coordinateAwsRestore({
          stateDb,
          restoreId: randomUUID(),
          source: source(),
          now: () => NOW,
          stage,
        })
      ).rejects.toThrow(/^aws_restore_failed$/u);
      expect(
        (await stateDb.query('SELECT status FROM authrim_aws_restore_activations')).rows
      ).toEqual([{ status: 'failed' }]);
      await expect(
        coordinateAwsRestore({
          stateDb,
          restoreId: randomUUID(),
          source: source(),
          now: () => NOW,
          stage,
        })
      ).rejects.toThrow('aws_restore_failed');
      expect(stage).toHaveBeenCalledTimes(1);
      const createRuntime = vi.fn(async (assertSnapshotReady: () => Promise<void>) => ({
        assertReady: assertSnapshotReady,
      }));
      await expect(
        coordinateAwsRestore({
          stateDb,
          restoreId: randomUUID(),
          source: source('tenant-b'),
          now: () => NOW,
          stage: async () => ({
            committed: committed(),
            assertCommittedTargets: async () => {
              throw new Error('missing_pii_commit');
            },
            createRuntime,
          }),
        })
      ).rejects.toThrow('aws_restore_failed');
      expect(
        (
          await stateDb.query(
            "SELECT count(*)::int AS count FROM authrim_aws_restore_activations WHERE status = 'active'"
          )
        ).rows
      ).toEqual([{ count: 0 }]);
    });
  }
);

postgresIt(
  'rejects stale imports before writing, and imports that become stale during validation',
  async () => {
    await withDatabase(async (stateDb) => {
      let clock = NOW + 100_000;
      const stage = vi.fn(async () => ({
        committed: committed(),
        assertCommittedTargets: async () => undefined,
        createRuntime: async () => ({
          assertReady: async () => {
            clock += 100_000;
          },
        }),
      }));
      await expect(
        coordinateAwsRestore({
          stateDb,
          restoreId: randomUUID(),
          source: source(),
          now: () => clock,
          stage,
        })
      ).rejects.toThrow('aws_restore_failed');
      expect(stage).not.toHaveBeenCalled();
      expect(
        (await stateDb.query('SELECT * FROM authrim_aws_restore_activations')).rows
      ).toHaveLength(0);
      clock = NOW;
      await expect(
        coordinateAwsRestore({
          stateDb,
          restoreId: randomUUID(),
          source: source(),
          now: () => clock,
          stage,
        })
      ).rejects.toThrow('aws_restore_failed');
      expect(
        (await stateDb.query('SELECT status FROM authrim_aws_restore_activations')).rows
      ).toEqual([{ status: 'failed' }]);
    });
  }
);
