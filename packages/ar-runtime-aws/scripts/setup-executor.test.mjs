import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AwsSetupError, createAwsSetupCli } from './setup-aws-cli.mjs';
import {
  assertSetupIdentity,
  executeSetupStack,
  validateSetupChanges,
} from './setup-cloudformation.mjs';
import {
  canonicalSetupJson,
  lockSetupState,
  readSetupFile,
  readSetupJson,
  setupDigest,
  writeSetupState,
} from './setup-execution-state.mjs';
import {
  EXECUTION_TEMPLATES,
  normalizeExecutionConfig,
  verifyExecutionPlan,
} from './setup-execution-plan.mjs';
import { executeAwsSetup, executeSetupMaintenance } from './setup-executor.mjs';
import { uploadExecutionObject } from './setup-artifacts.mjs';
import { readExecutionBuildPins } from './setup-build.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const account = '123456789012';
const region = 'ap-northeast-1';
const hash = 'a'.repeat(64);
const uuid = '11111111-1111-4111-8111-111111111111';
const rowCounts = Object.fromEntries(
  [
    'core.users_core',
    'core.identity_accounts',
    'core.passkeys',
    'core.identity_providers',
    'pii.users_pii',
    'pii.identity_sensitive_values',
    'state.authrim_aws_account_auth_state',
    'state.authrim_aws_passkey_counters',
    'state.authrim_aws_saml_persistent_nameids',
    'state.authrim_aws_restore_activations',
  ].map((key) => [key, 1])
);
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'authrim-setup-executor-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function config(directory) {
  return {
    formatVersion: 1,
    backend: 'aws',
    role: 'secondary',
    mode: 'browser-rehearsal',
    target: { accountId: account, region },
    identities: {
      bootstrap: { profile: 'bootstrap', principalArn: `arn:aws:iam::${account}:user/operator` },
      operator: {
        profile: 'operator',
        principalArn: `arn:aws:iam::${account}:role/authrim-dr/operator/example-bootstrap-operator`,
      },
    },
    stacks: Object.fromEntries(
      ['bootstrap', 'foundation', 'access', 'database', 'workload'].map((key) => [
        key,
        {
          name: `example-${key}`,
          disposition: 'create',
          parameters:
            key === 'bootstrap'
              ? {
                  OperatorPrincipalArn: `arn:aws:iam::${account}:user/operator`,
                  OperatorPrincipalMode: 'iam-user',
                }
              : {},
        },
      ])
    ),
    assets: { prefix: 'synthetic/setup/', caBundlePath: join(directory, 'ca.pem') },
    fixture: { directory: join(directory, 'fixture'), generate: true },
    databasePrefix: 'authrim_dr_browser',
  };
}

test('config separates backend from role and rejects credentials, foreign accounts, reuse without pins', async (t) => {
  const value = config(await temporary(t));
  assert.equal(normalizeExecutionConfig(value).role, 'secondary');
  for (const edit of [
    (x) => {
      x.secretAccessKey = 'must-never-be-accepted';
    },
    (x) => {
      x.identities.operator.principalArn = x.identities.operator.principalArn.replace(
        account,
        '999999999999'
      );
    },
    (x) => {
      x.stacks.foundation.disposition = 'reuse';
    },
    (x) => {
      x.stacks.workload.parameters.Password = 'secret';
    },
    (x) => {
      x.mode = 'production';
    },
    (x) => {
      x.stacks.bootstrap.parameters = {};
    },
    (x) => {
      x.stacks.bootstrap.parameters.OperatorPrincipalMode = 'federated-role';
    },
  ]) {
    const changed = structuredClone(value);
    edit(changed);
    assert.throws(() => normalizeExecutionConfig(changed), /config_invalid/u);
  }
  await assert.rejects(verifyExecutionPlan({}, hash, root), /plan_digest_mismatch/u);
});

test('CLI uses fixed argv, one attempt and redacts untrusted AWS stderr', async () => {
  const calls = [];
  const aws = createAwsSetupCli(
    { region, profile: 'operator' },
    {
      runProcess: async (...args) => {
        calls.push(args);
        return { exitCode: 0, stdout: '{}' };
      },
    }
  );
  await aws('cloudformation', 'create-change-set', { TemplateBody: 'Resources: {}' });
  assert.equal(calls[0][0], 'aws');
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].env.AWS_MAX_ATTEMPTS, '1');
  assert.equal(calls[0][2].env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS, 'true');
  await assert.rejects(aws('cloudformation', 'delete-stack', {}), /operation_invalid/u);
  await assert.rejects(
    aws('secretsmanager', 'put-secret-value', { SecretString: 'secret' }),
    /operation_invalid/u
  );
  const denied = createAwsSetupCli(
    { region, profile: 'operator' },
    { runProcess: async () => ({ exitCode: 1, stderr: 'AccessDenied password=do-not-print' }) }
  );
  await assert.rejects(
    denied('sts', 'get-caller-identity'),
    (error) => error.code === 'aws_setup_access_denied' && !String(error).includes('do-not-print')
  );
});

test('state is private, exclusive and rejects symlink reads', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'state.json');
  await writeSetupState(path, { status: 'pending' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const release = await lockSetupState(path);
  await assert.rejects(lockSetupState(path), /locked/u);
  await release();
  await symlink(path, join(directory, 'link'));
  await assert.rejects(readSetupFile(join(directory, 'link')), /file_invalid/u);
});

test('a dead lock requires review and is never unlinked by competing resumptions', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'state.json');
  const { hostname } = await import('node:os');
  await writeSetupState(`${path}.lock`, { pid: 2147483647, host: hostname(), token: uuid });
  const results = await Promise.allSettled([lockSetupState(path), lockSetupState(path)]);
  assert.ok(
    results.every(
      (result) =>
        result.status === 'rejected' &&
        result.reason.code === 'aws_setup_stale_lock_requires_review'
    )
  );
  assert.equal((await readSetupJson(`${path}.lock`)).token, uuid);
});

test('effective build pins include shared dist inputs rather than trusting source hashes alone', async (t) => {
  const directory = await temporary(t);
  const runtime = join(directory, 'packages/ar-runtime-aws/dist');
  const shared = join(directory, 'packages/shared/dist');
  await mkdir(runtime, { recursive: true });
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, 'index.js'), 'export const value = 1;');
  const outputs = {};
  for (const name of [
    'index',
    'restore-cli',
    'collector-cli',
    'lambda',
    'db-bootstrap',
    'synthetic-backup-cli',
    'browser-sp',
  ]) {
    outputs[`dist/${name}.mjs`] = {};
    await writeFile(join(runtime, `${name}.mjs`), 'export {};');
  }
  await writeFile(
    join(runtime, 'metafile.json'),
    JSON.stringify({ inputs: { '../shared/dist/index.js': {} }, outputs })
  );
  const before = await readExecutionBuildPins(directory);
  await writeFile(join(shared, 'index.js'), 'export const value = 2;');
  const after = await readExecutionBuildPins(directory);
  assert.equal(before.inputs[0].path, 'packages/shared/dist/index.js');
  assert.notEqual(before.inputs[0].sha256, after.inputs[0].sha256);
  assert.deepEqual(before.outputs, after.outputs);
});

test('principal verification checks account, exact role ARN and role unique ID', async () => {
  const expected = { principalArn: `arn:aws:iam::${account}:role/path/operator` };
  const responses = {
    identity: {
      Account: account,
      Arn: `arn:aws:sts::${account}:assumed-role/operator/session`,
      UserId: 'AROATEST:session',
    },
    role: { Role: { Arn: expected.principalArn, RoleId: 'AROATEST' } },
  };
  const aws = async (service) => (service === 'sts' ? responses.identity : responses.role);
  await assertSetupIdentity(aws, expected, { accountId: account });
  responses.identity.UserId = 'AROAFORGED:session';
  await assert.rejects(
    assertSetupIdentity(aws, expected, { accountId: account }),
    /principal_mismatch/u
  );
});

const body =
  'AWSTemplateFormatVersion: "2010-09-09"\nResources:\n  Function:\n    Type: AWS::Lambda::Function\nOutputs:\n  FunctionArn:\n    Value: example\n';
const addition = {
  Type: 'Resource',
  ResourceChange: {
    LogicalResourceId: 'Function',
    ResourceType: 'AWS::Lambda::Function',
    Action: 'Add',
  },
};
test('change review rejects resource deletion, replacement and unknown resources', () => {
  validateSetupChanges([addition], body);
  for (const patch of [
    { Action: 'Remove' },
    { Action: 'Modify', Replacement: 'True' },
    { Action: 'Modify', Replacement: 'Conditional' },
    { LogicalResourceId: 'Other' },
  ])
    assert.throws(
      () =>
        validateSetupChanges(
          [{ ...addition, ResourceChange: { ...addition.ResourceChange, ...patch } }],
          body
        ),
      /destructive_or_unknown_change/u
    );
});

test('lost create response adopts the same change set; failed stacks never auto rollback', async () => {
  const state = { operationId: uuid, stages: {} };
  let change;
  let stack;
  let createCount = 0;
  let executeCount = 0;
  const aws = async (_service, action, input) => {
    if (action === 'describe-stacks') {
      if (!stack) throw new AwsSetupError('aws_setup_not_found');
      return { Stacks: [stack] };
    }
    if (action === 'describe-change-set') {
      if (!change) throw new AwsSetupError('aws_setup_not_found');
      return change;
    }
    if (action === 'create-change-set') {
      createCount += 1;
      stack = { StackId: 'stack-id', StackStatus: 'REVIEW_IN_PROGRESS' };
      change = {
        ...input,
        StackId: 'stack-id',
        ChangeSetId: 'change-id',
        Status: 'CREATE_COMPLETE',
        ExecutionStatus: 'AVAILABLE',
        Changes: [addition],
      };
      throw new AwsSetupError('aws_setup_request_failed', { ambiguous: true });
    }
    if (action === 'get-template') return { TemplateBody: body };
    if (action === 'validate-template') return {};
    if (action === 'execute-change-set') {
      executeCount += 1;
      change.ExecutionStatus = 'EXECUTE_COMPLETE';
      stack.StackStatus = 'CREATE_FAILED';
      return {};
    }
    throw new Error(`unexpected ${action}`);
  };
  const run = () =>
    executeSetupStack({
      aws,
      state,
      stage: 'workload',
      save: async () => {},
      spec: { name: 'example-workload', disposition: 'create' },
      body,
      parameters: {},
    });
  await assert.rejects(run(), /request_failed/u);
  assert.equal((await run()).status, 'inProgress');
  await assert.rejects(run(), /stack_failed_requires_review/u);
  assert.equal(createCount, 1);
  assert.equal(executeCount, 1);
});

test('S3 upload recovers lost response only with exact size/checksum and a version', async (t) => {
  const path = join(await temporary(t), 'artifact.zip');
  await writeFile(path, 'pinned');
  const sha256 = setupDigest('pinned');
  let heads = 0;
  const aws = async (_service, action) => {
    if (action === 'put-object')
      throw new AwsSetupError('aws_setup_request_failed', { ambiguous: true });
    heads += 1;
    return {
      ContentLength: 6,
      ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
      VersionId: 'version-1',
    };
  };
  const receipt = await uploadExecutionObject({
    aws,
    bucket: 'assets',
    owner: account,
    prefix: 'run/',
    path,
    expectedSha256: sha256,
  });
  assert.equal(heads, 1);
  assert.equal(receipt.versionId, 'version-1');
  await assert.rejects(
    uploadExecutionObject({
      aws,
      bucket: 'assets',
      owner: account,
      prefix: 'run/',
      path,
      expectedSha256: hash,
    }),
    /artifact_changed/u
  );
});

function evidence(origin, restoreId) {
  return {
    formatVersion: 1,
    restoreId,
    activatedAtMs: 1000,
    coreTargetId: uuid,
    piiTargetId: uuid.replace(/^1/u, '2'),
    coreReceiptSha256: hash,
    piiReceiptSha256: hash,
    stateReceiptSha256: hash,
    configurationSha256: hash,
    tenantId: 'tenant-a',
    issuer: origin,
    bundleId: 'a'.repeat(32),
    snapshotId: 'snapshot',
    inventoryDigestSha256: hash,
    boundaryUnixMs: 900,
    backupReceiptSha256: hash,
    supplementFileSha256: hash,
    maxSnapshotAgeMs: 3600000,
  };
}
test('lost restore response resumes with inspection, never a second restore', async (t) => {
  const directory = await temporary(t);
  const calls = [];
  const expected = { initializationId: uuid, restoreId: uuid, origin: 'https://id.example.test' };
  const state = { stages: {} };
  const artifact = { sha256: hash };
  const aws = async (_service, action, _input, files) => {
    if (action === 'get-function-configuration')
      return {
        FunctionArn: 'function',
        State: 'Active',
        LastUpdateStatus: 'Successful',
        CodeSha256: Buffer.from(hash, 'hex').toString('base64'),
        Environment: { Variables: {} },
      };
    const event = JSON.parse(await readFile(files.payload));
    calls.push(event.action);
    if (event.action === 'restore')
      throw new AwsSetupError('aws_setup_request_failed', { ambiguous: true });
    await writeFile(
      files.response,
      JSON.stringify({
        status: 'verified',
        evidence: evidence(expected.origin, uuid),
        runtimeSecretVersionId: uuid,
        readinessStatus: 200,
        coldReloadVerified: true,
        rowCounts,
      })
    );
    return { StatusCode: 200 };
  };
  const run = () =>
    executeSetupMaintenance({
      aws,
      state,
      stage: 'restore',
      save: async () => {},
      directory,
      functionArn: 'function',
      configuration: {},
      artifact,
      expected,
    });
  await assert.rejects(run(), /request_failed/u);
  assert.equal((await run()).status, 'verified');
  assert.deepEqual(calls, ['restore', 'inspect-restore']);
  assert.equal(state.stages.restore.recoveredByInspection, true);
});

test('actual fixed stage pipeline runs via fake AWS CLI argv and resumes without duplicate writes', async (t) => {
  const directory = await temporary(t);
  const cfg = config(directory);
  const templates = {};
  for (const [id, file] of Object.entries(EXECUTION_TEMPLATES)) {
    const bytes = await readFile(join(root, 'packages/ar-runtime-aws/deploy', file));
    templates[id] = { file, sha256: setupDigest(bytes), bytes: bytes.length };
  }
  const plan = { config: cfg, templates };
  const statePath = join(directory, 'state.json');
  const stacks = new Map();
  const changes = new Map();
  const objects = new Map();
  const calls = [];
  const origin = `https://abcdefghij.execute-api.${region}.amazonaws.com`;
  const role = (name) => `arn:aws:iam::${account}:role/authrim-dr/${name}`;
  const secret = (name) => `arn:aws:secretsmanager:${region}:${account}:secret:${name}-abcdef`;
  const outputValues = {
    bootstrap: {
      OperatorRoleArn: cfg.identities.operator.principalArn,
      FoundationCfnServiceRoleArn: role('foundation'),
      WorkloadCfnServiceRoleArn: role('workload'),
      RuntimePermissionsBoundaryArn: role('boundary'),
    },
    foundation: {
      AssetsBucketName: 'example-assets',
      VpcId: 'vpc-123',
      PrivateSubnetIds: 'subnet-a,subnet-b',
      BootstrapSecurityGroupId: 'sg-123',
      DatabaseEndpointAddress: `example.${region}.rds.amazonaws.com`,
      DatabaseMasterSecretArn: secret('master'),
    },
    access: {
      BrowserCfnServiceRoleArn: role('browser'),
      DbBootstrapCfnServiceRoleArn: role('job'),
      BrowserIdpPermissionsBoundaryArn: role('idp-boundary'),
      BrowserSpPermissionsBoundaryArn: role('sp-boundary'),
      DbBootstrapPermissionsBoundaryArn: role('job-boundary'),
      BrowserInputSecretArn: secret('input'),
      BrowserSpSecretArn: secret('sp'),
    },
    database: {
      JobFunctionArn: `arn:aws:lambda:${region}:${account}:function:job`,
      RuntimeSecretArn: secret('runtime'),
      InitializationId: uuid,
    },
    workload: {
      ApiId: 'abcdefghij',
      IssuerOrigin: origin,
      TestSpUrl: `${origin}/test-sp/start`,
      IdpFunctionArn: `arn:aws:lambda:${region}:${account}:function:idp`,
      SpFunctionArn: `arn:aws:lambda:${region}:${account}:function:sp`,
    },
  };
  const lookup = (name) =>
    [...stacks.values()].find((stack) => [stack.StackName, stack.StackId].includes(name));
  const runProcess = async (_binary, args, options) => {
    const [service, action] = args;
    const input = JSON.parse(args[args.indexOf('--cli-input-json') + 1]);
    const profile = args[args.indexOf('--profile') + 1];
    calls.push({ service, action, input });
    assert.equal(options.shell, false);
    assert.equal(options.env.AWS_MAX_ATTEMPTS, '1');
    const okay = (value) => ({ exitCode: 0, stdout: JSON.stringify(value) });
    const missing = () => ({ exitCode: 1, stderr: 'ResourceNotFound does not exist' });
    if (service === 'sts')
      return okay(
        profile === 'bootstrap'
          ? { Account: account, Arn: cfg.identities.bootstrap.principalArn }
          : {
              Account: account,
              Arn: `arn:aws:sts::${account}:assumed-role/example-bootstrap-operator/session`,
              UserId: 'AROATEST:session',
            }
      );
    if (service === 'iam')
      return okay({ Role: { Arn: cfg.identities.operator.principalArn, RoleId: 'AROATEST' } });
    if (action === 'describe-stacks') {
      const stack = lookup(input.StackName);
      return stack ? okay({ Stacks: [stack] }) : missing();
    }
    if (action === 'describe-change-set') {
      const change =
        changes.get(input.ChangeSetName) ??
        [...changes.values()].find((x) => x.ChangeSetId === input.ChangeSetName);
      return change ? okay(change) : missing();
    }
    if (action === 'create-change-set') {
      const name = lookup(input.StackName)?.StackName ?? input.StackName;
      const kind = name.replace('example-', '');
      const stack = lookup(name) ?? {
        StackName: name,
        StackId: `arn:aws:cloudformation:${region}:${account}:stack/${name}/${uuid}`,
        StackStatus: 'REVIEW_IN_PROGRESS',
      };
      stacks.set(name, stack);
      const change = {
        ...input,
        StackId: stack.StackId,
        ChangeSetId: `change-${changes.size}`,
        Status: 'CREATE_COMPLETE',
        ExecutionStatus: 'AVAILABLE',
        Changes: [],
        kind,
      };
      changes.set(input.ChangeSetName, change);
      return okay({ Id: change.ChangeSetId, StackId: stack.StackId });
    }
    if (action === 'get-template')
      return okay({
        TemplateBody: input.ChangeSetName
          ? [...changes.values()].find((x) => x.ChangeSetId === input.ChangeSetName).TemplateBody
          : lookup(input.StackName).TemplateBody,
      });
    if (action === 'execute-change-set') {
      const change = [...changes.values()].find((x) => x.ChangeSetId === input.ChangeSetName);
      change.ExecutionStatus = 'EXECUTE_COMPLETE';
      Object.assign(lookup(input.StackName), {
        StackStatus: 'UPDATE_COMPLETE',
        Parameters: change.Parameters,
        RoleARN: change.RoleARN,
        TemplateBody: change.TemplateBody,
        Outputs: Object.entries(outputValues[change.kind]).map(([OutputKey, OutputValue]) => ({
          OutputKey,
          OutputValue,
        })),
      });
      return okay({});
    }
    if (action === 'get-bucket-versioning') return okay({ Status: 'Enabled' });
    if (action === 'validate-template') return okay({});
    if (action === 'put-object') {
      const result = { VersionId: `version-${objects.size}`, ChecksumSHA256: input.ChecksumSHA256 };
      objects.set(input.Key, result);
      return okay(result);
    }
    if (action === 'put-secret-value') {
      const content = await readFile(args[args.indexOf('--secret-string') + 1].slice(7), 'utf8');
      assert.match(content, /fixture-secret/u);
      return okay({ ARN: input.SecretId, VersionId: input.ClientRequestToken });
    }
    if (action === 'get-function-configuration') {
      const state = await readSetupJson(statePath);
      const name = input.FunctionName.split(':').at(-1);
      const artifact = state.stages.upload.receipt.artifacts[name === 'job' ? 'job' : name];
      const p = Object.fromEntries(
        lookup('example-database').Parameters.map((x) => [x.ParameterKey, x.ParameterValue])
      );
      const env = Object.fromEntries(
        Object.entries({
          DB_HOST: 'DatabaseHost',
          DB_PORT: 'DatabasePort',
          MASTER_SECRET_ARN: 'MasterSecretArn',
          JOB_CONFIG_SECRET_ARN: 'JobConfigSecretArn',
          JOB_CONFIG_SECRET_VERSION_ID: 'JobConfigSecretVersionId',
          INITIALIZATION_ID: 'InitializationId',
          DATABASE_PREFIX: 'DatabasePrefix',
          ASSETS_BUCKET: 'AssetsBucketName',
          BUCKET_OWNER: 'BucketOwnerAccountId',
          ASSET_PREFIX: 'AssetPrefix',
          FIXTURE_KEY: 'FixtureKey',
          FIXTURE_VERSION_ID: 'FixtureVersionId',
          FIXTURE_SHA256: 'FixtureSha256',
          BROWSER_SP_SECRET_ARN: 'BrowserSpSecretArn',
        }).map(([key, value]) => [`AUTHRIM_AWS_${key}`, p[value]])
      );
      env.AUTHRIM_AWS_RUNTIME_SECRET_ARN = secret('runtime');
      env.NODE_EXTRA_CA_CERTS = '/var/task/certs/rds-ca.pem';
      return okay({
        FunctionArn: input.FunctionName,
        State: 'Active',
        LastUpdateStatus: 'Successful',
        CodeSha256: Buffer.from(artifact.sha256, 'hex').toString('base64'),
        Environment: { Variables: env },
      });
    }
    if (action === 'invoke') {
      const state = await readSetupJson(statePath);
      const event = JSON.parse(await readFile(args[args.indexOf('--payload') + 1].slice(8)));
      const fixture = await readSetupJson(join(cfg.fixture.directory, 'fixture.json'));
      const activated = {
        ...evidence(origin, uuid),
        backupReceiptSha256: setupDigest(canonicalSetupJson(fixture.backup.receipt)),
        supplementFileSha256: fixture.supplement.sha256,
      };
      const receipt =
        event.action === 'initialize'
          ? {
              status: 'initialized',
              initializationId: state.initializationId,
              runtimeSecretVersionId: state.initializationId,
            }
          : event.action === 'prepare-browser-sp'
            ? {
                status: 'browser-sp-prepared',
                browserSpSecretVersionId: state.initializationId,
                origin,
                certificateDerSha256: hash,
              }
            : {
                status: event.action === 'restore' ? 'restored' : 'verified',
                runtimeSecretVersionId: state.initializationId,
                readinessStatus: 200,
                coldReloadVerified: true,
                evidence: activated,
                rowCounts,
              };
      await writeFile(args.at(-1), JSON.stringify(receipt));
      return okay({ StatusCode: 200 });
    }
    throw new Error(`unexpected ${service}/${action}`);
  };
  const prepare = async () => {
    await mkdir(cfg.fixture.directory);
    const part = Buffer.from('ciphertext');
    const supplement = Buffer.from('supplement');
    await writeFile(join(cfg.fixture.directory, 'part.bin'), part);
    await writeFile(join(cfg.fixture.directory, 'supplement.json'), supplement);
    const descriptor = {
      formatVersion: 1,
      manifest: { source: { tenantId: 'tenant-a', issuer: origin } },
      backup: {
        receipt: {},
        maxSnapshotAgeMs: 3600000,
        parts: [{ path: 'part.bin', sha256: setupDigest(part), size: part.length }],
      },
      supplement: {
        path: 'supplement.json',
        sha256: setupDigest(supplement),
        size: supplement.length,
      },
      restoreId: uuid,
      core: { targetId: uuid },
      pii: { targetId: uuid.replace(/^1/u, '2') },
      environmentName: 'aws-browser-rehearsal',
      spEntityIds: [`${origin}/test-sp/metadata`],
      allocationScope: 'shared_pool',
    };
    await writeFile(join(cfg.fixture.directory, 'fixture.json'), canonicalSetupJson(descriptor));
    await writeFile(
      join(cfg.fixture.directory, 'summary.json'),
      JSON.stringify({ syntheticOnly: true, issuer: origin, signingCertificateDerSha256: hash })
    );
    await writeFile(
      join(cfg.fixture.directory, 'secrets.json'),
      JSON.stringify({
        backupPassphrase: 'fixture-secret',
        awsFlowRuntimeHmacSecret: 'fixture-secret',
        awsLookupReadKeys: [],
      }),
      { mode: 0o600 }
    );
    const artifacts = {};
    for (const name of ['job', 'idp', 'sp']) {
      const path = join(directory, `${name}.zip`);
      await writeFile(path, name);
      artifacts[name] = { path, sha256: setupDigest(name), size: name.length };
    }
    return { fixtureSha256: setupDigest(canonicalSetupJson(descriptor)), artifacts };
  };
  const dependencies = {
    verifyPlan: async () => {},
    createAws: (target) => createAwsSetupCli(target, { runProcess }),
    prepare,
  };
  let result = await executeAwsSetup(
    { mode: 'apply', plan, planSha256: hash, statePath, root },
    dependencies
  );
  for (let attempt = 0; result.status === 'inProgress' && attempt < 30; attempt += 1)
    result = await executeAwsSetup(
      { mode: 'resume', plan, planSha256: hash, statePath, root },
      dependencies
    );
  assert.equal(result.status, 'complete');
  assert.equal(result.deploymentStatus, 'configured');
  assert.equal(result.browserLoginVerified, false);
  assert.equal(result.trafficSwitched, false);
  const state = await readSetupJson(statePath);
  assert.equal(state.status, 'complete');
  const before = calls.filter((call) =>
    [
      'create-change-set',
      'execute-change-set',
      'invoke',
      'put-object',
      'put-secret-value',
    ].includes(call.action)
  ).length;
  await executeAwsSetup({ mode: 'resume', plan, planSha256: hash, statePath, root }, dependencies);
  assert.equal(
    calls.filter((call) =>
      [
        'create-change-set',
        'execute-change-set',
        'invoke',
        'put-object',
        'put-secret-value',
      ].includes(call.action)
    ).length,
    before
  );
  assert.equal(calls.filter((call) => call.action === 'invoke').length, 4);
  assert.equal(calls.filter((call) => call.action === 'create-change-set').length, 7);
  assert.ok(!JSON.stringify(state).includes('fixture-secret'));
  const manifest = await readFile(`${statePath}.assets/runtime-manifest.json`, 'utf8');
  assert.equal(manifest, canonicalSetupJson(JSON.parse(manifest)));
  assert.ok(
    calls.every(
      (call) => !/delete|rollback|route53|cloudflare/u.test(`${call.service}/${call.action}`)
    )
  );
});
