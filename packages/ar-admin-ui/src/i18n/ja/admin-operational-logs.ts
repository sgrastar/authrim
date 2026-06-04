const adminOperationalLogs = {
	admin_operational_logs_head_title: 'Operational Logs - Admin Dashboard - Authrim',
	admin_operational_logs_title: 'Operational Logs',
	admin_operational_logs_description:
		'Immutable audit logsとは別に保存される、短期保持のreason detail recordを表示します。',
	admin_operational_logs_refresh: '更新',
	admin_operational_logs_subject_type: 'Subject Type',
	admin_operational_logs_all: 'すべて',
	admin_operational_logs_subject_user: 'User',
	admin_operational_logs_subject_client: 'Client',
	admin_operational_logs_subject_session: 'Session',
	admin_operational_logs_subject_id: 'Subject ID',
	admin_operational_logs_action: 'Action',
	admin_operational_logs_actor_id: 'Actor ID',
	admin_operational_logs_entries: 'Entries',
	admin_operational_logs_total_count: '合計{count}件',
	admin_operational_logs_loading: 'Operational logsを読み込み中...',
	admin_operational_logs_empty: '現在のfilterに一致するoperational logはありません。',
	admin_operational_logs_subject: 'Subject',
	admin_operational_logs_actor: 'Actor',
	admin_operational_logs_created: 'Created',
	admin_operational_logs_expires: 'Expires',
	admin_operational_logs_view_detail: 'Detailを表示',
	admin_operational_logs_detail_title: 'Operational Log Detail',
	admin_operational_logs_detail_loading: 'Operational log detailを読み込み中...',
	admin_operational_logs_request_id: 'Request ID',
	admin_operational_logs_reason_detail: 'Reason Detail',
	admin_operational_logs_load_failed: 'Operational logsの読み込みに失敗しました',
	admin_operational_logs_detail_load_failed: 'Operational log detailの読み込みに失敗しました'
} as const;

export default adminOperationalLogs;
