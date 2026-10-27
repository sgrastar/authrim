import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { AWS_SETUP_SCRIPT, getAwsSetupMarkup } from '../web/aws-setup-ui.js';

const RUN_ID = '12345678-1234-1234-1234-123456789abc';
const PLAN_HASH = 'a'.repeat(64);
const target = { accountId: '123456789012', region: 'ap-northeast-1' };
const pgPlan = {
  planSha256: PLAN_HASH,
  target,
  backend: 'aws',
  database: 'postgresql',
  role: 'secondary',
  mode: 'browser-rehearsal',
  stages: ['foundation', 'restore', 'complete'],
  stacks: ['bootstrap', 'foundation', 'access', 'database', 'workload'].map((stage) => ({
    stage,
    name: 'authrim-test-' + stage,
    disposition: stage === 'bootstrap' ? 'reuse' : 'create',
  })),
  identities: {
    bootstrap: {
      profile: 'test-bootstrap',
      principalArn: 'arn:aws:iam::123456789012:role/test-bootstrap',
    },
    operator: {
      profile: 'test-operator',
      principalArn: 'arn:aws:iam::123456789012:role/test-operator',
    },
  },
};
const dsqlPlan = {
  ...pgPlan,
  database: 'aurora-dsql',
  mode: 'identity-evaluation',
  stages: ['identity-probe'],
  hostname: 'example.dsql.ap-northeast-1.on.aws',
  fullRuntimeReady: false,
  profile: 'test-dsql',
  principalArn: 'arn:aws:iam::123456789012:role/test-dsql',
};

class Element {
  value = '';
  textContent = '';
  disabled = false;
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, () => unknown>();
  classes = new Set<string>();
  href = '';
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force: boolean) =>
      force ? this.classes.add(name) : this.classes.delete(name),
  };
  appendChild(child: Element) {
    this.children.push(child);
    return child;
  }
  replaceChildren() {
    this.children = [];
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(name: string, callback: () => unknown) {
    this.listeners.set(name, callback);
  }
}

function harness(savedId: string | null = null) {
  const elements = new Map<string, Element>();
  const element = (id: string): Element => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const api = vi.fn();
  const storage = { getItem: vi.fn(() => savedId), setItem: vi.fn() };
  const timers = new Map<number, () => unknown>();
  let nextTimer = 0;
  const context = vm.createContext({
    _currentLocale: 'ja',
    selectedSetupPlatform: 'aws',
    api,
    Error,
    URL,
    localStorage: storage,
    document: {
      getElementById: element,
      createElement: () => new Element(),
      querySelectorAll: () => [],
    },
    setTimeout: (callback: () => unknown) => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  element('aws-database').value = 'postgresql';
  element('aws-auth-state').value = 'postgresql';
  element('aws-account').value = target.accountId;
  element('aws-region').value = target.region;
  element('aws-profile').value = 'test-operator';
  element('aws-config-path').value = '/tmp/public-config.json';
  element('aws-users').value = '1001';
  vm.runInContext(AWS_SETUP_SCRIPT, context);
  const run = <T = unknown>(source: string): T => vm.runInContext(source, context);
  run('initializeAwsSetup()');
  return { api, storage, timers, context, element, run };
}

function view(status: string, plan: Record<string, unknown> = pgPlan) {
  return { runId: RUN_ID, status, plan };
}

async function prepare(h: ReturnType<typeof harness>, plan: Record<string, unknown> = pgPlan) {
  h.api.mockResolvedValueOnce({ runId: RUN_ID, status: 'planning' });
  h.api.mockResolvedValueOnce(view('planned', plan));
  await h.run('planAwsSetup()');
}

function textTree(element: Element): string {
  return element.textContent + element.children.map(textTree).join('\n');
}

describe('AWS setup browser workflow', () => {
  it('shows configuration evaluation failures alongside identity checks without claiming completion', () => {
    const h = harness();
    h.context.configurationView = {
      ...view('blocked', dsqlPlan),
      result: {
        checks: [{ name: 'native-uniqueness-enforced', passed: true }],
        restoredRows: { 'core.users_core': 1001 },
        cleanup: 'complete',
        configurationReport: {
          checks: [{ name: 'native-foreign-key-enforced', passed: false }],
          restoredRows: { 'core.flows': 101 },
          cleanup: 'failed',
        },
      },
    };
    h.run('renderAwsSetupView(configurationView)');
    const result = textTree(h.element('aws-result'));
    expect(result).toContain('native-uniqueness-enforced: ✓');
    expect(result).toContain('Flow・SAML SP設定の検証結果');
    expect(result).toContain('native-foreign-key-enforced: ×');
    expect(result).toContain('core.flows: 101');
    expect(result).toContain('試験データの後片付け: failed');
    expect(result).not.toContain('適合性検証が完了');
  });

  it('explains generated configuration and existing file input in both database modes', () => {
    const h = harness();
    for (const database of ['postgresql', 'aurora-dsql']) {
      h.element('aws-database').value = database;
      h.element('aws-config-source').value = 'create';
      h.run('refreshAwsSetupCopy()');
      expect(h.element('aws-config-help').textContent).toContain('入力内容から設定ファイルを生成');
      h.element('aws-config-source').value = 'file';
      h.run('updateAwsConfigurationVisibility()');
      expect(h.element('aws-config-help').textContent).toContain('絶対パスで指定');
    }
    h.element('aws-config-source').value = 'create';
    h.run("_currentLocale = 'en'; refreshAwsSetupCopy()");
    expect(h.element('aws-config-help').textContent).toContain('created from this form');
    expect(h.api).not.toHaveBeenCalled();
  });

  it('creates public configuration before planning and preserves independent UI choices', async () => {
    const h = harness();
    h.element('aws-config-source').value = 'create';
    h.element('aws-deployment-name').value = 'new-test';
    h.element('aws-deployment-mode').value = 'browser-rehearsal';
    h.element('aws-deployment-role').value = 'secondary';
    h.element('aws-bootstrap-principal').value = 'arn:aws:iam::123456789012:user/operator';
    h.element('aws-operator-profile').value = 'assumed-operator';
    h.element('aws-ca-bundle').value = '/tmp/ca.pem';
    h.element('aws-s3-prefix-list').value = 'pl-12345678';
    h.element('aws-login-ui-mode').value = 'disabled';
    h.element('aws-admin-ui-mode').value = 'external';
    h.element('aws-external-admin-url').value = 'https://admin.example.test';
    h.api.mockResolvedValueOnce({
      status: 'configured',
      database: 'postgresql',
      configPath: '/managed/config.json',
      configSha256: PLAN_HASH,
    });
    h.api.mockResolvedValueOnce({ runId: RUN_ID, status: 'planning' });
    h.api.mockResolvedValueOnce(view('planned'));
    await h.run('planAwsSetup()');
    expect(h.api.mock.calls[0]).toEqual([
      '/aws/configuration',
      {
        method: 'POST',
        body: {
          configuration: {
            database: 'postgresql',
            ...target,
            name: 'new-test',
            role: 'secondary',
            mode: 'browser-rehearsal',
            bootstrapProfile: 'test-operator',
            bootstrapPrincipalArn: 'arn:aws:iam::123456789012:user/operator',
            operatorProfile: 'assumed-operator',
            caBundlePath: '/tmp/ca.pem',
            s3GatewayPrefixListId: 'pl-12345678',
            authState: { backend: 'postgresql' },
            components: { loginUi: false, adminUi: false },
            ui: {
              login: { mode: 'disabled' },
              admin: { mode: 'external', baseUrl: 'https://admin.example.test' },
            },
          },
        },
      },
    ]);
    expect(h.api.mock.calls[1][1].body.configPath).toBe('/managed/config.json');
    expect(h.api.mock.calls.some(([path]) => String(path).endsWith('/apply'))).toBe(false);
    h.element('aws-deployment-role').value = 'primary';
    h.run('updateAwsConfigurationVisibility()');
    expect(h.element('aws-login-ui-mode').value).toBe('disabled');
    expect(h.element('aws-admin-ui-mode').value).toBe('external');
    h.element('aws-auth-state').value = 'dynamodb';
    h.element('aws-dynamo-prefix-list').value = 'pl-87654321';
    h.run('updateAwsConfigurationVisibility()');
    expect(h.element('aws-dynamo-fields').classes.has('hidden')).toBe(false);
    expect(h.run('awsConfigurationInput()')).toMatchObject({
      authState: { backend: 'dynamodb' },
      dynamoDbGatewayPrefixListId: 'pl-87654321',
    });
  });
  it('explains incompatible embedded UI without silently changing the selected UI', async () => {
    const h = harness();
    h.element('aws-config-source').value = 'create';
    h.element('aws-deployment-mode').value = 'existing-issuer';
    h.element('aws-login-ui-mode').value = 'embedded-rehearsal';
    await h.run('planAwsSetup()');
    expect(h.api).not.toHaveBeenCalled();
    expect(h.element('aws-login-ui-mode').value).toBe('embedded-rehearsal');
    expect(h.element('aws-message').textContent).toContain('外部ログイン画面');
  });
  it('renders both database choices and explicit actions with Japanese and English copy', () => {
    const ja = getAwsSetupMarkup('ja');
    const fallback = getAwsSetupMarkup('fr');
    expect(ja).toContain('value="postgresql"');
    expect(ja).toContain('value="aurora-dsql"');
    expect(ja).toContain('開発中・適合性検証用');
    expect(ja).toContain('id="btn-aws-apply"');
    expect(ja).toContain('id="btn-aws-verify"');
    expect(fallback).toContain('Choose an AWS database path');
    expect(ja).not.toContain('type="password"');
  });

  it('does not contact a provider or resume a write when the page opens', () => {
    const h = harness(RUN_ID);
    expect(h.api).not.toHaveBeenCalled();
    expect(h.element('aws-run-id').value).toBe(RUN_ID);
    expect(h.storage.setItem).not.toHaveBeenCalled();
    expect(h.timers.size).toBe(0);
  });

  it('builds and reviews a pinned PostgreSQL plan without applying it', async () => {
    const h = harness();
    await prepare(h);
    expect(h.api.mock.calls).toEqual([
      ['/aws/plan', { method: 'POST', body: { configPath: '/tmp/public-config.json', ...target } }],
      ['/aws/operations/' + RUN_ID + '/status', { method: 'POST', body: {} }],
    ]);
    expect(h.element('aws-plan-review').classes.has('hidden')).toBe(false);
    expect(h.element('btn-aws-apply').classes.has('hidden')).toBe(false);
    expect(textTree(h.element('aws-plan-summary'))).toContain(PLAN_HASH);
    const identities = textTree(h.element('aws-plan-identities'));
    expect(identities).toContain('test-bootstrap');
    expect(identities).toContain('arn:aws:iam::123456789012:role/test-operator');
    const stacks = textTree(h.element('aws-plan-stacks'));
    expect(stacks).toContain('authrim-test-foundation');
    expect(stacks).toContain('新規作成');
    expect(stacks).toContain('既存を利用');
    expect(h.element('aws-message').textContent).toContain('計画を作成しました');
    expect(h.element('aws-message').textContent).not.toContain('計画を準備しています');
    expect(h.storage.setItem.mock.calls).toEqual([['authrim_aws_setup_run_v1', RUN_ID]]);
    expect(h.timers.size).toBe(0);
  });

  it('requires an explicit start and sends the exact reviewed fingerprint', async () => {
    const h = harness();
    await prepare(h);
    h.api.mockResolvedValueOnce({ runId: RUN_ID, status: 'running' });
    h.api.mockResolvedValueOnce(view('complete'));
    await h.run("startAwsSetup('apply')");
    expect(h.api).toHaveBeenNthCalledWith(3, '/aws/operations/' + RUN_ID + '/apply', {
      method: 'POST',
      body: { planSha256: PLAN_HASH },
    });
    expect(textTree(h.element('aws-result'))).toContain('実ブラウザー');
    expect(h.element('btn-aws-apply').classes.has('hidden')).toBe(true);
    await h.run("startAwsSetup('apply')");
    expect(h.api).toHaveBeenCalledTimes(4);
  });

  it.each([
    { status: 'blocked', code: 'plan_digest_mismatch' },
    { code: 'session_token_required' },
    { success: false, code: 'same_origin_required' },
    { runId: RUN_ID, status: 'blocked', code: 'operation_blocked' },
  ])('shows a rejected start without polling away its diagnostic: $code', async (error) => {
    const h = harness();
    await prepare(h);
    h.api.mockResolvedValueOnce(error);
    await h.run("startAwsSetup('apply')");
    expect(h.api).toHaveBeenCalledTimes(3);
    expect(h.element('aws-message').textContent).toContain(error.code);
    expect(h.element('btn-aws-apply').disabled).toBe(false);
    expect(h.timers.size).toBe(0);
  });

  it.each(['account', 'region', 'database'])(
    'prevents applying a plan after the selected %s changes',
    async (field) => {
      const h = harness();
      await prepare(h);
      h.element('aws-' + field).value =
        field === 'database' ? 'aurora-dsql' : field === 'account' ? '999999999999' : 'us-east-1';
      await h.run("startAwsSetup('apply')");
      expect(h.api).toHaveBeenCalledTimes(2);
      expect(h.element('aws-message').textContent).toContain('一致しません');
    }
  );

  it('clears the reviewed operation when a form input changes', async () => {
    const h = harness();
    await prepare(h);
    h.element('aws-database').value = 'aurora-dsql';
    h.element('aws-database').listeners.get('change')!();
    await h.run("startAwsSetup('apply')");
    expect(h.api).toHaveBeenCalledTimes(2);
    expect(h.element('aws-plan-review').classes.has('hidden')).toBe(true);
    expect(h.element('aws-database-scope').textContent).toContain(
      'SAMLログインの有効化は行いません'
    );
  });

  it('rejects a malformed or missing plan fingerprint before exposing an action', async () => {
    const h = harness();
    h.api.mockResolvedValueOnce({ runId: RUN_ID, status: 'planning' });
    h.api.mockResolvedValueOnce(view('planned', { ...pgPlan, planSha256: '' }));
    await h.run('planAwsSetup()');
    await h.run("startAwsSetup('apply')");
    expect(h.api).toHaveBeenCalledTimes(2);
    expect(h.element('aws-plan-review').classes.has('hidden')).toBe(true);
    expect(h.element('aws-message').textContent).toContain('plan_invalid');
  });

  it.each([
    { ...pgPlan, identities: undefined },
    { ...pgPlan, stacks: [] },
    { ...pgPlan, mode: 'existing-issuer' },
    { ...dsqlPlan, profile: undefined },
    { ...dsqlPlan, principalArn: undefined },
  ])('refuses to start when concrete review scope is incomplete', async (plan) => {
    const h = harness();
    h.element('aws-database').value = plan.database;
    await prepare(h, plan);
    await h.run("startAwsSetup('apply')");
    await h.run("startAwsSetup('verify')");
    expect(h.api).toHaveBeenCalledTimes(2);
    expect(h.element('aws-plan-review').classes.has('hidden')).toBe(true);
    expect(h.element('aws-message').textContent).toContain('plan_scope_missing');
  });

  it('shows the existing issuer hostname as part of the reviewed target', async () => {
    const h = harness();
    await prepare(h, { ...pgPlan, mode: 'existing-issuer', issuerHost: 'idp.example.com' });
    expect(textTree(h.element('aws-plan-summary'))).toContain('idp.example.com');
    expect(h.element('btn-aws-apply').classes.has('hidden')).toBe(false);
  });

  it('checks only the AWS connection and does not claim that write permissions passed', async () => {
    const h = harness();
    h.api.mockResolvedValue({
      status: 'passed',
      checks: [{ id: 'aws-cli', status: 'passed', code: 'available' }],
      permissionsVerified: false,
      writeAuthorization: 'not_proven',
    });
    await h.run('checkAwsSetupConnection()');
    expect(h.api).toHaveBeenCalledExactlyOnceWith('/aws/check', {
      method: 'POST',
      body: { ...target, profile: 'test-operator' },
    });
    expect(h.element('aws-message').textContent).toContain('書込権限は実行時');
    expect(h.storage.setItem).not.toHaveBeenCalled();
  });

  it('checks DSQL separately and requires a bounded explicit synthetic evaluation', async () => {
    const h = harness();
    h.element('aws-database').value = 'aurora-dsql';
    await prepare(h, dsqlPlan);
    expect(h.api).toHaveBeenNthCalledWith(1, '/aws/dsql/check', {
      method: 'POST',
      body: { ...target, profile: 'test-operator', configPath: '/tmp/public-config.json' },
    });
    expect(h.element('btn-aws-apply').classes.has('hidden')).toBe(true);
    expect(h.element('btn-aws-verify').classes.has('hidden')).toBe(false);
    expect(textTree(h.element('aws-plan-identities'))).toContain(
      'arn:aws:iam::123456789012:role/test-dsql'
    );
    expect(h.element('aws-plan-stacks-section').classes.has('hidden')).toBe(true);
    await h.run("startAwsSetup('apply')");
    expect(h.api).toHaveBeenCalledTimes(2);
    h.element('aws-users').value = '2001';
    await h.run("startAwsSetup('verify')");
    expect(h.api).toHaveBeenCalledTimes(2);
    h.element('aws-users').value = '1001';
    h.api.mockResolvedValueOnce({ runId: RUN_ID, status: 'running' });
    h.api.mockResolvedValueOnce(view('complete', dsqlPlan));
    await h.run("startAwsSetup('verify')");
    expect(h.api).toHaveBeenNthCalledWith(3, '/aws/operations/' + RUN_ID + '/verify', {
      method: 'POST',
      body: { planSha256: PLAN_HASH, userCount: 1001 },
    });
    expect(textTree(h.element('aws-result'))).toContain('SAMLランタイムはまだ有効化できません');
    await h.run("startAwsSetup('verify')");
    expect(h.api).toHaveBeenCalledTimes(4);
  });

  it('loads and resumes a saved PostgreSQL operation using the server-pinned configuration', async () => {
    const h = harness(RUN_ID);
    h.element('aws-account').value = '';
    h.element('aws-profile').value = '';
    h.element('aws-config-path').value = '';
    h.api.mockResolvedValueOnce(view('inProgress'));
    await h.run('loadAwsSetupOperation()');
    expect(h.element('aws-account').value).toBe(target.accountId);
    expect(h.element('btn-aws-resume').classes.has('hidden')).toBe(false);
    h.api.mockResolvedValueOnce({ runId: RUN_ID, status: 'running' });
    h.api.mockResolvedValueOnce(view('inProgress'));
    await h.run("startAwsSetup('resume')");
    expect(h.api).toHaveBeenNthCalledWith(2, '/aws/operations/' + RUN_ID + '/resume', {
      method: 'POST',
      body: { planSha256: PLAN_HASH },
    });
    expect(h.timers.size).toBe(0);
  });

  it('polls only active work and leaves waiting or blocked operations for explicit resume', async () => {
    const h = harness();
    h.api.mockResolvedValueOnce({ runId: RUN_ID, status: 'planning' });
    h.api.mockResolvedValueOnce(view('planning'));
    await h.run('planAwsSetup()');
    expect(h.timers.size).toBe(1);
    expect(h.element('btn-aws-plan').disabled).toBe(true);
    h.api.mockResolvedValueOnce(view('blocked'));
    await h.run('pollAwsSetup(awsSetupState.runId, awsSetupState.epoch)');
    expect(h.timers.size).toBe(0);
    expect(h.element('btn-aws-plan').disabled).toBe(false);
    expect(h.api.mock.calls.every(([path]) => !path.endsWith('/apply'))).toBe(true);
  });

  it('stops polling when leaving AWS and resumes observation on re-entry without any write', async () => {
    const h = harness();
    await prepare(h);
    h.context.selectedSetupPlatform = null;
    h.api.mockResolvedValueOnce(view('running'));
    await h.run('pollAwsSetup(awsSetupState.runId, awsSetupState.epoch)');
    expect(h.timers.size).toBe(0);
    h.context.selectedSetupPlatform = 'aws';
    h.api.mockResolvedValueOnce(view('running'));
    h.run('initializeAwsSetup()');
    await new Promise(setImmediate);
    expect(h.timers.size).toBe(1);
    expect(h.api.mock.calls.every(([path]) => !path.endsWith('/apply'))).toBe(true);
  });

  it('ignores stale status responses after changing the plan', async () => {
    const h = harness();
    await prepare(h);
    let resolve: ((value: unknown) => void) | undefined;
    h.api.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const pending = h.run('pollAwsSetup(awsSetupState.runId, awsSetupState.epoch)');
    h.run('awsClearPlan()');
    resolve!(view('planned'));
    await pending;
    expect(h.element('aws-plan-review').classes.has('hidden')).toBe(true);
    expect(h.timers.size).toBe(0);
  });

  it('does not fetch malformed saved IDs or expose arbitrary server error text', async () => {
    const h = harness();
    h.element('aws-run-id').value = '../../cloudflare';
    await h.run('loadAwsSetupOperation()');
    expect(h.api).not.toHaveBeenCalled();
    h.api.mockResolvedValueOnce({ error: 'secret', code: '<img src=x onerror=alert(1)>' });
    await h.run('checkAwsSetupConnection()');
    expect(h.element('aws-message').textContent).not.toContain('secret');
    expect(h.element('aws-message').textContent).not.toContain('<img');
    expect(h.element('btn-aws-check').disabled).toBe(false);
  });

  it('renders result values as text and links only HTTPS URLs without embedded credentials', async () => {
    const h = harness(RUN_ID);
    h.api.mockResolvedValueOnce({
      ...view('complete'),
      currentStage: '<img src=x onerror=alert(1)>',
      origin: 'javascript:alert(1)',
      testSpUrl: 'https://user:secret@example.com/',
    });
    await h.run('loadAwsSetupOperation()');
    expect(h.element('aws-operation-status').textContent).toContain('<img');
    expect(h.element('aws-operation-status').children).toHaveLength(0);
    expect(h.element('aws-result').children.filter((child) => child.href)).toHaveLength(0);
  });
});
