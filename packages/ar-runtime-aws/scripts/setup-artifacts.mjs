import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { AwsSetupError } from './setup-aws-cli.mjs';
import {
  canonicalSetupJson,
  readSetupFile,
  readSetupJson,
  setupDigest,
  writeSetupState,
} from './setup-execution-state.mjs';
import { readExecutionBuildPins } from './setup-build.mjs';
import { normalizeSetupUi } from './setup-ui-config.mjs';
import { executionAuthState } from './setup-auth-state.mjs';

const execute = promisify(execFile);
const fail = (code) => {
  throw new AwsSetupError(`aws_setup_${code}`);
};
const HASH = /^[0-9a-f]{64}$/u;
const MAX = 256 * 1024 * 1024;
const packageFiles = { job: 'db-bootstrap.zip', idp: 'lambda.zip', sp: 'browser-sp.zip' };

async function runLocal(root, script, args = []) {
  // Fixed Node entry points only. Output is intentionally not forwarded: build/fixture diagnostics
  // may include source data or connection details. The CLI reports a stable failure code.
  try {
    await execute(process.execPath, [join(root, 'packages/ar-runtime-aws', script), ...args], {
      cwd: root,
      shell: false,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    fail('local_preparation_failed');
  }
}

export async function readExecutionFixture(directory, expectedSha256) {
  const bytes = await readSetupFile(join(directory, 'fixture.json'));
  if (expectedSha256 && setupDigest(bytes) !== expectedSha256) fail('fixture_changed');
  let descriptor;
  try {
    descriptor = JSON.parse(bytes);
  } catch {
    fail('fixture_invalid');
  }
  const keys = [
    'formatVersion',
    'manifest',
    'backup',
    'supplement',
    'restoreId',
    'core',
    'pii',
    'environmentName',
    'spEntityIds',
    'allocationScope',
  ];
  if (
    descriptor.formatVersion !== 1 ||
    Object.keys(descriptor).sort().join() !== keys.sort().join() ||
    !Array.isArray(descriptor.backup?.parts) ||
    descriptor.backup.parts.length < 1 ||
    descriptor.backup.parts.length > 128 ||
    !descriptor.backup.receipt ||
    typeof descriptor.backup.receipt !== 'object' ||
    !Number.isSafeInteger(descriptor.backup.maxSnapshotAgeMs) ||
    descriptor.backup.maxSnapshotAgeMs < 1 ||
    ![descriptor.restoreId, descriptor.core?.targetId, descriptor.pii?.targetId].every((id) =>
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id ?? '')
    )
  )
    fail('fixture_invalid');
  let total = 0;
  for (const pin of [...descriptor.backup.parts, descriptor.supplement]) {
    if (
      !pin ||
      typeof pin.path !== 'string' ||
      basename(pin.path) !== pin.path ||
      !HASH.test(pin.sha256) ||
      !Number.isSafeInteger(pin.size) ||
      pin.size < 1
    )
      fail('fixture_invalid');
    const content = await readSetupFile(join(directory, pin.path), { maxBytes: MAX });
    total += content.length;
    if (content.length !== pin.size || setupDigest(content) !== pin.sha256 || total > MAX)
      fail('fixture_changed');
  }
  return { descriptor, sha256: setupDigest(bytes) };
}

/** Only newly generated synthetic source data may be adapted to the requested external UI. */
export function createSyntheticExecutionProfile(config, origin) {
  const destinationUi = normalizeSetupUi(config.components, config.ui, config.mode);
  return {
    kind: 'aws-browser',
    issuer: origin,
    spEntityId: `${origin}/test-sp/metadata`,
    acsUrl: `${origin}/test-sp/acs`,
    ...(destinationUi?.ui.login.mode === 'external'
      ? { externalLogin: destinationUi.ui.login }
      : {}),
  };
}

export async function prepareExecutionArtifacts({
  config,
  root,
  directory,
  origin,
  state,
  save,
  build,
}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await runLocal(root, 'scripts/build.mjs');
  if (canonicalSetupJson(await readExecutionBuildPins(root)) !== canonicalSetupJson(build))
    fail('build_inputs_changed');
  if (config.fixture.generate) {
    const profile = createSyntheticExecutionProfile(config, origin);
    const profilePath = join(directory, 'fixture-profile.json');
    await writeSetupState(profilePath, profile);
    let exists = false;
    try {
      await lstat(config.fixture.directory);
      exists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!state.fixtureGenerationStarted && exists) fail('fixture_directory_exists');
    if (!state.fixtureGenerationStarted) {
      state.fixtureGenerationStarted = true;
      await save();
    }
    if (!exists)
      await runLocal(root, 'dist/synthetic-backup-cli.mjs', [
        '--out',
        config.fixture.directory,
        '--migrations',
        join(root, 'migrations'),
        '--profile',
        profilePath,
      ]);
    // A completed generation can be adopted after process interruption. An incomplete directory
    // fails validation; setup never removes it or silently generates different keys.
    const summary = await readSetupJson(join(config.fixture.directory, 'summary.json'));
    if (
      summary.syntheticOnly !== true ||
      summary.profile !== 'aws-browser' ||
      summary.issuer !== origin
    )
      fail('synthetic_origin_mismatch');
    if (
      canonicalSetupJson(summary.externalLogin ?? null) !==
      canonicalSetupJson(profile.externalLogin ?? null)
    )
      fail('synthetic_ui_mismatch');
  }
  const fixture = await readExecutionFixture(
    config.fixture.directory,
    config.fixture.descriptorSha256
  );
  if (fixture.descriptor.manifest?.source?.issuer !== origin) fail('fixture_origin_mismatch');
  for (const script of [
    'package-db-bootstrap.mjs',
    'package-lambda.mjs',
    ...(config.mode === 'browser-rehearsal' ? ['package-browser-sp.mjs'] : []),
  ])
    await runLocal(root, `scripts/${script}`, [
      '--ca-bundle',
      config.assets.caBundlePath,
      ...(script === 'package-lambda.mjs' && config.ui
        ? [
            '--login-ui',
            config.ui.login.mode === 'embedded-rehearsal' ? 'embedded-rehearsal' : 'none',
          ]
        : []),
    ]);
  const artifacts = {};
  for (const name of ['job', 'idp', ...(config.mode === 'browser-rehearsal' ? ['sp'] : [])]) {
    const bytes = await readSetupFile(
      join(root, 'packages/ar-runtime-aws/dist', packageFiles[name]),
      { maxBytes: 64 * 1024 * 1024 }
    );
    const sha256 = setupDigest(bytes);
    const path = join(directory, `${name}-${sha256}.zip`);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }).catch(async (error) => {
      if (
        error.code !== 'EEXIST' ||
        setupDigest(await readSetupFile(path, { maxBytes: 64 * 1024 * 1024 })) !== sha256
      )
        throw error;
    });
    artifacts[name] = { path, sha256, size: bytes.length };
  }
  return { fixtureSha256: fixture.sha256, artifacts };
}

/** Content-addressed immutable writes; recover a lost PutObject response by checking the exact object. */
export async function uploadExecutionObject({ aws, bucket, owner, prefix, path, expectedSha256 }) {
  const bytes = await readSetupFile(path, { maxBytes: MAX });
  const sha256 = setupDigest(bytes);
  if (expectedSha256 && sha256 !== expectedSha256) fail('artifact_changed');
  const key = `${prefix}${sha256}/${basename(path)}`;
  const checksum = Buffer.from(sha256, 'hex').toString('base64');
  let result;
  try {
    result = await aws(
      's3api',
      'put-object',
      {
        Bucket: bucket,
        Key: key,
        ExpectedBucketOwner: owner,
        ChecksumSHA256: checksum,
        ContentLength: bytes.length,
        ServerSideEncryption: 'AES256',
        IfNoneMatch: '*',
      },
      { body: resolve(path) }
    );
  } catch (error) {
    if (!error.ambiguous && error.code !== 'aws_setup_object_exists') throw error;
    result = await aws('s3api', 'head-object', {
      Bucket: bucket,
      Key: key,
      ExpectedBucketOwner: owner,
      ChecksumMode: 'ENABLED',
    });
    if (result.ContentLength !== bytes.length) fail('uploaded_object_mismatch');
  }
  if (
    result.ChecksumSHA256 !== checksum ||
    typeof result.VersionId !== 'string' ||
    !result.VersionId ||
    result.VersionId === 'null'
  )
    fail('uploaded_object_unpinned');
  return { key, versionId: result.VersionId, size: bytes.length, sha256 };
}

export async function uploadExecutionArtifacts({
  aws,
  config,
  state,
  save,
  directory,
  bucket,
  origin,
  inputSecretArn,
}) {
  const versioning = await aws('s3api', 'get-bucket-versioning', {
    Bucket: bucket,
    ExpectedBucketOwner: config.target.accountId,
  });
  if (versioning.Status !== 'Enabled') fail('bucket_versioning_required');
  const prepared = state.stages.prepare.receipt;
  const { descriptor } = await readExecutionFixture(
    config.fixture.directory,
    prepared.fixtureSha256
  );
  const upload = (path, sha256) =>
    uploadExecutionObject({
      aws,
      bucket,
      owner: config.target.accountId,
      prefix: config.assets.prefix,
      path,
      expectedSha256: sha256,
    });
  const pins = (state.uploads ??= {});
  async function pinned(id, path, sha256) {
    if (!pins[id]) {
      pins[id] = await upload(path, sha256);
      await save();
    }
    if (pins[id].sha256 !== sha256) fail('artifact_changed');
    return pins[id];
  }
  const parts = [];
  for (const [index, pin] of descriptor.backup.parts.entries())
    parts.push(await pinned(`part${index}`, join(config.fixture.directory, pin.path), pin.sha256));
  const supplement = await pinned(
    'supplement',
    join(config.fixture.directory, descriptor.supplement.path),
    descriptor.supplement.sha256
  );
  const destinationUi = normalizeSetupUi(config.components, config.ui, config.mode);
  const cloudFixture = {
    ...descriptor,
    backup: { ...descriptor.backup, parts },
    supplement,
    ...(destinationUi ? { destinationUi } : {}),
    ...(config.authState === undefined
      ? {}
      : {
          authState: executionAuthState(config, state, descriptor.restoreId),
        }),
  };
  const fixturePath = join(directory, 'cloud-fixture.json');
  await writeSetupState(fixturePath, cloudFixture);
  const fixture = await pinned(
    'fixture',
    fixturePath,
    setupDigest(await readSetupFile(fixturePath))
  );
  const artifacts = {};
  for (const [name, artifact] of Object.entries(prepared.artifacts))
    artifacts[name] = await pinned(name, artifact.path, artifact.sha256);
  if (config.mode === 'browser-rehearsal') {
    if (!state.inputSeeded) {
      const seeds = await readSetupJson(join(config.fixture.directory, 'secrets.json'), {
        privateFile: true,
      });
      const summary = await readSetupJson(join(config.fixture.directory, 'summary.json'));
      if (
        summary.syntheticOnly !== true ||
        summary.issuer !== origin ||
        !HASH.test(summary.signingCertificateDerSha256)
      )
        fail('synthetic_origin_mismatch');
      const value = {
        backupPassphrase: seeds.backupPassphrase,
        awsFlowRuntimeHmacSecret: seeds.awsFlowRuntimeHmacSecret,
        awsLookupReadKeys: seeds.awsLookupReadKeys,
        browserSp: {
          syntheticOnly: true,
          origin,
          certificateDerSha256: summary.signingCertificateDerSha256,
        },
      };
      if (
        !value.backupPassphrase ||
        !value.awsFlowRuntimeHmacSecret ||
        !Array.isArray(value.awsLookupReadKeys)
      )
        fail('fixture_secrets_invalid');
      const path = join(directory, 'input-secret.pending.json');
      try {
        await writeSetupState(path, value);
        const response = await aws(
          'secretsmanager',
          'put-secret-value',
          { SecretId: inputSecretArn, ClientRequestToken: state.inputVersion },
          { secret: path }
        );
        if (response.ARN !== inputSecretArn || response.VersionId !== state.inputVersion)
          fail('secret_version_mismatch');
        state.inputSeeded = true;
        await save();
      } finally {
        await unlink(path).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
  } else {
    const secret = await aws('secretsmanager', 'describe-secret', { SecretId: inputSecretArn });
    if (
      secret.ARN !== inputSecretArn ||
      !Object.hasOwn(secret.VersionIdsToStages ?? {}, config.issuer.inputSecretVersionId)
    )
      fail('input_secret_version_missing');
  }
  return { fixture, artifacts, fixtureSha256: prepared.fixtureSha256 };
}

export async function uploadExecutionManifest({ aws, config, state, directory, bucket }) {
  const fixture = await readSetupJson(join(directory, 'cloud-fixture.json'));
  if (
    setupDigest(await readSetupFile(join(directory, 'cloud-fixture.json'))) !==
    state.stages.upload.receipt.fixture.sha256
  )
    fail('fixture_changed');
  const { manifest: _manifest, restoreId: _restoreId, ...base } = fixture;
  const manifest = { ...base, evidence: state.stages.verify.receipt.evidence };
  const path = join(directory, 'runtime-manifest.json');
  // Runtime contract hashes exact canonical bytes. In particular, do not append a newline.
  await writeSetupState(path, manifest, { newline: false });
  return uploadExecutionObject({
    aws,
    bucket,
    owner: config.target.accountId,
    prefix: config.assets.prefix,
    path,
  });
}
