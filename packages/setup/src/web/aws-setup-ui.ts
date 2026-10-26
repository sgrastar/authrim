/** AWS-only browser workflow. Cloudflare setup keeps its existing state and routes. */
import {
  AWS_CONFIGURATION_EN,
  AWS_CONFIGURATION_JA,
  AWS_CONFIGURATION_SCRIPT,
  getAwsConfigurationMarkup,
} from './aws-configuration-ui.js';
const EN = {
  ...AWS_CONFIGURATION_EN,
  title: 'Choose an AWS database path',
  intro: 'Check the connection, review the plan, then start or resume the selected operation.',
  database: 'Database',
  postgres: 'PostgreSQL — SAML DR',
  dsql: 'Aurora DSQL — development / compatibility evaluation',
  postgresScope:
    'Use the existing PostgreSQL SAML DR setup, including initialization, restoration and deployment.',
  dsqlScope:
    'Evaluate three identity tables and four Flow/SAML SP configuration tables on an existing DSQL cluster with synthetic data. This does not deploy a cluster or enable SAML login.',
  account: 'Expected AWS account ID',
  region: 'AWS region',
  profile: 'Signed-in AWS profile',
  profileHelp:
    'Use a profile already signed in on this computer. Passwords and access keys are not entered here.',
  config: 'Public deployment configuration file',
  dsqlConfig: 'DSQL connection configuration file',
  configHelp:
    'Enter the absolute path to an existing public configuration file. The deployment configuration selects the bootstrap and operator profiles.',
  dsqlConfigHelp:
    'Enter the absolute path to the existing connection JSON. It contains the DSQL hostname, region and database user, never credentials.',
  check: 'Check AWS connection',
  plan: 'Prepare deployment plan',
  dsqlPlan: 'Check DSQL and prepare evaluation',
  review: 'Review the selected operation',
  planHash: 'Plan fingerprint',
  target: 'Target',
  mode: 'Operation',
  role: 'Deployment role',
  stages: 'Steps',
  hostname: 'Existing DSQL endpoint',
  issuerHost: 'Existing issuer hostname',
  identities: 'AWS identities used for this operation',
  bootstrapIdentity: 'Initial setup identity',
  operatorIdentity: 'Deployment identity',
  evaluationIdentity: 'DSQL evaluation identity',
  identityProfile: 'Profile',
  identityArn: 'IAM identity',
  stacks: 'CloudFormation stacks in this plan',
  stackName: 'Stack name',
  stackAction: 'Planned action',
  create: 'Create',
  reuse: 'Reuse',
  start: 'Start the reviewed deployment',
  resume: 'Continue the saved deployment',
  verify: 'Evaluate with synthetic data',
  users: 'Synthetic users (1–2,000)',
  saved: 'Saved operation ID',
  load: 'Load saved operation',
  progress: 'Operation status',
  noOperation: 'No operation has started.',
  planning: 'Preparing the plan…',
  planned: 'Plan ready. Review the target and steps before starting.',
  running: 'Running. Closing this browser tab does not cancel the operation.',
  inProgress: 'A step is waiting for AWS. Continue the same saved deployment.',
  complete: 'The operation completed.',
  blocked: 'The operation is blocked. Review the result before continuing.',
  interrupted: 'Observation was interrupted. Load or continue the same saved operation.',
  connectionPassed:
    'AWS CLI, login and target connection checked. Deployment write permissions are checked during execution.',
  connectionBlocked: 'AWS connection checks need attention.',
  error: 'The request could not be completed. Check the inputs and the saved operation.',
  mismatch:
    'The returned plan does not match the selected database, account or region. Prepare a new plan.',
  invalid: 'Enter a valid account, region, profile and absolute configuration path.',
  invalidRun: 'Enter a valid saved operation ID.',
  changed: 'The inputs changed. Prepare a new plan before starting.',
  pending: 'Waiting',
  result: 'Verification result',
  configurationResult: 'Flow and SAML SP configuration result',
  browserPending:
    'Deployment completion does not verify a real browser login. Open the test URL for that check.',
  dsqlNotReady:
    'Identity and Flow/SAML SP configuration compatibility checks are complete. SAML runtime activation remains unavailable.',
  openOrigin: 'Open the deployed URL',
  openSp: 'Open the test SP',
  cleanup: 'Test data cleanup',
  stage_bootstrap: 'Prepare deployment roles',
  stage_foundation: 'Create the AWS foundation',
  stage_access: 'Configure deployment access',
  stage_endpoint: 'Prepare public HTTPS',
  'stage_access-bind': 'Connect deployment permissions',
  stage_prepare: 'Prepare runtime files and restore data',
  stage_upload: 'Upload runtime files',
  stage_database: 'Deploy database preparation tasks',
  stage_initialize: 'Initialize the database',
  stage_restore: 'Restore the backup',
  stage_verify: 'Verify restored data',
  'stage_sp-prepare': 'Prepare the test service provider',
  stage_manifest: 'Prepare the deployment manifest',
  'stage_runtime-bind': 'Connect runtime settings',
  stage_workload: 'Deploy the SAML runtime',
  stage_complete: 'Check deployment completion',
  'stage_identity-probe': 'Evaluate three identity tables with synthetic data',
  'stage_configuration-probe': 'Evaluate four Flow and SAML SP configuration tables',
  'mode_browser-rehearsal': 'SAML browser rehearsal with test data',
  'mode_existing-issuer': 'DR deployment for the existing issuer',
  role_primary: 'Primary',
  role_secondary: 'Secondary',
} as const;

const JA: Record<keyof typeof EN, string> = {
  ...AWS_CONFIGURATION_JA,
  title: 'AWSで利用するDBを選択',
  intro: '接続を確認し、計画の内容を確認してから構築・再開を実行します。',
  database: 'データベース',
  postgres: 'PostgreSQL — SAML DR',
  dsql: 'Aurora DSQL — 開発中・適合性検証用',
  postgresScope: '既存のPostgreSQL向けSAML DRセットアップで、初期化・復元・配置を進めます。',
  dsqlScope:
    '既存のDSQLクラスターで、合成データを使いユーザー関連3表とFlow・SAML SP設定4表を検証します。クラスターの新規構築やSAMLログインの有効化は行いません。',
  account: '接続先のAWSアカウントID',
  region: 'AWSリージョン',
  profile: 'ログイン済みのAWSプロファイル',
  profileHelp:
    'このPCでログイン済みのプロファイルを使います。パスワードやアクセスキーの入力は不要です。',
  config: '公開パラメーターを含む構築設定ファイル',
  dsqlConfig: 'DSQL接続設定ファイル',
  configHelp:
    '既存の構築設定ファイルを絶対パスで指定します。初期構築用と作業者用のプロファイルは、この設定ファイルで指定します。',
  dsqlConfigHelp:
    '既存の接続設定JSONを絶対パスで指定します。ホスト名・リージョン・DBユーザーだけを記載し、認証情報は含めません。',
  check: 'AWS接続を確認',
  plan: '構築計画を作成',
  dsqlPlan: 'DSQLを確認して検証を準備',
  review: '実行する内容を確認',
  planHash: '計画の識別情報',
  target: '接続先',
  mode: '処理内容',
  role: '配置の役割',
  stages: '実行する手順',
  hostname: '既存のDSQL接続先',
  issuerHost: '既存の発行者のホスト名',
  identities: 'この処理で使うAWSの接続情報',
  bootstrapIdentity: '初期構築用',
  operatorIdentity: '構築作業用',
  evaluationIdentity: 'DSQL検証用',
  identityProfile: 'プロファイル',
  identityArn: 'IAMの接続主体',
  stacks: 'この計画で扱うCloudFormationスタック',
  stackName: 'スタック名',
  stackAction: '予定している操作',
  create: '新規作成',
  reuse: '既存を利用',
  start: '確認した計画で構築を開始',
  resume: '保存済みの構築を続ける',
  verify: '合成データで検証',
  users: '合成ユーザー数（1〜2,000）',
  saved: '保存済みの処理ID',
  load: '保存済みの処理を読み込む',
  progress: '処理の状態',
  noOperation: 'まだ処理を開始していません。',
  planning: '計画を準備しています…',
  planned: '計画を作成しました。接続先と手順を確認してから開始してください。',
  running: '実行中です。このブラウザーのタブを閉じても処理は取り消されません。',
  inProgress: 'AWS側の処理を待っています。同じ保存済みの構築を続けてください。',
  complete: '処理が完了しました。',
  blocked: '処理が停止しています。結果を確認してから続けてください。',
  interrupted: '状態の取得が中断しました。同じ保存済みの処理を読み込むか、再開してください。',
  connectionPassed:
    'AWS CLI・ログイン・接続先を確認しました。構築に必要な書込権限は実行時にも確認します。',
  connectionBlocked: 'AWS接続の確認結果を確認してください。',
  error: '処理を進められませんでした。入力内容と保存済みの処理を確認してください。',
  mismatch: '計画のDB・アカウント・リージョンが選択内容と一致しません。計画を作り直してください。',
  invalid: 'アカウントID・リージョン・プロファイル・設定ファイルの絶対パスを確認してください。',
  invalidRun: '保存済みの処理IDを確認してください。',
  changed: '入力内容が変わりました。開始する前に計画を作り直してください。',
  pending: '待機中',
  result: '検証結果',
  configurationResult: 'Flow・SAML SP設定の検証結果',
  browserPending:
    '構築完了は実ブラウザーでのログイン成功を意味しません。テストURLから別途確認してください。',
  dsqlNotReady:
    'ユーザー関連とFlow・SAML SP設定の適合性検証が完了しました。SAMLランタイムはまだ有効化できません。',
  openOrigin: '配置したURLを開く',
  openSp: 'テストSPを開く',
  cleanup: '試験データの後片付け',
  stage_bootstrap: '構築用のロールを準備',
  stage_foundation: 'AWSの基盤を作成',
  stage_access: '構築に必要なアクセス権を設定',
  stage_endpoint: '公開HTTPSを準備',
  'stage_access-bind': '構築対象とアクセス権を接続',
  stage_prepare: '実行ファイルと復元データを準備',
  stage_upload: '実行ファイルをアップロード',
  stage_database: 'データベースの準備処理を配置',
  stage_initialize: 'データベースを初期化',
  stage_restore: 'バックアップを復元',
  stage_verify: '復元したデータを検証',
  'stage_sp-prepare': 'テスト用サービスプロバイダーを準備',
  stage_manifest: '配置する構成を確定',
  'stage_runtime-bind': 'ランタイムの設定を接続',
  stage_workload: 'SAMLランタイムを配置',
  stage_complete: '構築の完了を確認',
  'stage_identity-probe': '合成データでユーザー関連3表を検証',
  'stage_configuration-probe': 'Flow・SAML SP設定4表を検証',
  'mode_browser-rehearsal': 'テストデータによるSAMLブラウザー試験',
  'mode_existing-issuer': '既存の発行者に対応するDR構築',
  role_primary: 'メイン',
  role_secondary: 'サブ',
};

function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function getAwsSetupMarkup(locale: string): string {
  const copy = locale === 'ja' ? JA : EN;
  const text = (key: keyof typeof EN) => `data-aws-copy="${key}">${html(copy[key])}`;
  return `<div class="aws-setup-guide">
    <p class="aws-setup-scope"><span class="platform-badge" data-i18n="web.platform.development">In development</span><strong data-i18n="web.platform.awsScope">Currently supports SAML DR only</strong></p>
    <h2 ${text('title')}</h2><p ${text('intro')}</p>
    <div class="fieldset"><label class="f-label" for="aws-database" ${text('database')}</label>
      <select class="f-input" id="aws-database"><option value="postgresql" ${text('postgres')}</option><option value="aurora-dsql" ${text('dsql')}</option></select></div>
    <p class="f-help" id="aws-database-scope">${html(copy.postgresScope)}</p>
    <div class="fieldset"><label class="f-label" for="aws-account" ${text('account')}</label><input class="f-input" type="text" id="aws-account" inputmode="numeric" maxlength="12" autocomplete="off" spellcheck="false" placeholder="123456789012"></div>
    <div class="fieldset"><label class="f-label" for="aws-region" ${text('region')}</label><input class="f-input" type="text" id="aws-region" value="ap-northeast-1" autocomplete="off" spellcheck="false"></div>
    <div class="fieldset"><label class="f-label" for="aws-profile" ${text('profile')}</label><input class="f-input" type="text" id="aws-profile" autocomplete="off" spellcheck="false"><p class="f-help" ${text('profileHelp')}</p></div>
    ${getAwsConfigurationMarkup(locale)}
    <div class="fieldset"><label class="f-label" id="aws-config-label" for="aws-config-path">${html(copy.config)}</label><input class="f-input" type="text" id="aws-config-path" autocomplete="off" spellcheck="false" placeholder="/absolute/path/config.json"><p class="f-help" id="aws-config-help">${html(copy.configHelp)}</p></div>
    <div class="actions"><button type="button" class="btn btn-back" id="btn-aws-check" ${text('check')}</button><button type="button" class="btn btn-next" id="btn-aws-plan">${html(copy.plan)}</button></div>
    <p id="aws-message" role="status" aria-live="polite"></p><ul id="aws-checks"></ul>
    <section id="aws-plan-review" class="hidden" aria-labelledby="aws-review-title">
      <h2 id="aws-review-title" ${text('review')}</h2><dl id="aws-plan-summary"></dl>
      <h3 ${text('identities')}</h3><div id="aws-plan-identities"></div>
      <div id="aws-plan-stacks-section"><h3 ${text('stacks')}</h3><table><thead><tr><th scope="col" ${text('stages')}</th><th scope="col" ${text('stackName')}</th><th scope="col" ${text('stackAction')}</th></tr></thead><tbody id="aws-plan-stacks"></tbody></table></div>
      <h3 ${text('stages')}</h3><ol id="aws-plan-stages"></ol>
      <div id="aws-users-field" class="fieldset hidden"><label class="f-label" for="aws-users" ${text('users')}</label><input class="f-input" type="text" id="aws-users" type="number" min="1" max="2000" step="1" value="1001"></div>
      <div class="actions"><button type="button" class="btn btn-next hidden" id="btn-aws-apply" ${text('start')}</button><button type="button" class="btn btn-next hidden" id="btn-aws-resume" ${text('resume')}</button><button type="button" class="btn btn-next hidden" id="btn-aws-verify" ${text('verify')}</button></div>
    </section>
    <section aria-labelledby="aws-progress-title"><h2 id="aws-progress-title" ${text('progress')}</h2><p id="aws-operation-status" role="status" aria-live="polite">${html(copy.noOperation)}</p><ol id="aws-operation-stages"></ol><div id="aws-result"></div></section>
    <div class="fieldset"><label class="f-label" for="aws-run-id" ${text('saved')}</label><input class="f-input" type="text" id="aws-run-id" maxlength="36" autocomplete="off" spellcheck="false"></div>
    <div class="actions"><button type="button" class="btn btn-back" id="btn-aws-load" ${text('load')}</button></div>
  </div>`;
}

export const AWS_SETUP_SCRIPT = String.raw`
    ${AWS_CONFIGURATION_SCRIPT}
    const AWS_SETUP_COPY = ${JSON.stringify({ en: EN, ja: JA })};
    const AWS_SETUP_STORAGE_KEY = 'authrim_aws_setup_run_v1';
    const awsSetupState = { initialized: false, busy: false, runId: null, plan: null, view: null, epoch: 0, timer: null };
    const awsRunIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    function awsText(key) { return (AWS_SETUP_COPY[_currentLocale] || AWS_SETUP_COPY.en)[key] || key; }
    function awsNamedValue(kind, value) { const key = kind + '_' + value; const translated = awsText(key); return translated === key ? String(value) : translated; }
    function awsElement(id) { return document.getElementById(id); }
    function awsSelectedDatabase() { return awsElement('aws-database').value; }
    function awsSetMessage(key, code) {
      awsElement('aws-message').textContent = awsText(key) + (typeof code === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(code) ? ' (' + code + ')' : '');
    }
    function stopAwsSetupPolling() { if (awsSetupState.timer) clearTimeout(awsSetupState.timer); awsSetupState.timer = null; }
    function awsSetBusy(value) {
      awsSetupState.busy = value;
      [...awsConfigurationIds,'aws-database','aws-account','aws-region','aws-profile','aws-config-path','btn-aws-check','btn-aws-plan','btn-aws-load','btn-aws-apply','btn-aws-resume','btn-aws-verify','aws-users'].forEach(id => { awsElement(id).disabled = value; });
    }
    function awsClearPlan() {
      stopAwsSetupPolling();
      awsSetupState.epoch += 1;
      awsSetupState.runId = null; awsSetupState.plan = null; awsSetupState.view = null;
      awsElement('aws-plan-review').classList.add('hidden');
      awsElement('aws-operation-status').textContent = awsText('noOperation');
      awsElement('aws-operation-stages').replaceChildren(); awsElement('aws-result').replaceChildren();
      awsSetMessage('changed'); refreshAwsSetupCopy();
    }
    function refreshAwsSetupCopy() {
      document.querySelectorAll('[data-aws-copy]').forEach(element => { element.textContent = awsText(element.getAttribute('data-aws-copy')); });
      const dsql = awsSelectedDatabase() === 'aurora-dsql';
      awsElement('aws-database-scope').textContent = awsText(dsql ? 'dsqlScope' : 'postgresScope');
      awsElement('aws-config-label').textContent = awsText(dsql ? 'dsqlConfig' : 'config');
      awsElement('btn-aws-plan').textContent = awsText(dsql ? 'dsqlPlan' : 'plan');
      updateAwsConfigurationVisibility();
      if (awsSetupState.view) renderAwsSetupView(awsSetupState.view);
    }
    function awsInputs(requirePath = true) {
      const values = { accountId: awsElement('aws-account').value.trim(), region: awsElement('aws-region').value.trim(), profile: awsElement('aws-profile').value.trim(), configPath: awsElement('aws-config-path').value.trim() };
      if (!/^\d{12}$/.test(values.accountId) || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(values.region) || !/^[A-Za-z0-9_+=,.@-]{1,128}$/.test(values.profile) || (requirePath && (!values.configPath.startsWith('/') || /[\u0000-\u001f]/.test(values.configPath)))) throw new Error('invalid');
      return values;
    }
    async function awsRequest(path, body) {
      const result = await api(path, { method: 'POST', body });
      const rejected = !result || result.error || result.success === false || ((result.status === 'blocked' || typeof result.code === 'string') && !result.runId && !Array.isArray(result.checks));
      if (rejected) throw new Error(typeof result?.code === 'string' ? result.code : 'request_failed');
      return result;
    }
    function awsSafeCode(error) { return error instanceof Error ? error.message : undefined; }
    function awsSaveRunId(runId) {
      if (!awsRunIdPattern.test(runId)) throw new Error('invalid_run');
      awsSetupState.runId = runId; awsElement('aws-run-id').value = runId;
      try { localStorage.setItem(AWS_SETUP_STORAGE_KEY, runId); } catch { /* The saved ID remains visible if browser storage is unavailable. */ }
    }
    function awsAppendText(parent, tag, value) { const element = document.createElement(tag); element.textContent = String(value); parent.appendChild(element); return element; }
    function renderAwsEvaluationReport(parent, report, heading) {
      awsAppendText(parent, 'h3', awsText(heading));
      const checks = document.createElement('ul'); parent.appendChild(checks);
      (Array.isArray(report.checks) ? report.checks : []).forEach(check => awsAppendText(checks, 'li', String(check.name) + ': ' + (check.passed === true ? '✓' : '×')));
      Object.entries(report.restoredRows || {}).forEach(([name, count]) => awsAppendText(parent, 'p', name + ': ' + String(count)));
      if (report.cleanup) awsAppendText(parent, 'p', awsText('cleanup') + ': ' + String(report.cleanup));
    }
    function awsAppendLink(parent, label, value) {
      try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) return; const link = awsAppendText(parent, 'a', awsText(label)); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; } catch { /* Do not render an unverified URL. */ }
    }
    function awsReviewScope(plan) {
      const validIdentity = identity => identity && typeof identity.profile === 'string' && identity.profile.length > 0 && typeof identity.principalArn === 'string' && identity.principalArn.length > 0;
      if (plan.database === 'aurora-dsql') {
        if (!validIdentity(plan)) throw new Error('plan_scope_missing');
      } else {
        const required = ['bootstrap','foundation',...(plan.mode === 'browser-rehearsal' ? ['access'] : []),'database','workload'];
        if (!validIdentity(plan.identities?.bootstrap) || !validIdentity(plan.identities?.operator) || !Array.isArray(plan.stacks) || required.some(stage => !plan.stacks.some(stack => stack.stage === stage && typeof stack.name === 'string' && stack.name.length > 0 && ['create','reuse'].includes(stack.disposition)))) throw new Error('plan_scope_missing');
        if (plan.mode === 'existing-issuer' && (typeof plan.issuerHost !== 'string' || !plan.issuerHost)) throw new Error('plan_scope_missing');
      }
      const identities = awsElement('aws-plan-identities'); identities.replaceChildren();
      const selectedIdentities = plan.database === 'aurora-dsql' ? [['evaluationIdentity', plan]] : [['bootstrapIdentity', plan.identities.bootstrap],['operatorIdentity', plan.identities.operator]];
      selectedIdentities.forEach(([label, identity]) => {
        awsAppendText(identities, 'h4', awsText(label));
        const details = document.createElement('dl'); identities.appendChild(details);
        [['identityProfile', identity.profile],['identityArn', identity.principalArn]].forEach(([key, value]) => { awsAppendText(details, 'dt', awsText(key)); awsAppendText(details, 'dd', value); });
      });
      awsElement('aws-plan-stacks-section').classList.toggle('hidden', plan.database !== 'postgresql');
      const stacks = awsElement('aws-plan-stacks'); stacks.replaceChildren();
      (plan.database === 'postgresql' ? plan.stacks : []).forEach(stack => {
        const row = document.createElement('tr'); stacks.appendChild(row);
        awsAppendText(row, 'td', awsNamedValue('stage', stack.stage)); awsAppendText(row, 'td', stack.name); awsAppendText(row, 'td', awsText(stack.disposition));
      });
    }
    function renderAwsSetupView(view) {
      awsSetupState.view = view;
      awsSetupState.plan = null;
      awsElement('aws-plan-review').classList.add('hidden');
      ['btn-aws-apply','btn-aws-resume','btn-aws-verify'].forEach(id => awsElement(id).classList.add('hidden'));
      const plan = view.plan;
      if (plan) {
        if (!/^[a-f0-9]{64}$/.test(plan.planSha256 || '') || !['postgresql','aurora-dsql'].includes(plan.database)) throw new Error('plan_invalid');
        awsReviewScope(plan);
        awsSetupState.plan = plan;
        const summary = awsElement('aws-plan-summary'); summary.replaceChildren();
        const rows = [['database', plan.database], ['target', String(plan.target?.accountId || '') + ' / ' + String(plan.target?.region || '')], ['mode', plan.mode], ['role', plan.role], ['planHash', plan.planSha256], ['hostname', plan.hostname], ['issuerHost', plan.issuerHost]];
        rows.filter(([, value]) => value !== undefined).forEach(([key, value]) => { awsAppendText(summary, 'dt', awsText(key)); awsAppendText(summary, 'dd', ['mode','role'].includes(key) ? awsNamedValue(key, value) : value); });
        const steps = awsElement('aws-plan-stages'); steps.replaceChildren();
        (Array.isArray(plan.stages) ? plan.stages : []).forEach(stage => awsAppendText(steps, 'li', awsNamedValue('stage', stage)));
        awsElement('aws-plan-review').classList.remove('hidden');
      }
      const dsql = plan?.database === 'aurora-dsql';
      awsElement('aws-users-field').classList.toggle('hidden', !dsql);
      awsElement('btn-aws-apply').classList.toggle('hidden', !plan || dsql || view.status !== 'planned');
      awsElement('btn-aws-resume').classList.toggle('hidden', !plan || dsql || !['inProgress','blocked','interrupted'].includes(view.status));
      awsElement('btn-aws-verify').classList.toggle('hidden', !plan || !dsql || view.status !== 'planned');
      const status = ['planning','planned','running','inProgress','complete','blocked','interrupted'].includes(view.status) ? view.status : 'blocked';
      awsSetMessage(status, view.code);
      awsElement('aws-operation-status').textContent = awsText(status) + (view.currentStage ? ' — ' + awsNamedValue('stage', view.currentStage) : '') + (typeof view.code === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(view.code) ? ' (' + view.code + ')' : '');
      const stages = awsElement('aws-operation-stages'); stages.replaceChildren();
      Object.entries(view.stages || {}).forEach(([name, stage]) => awsAppendText(stages, 'li', awsNamedValue('stage', name) + ': ' + String(typeof stage === 'string' ? stage : stage?.status || awsText('pending'))));
      const result = awsElement('aws-result'); result.replaceChildren();
      if (view.status === 'complete') {
        awsAppendText(result, 'p', awsText(dsql ? 'dsqlNotReady' : 'browserPending'));
        if (!dsql) { awsAppendLink(result, 'openOrigin', view.origin); awsAppendLink(result, 'openSp', view.testSpUrl); }
      }
      if (view.result) {
        renderAwsEvaluationReport(result, view.result, 'result');
        if (view.result.configurationReport) renderAwsEvaluationReport(result, view.result.configurationReport, 'configurationResult');
      }
    }
    async function pollAwsSetup(runId, epoch) {
      stopAwsSetupPolling();
      try {
        const view = await awsRequest('/aws/operations/' + encodeURIComponent(runId) + '/status', {});
        if (epoch !== awsSetupState.epoch || runId !== awsSetupState.runId) return;
        if (view.runId !== runId) throw new Error('operation_mismatch');
        renderAwsSetupView(view);
        if (['planning','running'].includes(view.status)) {
          awsSetBusy(true);
          if (selectedSetupPlatform === 'aws') awsSetupState.timer = setTimeout(() => { void pollAwsSetup(runId, epoch); }, 1500);
        } else awsSetBusy(false);
      } catch (error) {
        if (epoch !== awsSetupState.epoch) return;
        awsSetBusy(false); awsSetMessage('error', awsSafeCode(error));
      }
    }
    async function checkAwsSetupConnection() {
      if (awsSetupState.busy) return;
      try {
        const { accountId, region, profile } = awsInputs(false); awsSetBusy(true);
        const result = await awsRequest('/aws/check', { accountId, region, profile });
        const checks = awsElement('aws-checks'); checks.replaceChildren();
        (Array.isArray(result.checks) ? result.checks : []).forEach(check => awsAppendText(checks, 'li', String(check.id) + ': ' + String(check.status) + (check.code ? ' (' + String(check.code) + ')' : '')));
        awsSetMessage(result.status === 'passed' ? 'connectionPassed' : 'connectionBlocked');
      } catch (error) { awsSetMessage(error instanceof Error && error.message === 'invalid' ? 'invalid' : 'error', awsSafeCode(error)); }
      finally { awsSetBusy(false); }
    }
    async function planAwsSetup() {
      if (awsSetupState.busy) return;
      try {
        awsInputs(false); awsClearPlan(); awsSetBusy(true);
        if (awsElement('aws-config-source').value === 'create') await createAwsConfiguration();
        const values = awsInputs();
        const dsql = awsSelectedDatabase() === 'aurora-dsql';
        const result = await awsRequest(dsql ? '/aws/dsql/check' : '/aws/plan', dsql ? values : { configPath: values.configPath, accountId: values.accountId, region: values.region });
        awsSaveRunId(result.runId); awsSetMessage('planning');
        await pollAwsSetup(result.runId, awsSetupState.epoch);
      } catch (error) { awsSetBusy(false); awsSetMessage(error instanceof Error && error.message === 'configuration_login_mode_invalid' ? 'configurationLoginModeInvalid' : error instanceof Error && error.message === 'invalid' ? 'invalid' : 'error', awsSafeCode(error)); }
    }
    async function startAwsSetup(action) {
      if (awsSetupState.busy || !awsSetupState.runId || !awsSetupState.plan || !['apply','resume','verify'].includes(action)) return;
      try {
        const plan = awsSetupState.plan;
        const allowedStatuses = action === 'resume' ? ['inProgress','blocked','interrupted'] : ['planned'];
        if (!allowedStatuses.includes(awsSetupState.view?.status)) return;
        const values = { accountId: awsElement('aws-account').value.trim(), region: awsElement('aws-region').value.trim() };
        if (plan.database !== awsSelectedDatabase() || plan.target?.accountId !== values.accountId || plan.target?.region !== values.region) { awsSetMessage('mismatch'); return; }
        if ((action === 'verify') !== (plan.database === 'aurora-dsql')) { awsSetMessage('mismatch'); return; }
        const payload = { planSha256: plan.planSha256 };
        if (action === 'verify') {
          const count = awsElement('aws-users').value;
          if (!/^[1-9]\d{0,3}$/.test(count) || Number(count) > 2000) throw new Error('invalid_user_count');
          payload.userCount = Number(count);
        }
        awsSetBusy(true);
        const accepted = await awsRequest('/aws/operations/' + encodeURIComponent(awsSetupState.runId) + '/' + action, payload);
        if (accepted.runId !== awsSetupState.runId || accepted.status !== 'running') throw new Error(typeof accepted.code === 'string' ? accepted.code : 'operation_mismatch');
        await pollAwsSetup(awsSetupState.runId, awsSetupState.epoch);
      } catch (error) { awsSetBusy(false); awsSetMessage('error', awsSafeCode(error)); }
    }
    async function loadAwsSetupOperation() {
      if (awsSetupState.busy) return;
      const runId = awsElement('aws-run-id').value.trim();
      if (!awsRunIdPattern.test(runId)) { awsSetMessage('invalidRun'); return; }
      stopAwsSetupPolling(); awsSetupState.epoch += 1; awsSetupState.plan = null;
      try {
        awsSetBusy(true);
        const view = await awsRequest('/aws/operations/' + encodeURIComponent(runId) + '/status', {});
        if (view.runId !== runId) throw new Error('operation_mismatch');
        awsSaveRunId(runId);
        if (view.plan) {
          awsElement('aws-database').value = view.plan.database;
          awsElement('aws-account').value = view.plan.target?.accountId || '';
          awsElement('aws-region').value = view.plan.target?.region || '';
        }
        renderAwsSetupView(view); refreshAwsSetupCopy();
        if (['planning','running'].includes(view.status)) await pollAwsSetup(runId, awsSetupState.epoch);
        else awsSetBusy(false);
      } catch (error) { awsSetBusy(false); awsSetMessage('error', awsSafeCode(error)); }
    }
    function initializeAwsSetup() {
      refreshAwsSetupCopy();
      if (awsSetupState.initialized) {
        if (awsSetupState.runId && ['planning','running'].includes(awsSetupState.view?.status)) void pollAwsSetup(awsSetupState.runId, awsSetupState.epoch);
        return;
      }
      awsSetupState.initialized = true;
      initializeAwsConfiguration();
      ['aws-database','aws-account','aws-region','aws-profile','aws-config-path'].forEach(id => awsElement(id).addEventListener('change', awsClearPlan));
      awsElement('btn-aws-check').addEventListener('click', checkAwsSetupConnection);
      awsElement('btn-aws-plan').addEventListener('click', planAwsSetup);
      awsElement('btn-aws-apply').addEventListener('click', () => startAwsSetup('apply'));
      awsElement('btn-aws-resume').addEventListener('click', () => startAwsSetup('resume'));
      awsElement('btn-aws-verify').addEventListener('click', () => startAwsSetup('verify'));
      awsElement('btn-aws-load').addEventListener('click', loadAwsSetupOperation);
      try { const runId = localStorage.getItem(AWS_SETUP_STORAGE_KEY); if (awsRunIdPattern.test(runId || '')) awsElement('aws-run-id').value = runId; } catch { /* Manual operation IDs remain usable. */ }
    }
`;
