const adminDirectoryAuthentication = {
	admin_directory_authentication_page_title: 'ディレクトリ認証 - Authrim管理',
	admin_directory_authentication_fleet_page_title: 'コネクタフリート - Authrim管理',
	admin_directory_authentication_title: 'ディレクトリ認証',
	admin_directory_authentication_description:
		'LDAP/ADのパスワード検証に使うDirectory Connectorを設定します。',
	admin_directory_authentication_tabs_aria: 'ディレクトリ認証のセクション',
	admin_directory_authentication_tab_settings: '設定',
	admin_directory_authentication_tab_migration: '移行',
	admin_directory_authentication_tab_compliance: 'コンプライアンス',
	admin_directory_authentication_tab_fleet: 'コネクタフリート',
	admin_directory_authentication_migration_page_title: 'ディレクトリ認証の移行 - Authrim管理',
	admin_directory_authentication_migration_title: '移行',
	admin_directory_authentication_migration_description:
		'Directory認証ユーザー向けの明示的なパスワードレス移行キャンペーンを管理します。',
	admin_directory_authentication_compliance_page_title:
		'ディレクトリ認証のコンプライアンス - Authrim管理',
	admin_directory_authentication_compliance_title: 'コンプライアンス',
	admin_directory_authentication_compliance_description:
		'保持期間、証跡エクスポート、サポートバンドル、Wordwardenアドバイザリを確認します。',
	admin_directory_authentication_load_failed: 'Directory Connectorを読み込めませんでした',
	admin_directory_authentication_save_failed: 'Directory Connectorを保存できませんでした',
	admin_directory_authentication_saved: 'Directory Connector設定を保存しました。',
	admin_directory_authentication_back_to_settings: '設定へ戻る',
	admin_directory_authentication_open_fleet: 'Connector Fleet',
	admin_directory_authentication_select_tenant:
		'ディレクトリ認証を管理するテナントを選択してください。',
	admin_directory_authentication_loading: 'Directory Connectorを読み込み中...',
	admin_directory_authentication_add_connector: 'Connectorを追加',
	admin_directory_authentication_save: '保存',
	admin_directory_authentication_saving: '保存中...',
	admin_directory_authentication_discard: '破棄',
	admin_directory_authentication_empty: 'Directory Connectorは設定されていません。',
	admin_directory_authentication_runtime_title: '認証動作',
	admin_directory_authentication_runtime_description:
		'AuthrimがDirectory Connectorをログイン時に使う条件を設定します。',
	admin_directory_authentication_enable_login: 'ディレクトリパスワードログイン',
	admin_directory_authentication_enable_login_description:
		'有効にすると、Authrimのログイン画面からWordwarden経由でLDAP/ADのパスワード検証を行います。',
	admin_directory_authentication_default_connector: '既定Connector',
	admin_directory_authentication_auto_provision: '自動プロビジョニング',
	admin_directory_authentication_auto_provision_description:
		'Directoryで検証できた未linkユーザーを承認待ちとして記録します。通常セッションは作成しません。',
	admin_directory_authentication_pending_title: '承認待ちDirectoryユーザー',
	admin_directory_authentication_pending_description:
		'Directory認証に成功したがAuthrimユーザーへlinkされていないユーザーを確認します。',
	admin_directory_authentication_pending_warning:
		'自動active作成は誤設定時の影響が大きいため、初期状態では承認待ちにします。既存ユーザーへlinkする前にSCIM/CSV/Authrim profileと照合してください。',
	admin_directory_authentication_pending_loading: '承認待ちユーザーを読み込み中...',
	admin_directory_authentication_pending_refresh: '再読み込み',
	admin_directory_authentication_pending_empty: '承認待ちDirectoryユーザーはありません。',
	admin_directory_authentication_pending_load_failed:
		'承認待ちDirectoryユーザーを読み込めませんでした',
	admin_directory_authentication_pending_update_failed:
		'承認待ちDirectoryユーザーを更新できませんでした',
	admin_directory_authentication_pending_updated: '承認待ちDirectoryユーザーを更新しました。',
	admin_directory_authentication_pending_link_user_required:
		'既存ユーザーへlinkするにはAuthrim User IDが必要です。',
	admin_directory_authentication_pending_group_count: '{count} グループ',
	admin_directory_authentication_pending_details: '詳細',
	admin_directory_authentication_pending_subject: 'Directory Subject',
	admin_directory_authentication_pending_identifier: 'ログイン識別子',
	admin_directory_authentication_pending_user_id: 'Authrim User ID',
	admin_directory_authentication_pending_reason: '理由',
	admin_directory_authentication_pending_approve: '承認',
	admin_directory_authentication_pending_link: 'リンク',
	admin_directory_authentication_pending_reject: '却下',
	admin_directory_authentication_fleet_title: 'コネクタフリート',
	admin_directory_authentication_fleet_description:
		'Wordwarden instance、現在のstatus episode、設定driftを確認します。',
	admin_directory_authentication_fleet_instances: 'インスタンス',
	admin_directory_authentication_fleet_instances_description:
		'各instanceは独立したidentityを持ちます。Deactivateは選択したinstanceだけに影響します。',
	admin_directory_authentication_fleet_empty: 'まだ報告されたconnector instanceはありません。',
	admin_directory_authentication_fleet_load_failed: 'Connector Fleetを読み込めませんでした',
	admin_directory_authentication_fleet_update_failed: 'Connector instanceを更新できませんでした',
	admin_directory_authentication_fleet_updated: 'Connector Fleetを更新しました。',
	admin_directory_authentication_fleet_last_seen: '最終確認',
	admin_directory_authentication_fleet_started_at: '開始日時',
	admin_directory_authentication_fleet_health: 'ヘルス',
	admin_directory_authentication_fleet_drift: '差分',
	admin_directory_authentication_fleet_categories: 'カテゴリ',
	admin_directory_authentication_fleet_acknowledge: '確認済みにする',
	admin_directory_authentication_fleet_deactivate: '無効化',
	admin_directory_authentication_fleet_reactivate: '再有効化',
	admin_directory_authentication_fleet_recent_episodes: '最近のエピソード',
	admin_directory_authentication_fleet_acknowledged: '確認済み',
	admin_directory_authentication_fleet_key_rotation_recommended:
		'Security reasonでdeactivateした場合は、reactivate前にheartbeat key rotationを推奨します。',
	admin_directory_authentication_status: '状態',
	admin_directory_authentication_status_enabled: '有効',
	admin_directory_authentication_status_disabled: '無効',
	admin_directory_authentication_connectors_title: 'コネクタ',
	admin_directory_authentication_connectors_description:
		'AuthrimはこれらのWordwarden endpointへパスワード検証リクエストを送信します。',
	admin_directory_authentication_remove: '削除',
	admin_directory_authentication_check_health: 'ヘルスチェック',
	admin_directory_authentication_checking_health: '確認中...',
	admin_directory_authentication_health_ok: '正常',
	admin_directory_authentication_health_failed: 'ヘルスチェックに失敗しました',
	admin_directory_authentication_health_status: 'HTTP {status}',
	admin_directory_authentication_load_events: 'Events取得',
	admin_directory_authentication_loading_events: '取得中...',
	admin_directory_authentication_events_failed: 'Relay eventsを読み込めませんでした',
	admin_directory_authentication_recent_events: '最近のRelay events',
	admin_directory_authentication_issue_secret: 'Secret発行',
	admin_directory_authentication_issuing_secret: '発行中...',
	admin_directory_authentication_rotate_secret: 'Secretローテーション',
	admin_directory_authentication_rotating_secret: 'ローテーション中...',
	admin_directory_authentication_secret_issued: 'Connector secretを発行しました。',
	admin_directory_authentication_secret_rotated: 'Connector secretをローテーションしました。',
	admin_directory_authentication_secret_failed: 'Connector secretを更新できませんでした',
	admin_directory_authentication_one_time_secret: 'One-time secret',
	admin_directory_authentication_one_time_secret_hint:
		'この値をWordwardenへ設定してください。Authrimでは再表示できません。',
	admin_directory_authentication_id: 'Connector ID',
	admin_directory_authentication_endpoint_url: 'Endpoint URL',
	admin_directory_authentication_connector_id: 'Wordwarden Connector ID',
	admin_directory_authentication_relay_url: 'Relay URL',
	admin_directory_authentication_relay_url_copy: 'コピー',
	admin_directory_authentication_relay_url_copied: 'コピー済み',
	admin_directory_authentication_relay_url_copy_failed: 'Relay URLをコピーできませんでした',
	admin_directory_authentication_key_id: 'Key ID',
	admin_directory_authentication_secret_ref: 'Secret Reference',
	admin_directory_authentication_timeout_ms: 'Timeout (ms)',
	admin_directory_authentication_relay_verify_timeout_ms: 'Relay Verify Timeout (ms)',
	admin_directory_authentication_relay_max_pending_requests: 'Max Pending Requests',
	admin_directory_authentication_relay_challenge_ttl_ms: 'Challenge TTL (ms)',
	admin_directory_authentication_relay_auth_failure_rate: 'Auth Failures / Minute',
	admin_directory_authentication_relay_auth_failure_block_ms: 'Auth Failure Block (ms)',
	admin_directory_authentication_rotation_grace_ms: 'Rotation Grace (ms)',
	admin_directory_authentication_heartbeat_key_id: 'Heartbeat Key ID',
	admin_directory_authentication_heartbeat_secret_ref: 'Heartbeat Secret Reference',
	admin_directory_authentication_heartbeat_secret_hint:
		'env:WORDWARDEN_* または env:AUTHRIM_WORDWARDEN_* を使います。Heartbeatはパスワード検証とは別keyです。',
	admin_directory_authentication_heartbeat_interval_ms: 'Heartbeat Interval (ms)',
	admin_directory_authentication_heartbeat_stale_after_ms: 'Stale After (ms)',
	admin_directory_authentication_advanced_fleet_settings: '高度なFleet設定',
	admin_directory_authentication_heartbeat_previous_key_id: 'Previous Heartbeat Key ID',
	admin_directory_authentication_heartbeat_previous_secret_ref:
		'Previous Heartbeat Secret Reference',
	admin_directory_authentication_heartbeat_retention_days: 'Episode Retention (days)',
	admin_directory_authentication_version_mismatch_policy: 'Version Mismatch Policy',
	admin_directory_authentication_expected_version: '期待バージョン',
	admin_directory_authentication_minimum_version: '最小バージョン',
	admin_directory_authentication_unhealthy_threshold: 'Unhealthy Threshold',
	admin_directory_authentication_stale_detection_grace_ms: 'Stale Detection Grace (ms)',
	admin_directory_authentication_attributes: 'LDAP Attributes',
	admin_directory_authentication_auth_mode: 'Auth Mode',
	admin_directory_authentication_hmac: 'HMAC',
	admin_directory_authentication_transport: '接続方式',
	admin_directory_authentication_transport_direct: 'Direct HTTPS',
	admin_directory_authentication_transport_relay: 'Outbound Relay',
	admin_directory_authentication_attributes_hint: 'カンマ区切りのattribute names。',
	admin_directory_authentication_secret_hint:
		'managed:<connector-id>、env:WORDWARDEN_*、env:AUTHRIM_WORDWARDEN_* を使います。',
	admin_directory_authentication_validation_id_required: 'Connector IDは必須です。',
	admin_directory_authentication_validation_id_format:
		'Connector IDには英数字、underscore、hyphenを使えます。',
	admin_directory_authentication_validation_id_unique: 'Connector IDは一意である必要があります。',
	admin_directory_authentication_validation_endpoint_required: 'Endpoint URLは必須です。',
	admin_directory_authentication_validation_endpoint_https:
		'Endpoint URLはHTTPSにしてください。local developmentのhttp://localhostのみ例外です。',
	admin_directory_authentication_validation_connector_id_required:
		'Wordwarden Connector IDは必須です。',
	admin_directory_authentication_validation_connector_id_format:
		'Wordwarden Connector IDは wwcon_ で始まる16文字の不変IDにしてください。',
	admin_directory_authentication_validation_connector_id_unique:
		'Wordwarden Connector IDは一意である必要があります。',
	admin_directory_authentication_validation_key_id_required: 'Key IDは必須です。',
	admin_directory_authentication_validation_secret_required: 'Secret Referenceは必須です。',
	admin_directory_authentication_validation_secret_format:
		'Secret Referenceは managed:<connector-id>、env:WORDWARDEN_*、env:AUTHRIM_WORDWARDEN_* 形式にしてください。',
	admin_directory_authentication_validation_timeout: 'Timeoutは100から30000 msの範囲です。',
	admin_directory_authentication_validation_relay_verify_timeout:
		'Relay Verify Timeoutは100から30000 msの範囲です。',
	admin_directory_authentication_validation_relay_max_pending:
		'Max Pending Requestsは1から256の範囲です。',
	admin_directory_authentication_validation_relay_challenge_ttl:
		'Challenge TTLは5000から300000 msの範囲です。',
	admin_directory_authentication_validation_relay_auth_failure_rate:
		'Auth Failures / Minuteは1から100の範囲です。',
	admin_directory_authentication_validation_relay_auth_failure_block:
		'Auth Failure Blockは1000から3600000 msの範囲です。',
	admin_directory_authentication_validation_rotation_grace:
		'Rotation Graceは0から86400000 msの範囲です。',
	admin_directory_authentication_validation_heartbeat_secret_pair:
		'Heartbeat Key IDとHeartbeat Secret Referenceはセットで設定してください。',
	admin_directory_authentication_validation_heartbeat_previous_pair:
		'Previous Heartbeat Key IDとPrevious Heartbeat Secret Referenceはセットで設定してください。',
	admin_directory_authentication_validation_heartbeat_secret_format:
		'Heartbeat Secret Referenceは env:WORDWARDEN_* または env:AUTHRIM_WORDWARDEN_* 形式にしてください。',
	admin_directory_authentication_validation_heartbeat_interval:
		'Heartbeat Intervalは30000から86400000 msの範囲です。',
	admin_directory_authentication_validation_heartbeat_stale_after:
		'Stale Afterは60000から604800000 msの範囲です。',
	admin_directory_authentication_validation_heartbeat_retention:
		'Episode Retentionは1から90日の範囲です。',
	admin_directory_authentication_validation_attributes: 'LDAP Attributesは最大32個です。',
	admin_directory_authentication_validation_connector_required_when_enabled:
		'ディレクトリパスワードログインを有効にするにはConnectorが必要です。',
	admin_directory_authentication_validation_default_connector:
		'既定ConnectorはConnector一覧に含まれている必要があります。',
	admin_directory_authentication_tenant: 'Tenant',
	admin_directory_authentication_not_selected: '未選択',
	admin_directory_authentication_count: '{count} 件',
	admin_directory_authentication_loading_short: '読み込み中...',
	admin_directory_authentication_updated: '更新',
	admin_directory_authentication_migration_load_failed:
		'ディレクトリ移行状態を読み込めませんでした。',
	admin_directory_authentication_migration_select_tenant:
		'ディレクトリ移行を管理するテナントを選択してください。',
	admin_directory_authentication_migration_tenant_policy_title: 'テナントFallbackポリシー',
	admin_directory_authentication_migration_tenant_policy_description:
		'キャンペーンはこのテナント既定値を継承するか、移行・復旧フロー用に明示的に上書きできます。',
	admin_directory_authentication_migration_tenant_fallback_label:
		'テナント既定のEmail Code fallback',
	admin_directory_authentication_migration_save_policy: 'ポリシーを保存',
	admin_directory_authentication_migration_policy_saved: 'テナントfallbackポリシーを更新しました。',
	admin_directory_authentication_migration_policy_save_failed:
		'テナントfallbackポリシーを更新できませんでした。',
	admin_directory_authentication_migration_current: '現在',
	admin_directory_authentication_migration_updated: '更新',
	admin_directory_authentication_migration_by: '更新者',
	admin_directory_authentication_migration_campaigns_title: 'キャンペーン',
	admin_directory_authentication_migration_campaigns_description:
		'Directory Loginは、キャンペーンが明示的に有効化され割り当てられるまで移行を開始しません。',
	admin_directory_authentication_migration_campaign_name: '名前',
	admin_directory_authentication_migration_campaign_mode: 'モード',
	admin_directory_authentication_migration_email_fallback: 'Email fallback',
	admin_directory_authentication_migration_admin_invitation_hint:
		'Admin invitation onlyでは、招待メールアドレスがdirectory userと一致する有効なinvitation tokenが必要です。',
	admin_directory_authentication_migration_create_disabled_campaign: '無効状態のキャンペーンを作成',
	admin_directory_authentication_migration_campaign_created: '移行キャンペーンを作成しました。',
	admin_directory_authentication_migration_campaign_create_failed:
		'移行キャンペーンを作成できませんでした。',
	admin_directory_authentication_migration_campaign_updated: '移行キャンペーンを更新しました。',
	admin_directory_authentication_migration_campaign_update_failed:
		'移行キャンペーンを更新できませんでした。',
	admin_directory_authentication_migration_no_campaigns: '移行キャンペーンはありません。',
	admin_directory_authentication_migration_template: 'テンプレート',
	admin_directory_authentication_migration_status: '状態',
	admin_directory_authentication_migration_prompt: 'プロンプト',
	admin_directory_authentication_migration_grace: '猶予',
	admin_directory_authentication_migration_target_policy: '対象ポリシー',
	admin_directory_authentication_migration_user_states_column: 'ユーザー状態',
	admin_directory_authentication_migration_cohorts: 'コホート',
	admin_directory_authentication_migration_reasons: '理由',
	admin_directory_authentication_migration_actions: '操作',
	admin_directory_authentication_migration_effective: '有効値',
	admin_directory_authentication_migration_ttl: 'TTL',
	admin_directory_authentication_migration_user_states_title: 'ユーザー状態',
	admin_directory_authentication_migration_user_states_description:
		'通常ログインセッションを作成せず、blocked/deferredの移行状態をresetします。',
	admin_directory_authentication_migration_user_state: '状態',
	admin_directory_authentication_migration_any_state: 'すべての状態',
	admin_directory_authentication_migration_campaign_id: 'キャンペーンID',
	admin_directory_authentication_migration_user_id: 'ユーザーID',
	admin_directory_authentication_migration_search: '検索',
	admin_directory_authentication_migration_search_failed:
		'移行ユーザー状態を検索できませんでした。',
	admin_directory_authentication_migration_no_user_states: 'ユーザー移行状態はありません。',
	admin_directory_authentication_migration_first_login: '初回ログイン',
	admin_directory_authentication_migration_reset_reason: 'Reset理由',
	admin_directory_authentication_migration_reset: 'Reset',
	admin_directory_authentication_migration_state_reset: '移行状態をresetしました。',
	admin_directory_authentication_migration_state_reset_failed: '移行状態をresetできませんでした。',
	admin_directory_authentication_mode_directory_login_allowed: 'Directory loginを許可',
	admin_directory_authentication_mode_prompt_passkey: 'Passkey登録を促す',
	admin_directory_authentication_mode_grace_then_require_passkey: '猶予後にPasskey必須',
	admin_directory_authentication_mode_require_passkey_after_directory:
		'Directory認証後にPasskey必須',
	admin_directory_authentication_option_disabled: '無効',
	admin_directory_authentication_option_draft: '下書き',
	admin_directory_authentication_option_active: '有効',
	admin_directory_authentication_option_paused: '一時停止',
	admin_directory_authentication_option_archived: 'アーカイブ',
	admin_directory_authentication_option_campaign_only: 'キャンペーンのみ',
	admin_directory_authentication_option_optional: '任意',
	admin_directory_authentication_option_none: 'なし',
	admin_directory_authentication_option_tenant_default: 'テナント既定',
	admin_directory_authentication_option_migration_recovery: '移行復旧',
	admin_directory_authentication_option_admin_invitation_only: 'Admin招待のみ',
	admin_directory_authentication_option_login_method: 'ログイン方法',
	admin_directory_authentication_option_directory_unavailable_recovery: 'Directory利用不可時の復旧',
	admin_directory_authentication_state_eligible: '対象',
	admin_directory_authentication_state_not_applicable: '対象外',
	admin_directory_authentication_state_prompted: '案内済み',
	admin_directory_authentication_state_deferred: '延期',
	admin_directory_authentication_state_passkey_required: 'Passkey必須',
	admin_directory_authentication_state_enrolled: '登録済み',
	admin_directory_authentication_state_blocked: 'ブロック',
	admin_directory_authentication_state_recovered: '復旧済み',
	admin_directory_authentication_compliance_load_failed:
		'ディレクトリコンプライアンス状態を読み込めませんでした。',
	admin_directory_authentication_compliance_select_tenant:
		'ディレクトリコンプライアンスを管理するテナントを選択してください。',
	admin_directory_authentication_compliance_evidence_unavailable:
		'証跡exportへアクセスできません。',
	admin_directory_authentication_compliance_retention_title: '保持期間',
	admin_directory_authentication_compliance_retention_description:
		'Authrimを長期監査の正とし、Wordwardenのlocal logは短期保持にします。',
	admin_directory_authentication_compliance_authrim_retention: 'Authrim監査保持日数',
	admin_directory_authentication_compliance_wordwarden_retention: 'Wordwarden local保持日数',
	admin_directory_authentication_compliance_artifact_grace: 'Artifact削除猶予時間',
	admin_directory_authentication_compliance_save_retention: '保持設定を保存',
	admin_directory_authentication_compliance_retention_saved: '保持ポリシーを更新しました。',
	admin_directory_authentication_compliance_retention_save_failed:
		'保持ポリシーを更新できませんでした。',
	admin_directory_authentication_compliance_maintenance_title: 'メンテナンス',
	admin_directory_authentication_compliance_maintenance_description:
		'設定済みの猶予期間を使い、期限切れtransactionとartifact metadataをテナント単位でcleanupします。',
	admin_directory_authentication_compliance_reason: '理由',
	admin_directory_authentication_compliance_run_cleanup: 'Cleanup実行',
	admin_directory_authentication_compliance_cleanup_failed: 'メンテナンスCleanupに失敗しました。',
	admin_directory_authentication_compliance_cleanup_completed:
		'Cleanupが完了しました。期限切れtransaction {transactions} 件、export {exports} 件、support bundle {bundles} 件を処理しました。',
	admin_directory_authentication_compliance_evidence_title: '証跡エクスポート',
	admin_directory_authentication_compliance_evidence_description:
		'証跡bundleは暗号化export storage、Object Catalog tracking、proxy download、SHA-256 checksumを使います。',
	admin_directory_authentication_compliance_period_start: '期間開始',
	admin_directory_authentication_compliance_period_end: '期間終了',
	admin_directory_authentication_compliance_delete_after_download: 'ダウンロード後に削除',
	admin_directory_authentication_compliance_create_export: 'エクスポートジョブを作成',
	admin_directory_authentication_compliance_invalid_export_period:
		'有効なexport期間を入力してください。',
	admin_directory_authentication_compliance_export_created:
		'証跡エクスポートジョブを作成しました。',
	admin_directory_authentication_compliance_export_create_failed:
		'証跡エクスポートを作成できませんでした。',
	admin_directory_authentication_compliance_support_title: 'サポートバンドル',
	admin_directory_authentication_compliance_support_description:
		'Support bundleにはredaction summaryが必要で、raw password、hash、secret、token、完全なLDAP filterは含めません。',
	admin_directory_authentication_compliance_redaction_level: 'Redactionレベル',
	admin_directory_authentication_compliance_create_support_bundle: 'サポートバンドルを作成',
	admin_directory_authentication_compliance_support_created:
		'サポートバンドルリクエストを作成しました。',
	admin_directory_authentication_compliance_support_create_failed:
		'サポートバンドルを作成できませんでした。',
	admin_directory_authentication_compliance_redaction_minimal: '最小',
	admin_directory_authentication_compliance_redaction_standard: '標準',
	admin_directory_authentication_compliance_redaction_detailed: '詳細',
	admin_directory_authentication_compliance_detailed_warning:
		'詳細bundleにはendpoint名、DN断片、attribute名、timing dataが含まれる場合があります。',
	admin_directory_authentication_compliance_ack_warning: '詳細bundleの警告を確認しました',
	admin_directory_authentication_compliance_config_history_title: '設定履歴',
	admin_directory_authentication_compliance_config_history_description:
		'ディレクトリ認証ポリシー、キャンペーン、保持期間、移行状態のredacted changeを確認します。',
	admin_directory_authentication_compliance_no_config_history: '設定履歴はありません。',
	admin_directory_authentication_compliance_summary_links_title: 'サマリーリンク',
	admin_directory_authentication_compliance_summary_links_description:
		'このテナントのredacted operational summary viewを開きます。',
	admin_directory_authentication_compliance_no_summary_links: 'サマリーリンクはありません。',
	admin_directory_authentication_compliance_managed_connectors_title: '管理対象コネクタ',
	admin_directory_authentication_compliance_managed_connectors_description:
		'Heartbeatで報告されたWordwarden instanceを確認します。Auto-updateは意図的に無効です。',
	admin_directory_authentication_compliance_no_heartbeat:
		'Connector heartbeatはまだ受信されていません。',
	admin_directory_authentication_compliance_advisories_title: 'Wordwardenアドバイザリ',
	admin_directory_authentication_compliance_advisories_description:
		'Fleet heartbeatがinstall済みversionを報告し、Authrimはconnectorをauto-updateせずadvisory状態を表示します。',
	admin_directory_authentication_compliance_no_advisories: 'Advisoryはありません。',
	admin_directory_authentication_compliance_no_jobs: 'ジョブはありません。',
	admin_directory_authentication_compliance_id: 'ID',
	admin_directory_authentication_compliance_status: '状態',
	admin_directory_authentication_compliance_requested_by: 'リクエスト者',
	admin_directory_authentication_compliance_retention_expires: '保持期限',
	admin_directory_authentication_compliance_checksum: 'チェックサム',
	admin_directory_authentication_compliance_artifact: 'Artifact',
	admin_directory_authentication_compliance_download: 'ダウンロード',
	admin_directory_authentication_compliance_time: '時刻',
	admin_directory_authentication_compliance_action: '操作',
	admin_directory_authentication_compliance_resource: 'リソース',
	admin_directory_authentication_compliance_actor: '実行者',
	admin_directory_authentication_compliance_after: 'After',
	admin_directory_authentication_compliance_connector: 'コネクタ',
	admin_directory_authentication_compliance_instance: 'インスタンス',
	admin_directory_authentication_compliance_version: 'バージョン',
	admin_directory_authentication_compliance_channel: 'チャネル',
	admin_directory_authentication_compliance_advisory: 'アドバイザリ',
	admin_directory_authentication_compliance_affected: '件の影響',
	admin_directory_authentication_compliance_health: 'ヘルス',
	admin_directory_authentication_compliance_last_seen: '最終確認',
	admin_directory_authentication_compliance_recent_episode: '最近のエピソード',
	admin_directory_authentication_compliance_started: '開始',
	admin_directory_authentication_compliance_fixed: '修正版'
} as const;

export default adminDirectoryAuthentication;
