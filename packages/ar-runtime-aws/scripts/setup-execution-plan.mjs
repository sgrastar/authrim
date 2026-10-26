import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AwsSetupError } from './setup-aws-cli.mjs';
import {
  canonicalSetupJson,
  readSetupFile,
  readSetupJson,
  setupDigest,
} from './setup-execution-state.mjs';
import { captureExecutionBuild, readExecutionBuildPins } from './setup-build.mjs';
import { validateServingCaBundle } from './package-serving.mjs';

export const EXECUTION_TEMPLATES = Object.freeze({
  bootstrap: 'saml-idp-bootstrap-roles.yaml',
  foundation: 'saml-idp-foundation.yaml',
  access: 'saml-browser-access.yaml',
  database: 'saml-idp-db-bootstrap.yaml',
  browser: 'saml-browser-workload.yaml',
  workload: 'saml-idp-workload.yaml',
});
export const EXECUTION_STAGES = Object.freeze([
  'bootstrap',
  'foundation',
  'access',
  'endpoint',
  'access-bind',
  'prepare',
  'upload',
  'database',
  'initialize',
  'restore',
  'verify',
  'sp-prepare',
  'manifest',
  'runtime-bind',
  'workload',
  'complete',
]);
const HASH = /^[a-f0-9]{64}$/u;
const fail = () => {
  throw new AwsSetupError('aws_setup_config_invalid');
};
function keys(value, allowed) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    fail();
}
function text(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) fail();
  return value;
}
const PARAMETERS = {
  bootstrap: ['OperatorPrincipalArn', 'OperatorPrincipalMode'],
  foundation: [
    'VpcCidr',
    'PrivateSubnetACidr',
    'PrivateSubnetBCidr',
    'S3GatewayPrefixListId',
    'DatabaseInstanceClass',
    'AllocatedStorageGiB',
    'BackupRetentionDays',
  ],
  access: ['InputSecretName', 'SpSecretName'],
  database: [],
  workload: ['ReservedConcurrency', 'ApiRateLimit', 'ApiBurstLimit'],
};

/** Configuration contains locations and public parameters only. Credentials stay in AWS profiles/secrets. */
export function normalizeExecutionConfig(input) {
  keys(input, [
    'formatVersion',
    'backend',
    'role',
    'mode',
    'target',
    'identities',
    'stacks',
    'assets',
    'fixture',
    'databasePrefix',
    'issuer',
  ]);
  if (
    input.formatVersion !== 1 ||
    input.backend !== 'aws' ||
    !['primary', 'secondary'].includes(input.role) ||
    !['browser-rehearsal', 'existing-issuer'].includes(input.mode)
  )
    fail();
  keys(input.target, ['accountId', 'region']);
  const account = text(input.target.accountId, /^\d{12}$/u);
  text(input.target.region, /^[a-z]{2}(?:-[a-z]+)+-\d$/u);
  if (input.mode === 'browser-rehearsal' && input.target.region !== 'ap-northeast-1') fail();
  keys(input.identities, ['bootstrap', 'operator']);
  for (const name of ['bootstrap', 'operator']) {
    const identity = input.identities[name];
    keys(identity, ['profile', 'principalArn']);
    text(identity.profile, /^[A-Za-z0-9_+=,.@-]{1,128}$/u);
    text(
      identity.principalArn,
      new RegExp(`^arn:aws:iam::${account}:(?:role|user)/[A-Za-z0-9/+=,.@_-]+$`, 'u')
    );
    if (name === 'operator' && !identity.principalArn.includes(':role/')) fail();
  }
  keys(input.stacks, ['bootstrap', 'foundation', 'access', 'database', 'workload']);
  const names = [];
  for (const name of [
    'bootstrap',
    'foundation',
    'database',
    'workload',
    ...(input.mode === 'browser-rehearsal' ? ['access'] : []),
  ]) {
    const stack = input.stacks[name];
    keys(stack, ['name', 'disposition', 'stackId', 'templateSha256', 'parameters']);
    text(stack.name, /^[A-Za-z][A-Za-z0-9-]{0,44}$/u);
    if (name === 'foundation' && stack.name.length > 28) fail();
    names.push(stack.name);
    if (!['create', 'reuse'].includes(stack.disposition)) fail();
    if (stack.disposition === 'reuse') {
      if (!['bootstrap', 'foundation'].includes(name)) fail();
      text(
        stack.stackId,
        new RegExp(
          `^arn:aws:cloudformation:${input.target.region}:${account}:stack/${stack.name}/[a-f0-9-]+$`,
          'u'
        )
      );
      text(stack.templateSha256, HASH);
    } else if (stack.stackId !== undefined || stack.templateSha256 !== undefined) fail();
    keys(stack.parameters ?? {}, PARAMETERS[name]);
    for (const value of Object.values(stack.parameters ?? {}))
      text(value, /^[A-Za-z0-9/:_.,=+@-]{1,2048}$/u);
  }
  if (new Set(names).size !== names.length) fail();
  if (input.stacks.bootstrap.disposition === 'create') {
    const parameters = input.stacks.bootstrap.parameters;
    text(
      parameters?.OperatorPrincipalArn,
      new RegExp(`^arn:aws:iam::${account}:(?:user|role)/[A-Za-z0-9/+=,.@_-]+$`, 'u')
    );
    if (
      parameters.OperatorPrincipalMode !==
      (parameters.OperatorPrincipalArn.includes(':user/') ? 'iam-user' : 'federated-role')
    )
      fail();
  }
  const expectedOperator = `arn:aws:iam::${account}:role/authrim-dr/operator/${input.stacks.bootstrap.name}-operator`;
  if (input.identities.operator.principalArn !== expectedOperator) fail();
  keys(input.assets, ['prefix', 'caBundlePath']);
  text(input.assets.prefix, /^[A-Za-z0-9!_.()-]+(?:\/[A-Za-z0-9!_.()-]+)*\/$/u);
  text(input.assets.caBundlePath, /^\/.+/u);
  keys(input.fixture, ['directory', 'generate', 'descriptorSha256']);
  text(input.fixture.directory, /^\/.+/u);
  if (typeof input.fixture.generate !== 'boolean') fail();
  if (input.fixture.generate) {
    if (input.mode !== 'browser-rehearsal' || input.fixture.descriptorSha256 !== undefined) fail();
  } else text(input.fixture.descriptorSha256, HASH);
  text(input.databasePrefix, /^authrim_dr_[a-z0-9_]{1,30}$/u);
  if (input.mode === 'browser-rehearsal') {
    if (input.databasePrefix !== 'authrim_dr_browser' || input.issuer !== undefined) fail();
  } else {
    keys(input.issuer, ['host', 'certificateArn', 'inputSecretArn', 'inputSecretVersionId']);
    text(input.issuer.host, /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u);
    text(
      input.issuer.certificateArn,
      new RegExp(`^arn:aws:acm:${input.target.region}:${account}:certificate/[a-f0-9-]+$`, 'u')
    );
    text(
      input.issuer.inputSecretArn,
      new RegExp(
        `^arn:aws:secretsmanager:${input.target.region}:${account}:secret:[A-Za-z0-9/_+=.@!-]+$`,
        'u'
      )
    );
    text(input.issuer.inputSecretVersionId, /^[A-Za-z0-9-]{32,64}$/u);
  }
  return JSON.parse(canonicalSetupJson(input));
}

/** Build inputs are pinned before any AWS write, including shared handlers and migration SQL. */
export async function executionSourceDigest(root) {
  const records = [];
  async function visit(relative) {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name)
    )) {
      if (['node_modules', 'dist', '.turbo', 'coverage', '.svelte-kit'].includes(entry.name))
        continue;
      const path = join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new AwsSetupError('aws_setup_source_symlink');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:ts|js|mjs|json|sql|yaml)$/u.test(entry.name))
        records.push([
          path,
          setupDigest(await readSetupFile(join(root, path), { maxBytes: 16 * 1024 * 1024 })),
        ]);
    }
  }
  const packages = new Map();
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join('packages', entry.name);
    try {
      const manifest = await readSetupJson(join(root, path, 'package.json'));
      packages.set(manifest.name, { path, manifest });
    } catch (error) {
      if (error.code !== 'aws_setup_file_missing') throw error;
    }
  }
  const selected = new Set();
  async function workspace(name) {
    if (selected.has(name)) return;
    const pkg = packages.get(name);
    if (!pkg) throw new AwsSetupError('aws_setup_workspace_dependency_missing');
    selected.add(name);
    await visit(pkg.path);
    for (const [dependency, version] of Object.entries({
      ...pkg.manifest.dependencies,
      ...pkg.manifest.devDependencies,
    }))
      if (version.startsWith('workspace:')) await workspace(dependency);
  }
  await workspace('@authrim/ar-runtime-aws');
  for (const directory of ['migrations/core/postgresql', 'migrations/pii/postgresql'])
    await visit(directory);
  for (const file of (await readdir(root)).filter(
    (name) =>
      ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(name) ||
      /^tsconfig.*\.json$/u.test(name)
  ))
    records.push([file, setupDigest(await readSetupFile(join(root, file)))]);
  return setupDigest(canonicalSetupJson(records));
}

export async function createExecutionPlan(config, root, { rebuild = true } = {}) {
  config = normalizeExecutionConfig(config);
  const templates = {};
  for (const [id, filename] of Object.entries(EXECUTION_TEMPLATES)) {
    const bytes = await readSetupFile(join(root, 'packages/ar-runtime-aws/deploy', filename), {
      maxBytes: 51_200,
    });
    templates[id] = { file: filename, sha256: setupDigest(bytes), bytes: bytes.length };
  }
  const ca = await readSetupFile(config.assets.caBundlePath, { maxBytes: 1024 * 1024 });
  try {
    validateServingCaBundle(ca.toString('utf8'));
  } catch {
    throw new AwsSetupError('aws_setup_ca_bundle_invalid');
  }
  const caSha256 = setupDigest(ca);
  const build = await (rebuild ? captureExecutionBuild : readExecutionBuildPins)(root);
  return {
    formatVersion: 2,
    config,
    sourceRoot: resolve(root),
    templates,
    sourceSha256: await executionSourceDigest(root),
    build,
    caSha256,
    stages: EXECUTION_STAGES,
  };
}

export async function verifyExecutionPlan(plan, expectedSha256, root) {
  if (!HASH.test(expectedSha256 ?? '') || setupDigest(canonicalSetupJson(plan)) !== expectedSha256)
    throw new AwsSetupError('aws_setup_plan_digest_mismatch');
  const current = await createExecutionPlan(plan.config, root, { rebuild: false });
  if (canonicalSetupJson(current) !== canonicalSetupJson(plan))
    throw new AwsSetupError('aws_setup_plan_inputs_changed');
  return plan;
}
