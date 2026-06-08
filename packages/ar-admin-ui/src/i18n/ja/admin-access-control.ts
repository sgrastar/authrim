const adminAccessControl = {
	admin_access_control_head_title: 'アクセス制御ハブ - 管理ダッシュボード - Authrim',
	admin_access_control_banner_title: 'End Userアクセス制御',
	admin_access_control_banner:
		'このページではEnd User（アプリケーションのユーザー）向けのアクセス制御を管理します。Admin Operator向けのアクセス制御は ',
	admin_access_control_admin_hub: 'Admin Access Control Hub',
	admin_access_control_title: 'アクセス制御ハブ',
	admin_access_control_description:
		'RBAC、ABAC、ReBAC、Policyベースのアクセス制御を統合管理します。',
	admin_access_control_loading: 'アクセス制御統計を読み込んでいます...',
	admin_access_control_load_failed: 'アクセス制御統計の読み込みに失敗しました',
	admin_access_control_retry: '再試行',
	admin_access_control_rbac_subtitle: 'ロール',
	admin_access_control_rbac_description:
		'ロールベースアクセス制御でユーザーのロールと権限を管理します。',
	admin_access_control_rbac_stats: '{roles}ロール、{assignments}件の割り当て',
	admin_access_control_abac_subtitle: '属性',
	admin_access_control_abac_description:
		'属性ベースアクセス制御向けのユーザー属性を定義・管理します。',
	admin_access_control_abac_stats: '{attributes}属性（有効: {active}）',
	admin_access_control_rebac_subtitle: '関係',
	admin_access_control_rebac_description:
		'細かなアクセス制御のために、エンティティ間の複雑な関係をモデル化します。',
	admin_access_control_rebac_stats: '{definitions}定義、{tuples}タプル',
	admin_access_control_policies_title: 'ポリシー',
	admin_access_control_policies_subtitle: '複合ルール',
	admin_access_control_policies_description:
		'RBAC、ABAC、ReBACの条件を組み合わせて、細かなアクセス制御ポリシーを作成します。複数の要素を評価してアクセス可否を判断する複雑なルールを定義できます。',
	admin_access_control_policies_stats: '{policies}ポリシー（有効: {active}）',
	admin_access_control_related_tools: '関連ツール',
	admin_access_control_access_trace: 'Access Trace',
	admin_access_control_access_trace_desc: 'アクセス判定をデバッグ',
	admin_access_control_role_rules: 'ロール割り当てルール',
	admin_access_control_role_rules_desc: 'ロールの自動割り当て'
} as const;

export default adminAccessControl;
