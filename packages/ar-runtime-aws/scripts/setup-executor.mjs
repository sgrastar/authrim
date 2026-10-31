import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AwsSetupError, createAwsSetupCli } from './setup-aws-cli.mjs';
import { assertSetupIdentity, executeSetupStack } from './setup-cloudformation.mjs';
import { normalizeSetupAuthState } from './setup-auth-state.mjs';
import { EXECUTION_STAGES, verifyExecutionPlan } from './setup-execution-plan.mjs';
import {
  canonicalSetupJson,
  lockSetupState,
  readSetupFile,
  readSetupJson,
  setupDigest,
  writeSetupState,
} from './setup-execution-state.mjs';
import {
  prepareExecutionArtifacts,
  readExecutionFixture,
  uploadExecutionArtifacts,
  uploadExecutionManifest,
} from './setup-artifacts.mjs';

const fail = (code) => {
  throw new AwsSetupError(`aws_setup_${code}`);
};
const countKeys = [
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
];
const evidenceKeys = [
  'formatVersion',
  'restoreId',
  'activatedAtMs',
  'coreTargetId',
  'piiTargetId',
  'coreReceiptSha256',
  'piiReceiptSha256',
  'stateReceiptSha256',
  'configurationSha256',
  'tenantId',
  'issuer',
  'bundleId',
  'snapshotId',
  'inventoryDigestSha256',
  'boundaryUnixMs',
  'backupReceiptSha256',
  'supplementFileSha256',
  'maxSnapshotAgeMs',
];

export function maintenanceReceipt(value, action, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('maintenance_response_invalid');
  const allowedStatuses = {
    initialize: 'initialized',
    restore: 'restored',
    verify: 'verified',
    'inspect-restore': 'verified',
    'prepare-browser-sp': 'browser-sp-prepared',
  };
  if (value.status !== allowedStatuses[action]) fail('maintenance_response_invalid');
  let receipt;
  if (action === 'initialize') {
    if (
      value.initializationId !== expected.initializationId ||
      value.runtimeSecretVersionId !== expected.initializationId
    )
      fail('maintenance_initialization_mismatch');
    receipt = {
      status: value.status,
      initializationId: value.initializationId,
      runtimeSecretVersionId: value.runtimeSecretVersionId,
    };
  } else if (action === 'prepare-browser-sp') {
    if (
      value.browserSpSecretVersionId !== expected.initializationId ||
      value.origin !== expected.origin ||
      !/^[a-f0-9]{64}$/u.test(value.certificateDerSha256 ?? '')
    )
      fail('maintenance_secret_version_mismatch');
    receipt = {
      status: value.status,
      browserSpSecretVersionId: value.browserSpSecretVersionId,
      origin: value.origin,
      certificateDerSha256: value.certificateDerSha256,
    };
  } else {
    const evidence = value.evidence;
    if (
      !evidence ||
      Object.keys(evidence).sort().join() !== [...evidenceKeys].sort().join() ||
      evidence.formatVersion !== 1 ||
      evidence.restoreId !== expected.restoreId ||
      evidence.issuer !== expected.origin ||
      value.runtimeSecretVersionId !== expected.initializationId ||
      value.readinessStatus !== 200 ||
      value.coldReloadVerified !== true
    )
      fail('maintenance_evidence_mismatch');
    for (const [key, item] of Object.entries(evidence)) {
      if (key.endsWith('Sha256') && !/^[a-f0-9]{64}$/u.test(item))
        fail('maintenance_evidence_mismatch');
      if (
        !['string', 'number'].includes(typeof item) ||
        (typeof item === 'string' && item.length > 2048)
      )
        fail('maintenance_evidence_mismatch');
    }
    for (const key of [
      'backupReceiptSha256',
      'supplementFileSha256',
      'coreTargetId',
      'piiTargetId',
      'maxSnapshotAgeMs',
    ])
      if (expected[key] !== undefined && evidence[key] !== expected[key])
        fail('maintenance_source_mismatch');
    if (
      !value.rowCounts ||
      Object.keys(value.rowCounts).sort().join() !== [...countKeys].sort().join() ||
      Object.values(value.rowCounts).some((count) => !Number.isSafeInteger(count) || count < 0)
    )
      fail('maintenance_counts_invalid');
    receipt = {
      status: value.status,
      evidence: value.evidence,
      runtimeSecretVersionId: value.runtimeSecretVersionId,
      readinessStatus: 200,
      coldReloadVerified: true,
      rowCounts: value.rowCounts,
    };
  }
  return JSON.parse(canonicalSetupJson(receipt));
}

export async function executeSetupMaintenance({
  aws,
  state,
  stage,
  save,
  directory,
  functionArn,
  configuration,
  artifact,
  expected,
}) {
  const config = await aws('lambda', 'get-function-configuration', { FunctionName: functionArn });
  if (
    config.FunctionArn !== functionArn ||
    config.State !== 'Active' ||
    config.LastUpdateStatus !== 'Successful' ||
    config.CodeSha256 !== Buffer.from(artifact.sha256, 'hex').toString('base64')
  )
    fail('maintenance_function_changed');
  for (const [key, value] of Object.entries(configuration))
    if (config.Environment?.Variables?.[key] !== value) fail('maintenance_configuration_changed');
  const prior = state.stages[stage];
  if (prior?.status === 'complete') return prior.receipt;
  // Restore is not replay-safe. Any prior attempt, including a lost response, is inspection-only.
  const action =
    stage === 'restore' && prior
      ? 'inspect-restore'
      : stage === 'sp-prepare'
        ? 'prepare-browser-sp'
        : stage;
  const event = {
    action,
    ...(['verify', 'prepare-browser-sp'].includes(action)
      ? { evidence: state.stages.restore.receipt.evidence }
      : {}),
  };
  const inputHash = setupDigest(
    canonicalSetupJson({ functionArn, configuration, artifact, expected })
  );
  if (prior && prior.inputHash !== inputHash) fail('maintenance_inputs_changed');
  state.stages[stage] = { status: 'invoking', inputHash, action };
  await save();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const payload = join(directory, `${stage}.request.json`);
  const response = join(directory, `${stage}.response.json`);
  try {
    await writeSetupState(payload, event);
    await writeSetupState(response, {});
    const metadata = await aws(
      'lambda',
      'invoke',
      { FunctionName: functionArn, InvocationType: 'RequestResponse', LogType: 'None' },
      { payload, response }
    );
    if (metadata.StatusCode !== 200 || metadata.FunctionError)
      fail('maintenance_invocation_failed');
    const result = maintenanceReceipt(
      await readSetupJson(response, { privateFile: true }),
      action,
      expected
    );
    state.stages[stage] = {
      status: 'complete',
      inputHash,
      receipt: result,
      ...(action === 'inspect-restore' ? { recoveredByInspection: true } : {}),
    };
    await save();
    return result;
  } catch (error) {
    state.stages[stage].status = stage === 'restore' ? 'requiresInspection' : 'failed';
    state.stages[stage].code =
      error instanceof AwsSetupError ? error.code : 'aws_setup_maintenance_response_invalid';
    await save();
    throw error instanceof AwsSetupError
      ? error
      : new AwsSetupError('aws_setup_maintenance_response_invalid');
  } finally {
    for (const path of [payload, response])
      await unlink(path).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
}

/** Backend-specific execution; primary/secondary is intent and never changes traffic or writer authority. */
export async function executeAwsSetup(
  { mode, plan, planSha256, statePath, root, through = 'complete' },
  dependencies = {}
) {
  if (!['apply', 'resume'].includes(mode) || !EXECUTION_STAGES.includes(through))
    fail('arguments_invalid');
  await (dependencies.verifyPlan ?? verifyExecutionPlan)(plan, planSha256, root);
  const unlock = await lockSetupState(statePath);
  try {
    let state;
    try {
      state = await readSetupJson(statePath, { privateFile: true });
    } catch (error) {
      if (error.code !== 'aws_setup_file_missing') throw error;
    }
    if ((mode === 'apply' && state) || (mode === 'resume' && !state)) fail('state_mode_mismatch');
    if (!state)
      state = {
        formatVersion: 1,
        operationId: randomUUID(),
        planSha256,
        target: plan.config.target,
        backend: 'aws',
        role: plan.config.role,
        initializationId: randomUUID(),
        inputVersion: randomUUID(),
        stages: {},
        status: 'inProgress',
      };
    if (
      state.formatVersion !== 1 ||
      state.planSha256 !== planSha256 ||
      canonicalSetupJson(state.target) !== canonicalSetupJson(plan.config.target)
    )
      fail('state_plan_mismatch');
    const save = () => writeSetupState(statePath, state);
    await save();
    const config = plan.config;
    const authentication = normalizeSetupAuthState(config.authState);
    const browser = config.mode === 'browser-rehearsal';
    const directory = `${resolve(statePath)}.assets`;
    const clients = new Map();
    async function client(name) {
      if (!clients.has(name)) {
        const identity = config.identities[name];
        const aws = (dependencies.createAws ?? createAwsSetupCli)({
          region: config.target.region,
          profile: identity.profile,
        });
        await assertSetupIdentity(aws, identity, config.target);
        clients.set(name, aws);
      }
      return clients.get(name);
    }
    const output = (stage, key) =>
      state.stages[stage]?.outputs?.[key] ?? fail(`output_missing_${stage}_${key}`);
    const foundation = (key) => output('foundation', key);
    const authStateParams = () =>
      authentication.backend === 'dynamodb'
        ? { AuthStateTableArn: foundation('AuthStateTableArn') }
        : {};
    const dynamoNetworkParams = () =>
      authentication.backend === 'dynamodb'
        ? { DynamoDbGatewayPrefixListId: foundation('DynamoDbGatewayPrefixListId') }
        : {};
    const boot = (key) => output('bootstrap', key);
    const access = (key) => output('access-bind', key);
    const origin = () =>
      browser ? output('endpoint', 'IssuerOrigin') : `https://${config.issuer.host}`;
    const asset = (name) => state.stages.upload.receipt.artifacts[name];
    const inputSecret = () =>
      browser ? output('access', 'BrowserInputSecretArn') : config.issuer.inputSecretArn;
    const inputVersion = () => (browser ? state.inputVersion : config.issuer.inputSecretVersionId);
    const network = () => ({
      PrivateSubnetIds: foundation('PrivateSubnetIds'),
      BootstrapSecurityGroupId: foundation('BootstrapSecurityGroupId'),
      DatabaseHost: foundation('DatabaseEndpointAddress'),
    });
    const bucketParams = () => ({
      AssetsBucketName: foundation('AssetsBucketName'),
      AssetPrefix: config.assets.prefix,
      BucketOwnerAccountId: config.target.accountId,
    });
    const bootstrapParams = () => ({
      ...(config.stacks.bootstrap.parameters ?? {}),
      FoundationStackName: config.stacks.foundation.name,
      WorkloadStackName: config.stacks.workload.name,
      DbBootstrapStackName: config.stacks.database.name,
    });
    const accessParams = (bound) => ({
      ...(config.stacks.access.parameters ?? {}),
      ...authStateParams(),
      BrowserStackName: config.stacks.workload.name,
      DbBootstrapStackName: config.stacks.database.name,
      OperatorRoleName: config.identities.operator.principalArn.split('/').at(-1),
      AssetsBucketName: foundation('AssetsBucketName'),
      AssetPrefix: config.assets.prefix,
      MasterSecretArn: foundation('DatabaseMasterSecretArn'),
      VpcId: foundation('VpcId'),
      PrivateSubnetIds: foundation('PrivateSubnetIds'),
      BootstrapSecurityGroupId: foundation('BootstrapSecurityGroupId'),
      ApiId: bound ? output('endpoint', 'ApiId') : '',
      InputSecretName:
        config.stacks.access.parameters?.InputSecretName ?? `${config.stacks.database.name}-input`,
      SpSecretName:
        config.stacks.access.parameters?.SpSecretName ?? `${config.stacks.workload.name}-sp`,
    });
    async function stack(stage, kind, parameters, identity, roleArn, previous) {
      const spec = config.stacks[kind];
      const templateId = kind === 'workload' && browser ? 'browser' : kind;
      const body = (
        await readSetupFile(
          join(root, 'packages/ar-runtime-aws/deploy', plan.templates[templateId].file),
          { maxBytes: 51_200 }
        )
      ).toString();
      if (setupDigest(body) !== plan.templates[templateId].sha256) fail('template_changed');
      return executeSetupStack({
        aws: await client(identity),
        state,
        stage,
        save,
        spec,
        body,
        parameters: { ...(previous ? state.stages[previous]?.parameters : {}), ...parameters },
        roleArn,
        allowUpdate: Boolean(previous),
        expectedStackId: previous ? state.stages[previous].stackId : undefined,
      });
    }
    async function run(stage) {
      if (stage === 'bootstrap') return stack(stage, 'bootstrap', bootstrapParams(), 'bootstrap');
      if (stage === 'foundation')
        return stack(
          stage,
          'foundation',
          {
            ...(config.stacks.foundation.parameters ?? {}),
            ...(config.authState === undefined ? {} : { AuthStateBackend: authentication.backend }),
          },
          'operator',
          boot('FoundationCfnServiceRoleArn')
        );
      if (stage === 'access') {
        if (browser) return stack(stage, 'access', accessParams(false), 'bootstrap');
        return stack(
          stage,
          'bootstrap',
          {
            ...bootstrapParams(),
            DbBootstrapAssetsBucketName: foundation('AssetsBucketName'),
            DbBootstrapAssetPrefix: config.assets.prefix,
            DbBootstrapMasterSecretArn: foundation('DatabaseMasterSecretArn'),
            DbBootstrapJobConfigSecretArn: inputSecret(),
            DbBootstrapVpcId: foundation('VpcId'),
            DbBootstrapSubnetIds: foundation('PrivateSubnetIds'),
            DbBootstrapSecurityGroupId: foundation('BootstrapSecurityGroupId'),
            ...authStateParams(),
          },
          'bootstrap',
          undefined,
          'bootstrap'
        );
      }
      if (stage === 'endpoint')
        return browser
          ? stack(
              stage,
              'workload',
              { ...network(), ...bucketParams(), DeployWorkload: 'false' },
              'operator',
              output('access', 'BrowserCfnServiceRoleArn')
            )
          : { skipped: true };
      if (stage === 'access-bind')
        return browser
          ? stack(stage, 'access', accessParams(true), 'bootstrap', undefined, 'access')
          : { skipped: true };
      if (stage === 'prepare')
        return {
          receipt: await (dependencies.prepare ?? prepareExecutionArtifacts)({
            config,
            root,
            directory,
            origin: origin(),
            state,
            save,
            build: plan.build,
          }),
        };
      if (stage === 'upload')
        return {
          receipt: await uploadExecutionArtifacts({
            aws: await client('operator'),
            config,
            state,
            save,
            directory,
            bucket: foundation('AssetsBucketName'),
            origin: origin(),
            inputSecretArn: inputSecret(),
          }),
        };
      if (stage === 'database') {
        const pin = state.stages.upload.receipt.fixture;
        return stack(
          stage,
          'database',
          {
            ...network(),
            ...bucketParams(),
            DatabasePort: '5432',
            DatabasePrefix: config.databasePrefix,
            InitializationId: state.initializationId,
            MasterSecretArn: foundation('DatabaseMasterSecretArn'),
            JobConfigSecretArn: inputSecret(),
            JobConfigSecretVersionId: inputVersion(),
            ...authStateParams(),
            BrowserSpSecretArn: browser ? output('access', 'BrowserSpSecretArn') : '',
            JobPermissionsBoundaryArn: browser
              ? access('DbBootstrapPermissionsBoundaryArn')
              : output('access', 'DbBootstrapPermissionsBoundaryArn'),
            ArtifactKey: asset('job').key,
            ArtifactObjectVersion: asset('job').versionId,
            FixtureKey: pin.key,
            FixtureVersionId: pin.versionId,
            FixtureSha256: pin.sha256,
          },
          'operator',
          browser
            ? access('DbBootstrapCfnServiceRoleArn')
            : output('access', 'DbBootstrapCfnServiceRoleArn')
        );
      }
      if (['initialize', 'restore', 'verify', 'sp-prepare'].includes(stage)) {
        if (stage === 'sp-prepare' && !browser) return { skipped: true };
        const fixture = await readExecutionFixture(
          config.fixture.directory,
          state.stages.prepare.receipt.fixtureSha256
        );
        const pin = state.stages.upload.receipt.fixture;
        const configuration = {
          AUTHRIM_AWS_DB_HOST: foundation('DatabaseEndpointAddress'),
          AUTHRIM_AWS_DB_PORT: '5432',
          AUTHRIM_AWS_MASTER_SECRET_ARN: foundation('DatabaseMasterSecretArn'),
          AUTHRIM_AWS_JOB_CONFIG_SECRET_ARN: inputSecret(),
          AUTHRIM_AWS_JOB_CONFIG_SECRET_VERSION_ID: inputVersion(),
          AUTHRIM_AWS_RUNTIME_SECRET_ARN: output('database', 'RuntimeSecretArn'),
          AUTHRIM_AWS_INITIALIZATION_ID: state.initializationId,
          AUTHRIM_AWS_DATABASE_PREFIX: config.databasePrefix,
          AUTHRIM_AWS_ASSETS_BUCKET: foundation('AssetsBucketName'),
          AUTHRIM_AWS_BUCKET_OWNER: config.target.accountId,
          AUTHRIM_AWS_ASSET_PREFIX: config.assets.prefix,
          AUTHRIM_AWS_FIXTURE_KEY: pin.key,
          AUTHRIM_AWS_FIXTURE_VERSION_ID: pin.versionId,
          AUTHRIM_AWS_FIXTURE_SHA256: pin.sha256,
          NODE_EXTRA_CA_CERTS: '/var/task/certs/rds-ca.pem',
          ...(browser
            ? { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: output('access', 'BrowserSpSecretArn') }
            : {}),
        };
        return {
          receipt: await executeSetupMaintenance({
            aws: await client('operator'),
            state,
            stage,
            save,
            directory,
            functionArn: output('database', 'JobFunctionArn'),
            configuration,
            artifact: asset('job'),
            expected: {
              initializationId: state.initializationId,
              restoreId: fixture.descriptor.restoreId,
              origin: origin(),
              backupReceiptSha256: setupDigest(
                canonicalSetupJson(fixture.descriptor.backup.receipt)
              ),
              supplementFileSha256: fixture.descriptor.supplement.sha256,
              coreTargetId: fixture.descriptor.core.targetId,
              piiTargetId: fixture.descriptor.pii.targetId,
              maxSnapshotAgeMs: fixture.descriptor.backup.maxSnapshotAgeMs,
            },
          }),
        };
      }
      if (stage === 'manifest')
        return {
          receipt: await uploadExecutionManifest({
            aws: await client('operator'),
            config,
            state,
            directory,
            bucket: foundation('AssetsBucketName'),
          }),
        };
      if (stage === 'runtime-bind')
        return browser
          ? { skipped: true }
          : stack(
              stage,
              'bootstrap',
              {
                ...bootstrapParams(),
                AssetsBucketName: foundation('AssetsBucketName'),
                AssetObjectPrefix: config.assets.prefix,
                RuntimeSecretArn: output('database', 'RuntimeSecretArn'),
                FoundationVpcId: foundation('VpcId'),
                DatabaseSecurityGroupId: foundation('DatabaseSecurityGroupId'),
                SecretsEndpointSecurityGroupId: foundation('SecretsEndpointSecurityGroupId'),
                HttpApiId: foundation('HttpApiId'),
                IssuerHost: config.issuer.host,
                ...authStateParams(),
              },
              'bootstrap',
              undefined,
              'access'
            );
      if (stage === 'workload') {
        const manifest = state.stages.manifest.receipt;
        const common = {
          ...(config.stacks.workload.parameters ?? {}),
          ...authStateParams(),
          RuntimeSecretArn: output('database', 'RuntimeSecretArn'),
          RuntimeSecretVersionId: state.initializationId,
          ManifestKey: manifest.key,
          ManifestVersionId: manifest.versionId,
          ManifestSha256: manifest.sha256,
          BucketOwnerAccountId: config.target.accountId,
        };
        if (browser)
          return stack(
            stage,
            'workload',
            {
              ...network(),
              ...bucketParams(),
              ...common,
              DeployWorkload: 'true',
              BrowserSpSecretArn: output('access', 'BrowserSpSecretArn'),
              BrowserSpSecretVersionId: state.initializationId,
              IdpPermissionsBoundaryArn: access('BrowserIdpPermissionsBoundaryArn'),
              SpPermissionsBoundaryArn: access('BrowserSpPermissionsBoundaryArn'),
              IdpArtifactKey: asset('idp').key,
              IdpArtifactObjectVersion: asset('idp').versionId,
              SpArtifactKey: asset('sp').key,
              SpArtifactObjectVersion: asset('sp').versionId,
            },
            'operator',
            access('BrowserCfnServiceRoleArn'),
            'endpoint'
          );
        return stack(
          stage,
          'workload',
          {
            ...common,
            IssuerHost: config.issuer.host,
            CertificateArn: config.issuer.certificateArn,
            HttpApiId: foundation('HttpApiId'),
            VpcId: foundation('VpcId'),
            PrivateSubnetIds: foundation('PrivateSubnetIds'),
            DatabaseSecurityGroupId: foundation('DatabaseSecurityGroupId'),
            DatabasePort: '5432',
            SecretsEndpointSecurityGroupId: foundation('SecretsEndpointSecurityGroupId'),
            S3GatewayPrefixListId: foundation('S3GatewayPrefixListId'),
            ...dynamoNetworkParams(),
            RuntimePermissionsBoundaryArn: output('runtime-bind', 'RuntimePermissionsBoundaryArn'),
            ManifestBucket: foundation('AssetsBucketName'),
            BackupObjectPrefix: config.assets.prefix,
            ArtifactBucket: foundation('AssetsBucketName'),
            ArtifactKey: asset('idp').key,
            ArtifactObjectVersion: asset('idp').versionId,
          },
          'operator',
          output('runtime-bind', 'WorkloadCfnServiceRoleArn')
        );
      }
      if (stage === 'complete') {
        const aws = await client('operator');
        for (const [key, name] of browser
          ? [
              ['IdpFunctionArn', 'idp'],
              ['SpFunctionArn', 'sp'],
            ]
          : [['LambdaFunctionArn', 'idp']]) {
          const result = await aws('lambda', 'get-function-configuration', {
            FunctionName: output('workload', key),
          });
          if (
            result.FunctionArn !== output('workload', key) ||
            result.State !== 'Active' ||
            result.LastUpdateStatus !== 'Successful' ||
            result.CodeSha256 !== Buffer.from(asset(name).sha256, 'hex').toString('base64')
          )
            fail('serving_function_changed');
        }
        return {
          receipt: {
            deploymentStatus: 'configured',
            mode: config.mode,
            origin: origin(),
            ...(browser ? { testSpUrl: `${origin()}/test-sp/start` } : {}),
            databaseReadinessVerified: true,
            browserLoginVerified: false,
            trafficSwitched: false,
            writerAuthorityChanged: false,
          },
        };
      }
      fail('stage_unknown');
    }
    for (const stage of EXECUTION_STAGES.slice(0, EXECUTION_STAGES.indexOf(through) + 1)) {
      if (state.stages[stage]?.status === 'complete') continue;
      state.currentStage = stage;
      state.status = 'inProgress';
      await save();
      dependencies.progress?.({ stage, status: 'running' });
      try {
        const result = await run(stage);
        if (result.status === 'inProgress')
          return { status: 'inProgress', stage, operationId: state.operationId };
        state.stages[stage] = { ...state.stages[stage], ...result, status: 'complete' };
        await save();
      } catch (error) {
        state.status = 'blocked';
        state.code = error instanceof AwsSetupError ? error.code : 'aws_setup_execution_failed';
        await save();
        throw error instanceof AwsSetupError
          ? error
          : new AwsSetupError('aws_setup_execution_failed');
      }
    }
    state.status = through === 'complete' ? 'complete' : 'inProgress';
    delete state.code;
    await save();
    return {
      status: state.status,
      stage: through,
      operationId: state.operationId,
      ...(state.stages.complete?.receipt ?? {}),
    };
  } finally {
    await unlock();
  }
}
