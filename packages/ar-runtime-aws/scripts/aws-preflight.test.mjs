import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { formatAwsPreflight, runAwsPreflight } from './aws-preflight.mjs';

const accountId = '123456789012';
const target = { accountId, region: 'ap-northeast-1', profile: 'authrim-dr' };
const operatorId = 'AROAOPERATOR12345';
const source = `arn:aws:iam::${accountId}:user/operator-user`;
const arn = (kind) =>
  `arn:aws:iam::${accountId}:role/authrim-dr/${kind === 'operator' ? 'operator' : 'cfn'}/authrim-dr-bootstrap-${kind === 'operator' ? kind : `${kind}-cfn`}`;
const stackName = (kind) => `authrim-dr-${kind === 'workload' ? 'saml' : kind}`;
const stackArn = (kind) =>
  `arn:aws:cloudformation:ap-northeast-1:${accountId}:stack/${stackName(kind)}/00000000-0000-0000-0000-000000000000`;
const ok = (data) => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: '' });
const denied = () => ({
  exitCode: 254,
  stderr: 'An error occurred (AccessDenied) when calling the operation: secret=DO_NOT_PRINT',
});
const missing = (kind = 'entity') => ({
  exitCode: 254,
  stderr:
    kind === 'stack'
      ? 'An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id authrim-dr-foundation does not exist'
      : 'An error occurred (NoSuchEntity) when calling the GetRole operation: not found',
});
function role(kind) {
  return {
    Arn: arn(kind),
    RoleId: kind === 'operator' ? operatorId : `AROA${kind.toUpperCase()}12345`,
    AssumeRolePolicyDocument: {
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sts:AssumeRole',
          Principal:
            kind === 'operator' ? { AWS: source } : { Service: 'cloudformation.amazonaws.com' },
          ...(kind === 'operator'
            ? {
                Condition: {
                  StringEquals: { 'aws:PrincipalAccount': accountId, 'aws:PrincipalType': 'User' },
                  Bool: { 'aws:MultiFactorAuthPresent': 'true' },
                },
              }
            : {}),
        },
      ],
    },
  };
}
function stack(kind) {
  return {
    StackName: stackName(kind),
    StackId: stackArn(kind),
    StackStatus: 'UPDATE_COMPLETE',
    ...(kind === 'bootstrap'
      ? {
          Parameters: [
            { ParameterKey: 'OperatorPrincipalArn', ParameterValue: source },
            { ParameterKey: 'OperatorPrincipalMode', ParameterValue: 'iam-user' },
          ],
        }
      : { RoleARN: arn(kind) }),
  };
}
function fixture(override = () => undefined) {
  const calls = [];
  const runCommand = async (file, args) => {
    assert.equal(file, 'aws');
    calls.push(args);
    const changed = override(args);
    if (changed !== undefined) return changed;
    if (args[0] === '--version')
      return { exitCode: 0, stdout: 'aws-cli/2.33.12 Python/3.13 Darwin/24 exe/arm64', stderr: '' };
    assert.equal(args[args.indexOf('--region') + 1], target.region);
    assert.equal(args[args.indexOf('--profile') + 1], target.profile);
    assert.ok(args.includes('--no-cli-pager'));
    const command = args.slice(0, 2).join(' ');
    if (command === 'sts get-caller-identity')
      return ok({
        Account: accountId,
        Arn: `arn:aws:sts::${accountId}:assumed-role/authrim-dr-bootstrap-operator/session`,
        UserId: `${operatorId}:session`,
      });
    if (command === 'cloudformation validate-template') return ok({ Parameters: [] });
    if (command === 'cloudformation describe-stacks')
      return ok({
        Stacks: [
          stack(
            args[3] === 'authrim-dr-bootstrap'
              ? 'bootstrap'
              : args[3] === 'authrim-dr-foundation'
                ? 'foundation'
                : 'workload'
          ),
        ],
      });
    if (command === 'iam get-role')
      return ok({
        Role: role(
          args[3].endsWith('operator')
            ? 'operator'
            : args[3].includes('foundation')
              ? 'foundation'
              : 'workload'
        ),
      });
    if (command === 'iam list-mfa-devices')
      return ok({ MFADevices: [{ UserName: 'operator-user' }] });
    if (command === 'iam simulate-principal-policy') {
      const actions = args.slice(
        args.indexOf('--action-names') + 1,
        args.indexOf('--resource-arns')
      );
      return ok({
        EvaluationResults: actions.map((action) => ({
          EvalActionName: action,
          EvalResourceName: args[args.indexOf('--resource-arns') + 1],
          EvalDecision: 'allowed',
          MissingContextValues: [],
        })),
      });
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  return { calls, runCommand };
}
const check = (report, id) => report.checks.find((entry) => entry.id === id);

test('diagnoses a real-shaped operator session and exact permissions using read-only APIs', async () => {
  const fake = fixture();
  const report = await runAwsPreflight(target, fake);
  assert.equal(report.status, 'passed');
  assert.equal(report.writeAuthorization, 'not_proven');
  assert.equal(check(report, 'caller').status, 'pass');
  assert.match(report.limitation, /SCP/u);
  const simulations = fake.calls.filter((args) => args[1] === 'simulate-principal-policy');
  assert.equal(simulations.length, 3);
  const contexts = simulations.map((args) =>
    JSON.parse(args[args.indexOf('--context-entries') + 1])
  );
  assert.deepEqual(contexts[0][1], {
    ContextKeyName: 'cloudformation:RoleArn',
    ContextKeyValues: [arn('foundation')],
    ContextKeyType: 'string',
  });
  assert.deepEqual(contexts[2][1], {
    ContextKeyName: 'iam:PassedToService',
    ContextKeyValues: ['cloudformation.amazonaws.com'],
    ContextKeyType: 'string',
  });
  assert.ok(
    fake.calls.every((args) =>
      [
        '--version',
        'sts get-caller-identity',
        'cloudformation validate-template',
        'cloudformation describe-stacks',
        'iam get-role',
        'iam list-mfa-devices',
        'iam simulate-principal-policy',
      ].includes(args[0] === '--version' ? args[0] : args.slice(0, 2).join(' '))
    )
  );
});

test('missing CLI and v1 stop before credential resolution', async () => {
  for (const response of [
    { exitCode: 1, errorCode: 'ENOENT' },
    { exitCode: 0, stdout: 'aws-cli/1.99.0' },
  ]) {
    const fake = fixture(() => response);
    const report = await runAwsPreflight(target, fake);
    assert.equal(report.status, 'blocked');
    assert.equal(check(report, 'cli').status, 'fail');
    assert.equal(fake.calls.length, 1);
  }
});

test('expired credentials and account mismatch block without exposing raw diagnostics', async () => {
  for (const response of [
    {
      exitCode: 254,
      stderr: 'An error occurred (ExpiredToken) when calling STS: secret=DO_NOT_PRINT',
    },
    ok({ Account: '999999999999', Arn: 'arn:aws:iam::999999999999:root', UserId: 'other' }),
  ]) {
    const fake = fixture((args) => (args[0] === 'sts' ? response : undefined));
    const report = await runAwsPreflight(target, fake);
    assert.equal(report.status, 'blocked');
    assert.equal(fake.calls.length, 2);
    assert.doesNotMatch(JSON.stringify(report), /DO_NOT_PRINT/u);
    assert.doesNotMatch(formatAwsPreflight(report), /DO_NOT_PRINT/u);
  }
});

test('root is blocked for daily operations and only warned for bootstrap', async () => {
  const root = (args) =>
    args[0] === 'sts'
      ? ok({ Account: accountId, Arn: `arn:aws:iam::${accountId}:root`, UserId: accountId })
      : undefined;
  const normal = await runAwsPreflight(target, fixture(root));
  assert.equal(normal.status, 'blocked');
  assert.equal(check(normal, 'caller').status, 'fail');
  const initial = await runAwsPreflight({ ...target, phase: 'bootstrap' }, fixture(root));
  assert.equal(initial.status, 'passed');
  assert.equal(check(initial, 'caller').status, 'warning');
  assert.equal(initial.writeAuthorization, 'not_proven');
});

test('role absence and missing read permission are distinct, sanitized failures', async () => {
  for (const [response, expected] of [
    [missing(), 'not_found'],
    [denied(), 'access_denied'],
  ]) {
    const report = await runAwsPreflight(
      target,
      fixture((args) =>
        args[1] === 'get-role' && args[3].endsWith('operator') ? response : undefined
      )
    );
    assert.equal(report.status, 'blocked');
    assert.match(check(report, 'role_operator').message, new RegExp(expected, 'u'));
    assert.equal(check(report, 'caller').status, 'fail');
    assert.doesNotMatch(JSON.stringify(report), /DO_NOT_PRINT/u);
  }
});

test('matching role names do not bypass the RoleId identity check', async () => {
  const report = await runAwsPreflight(
    target,
    fixture((args) =>
      args[0] === 'sts'
        ? ok({
            Account: accountId,
            Arn: `arn:aws:sts::${accountId}:assumed-role/authrim-dr-bootstrap-operator/session`,
            UserId: 'AROAOTHERROLE:session',
          })
        : undefined
    )
  );
  assert.equal(report.status, 'blocked');
  assert.equal(check(report, 'caller').status, 'fail');
  assert.equal(check(report, 'permissions').status, 'pending');
});

test('dormant, broad trust, missing MFA and wrong service role cannot pass', async () => {
  const cases = [
    [
      (args) =>
        args[1] === 'describe-stacks' && args[3] === 'authrim-dr-bootstrap'
          ? ok({ Stacks: [{ ...stack('bootstrap'), Parameters: [] }] })
          : undefined,
      'operator_binding',
    ],
    [
      (args) =>
        args[1] === 'get-role' && args[3].endsWith('operator')
          ? ok({
              Role: {
                ...role('operator'),
                AssumeRolePolicyDocument: {
                  Statement: [
                    { Effect: 'Allow', Principal: { AWS: '*' }, Action: 'sts:AssumeRole' },
                  ],
                },
              },
            })
          : undefined,
      'role_operator',
    ],
    [(args) => (args[1] === 'list-mfa-devices' ? ok({ MFADevices: [] }) : undefined), 'mfa'],
    [
      (args) =>
        args[1] === 'describe-stacks' && args[3] === 'authrim-dr-foundation'
          ? ok({ Stacks: [{ ...stack('foundation'), RoleARN: arn('workload') }] })
          : undefined,
      'stack_foundation',
    ],
  ];
  for (const [override, id] of cases) {
    const report = await runAwsPreflight(target, fixture(override));
    assert.equal(report.status, 'blocked');
    assert.equal(check(report, id).status, 'fail');
  }
});

test('simulator denial, missing context, permission boundary and incomplete replies block', async () => {
  for (const response of [
    denied(),
    ok({ EvaluationResults: [] }),
    ok({
      EvaluationResults: [
        {
          EvalActionName: 'cloudformation:CreateChangeSet',
          EvalResourceName: stackArn('foundation'),
          EvalDecision: 'allowed',
          MissingContextValues: ['cloudformation:RoleArn'],
        },
      ],
    }),
    ok({
      EvaluationResults: [
        {
          EvalActionName: 'cloudformation:CreateChangeSet',
          EvalResourceName: stackArn('foundation'),
          EvalDecision: 'explicitDeny',
        },
      ],
    }),
    ok({
      EvaluationResults: [
        {
          EvalActionName: 'cloudformation:CreateChangeSet',
          EvalResourceName: stackArn('foundation'),
          EvalDecision: 'allowed',
          PermissionsBoundaryDecisionDetail: { AllowedByPermissionsBoundary: false },
        },
      ],
    }),
  ]) {
    const report = await runAwsPreflight(
      target,
      fixture((args) => (args[1] === 'simulate-principal-policy' ? response : undefined))
    );
    assert.equal(report.status, 'blocked');
    assert.notEqual(check(report, 'permissions_create').status, 'pass');
    assert.equal(report.writeAuthorization, 'not_proven');
  }
});

test('an uncreated foundation is allowed only for foundation creation; workload needs it', async () => {
  const override = (args) =>
    args[1] === 'describe-stacks' && args[3] === 'authrim-dr-foundation'
      ? missing('stack')
      : undefined;
  assert.equal((await runAwsPreflight(target, fixture(override))).status, 'passed');
  const workload = await runAwsPreflight({ ...target, phase: 'workload' }, fixture(override));
  assert.equal(workload.status, 'blocked');
  assert.equal(check(workload, 'stack_foundation').status, 'fail');
});

test('workload probes pin the workload service role rather than foundation authority', async () => {
  const fake = fixture();
  assert.equal((await runAwsPreflight({ ...target, phase: 'workload' }, fake)).status, 'passed');
  const calls = fake.calls.filter((args) => args[1] === 'simulate-principal-policy');
  assert.equal(calls[2][calls[2].indexOf('--resource-arns') + 1], arn('workload'));
});

test('malformed options fail before any command and arbitrary stderr is not printed', async () => {
  for (const changed of [
    { accountId: '123;evil' },
    { region: 'ap-northeast-1 --profile x' },
    { profile: '../bad' },
    { phase: 'destroy' },
    { secret: 'DO_NOT_PRINT' },
  ]) {
    let calls = 0;
    await assert.rejects(
      runAwsPreflight(
        { ...target, ...changed },
        {
          runCommand: () => {
            calls += 1;
          },
        }
      ),
      /aws_preflight_options_invalid/u
    );
    assert.equal(calls, 0);
  }
  const report = await runAwsPreflight(
    target,
    fixture((args) =>
      args[1] === 'validate-template' ? { exitCode: 1, stderr: 'password=DO_NOT_PRINT' } : undefined
    )
  );
  assert.equal(report.status, 'blocked');
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_PRINT/u);
});

test('the real CLI entry emits structured failure and exit 1 when aws is absent', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./aws-preflight.mjs', import.meta.url)),
      '--account-id',
      accountId,
      '--region',
      target.region,
      '--json',
    ],
    { env: { ...process.env, PATH: '/nonexistent-authrim-preflight-test' }, encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'blocked');
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].id, 'cli');
});

test('contradictory Deny and additional trust principals fail closed', async () => {
  for (const kind of ['operator', 'foundation']) {
    for (const tamper of [
      (policy) =>
        policy.Statement.push({ Effect: 'Deny', Principal: '*', Action: 'sts:AssumeRole' }),
      (policy) => {
        policy.Statement[0].Principal.Federated = '*';
      },
    ]) {
      const changed = role(kind);
      tamper(changed.AssumeRolePolicyDocument);
      const report = await runAwsPreflight(
        target,
        fixture((args) =>
          args[1] === 'get-role' &&
          args[3] === `authrim-dr-bootstrap-${kind === 'operator' ? kind : `${kind}-cfn`}`
            ? ok({ Role: changed })
            : undefined
        )
      );
      assert.equal(report.status, 'blocked');
      assert.equal(check(report, `role_${kind}`).status, 'fail');
    }
  }
});

test('missing profiles get actionable guidance and cross-region stack responses are rejected', async () => {
  const profile = await runAwsPreflight(
    target,
    fixture((args) =>
      args[0] === 'sts'
        ? { exitCode: 255, stderr: 'The config profile (unconfigured) could not be found' }
        : undefined
    )
  );
  assert.equal(profile.status, 'blocked');
  assert.match(check(profile, 'identity').message, /profile_missing/u);
  assert.match(check(profile, 'identity').remediation, /プロファイル/u);
  const region = await runAwsPreflight(
    target,
    fixture((args) =>
      args[1] === 'describe-stacks' && args[3] === 'authrim-dr-foundation'
        ? ok({
            Stacks: [
              {
                ...stack('foundation'),
                StackId: stackArn('foundation').replace('ap-northeast-1', 'us-east-1'),
              },
            ],
          })
        : undefined
    )
  );
  assert.equal(region.status, 'blocked');
  assert.equal(check(region, 'stack_foundation').status, 'fail');
});

test('network, proxy, TLS and CLI timeouts have sanitized non-credential remedies', async () => {
  for (const [response, expected] of [
    [
      {
        exitCode: 255,
        stderr:
          'aws: [ERROR]: Could not connect to the endpoint URL: "https://DO_NOT_PRINT@sts.ap-northeast-1.amazonaws.com/"',
      },
      'endpoint_unreachable',
    ],
    [
      { exitCode: 255, stderr: 'Failed to connect to proxy URL: "http://DO_NOT_PRINT@proxy/"' },
      'proxy_unreachable',
    ],
    [
      {
        exitCode: 255,
        stderr: 'SSL validation failed for https://DO_NOT_PRINT/ [SSL: CERTIFICATE_VERIFY_FAILED]',
      },
      'tls_failed',
    ],
    [
      { exitCode: 255, stderr: 'Read timeout on endpoint URL: https://DO_NOT_PRINT/' },
      'network_timeout',
    ],
    [{ exitCode: 1, errorCode: 'ETIMEDOUT', stderr: 'DO_NOT_PRINT' }, 'cli_timeout'],
  ]) {
    const report = await runAwsPreflight(
      target,
      fixture((args) => (args[0] === 'sts' ? response : undefined))
    );
    assert.equal(report.status, 'blocked');
    assert.match(check(report, 'identity').message, new RegExp(expected, 'u'));
    assert.match(check(report, 'identity').remediation, /ネットワーク|プロキシ/u);
    assert.doesNotMatch(check(report, 'identity').remediation, /再ログイン/u);
    assert.doesNotMatch(JSON.stringify(report), /DO_NOT_PRINT/u);
  }
  const cli = await runAwsPreflight(
    target,
    fixture(() => ({ exitCode: 1, errorCode: 'ETIMEDOUT' }))
  );
  assert.match(check(cli, 'cli').message, /cli_timeout/u);
  assert.doesNotMatch(check(cli, 'cli').remediation, /インストール/u);
});

test('interactive MFA prompts take precedence over timeout without exposing the prompt', async () => {
  for (const errorCode of [undefined, 'ETIMEDOUT']) {
    const report = await runAwsPreflight(
      target,
      fixture((args) =>
        args[0] === 'sts'
          ? {
              exitCode: 1,
              errorCode,
              stderr: 'Enter MFA code for arn:aws:iam::123456789012:mfa/DO_NOT_PRINT: ',
            }
          : undefined
      )
    );
    assert.equal(report.status, 'blocked');
    assert.match(check(report, 'identity').message, /mfa_session_required/u);
    assert.match(check(report, 'identity').remediation, /対話可能な端末/u);
    assert.doesNotMatch(JSON.stringify(report), /DO_NOT_PRINT|cli_timeout/u);
  }
});

test('expired aws login sessions and login-required errors request reauthentication', async () => {
  for (const stderr of [
    'The login session associated with this profile has expired. Please run aws login to refresh your session. DO_NOT_PRINT',
    'Login required for this profile: DO_NOT_PRINT',
    'Login is required. DO_NOT_PRINT',
    'Please run "aws login" to authenticate. DO_NOT_PRINT',
  ]) {
    const report = await runAwsPreflight(
      target,
      fixture((args) => (args[0] === 'sts' ? { exitCode: 255, stderr } : undefined))
    );
    assert.equal(report.status, 'blocked');
    assert.match(check(report, 'identity').message, /login_required/u);
    assert.match(check(report, 'identity').remediation, /再ログイン/u);
    assert.doesNotMatch(JSON.stringify(report), /DO_NOT_PRINT/u);
  }
});
