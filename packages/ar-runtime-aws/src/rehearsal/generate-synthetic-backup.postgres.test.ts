import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';
import { createAwsSamlRuntime } from '../http-runtime';
import { restoreOfflineAwsSamlTenant } from '../import/restore-offline';
import { prepareBrowserSp } from '../maintenance/prepare-browser-sp';
import { parseSAMLXml } from '../../../ar-saml/src/common/xml-utils';
import { SAML_NAMESPACES } from '../../../ar-saml/src/common/constants';
import { generateSyntheticAwsBackup } from './generate-synthetic-backup';
import { migrate, fromBase64url, type buildBackupFiles } from './synthetic-fixture';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
const postgresIt = databaseUrl ? it : it.skip;
type Backup = Awaited<ReturnType<typeof buildBackupFiles>>['backup'];

postgresIt(
  'generates and restores a separate browser fixture with AWS-bound issuer, passkey and SP metadata',
  { timeout: 120_000 },
  async () => {
    if (!databaseUrl) throw new Error('test_database_missing');
    const base = new URL(databaseUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
      throw new Error('local_test_database_required');
    const issuer = 'https://abcdefghij.execute-api.ap-northeast-1.amazonaws.com';
    const profile = {
      kind: 'aws-browser' as const,
      issuer,
      spEntityId: `${issuer}/test-sp/metadata`,
      acsUrl: `${issuer}/test-sp/acs`,
    };
    const suffix = randomUUID().replaceAll('-', '');
    const names = {
      core: `browser_core_${suffix}`,
      pii: `browser_pii_${suffix}`,
      state: `browser_state_${suffix}`,
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
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'authrim-browser-fixture-'));
    const output = join(directory, 'generated');
    const created: string[] = [];
    const connected: Client[] = [];
    let restored: Awaited<ReturnType<typeof restoreOfflineAwsSamlTenant>> | undefined;
    const externalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fixture_external_fetch_forbidden');
    });
    try {
      const summary = await generateSyntheticAwsBackup({
        databaseUrl,
        directory: output,
        migrationDirectory: new URL('../../../../migrations/', import.meta.url).pathname,
        profile,
      });
      expect(summary).toMatchObject({
        issuer,
        spEntityId: profile.spEntityId,
        environmentName: 'aws-browser-rehearsal',
        syntheticOnly: true,
        cloudflareApiCalls: 0,
        users: 1,
        passkeys: 1,
      });
      expect((await stat(output)).mode & 0o777).toBe(0o700);
      for (const file of [
        'fixture.json',
        'summary.json',
        'secrets.json',
        'supplement.json',
        'backup-0.bin',
      ])
        expect((await stat(join(output, file))).mode & 0o777).toBe(0o600);
      const descriptor = JSON.parse(await readFile(join(output, 'fixture.json'), 'utf8')) as {
        backup: Omit<Backup, 'partPaths' | 'passphrase'> & { parts: { path: string }[] };
        supplement: { path: string; sha256: string };
        restoreId: string;
        core: { targetId: string; bindingRefs: string[] };
        pii: { targetId: string; bindingRefs: string[] };
        environmentName: string;
        spEntityIds: string[];
      };
      const secrets = JSON.parse(await readFile(join(output, 'secrets.json'), 'utf8')) as {
        backupPassphrase: string;
        awsFlowRuntimeHmacSecret: string;
        awsLookupReadKeys: { generation: number; secret: string }[];
        softwarePasskeyPrivateJwk: JsonWebKey;
        softwarePasskeyCredentialId: string;
        softwarePasskeyCdpCredential: {
          credentialId: string;
          rpId: string;
          privateKey: string;
          userHandle: string;
          signCount: number;
          isResidentCredential: boolean;
        };
      };
      expect(secrets.softwarePasskeyCdpCredential).toMatchObject({
        rpId: new URL(issuer).hostname,
        isResidentCredential: true,
        signCount: 0,
        userHandle: btoa('user-tenant-a'),
      });
      expect(fromBase64url(secrets.softwarePasskeyCdpCredential.credentialId)).toEqual(
        fromBase64url(secrets.softwarePasskeyCredentialId)
      );
      expect(JSON.stringify(summary)).not.toContain(secrets.softwarePasskeyPrivateJwk.d);
      expect(JSON.stringify(descriptor)).not.toContain(secrets.backupPassphrase);
      await admin.connect();
      for (const name of Object.values(names)) {
        await admin.query(`CREATE DATABASE "${name}"`);
        created.push(name);
      }
      for (const client of Object.values(db)) {
        await client.connect();
        connected.push(client);
      }
      await migrate(db.core, new URL('../../../../migrations/core/postgresql/', import.meta.url));
      await migrate(db.pii, new URL('../../../../migrations/pii/postgresql/', import.meta.url));
      restored = await restoreOfflineAwsSamlTenant({
        backup: {
          ...descriptor.backup,
          partPaths: descriptor.backup.parts.map((part) => join(output, part.path)),
          passphrase: secrets.backupPassphrase,
        },
        supplement: {
          path: join(output, descriptor.supplement.path),
          expectedSha256: descriptor.supplement.sha256,
        },
        restoreId: descriptor.restoreId,
        core: { connectionString: urlFor(names.core), ...descriptor.core },
        pii: { connectionString: urlFor(names.pii), ...descriptor.pii },
        state: { connectionString: urlFor(names.state), initializeEmptySchema: true },
        environmentName: descriptor.environmentName,
        spEntityIds: descriptor.spEntityIds,
        allocationScope: 'shared_pool',
        awsFlowRuntimeHmacSecret: secrets.awsFlowRuntimeHmacSecret,
        awsLookupReadKeys: secrets.awsLookupReadKeys,
      });
      expect(restored.runtime.origin).toBe(issuer);
      const app = createAwsSamlRuntime({ tenants: [restored.runtime] }).app;
      expect((await app.request(`${issuer}/health/ready`)).status).toBe(200);
      expect((await app.request('https://tenant-a.example.test/health/ready')).status).toBe(404);
      // Readiness has no ingress requirement, but real protocol routes require trusted context.
      // A mocked metadata response alone cannot catch this private-preparer integration error.
      expect((await app.request(`${issuer}/saml/idp/metadata`)).status).toBe(400);
      const metadata = await app.request(
        `${issuer}/saml/idp/metadata`,
        {},
        { requestContext: { http: { sourceIp: '203.0.113.8' } } }
      );
      expect(metadata.status).toBe(200);
      const xml = await metadata.text();
      expect(xml).toContain(`entityID="${issuer}/saml/idp/metadata"`);
      const metadataRoot = parseSAMLXml(xml).documentElement;
      expect(metadataRoot?.getElementsByTagNameNS(SAML_NAMESPACES.DS, 'Signature').length).toBe(1);
      expect(metadataRoot?.getElementsByTagNameNS(SAML_NAMESPACES.MD, 'KeyDescriptor').length).toBe(
        1
      );
      expect(
        metadataRoot?.getElementsByTagNameNS(SAML_NAMESPACES.DS, 'X509Certificate').length
      ).toBe(2);
      const cert = xml.match(/<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/u)?.[1];
      if (!cert) throw new Error('metadata_certificate_missing');
      expect(
        createHash('sha256')
          .update(
            new X509Certificate(Uint8Array.from(atob(cert), (character) => character.charCodeAt(0)))
              .raw
          )
          .digest('hex')
      ).toBe(summary.signingCertificateDerSha256);
      const host = 'browser-test.abc.ap-northeast-1.rds.amazonaws.com';
      const stateDatabaseUrl = `postgresql://authrim_dr_browser_state:synthetic-placeholder@${host}:5432/authrim_dr_browser_state?sslmode=verify-full`;
      const saveSecret = vi.fn(async (_value: string) => undefined);
      const prepareInput = {
        databasePrefix: 'authrim_dr_browser',
        environmentName: 'aws-browser-rehearsal',
        tenantId: 'tenant-a',
        issuer,
        spEntityIds: [profile.spEntityId],
        host,
        stateDatabaseUrl,
        seed: {
          browserSp: {
            syntheticOnly: true,
            origin: issuer,
            certificateDerSha256: summary.signingCertificateDerSha256,
          },
        },
        currentSecret: async () => JSON.stringify({ formatVersion: 1, uninitialized: true }),
        saveSecret,
      };
      await expect(
        prepareBrowserSp({
          ...prepareInput,
          metadata: async () => app.request(`${issuer}/saml/idp/metadata`),
        })
      ).rejects.toThrow('aws_browser_sp_preparation_invalid');
      expect(saveSecret).not.toHaveBeenCalled();
      const prepared = await prepareBrowserSp({
        ...prepareInput,
        metadata: async () =>
          app.request(
            `${issuer}/saml/idp/metadata`,
            {},
            { requestContext: { http: { sourceIp: '203.0.113.8' } } }
          ),
      });
      expect(prepared).toEqual({
        syntheticOnly: true,
        origin: issuer,
        certificateDerSha256: summary.signingCertificateDerSha256,
      });
      expect(saveSecret).toHaveBeenCalledTimes(1);
      const saved = JSON.parse(saveSecret.mock.calls[0][0]) as Record<string, unknown>;
      expect(Object.keys(saved).sort()).toEqual([
        'certificateDerSha256',
        'certificatePem',
        'environmentName',
        'formatVersion',
        'origin',
        'stateDatabaseUrl',
        'syntheticOnly',
        'tenantId',
      ]);
      expect(saved).toMatchObject({
        formatVersion: 1,
        syntheticOnly: true,
        environmentName: 'aws-browser-rehearsal',
        tenantId: 'tenant-a',
        origin: issuer,
        stateDatabaseUrl,
        certificateDerSha256: summary.signingCertificateDerSha256,
      });
      expect(typeof saved.certificatePem).toBe('string');
      expect(
        createHash('sha256')
          .update(new X509Certificate(saved.certificatePem as string).raw)
          .digest('hex')
      ).toBe(summary.signingCertificateDerSha256);
      const passkeys = await db.core.query<{ credential_id: string; rp_id: string }>(
        'SELECT credential_id, rp_id FROM passkeys WHERE tenant_id=$1',
        ['tenant-a']
      );
      expect(passkeys.rows).toEqual([
        { credential_id: secrets.softwarePasskeyCredentialId, rp_id: new URL(issuer).hostname },
      ]);
      const sp = await db.core.query<{ config_json: string }>(
        "SELECT config_json FROM identity_providers WHERE id='provider-a' AND tenant_id=$1",
        ['tenant-a']
      );
      expect(JSON.parse(sp.rows[0].config_json) as unknown).toMatchObject({
        entityId: profile.spEntityId,
        acsUrl: profile.acsUrl,
        acsUrls: [profile.acsUrl],
        signResponses: true,
      });
      expect(externalFetch).not.toHaveBeenCalled();
    } finally {
      externalFetch.mockRestore();
      await restored?.close();
      await Promise.all(connected.map((client) => client.end()));
      for (const name of created.reverse())
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
