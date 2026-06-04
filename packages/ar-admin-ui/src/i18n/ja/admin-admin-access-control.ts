const adminAdminAccessControl = {
	admin_admin_access_control_head_title: '管理者アクセス制御ハブ - 管理ダッシュボード - Authrim',
	admin_admin_access_control_title: '管理者アクセス制御ハブ',
	admin_admin_access_control_description:
		'管理者向けのAdmin RBAC、ABAC、ReBAC、Policy-based access controlをまとめて管理します。',
	admin_admin_access_control_loading: '管理者アクセス制御統計を読み込んでいます...',
	admin_admin_access_control_load_failed: '管理者アクセス制御統計の読み込みに失敗しました',
	admin_admin_access_control_retry: '再試行',
	admin_admin_access_control_rbac_subtitle: '管理者ロール',
	admin_admin_access_control_rbac_description:
		'Role-based access controlで管理者のロールと権限を管理します。',
	admin_admin_access_control_rbac_stats: '{roles}ロール、{assignments}件の割り当て',
	admin_admin_access_control_abac_subtitle: '管理者属性',
	admin_admin_access_control_abac_description:
		'Attribute-based access controlで使う管理者属性を定義・管理します。',
	admin_admin_access_control_abac_stats: '{attributes}属性（有効: {active}）',
	admin_admin_access_control_rebac_subtitle: '管理者リレーション',
	admin_admin_access_control_rebac_description:
		'管理者間の複雑な関係をモデル化し、より細かなアクセス制御に使います。',
	admin_admin_access_control_rebac_stats: '{definitions}定義、{tuples}タプル',
	admin_admin_access_control_policies_title: 'ポリシー',
	admin_admin_access_control_policies_subtitle: '管理者向け複合ルール',
	admin_admin_access_control_policies_description:
		'Admin RBAC、ABAC、ReBACの条件を組み合わせ、管理者向けの細かなアクセス制御ポリシーを作成します。複数の要素を評価する複雑なルールを定義できます。',
	admin_admin_access_control_policies_stats: '{policies}ポリシー（有効: {active}）',
	admin_admin_access_control_related_tools: '関連ツール',
	admin_admin_access_control_admin_audit_log: '管理者監査ログ',
	admin_admin_access_control_admin_audit_log_desc: '管理者操作を確認',
	admin_admin_access_control_ip_allowlist: 'IP許可リスト',
	admin_admin_access_control_ip_allowlist_desc: 'ネットワークアクセス制御'
} as const;

export default adminAdminAccessControl;
