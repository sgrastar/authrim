/** Pure helpers shared by browser markup and offline unit tests. No token values in messages. */
export function logArchiveInputError(input: {
  mode?: string;
  readToken?: string;
  writeToken?: string;
  sinkToken?: string;
}): string | null {
  if (!input.mode) return 'log_archive_mode_required';
  if (!input.readToken?.trim() || !input.writeToken?.trim())
    return 'log_archive_catalog_credentials_required';
  if (input.mode === 'pipeline' && !input.sinkToken?.trim())
    return 'log_archive_sink_credential_required';
  const tokens = [
    input.readToken.trim(),
    input.writeToken.trim(),
    ...(input.mode === 'pipeline' ? [input.sinkToken!.trim()] : []),
  ];
  return new Set(tokens).size !== tokens.length
    ? 'log_archive_distinct_catalog_credentials_required'
    : null;
}

export interface LogArchiveStagedStatus {
  complete: boolean;
  mode: 'scheduled' | 'pipeline' | null;
  accountMatches: boolean;
  pendingRecovery: boolean;
}

/** Reload-safe choice; an unconfirmed issuance must be recovered before using its values. */
export function logArchiveStagedChoice(
  status: LogArchiveStagedStatus | null,
  mode: string
): { useStaged: boolean; messageCode: string | null } {
  if (status?.pendingRecovery && !status.complete)
    return { useStaged: false, messageCode: 'log_archive_pending_recovery_required' };
  if (!status?.complete || !mode) return { useStaged: false, messageCode: null };
  if (!status.accountMatches)
    return { useStaged: false, messageCode: 'log_archive_staged_account_mismatch' };
  if (status.mode !== mode)
    return { useStaged: false, messageCode: 'log_archive_staged_mode_mismatch' };
  return {
    useStaged: true,
    messageCode: status.pendingRecovery
      ? 'log_archive_local_cleanup_pending'
      : 'log_archive_staged_tokens_ready',
  };
}

/** Translate synchronous source resolution and asynchronous issuance at the same CLI boundary. */
export function withLogArchiveCliErrors<T>(locale: string, action: () => T): T {
  const failure = (error: unknown): never => {
    const detail = error as {
      code?: unknown;
      message?: unknown;
      cleanupRequired?: unknown;
      childCleanupRequired?: unknown;
    } | null;
    const candidate = detail?.code ?? detail?.message;
    const code =
      typeof candidate === 'string' && /^log_archive_[a-z0-9_]+$/u.test(candidate)
        ? candidate
        : 'log_archive_token_issuance_failed';
    throw new Error(
      logArchiveErrorMessage(
        code,
        locale,
        detail?.cleanupRequired === true || detail?.childCleanupRequired === true
      )
    );
  };
  try {
    const result = action();
    return result instanceof Promise ? (result.catch(failure) as T) : result;
  } catch (error) {
    return failure(error);
  }
}

const messages = [
  [
    ['log_archive_pending_recovery_required'],
    '前回の自動発行の復旧が必要です。手入力せず、自動発行で前回の一時トークン（失効確認ができない場合は新しい復旧用の一時トークン）を入力して再開してください。',
    'Recover the previous automatic issuance before entering tokens manually. Resume automatic issuance with the previous one-time token, or a new recovery token if revocation cannot be confirmed.',
  ],
  [
    ['log_archive_staged_tokens_ready'],
    '保存済みの発行済みトークンを使用できます。一時トークンの再入力は不要です。',
    'Use the already issued tokens. No one-time token is needed again.',
  ],
  [
    ['log_archive_staged_credentials_exist'],
    '保存済みのログ用トークンがあります。既存の設定を再開するか、手入力を選択してください。',
    'Log tokens are already staged. Resume the existing setup or choose manual entry.',
  ],
  [
    [
      'log_archive_staged_account_required',
      'log_archive_staged_account_mismatch',
      'log_archive_staged_mode_mismatch',
    ],
    '保存済みトークンの対象accountと保存方式を確認してください。検証済みの設定を使って再開してください。',
    'Check the account and storage mode bound to the staged tokens. Resume using the verified setup.',
  ],
  [
    ['log_archive_local_cleanup_pending'],
    'トークンの発行と一時トークンの失効は完了しました。ローカル復旧ファイルの後片付けは次回の再開時に再試行します。',
    'Tokens were issued and the one-time token was revoked. Local recovery-file cleanup will be retried on resume.',
  ],

  [
    ['log_archive_mode_required'],
    'ログの保存方式を選択してください。',
    'Choose a log storage mode.',
  ],
  [
    ['log_archive_catalog_credentials_required'],
    '読取り用と書込み用のトークンを入力するか、自動発行を選んでください。',
    'Enter both read and write tokens, or choose automatic issuance.',
  ],
  [
    ['log_archive_sink_credential_required'],
    'Pipeline Sink専用の別トークンを入力してください。',
    'Enter a separate token for the Pipeline Sink.',
  ],
  [
    [
      'log_archive_distinct_catalog_credentials_required',
      'log_archive_distinct_sink_credential_required',
      'log_archive_distinct_catalog_token_ids_required',
    ],
    '各欄に別々のトークンを入力してください。',
    'Use a different token in each field.',
  ],
  [
    ['log_archive_bootstrap_token_required'],
    'Account API Tokens Write権限を持つ一時トークンを作成して入力してください。',
    'Create and enter a one-time token with Account API Tokens Write permission.',
  ],
  [
    ['log_archive_bootstrap_token_invalid'],
    '一時トークンを確認できませんでした。貼り付けた値が、Account API Tokens Write権限で作成した一時トークンか確認してください。トークンは作成されていません。',
    'The one-time token could not be verified. Check that the pasted value is the one-time token created with Account API Tokens Write permission. No tokens were created.',
  ],
  [
    ['log_archive_permission_group_invalid'],
    '必要な権限名を一意に特定できません。Cloudflareの権限一覧を確認してください。',
    'Required permission names are missing or ambiguous. Check the Cloudflare permission groups.',
  ],
  [
    ['log_archive_catalog_token_inactive'],
    'トークンが有効ではありません。新しいトークンを入力してください。',
    'A Catalog token is inactive. Enter a new token.',
  ],
  [
    [
      'log_archive_catalog_token_account_mismatch',
      'log_archive_cloudflare_credentials_invalid',
      'log_archive_recovery_account_mismatch',
    ],
    'Cloudflareアカウントとトークンの対象アカウントを確認してください。',
    'Check that Cloudflare and the tokens use the same account.',
  ],
  [
    [
      'log_archive_catalog_token_permission_unknown',
      'log_archive_issued_token_scope_invalid',
      'log_archive_catalog_read_token_not_read_only',
      'log_archive_catalog_write_token_permission_missing',
    ],
    'トークンの権限が要件を満たしていません。読取り用にはCatalog・SQL・R2 StorageのRead、書込み用にはCatalog・R2 StorageのWriteが必要です。',
    'Check token permissions: Catalog, SQL and R2 Storage Read for readers; Catalog and R2 Storage Write for writers.',
  ],
  [
    ['log_archive_request_invalid'],
    '入力内容を確認してください。保存方式と必要なトークン、DB保持日数（1〜3650日）を確認してください。',
    'Check the storage mode, required tokens and DB retention (1–3650 days).',
  ],
  [
    ['log_archive_configuration_invalid', 'log_archive_token_issuance_failed'],
    'ログ保存を設定できませんでした。入力内容を確認して再試行してください。',
    'Log storage setup failed. Check the input and try again.',
  ],
  [
    ['log_archive_mode_not_implemented'],
    'この保存方式は現在のSetupでは利用できません。',
    'This storage mode is unavailable in this version of Setup.',
  ],
  [
    ['log_archive_environment_config_required'],
    '先に環境設定を保存してください。',
    'Save the environment configuration first.',
  ],
  [
    ['log_archive_generation_change_requires_explicit_transition'],
    '作成済み環境の保存方式はこの画面で変更できません。明示的な移行操作が必要です。',
    'Changing an existing archive requires an explicit transition.',
  ],
  [
    ['log_archive_bootstrap_revocation_unconfirmed', 'log_archive_child_cleanup_unconfirmed'],
    'トークンの失効を確認できません。自動発行を再実行して復旧してください。解消しない場合はCloudflareで一時トークンと発行済みトークンを確認・失効してください。',
    'Token revocation is unconfirmed. Retry automatic issuance to recover. If unresolved, inspect and revoke the one-time and issued tokens in Cloudflare.',
  ],
  [
    ['log_archive_bootstrap_recovered_retry_required'],
    '前回のトークンを失効しました。新しい一時トークンを作成して再試行してください。',
    'Previous tokens were revoked. Create a new one-time token and retry.',
  ],
  [
    ['log_archive_token_sources_conflict'],
    'Catalogトークンと一時トークンは同時に指定できません。どちらか一方を指定してください。',
    'Supply explicit Catalog tokens or a bootstrap token, with no mixing of sources.',
  ],
  [
    ['log_archive_permission_or_subscription_required'],
    'Cloudflareのトークン権限とR2・Catalogの契約を確認してください。手動で入力したトークンを検証する場合は、ログイン中の認証情報にAPI Tokensの読み取り権限が必要です。',
    'Check Cloudflare token permissions and R2 / Catalog subscriptions. Verifying manually entered tokens also needs a login credential that can read API Tokens.',
  ],
  [
    [
      'log_archive_cloudflare_response_invalid',
      'log_archive_cloudflare_request_failed',
      'log_archive_resource_not_found',
    ],
    'Cloudflare APIの処理に失敗しました。設定を確認して再試行してください。',
    'The Cloudflare API request failed. Check the configuration and retry.',
  ],
  [
    [
      'log_archive_secret_file_invalid',
      'log_archive_secret_file_permissions_invalid',
      'log_archive_recovery_state_invalid',
      'log_archive_recovery_state_permissions_invalid',
      'log_archive_environment_invalid',
    ],
    'ローカルの秘密情報または復旧情報を読み取れません。ファイルとアクセス権を確認してください。',
    'Local secrets or recovery state could not be read. Check the files and permissions.',
  ],
] as const;

export const LOG_ARCHIVE_ERROR_MESSAGES: Readonly<Record<string, { ja: string; en: string }>> =
  Object.fromEntries(
    messages.flatMap(([codes, ja, en]) => codes.map((code) => [code, { ja, en }]))
  );
export function logArchiveErrorMessage(
  code: string,
  locale: string,
  cleanupRequired = false
): string {
  const language = locale.startsWith('ja') ? 'ja' : 'en';
  const message =
    LOG_ARCHIVE_ERROR_MESSAGES[code]?.[language] ??
    (language === 'ja' ? 'ログ保存の設定に失敗しました。' : 'Log storage setup failed.') +
      ' (' +
      code +
      ')';
  return cleanupRequired &&
    ![
      'log_archive_bootstrap_revocation_unconfirmed',
      'log_archive_child_cleanup_unconfirmed',
    ].includes(code)
    ? message +
        ' ' +
        LOG_ARCHIVE_ERROR_MESSAGES.log_archive_bootstrap_revocation_unconfirmed[language]
    : message;
}
