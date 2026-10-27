import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const OPERATIONS = new Set([
  'sts/get-caller-identity',
  'iam/get-role',
  'cloudformation/validate-template',
  'cloudformation/describe-stacks',
  'cloudformation/get-template',
  'cloudformation/create-change-set',
  'cloudformation/describe-change-set',
  'cloudformation/execute-change-set',
  'cloudformation/list-stack-resources',
  's3api/get-bucket-versioning',
  's3api/put-object',
  's3api/head-object',
  'secretsmanager/describe-secret',
  'secretsmanager/put-secret-value',
  'lambda/get-function-configuration',
  'lambda/invoke',
]);
const MUTATIONS = new Set([
  'cloudformation/create-change-set',
  'cloudformation/execute-change-set',
  's3api/put-object',
  'secretsmanager/put-secret-value',
  'lambda/invoke',
]);

export class AwsSetupError extends Error {
  constructor(code, { ambiguous = false } = {}) {
    super(code);
    this.name = 'AwsSetupError';
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

/** Never propagate SDK/CLI diagnostics: they can include supplied input or credential material. */
function failure(result, operation) {
  const raw = String(result.stderr ?? '');
  if (result.errorCode === 'ENOENT') return new AwsSetupError('aws_setup_cli_missing');
  // Credential refresh can fail on the local cache even when the login remains valid.
  // Check before reauthentication boilerplate and never expose the path or raw diagnostics.
  if (
    /EACCES|EPERM|EROFS|Errno (?:1|13|30)\b|Permission denied|Operation not permitted|Read-only file system/iu.test(
      raw
    ) &&
    /\.aws[/\\](?:login|sso|cli)[/\\]cache\b|AWS_LOGIN_CACHE_DIRECTORY|(?:credential|token)[^\r\n]*cache|cache[^\r\n]*(?:credential|token)/iu.test(
      raw
    )
  )
    return new AwsSetupError('aws_setup_credential_cache_access_denied');
  if (
    /ExpiredToken|InvalidClientTokenId|UnrecognizedClientException|RequestExpired|Unable to locate credentials|SSO session.*expired|Error loading SSO Token|Token has expired|Your session has expired\. Please reauthenticate|login session.*expired|login[ -](?:is[ -])?required|Please run ['"]?aws login/iu.test(
      raw
    )
  )
    return new AwsSetupError('aws_setup_login_required');
  if (/AccessDenied|UnauthorizedOperation/iu.test(raw))
    return new AwsSetupError('aws_setup_access_denied');
  if (/AlreadyExists|AlreadyExistsException/iu.test(raw))
    return new AwsSetupError('aws_setup_already_exists');
  if (/PreconditionFailed|ConditionalRequestConflict/iu.test(raw))
    return new AwsSetupError('aws_setup_object_exists');
  if (
    /ResourceNotFound|ChangeSetNotFound|NoSuchKey|NoSuchEntity|\(404\)|does not exist/iu.test(raw)
  )
    return new AwsSetupError('aws_setup_not_found');
  return new AwsSetupError('aws_setup_request_failed', { ambiguous: MUTATIONS.has(operation) });
}

async function runProcess(file, args, options) {
  try {
    return { exitCode: 0, ...(await execute(file, args, options)) };
  } catch (error) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      errorCode: error.killed ? 'ETIMEDOUT' : error.code,
      stderr: error.stderr ?? '',
    };
  }
}

/** Fixed operations and argv only. This transport cannot call Cloudflare, DNS or destructive CFN APIs. */
export function createAwsSetupCli({ region, profile }, dependencies = {}) {
  if (
    !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(region ?? '') ||
    !/^[A-Za-z0-9_+=,.@-]{1,128}$/u.test(profile ?? '')
  )
    throw new AwsSetupError('aws_setup_cli_target_invalid');
  const run = dependencies.runProcess ?? runProcess;
  return async (service, action, input = {}, files = {}) => {
    const operation = `${service}/${action}`;
    const isInvoke = operation === 'lambda/invoke';
    if (
      !OPERATIONS.has(operation) ||
      !input ||
      Array.isArray(input) ||
      Object.keys(files).some((key) => !['body', 'secret', 'payload', 'response'].includes(key)) ||
      (files.body && operation !== 's3api/put-object') ||
      (files.secret && operation !== 'secretsmanager/put-secret-value') ||
      ((files.payload || files.response) && operation !== 'lambda/invoke') ||
      (operation === 'lambda/invoke' && (!files.payload || !files.response)) ||
      Object.keys(input).some((key) =>
        ['SecretString', 'SecretBinary', 'Payload', 'Body'].includes(key)
      ) ||
      (isInvoke &&
        (Object.keys(input).some(
          (key) => !['FunctionName', 'InvocationType', 'LogType'].includes(key)
        ) ||
          typeof input.FunctionName !== 'string' ||
          !/^[A-Za-z0-9_][A-Za-z0-9_.:$-]{0,255}$/u.test(input.FunctionName) ||
          (input.InvocationType !== undefined &&
            !['RequestResponse', 'Event', 'DryRun'].includes(input.InvocationType)) ||
          (input.LogType !== undefined && !['None', 'Tail'].includes(input.LogType))))
    )
      throw new AwsSetupError('aws_setup_operation_invalid');
    // Lambda invoke is a custom CLI command and does not support --cli-input-json.
    const inputArgs = isInvoke
      ? [
          '--function-name',
          input.FunctionName,
          ...(input.InvocationType === undefined
            ? []
            : ['--invocation-type', input.InvocationType]),
          ...(input.LogType === undefined ? [] : ['--log-type', input.LogType]),
        ]
      : ['--cli-input-json', JSON.stringify(input)];
    const args = [
      service,
      action,
      ...inputArgs,
      '--profile',
      profile,
      '--region',
      region,
      '--output',
      'json',
      '--no-cli-pager',
      '--no-cli-auto-prompt',
      '--cli-connect-timeout',
      '10',
      '--cli-read-timeout',
      operation === 'lambda/invoke' ? '910' : '30',
    ];
    if (files.body) args.push('--body', files.body);
    if (files.secret) args.push('--secret-string', `file://${files.secret}`);
    if (files.payload) args.push('--payload', `fileb://${files.payload}`);
    if (files.response) args.push(files.response);
    const env = {
      ...process.env,
      AWS_PAGER: '',
      AWS_CLI_AUTO_PROMPT: 'off',
      AWS_MAX_ATTEMPTS: '1',
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
    };
    for (const key of Object.keys(env)) if (key.startsWith('AWS_ENDPOINT_URL')) delete env[key];
    const result = await run('aws', args, {
      shell: false,
      encoding: 'utf8',
      timeout: operation === 'lambda/invoke' ? 930_000 : 45_000,
      maxBuffer: 4 * 1024 * 1024,
      env,
    });
    if (result.exitCode !== 0) throw failure(result, operation);
    try {
      const value = result.stdout?.trim() ? JSON.parse(result.stdout) : {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new AwsSetupError('aws_setup_response_invalid', {
        ambiguous: MUTATIONS.has(operation),
      });
    }
  };
}
