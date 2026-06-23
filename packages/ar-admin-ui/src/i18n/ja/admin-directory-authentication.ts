const adminDirectoryAuthentication = {
	admin_directory_authentication_page_title: 'ディレクトリ認証 - Authrim管理',
	admin_directory_authentication_title: 'ディレクトリ認証',
	admin_directory_authentication_description:
		'LDAP/ADのパスワード検証に使うDirectory Connectorを設定します。',
	admin_directory_authentication_load_failed: 'Directory Connectorを読み込めませんでした',
	admin_directory_authentication_save_failed: 'Directory Connectorを保存できませんでした',
	admin_directory_authentication_saved: 'Directory Connector設定を保存しました。',
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
		'Directoryで検証できたユーザーがAuthrimに未作成の場合、属性からユーザーを作成します。',
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
	admin_directory_authentication_id: 'Connector ID',
	admin_directory_authentication_endpoint_url: 'Endpoint URL',
	admin_directory_authentication_connector_id: 'Wordwarden Tenant ID',
	admin_directory_authentication_key_id: 'Key ID',
	admin_directory_authentication_secret_ref: 'Secret Reference',
	admin_directory_authentication_timeout_ms: 'Timeout (ms)',
	admin_directory_authentication_attributes: 'LDAP Attributes',
	admin_directory_authentication_auth_mode: 'Auth Mode',
	admin_directory_authentication_hmac: 'HMAC',
	admin_directory_authentication_transport: '接続方式',
	admin_directory_authentication_transport_direct: 'Direct HTTPS',
	admin_directory_authentication_transport_relay: 'Outbound Relay',
	admin_directory_authentication_attributes_hint: 'カンマ区切りのattribute names。',
	admin_directory_authentication_secret_hint:
		'env:WORDWARDEN_* または env:AUTHRIM_WORDWARDEN_* を使います。',
	admin_directory_authentication_validation_id_required: 'Connector IDは必須です。',
	admin_directory_authentication_validation_id_format:
		'Connector IDには英数字、underscore、hyphenを使えます。',
	admin_directory_authentication_validation_id_unique: 'Connector IDは一意である必要があります。',
	admin_directory_authentication_validation_endpoint_required: 'Endpoint URLは必須です。',
	admin_directory_authentication_validation_endpoint_https:
		'Endpoint URLはHTTPSにしてください。local developmentのhttp://localhostのみ例外です。',
	admin_directory_authentication_validation_connector_id_required:
		'Wordwarden Tenant IDは必須です。',
	admin_directory_authentication_validation_key_id_required: 'Key IDは必須です。',
	admin_directory_authentication_validation_secret_required: 'Secret Referenceは必須です。',
	admin_directory_authentication_validation_secret_format:
		'Secret Referenceは env:WORDWARDEN_* または env:AUTHRIM_WORDWARDEN_* 形式にしてください。',
	admin_directory_authentication_validation_timeout: 'Timeoutは100から30000 msの範囲です。',
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
