const labels = {
  configurationSource: ['Configuration', '設定方法'],
  configurationCreate: ['Create from this form', 'この画面で設定を作成'],
  configurationFile: ['Use an existing file', '既存の設定ファイルを使用'],
  configurationOutputHelp: [
    'The configuration file will be created from this form when you prepare the plan. Its saved location will appear here.',
    '計画を作成すると、入力内容から設定ファイルを生成します。保存先はここに表示されます。',
  ],
  configurationLoginModeInvalid: [
    'For an existing issuer, choose an external login screen or no screen. The test screen is available only in rehearsal mode.',
    '既存の発行者を使う場合は、外部ログイン画面か「画面を提供しない」を選んでください。試験用画面はブラウザー試験モードで利用できます。',
  ],
  deploymentName: [
    'New environment name (lowercase letters, numbers and hyphens; start with a letter)',
    '新しい環境の名前（英小文字で開始、英小文字・数字・ハイフン）',
  ],
  deploymentMode: ['Deployment mode', '構築モード'],
  bootstrapPrincipal: [
    'Initial setup IAM user or role ARN',
    '初期構築に使うIAMユーザーまたはロールのARN',
  ],
  operatorProfile: ['Deployment role profile', '構築用ロールのプロファイル'],
  caBundle: ['Local RDS CA bundle file', 'RDSのCA証明書ファイル'],
  s3PrefixList: ['S3 gateway prefix list ID', 'S3ゲートウェイのプレフィックスリストID'],
  authState: ['Authentication state storage', '認証状態の保存先'],
  authStatePostgres: ['PostgreSQL', 'PostgreSQL'],
  authStateDynamo: ['DynamoDB', 'DynamoDB'],
  dynamoPrefixList: [
    'DynamoDB gateway prefix list ID',
    'DynamoDBゲートウェイのプレフィックスリストID',
  ],
  issuer: ['Existing issuer hostname', '既存の発行者ホスト名'],
  certificate: ['HTTPS certificate ARN', '公開HTTPS用証明書のARN'],
  inputSecret: ['Existing restore-input secret ARN', '復元用の秘密情報を保存したSecretのARN'],
  inputVersion: ['Pinned secret version ID', '固定するSecretのバージョンID'],
  fixtureDirectory: ['Prepared backup directory', '準備済みバックアップのフォルダ'],
  fixtureDigest: ['Backup descriptor SHA-256', 'バックアップ記述ファイルのSHA-256'],
  dsqlHost: ['Existing DSQL hostname', '既存DSQLのホスト名'],
  dsqlUser: ['DSQL database user', 'DSQLのデータベースユーザー'],
  loginUiMode: ['Login screen', 'ログイン画面'],
  adminUiMode: ['Admin screen', '管理画面'],
  uiDisabled: ['Do not provide a screen', '画面を提供しない'],
  uiExternal: ['Use an external screen', '外部の画面を使用'],
  uiEmbedded: ['Built-in test passkey screen', '組み込みの試験用パスキー画面'],
  externalLoginUrl: ['External Login UI origin (HTTPS)', '外部Login UIのオリジン（HTTPS）'],
  externalClient: ['Captured Login UI client ID', 'バックアップに含まれるLogin UIのクライアントID'],
  loginPath: ['Login path', 'ログインのパス'],
  reauthPath: ['Reauthentication path', '再認証のパス'],
  externalAdminUrl: ['External Admin UI origin (HTTPS)', '外部Admin UIのオリジン（HTTPS）'],
  optionalUiHelp: [
    'Packaged Login UI and Admin UI are not installed by this AWS profile. External screens are independent. An Admin UI URL does not deploy the management API.',
    'このAWS構成では付属Login UI・Admin UIのパッケージは配置しません。外部画面はそれぞれ独立して指定できます。管理画面のURL指定は管理APIの配置を意味しません。',
  ],
  setupPreparationHelp: [
    'Use signed-in initial setup and deployment role profiles. Synthetic backup generation needs a disposable local PostgreSQL database.',
    'ログイン済みの初期構築用プロファイルと、構築用ロールを引き受けるプロファイルを指定してください。合成バックアップの生成には作業用のローカルPostgreSQLを使います。',
  ],
} as const;
type Key = keyof typeof labels;
const copy = (index: 0 | 1) =>
  Object.fromEntries(Object.entries(labels).map(([key, values]) => [key, values[index]])) as Record<
    Key,
    string
  >;
export const AWS_CONFIGURATION_EN = copy(0);
export const AWS_CONFIGURATION_JA = copy(1);
const escape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

export function getAwsConfigurationMarkup(locale: string) {
  const words = locale === 'ja' ? AWS_CONFIGURATION_JA : AWS_CONFIGURATION_EN;
  const label = (key: Key) => `data-aws-copy="${key}">${escape(words[key])}`;
  const field = (id: string, key: Key, value = '') =>
    `<div class="fieldset"><label class="f-label" for="${id}" ${label(key)}</label><input class="f-input" id="${id}" type="text" value="${escape(value)}" autocomplete="off" spellcheck="false"></div>`;
  return `<div class="fieldset"><label class="f-label" for="aws-config-source" ${label('configurationSource')}</label><select class="f-input" id="aws-config-source"><option value="create" ${label('configurationCreate')}</option><option value="file" ${label('configurationFile')}</option></select></div>
    <div id="aws-config-form"><div id="aws-pg-configuration">
      <p class="f-help" ${label('setupPreparationHelp')}</p>${field('aws-deployment-name', 'deploymentName')}
      <div class="fieldset"><label class="f-label" for="aws-deployment-mode" ${label('deploymentMode')}</label><select class="f-input" id="aws-deployment-mode"><option value="browser-rehearsal" data-aws-copy="mode_browser-rehearsal"></option><option value="existing-issuer" data-aws-copy="mode_existing-issuer"></option></select></div>
      <div class="fieldset"><label class="f-label" for="aws-deployment-role" data-aws-copy="role"></label><select class="f-input" id="aws-deployment-role"><option value="secondary" data-aws-copy="role_secondary"></option><option value="primary" data-aws-copy="role_primary"></option></select></div>
      ${field('aws-bootstrap-principal', 'bootstrapPrincipal')}${field('aws-operator-profile', 'operatorProfile')}${field('aws-ca-bundle', 'caBundle')}${field('aws-s3-prefix-list', 's3PrefixList')}
      <div class="fieldset"><label class="f-label" for="aws-auth-state" ${label('authState')}</label><select class="f-input" id="aws-auth-state"><option value="postgresql" ${label('authStatePostgres')}</option><option value="dynamodb" ${label('authStateDynamo')}</option></select></div>
      <div id="aws-dynamo-fields" class="hidden">${field('aws-dynamo-prefix-list', 'dynamoPrefixList')}</div>
      <div id="aws-existing-issuer-fields" class="hidden">${field('aws-issuer-host', 'issuer')}${field('aws-certificate-arn', 'certificate')}${field('aws-input-secret-arn', 'inputSecret')}${field('aws-input-secret-version', 'inputVersion')}${field('aws-fixture-directory', 'fixtureDirectory')}${field('aws-fixture-digest', 'fixtureDigest')}</div>
      <p class="f-help" ${label('optionalUiHelp')}</p>
      <div class="fieldset"><label class="f-label" for="aws-login-ui-mode" ${label('loginUiMode')}</label><select class="f-input" id="aws-login-ui-mode"><option value="embedded-rehearsal" ${label('uiEmbedded')}</option><option value="disabled" ${label('uiDisabled')}</option><option value="external" ${label('uiExternal')}</option></select></div>
      <div id="aws-external-login-fields" class="hidden">${field('aws-external-login-url', 'externalLoginUrl')}${field('aws-external-client', 'externalClient')}${field('aws-login-path', 'loginPath', '/login')}${field('aws-reauth-path', 'reauthPath', '/reauth')}</div>
      <div class="fieldset"><label class="f-label" for="aws-admin-ui-mode" ${label('adminUiMode')}</label><select class="f-input" id="aws-admin-ui-mode"><option value="disabled" ${label('uiDisabled')}</option><option value="external" ${label('uiExternal')}</option></select></div>
      <div id="aws-external-admin-fields" class="hidden">${field('aws-external-admin-url', 'externalAdminUrl')}</div>
    </div><div id="aws-dsql-configuration" class="hidden">${field('aws-dsql-hostname', 'dsqlHost')}${field('aws-dsql-user', 'dsqlUser')}</div></div>`;
}

export const AWS_CONFIGURATION_SCRIPT = String.raw`
    const awsConfigurationIds = ['aws-config-source','aws-deployment-name','aws-deployment-mode','aws-deployment-role','aws-bootstrap-principal','aws-operator-profile','aws-ca-bundle','aws-s3-prefix-list','aws-auth-state','aws-dynamo-prefix-list','aws-issuer-host','aws-certificate-arn','aws-input-secret-arn','aws-input-secret-version','aws-fixture-directory','aws-fixture-digest','aws-login-ui-mode','aws-external-login-url','aws-external-client','aws-login-path','aws-reauth-path','aws-admin-ui-mode','aws-external-admin-url','aws-dsql-hostname','aws-dsql-user'];
    function updateAwsConfigurationVisibility() {
      const create = awsElement('aws-config-source').value === 'create';
      const dsql = awsSelectedDatabase() === 'aurora-dsql';
      awsElement('aws-config-form').classList.toggle('hidden', !create);
      awsElement('aws-pg-configuration').classList.toggle('hidden', dsql);
      awsElement('aws-dsql-configuration').classList.toggle('hidden', !dsql);
      awsElement('aws-existing-issuer-fields').classList.toggle('hidden', awsElement('aws-deployment-mode').value !== 'existing-issuer');
      awsElement('aws-external-login-fields').classList.toggle('hidden', awsElement('aws-login-ui-mode').value !== 'external');
      awsElement('aws-external-admin-fields').classList.toggle('hidden', awsElement('aws-admin-ui-mode').value !== 'external');
      awsElement('aws-dynamo-fields').classList.toggle('hidden', awsElement('aws-auth-state').value !== 'dynamodb');
      awsElement('aws-config-path').readOnly = create;
      awsElement('aws-config-help').textContent = awsText(create ? 'configurationOutputHelp' : dsql ? 'dsqlConfigHelp' : 'configHelp');
    }
    function awsConfigurationInput() {
      const values = awsInputs(false);
      const value = id => awsElement(id).value.trim();
      const configuration = { database: awsSelectedDatabase(), accountId: values.accountId, region: values.region };
      if (configuration.database === 'aurora-dsql') return { ...configuration, hostname: value('aws-dsql-hostname'), user: value('aws-dsql-user') };
      const login = { mode: value('aws-login-ui-mode') };
      if (login.mode === 'external') Object.assign(login, { baseUrl: value('aws-external-login-url'), clientId: value('aws-external-client'), paths: { login: value('aws-login-path'), reauth: value('aws-reauth-path') } });
      const admin = { mode: value('aws-admin-ui-mode') };
      if (admin.mode === 'external') admin.baseUrl = value('aws-external-admin-url');
      Object.assign(configuration, { name: value('aws-deployment-name'), role: value('aws-deployment-role'), mode: value('aws-deployment-mode'), bootstrapProfile: values.profile, bootstrapPrincipalArn: value('aws-bootstrap-principal'), operatorProfile: value('aws-operator-profile'), caBundlePath: value('aws-ca-bundle'), s3GatewayPrefixListId: value('aws-s3-prefix-list'), components: { loginUi: false, adminUi: false }, ui: { login, admin } });
      configuration.authState = { backend: value('aws-auth-state') };
      if (configuration.authState.backend === 'dynamodb') configuration.dynamoDbGatewayPrefixListId = value('aws-dynamo-prefix-list');
      if (configuration.mode === 'existing-issuer' && login.mode === 'embedded-rehearsal') throw new Error('configuration_login_mode_invalid');
      if (configuration.mode === 'existing-issuer') Object.assign(configuration, {
        issuer: { host: value('aws-issuer-host'), certificateArn: value('aws-certificate-arn'), inputSecretArn: value('aws-input-secret-arn'), inputSecretVersionId: value('aws-input-secret-version') },
        fixture: { directory: value('aws-fixture-directory'), descriptorSha256: value('aws-fixture-digest') }
      });
      return configuration;
    }
    async function createAwsConfiguration() {
      const configuration = awsConfigurationInput();
      const result = await awsRequest('/aws/configuration', { configuration });
      if (result.status !== 'configured' || result.database !== configuration.database || typeof result.configPath !== 'string' || !result.configPath.startsWith('/') || !/^[a-f0-9]{64}$/.test(result.configSha256 || '')) throw new Error('configuration_invalid');
      awsElement('aws-config-path').value = result.configPath;
    }
    function initializeAwsConfiguration() {
      awsConfigurationIds.forEach(id => awsElement(id).addEventListener('change', () => { awsClearPlan(); updateAwsConfigurationVisibility(); }));
      updateAwsConfigurationVisibility();
    }
`;
