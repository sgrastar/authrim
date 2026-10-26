import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PHASES = ['bootstrap', 'foundation', 'workload'];
const COMPLETE = ['CREATE_COMPLETE', 'UPDATE_COMPLETE'];
const STACKS = {
  bootstrap: 'authrim-dr-bootstrap',
  foundation: 'authrim-dr-foundation',
  workload: 'authrim-dr-saml',
};
const ROLES = {
  operator: ['operator', 'operator'],
  foundation: ['cfn', 'foundation-cfn'],
  workload: ['cfn', 'workload-cfn'],
};
const HELP =
  'AWS 読み取り診断: --account-id <12桁> --region <region> [--profile <profile>] [--phase bootstrap|foundation|workload] [--json]\n設定変更、ログイン、インストールは行いません。\n';

async function runCommand(file, args) {
  try {
    const result = await execute(file, args, {
      timeout: 20_000,
      maxBuffer: 1_048_576,
      encoding: 'utf8',
      shell: false,
      env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_MAX_ATTEMPTS: '1' },
    });
    return { exitCode: 0, ...result };
  } catch (error) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      errorCode: error.killed ? 'ETIMEDOUT' : error.code,
      stdout: '',
      stderr: error.stderr ?? '',
    };
  }
}

function validateOptions(options) {
  if (
    !options ||
    Object.keys(options).some(
      (key) => !['accountId', 'region', 'profile', 'phase'].includes(key)
    ) ||
    !/^\d{12}$/u.test(options.accountId ?? '') ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(options.region ?? '') ||
    !PHASES.includes(options.phase ?? 'foundation') ||
    (options.profile !== undefined && !/^[A-Za-z0-9_+=,.@-]{1,128}$/u.test(options.profile))
  ) {
    throw new Error('aws_preflight_options_invalid');
  }
}

function errorKind(response) {
  if (response.errorCode === 'ENOENT') return 'cli_missing';
  const text = String(response.stderr ?? '');
  if (/Enter MFA code(?: for)?/iu.test(text)) return 'mfa_session_required';
  if (response.errorCode === 'ETIMEDOUT') return 'cli_timeout';
  if (/SSL validation failed|CERTIFICATE_VERIFY_FAILED|certificate verify failed/u.test(text))
    return 'tls_failed';
  if (/Failed to connect to proxy URL|ProxyConnectionError/u.test(text)) return 'proxy_unreachable';
  if (
    /Read timeout on endpoint URL|Connect timeout on endpoint URL|ConnectTimeoutError|ReadTimeoutError/u.test(
      text
    )
  )
    return 'network_timeout';
  if (
    /Could not connect to the endpoint URL|EndpointConnectionError|Name or service not known|nodename nor servname provided/u.test(
      text
    )
  )
    return 'endpoint_unreachable';
  if (/\((?:AccessDenied|AccessDeniedException|UnauthorizedOperation)\)/u.test(text))
    return 'access_denied';
  if (
    /\((?:ExpiredToken|ExpiredTokenException|InvalidClientTokenId|UnrecognizedClientException|RequestExpired)\)/u.test(
      text
    ) ||
    /Unable to locate credentials|SSO session.*expired|Error loading SSO Token|Token has expired|login session.*expired|login[ -](?:is[ -])?required|Please run ['"]?aws login/iu.test(
      text
    )
  )
    return 'login_required';
  if (/The config profile \([^\r\n]*\) could not be found/u.test(text)) return 'profile_missing';
  if (/\(NoSuchEntity\)/u.test(text)) return 'not_found';
  if (/\(ValidationError\).*Stack with id [^\r\n]* does not exist/u.test(text)) return 'not_found';
  return 'request_failed';
}

function values(value) {
  return Array.isArray(value) ? value : [value];
}
function statements(role) {
  let policy = role?.AssumeRolePolicyDocument;
  try {
    if (typeof policy === 'string') policy = JSON.parse(decodeURIComponent(policy));
  } catch {
    return [];
  }
  return values(policy?.Statement).filter(Boolean);
}
function operatorTrust(role, principal, mode) {
  const allows = statements(role);
  return (
    allows.length === 1 &&
    allows[0].Effect === 'Allow' &&
    Object.keys(allows[0].Principal ?? {}).join(',') === 'AWS' &&
    allows[0].Principal.AWS === principal &&
    values(allows[0].Action).join(',') === 'sts:AssumeRole' &&
    Object.keys(allows[0].Condition ?? {})
      .sort()
      .join(',') === (mode === 'iam-user' ? 'Bool,StringEquals' : 'StringEquals') &&
    Object.keys(allows[0].Condition?.StringEquals ?? {})
      .sort()
      .join(',') === 'aws:PrincipalAccount,aws:PrincipalType' &&
    (mode !== 'iam-user' ||
      Object.keys(allows[0].Condition?.Bool ?? {}).join(',') === 'aws:MultiFactorAuthPresent') &&
    allows[0].Condition?.StringEquals?.['aws:PrincipalAccount'] === principal?.split(':')[4] &&
    allows[0].Condition?.StringEquals?.['aws:PrincipalType'] ===
      (mode === 'iam-user' ? 'User' : 'AssumedRole') &&
    (mode !== 'iam-user' ||
      String(allows[0].Condition?.Bool?.['aws:MultiFactorAuthPresent']) === 'true')
  );
}
function serviceTrust(role) {
  const allows = statements(role);
  return (
    allows.length === 1 &&
    allows[0].Effect === 'Allow' &&
    Object.keys(allows[0].Principal ?? {}).join(',') === 'Service' &&
    allows[0].Condition === undefined &&
    allows[0].Principal?.Service === 'cloudformation.amazonaws.com' &&
    values(allows[0].Action).join(',') === 'sts:AssumeRole'
  );
}

/** Read-only checks. Simulation is advisory and never proves that a future write will succeed. */
export async function runAwsPreflight(options, dependencies = {}) {
  validateOptions(options);
  const invoke = dependencies.runCommand ?? runCommand;
  const phase = options.phase ?? 'foundation';
  const partition = options.region.startsWith('cn-')
    ? 'aws-cn'
    : options.region.startsWith('us-gov-')
      ? 'aws-us-gov'
      : 'aws';
  const roleArn = (kind) =>
    `arn:${partition}:iam::${options.accountId}:role/authrim-dr/${ROLES[kind][0]}/authrim-dr-bootstrap-${ROLES[kind][1]}`;
  const checks = [];
  const add = (id, status, message, remediation) =>
    checks.push({ id, status, message, ...(remediation ? { remediation } : {}) });
  const report = () => ({
    formatVersion: 1,
    status: checks.some((check) => ['fail', 'pending'].includes(check.status))
      ? 'blocked'
      : 'passed',
    target: {
      accountId: options.accountId,
      region: options.region,
      phase,
      profile: options.profile ?? null,
    },
    checks,
    writeAuthorization: 'not_proven',
    limitation:
      '読み取りAPIとIAMシミュレーションの結果です。SCP、セッションポリシー、リソースポリシー等により実操作の結果は異なります。変更セットの作成・レビュー・実行時にも権限を確認します。',
  });
  const request = async (args) => {
    let response;
    try {
      response = await invoke('aws', [
        ...args,
        '--region',
        options.region,
        ...(options.profile ? ['--profile', options.profile] : []),
        '--output',
        'json',
        '--no-cli-pager',
        '--cli-connect-timeout',
        '5',
        '--cli-read-timeout',
        '10',
      ]);
    } catch {
      return { error: 'request_failed' };
    }
    if (response.exitCode !== 0) return { error: errorKind(response) };
    try {
      const data = JSON.parse(response.stdout);
      return data && typeof data === 'object' && !Array.isArray(data)
        ? { data }
        : { error: 'invalid_response' };
    } catch {
      return { error: 'invalid_response' };
    }
  };
  const remedies = {
    access_denied: '対象だけに限定した診断用の読取権限を管理者に付与してもらってください。',
    login_required:
      '選択したプロファイルで再ログインしてください。IAM Identity Centerは aws sso login、通常のAWSログインは aws login を使います。',
    mfa_session_required:
      '選択したロールプロファイルでMFA認証が必要です。対話可能な端末でロールへのログインとMFA入力を済ませ、認証済みセッションで診断を再実行してください。この診断ではMFAコードを受け取りません。',
    profile_missing:
      '指定したAWSプロファイルが存在しません。設定済みのプロファイル名を指定してください。',
    endpoint_unreachable:
      'AWSの公開エンドポイントへの接続、DNS、ネットワーク、VPN、プロキシ設定を確認してください。認証情報の作り直しは不要です。',
    proxy_unreachable:
      'プロキシの接続先とネットワーク設定を確認してください。認証情報の作り直しは不要です。',
    tls_failed:
      '端末の時刻、TLS証明書、社内CAとプロキシ設定を確認してください。TLS証明書の検証は無効にしないでください。',
    network_timeout:
      'AWSへの通信がタイムアウトしました。ネットワーク、VPN、プロキシを確認して再実行してください。',
    cli_timeout:
      'AWS CLIが制限時間内に終了しませんでした。CLI、認証プロセス、ネットワークの状態を確認して再実行してください。',
  };
  const failed = (id, error, label) =>
    add(
      id,
      'fail',
      `${label}: ${error}`,
      remedies[error] ?? '対象名と接続先を確認して再実行してください。'
    );

  let version;
  try {
    version = await invoke('aws', ['--version']);
  } catch {
    version = { exitCode: 1, errorCode: 'ENOENT' };
  }
  const match = /aws-cli\/(\d+)\.(\d+)\.(\d+)/u.exec(
    `${version.stdout ?? ''} ${version.stderr ?? ''}`
  );
  if (version.exitCode !== 0 || !match) {
    if (errorKind(version) === 'cli_timeout') {
      failed('cli', 'cli_timeout', 'AWS CLIを確認できません');
      return report();
    }
    add(
      'cli',
      'fail',
      'AWS CLIを実行できません。',
      'AWS CLI v2をインストールし、PATHを確認してください。https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html'
    );
    return report();
  }
  if (Number(match[1]) !== 2) {
    add('cli', 'fail', 'AWS CLI v2が必要です。', 'AWS CLI v2へ更新してください。');
    return report();
  }
  add('cli', 'pass', `AWS CLI ${match.slice(1).join('.')} を確認しました。`);
  if (Number(match[2]) < 32)
    add(
      'cli_login',
      'warning',
      'このAWS CLIは aws login に未対応です。既存の認証方式による診断は続行します。',
      'aws login を利用する場合はAWS CLI 2.32.0以降へ更新してください。'
    );
  add('region', 'pass', `すべてのAPI呼び出しに ${options.region} を明示します。`);
  const identity = await request(['sts', 'get-caller-identity']);
  if (identity.error) {
    failed('identity', identity.error, '認証状態を確認できません');
    return report();
  }
  if (
    identity.data.Account !== options.accountId ||
    typeof identity.data.Arn !== 'string' ||
    typeof identity.data.UserId !== 'string'
  ) {
    add(
      'identity',
      'fail',
      '接続先アカウントが指定値と一致しないか、認証応答が不正です。',
      '対象アカウントに対応するAWSプロファイルを選択してください。'
    );
    return report();
  }
  add('identity', 'pass', `接続先アカウント ${options.accountId} を確認しました。`);
  const root = identity.data.Arn === `arn:${partition}:iam::${options.accountId}:root`;
  if (root)
    add(
      'caller',
      phase === 'bootstrap' ? 'warning' : 'fail',
      '現在の接続はrootです。',
      phase === 'bootstrap'
        ? '初期ロール作成後は専用operatorロールへ切り替えてください。'
        : '日常セットアップには専用operatorロールを引き受けるプロファイルを使用してください。'
    );
  else if (phase === 'bootstrap')
    add('caller', 'warning', 'bootstrap管理者の書込権限は、この読み取り診断では確定しません。');

  const templateName =
    phase === 'bootstrap' ? 'saml-idp-bootstrap-roles.yaml' : `saml-idp-${phase}.yaml`;
  let template;
  try {
    template = await readFile(resolve(ROOT, 'deploy', templateName), 'utf8');
  } catch {
    add('template', 'fail', '同梱のCloudFormationテンプレートを読み込めません。');
    return report();
  }
  const validation = await request([
    'cloudformation',
    'validate-template',
    '--template-body',
    template,
  ]);
  if (validation.error) failed('template', validation.error, 'CloudFormationテンプレート検証');
  else if (!Array.isArray(validation.data.Parameters))
    add('template', 'fail', 'CloudFormationの検証応答が不正です。');
  else add('template', 'pass', 'CloudFormationのテンプレート検証が成功しました。');

  const inspectStack = async (kind, optional) => {
    const response = await request([
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      STACKS[kind],
    ]);
    if (response.error === 'not_found' && optional) {
      add(`stack_${kind}`, 'pass', `${STACKS[kind]} は未作成です。新規作成の対象です。`);
      return null;
    }
    if (response.error) {
      failed(`stack_${kind}`, response.error, `${STACKS[kind]} の参照`);
      return null;
    }
    const stack = response.data.Stacks?.[0];
    if (
      response.data.Stacks?.length !== 1 ||
      stack?.StackName !== STACKS[kind] ||
      !stack.StackId?.startsWith(
        `arn:${partition}:cloudformation:${options.region}:${options.accountId}:stack/${STACKS[kind]}/`
      )
    ) {
      add(`stack_${kind}`, 'fail', 'スタック応答の接続先・名前が一致しません。');
      return null;
    }
    if (!COMPLETE.includes(stack.StackStatus)) {
      add(
        `stack_${kind}`,
        'fail',
        `${STACKS[kind]} は完了状態ではありません。`,
        'CloudFormationイベントを確認し、進行中の処理または失敗を解消してください。'
      );
      return null;
    }
    if (kind !== 'bootstrap' && stack.RoleARN !== roleArn(kind)) {
      add(
        `stack_${kind}`,
        'fail',
        `${STACKS[kind]} の実行ロールが指定の専用ロールと一致しません。`
      );
      return null;
    }
    add(`stack_${kind}`, 'pass', `${STACKS[kind]} の完了状態と接続先を確認しました。`);
    return stack;
  };
  const bootstrap = await inspectStack('bootstrap', phase === 'bootstrap');
  if (phase === 'bootstrap') return report();
  if (!bootstrap) return report();
  const parameters = Object.fromEntries(
    (bootstrap.Parameters ?? []).map((entry) => [entry.ParameterKey, entry.ParameterValue])
  );
  const source = parameters.OperatorPrincipalArn;
  const mode = parameters.OperatorPrincipalMode;
  if (
    !new RegExp(
      `^arn:${partition}:iam::${options.accountId}:${mode === 'iam-user' ? 'user' : 'role'}/[A-Za-z0-9+=,.@_/-]+$`,
      'u'
    ).test(source ?? '') ||
    !['iam-user', 'federated-role'].includes(mode)
  )
    add(
      'operator_binding',
      'fail',
      '担当者ロールが未割当です。',
      'bootstrapのOperatorPrincipalArnに担当者を割り当ててください。'
    );
  else add('operator_binding', 'pass', 'bootstrapに担当者が割り当てられています。');
  const roles = {};
  for (const kind of Object.keys(ROLES)) {
    const result = await request([
      'iam',
      'get-role',
      '--role-name',
      `authrim-dr-bootstrap-${ROLES[kind][1]}`,
    ]);
    if (result.error) {
      failed(`role_${kind}`, result.error, `${kind} ロールの参照`);
      continue;
    }
    const role = result.data.Role;
    if (role?.Arn !== roleArn(kind) || !/^AROA[A-Z0-9]+$/u.test(role.RoleId ?? '')) {
      add(`role_${kind}`, 'fail', `${kind} ロールのARNまたはIDが一致しません。`);
      continue;
    }
    roles[kind] = role;
    if (!(kind === 'operator' ? operatorTrust(role, source, mode) : serviceTrust(role)))
      add(
        `role_${kind}`,
        'fail',
        `${kind} ロールの信頼ポリシーが期待した設定と一致しません。`,
        'bootstrapテンプレートと実際の信頼ポリシーを確認してください。'
      );
    else add(`role_${kind}`, 'pass', `${kind} ロールと信頼ポリシーを確認しました。`);
  }
  const expectedSessionArn = `arn:${partition}:sts::${options.accountId}:assumed-role/authrim-dr-bootstrap-operator/`;
  if (
    !root &&
    (!identity.data.Arn.startsWith(expectedSessionArn) ||
      !roles.operator ||
      !identity.data.UserId.startsWith(`${roles.operator.RoleId}:`) ||
      identity.data.UserId.length <= roles.operator.RoleId.length + 1)
  )
    add(
      'caller',
      'fail',
      '接続は専用operatorロールの有効なセッションではありません。',
      '専用operatorロールを引き受けるAWSプロファイルを選択してください。'
    );
  else if (!root) add('caller', 'pass', '専用operatorロールの実際のセッションを確認しました。');
  if (
    mode === 'iam-user' &&
    typeof source === 'string' &&
    source.startsWith(`arn:${partition}:iam::${options.accountId}:user/`)
  ) {
    const mfa = await request(['iam', 'list-mfa-devices', '--user-name', source.split('/').at(-1)]);
    if (mfa.error) failed('mfa', mfa.error, '担当者のMFA確認');
    else if (!Array.isArray(mfa.data.MFADevices) || mfa.data.MFADevices.length === 0)
      add(
        'mfa',
        'fail',
        '担当者のIAMユーザーにMFAが登録されていません。',
        '担当者がAWSコンソールでMFAを登録してから、専用ロールへログインしてください。'
      );
    else add('mfa', 'pass', '担当者のIAMユーザーにMFAが登録されています。');
  }
  const foundation = await inspectStack('foundation', phase === 'foundation');
  if (phase === 'workload' && !foundation) return report();
  const stack = phase === 'workload' ? await inspectStack('workload', true) : foundation;
  if (roles.operator && !checks.some((check) => check.id === 'caller' && check.status === 'fail')) {
    const resource =
      stack?.StackId ??
      `arn:${partition}:cloudformation:${options.region}:${options.accountId}:stack/${STACKS[phase]}/preflight`;
    const probes = [
      {
        id: 'permissions_create',
        actions: ['cloudformation:CreateChangeSet'],
        resource,
        context: [
          {
            ContextKeyName: 'cloudformation:RoleArn',
            ContextKeyValues: [roleArn(phase)],
            ContextKeyType: 'string',
          },
        ],
      },
      {
        id: 'permissions_changes',
        actions: [
          'cloudformation:ExecuteChangeSet',
          'cloudformation:DescribeChangeSet',
          'cloudformation:DescribeStacks',
        ],
        resource,
        context: [],
      },
      {
        id: 'permissions_passrole',
        actions: ['iam:PassRole'],
        resource: roleArn(phase),
        context: [
          {
            ContextKeyName: 'iam:PassedToService',
            ContextKeyValues: ['cloudformation.amazonaws.com'],
            ContextKeyType: 'string',
          },
        ],
      },
    ];
    for (const probe of probes) {
      const result = await request([
        'iam',
        'simulate-principal-policy',
        '--policy-source-arn',
        roleArn('operator'),
        '--action-names',
        ...probe.actions,
        '--resource-arns',
        probe.resource,
        '--context-entries',
        JSON.stringify([
          {
            ContextKeyName: 'aws:RequestedRegion',
            ContextKeyValues: [options.region],
            ContextKeyType: 'string',
          },
          ...probe.context,
        ]),
      ]);
      if (result.error) {
        add(
          probe.id,
          result.error === 'access_denied' ? 'pending' : 'fail',
          `必要権限のシミュレーションを完了できません: ${result.error}`,
          '専用operatorロールに対するiam:SimulatePrincipalPolicyの診断権限を確認してください。未確認のまま配置へ進みません。'
        );
        continue;
      }
      const evaluations = result.data.EvaluationResults;
      const allowed =
        Array.isArray(evaluations) &&
        evaluations.length === probe.actions.length &&
        probe.actions.every(
          (action) =>
            evaluations.filter(
              (entry) =>
                entry.EvalActionName === action &&
                entry.EvalResourceName === probe.resource &&
                entry.EvalDecision === 'allowed' &&
                (entry.MissingContextValues?.length ?? 0) === 0 &&
                entry.PermissionsBoundaryDecisionDetail?.AllowedByPermissionsBoundary !== false &&
                entry.OrganizationsDecisionDetail?.AllowedByOrganizations !== false
            ).length === 1
        );
      add(
        probe.id,
        allowed ? 'pass' : 'fail',
        allowed
          ? '対象操作・対象リソースの権限シミュレーションは許可でした（参考判定）。'
          : '必要な操作の権限が拒否・未確認、または応答が不正です。',
        allowed
          ? undefined
          : '専用ロールの対象スタック・service role・条件を確認してください。管理者権限を一律に追加しないでください。'
      );
    }
  } else
    add(
      'permissions',
      'pending',
      '専用operatorロールのセッションを確認できないため、権限診断を完了できません。'
    );
  return report();
}

export function formatAwsPreflight(report) {
  const marks = { pass: 'OK', fail: 'NG', warning: '注意', pending: '未確認' };
  return `${report.status === 'passed' ? 'AWS事前診断が完了しました。' : 'AWSセットアップを続行できません。'}\n${report.checks.map((check) => `[${marks[check.status]}] ${check.message}${check.remediation ? `\n  ${check.remediation}` : ''}`).join('\n')}\n${report.limitation}\n`;
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(HELP);
    return;
  }
  const options = {};
  let json = false;
  const names = {
    '--account-id': 'accountId',
    '--region': 'region',
    '--profile': 'profile',
    '--phase': 'phase',
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json' && !json) {
      json = true;
      continue;
    }
    if (!names[flag] || options[names[flag]] !== undefined || args[index + 1] === undefined)
      throw new Error('aws_preflight_options_invalid');
    options[names[flag]] = args[++index];
  }
  const result = await runAwsPreflight(options);
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : formatAwsPreflight(result));
  process.exitCode = result.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write(`aws_preflight_options_invalid\n${HELP}`);
    process.exitCode = 2;
  });
}
