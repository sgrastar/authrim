/** Genuine encrypted restore, authentication and signature checks; all databases are disposable. */
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';
import { restoreOfflineAwsSamlTenant } from '../import/restore-offline';
import { loadActivatedAwsSamlTenant } from '../startup/load-activated-tenant';
import { runSyntheticSamlLoginProbe } from './saml-login-probe';
import {
  TENANT,
  ORIGIN,
  SP,
  migrate,
  softwarePasskey,
  sourceSigningBundle,
  seedSource,
  buildBackupFiles,
} from './synthetic-fixture';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
const postgresIt = databaseUrl ? it : it.skip;

postgresIt(
  'verifies signed SAML login and rejects invalid/replayed proofs before and after a cold reload',
  { timeout: 120_000 },
  async () => {
    if (!databaseUrl) throw new Error('test_database_missing');
    const base = new URL(databaseUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
      throw new Error('local_test_database_required');
    const suffix = randomUUID().replaceAll('-', '');
    const names = {
      sourceCore: `probe_src_core_${suffix}`,
      sourcePii: `probe_src_pii_${suffix}`,
      core: `probe_core_${suffix}`,
      pii: `probe_pii_${suffix}`,
      state: `probe_state_${suffix}`,
    };
    const urlFor = (name: string) => {
      const url = new URL(base);
      url.pathname = `/${name}`;
      return url.toString();
    };
    const admin = new Client({ connectionString: databaseUrl });
    const db = Object.fromEntries(
      Object.entries(names).map(([role, name]) => [
        role,
        new Client({ connectionString: urlFor(name) }),
      ])
    ) as Record<keyof typeof names, Client>;
    const created: string[] = [];
    const connected: Client[] = [];
    let restored: Awaited<ReturnType<typeof restoreOfflineAwsSamlTenant>> | undefined;
    let reloaded: Awaited<ReturnType<typeof loadActivatedAwsSamlTenant>> | undefined;
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'authrim-saml-probe-'));
    const externalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('probe_external_fetch_forbidden');
    });
    try {
      await admin.connect();
      for (const name of Object.values(names)) {
        await admin.query(`CREATE DATABASE "${name}"`);
        created.push(name);
      }
      for (const client of Object.values(db)) {
        await client.connect();
        connected.push(client);
      }
      for (const client of [db.sourceCore, db.core])
        await migrate(client, new URL('../../../../migrations/core/postgresql/', import.meta.url));
      for (const client of [db.sourcePii, db.pii])
        await migrate(client, new URL('../../../../migrations/pii/postgresql/', import.meta.url));
      const credential = await softwarePasskey();
      await seedSource(db.sourceCore, db.sourcePii, credential);
      const signing = await sourceSigningBundle();
      const files = await buildBackupFiles({
        sourceCore: db.sourceCore,
        sourcePii: db.sourcePii,
        signing,
        credential,
        directory,
      });
      const plan = {
        backup: files.backup,
        supplement: files.supplement,
        core: {
          connectionString: urlFor(names.core),
          targetId: randomUUID(),
          bindingRefs: ['TEST_CORE'],
        },
        pii: {
          connectionString: urlFor(names.pii),
          targetId: randomUUID(),
          bindingRefs: ['TEST_PII'],
        },
        state: { connectionString: urlFor(names.state) },
        environmentName: 'aws-backup-e2e',
        spEntityIds: [SP],
        allocationScope: 'shared_pool' as const,
        awsFlowRuntimeHmacSecret: 'aws-flow-hmac-with-at-least-thirty-two-bytes',
        awsLookupReadKeys: [
          { generation: 1, secret: 'aws-lookup-hmac-with-at-least-thirty-two-bytes' },
        ],
      };
      restored = await restoreOfflineAwsSamlTenant({
        ...plan,
        restoreId: randomUUID(),
        state: { ...plan.state, initializeEmptySchema: true },
      });
      const probe = {
        issuer: ORIGIN,
        tenantId: TENANT,
        spEntityId: SP,
        userId: 'user-tenant-a',
        credential: { id: credential.id, privateJwk: credential.privateJwk },
        expectedCertificateDerSha256: createHash('sha256')
          .update(new X509Certificate(signing.certificate).raw)
          .digest('hex'),
      };
      for (const counter of [1, 2]) {
        const runtime = counter === 1 ? restored?.runtime : reloaded?.runtime;
        if (!runtime) throw new Error('reloaded_runtime_missing');
        const report = await runSyntheticSamlLoginProbe({ runtime, probe, counter });
        expect(report).toMatchObject({
          counter,
          signatureVerified: true,
          metadataCertificatePinned: true,
          badSignatureRejected: true,
          badOriginRejected: true,
          passkeyReplayRejected: true,
          samlReplayRejected: true,
          replayRejected: true,
          attributeVerified: true,
          nameIdVerified: true,
        });
        expect(JSON.stringify(report)).not.toContain(credential.id);
        expect(JSON.stringify(report)).not.toContain(credential.privateJwk.d);
        expect(
          (
            await db.core.query('SELECT counter FROM passkeys WHERE id=$1 AND tenant_id=$2', [
              'passkey-a',
              TENANT,
            ])
          ).rows
        ).toEqual([{ counter: String(counter) }]);
        expect(
          (
            await db.core.query(
              `SELECT count(*)::text AS count FROM flow_audit_events
           WHERE tenant_id=$1 AND user_id=$2 AND event_type='flow.interaction.completed' AND result='success'`,
              [TENANT, 'user-tenant-a']
            )
          ).rows
        ).toEqual([{ count: String(counter) }]);
        expect(
          (
            await db.state.query(
              `SELECT count(*)::text AS count FROM authrim_aws_transient_state
           WHERE tenant_id=$1 AND kind='session' AND payload->>'userId'=$2`,
              [TENANT, 'user-tenant-a']
            )
          ).rows
        ).toEqual([{ count: String(counter) }]);
        expect(
          (
            await db.state.query(
              'SELECT counter FROM authrim_aws_passkey_counters WHERE credential_id=$1 AND tenant_id=$2',
              ['passkey-a', TENANT]
            )
          ).rows
        ).toEqual([{ counter: String(counter) }]);
        if (counter === 1) {
          if (!restored) throw new Error('restored_runtime_missing');
          const evidence = restored.evidence;
          await restored.close();
          restored = undefined;
          reloaded = await loadActivatedAwsSamlTenant({ ...plan, evidence });
        }
      }
      expect(externalFetch).not.toHaveBeenCalled();
    } finally {
      externalFetch.mockRestore();
      await restored?.close();
      await reloaded?.close();
      await Promise.all(connected.map((client) => client.end()));
      for (const name of created.reverse())
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
