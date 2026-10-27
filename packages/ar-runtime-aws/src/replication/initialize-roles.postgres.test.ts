import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  initializeReplicationAuthorityDatabase,
  readReplicationAuthoritySchema,
} from './initialize';
import { PostgresEnvironmentAuthority } from './environment-authority-postgres';
import { PostgresDeploymentAuthority } from './authority-postgres';
import { ReplicationJournal } from './journal';
const connectionString =
  process.env.AUTHRIM_AWS_TEST_DATABASE_URL ?? process.env.AUTHRIM_TEST_DATABASE_URL;
const caPath = process.env.AUTHRIM_TEST_DATABASE_CA;
(connectionString && caPath ? describe : describe.skip)(
  'authority least-privilege bootstrap (native TLS PostgreSQL)',
  () => {
    let admin: Pool;
    let owner: Pool;
    let service: Pool;
    let journal: Pool;
    let ca = '';
    let database = '';
    let source = '';
    let roles = { serviceRole: '', journalRole: '' };
    beforeAll(async () => {
      ca = await readFile(caPath ?? '', 'utf8');
      source = (await readReplicationAuthoritySchema()).digest;
      admin = new Pool({ connectionString, ssl: { ca, rejectUnauthorized: true } });
    });
    beforeEach(async () => {
      const suffix = randomUUID().replaceAll('-', '');
      database = `replica_role_${suffix}`;
      roles = { serviceRole: `replica_s_${suffix}`, journalRole: `replica_j_${suffix}` };
      await admin.query(
        `CREATE ROLE "${roles.serviceRole}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'local_role_test_only'`
      );
      await admin.query(
        `CREATE ROLE "${roles.journalRole}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'local_role_test_only'`
      );
      await admin.query(`CREATE DATABASE "${database}"`);
      const url = new URL(connectionString ?? '');
      url.pathname = `/${database}`;
      owner = new Pool({ connectionString: url.href, ssl: { ca, rejectUnauthorized: true } });
      url.username = roles.serviceRole;
      url.password = 'local_role_test_only';
      service = new Pool({ connectionString: url.href, ssl: { ca, rejectUnauthorized: true } });
      url.username = roles.journalRole;
      journal = new Pool({ connectionString: url.href, ssl: { ca, rejectUnauthorized: true } });
    });
    afterEach(async () => {
      await Promise.all([owner?.end(), service?.end(), journal?.end()]);
      if (database) await admin.query(`DROP DATABASE "${database}"`);
      for (const role of [roles.serviceRole, roles.journalRole])
        if (role) await admin.query(`DROP ROLE "${role}"`);
      database = '';
    });
    afterAll(async () => {
      await admin?.end();
    });
    it('grants exact authority/journal operations before pinning the repeatable initialization receipt', async () => {
      await owner.query(
        `GRANT CREATE,TEMP ON DATABASE "${database}" TO "${roles.serviceRole}","${roles.journalRole}"; GRANT CREATE ON SCHEMA public TO "${roles.serviceRole}","${roles.journalRole}"`
      );
      const first = await initializeReplicationAuthorityDatabase(owner, source, roles);
      expect(await initializeReplicationAuthorityDatabase(owner, source, roles)).toEqual(first);
      const authority = new PostgresDeploymentAuthority(service);
      const pairId = randomUUID();
      const tenantId = randomUUID();
      expect(
        await authority.initialize({
          pairId,
          tenantId,
          deployments: [
            { deploymentId: 'cf-a', provider: 'cloudflare' },
            { deploymentId: 'aws-a', provider: 'aws' },
          ],
          initialOwnerDeploymentId: 'cf-a',
          initialGenerationId: 'initial',
        })
      ).toMatchObject({ phase: 'active', epoch: 1 });
      await new ReplicationJournal(journal).withOperation({
        pairId,
        operationId: randomUUID(),
        planSha256: 'a'.repeat(64),
        initial: { phase: 'pending' },
        run: async (checkpoint) => {
          await checkpoint.save({ phase: 'done' });
        },
      });
      const environmentPair = {
        pairId: randomUUID(),
        environmentId: randomUUID(),
        deployments: [
          { deploymentId: 'env-cf', provider: 'cloudflare' as const },
          { deploymentId: 'env-aws', provider: 'aws' as const },
        ] as const,
        initialOwnerDeploymentId: 'env-cf',
        initialGenerationId: 'original',
      };
      const environmentAuthority = new PostgresEnvironmentAuthority(service);
      await environmentAuthority.initialize(environmentPair);
      const environmentPermit = {
        pairId: environmentPair.pairId,
        environmentId: environmentPair.environmentId,
        deploymentId: 'env-cf',
        epoch: 1,
        generationId: 'original',
        permitId: randomUUID(),
        operationDigest: 'b'.repeat(64),
      };
      await environmentAuthority.enter(environmentPermit);
      await environmentAuthority.complete(environmentPermit);
      await new ReplicationJournal(journal, 'environment').withOperation({
        pairId: environmentPair.pairId,
        operationId: randomUUID(),
        planSha256: 'b'.repeat(64),
        initial: { phase: 'pending' },
        run: async (checkpoint) => {
          await checkpoint.save({ phase: 'done' });
        },
      });
      await expect(
        service.query('SELECT * FROM authrim_replication_environment_journal')
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        journal.query('UPDATE authrim_replication_environment_authorities SET epoch=epoch+1')
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        journal.query(
          "INSERT INTO authrim_replication_environment_reservations VALUES('forbidden','forbidden','forbidden')"
        )
      ).rejects.toMatchObject({ code: '42501' });
      for (const table of [
        'authrim_replication_environment_permits',
        'authrim_replication_environment_generations',
        'authrim_replication_environment_reservations',
      ])
        await expect(service.query(`DELETE FROM ${table}`)).rejects.toMatchObject({
          code: '42501',
        });
      for (const pool of [service, journal])
        for (const sql of [
          'CREATE TABLE forbidden(id text)',
          'CREATE TEMP TABLE forbidden(id text)',
          'UPDATE authrim_replication_schema SET source_sha256=source_sha256',
          'SELECT * FROM authrim_replication_schema',
        ])
          await expect(pool.query(sql)).rejects.toMatchObject({ code: '42501' });
      await expect(
        service.query('SELECT * FROM authrim_replication_journal')
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        journal.query("UPDATE authrim_replication_authorities SET owner_deployment_id='aws-a'")
      ).rejects.toMatchObject({ code: '42501' });
      await expect(service.query('DELETE FROM authrim_replication_permits')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(service.query('TRUNCATE authrim_replication_permits')).rejects.toMatchObject({
        code: '42501',
      });
      expect((await authority.get(pairId, tenantId)).ownerDeploymentId).toBe('cf-a');
      expect(
        (
          await owner.query<{ bootstrap_json: string }>(
            'SELECT bootstrap_json FROM authrim_replication_schema'
          )
        ).rows[0]?.bootstrap_json
      ).toContain(roles.serviceRole);
    });
    it.each([
      'SUPERUSER',
      'BYPASSRLS',
      'CREATEDB',
      'CREATEROLE',
      'REPLICATION',
      'INHERIT',
      'NOLOGIN',
    ] as const)('rejects unsafe existing role flag %s before DDL', async (flag) => {
      await admin.query(`ALTER ROLE "${roles.serviceRole}" ${flag}`);
      await expect(initializeReplicationAuthorityDatabase(owner, source, roles)).rejects.toThrow(
        'replication_authority_initialization_failed'
      );
      expect(
        (await owner.query("SELECT to_regclass('public.authrim_replication_schema') AS relation"))
          .rows
      ).toEqual([{ relation: null }]);
    });
    it('rejects any inherited/member role path, including reverse membership', async () => {
      await admin.query(`GRANT "${roles.journalRole}" TO "${roles.serviceRole}"`);
      await expect(initializeReplicationAuthorityDatabase(owner, source, roles)).rejects.toThrow(
        'replication_authority_initialization_failed'
      );
    });
    it('rejects altered grants, role capabilities and omitted bootstrap pins on repeat', async () => {
      await initializeReplicationAuthorityDatabase(owner, source, roles);
      await expect(initializeReplicationAuthorityDatabase(owner, source)).rejects.toThrow(
        'replication_authority_initialization_failed'
      );
      await owner.query(`GRANT DELETE ON authrim_replication_permits TO "${roles.serviceRole}"`);
      await expect(initializeReplicationAuthorityDatabase(owner, source, roles)).rejects.toThrow(
        'replication_authority_initialization_failed'
      );
      await owner.query(`REVOKE DELETE ON authrim_replication_permits FROM "${roles.serviceRole}"`);
      await admin.query(`ALTER ROLE "${roles.journalRole}" INHERIT`);
      await expect(initializeReplicationAuthorityDatabase(owner, source, roles)).rejects.toThrow(
        'replication_authority_initialization_failed'
      );
    });
  }
);
