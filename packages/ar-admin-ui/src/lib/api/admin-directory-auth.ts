import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';

export type DirectoryAuthMigrationCampaignStatus =
	| 'disabled'
	| 'draft'
	| 'active'
	| 'paused'
	| 'archived';

export type DirectoryAuthMigrationPolicyMode =
	| 'directory_login_allowed'
	| 'prompt_passkey'
	| 'grace_then_require_passkey'
	| 'require_passkey_after_directory'
	| 'disabled';

export type DirectoryAuthPasskeyPromptMode = 'none' | 'optional' | 'campaign_only';

export type DirectoryAuthEmailCodeFallbackMode =
	| 'migration_recovery'
	| 'directory_unavailable_recovery'
	| 'admin_invitation_only'
	| 'login_method'
	| 'disabled';

export type DirectoryAuthCampaignEmailCodeFallbackMode =
	| DirectoryAuthEmailCodeFallbackMode
	| 'tenant_default';

export type DirectoryAuthMigrationUserState =
	| 'not_applicable'
	| 'eligible'
	| 'prompted'
	| 'deferred'
	| 'passkey_required'
	| 'enrolled'
	| 'blocked'
	| 'recovered';

export interface DirectoryAuthMigrationCampaign {
	id: string;
	tenant_id: string;
	name: string;
	description: string | null;
	status: DirectoryAuthMigrationCampaignStatus;
	mode: DirectoryAuthMigrationPolicyMode;
	passkey_prompt_mode: DirectoryAuthPasskeyPromptMode;
	email_code_fallback_mode: DirectoryAuthCampaignEmailCodeFallbackMode;
	effective_email_code_fallback_mode: DirectoryAuthEmailCodeFallbackMode;
	grace_period_days: number;
	transaction_ttl_seconds: number;
	enforcement_start_mode: 'first_directory_login';
	target_policy: unknown;
	is_template: number;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

export interface DirectoryAuthMigrationUserStateRecord {
	id: string;
	tenant_id: string;
	campaign_id: string;
	user_id: string | null;
	connector_id: string | null;
	directory_subject: string | null;
	cohort_key?: string | null;
	state: DirectoryAuthMigrationUserState;
	first_directory_login_at: number | null;
	prompted_at: number | null;
	deferred_until: number | null;
	passkey_required_at: number | null;
	enrolled_at: number | null;
	blocked_reason: string | null;
	recovery_reason: string | null;
	reset_count: number;
	last_reset_at: number | null;
	last_reset_by: string | null;
	last_reset_reason: string | null;
	created_at: number;
	updated_at: number;
}

export interface DirectoryAuthMigrationCampaignsResponse {
	tenantId: string;
	items: DirectoryAuthMigrationCampaign[];
}

export interface DirectoryAuthMigrationUserStatesResponse {
	tenantId: string;
	items: DirectoryAuthMigrationUserStateRecord[];
}

export interface DirectoryAuthTenantPolicy {
	tenant_id: string;
	email_code_fallback_mode: DirectoryAuthEmailCodeFallbackMode;
	updated_by: string | null;
	created_at: number;
	updated_at: number;
}

export interface DirectoryAuthRetentionPolicy {
	tenant_id: string;
	authrim_audit_retention_days: number;
	wordwarden_local_retention_days: number | null;
	artifact_delete_grace_hours: number;
	updated_by: string | null;
	created_at: number;
	updated_at: number;
}

export interface DirectoryAuthConfigHistory {
	id: string;
	tenant_id: string;
	actor_id: string | null;
	category: string;
	action: string;
	resource_type: string;
	resource_id: string | null;
	before_redacted_json: string;
	after_redacted_json: string;
	before_redacted: unknown;
	after_redacted: unknown;
	created_at: number;
}

export interface DirectoryAuthSummaryLink {
	label: string;
	href: string;
}

export interface DirectoryAuthEvidenceExport {
	id: string;
	tenant_id: string;
	status: 'pending' | 'running' | 'ready' | 'failed' | 'deleted' | 'expired';
	requested_by: string;
	period_start_at: number;
	period_end_at: number;
	size_estimate_bytes: number | null;
	artifact_key: string | null;
	artifact_sha256: string | null;
	artifact_download_url: string | null;
	manifest_signature_key_id: string | null;
	manifest_signature_alg: string | null;
	signed_url_expires_at: number | null;
	retention_expires_at: number;
	download_after_delete: number;
	error_code: string | null;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
	deleted_at: number | null;
}

export interface DirectoryAuthSupportBundle {
	id: string;
	tenant_id: string;
	requested_by: string;
	redaction_level: 'minimal' | 'standard' | 'detailed';
	status: 'pending' | 'running' | 'ready' | 'failed' | 'deleted' | 'expired';
	scope_json: string;
	consent_summary_json: string;
	artifact_key: string | null;
	artifact_sha256: string | null;
	artifact_download_url: string | null;
	retention_expires_at: number;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
	deleted_at: number | null;
}

export interface DirectoryAuthReleaseAdvisory {
	id: string;
	channel: string;
	severity: 'low' | 'medium' | 'high' | 'critical';
	affected_versions_json: string;
	fixed_version: string | null;
	summary: string;
	published_at: number;
	updated_at: number;
	release_url: string | null;
	created_at: number;
}

export interface DirectoryAuthManagedConnectorInstance {
	id: string;
	tenant_id: string;
	connector_id: string;
	instance_id: string;
	display_name: string | null;
	transport: string;
	version: string;
	release_channel: string;
	started_at: string;
	first_seen_at: number;
	last_seen_at: number;
	status: string;
	health_status: string;
	health_summary_json: string;
	config_fingerprint: string;
	config_categories_json: string;
	drift_severity: string;
	deactivated_at: number | null;
	deactivated_by: string | null;
	deactivation_reason: string | null;
	advisory_matches?: Array<{
		id: string;
		severity: DirectoryAuthReleaseAdvisory['severity'];
		fixed_version: string | null;
		summary: string;
		release_url: string | null;
	}>;
	affected_advisory_count?: number;
	updated_at: number;
}

export interface DirectoryAuthManagedConnectorEpisode {
	id: string;
	tenant_id: string;
	connector_id: string;
	instance_id: string;
	status: string;
	started_at: number;
	ended_at: number | null;
	last_seen_at: number;
	reason: string | null;
	acknowledged_at: number | null;
	acknowledged_by: string | null;
	created_at: number;
	updated_at: number;
}

export interface DirectoryAuthOverviewResponse {
	tenantId: string;
	policy: DirectoryAuthTenantPolicy;
	migration: {
		campaigns: DirectoryAuthMigrationCampaign[];
		user_states: DirectoryAuthMigrationUserStateRecord[];
	};
	compliance: {
		retention_policy: DirectoryAuthRetentionPolicy | null;
		evidence_exports: DirectoryAuthEvidenceExport[];
		support_bundles: DirectoryAuthSupportBundle[];
		config_history: DirectoryAuthConfigHistory[];
		public_summary_links: DirectoryAuthSummaryLink[];
	};
	managed_connector: {
		advisories: DirectoryAuthReleaseAdvisory[];
		heartbeat_fields: string[];
	};
}

async function parseError(response: Response, fallback: string): Promise<Error> {
	const error = await response.json().catch(() => ({}));
	return new Error(error.error_description || error.message || error.error || fallback);
}

function tenantDirectoryAuthBase(tenantId: string): string {
	return `${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(tenantId)}/directory-auth`;
}

export const adminDirectoryAuthAPI = {
	async overview(tenantId: string): Promise<DirectoryAuthOverviewResponse> {
		const response = await adminFetch(`${tenantDirectoryAuthBase(tenantId)}/overview`, {
			tenantId
		});
		if (!response.ok) throw await parseError(response, 'Failed to load directory auth overview');
		return response.json();
	},

	async listCampaigns(tenantId: string): Promise<DirectoryAuthMigrationCampaignsResponse> {
		const response = await adminFetch(`${tenantDirectoryAuthBase(tenantId)}/migration/campaigns`, {
			tenantId
		});
		if (!response.ok) throw await parseError(response, 'Failed to load migration campaigns');
		return response.json();
	},

	async getTenantPolicy(
		tenantId: string
	): Promise<{ tenantId: string; policy: DirectoryAuthTenantPolicy }> {
		const response = await adminFetch(`${tenantDirectoryAuthBase(tenantId)}/policy`, {
			tenantId
		});
		if (!response.ok) throw await parseError(response, 'Failed to load directory auth policy');
		return response.json();
	},

	async updateTenantPolicy(
		tenantId: string,
		policy: { email_code_fallback_mode: DirectoryAuthEmailCodeFallbackMode }
	): Promise<{ tenantId: string; policy: DirectoryAuthTenantPolicy }> {
		const response = await adminFetch(`${tenantDirectoryAuthBase(tenantId)}/policy`, {
			method: 'PUT',
			includeJsonContentType: true,
			tenantId,
			body: JSON.stringify(policy)
		});
		if (!response.ok) throw await parseError(response, 'Failed to update directory auth policy');
		return response.json();
	},

	async createCampaign(
		tenantId: string,
		campaign: {
			name: string;
			description?: string | null;
			status?: DirectoryAuthMigrationCampaignStatus;
			mode?: DirectoryAuthMigrationPolicyMode;
			passkey_prompt_mode?: DirectoryAuthPasskeyPromptMode;
			email_code_fallback_mode?: DirectoryAuthCampaignEmailCodeFallbackMode;
			grace_period_days?: number;
			transaction_ttl_seconds?: number;
			target_policy?: unknown;
		}
	): Promise<{ tenantId: string; item: DirectoryAuthMigrationCampaign }> {
		const response = await adminFetch(`${tenantDirectoryAuthBase(tenantId)}/migration/campaigns`, {
			method: 'POST',
			includeJsonContentType: true,
			tenantId,
			body: JSON.stringify(campaign)
		});
		if (!response.ok) throw await parseError(response, 'Failed to create migration campaign');
		return response.json();
	},

	async updateCampaign(
		tenantId: string,
		campaignId: string,
		campaign: {
			name?: string;
			description?: string | null;
			status?: DirectoryAuthMigrationCampaignStatus;
			mode?: DirectoryAuthMigrationPolicyMode;
			passkey_prompt_mode?: DirectoryAuthPasskeyPromptMode;
			email_code_fallback_mode?: DirectoryAuthCampaignEmailCodeFallbackMode;
			grace_period_days?: number;
			transaction_ttl_seconds?: number;
			target_policy?: unknown;
		}
	): Promise<{ tenantId: string; item: DirectoryAuthMigrationCampaign }> {
		const response = await adminFetch(
			`${tenantDirectoryAuthBase(tenantId)}/migration/campaigns/${encodeURIComponent(campaignId)}`,
			{
				method: 'PATCH',
				includeJsonContentType: true,
				tenantId,
				body: JSON.stringify(campaign)
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to update migration campaign');
		return response.json();
	},

	async listUserStates(
		tenantId: string,
		filters: {
			state?: DirectoryAuthMigrationUserState;
			campaign_id?: string;
			user_id?: string;
		} = {}
	): Promise<DirectoryAuthMigrationUserStatesResponse> {
		const params = new URLSearchParams({ limit: '50' });
		if (filters.state) params.set('state', filters.state);
		if (filters.campaign_id) params.set('campaign_id', filters.campaign_id);
		if (filters.user_id) params.set('user_id', filters.user_id);
		const response = await adminFetch(
			`${tenantDirectoryAuthBase(tenantId)}/migration/user-states?${params.toString()}`,
			{ tenantId }
		);
		if (!response.ok) throw await parseError(response, 'Failed to load migration user states');
		return response.json();
	},

	async resetUserState(
		tenantId: string,
		stateId: string,
		reason: string
	): Promise<{ tenantId: string; item: DirectoryAuthMigrationUserStateRecord }> {
		const response = await adminFetch(
			`${tenantDirectoryAuthBase(tenantId)}/migration/user-states/${encodeURIComponent(
				stateId
			)}/reset`,
			{
				method: 'POST',
				includeJsonContentType: true,
				tenantId,
				body: JSON.stringify({ reason })
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to reset migration state');
		return response.json();
	},

	async getRetention(
		tenantId: string
	): Promise<{ tenantId: string; policy: DirectoryAuthRetentionPolicy }> {
		const response = await adminFetch(`${tenantDirectoryAuthBase(tenantId)}/compliance/retention`, {
			tenantId
		});
		if (!response.ok) throw await parseError(response, 'Failed to load retention policy');
		return response.json();
	},

	async updateRetention(
		tenantId: string,
		policy: {
			authrim_audit_retention_days: number;
			wordwarden_local_retention_days: number | null;
			artifact_delete_grace_hours: number;
		}
	): Promise<{ tenantId: string; policy: DirectoryAuthRetentionPolicy }> {
		const response = await adminFetch(`${tenantDirectoryAuthBase(tenantId)}/compliance/retention`, {
			method: 'PUT',
			includeJsonContentType: true,
			tenantId,
			body: JSON.stringify(policy)
		});
		if (!response.ok) throw await parseError(response, 'Failed to update retention policy');
		return response.json();
	},

	async listConfigHistory(tenantId: string): Promise<{
		tenantId: string;
		items: DirectoryAuthConfigHistory[];
		public_summary_links: DirectoryAuthSummaryLink[];
	}> {
		const response = await adminFetch(
			`${tenantDirectoryAuthBase(tenantId)}/compliance/config-history?limit=50`,
			{ tenantId }
		);
		if (!response.ok) throw await parseError(response, 'Failed to load config history');
		return response.json();
	},

	async runMaintenanceCleanup(
		tenantId: string,
		reason: string
	): Promise<{
		tenantId: string;
		result: {
			migration_transactions_expired: number;
			evidence_exports_expired: number;
			evidence_exports_deleted: number;
			support_bundles_expired: number;
			support_bundles_deleted: number;
		};
	}> {
		const response = await adminFetch(`${tenantDirectoryAuthBase(tenantId)}/maintenance/cleanup`, {
			method: 'POST',
			includeJsonContentType: true,
			tenantId,
			body: JSON.stringify({ reason })
		});
		if (!response.ok) throw await parseError(response, 'Failed to run maintenance cleanup');
		return response.json();
	},

	async listEvidenceExports(
		tenantId: string
	): Promise<{ tenantId: string; items: DirectoryAuthEvidenceExport[] }> {
		const response = await adminFetch(
			`${tenantDirectoryAuthBase(tenantId)}/compliance/evidence-exports?limit=50`,
			{ tenantId }
		);
		if (!response.ok) throw await parseError(response, 'Failed to load evidence exports');
		return response.json();
	},

	async createEvidenceExport(
		tenantId: string,
		request: {
			period_start_at: number;
			period_end_at: number;
			download_after_delete?: boolean;
		}
	): Promise<{ tenantId: string; item: DirectoryAuthEvidenceExport }> {
		const response = await adminFetch(
			`${tenantDirectoryAuthBase(tenantId)}/compliance/evidence-exports`,
			{
				method: 'POST',
				includeJsonContentType: true,
				tenantId,
				body: JSON.stringify(request)
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to create evidence export');
		return response.json();
	},

	async listSupportBundles(
		tenantId: string
	): Promise<{ tenantId: string; items: DirectoryAuthSupportBundle[] }> {
		const response = await adminFetch(
			`${tenantDirectoryAuthBase(tenantId)}/support/bundles?limit=50`,
			{
				tenantId
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to load support bundles');
		return response.json();
	},

	async createSupportBundle(
		tenantId: string,
		request: {
			redaction_level: 'minimal' | 'standard' | 'detailed';
			scope?: {
				connector_ids?: string[];
				include_recent_episodes?: boolean;
				include_advisories?: boolean;
			};
			consent_summary: {
				operator_confirmed: true;
				detailed_warning_acknowledged?: boolean;
			};
		}
	): Promise<{ tenantId: string; item: DirectoryAuthSupportBundle }> {
		const response = await adminFetch(`${tenantDirectoryAuthBase(tenantId)}/support/bundles`, {
			method: 'POST',
			includeJsonContentType: true,
			tenantId,
			body: JSON.stringify(request)
		});
		if (!response.ok) throw await parseError(response, 'Failed to create support bundle');
		return response.json();
	},

	async listAdvisories(
		tenantId: string
	): Promise<{ tenantId: string; channel: string; items: DirectoryAuthReleaseAdvisory[] }> {
		const response = await adminFetch(`${tenantDirectoryAuthBase(tenantId)}/managed/advisories`, {
			tenantId
		});
		if (!response.ok) throw await parseError(response, 'Failed to load release advisories');
		return response.json();
	},

	async listManagedConnectors(tenantId: string): Promise<{
		tenantId: string;
		items: DirectoryAuthManagedConnectorInstance[];
		recent_episodes: DirectoryAuthManagedConnectorEpisode[];
	}> {
		const response = await adminFetch(`${tenantDirectoryAuthBase(tenantId)}/managed/connectors`, {
			tenantId
		});
		if (!response.ok) throw await parseError(response, 'Failed to load managed connectors');
		return response.json();
	}
};
