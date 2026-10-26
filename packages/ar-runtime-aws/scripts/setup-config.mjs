import { dirname, join } from 'node:path';
import { AwsSetupError } from './setup-aws-cli.mjs';
import { normalizeExecutionConfig } from './setup-execution-plan.mjs';

const fail = () => {
  throw new AwsSetupError('aws_setup_configuration_input_invalid');
};
function keys(value, allowed, required = allowed) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    fail();
}
function text(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) fail();
  return value;
}

/** Produce public, create-only configuration. No AWS calls, credentials, arbitrary templates or overwrite. */
export function createSetupConfiguration(input, outputPath) {
  const shared = ['database', 'accountId', 'region'];
  if (input?.database === 'aurora-dsql') {
    keys(input, [...shared, 'hostname', 'user']);
    text(input.accountId, /^\d{12}$/u);
    text(input.region, /^[a-z]{2}(?:-[a-z]+)+-\d$/u);
    text(input.hostname, /^[a-z0-9]{26}\.dsql\.[a-z0-9-]+\.on\.aws$/u);
    if (!input.hostname.endsWith(`.dsql.${input.region}.on.aws`)) fail();
    text(input.user, /^[a-z][a-z0-9_]{0,62}$/u);
    return { hostname: input.hostname, region: input.region, user: input.user };
  }
  const required = [
    ...shared,
    'name',
    'role',
    'mode',
    'bootstrapProfile',
    'bootstrapPrincipalArn',
    'operatorProfile',
    'caBundlePath',
    's3GatewayPrefixListId',
    'components',
    'ui',
  ];
  keys(
    input,
    [...required, 'issuer', 'fixture', 'authState', 'dynamoDbGatewayPrefixListId'],
    required
  );
  if (input.database !== 'postgresql') fail();
  const account = text(input.accountId, /^\d{12}$/u);
  const prefix = text(input.name, /^[a-z][a-z0-9-]{0,27}$/u);
  const principal = text(
    input.bootstrapPrincipalArn,
    new RegExp(`^arn:aws:iam::${account}:(?:user|role)/[A-Za-z0-9/+=,.@_-]+$`, 'u')
  );
  const principalMode = principal.includes(':user/') ? 'iam-user' : 'federated-role';
  text(input.s3GatewayPrefixListId, /^pl-[a-f0-9]{8,17}$/u);
  const bootstrap = `${prefix}-bootstrap`;
  let fixture;
  if (input.mode === 'browser-rehearsal') {
    if (input.fixture !== undefined || input.issuer !== undefined) fail();
    fixture = { directory: join(dirname(outputPath), 'fixture'), generate: true };
  } else {
    keys(input.fixture, ['directory', 'descriptorSha256']);
    fixture = { ...input.fixture, generate: false };
  }
  return normalizeExecutionConfig({
    formatVersion: 1,
    backend: 'aws',
    role: input.role,
    mode: input.mode,
    target: { accountId: account, region: input.region },
    identities: {
      bootstrap: { profile: input.bootstrapProfile, principalArn: principal },
      operator: {
        profile: input.operatorProfile,
        principalArn: `arn:aws:iam::${account}:role/authrim-dr/operator/${bootstrap}-operator`,
      },
    },
    stacks: {
      bootstrap: {
        name: bootstrap,
        disposition: 'create',
        parameters: {
          OperatorPrincipalArn: principal,
          OperatorPrincipalMode: principalMode,
        },
      },
      foundation: {
        name: prefix,
        disposition: 'create',
        parameters: {
          S3GatewayPrefixListId: input.s3GatewayPrefixListId,
          ...(input.dynamoDbGatewayPrefixListId === undefined
            ? {}
            : {
                DynamoDbGatewayPrefixListId: input.dynamoDbGatewayPrefixListId,
              }),
        },
      },
      ...(input.mode === 'browser-rehearsal'
        ? { access: { name: `${prefix}-access`, disposition: 'create' } }
        : {}),
      database: { name: `${prefix}-db`, disposition: 'create' },
      workload: { name: `${prefix}-workload`, disposition: 'create' },
    },
    assets: { prefix: `${prefix}/`, caBundlePath: input.caBundlePath },
    fixture,
    databasePrefix:
      input.mode === 'browser-rehearsal' ? 'authrim_dr_browser' : 'authrim_dr_runtime',
    ...(input.issuer ? { issuer: input.issuer } : {}),
    components: input.components,
    ui: input.ui,
    ...(input.authState === undefined ? {} : { authState: input.authState }),
  });
}
