import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';
import {
  TENANT,
  base64url,
  buildBackupFiles,
  migrate,
  seedSource,
  softwarePasskey,
  sourceSigningBundle,
  fromBase64url,
  resolveSyntheticFixtureProfile,
  type SyntheticFixtureProfile,
} from './synthetic-fixture';

export interface GenerateSyntheticBackupInput {
  databaseUrl: string;
  directory: string;
  migrationDirectory: string;
  profile?: SyntheticFixtureProfile;
}

/** The generator only connects to a disposable local PostgreSQL server. */
export function assertLocalFixtureDatabase(databaseUrl: string): URL {
  const url = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.searchParams.has('host') ||
    url.searchParams.has('hostaddr') ||
    url.searchParams.has('service')
  ) {
    throw new Error('aws_synthetic_fixture_local_database_required');
  }
  return url;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

/** Creates local synthetic source DBs, emits encrypted files, and removes those source DBs. */
export async function generateSyntheticAwsBackup(input: GenerateSyntheticBackupInput) {
  const sourceUrl = assertLocalFixtureDatabase(input.databaseUrl);
  const profile = resolveSyntheticFixtureProfile(input.profile);
  const directory = resolve(input.directory);
  // A new directory avoids overwriting an earlier fixture or confusing two runs.
  await mkdir(directory, { mode: 0o700 });
  const suffix = randomUUID().replaceAll('-', '');
  const names = {
    core: `authrim_fixture_core_${suffix}`,
    pii: `authrim_fixture_pii_${suffix}`,
  };
  const admin = new Client({ connectionString: sourceUrl.toString() });
  const created: string[] = [];
  const connected: Client[] = [];
  let adminConnected = false;
  const sources = Object.fromEntries(
    Object.entries(names).map(([family, name]) => {
      const url = new URL(sourceUrl);
      url.pathname = `/${name}`;
      return [family, new Client({ connectionString: url.toString() })];
    })
  ) as Record<keyof typeof names, Client>;
  try {
    await admin.connect();
    adminConnected = true;
    for (const name of Object.values(names)) {
      await admin.query(`CREATE DATABASE "${name}"`);
      created.push(name);
    }
    for (const client of Object.values(sources)) {
      await client.connect();
      connected.push(client);
    }
    for (const family of ['core', 'pii'] as const) {
      await migrate(
        sources[family],
        pathToFileURL(`${resolve(input.migrationDirectory, family, 'postgresql')}/`)
      );
    }
    const credential = await softwarePasskey(input.profile);
    const accounts = await seedSource(sources.core, sources.pii, credential, input.profile);
    const signing = await sourceSigningBundle(input.profile);
    const backupPassphrase = base64url(randomBytes(32));
    const files = await buildBackupFiles({
      sourceCore: sources.core,
      sourcePii: sources.pii,
      credential,
      signing,
      directory,
      passphrase: backupPassphrase,
      maxSnapshotAgeMs: 24 * 60 * 60 * 1000,
      profile: input.profile,
    });
    const supplementBytes = await readFile(files.supplement.path);
    const descriptor = {
      formatVersion: 1,
      manifest: files.manifest,
      backup: {
        receipt: files.backup.receipt,
        selection: files.backup.selection,
        datasets: files.backup.datasets,
        maxSnapshotAgeMs: files.backup.maxSnapshotAgeMs,
        parts: files.backup.partPaths.map((path, index) => ({
          path: basename(path),
          size: files.backup.receipt.parts[index].size,
          sha256: files.backup.receipt.parts[index].sha256,
        })),
      },
      supplement: {
        path: basename(files.supplement.path),
        size: supplementBytes.length,
        sha256: files.supplement.expectedSha256,
      },
      restoreId: randomUUID(),
      core: { targetId: randomUUID(), bindingRefs: ['TEST_CORE'] },
      pii: { targetId: randomUUID(), bindingRefs: ['TEST_PII'] },
      environmentName: profile.environmentName,
      spEntityIds: [profile.spEntityId],
      allocationScope: 'shared_pool',
    };
    const secrets = {
      backupPassphrase,
      awsFlowRuntimeHmacSecret: base64url(randomBytes(32)),
      awsLookupReadKeys: [{ generation: 1, secret: base64url(randomBytes(32)) }],
      softwarePasskeyPrivateJwk: credential.privateJwk,
      softwarePasskeyCredentialId: credential.id,
      ...(profile.kind === 'aws-browser'
        ? {
            // CDP's Binary fields use standard base64, unlike the stored WebAuthn credential ID.
            softwarePasskeyCdpCredential: {
              credentialId: btoa(String.fromCharCode(...fromBase64url(credential.id))),
              isResidentCredential: true,
              rpId: credential.rpId,
              privateKey: credential.privateKeyPkcs8Base64,
              userHandle: btoa(accounts.userId),
              signCount: 0,
            },
          }
        : {}),
    };
    const summary = {
      formatVersion: 1,
      syntheticOnly: true,
      generatedAt: new Date().toISOString(),
      tenantId: TENANT,
      issuer: profile.issuer,
      spEntityId: profile.spEntityId,
      ...(profile.kind === 'aws-browser'
        ? {
            profile: profile.kind,
            environmentName: profile.environmentName,
            acsUrl: profile.acsUrl,
            rpId: profile.rpId,
            ...(profile.externalLogin ? { externalLogin: profile.externalLogin } : {}),
            spStartUrl: `${profile.issuer}/test-sp/start`,
          }
        : {}),
      userId: accounts.userId,
      accountId: accounts.accountId,
      email: `${accounts.userId}@example.test`,
      users: 1,
      passkeys: 1,
      datasets: files.backup.datasets.length,
      parts: files.backup.receipt.parts.length,
      boundaryUnixMs: files.manifest.boundaryUnixMs,
      bundleId: files.manifest.bundleId,
      snapshotId: files.manifest.snapshotId,
      signingCertificateDerSha256: sha256(new X509Certificate(signing.certificate).raw),
      cloudflareApiCalls: 0,
    };
    await writeJson(join(directory, 'fixture.json'), descriptor);
    await writeJson(join(directory, 'secrets.json'), secrets);
    await writeJson(join(directory, 'summary.json'), summary);
    return summary;
  } finally {
    await Promise.allSettled(connected.map((client) => client.end()));
    if (adminConnected) {
      try {
        for (const name of created.reverse()) await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
      }
    }
  }
}

export function parseSyntheticFixtureArguments(args: string[]) {
  if (
    ![4, 6].includes(args.length) ||
    args[0] !== '--out' ||
    args[2] !== '--migrations' ||
    !args[1] ||
    !args[3] ||
    (args.length === 6 && (args[4] !== '--profile' || !args[5]))
  ) {
    throw new Error('aws_synthetic_fixture_arguments_invalid');
  }
  return { directory: args[1], migrationDirectory: args[3], profilePath: args[5] };
}

async function main(): Promise<void> {
  const args = parseSyntheticFixtureArguments(process.argv.slice(2));
  const databaseUrl = process.env.AUTHRIM_AWS_FIXTURE_DATABASE_URL;
  if (!databaseUrl) throw new Error('aws_synthetic_fixture_database_missing');
  const result = await generateSyntheticAwsBackup({
    databaseUrl,
    directory: args.directory,
    migrationDirectory: args.migrationDirectory,
    profile: args.profilePath
      ? (JSON.parse(await readFile(args.profilePath, 'utf8')) as SyntheticFixtureProfile)
      : undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Do not print connection strings, source rows, ciphertext or generated keys.
    process.stderr.write('aws_synthetic_fixture_generation_failed\n');
    process.exitCode = 1;
  });
}
