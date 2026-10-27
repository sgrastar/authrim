import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { adoptExecutionPlan } from './setup-plan-adoption.mjs';
import { executeAwsSetup } from './setup-executor.mjs';
import { EXECUTION_STAGES } from './setup-execution-plan.mjs';
import { canonicalSetupJson, setupDigest } from './setup-execution-state.mjs';
import { normalizeSetupUi } from './setup-ui-config.mjs';

const account = '123456789012';
const region = 'ap-northeast-1';
const uuid = '11111111-1111-4111-8111-111111111111';
const iam = (name) => `arn:aws:iam::${account}:role/${name}`;
const origin = 'https://abcdefghij.execute-api.ap-northeast-1.amazonaws.com';
const sha = (value) => setupDigest(canonicalSetupJson(value));
const pairs = (values, key, value) =>
  Object.entries(values).map(([k, v]) => ({ [key]: k, [value]: v }));

async function fixture(t, { withUi = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'authrim-plan-adoption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousStatePath = join(root, 'previous-state.json');
  const fixtureDir = join(root, 'fixture');
  await mkdir(fixtureDir);
  await mkdir(`${previousStatePath}.assets`);
  const config = {
    formatVersion: 1,
    backend: 'aws',
    role: 'secondary',
    mode: 'browser-rehearsal',
    target: { accountId: account, region },
    identities: {
      bootstrap: { profile: 'bootstrap', principalArn: `arn:aws:iam::${account}:user/operator` },
      operator: {
        profile: 'operator',
        principalArn: iam('authrim-dr/operator/example-bootstrap-operator'),
      },
    },
    stacks: Object.fromEntries(
      ['bootstrap', 'foundation', 'access', 'database', 'workload'].map((key) => [
        key,
        { name: `example-${key}`, disposition: 'create', parameters: {} },
      ])
    ),
    assets: { prefix: 'synthetic/', caBundlePath: join(root, 'ca.pem') },
    fixture: { directory: fixtureDir, generate: true },
    databasePrefix: 'authrim_dr_browser',
  };
  if (withUi) {
    // A plan that selects the destination UI: the upload writes it into the cloud fixture too.
    config.components = { loginUi: false, adminUi: false };
    config.ui = { login: { mode: 'disabled' }, admin: { mode: 'disabled' } };
  }
  config.stacks.bootstrap.parameters = {
    OperatorPrincipalArn: config.identities.bootstrap.principalArn,
    OperatorPrincipalMode: 'iam-user',
  };
  const templates = Object.fromEntries(
    ['bootstrap', 'foundation', 'access', 'database', 'browser', 'workload'].map((kind) => [
      kind,
      { file: `${kind}.yaml`, sha256: setupDigest(`template-${kind}`), bytes: 20 },
    ])
  );
  const stages = {
    bootstrap: {
      outputs: {
        FoundationCfnServiceRoleArn: iam('foundation-cfn'),
        OperatorRoleArn: config.identities.operator.principalArn,
      },
    },
    foundation: {
      outputs: {
        AssetsBucketName: 'example-assets',
        DatabaseEndpointAddress: 'db.example.test',
        DatabaseMasterSecretArn: 'master-secret',
        VpcId: 'vpc-example',
      },
    },
    access: {
      outputs: {
        BoundApiId: '',
        BrowserInputSecretArn: 'input-secret',
        BrowserSpSecretArn: 'sp-secret',
        BrowserCfnServiceRoleArn: iam('browser-cfn'),
        DbBootstrapCfnServiceRoleArn: iam('database-cfn'),
      },
    },
    endpoint: { outputs: { IssuerOrigin: origin, ApiId: 'abcdefghij' } },
    database: {
      outputs: {
        JobFunctionArn: `arn:aws:lambda:${region}:${account}:function:example-database-job`,
        RuntimeSecretArn: 'runtime-secret',
        JobLogGroupName: '/authrim/job',
        InitializationId: uuid,
      },
      parameters: {
        PrivateSubnetIds: 'subnet-a,subnet-b',
        BootstrapSecurityGroupId: 'sg-example',
        JobPermissionsBoundaryArn: `arn:aws:iam::${account}:policy/job-boundary`,
      },
    },
  };
  stages['access-bind'] = structuredClone(stages.access);
  stages['access-bind'].outputs.BoundApiId = 'abcdefghij';
  const stackMap = new Map();
  for (const [stage, kind, template, role] of [
    ['bootstrap', 'bootstrap', 'bootstrap', undefined],
    ['foundation', 'foundation', 'foundation', iam('foundation-cfn')],
    ['access-bind', 'access', 'access', undefined],
    ['endpoint', 'workload', 'browser', iam('browser-cfn')],
    ['database', 'database', 'database', iam('database-cfn')],
  ]) {
    const saved = stages[stage];
    saved.stackId = `arn:aws:cloudformation:${region}:${account}:stack/example-${kind}/${uuid}`;
    saved.status = 'complete';
    saved.parameters ??= {};
    saved.inputHash = setupDigest(stage);
    stackMap.set(saved.stackId, {
      StackId: saved.stackId,
      StackName: `example-${kind}`,
      StackStatus: 'CREATE_COMPLETE',
      ...(role ? { RoleARN: role } : {}),
      Parameters: pairs(saved.parameters, 'ParameterKey', 'ParameterValue'),
      Outputs: pairs(saved.outputs, 'OutputKey', 'OutputValue'),
      template: `template-${template}`,
    });
  }
  stages.access = {
    ...structuredClone(stages['access-bind']),
    outputs: { ...stages['access-bind'].outputs, BoundApiId: '' },
  };
  // Reuse must follow the deployed hash even when a local description has changed.
  const deployedFoundation = stackMap.get(stages.foundation.stackId);
  deployedFoundation.template = 'deployed-foundation-question-mark';
  config.stacks.foundation = {
    ...config.stacks.foundation,
    disposition: 'reuse',
    stackId: stages.foundation.stackId,
    templateSha256: setupDigest(deployedFoundation.template),
  };
  const uploads = {};
  const contents = new Map();
  async function localPin(name, content, directory = fixtureDir) {
    const bytes = Buffer.from(content);
    const pin = { path: name, sha256: setupDigest(bytes), size: bytes.length };
    await writeFile(join(directory, name), bytes, { mode: 0o600 });
    return pin;
  }
  function uploadedPin(id, pin, name) {
    const value = {
      key: `${config.assets.prefix}${pin.sha256}/${name}`,
      versionId: `version-${id}`,
      sha256: pin.sha256,
      size: pin.size,
    };
    uploads[id] = value;
    contents.set(value.key, value);
    return value;
  }
  const part = await localPin('backup.bin', 'encrypted-synthetic-fixture');
  const supplement = await localPin('supplement.json', '{"syntheticOnly":true}');
  uploadedPin('part0', part, part.path);
  uploadedPin('supplement', supplement, supplement.path);
  const descriptor = {
    formatVersion: 1,
    manifest: { source: { issuer: origin } },
    backup: { parts: [part], receipt: { syntheticOnly: true }, maxSnapshotAgeMs: 3600000 },
    supplement,
    restoreId: uuid,
    core: { targetId: uuid },
    pii: { targetId: uuid },
    environmentName: 'test',
    spEntityIds: [`${origin}/test-sp/metadata`],
    allocationScope: 'synthetic',
  };
  const fixtureBytes = `${canonicalSetupJson(descriptor)}\n`;
  await writeFile(join(fixtureDir, 'fixture.json'), fixtureBytes, { mode: 0o600 });
  const cloud = {
    ...descriptor,
    backup: { ...descriptor.backup, parts: [uploads.part0] },
    supplement: uploads.supplement,
    ...(withUi
      ? { destinationUi: normalizeSetupUi(config.components, config.ui, config.mode) }
      : {}),
  };
  const cloudBytes = `${canonicalSetupJson(cloud)}\n`;
  await writeFile(`${previousStatePath}.assets/cloud-fixture.json`, cloudBytes, { mode: 0o600 });
  uploadedPin(
    'fixture',
    { sha256: setupDigest(cloudBytes), size: Buffer.byteLength(cloudBytes) },
    'cloud-fixture.json'
  );
  const artifacts = {};
  for (const name of ['idp', 'job', 'sp']) {
    const pin = await localPin(`${name}.zip`, `immutable-${name}-artifact`, root);
    artifacts[name] = { ...pin, path: join(root, pin.path) };
    uploadedPin(name, pin, `${name}.zip`);
  }
  stages.prepare = {
    status: 'complete',
    receipt: { fixtureSha256: setupDigest(fixtureBytes), artifacts },
  };
  stages.upload = {
    status: 'complete',
    receipt: {
      fixtureSha256: setupDigest(fixtureBytes),
      fixture: uploads.fixture,
      artifacts: Object.fromEntries(['idp', 'job', 'sp'].map((n) => [n, uploads[n]])),
    },
  };
  const environment = {
    AUTHRIM_AWS_DB_HOST: 'db.example.test',
    AUTHRIM_AWS_DB_PORT: '5432',
    AUTHRIM_AWS_MASTER_SECRET_ARN: 'master-secret',
    AUTHRIM_AWS_JOB_CONFIG_SECRET_ARN: 'input-secret',
    AUTHRIM_AWS_JOB_CONFIG_SECRET_VERSION_ID: uuid,
    AUTHRIM_AWS_RUNTIME_SECRET_ARN: 'runtime-secret',
    AUTHRIM_AWS_INITIALIZATION_ID: uuid,
    AUTHRIM_AWS_DATABASE_PREFIX: 'authrim_dr_browser',
    AUTHRIM_AWS_ASSETS_BUCKET: 'example-assets',
    AUTHRIM_AWS_BUCKET_OWNER: account,
    AUTHRIM_AWS_ASSET_PREFIX: 'synthetic/',
    AUTHRIM_AWS_FIXTURE_KEY: uploads.fixture.key,
    AUTHRIM_AWS_FIXTURE_VERSION_ID: uploads.fixture.versionId,
    AUTHRIM_AWS_FIXTURE_SHA256: uploads.fixture.sha256,
    NODE_EXTRA_CA_CERTS: '/var/task/certs/rds-ca.pem',
    AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: 'sp-secret',
  };
  const expected = {
    initializationId: uuid,
    restoreId: uuid,
    origin,
    backupReceiptSha256: sha(descriptor.backup.receipt),
    supplementFileSha256: supplement.sha256,
    coreTargetId: uuid,
    piiTargetId: uuid,
    maxSnapshotAgeMs: 3600000,
  };
  stages.initialize = {
    status: 'failed',
    action: 'initialize',
    code: 'aws_setup_request_failed',
    inputHash: sha({
      functionArn: stages.database.outputs.JobFunctionArn,
      configuration: environment,
      artifact: uploads.job,
      expected,
    }),
  };
  const previousPlan = {
    formatVersion: 2,
    config,
    sourceRoot: root,
    templates,
    sourceSha256: 'a'.repeat(64),
    build: { outputs: { job: 'immutable' } },
    caSha256: 'c'.repeat(64),
    stages: EXECUTION_STAGES,
  };
  const plan = structuredClone(previousPlan);
  plan.sourceSha256 = 'b'.repeat(64);
  const state = {
    formatVersion: 1,
    backend: 'aws',
    role: 'secondary',
    target: config.target,
    planSha256: sha(previousPlan),
    operationId: uuid,
    initializationId: uuid,
    inputVersion: uuid,
    status: 'blocked',
    currentStage: 'initialize',
    code: 'aws_setup_request_failed',
    inputSeeded: true,
    fixtureGenerationStarted: true,
    stages,
    uploads,
  };
  const options = {
    root,
    previousPlanPath: join(root, 'previous-plan.json'),
    previousPlanSha256: sha(previousPlan),
    previousStatePath,
    previousStateSha256: '',
    planPath: join(root, 'plan.json'),
    planSha256: sha(plan),
    statePath: join(root, 'next-state.json'),
  };
  async function save() {
    options.previousPlanSha256 = sha(previousPlan);
    options.planSha256 = sha(plan);
    state.planSha256 = options.previousPlanSha256;
    const bytes = `${canonicalSetupJson(state)}\n`;
    options.previousStateSha256 = setupDigest(bytes);
    for (const [path, bytes] of [
      [options.previousPlanPath, canonicalSetupJson(previousPlan)],
      [options.planPath, canonicalSetupJson(plan)],
      [previousStatePath, `${canonicalSetupJson(state)}\n`],
    ])
      await writeFile(path, bytes, { mode: 0o600 });
  }
  await save();
  const functionConfig = {
    FunctionArn: stages.database.outputs.JobFunctionArn,
    FunctionName: 'example-database-job',
    State: 'Active',
    LastUpdateStatus: 'Successful',
    CodeSha256: Buffer.from(uploads.job.sha256, 'hex').toString('base64'),
    Role: iam('job-role'),
    Handler: 'db-bootstrap.handler',
    Runtime: 'nodejs24.x',
    Architectures: ['arm64'],
    Environment: { Variables: environment },
    VpcConfig: {
      VpcId: 'vpc-example',
      SubnetIds: ['subnet-b', 'subnet-a'],
      SecurityGroupIds: ['sg-example'],
    },
    Timeout: 900,
    MemorySize: 2048,
    EphemeralStorage: { Size: 1024 },
    LoggingConfig: { LogGroup: '/authrim/job' },
  };
  const calls = [];
  let intercept;
  const dependencies = {
    verifyPlan: async (value, expectedHash) => {
      assert.equal(sha(value), expectedHash);
      assert.deepEqual(value, plan);
    },
    now: () => new Date('2026-10-26T00:00:00Z'),
    createAws:
      ({ profile }) =>
      async (service, action, input, files) => {
        calls.push({ service, action, input });
        const override = await intercept?.(service, action, input);
        if (override !== undefined) return override;
        if (action === 'get-caller-identity')
          return profile === 'bootstrap'
            ? { Account: account, Arn: config.identities.bootstrap.principalArn }
            : {
                Account: account,
                Arn: `arn:aws:sts::${account}:assumed-role/example-bootstrap-operator/session`,
                UserId: 'AROATEST:session',
              };
        if (action === 'get-role')
          return {
            Role:
              input.RoleName === 'job-role'
                ? {
                    Arn: iam('job-role'),
                    RoleId: 'AROA_JOB',
                    PermissionsBoundary: {
                      PermissionsBoundaryArn: `arn:aws:iam::${account}:policy/job-boundary`,
                    },
                  }
                : { Arn: config.identities.operator.principalArn, RoleId: 'AROATEST' },
          };
        if (action === 'describe-stacks')
          return { Stacks: [structuredClone(stackMap.get(input.StackName))] };
        if (action === 'get-template')
          return { TemplateBody: stackMap.get(input.StackName).template };
        if (action === 'get-bucket-versioning') return { Status: 'Enabled' };
        if (action === 'head-object') {
          const pin = contents.get(input.Key);
          assert.equal(input.VersionId, pin.versionId);
          return {
            ContentLength: pin.size,
            VersionId: pin.versionId,
            ChecksumSHA256: Buffer.from(pin.sha256, 'hex').toString('base64'),
          };
        }
        if (action === 'get-function-configuration') return structuredClone(functionConfig);
        if (action === 'list-stack-resources')
          return {
            StackResourceSummaries: [
              {
                LogicalResourceId: 'JobRole',
                ResourceType: 'AWS::IAM::Role',
                PhysicalResourceId: 'job-role',
              },
              {
                LogicalResourceId: 'JobFunction',
                ResourceType: 'AWS::Lambda::Function',
                PhysicalResourceId: 'example-database-job',
              },
            ],
          };
        if (action === 'describe-secret')
          return { ARN: 'input-secret', VersionIdsToStages: { [uuid]: ['AWSCURRENT'] } };
        if (action === 'invoke') {
          const payload = JSON.parse(await readFile(files.payload, 'utf8'));
          assert.deepEqual(payload, { action: 'initialize' });
          await writeFile(
            files.response,
            JSON.stringify({
              status: 'initialized',
              initializationId: uuid,
              runtimeSecretVersionId: uuid,
            })
          );
          return { StatusCode: 200 };
        }
        throw new Error(`unexpected API ${service}/${action}`);
      },
  };
  return {
    options,
    dependencies,
    calls,
    state,
    previousPlan,
    plan,
    save,
    stackMap,
    functionConfig,
    intercept: (fn) => {
      intercept = fn;
    },
  };
}

test('explicit adoption preserves old evidence and resumes initialize without recreating resources', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.options.previousStatePath);
  const result = await adoptExecutionPlan(f.options, f.dependencies);
  assert.equal(result.status, 'adopted');
  assert.equal(result.nextStage, 'initialize');
  assert.equal(
    f.calls.some((c) => /create|execute|invoke|put/iu.test(c.action)),
    false
  );
  const adopted = JSON.parse(await readFile(f.options.statePath));
  assert.equal(adopted.operationId, f.state.operationId);
  assert.equal(adopted.initializationId, f.state.initializationId);
  assert.equal(adopted.inputVersion, f.state.inputVersion);
  assert.deepEqual(adopted.stages, f.state.stages);
  assert.deepEqual(adopted.uploads, f.state.uploads);
  assert.equal(adopted.planAdoption.previousStateSha256, setupDigest(before));
  assert.equal(adopted.planAdoption.previousPlanSha256, f.options.previousPlanSha256);
  assert.equal((await stat(f.options.statePath)).mode & 0o777, 0o600);
  assert.deepEqual(
    await readFile(`${f.options.statePath}.assets/cloud-fixture.json`),
    await readFile(`${f.options.previousStatePath}.assets/cloud-fixture.json`)
  );
  const resumed = await executeAwsSetup(
    {
      mode: 'resume',
      plan: f.plan,
      planSha256: f.options.planSha256,
      statePath: f.options.statePath,
      root: f.options.root,
      through: 'initialize',
    },
    f.dependencies
  );
  assert.equal(resumed.status, 'inProgress');
  const after = JSON.parse(await readFile(f.options.statePath));
  assert.equal(after.stages.initialize.status, 'complete');
  assert.equal(f.calls.filter((c) => c.action === 'invoke').length, 1);
  assert.deepEqual(await readFile(f.options.previousStatePath), before);
});

test('adoption accepts the destination UI the upload wrote into the cloud fixture', async (t) => {
  const f = await fixture(t, { withUi: true });
  const result = await adoptExecutionPlan(f.options, f.dependencies);
  assert.equal(result.status, 'adopted');
  const cloud = JSON.parse(
    await readFile(`${f.options.previousStatePath}.assets/cloud-fixture.json`, 'utf8')
  );
  assert.deepEqual(Object.keys(cloud.destinationUi ?? {}).sort(), ['components', 'ui']);
});

test('adoption rejects changed deployment inputs and unreviewed digests before AWS calls', async (t) => {
  for (const [name, edit, error] of [
    [
      'config',
      (f) => {
        f.plan.config.role = 'primary';
      },
      /deployment_inputs_changed/u,
    ],
    [
      'build',
      (f) => {
        f.plan.build.outputs.job = 'changed';
      },
      /deployment_inputs_changed/u,
    ],
    [
      'template',
      (f) => {
        f.plan.templates.database.sha256 = 'd'.repeat(64);
      },
      /deployment_inputs_changed/u,
    ],
    [
      'CA',
      (f) => {
        f.plan.caSha256 = 'd'.repeat(64);
      },
      /deployment_inputs_changed/u,
    ],
    [
      'unknown plan field',
      (f) => {
        f.plan.unreviewed = true;
      },
      /deployment_inputs_changed/u,
    ],
    [
      'unchanged source',
      (f) => {
        f.plan.sourceSha256 = f.previousPlan.sourceSha256;
      },
      /deployment_inputs_changed/u,
    ],
    [
      'active state',
      (f) => {
        f.state.status = 'inProgress';
      },
      /state_unsupported/u,
    ],
    [
      'executing stage',
      (f) => {
        f.state.stages.database.status = 'executing';
      },
      /state_unsupported/u,
    ],
    [
      'later stage',
      (f) => {
        f.state.stages.restore = { status: 'failed' };
      },
      /state_unsupported/u,
    ],
  ])
    await t.test(name, async (t) => {
      const f = await fixture(t);
      edit(f);
      await f.save();
      await assert.rejects(adoptExecutionPlan(f.options, f.dependencies), error);
      assert.equal(f.calls.length, 0);
    });
  for (const key of ['previousPlanSha256', 'previousStateSha256', 'planSha256'])
    await t.test(key, async (t) => {
      const f = await fixture(t);
      f.options[key] = '0'.repeat(64);
      await assert.rejects(adoptExecutionPlan(f.options, f.dependencies), /digest/u);
      assert.equal(f.calls.length, 0);
    });
});

test('adoption fails closed on live resource drift and changed old evidence', async (t) => {
  const variants = [
    [
      'stack in progress',
      (f) => {
        f.stackMap.values().next().value.StackStatus = 'UPDATE_IN_PROGRESS';
      },
      /stack_changed/u,
    ],
    [
      'service role',
      (f) => {
        f.stackMap.get(f.state.stages.foundation.stackId).RoleARN = iam('other');
      },
      /stack_changed/u,
    ],
    [
      'template',
      (f) => {
        f.stackMap.values().next().value.template = 'changed';
      },
      /template_changed/u,
    ],
    [
      'stack parameters',
      (f) => {
        f.stackMap
          .values()
          .next()
          .value.Parameters.push({ ParameterKey: 'Extra', ParameterValue: 'value' });
      },
      /stack_changed/u,
    ],
    [
      'Lambda extra env',
      (f) => {
        f.functionConfig.Environment.Variables.UNREVIEWED = 'true';
      },
      /job_changed/u,
    ],
    [
      'Lambda role',
      (f) => {
        f.functionConfig.Role = iam('other');
      },
      /job_changed/u,
    ],
    [
      'Lambda code',
      (f) => {
        f.functionConfig.CodeSha256 = 'changed';
      },
      /job_changed/u,
    ],
    [
      'Lambda layer',
      (f) => {
        f.functionConfig.Layers = [{ Arn: 'unreviewed-layer' }];
      },
      /job_changed/u,
    ],
    [
      'job permission boundary',
      (f) =>
        f.intercept((_s, a, input) =>
          a === 'get-role' && input.RoleName === 'job-role'
            ? { Role: { Arn: iam('job-role') } }
            : undefined
        ),
      /job_changed/u,
    ],
    [
      'object version',
      (f) => f.intercept((_s, a) => (a === 'head-object' ? { VersionId: 'different' } : undefined)),
      /object_changed/u,
    ],
    [
      'secret version',
      (f) =>
        f.intercept((_s, a) =>
          a === 'describe-secret' ? { ARN: 'input-secret', VersionIdsToStages: {} } : undefined
        ),
      /input_secret_changed/u,
    ],
    [
      'state changed during reads',
      (f) =>
        f.intercept(async (_s, a) => {
          if (a === 'describe-secret') await writeFile(f.options.previousStatePath, 'changed');
        }),
      /previous_state_changed/u,
    ],
  ];
  for (const [name, edit, error] of variants)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      edit(f);
      await assert.rejects(adoptExecutionPlan(f.options, f.dependencies), error);
      await assert.rejects(stat(f.options.statePath), { code: 'ENOENT' });
      assert.equal(
        f.calls.some((c) => /create|execute|invoke|put/iu.test(c.action)),
        false
      );
    });
});

test('adoption does not overwrite existing state, assets or an active predecessor', async (t) => {
  for (const target of ['state', 'assets', 'lock'])
    await t.test(target, async (t) => {
      const f = await fixture(t);
      if (target === 'state') await writeFile(f.options.statePath, 'preserve');
      if (target === 'assets') await mkdir(`${f.options.statePath}.assets`);
      if (target === 'lock')
        await writeFile(`${f.options.previousStatePath}.lock`, 'occupied', { mode: 0o600 });
      await assert.rejects(adoptExecutionPlan(f.options, f.dependencies));
      assert.equal(f.calls.length, 0);
      if (target === 'state') assert.equal(await readFile(f.options.statePath, 'utf8'), 'preserve');
    });
});

test('one predecessor cannot produce competing successor states', async (t) => {
  const f = await fixture(t);
  await adoptExecutionPlan(f.options, f.dependencies);
  const marker = JSON.parse(await readFile(`${f.options.previousStatePath}.adoption.json`));
  assert.equal(marker.statePath, f.options.statePath);
  const calls = f.calls.length;
  await assert.rejects(
    adoptExecutionPlan(
      { ...f.options, statePath: join(f.options.root, 'competing-state.json') },
      f.dependencies
    ),
    /destination_exists/u
  );
  assert.equal(f.calls.length, calls);
});

test('failed exclusive publication preserves a competing target and cleans only its own reservation', async (t) => {
  const f = await fixture(t);
  f.intercept(async (_service, action) => {
    if (action === 'describe-secret') await writeFile(f.options.statePath, 'competing-writer');
  });
  const before = await readFile(f.options.previousStatePath);
  await assert.rejects(adoptExecutionPlan(f.options, f.dependencies), { code: 'EEXIST' });
  assert.equal(await readFile(f.options.statePath, 'utf8'), 'competing-writer');
  assert.deepEqual(await readFile(f.options.previousStatePath), before);
  await assert.rejects(stat(`${f.options.statePath}.assets`), { code: 'ENOENT' });
  await assert.rejects(stat(`${f.options.previousStatePath}.adoption.json`), { code: 'ENOENT' });
});
