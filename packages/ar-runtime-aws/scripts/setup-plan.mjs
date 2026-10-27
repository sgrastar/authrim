import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE_FILES = Object.freeze({
  roleBootstrap: 'saml-idp-bootstrap-roles.yaml',
  foundation: 'saml-idp-foundation.yaml',
  databaseBootstrap: 'saml-idp-db-bootstrap.yaml',
  workload: 'saml-idp-workload.yaml',
});
const TARGET_KEYS = ['accountId', 'region', 'issuerHost', 'templateDirectory'];
const PLAN_KEYS = ['formatVersion', 'target', 'stacks', 'templates', 'phases'];
const HASH = /^[a-f0-9]{64}$/u;

function invalid() {
  throw new Error('aws_setup_plan_invalid');
}

function exactKeys(value, expected) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...expected].sort().join(',')
  ) {
    invalid();
  }
}

function optionalKeys(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    invalid();
  }
}

function validateTarget(input) {
  optionalKeys(input, TARGET_KEYS);
  if (
    typeof input.accountId !== 'string' ||
    !/^\d{12}$/u.test(input.accountId) ||
    typeof input.region !== 'string' ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(input.region) ||
    (input.issuerHost !== undefined &&
      (typeof input.issuerHost !== 'string' ||
        input.issuerHost.length > 253 ||
        input.issuerHost.split('.').some((label) => label.length > 63) ||
        !/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/u.test(
          input.issuerHost
        ))) ||
    (input.templateDirectory !== undefined && typeof input.templateDirectory !== 'string')
  ) {
    invalid();
  }
}

function namesInSection(template, section) {
  const lines = template.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `${section}:`);
  if (start < 0) invalid();
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z][A-Za-z0-9]*:/u.test(line)) break;
    const match = /^  ([A-Za-z][A-Za-z0-9]*):(?:\s|$)/u.exec(line);
    if (match) names.push(match[1]);
  }
  if (new Set(names).size !== names.length) invalid();
  return names;
}

function resourceTypes(template) {
  const lines = template.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === 'Resources:');
  if (start < 0) invalid();
  const types = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z][A-Za-z0-9]*:/u.test(line)) break;
    const match = /^    Type: ['"]?((?:AWS|Custom)::[A-Za-z0-9:]+)['"]?\s*$/u.exec(line);
    if (match) types.push(match[1]);
  }
  if (types.length === 0 || types.length !== namesInSection(template, 'Resources').length)
    invalid();
  return [...new Set(types)].sort();
}

async function templateRecord(directory, name) {
  const path = join(directory, name);
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > 51_200
  )
    invalid();
  const bytes = await readFile(path);
  const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parameters = namesInSection(body, 'Parameters');
  const outputs = namesInSection(body, 'Outputs');
  const types = resourceTypes(body);
  const hasIam = types.some((type) => type.startsWith('AWS::IAM::'));
  const namedIam = hasIam && /^\s+RoleName:/mu.test(body);
  return {
    path: resolve(path),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    parameters,
    outputs,
    resourceTypes: types,
    capabilities: hasIam ? [namedIam ? 'CAPABILITY_NAMED_IAM' : 'CAPABILITY_IAM'] : [],
  };
}

/** Local plan only. It never resolves credentials or invokes AWS APIs. */
export async function createAwsSetupPlan(input) {
  validateTarget(input);
  const templateDirectory = resolve(input.templateDirectory ?? join(packageRoot, 'deploy'));
  const entries = await Promise.all(
    Object.entries(TEMPLATE_FILES).map(async ([id, name]) => [
      id,
      await templateRecord(templateDirectory, name),
    ])
  );
  const templates = Object.fromEntries(entries);
  return {
    formatVersion: 1,
    target: {
      accountId: input.accountId,
      region: input.region,
      issuerHost: input.issuerHost ?? null,
    },
    stacks: {
      roleBootstrap: 'authrim-dr-bootstrap',
      foundation: 'authrim-dr-foundation',
      databaseBootstrap: 'authrim-dr-db-bootstrap',
      workload: 'authrim-dr-saml',
    },
    templates,
    phases: [
      {
        id: 'role_bootstrap',
        template: 'roleBootstrap',
        dependsOn: [],
        pending: ['operator_identity_and_permissions', 'change_set_review'],
      },
      {
        id: 'foundation',
        template: 'foundation',
        dependsOn: ['role_bootstrap'],
        pending: ['s3_prefix_list_id', 'service_role_pin', 'change_set_review'],
      },
      {
        id: 'database_bootstrap',
        template: 'databaseBootstrap',
        dependsOn: ['foundation'],
        pending: [
          'pinned_backup_and_job_artifacts',
          'bootstrap_service_role_pin',
          'change_set_review',
          'three_database_users',
          'runtime_secret_version',
        ],
      },
      {
        id: 'role_bootstrap_bind',
        template: 'roleBootstrap',
        dependsOn: ['database_bootstrap'],
        pending: [
          'exact_foundation_assets_bucket',
          'exact_asset_object_prefix',
          'exact_runtime_secret_arn',
          'exact_foundation_database_security_group',
          'exact_foundation_secrets_endpoint_security_group',
          'exact_foundation_vpc_id',
          'exact_foundation_http_api_id',
          'change_set_review',
        ],
      },
      {
        id: 'offline_restore',
        template: null,
        dependsOn: ['role_bootstrap_bind'],
        pending: ['verified_source_capture', 'restore_activation_receipt'],
      },
      {
        id: 'workload',
        template: 'workload',
        dependsOn: ['offline_restore'],
        pending: [
          ...(input.issuerHost === undefined ? ['issuer_host'] : []),
          'certificate_arn',
          'pinned_artifact_and_manifest_versions',
          'activation_evidence',
          'service_role_pin',
          'change_set_review',
        ],
      },
      {
        id: 'dns_cutover',
        template: null,
        dependsOn: ['workload'],
        pending: ['real_sp_validation', 'explicit_cutover_decision'],
      },
    ],
  };
}

/** Require an independently pinned plan digest, then reject edits and template drift. */
export async function verifyAwsSetupPlan(plan, options = {}) {
  optionalKeys(options, ['templateDirectory', 'expectedPlanSha256']);
  if (options.templateDirectory !== undefined && typeof options.templateDirectory !== 'string')
    invalid();
  if (!HASH.test(options.expectedPlanSha256)) invalid();
  const actualPlanSha256 = createHash('sha256')
    .update(`${JSON.stringify(plan)}\n`)
    .digest('hex');
  if (actualPlanSha256 !== options.expectedPlanSha256) invalid();
  exactKeys(plan, PLAN_KEYS);
  if (plan.formatVersion !== 1) invalid();
  exactKeys(plan.target, ['accountId', 'region', 'issuerHost']);
  exactKeys(plan.stacks, ['roleBootstrap', 'foundation', 'databaseBootstrap', 'workload']);
  exactKeys(plan.templates, Object.keys(TEMPLATE_FILES));
  if (!Array.isArray(plan.phases)) invalid();
  if (plan.target.issuerHost !== null && typeof plan.target.issuerHost !== 'string') {
    invalid();
  }
  const rebuilt = await createAwsSetupPlan({
    accountId: plan.target.accountId,
    region: plan.target.region,
    ...(plan.target.issuerHost === null ? {} : { issuerHost: plan.target.issuerHost }),
    templateDirectory: options.templateDirectory ?? join(packageRoot, 'deploy'),
  });
  if (JSON.stringify(plan) !== JSON.stringify(rebuilt)) invalid();
  for (const value of Object.values(plan.templates)) {
    if (!HASH.test(value.sha256)) invalid();
  }
  return rebuilt;
}

function parseArgs(args) {
  if (args.length === 0 || !['create', 'verify'].includes(args[0])) invalid();
  const flags = {};
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined || key in flags) invalid();
    flags[key] = value;
  }
  if (args[0] === 'create') {
    optionalKeys(flags, ['--account-id', '--region', '--issuer-host', '--out']);
    if (!flags['--out']) invalid();
  } else {
    exactKeys(flags, ['--plan', '--plan-sha256']);
  }
  return { mode: args[0], flags };
}

async function main(args) {
  const { mode, flags } = parseArgs(args);
  if (mode === 'create') {
    const plan = await createAwsSetupPlan({
      accountId: flags['--account-id'],
      region: flags['--region'],
      ...(flags['--issuer-host'] ? { issuerHost: flags['--issuer-host'] } : {}),
    });
    const body = `${JSON.stringify(plan)}\n`;
    await writeFile(flags['--out'], body, { flag: 'wx', mode: 0o600 });
    process.stdout.write(
      `${JSON.stringify({ status: 'plan_created', sha256: createHash('sha256').update(body).digest('hex') })}\n`
    );
  } else {
    const metadata = await lstat(flags['--plan']);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_048_576) invalid();
    const raw = await readFile(flags['--plan'], 'utf8');
    if (Buffer.byteLength(raw) > 1_048_576) invalid();
    const plan = JSON.parse(raw);
    if (raw !== `${JSON.stringify(plan)}\n`) invalid();
    await verifyAwsSetupPlan(plan, { expectedPlanSha256: flags['--plan-sha256'] });
    process.stdout.write(
      `${JSON.stringify({ status: 'plan_verified', sha256: createHash('sha256').update(raw).digest('hex') })}\n`
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('aws_setup_plan_invalid\n');
    process.exitCode = 1;
  });
}
