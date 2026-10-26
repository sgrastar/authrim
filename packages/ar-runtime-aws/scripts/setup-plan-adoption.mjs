/** Explicit, read-only reconciliation after a reviewed source update before initialization. */
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AwsSetupError, createAwsSetupCli } from './setup-aws-cli.mjs';
import { readExecutionFixture } from './setup-artifacts.mjs';
import { assertSetupIdentity } from './setup-cloudformation.mjs';
import { EXECUTION_STAGES, verifyExecutionPlan } from './setup-execution-plan.mjs';
import {
  canonicalSetupJson,
  lockSetupState,
  readSetupFile,
  readSetupJson,
  setupDigest,
} from './setup-execution-state.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const COMPLETED = EXECUTION_STAGES.slice(0, EXECUTION_STAGES.indexOf('initialize'));
const fail = (code) => {
  throw new AwsSetupError(`aws_setup_adoption_${code}`);
};
const same = (left, right) => canonicalSetupJson(left) === canonicalSetupJson(right);
function requireHash(value, expected, code) {
  if (!HASH.test(expected ?? '') || setupDigest(value) !== expected) fail(code);
}
function record(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('state_invalid');
  return value;
}
function pairs(values, key, value) {
  if (!Array.isArray(values)) fail('resource_changed');
  const output = {};
  for (const item of values) {
    if (
      typeof item[key] !== 'string' ||
      typeof item[value] !== 'string' ||
      Object.hasOwn(output, item[key])
    )
      fail('resource_changed');
    output[item[key]] = item[value];
  }
  return output;
}
async function requireAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  fail('destination_exists');
}
async function syncParent(path) {
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function writeExclusive(path, bytes) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
    await syncParent(path);
  } catch (error) {
    await unlink(path);
    throw error;
  } finally {
    await file.close();
  }
}

async function publishState(path, bytes, published) {
  const temporary = `${path}.${randomUUID()}.pending`;
  await writeExclusive(temporary, bytes);
  try {
    // link atomically publishes the complete private file and never replaces a target.
    await link(temporary, path);
    published();
    await syncParent(path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** No approval inference: all three immutable inputs need independently reviewed digests. */
export function validatePlanAdoption({
  previousPlan,
  previousPlanSha256,
  state,
  plan,
  planSha256,
}) {
  requireHash(canonicalSetupJson(previousPlan), previousPlanSha256, 'previous_plan_digest');
  requireHash(canonicalSetupJson(plan), planSha256, 'plan_digest');
  if (
    previousPlan.formatVersion !== 2 ||
    plan.formatVersion !== 2 ||
    !HASH.test(previousPlan.sourceSha256 ?? '') ||
    !HASH.test(plan.sourceSha256 ?? '') ||
    previousPlan.sourceSha256 === plan.sourceSha256 ||
    !same({ ...previousPlan, sourceSha256: plan.sourceSha256 }, plan)
  )
    fail('deployment_inputs_changed');
  if (
    plan.config?.mode !== 'browser-rehearsal' ||
    state.formatVersion !== 1 ||
    state.backend !== 'aws' ||
    state.role !== plan.config.role ||
    state.planSha256 !== previousPlanSha256 ||
    !same(state.target, plan.config.target) ||
    state.status !== 'blocked' ||
    state.currentStage !== 'initialize' ||
    ![state.operationId, state.initializationId, state.inputVersion].every((v) => UUID.test(v)) ||
    state.inputSeeded !== true ||
    state.fixtureGenerationStarted !== true
  )
    fail('state_unsupported');
  const stages = record(state.stages);
  if (
    Object.keys(stages).sort().join() !== [...COMPLETED, 'initialize'].sort().join() ||
    COMPLETED.some((stage) => stages[stage]?.status !== 'complete') ||
    stages.initialize?.status !== 'failed' ||
    stages.initialize.action !== 'initialize' ||
    !HASH.test(stages.initialize.inputHash ?? '') ||
    Object.hasOwn(stages.initialize, 'receipt')
  )
    fail('state_unsupported');
  return state;
}

async function reconcileStacks({ aws, plan, state }) {
  const config = plan.config;
  const stages = state.stages;
  const definitions = [
    ['bootstrap', 'bootstrap', 'bootstrap', undefined],
    [
      'foundation',
      'foundation',
      'foundation',
      stages.bootstrap.outputs.FoundationCfnServiceRoleArn,
    ],
    ['access-bind', 'access', 'access', undefined],
    ['endpoint', 'workload', 'browser', stages['access-bind'].outputs.BrowserCfnServiceRoleArn],
    [
      'database',
      'database',
      'database',
      stages['access-bind'].outputs.DbBootstrapCfnServiceRoleArn,
    ],
  ];
  const ids = [];
  for (const [stage, kind, template, expectedRole] of definitions) {
    const saved = stages[stage];
    const spec = config.stacks[kind];
    const prefix = `arn:aws:cloudformation:${config.target.region}:${config.target.accountId}:stack/${spec.name}/`;
    if (typeof saved.stackId !== 'string' || !saved.stackId.startsWith(prefix))
      fail('stack_identity');
    if (spec.disposition === 'reuse' && saved.stackId !== spec.stackId) fail('stack_identity');
    const response = await aws('cloudformation', 'describe-stacks', { StackName: saved.stackId });
    const stack = response.Stacks?.[0];
    if (
      response.Stacks?.length !== 1 ||
      stack.StackId !== saved.stackId ||
      stack.StackName !== spec.name ||
      !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus) ||
      (stack.RoleARN ?? null) !== (expectedRole ?? null) ||
      !same(pairs(stack.Parameters ?? [], 'ParameterKey', 'ParameterValue'), saved.parameters) ||
      !same(pairs(stack.Outputs ?? [], 'OutputKey', 'OutputValue'), saved.outputs)
    )
      fail('stack_changed');
    const deployed = await aws('cloudformation', 'get-template', {
      StackName: saved.stackId,
      TemplateStage: 'Original',
    });
    if (typeof deployed.TemplateBody !== 'string') fail('template_changed');
    requireHash(
      deployed.TemplateBody,
      spec.disposition === 'reuse' ? spec.templateSha256 : plan.templates[template].sha256,
      'template_changed'
    );
    ids.push(saved.stackId);
  }
  if (
    stages.access.stackId !== stages['access-bind'].stackId ||
    Object.entries(stages.access.outputs).some(
      ([key, value]) => key !== 'BoundApiId' && stages['access-bind'].outputs[key] !== value
    )
  )
    fail('stack_changed');
  return ids;
}

function objectPin(pin, prefix) {
  if (
    !pin ||
    !HASH.test(pin.sha256 ?? '') ||
    !Number.isSafeInteger(pin.size) ||
    pin.size < 1 ||
    typeof pin.versionId !== 'string' ||
    !pin.versionId ||
    pin.versionId === 'null' ||
    typeof pin.key !== 'string' ||
    !pin.key.startsWith(`${prefix}${pin.sha256}/`)
  )
    fail('object_invalid');
  return pin;
}

async function reconcileArtifacts({ aws, plan, state, previousStatePath }) {
  const config = plan.config;
  const prepared = record(state.stages.prepare.receipt);
  const uploaded = record(state.stages.upload.receipt);
  const fixture = await readExecutionFixture(config.fixture.directory, prepared.fixtureSha256);
  if (
    uploaded.fixtureSha256 !== fixture.sha256 ||
    fixture.descriptor.manifest?.source?.issuer !== state.stages.endpoint.outputs.IssuerOrigin ||
    Object.keys(prepared.artifacts ?? {})
      .sort()
      .join() !== 'idp,job,sp' ||
    Object.keys(uploaded.artifacts ?? {})
      .sort()
      .join() !== 'idp,job,sp'
  )
    fail('fixture_changed');
  for (const name of ['idp', 'job', 'sp']) {
    const local = prepared.artifacts[name];
    const pin = objectPin(uploaded.artifacts[name], config.assets.prefix);
    const bytes = await readSetupFile(local.path, { maxBytes: 64 * 1024 * 1024 });
    if (bytes.length !== local.size || local.size !== pin.size || local.sha256 !== pin.sha256)
      fail('artifact_changed');
    requireHash(bytes, pin.sha256, 'artifact_changed');
    if (!same(state.uploads?.[name], pin)) fail('object_invalid');
  }
  const cloudBytes = await readSetupFile(`${previousStatePath}.assets/cloud-fixture.json`, {
    privateFile: true,
  });
  requireHash(cloudBytes, uploaded.fixture.sha256, 'fixture_changed');
  const expectedUploads = [
    'idp',
    'job',
    'sp',
    'fixture',
    'supplement',
    ...fixture.descriptor.backup.parts.map((_part, index) => `part${index}`),
  ];
  if (
    Object.keys(state.uploads ?? {})
      .sort()
      .join() !== expectedUploads.sort().join()
  )
    fail('object_invalid');
  const cloud = JSON.parse(cloudBytes.toString('utf8'));
  const expectedCloud = {
    ...fixture.descriptor,
    backup: {
      ...fixture.descriptor.backup,
      parts: fixture.descriptor.backup.parts.map((part, index) => {
        const pin = objectPin(state.uploads[`part${index}`], config.assets.prefix);
        if (pin.sha256 !== part.sha256 || pin.size !== part.size) fail('fixture_changed');
        return pin;
      }),
    },
    supplement: objectPin(state.uploads.supplement, config.assets.prefix),
  };
  if (
    expectedCloud.supplement.sha256 !== fixture.descriptor.supplement.sha256 ||
    expectedCloud.supplement.size !== fixture.descriptor.supplement.size ||
    !same(cloud, expectedCloud) ||
    !same(state.uploads.fixture, uploaded.fixture)
  )
    fail('fixture_changed');
  const bucket = state.stages.foundation.outputs.AssetsBucketName;
  const versioning = await aws('s3api', 'get-bucket-versioning', {
    Bucket: bucket,
    ExpectedBucketOwner: config.target.accountId,
  });
  if (versioning.Status !== 'Enabled') fail('bucket_changed');
  for (const value of Object.values(state.uploads)) {
    const pin = objectPin(value, config.assets.prefix);
    const actual = await aws('s3api', 'head-object', {
      Bucket: bucket,
      Key: pin.key,
      VersionId: pin.versionId,
      ExpectedBucketOwner: config.target.accountId,
      ChecksumMode: 'ENABLED',
    });
    if (
      actual.VersionId !== pin.versionId ||
      actual.ContentLength !== pin.size ||
      actual.ChecksumSHA256 !== Buffer.from(pin.sha256, 'hex').toString('base64') ||
      actual.DeleteMarker === true
    )
      fail('object_changed');
  }
  return { fixture, cloudBytes };
}

async function reconcileJob({ aws, plan, state, fixture }) {
  const config = plan.config;
  const stages = state.stages;
  const foundation = stages.foundation.outputs;
  const database = stages.database;
  const pin = stages.upload.receipt.fixture;
  const configuration = {
    AUTHRIM_AWS_DB_HOST: foundation.DatabaseEndpointAddress,
    AUTHRIM_AWS_DB_PORT: '5432',
    AUTHRIM_AWS_MASTER_SECRET_ARN: foundation.DatabaseMasterSecretArn,
    AUTHRIM_AWS_JOB_CONFIG_SECRET_ARN: stages.access.outputs.BrowserInputSecretArn,
    AUTHRIM_AWS_JOB_CONFIG_SECRET_VERSION_ID: state.inputVersion,
    AUTHRIM_AWS_RUNTIME_SECRET_ARN: database.outputs.RuntimeSecretArn,
    AUTHRIM_AWS_INITIALIZATION_ID: state.initializationId,
    AUTHRIM_AWS_DATABASE_PREFIX: config.databasePrefix,
    AUTHRIM_AWS_ASSETS_BUCKET: foundation.AssetsBucketName,
    AUTHRIM_AWS_BUCKET_OWNER: config.target.accountId,
    AUTHRIM_AWS_ASSET_PREFIX: config.assets.prefix,
    AUTHRIM_AWS_FIXTURE_KEY: pin.key,
    AUTHRIM_AWS_FIXTURE_VERSION_ID: pin.versionId,
    AUTHRIM_AWS_FIXTURE_SHA256: pin.sha256,
    NODE_EXTRA_CA_CERTS: '/var/task/certs/rds-ca.pem',
    AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: stages.access.outputs.BrowserSpSecretArn,
  };
  const functionArn = database.outputs.JobFunctionArn;
  const fn = await aws('lambda', 'get-function-configuration', { FunctionName: functionArn });
  const resources = await aws('cloudformation', 'list-stack-resources', {
    StackName: database.stackId,
  });
  if (resources.NextToken || !Array.isArray(resources.StackResourceSummaries))
    fail('job_resources_changed');
  const roles = resources.StackResourceSummaries.filter(
    (item) => item.LogicalResourceId === 'JobRole' && item.ResourceType === 'AWS::IAM::Role'
  );
  const functions = resources.StackResourceSummaries.filter(
    (item) =>
      item.LogicalResourceId === 'JobFunction' && item.ResourceType === 'AWS::Lambda::Function'
  );
  if (roles.length !== 1 || functions.length !== 1) fail('job_resources_changed');
  const role = await aws('iam', 'get-role', { RoleName: roles[0].PhysicalResourceId });
  if (
    fn.FunctionArn !== functionArn ||
    fn.FunctionName !== functions[0].PhysicalResourceId ||
    fn.State !== 'Active' ||
    fn.LastUpdateStatus !== 'Successful' ||
    fn.CodeSha256 !==
      Buffer.from(stages.upload.receipt.artifacts.job.sha256, 'hex').toString('base64') ||
    !role.Role?.Arn ||
    fn.Role !== role.Role.Arn ||
    role.Role.PermissionsBoundary?.PermissionsBoundaryArn !==
      database.parameters.JobPermissionsBoundaryArn ||
    (fn.Layers ?? []).length !== 0 ||
    fn.Handler !== 'db-bootstrap.handler' ||
    fn.Runtime !== 'nodejs24.x' ||
    !same(fn.Architectures, ['arm64']) ||
    !same(fn.Environment?.Variables, configuration) ||
    !same(
      [...(fn.VpcConfig?.SubnetIds ?? [])].sort(),
      database.parameters.PrivateSubnetIds.split(',').sort()
    ) ||
    !same(fn.VpcConfig?.SecurityGroupIds, [database.parameters.BootstrapSecurityGroupId]) ||
    fn.VpcConfig?.VpcId !== foundation.VpcId ||
    fn.Timeout !== 900 ||
    fn.MemorySize !== 2048 ||
    fn.EphemeralStorage?.Size !== 1024 ||
    fn.LoggingConfig?.LogGroup !== database.outputs.JobLogGroupName
  )
    fail('job_changed');
  const expected = {
    initializationId: state.initializationId,
    restoreId: fixture.descriptor.restoreId,
    origin: stages.endpoint.outputs.IssuerOrigin,
    backupReceiptSha256: setupDigest(canonicalSetupJson(fixture.descriptor.backup.receipt)),
    supplementFileSha256: fixture.descriptor.supplement.sha256,
    coreTargetId: fixture.descriptor.core.targetId,
    piiTargetId: fixture.descriptor.pii.targetId,
    maxSnapshotAgeMs: fixture.descriptor.backup.maxSnapshotAgeMs,
  };
  requireHash(
    canonicalSetupJson({
      functionArn,
      configuration,
      artifact: stages.upload.receipt.artifacts.job,
      expected,
    }),
    stages.initialize.inputHash,
    'initialize_inputs_changed'
  );
  const secret = await aws('secretsmanager', 'describe-secret', {
    SecretId: configuration.AUTHRIM_AWS_JOB_CONFIG_SECRET_ARN,
  });
  if (
    secret.ARN !== configuration.AUTHRIM_AWS_JOB_CONFIG_SECRET_ARN ||
    secret.DeletedDate ||
    !Object.hasOwn(secret.VersionIdsToStages ?? {}, state.inputVersion)
  )
    fail('input_secret_changed');
  return functionArn;
}

export async function adoptExecutionPlan(options, dependencies = {}) {
  const {
    root,
    previousPlanPath,
    previousPlanSha256,
    previousStatePath,
    previousStateSha256,
    planPath,
    planSha256,
    statePath,
  } = options;
  const destination = resolve(statePath);
  const oldStatePath = resolve(previousStatePath);
  const successorMarker = `${oldStatePath}.adoption.json`;
  await requireAbsent(destination);
  await requireAbsent(`${destination}.assets`);
  const unlock = await lockSetupState(oldStatePath);
  let unlockDestination;
  try {
    unlockDestination = await lockSetupState(destination);
    await requireAbsent(destination);
    await requireAbsent(`${destination}.assets`);
    await requireAbsent(successorMarker);
    const previousPlan = await readSetupJson(previousPlanPath);
    const plan = await readSetupJson(planPath);
    const stateBytes = await readSetupFile(oldStatePath, { privateFile: true });
    requireHash(stateBytes, previousStateSha256, 'previous_state_digest');
    const state = JSON.parse(stateBytes.toString('utf8'));
    validatePlanAdoption({ previousPlan, previousPlanSha256, state, plan, planSha256 });
    await (dependencies.verifyPlan ?? verifyExecutionPlan)(plan, planSha256, root);
    const clients = {};
    for (const name of ['bootstrap', 'operator']) {
      const identity = plan.config.identities[name];
      clients[name] = (dependencies.createAws ?? createAwsSetupCli)({
        region: plan.config.target.region,
        profile: identity.profile,
      });
      await assertSetupIdentity(clients[name], identity, plan.config.target);
    }
    // The already reviewed bootstrap identity can inspect all created resources;
    // no permission changes or fallback identities are introduced by adoption.
    const aws = clients.bootstrap;
    const stackIds = await reconcileStacks({ aws, plan, state });
    const { fixture, cloudBytes } = await reconcileArtifacts({
      aws,
      plan,
      state,
      previousStatePath: oldStatePath,
    });
    const functionArn = await reconcileJob({ aws, plan, state, fixture });
    requireHash(
      await readSetupFile(oldStatePath, { privateFile: true }),
      previousStateSha256,
      'previous_state_changed'
    );
    const adoption = {
      formatVersion: 1,
      previousPlanSha256,
      previousStateSha256,
      previousStatePath: oldStatePath,
      planSha256,
      adoptedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      scope: 'reviewed-source-update-before-initialize',
      verifiedStackIds: stackIds,
      verifiedJobFunctionArn: functionArn,
      ...(state.planAdoption ? { previousAdoption: state.planAdoption } : {}),
    };
    const next = { ...state, planSha256, status: 'inProgress', planAdoption: adoption };
    delete next.code;
    // Retain the immutable cloud fixture used by the later manifest stage. Artifact
    // paths and every operation, initialization, request and version ID stay unchanged.
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const copiedFixture = join(`${destination}.assets`, 'cloud-fixture.json');
    // One predecessor may have only one successor. A process crash leaves this
    // reservation for inspection instead of permitting competing restore operations.
    await writeExclusive(
      successorMarker,
      `${canonicalSetupJson({
        formatVersion: 1,
        previousPlanSha256,
        previousStateSha256,
        planSha256,
        statePath: destination,
        operationId: state.operationId,
      })}\n`
    );
    let createdDirectory = false;
    let copied = false;
    let published = false;
    try {
      await mkdir(`${destination}.assets`, { mode: 0o700 });
      createdDirectory = true;
      await writeExclusive(copiedFixture, cloudBytes);
      copied = true;
      await publishState(destination, `${canonicalSetupJson(next)}\n`, () => {
        published = true;
      });
    } catch (error) {
      // These files belong to this adoption attempt; never touch the predecessor
      // or an existing destination. Incomplete publication is safe to retry.
      // Once publication succeeds, an uncertain directory-sync outcome must keep
      // both the state and reservation for inspection, never enable another adoption.
      if (!published) {
        if (copied) await unlink(copiedFixture);
        if (createdDirectory) await rmdir(`${destination}.assets`);
        await unlink(successorMarker);
      }
      throw error;
    }
    return {
      status: 'adopted',
      planSha256,
      previousPlanSha256,
      previousStateSha256,
      operationId: state.operationId,
      statePath: destination,
      nextStage: 'initialize',
    };
  } finally {
    try {
      await unlockDestination?.();
    } finally {
      await unlock();
    }
  }
}
