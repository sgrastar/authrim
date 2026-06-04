const adminOperationalLogs = {
	admin_operational_logs_head_title: 'Operational Logs - Admin Dashboard - Authrim',
	admin_operational_logs_title: 'Operational Logs',
	admin_operational_logs_description:
		'View short-retention reason-detail records stored separately from immutable audit logs.',
	admin_operational_logs_refresh: 'Refresh',
	admin_operational_logs_subject_type: 'Subject Type',
	admin_operational_logs_all: 'All',
	admin_operational_logs_subject_user: 'User',
	admin_operational_logs_subject_client: 'Client',
	admin_operational_logs_subject_session: 'Session',
	admin_operational_logs_subject_id: 'Subject ID',
	admin_operational_logs_action: 'Action',
	admin_operational_logs_actor_id: 'Actor ID',
	admin_operational_logs_entries: 'Entries',
	admin_operational_logs_total_count: '{count:number} total',
	admin_operational_logs_loading: 'Loading operational logs...',
	admin_operational_logs_empty: 'No operational logs matched the current filters.',
	admin_operational_logs_subject: 'Subject',
	admin_operational_logs_actor: 'Actor',
	admin_operational_logs_created: 'Created',
	admin_operational_logs_expires: 'Expires',
	admin_operational_logs_view_detail: 'View Detail',
	admin_operational_logs_detail_title: 'Operational Log Detail',
	admin_operational_logs_detail_loading: 'Loading operational log detail...',
	admin_operational_logs_request_id: 'Request ID',
	admin_operational_logs_reason_detail: 'Reason Detail',
	admin_operational_logs_load_failed: 'Failed to load operational logs',
	admin_operational_logs_detail_load_failed: 'Failed to load operational log detail'
} as const;

export default adminOperationalLogs;
