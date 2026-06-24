const adminDirectoryAuthentication = {
	admin_directory_authentication_page_title: 'ディレクトリ認証 - Authrim管理',
	admin_directory_authentication_fleet_page_title: 'Connector Fleet - Authrim管理',
	admin_directory_authentication_title: 'ディレクトリ認証',
	admin_directory_authentication_description:
		'LDAP/ADのパスワード検証に使うDirectory Connectorを設定します。',
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
	admin_directory_authentication_pending_group_count: '{count} groups',
	admin_directory_authentication_pending_details: '詳細',
	admin_directory_authentication_pending_subject: 'Directory Subject',
	admin_directory_authentication_pending_identifier: 'Login Identifier',
	admin_directory_authentication_pending_user_id: 'Authrim User ID',
	admin_directory_authentication_pending_reason: 'Reason',
	admin_directory_authentication_pending_approve: 'Approve',
	admin_directory_authentication_pending_link: 'Link',
	admin_directory_authentication_pending_reject: 'Reject',
	admin_directory_authentication_fleet_title: 'Connector Fleet',
	admin_directory_authentication_fleet_description:
		'Wordwarden instance、現在のstatus episode、設定driftを確認します。',
	admin_directory_authentication_fleet_instances: 'Instances',
	admin_directory_authentication_fleet_instances_description:
		'各instanceは独立したidentityを持ちます。Deactivateは選択したinstanceだけに影響します。',
	admin_directory_authentication_fleet_empty: 'まだ報告されたconnector instanceはありません。',
	admin_directory_authentication_fleet_load_failed: 'Connector Fleetを読み込めませんでした',
	admin_directory_authentication_fleet_update_failed: 'Connector instanceを更新できませんでした',
	admin_directory_authentication_fleet_updated: 'Connector Fleetを更新しました。',
	admin_directory_authentication_fleet_last_seen: 'Last Seen',
	admin_directory_authentication_fleet_started_at: 'Started At',
	admin_directory_authentication_fleet_health: 'Health',
	admin_directory_authentication_fleet_drift: 'Drift',
	admin_directory_authentication_fleet_categories: 'Categories',
	admin_directory_authentication_fleet_acknowledge: 'Acknowledge',
	admin_directory_authentication_fleet_deactivate: 'Deactivate',
	admin_directory_authentication_fleet_reactivate: 'Reactivate',
	admin_directory_authentication_fleet_recent_episodes: 'Recent Episodes',
	admin_directory_authentication_fleet_acknowledged: 'Acknowledged',
	admin_directory_authentication_fleet_key_rotation_recommended:
		'Security reasonでdeactivateした場合は、reactivate前にheartbeat key rotationを推奨します。',
	admin_directory_authentication_status: 'Status',
	admin_directory_authentication_status_enabled: '有効',
	admin_directory_authentication_status_disabled: '無効',
	admin_directory_authentication_connectors_title: 'Connectors',
	admin_directory_authentication_connectors_description:
		'AuthrimはこれらのWordwarden endpointへパスワード検証リクエストを送信します。',
	admin_directory_authentication_remove: '削除',
	admin_directory_authentication_check_health: 'Health Check',
	admin_directory_authentication_checking_health: '確認中...',
	admin_directory_authentication_health_ok: '正常',
	admin_directory_authentication_health_failed: 'Health check failed',
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
	admin_directory_authentication_count: '{count} connectors'
} as const;

export default adminDirectoryAuthentication;
