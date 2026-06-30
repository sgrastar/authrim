import type { RequestEvent } from '@sveltejs/kit';

const DEV_ADMIN_MOCK_FLAG = 'AUTHRIM_ADMIN_UI_DEV_MOCK';
const DEV_ADMIN_MOCK_SENTINEL = '__AUTHRIM_ADMIN_UI_DEV_MOCK_SENTINEL__';
const TENANT_ID = 'dev-tenant';
const NOW = 1780704000000;
const NOW_SECONDS = Math.floor(NOW / 1000);

type EnvLike = Record<string, unknown> | undefined;
type DevApprovalRequestStatus =
	| 'pending'
	| 'partially_approved'
	| 'approved'
	| 'denied'
	| 'expired'
	| 'cancelled';
type DevApprovalDecisionStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
type DevApprovalTransportMethod =
	| 'ciba'
	| 'passkey'
	| 'portal_confirm'
	| 'email_otp'
	| 'sms_otp'
	| 'reauth';

interface DevApprovalStep {
	id: string;
	approval_request_id: string;
	step_key: string;
	side: 'admin_operator' | 'customer_data_owner' | 'guardian_delegate';
	subject_type: 'admin_user' | 'end_user' | 'customer_delegate' | 'service_principal';
	subject_id?: string | null;
	relation_type?: string | null;
	relation_source?: string | null;
	status: DevApprovalDecisionStatus;
	method?: DevApprovalTransportMethod | null;
	transport_channel?: string | null;
	reason_code?: string | null;
	reason_note?: string | null;
	last_notification_action?: 'initial' | 'resend' | 'remind' | null;
	last_notified_at?: number | null;
	notification_count: number;
	decided_at?: number | null;
	expires_at: number;
	created_at: number;
	updated_at: number;
}

interface DevApprovalGrant {
	id: string;
	public_grant_id: string;
	approval_request_id: string;
	tenant_id: string;
	status: 'active' | 'expired' | 'revoked';
	target_audience: string;
	resource_class: string;
	redaction_level: 'summary_only' | 'masked' | 'raw';
	scope_canonical: string;
	scope_json: Record<string, unknown>;
	authorization_details_json?: Record<string, unknown> | null;
	requester_subject_type: string;
	requester_subject_id: string;
	actor_subject_type: string;
	actor_subject_id: string;
	issued_at: number;
	expires_at: number;
	revoked_at?: number | null;
	revoke_reason?: string | null;
	created_at: number;
	updated_at: number;
}

interface DevApprovalRequest {
	id: string;
	public_request_id: string;
	tenant_id: string;
	investigation_id: string;
	requester_subject_type: string;
	requester_subject_id: string;
	target_subject_type: string;
	target_subject_id: string;
	request_surface: string;
	requested_action: string;
	redaction_level: 'summary_only' | 'masked' | 'raw';
	status: DevApprovalRequestStatus;
	scope_json: Record<string, unknown>;
	scope_canonical: string;
	reason_code: string;
	reason_note?: string | null;
	reference?: { system: string; id: string; url?: string | null } | null;
	ticket_reference?: { system: string; id: string; url?: string | null } | null;
	reuse_scope: 'request' | 'case';
	policy_preset: string;
	partial_access_allowed: boolean;
	has_detail?: boolean;
	expires_at: number;
	decided_at?: number | null;
	created_at: number;
	updated_at: number;
	approvals: DevApprovalStep[];
	grants: DevApprovalGrant[];
	resolved_policy?: {
		preset: string;
		request_ttl_seconds: number | null;
		notification_cooldown_seconds?: {
			remind: number;
			resend: number;
		};
	};
}

interface DevClient {
	client_id: string;
	client_name: string;
	description?: string | null;
	client_secret?: string;
	grant_types: string[];
	response_types: string[];
	redirect_uris: string[];
	token_endpoint_auth_method: string;
	browser_public_client_mode?: 'strict' | 'cookie_fallback' | null;
	browser_refresh_token_policy?: 'disabled' | 'dpop_bound' | null;
	scope?: string;
	contacts?: string[];
	logo_uri?: string | null;
	client_uri?: string | null;
	policy_uri?: string | null;
	tos_uri?: string | null;
	is_trusted?: boolean;
	skip_consent?: boolean;
	allow_claims_without_scope?: boolean;
	claims_parameter_policy?: Record<string, string> | null;
	identity_mapping?: Record<string, unknown> | null;
	attribute_release_consent?: { enabled: boolean; mode: string } | null;
	asc_enabled?: boolean;
	asc_protected_request_required?: boolean;
	asc_sao_enabled?: boolean;
	asc_transformed_claims_enabled?: boolean;
	asc_allowed_transformed_claims?: string[] | null;
	login_ui_url?: string | null;
	id_token_signed_response_alg?: string;
	require_pkce?: boolean;
	token_exchange_allowed?: boolean;
	allowed_subject_token_clients?: string[];
	allowed_token_exchange_resources?: string[];
	delegation_mode?: 'none' | 'delegation' | 'impersonation';
	client_credentials_allowed?: boolean;
	allowed_scopes?: string[];
	default_scope?: string | null;
	default_audience?: string | null;
	access_token_ttl?: number;
	refresh_token_ttl?: number;
	web_origin_registry?: Record<string, unknown>;
	created_at: number;
	updated_at: number;
}

interface DevSamlProvider {
	id: string;
	name: string;
	providerType: 'saml_idp' | 'saml_sp';
	config: Record<string, unknown>;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

interface DevDirectoryConnector {
	id: string;
	transport: 'direct' | 'relay';
	endpoint_url: string;
	auth_mode: 'hmac';
	connector_id: string;
	key_id: string;
	secret_ref: string;
	timeouts: {
		request_ms: number;
	};
	relay: {
		verify_timeout_ms: number;
		max_pending_requests: number;
		challenge_ttl_ms: number;
		auth_failure_rate_limit_per_minute: number;
		auth_failure_block_ms: number;
		secret_rotation_grace_ms: number;
	};
	heartbeat: {
		key_id: string;
		secret_ref: string;
		previous_key_id: string;
		previous_secret_ref: string;
		interval_ms: number;
		stale_after_ms: number;
		retention_days: number;
		version_mismatch_policy: 'warn' | 'block';
		expected_version: string;
		minimum_version: string;
		unhealthy_threshold: number;
		stale_detection_grace_ms: number;
	};
	attribute_names: string[];
}

interface DevDirectoryConnectorConfig {
	enabled: boolean;
	default_connector_id: string;
	auto_provision: boolean;
	connectors: DevDirectoryConnector[];
}

interface DevDirectoryAuthCampaign {
	id: string;
	tenant_id: string;
	name: string;
	description: string | null;
	status: 'disabled' | 'draft' | 'active' | 'paused' | 'archived';
	mode:
		| 'directory_login_allowed'
		| 'prompt_passkey'
		| 'grace_then_require_passkey'
		| 'require_passkey_after_directory'
		| 'disabled';
	passkey_prompt_mode: 'none' | 'optional' | 'campaign_only';
	email_code_fallback_mode:
		| 'tenant_default'
		| 'migration_recovery'
		| 'directory_unavailable_recovery'
		| 'admin_invitation_only'
		| 'login_method'
		| 'disabled';
	grace_period_days: number;
	transaction_ttl_seconds: number;
	enforcement_start_mode: 'first_directory_login';
	target_policy: Record<string, unknown>;
	is_template: number;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

interface DevDirectoryAuthUserState {
	id: string;
	tenant_id: string;
	campaign_id: string;
	user_id: string | null;
	connector_id: string | null;
	directory_subject: string | null;
	cohort_key?: string | null;
	state:
		| 'not_applicable'
		| 'eligible'
		| 'prompted'
		| 'deferred'
		| 'passkey_required'
		| 'enrolled'
		| 'blocked'
		| 'recovered';
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

interface DevDirectoryAuthTenantPolicy {
	tenant_id: string;
	email_code_fallback_mode:
		| 'migration_recovery'
		| 'directory_unavailable_recovery'
		| 'admin_invitation_only'
		| 'login_method'
		| 'disabled';
	updated_by: string | null;
	created_at: number;
	updated_at: number;
}

interface DevDirectoryAuthRetentionPolicy {
	tenant_id: string;
	authrim_audit_retention_days: number;
	wordwarden_local_retention_days: number | null;
	artifact_delete_grace_hours: number;
	updated_by: string | null;
	created_at: number;
	updated_at: number;
}

interface DevDirectoryAuthConfigHistory {
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

interface DevDirectoryAuthJob {
	id: string;
	tenant_id: string;
	status: 'pending' | 'running' | 'ready' | 'failed' | 'deleted' | 'expired';
	requested_by: string;
	retention_expires_at: number;
	created_at: number;
	updated_at: number;
	artifact_key: string | null;
	artifact_sha256: string | null;
	artifact_download_url?: string | null;
	completed_at: number | null;
	deleted_at: number | null;
}

interface DevExternalIdPProvider {
	id: string;
	slug?: string;
	tenantId: string;
	name: string;
	providerType: 'oidc' | 'oauth2';
	enabled: boolean;
	priority: number;
	issuer?: string;
	clientId: string;
	hasSecret: boolean;
	authorizationEndpoint?: string;
	tokenEndpoint?: string;
	userinfoEndpoint?: string;
	jwksUri?: string;
	scopes: string;
	attributeMapping: Record<string, string>;
	autoLinkEmail: boolean;
	jitProvisioning: boolean;
	requireEmailVerified: boolean;
	alwaysFetchUserinfo?: boolean;
	enableSso?: boolean;
	iconUrl?: string;
	iconName?: string;
	buttonColor?: string;
	buttonColorDark?: string;
	buttonText?: string;
	createdAt: number;
	updatedAt: number;
}

interface DevSession {
	id: string;
	user_id: string;
	user_email: string | null;
	user_name: string | null;
	created_at: string;
	last_accessed_at: string;
	expires_at: string;
	ip_address: string | null;
	user_agent: string | null;
	is_active: boolean;
}

interface DevSettings {
	category: string;
	version: string;
	values: Record<string, unknown>;
	sources: Record<string, 'default' | 'kv' | 'env'>;
}

interface DevStorageDestination {
	id: string;
	scope_type: 'tenant' | 'platform';
	scope_id: string;
	name: string;
	display_name: string;
	description: string | null;
	provider: 'r2' | 'aws_s3' | 'custom';
	config: Record<string, unknown>;
	managed_by?: 'setup' | 'admin';
	read_only?: boolean;
	has_credential: boolean;
	credential_key_version: number | null;
	credential_updated_at: number | null;
	credential_updated_by: string | null;
	status: 'active' | 'disabled';
	created_by: string | null;
	updated_by: string | null;
	created_at: number;
	updated_at: number;
}

interface DevStorageDestinationUsage {
	id: string;
	destination_id: string;
	feature: string;
	resource_type: string;
	resource_id: string;
	tenant_id: string;
	metadata: Record<string, unknown>;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

interface DevControlPlaneDestination {
	id: string;
	scope_type: 'platform' | 'tenant' | 'shared';
	scope_id: string | null;
	destination_kind: string;
	name: string;
	display_name: string;
	description: string | null;
	provider:
		| 'r2'
		| 'aws_s3'
		| 'http'
		| 'logpush'
		| 'analytics_engine'
		| 'firehose'
		| 'external'
		| 'custom';
	provider_config: Record<string, unknown>;
	allowed_tenant_ids: string | null;
	allowed_log_types: string | null;
	allowed_planes: string | null;
	region: string | null;
	critical_allowed: number;
	default_fallback_eligible: number;
	runtime_supported?: boolean;
	runtime_status?: 'supported' | 'unsupported';
	runtime_unsupported_reason?: string | null;
	retention_days: number | null;
	encryption_mode: string;
	lifecycle_status: 'active' | 'disabled' | 'deleted';
	health_status: string;
	rotation_status: string;
	credential_ref: string | null;
	credential_version: number;
	next_credential_ref: string | null;
	next_credential_version: number | null;
	previous_credential_ref: string | null;
	previous_credential_retire_after: number | null;
	last_health_check_at: number | null;
	created_at: number;
	updated_at: number;
	deleted_at: number | null;
	version: number;
	capabilities?: Array<{
		capability: string;
		source: string;
		enabled: number;
		created_at?: number;
		updated_at?: number;
	}>;
}

interface DevCacheTTLConfig {
	clientMetadata: number;
	redirectUris: number;
	grantTypes: number;
	scopes: number;
	jwks: number;
	clientSecret: number;
	tenant: number;
	policy: number;
}

interface DevCustomClaimSchema {
	id: string;
	field_key: string;
	display_label: string;
	field_type: 'string' | 'number' | 'boolean' | 'date' | 'enum';
	is_pii: boolean;
	is_required: boolean;
	is_active: boolean;
	is_system: boolean;
	description: string | null;
	validation_rules: Record<string, unknown> | null;
	include_in_id_token: boolean;
	include_in_userinfo: boolean;
	include_in_introspection: boolean;
	required_scopes: string[] | null;
	scope_mode: 'any' | 'all';
	display_order: number;
	claim_namespace: string | null;
	is_searchable: boolean;
	is_exportable: boolean;
	is_vc_claim: boolean;
	show_on_registration: boolean;
	registration_required: boolean;
	registration_order: number;
	registration_placeholder: string | null;
	operation_status: 'active' | 'renaming' | 'deleting' | 'error';
	operation_detail: string | null;
	schema_version: number;
	user_count: number;
	user_count_approximate: boolean;
	ui_group_key: string;
	ui_group_label: string;
	ui_group_order: number;
	ui_field_order: number;
	created_at: number;
	updated_at: number;
	created_by: string;
}

interface DevRole {
	id: string;
	tenant_id: string;
	name: string;
	display_name?: string;
	description?: string;
	is_system: boolean;
	permissions: string[];
	inherits_from?: string;
	assignment_count: number;
	created_at: number;
	updated_at: number;
}

interface DevRoleAssignedUser {
	assignment_id: string;
	user_id: string;
	user_email: string | null;
	user_name: string | null;
	scope: 'global' | 'org' | 'resource';
	scope_target: string;
	granted_by: string | null;
	expires_at: number | null;
	assigned_at: number;
}

interface DevFlowNode {
	id: string;
	type: string;
	position: { x: number; y: number };
	data: {
		label: string;
		icon?: string;
		color?: string;
		config?: Record<string, unknown>;
	};
}

interface DevFlow {
	id: string;
	tenant_id: string;
	client_id: string | null;
	profile_id: 'human-basic' | 'human-org' | 'ai-agent' | 'iot-device';
	name: string;
	description: string | null;
	graph_definition: {
		nodes: DevFlowNode[];
		edges: Array<Record<string, unknown>>;
		metadata: Record<string, unknown>;
	} | null;
	compiled_plan: Record<string, unknown> | null;
	version: string;
	is_active: boolean;
	is_builtin: boolean;
	created_by: string | null;
	created_at: number;
	updated_by: string | null;
	updated_at: number;
	slug?: string;
	display_name?: string;
	kind?: 'login' | 'registration' | 'approve' | 'account' | `custom:${string}`;
	status?: 'draft' | 'published' | 'disabled';
	draft_editor_json?: Record<string, unknown> | null;
	draft_runtime_base_json?: Record<string, unknown> | null;
	published_version_id?: string | null;
	deleted_at?: number | null;
}

interface DevFlowAssignment {
	id: string;
	tenant_id: string;
	target_type: 'tenant' | 'oidc_client' | 'saml_sp';
	target_id: string | null;
	flow_kind: 'login' | 'registration' | 'approve' | 'account' | `custom:${string}`;
	flow_id: string;
	enabled: boolean;
	created_at: number;
	updated_at: number;
}

interface DevFlowVersion {
	id: string;
	tenant_id: string;
	flow_id: string;
	version_number: number;
	schema_version: 'authrim.login_ui.contract.v1';
	runtime_snapshot: Record<string, unknown>;
	editor_snapshot: Record<string, unknown> | null;
	validation_result: Record<string, unknown>;
	published_by: string | null;
	published_at: number;
	created_at: number;
}

interface DevAdminAttribute {
	id: string;
	tenant_id: string;
	name: string;
	display_name: string | null;
	description: string | null;
	attribute_type: 'string' | 'enum' | 'number' | 'boolean' | 'date' | 'array';
	allowed_values: string[] | null;
	min_value: number | null;
	max_value: number | null;
	regex_pattern: string | null;
	is_required: boolean;
	is_multi_valued: boolean;
	is_system: boolean;
	created_at: number;
	updated_at: number;
}

interface DevAdminRebacDefinition {
	id: string;
	tenant_id: string;
	relation_name: string;
	display_name: string | null;
	description: string | null;
	priority: number;
	is_system: boolean;
	created_at: number;
	updated_at: number;
}

interface DevAdminRelationship {
	id: string;
	tenant_id: string;
	relationship_type: string;
	from_type: string | null;
	from_id: string;
	to_type: string | null;
	to_id: string;
	permission_level: 'full' | 'limited' | 'read_only' | null;
	is_transitive: boolean;
	expires_at: number | null;
	is_bidirectional: boolean;
	metadata: Record<string, unknown> | null;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

interface DevAdminPolicy {
	id: string;
	tenant_id: string;
	name: string;
	display_name: string | null;
	description: string | null;
	effect: 'allow' | 'deny';
	priority: number;
	resource_pattern: string;
	actions: string[];
	conditions: Record<string, unknown>;
	is_active: boolean;
	is_system: boolean;
	created_at: number;
	updated_at: number;
}

interface DevAdminUser {
	id: string;
	tenant_id: string;
	email: string;
	email_verified: boolean;
	name: string | null;
	is_active: boolean;
	status: 'active' | 'suspended' | 'locked';
	mfa_enabled: boolean;
	mfa_method: 'totp' | 'passkey' | 'both' | null;
	last_login_at: number | null;
	last_login_ip: string | null;
	failed_login_count: number;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

interface DevEndUser {
	id: string;
	tenant_id: string;
	email: string | null;
	name: string | null;
	given_name: string | null;
	family_name: string | null;
	nickname: string | null;
	preferred_username: string | null;
	picture: string | null;
	phone_number: string | null;
	email_verified: boolean;
	phone_number_verified: boolean;
	user_type: string;
	is_active: boolean;
	pii_partition: string;
	pii_status: string;
	created_at: number;
	updated_at: number;
	last_login_at: number | null;
	status: 'active' | 'suspended' | 'locked';
	suspended_at: number | null;
	suspended_until: number | null;
	locked_at: number | null;
	locked_until: number | null;
	passkeys?: Array<{
		id: string;
		device_name: string | null;
		created_at: number;
		last_used_at: number | null;
	}>;
}

interface DevAdminRoleAssignment {
	id: string;
	assignment_id: string;
	role_id: string;
	name: string;
	display_name: string | null;
	scope_type: 'global' | 'tenant' | 'org';
	scope_id: string | null;
	assigned_at: number;
	expires_at: number | null;
	assigned_by: string | null;
}

interface DevAdminAuditLogEntry {
	id: string;
	tenant_id: string;
	detail_artifact_id?: string | null;
	admin_user_id: string | null;
	admin_email: string | null;
	admin_user_name?: string | null;
	actor_type?: 'admin_user' | 'machine' | 'system';
	actor_id?: string | null;
	actor_display_name?: string | null;
	machine_principal_id?: string | null;
	machine_principal_type?: string | null;
	machine_credential_id?: string | null;
	machine_client_id?: string | null;
	machine_client_auth_method?: string | null;
	action: string;
	resource_type: string | null;
	resource_id: string | null;
	result: 'success' | 'failure';
	severity: 'debug' | 'info' | 'warn' | 'error' | 'critical';
	ip_address: string | null;
	user_agent: string | null;
	request_id: string | null;
	before: Record<string, unknown> | null;
	after: Record<string, unknown> | null;
	metadata: Record<string, unknown> | null;
	created_at: number;
}

interface DevPolicyCondition {
	type: string;
	params: Record<string, unknown>;
}

interface DevPolicyRule {
	id: string;
	name: string;
	description?: string;
	priority: number;
	effect: 'allow' | 'deny';
	resource_types: string[];
	actions: string[];
	conditions: DevPolicyCondition[];
	enabled: boolean;
	created_by?: string;
	created_at: number;
	updated_by?: string;
	updated_at: number;
}

interface DevAdminPasskey {
	id: string;
	device_name: string | null;
	created_at: number;
	last_used_at: number | null;
}

interface DevIpAllowlistEntry {
	id: string;
	tenant_id: string;
	ip_range: string;
	ip_version: 4 | 6 | null;
	description: string | null;
	enabled: boolean;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

interface DevMachineTenantScope {
	scopeMode: 'none' | 'all' | 'allow';
	tenantId: string | null;
}

interface DevMachineCredential {
	id: string;
	principalId: string;
	kid: string;
	publicJwkJson: string;
	alg: 'ES256' | 'PS256' | 'RS256';
	displayName: string;
	description: string | null;
	status: 'active' | 'rotating' | 'revoked' | 'expired';
	notBefore: number | null;
	expiresAt: number | null;
	lastUsedAt: number | null;
	lastUsedIp: string | null;
	lastUsedUserAgent: string | null;
	createdAt: number;
	updatedAt: number;
	revokedAt: number | null;
	revokeReason: string | null;
}

interface DevMachinePrincipal {
	id: string;
	clientId: string;
	displayName: string;
	description: string | null;
	principalType:
		| 'setup_tool'
		| 'admin_ui_bff'
		| 'automation'
		| 'ci'
		| 'mcp_server'
		| 'ai_agent'
		| 'internal_service'
		| 'integration';
	status: 'active' | 'disabled' | 'deleted';
	defaultAudience: string;
	tokenTtlSeconds: number;
	createdAt: number;
	updatedAt: number;
	disabledAt: number | null;
	permissions: string[];
	tenantScopes: DevMachineTenantScope[];
	credentials: DevMachineCredential[];
}

interface DevSigningKey {
	kid: string;
	algorithm: string;
	status: 'active' | 'overlap' | 'revoked';
	createdAt: string;
	revokedAt?: string;
	overlaps?: boolean;
}

interface DevTenant {
	id: string;
	tenant_code: string;
	name: string;
	description: string | null;
	lifecycle_state:
		| 'provisioning'
		| 'active'
		| 'suspended'
		| 'frozen'
		| 'migration_read_only'
		| 'deleting'
		| 'deleted'
		| 'restore_pending'
		| 'restore_validating';
	is_default: boolean;
	created_at: number;
	updated_at: number;
}

interface DevTenantInvitation {
	id: string;
	tenant_id: string;
	invited_email: string | null;
	invited_by: string;
	role_id: string | null;
	org_id: string | null;
	max_uses: number;
	use_count: number;
	expires_at: number;
	created_at: number;
	updated_at: number;
}

interface DevTenantDomainMapping {
	id: string;
	tenant_id: string;
	hash_version: number;
	priority: number;
	is_active: boolean;
	verified: boolean;
	verification_expires_at: number | null;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

interface DevTenantVanityDomain {
	id: string;
	tenant_id: string;
	hostname: string;
	is_active: boolean;
	is_primary: boolean;
	status: 'pending' | 'pending_manual' | 'active' | 'failed' | 'deleted';
	cloudflare_zone_id: string | null;
	cloudflare_custom_hostname_id: string | null;
	ssl_status: string | null;
	ownership_status: string | null;
	validation_method: string | null;
	validation_records: unknown;
	last_sync_at: number | null;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

interface DevConsentStatement {
	id: string;
	tenant_id: string;
	slug: string;
	category: string;
	legal_basis: string;
	processing_purpose?: string;
	record_retention_days?: number | null;
	withdrawal_allowed?: number;
	withdrawal_impact?: string | null;
	reconsent_on_version_change?: number;
	reconsent_interval_days?: number | null;
	display_order: number;
	is_active: number;
	created_at: number;
	updated_at: number;
}

interface DevConsentStatementVersion {
	id: string;
	tenant_id: string;
	statement_id: string;
	version: string;
	content_type: string;
	effective_at: number;
	effective_until?: number | null;
	content_hash?: string;
	is_current: number;
	status: string;
	created_at: number;
	updated_at: number;
}

interface DevConsentStatementLocalization {
	id: string;
	tenant_id: string;
	version_id: string;
	language: string;
	title: string;
	description: string;
	processing_purpose?: string | null;
	withdrawal_impact?: string | null;
	document_url?: string;
	inline_content?: string;
	created_at: number;
	updated_at: number;
}

interface DevTenantConsentRequirement {
	id: string;
	tenant_id: string;
	statement_id: string;
	is_required: number;
	min_version?: string;
	enforcement: string;
	show_deletion_link: number;
	deletion_url?: string;
	conditional_rules_json?: string;
	display_order: number;
	created_at: number;
	updated_at: number;
}

interface DevConsentPolicy {
	id: string;
	tenant_id: string;
	name: string;
	display_name: string;
	description?: string | null;
	is_active: number;
	created_at: number;
	updated_at: number;
}

interface DevConsentPolicyItem {
	id: string;
	tenant_id: string;
	policy_id: string;
	statement_id: string;
	requirement: 'required' | 'optional' | 'hidden';
	version_mode: 'current' | 'fixed' | 'minimum';
	version_id?: string | null;
	min_version?: string | null;
	checkbox_mode: 'none' | 'required' | 'optional';
	checkbox_default_checked: number;
	binding_type?: 'subject' | 'scope' | 'claim' | 'saml_attribute' | 'destination_field_set' | null;
	binding_value?: string | null;
	evidence_profile?: string | null;
	language_fallback?: string | null;
	display_order: number;
	created_at: number;
	updated_at: number;
}

interface DevClientTrustPolicy {
	id: string;
	tenant_id: string;
	name: string;
	display_name: string;
	description?: string | null;
	target_type: 'tenant_default' | 'oidc_client' | 'saml_sp';
	target_id: string;
	first_party: number;
	trusted: number;
	skip_authorization_consent: number;
	is_active: number;
	created_at: number;
	updated_at: number;
}

interface DevSignInConfirmationPolicy {
	id: string;
	tenant_id: string;
	name: string;
	display_name: string;
	description?: string | null;
	trigger_type: 'login';
	mode: 'disabled' | 'first_time' | 'every_time';
	remember_duration_days: number;
	show_application_context: number;
	show_tenant_context: number;
	is_active: number;
	created_at: number;
	updated_at: number;
}

const fieldMappingSets = [
	{
		id: 'field-mapping-gakunin-basic',
		tenantId: TENANT_ID,
		fieldMappingKey: 'gakunin-basic',
		displayName: 'GakuNin basic profile',
		description: 'Dev mock field mapping set for SAML attributes and OIDC claims.',
		lifecycleState: 'active',
		createdAt: NOW - 86_400_000,
		updatedAt: NOW
	},
	{
		id: 'field-mapping-researcher-oidc',
		tenantId: TENANT_ID,
		fieldMappingKey: 'researcher-oidc',
		displayName: 'Researcher OIDC claims',
		description: 'Dev mock field mapping set for OIDC claim release testing.',
		lifecycleState: 'draft',
		createdAt: NOW - 43_200_000,
		updatedAt: NOW - 3_600_000
	}
];

const fieldMappingVersions = [
	{
		id: 'field-mapping-version-gakunin-basic-v1',
		tenantId: TENANT_ID,
		fieldMappingSetId: 'field-mapping-gakunin-basic',
		versionLabel: 'v1',
		lifecycleState: 'active',
		authorId: 'admin-dev-admin',
		publishedAt: NOW,
		createdAt: NOW,
		updatedAt: NOW,
		directions: { source: true, destination: true },
		sourceProfileIds: ['source-profile-gakunin-saml'],
		destinationProfileIds: ['destination-profile-oidc-core', 'destination-profile-saml-sp'],
		rules: [
			{
				id: 'rule-email',
				ruleKey: 'email',
				ruleKind: 'field',
				action: 'map',
				priority: 10,
				metadata: {},
				edges: [
					{
						id: 'edge-email',
						sourceRef: {
							side: 'source',
							namespace: 'saml.attribute',
							path: 'urn:oid:0.9.2342.19200300.100.1.3'
						},
						targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'email' },
						edgeKind: 'direct',
						displayOrder: 0
					}
				],
				transforms: []
			}
		],
		latestSnapshot: {
			id: 'snapshot-gakunin-basic-v1',
			catalogVersionId: 'catalog-version-core-v1',
			lifecycleState: 'active',
			compiledAt: NOW
		}
	}
];

const catalogEntries = [
	{
		id: 'catalog-entry-email',
		stableFieldId: 'profile.email',
		namespace: 'authrim.profile',
		path: 'email',
		targetTaxonomy: 'person',
		valueType: 'string',
		cardinality: 'single',
		classification: 'contact',
		aliases: [
			{ namespace: 'oidc.claim', path: 'email' },
			{ namespace: 'saml.attribute', path: 'urn:oid:0.9.2342.19200300.100.1.3' }
		],
		uiGroupKey: 'contact',
		uiGroupLabel: 'Contact',
		uiGroupOrder: 10,
		uiFieldOrder: 10,
		nullable: false,
		required: true
	},
	{
		id: 'catalog-entry-display-name',
		stableFieldId: 'profile.display_name',
		namespace: 'authrim.profile',
		path: 'displayName',
		targetTaxonomy: 'person',
		valueType: 'string',
		cardinality: 'single',
		classification: 'profile',
		aliases: [
			{ namespace: 'oidc.claim', path: 'name' },
			{ namespace: 'saml.attribute', path: 'urn:oid:2.5.4.3' }
		],
		uiGroupKey: 'profile',
		uiGroupLabel: 'Profile',
		uiGroupOrder: 20,
		uiFieldOrder: 10,
		nullable: true,
		required: false
	}
];

const customClaimSchemas: DevCustomClaimSchema[] = [
	{
		id: 'dev-claim-employee-id',
		field_key: 'employee_id',
		display_label: 'Employee ID',
		field_type: 'string',
		is_pii: false,
		is_required: true,
		is_active: true,
		is_system: false,
		description: 'Stable employee identifier released to selected client applications.',
		validation_rules: { pattern: '^[A-Z0-9-]{4,32}$' },
		include_in_id_token: true,
		include_in_userinfo: true,
		include_in_introspection: false,
		required_scopes: ['profile'],
		scope_mode: 'any',
		display_order: 10,
		claim_namespace: null,
		is_searchable: true,
		is_exportable: true,
		is_vc_claim: false,
		show_on_registration: true,
		registration_required: false,
		registration_order: 20,
		registration_placeholder: 'EMP-1001',
		operation_status: 'active',
		operation_detail: null,
		schema_version: 3,
		user_count: 42,
		user_count_approximate: false,
		ui_group_key: 'identity',
		ui_group_label: 'Identity',
		ui_group_order: 10,
		ui_field_order: 20,
		created_at: Math.floor(NOW / 1000) - 86400 * 20,
		updated_at: Math.floor(NOW / 1000) - 86400,
		created_by: 'dev-admin'
	},
	{
		id: 'dev-claim-research-consent',
		field_key: 'research_consent',
		display_label: 'Research Consent',
		field_type: 'boolean',
		is_pii: true,
		is_required: false,
		is_active: true,
		is_system: false,
		description: 'Consent flag used by research applications.',
		validation_rules: null,
		include_in_id_token: false,
		include_in_userinfo: true,
		include_in_introspection: false,
		required_scopes: ['research'],
		scope_mode: 'all',
		display_order: 30,
		claim_namespace: 'https://claims.example.test',
		is_searchable: false,
		is_exportable: false,
		is_vc_claim: true,
		show_on_registration: false,
		registration_required: false,
		registration_order: 0,
		registration_placeholder: null,
		operation_status: 'active',
		operation_detail: null,
		schema_version: 1,
		user_count: 17,
		user_count_approximate: true,
		ui_group_key: 'profile',
		ui_group_label: 'Profile',
		ui_group_order: 50,
		ui_field_order: 30,
		created_at: Math.floor(NOW / 1000) - 86400 * 12,
		updated_at: Math.floor(NOW / 1000) - 3600,
		created_by: 'dev-admin'
	}
];

const clients = new Map<string, DevClient>([
	[
		'dev-oidc-client',
		{
			client_id: 'dev-oidc-client',
			client_name: 'Dev OIDC Client',
			description: 'Local Admin UI mock client',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			redirect_uris: ['http://localhost:5173/callback'],
			token_endpoint_auth_method: 'none',
			browser_public_client_mode: 'strict',
			browser_refresh_token_policy: 'dpop_bound',
			scope: 'openid profile email',
			identity_mapping: {
				fieldMappingSetId: 'field-mapping-gakunin-basic',
				destinationNamespace: 'oidc.claim'
			},
			attribute_release_consent: null,
			asc_enabled: true,
			asc_protected_request_required: true,
			asc_sao_enabled: true,
			asc_transformed_claims_enabled: true,
			asc_allowed_transformed_claims: ['age_over_18', 'email_domain'],
			require_pkce: true,
			created_at: NOW,
			updated_at: NOW
		}
	]
]);

const devApprovalRequests = new Map<string, DevApprovalRequest>([
	[
		'ar-dev-pending',
		{
			id: 'dev-approval-request-1',
			public_request_id: 'ar-dev-pending',
			tenant_id: TENANT_ID,
			investigation_id: 'INV-2026-0616-001',
			requester_subject_type: 'admin_user',
			requester_subject_id: 'dev-admin',
			target_subject_type: 'user',
			target_subject_id: 'user_42',
			request_surface: 'admin_audit',
			requested_action: 'detail_read',
			redaction_level: 'masked',
			status: 'pending',
			scope_json: {
				resource_class: 'admin_audit_detail',
				resource_ids: ['audit_evt_9f3a'],
				detail_classes: ['ip_address', 'user_agent']
			},
			scope_canonical: 'admin_audit_detail:audit_evt_9f3a:masked',
			reason_code: 'support_case',
			reason_note: 'Dev mock case for approval theme review',
			reference: {
				system: 'authrim',
				id: 'audit_evt_9f3a'
			},
			ticket_reference: {
				system: 'linear',
				id: 'SEC-1182',
				url: 'https://example.invalid/SEC-1182'
			},
			reuse_scope: 'request',
			policy_preset: 'support_case_default',
			partial_access_allowed: false,
			has_detail: true,
			expires_at: NOW_SECONDS + 3600 * 6,
			decided_at: null,
			created_at: NOW_SECONDS - 1800,
			updated_at: NOW_SECONDS - 900,
			approvals: [
				{
					id: 'dev-approval-step-1',
					approval_request_id: 'dev-approval-request-1',
					step_key: 'operator-1',
					side: 'admin_operator',
					subject_type: 'admin_user',
					subject_id: 'dev-admin',
					status: 'pending',
					method: 'portal_confirm',
					transport_channel: 'admin_ui',
					last_notification_action: 'initial',
					last_notified_at: NOW_SECONDS - 1500,
					notification_count: 1,
					expires_at: NOW_SECONDS + 3600 * 6,
					created_at: NOW_SECONDS - 1800,
					updated_at: NOW_SECONDS - 900
				}
			],
			grants: [],
			resolved_policy: {
				preset: 'support_case_default',
				request_ttl_seconds: 21600,
				notification_cooldown_seconds: {
					remind: 900,
					resend: 1800
				}
			}
		}
	],
	[
		'ar-dev-approved',
		{
			id: 'dev-approval-request-2',
			public_request_id: 'ar-dev-approved',
			tenant_id: TENANT_ID,
			investigation_id: 'INV-2026-0615-014',
			requester_subject_type: 'admin_user',
			requester_subject_id: 'dev-admin',
			target_subject_type: 'service_resource',
			target_subject_id: 'session_store:cluster-a',
			request_surface: 'support_ops',
			requested_action: 'limited_export',
			redaction_level: 'summary_only',
			status: 'approved',
			scope_json: {
				resource_class: 'session_summary',
				resource_ids: ['cluster-a'],
				detail_classes: ['session_count']
			},
			scope_canonical: 'session_summary:cluster-a:summary_only',
			reason_code: 'technical_debug',
			reuse_scope: 'case',
			policy_preset: 'technical_debug_default',
			partial_access_allowed: true,
			has_detail: true,
			expires_at: NOW_SECONDS + 3600 * 2,
			decided_at: NOW_SECONDS - 7200,
			created_at: NOW_SECONDS - 10800,
			updated_at: NOW_SECONDS - 7200,
			approvals: [
				{
					id: 'dev-approval-step-2',
					approval_request_id: 'dev-approval-request-2',
					step_key: 'operator-1',
					side: 'admin_operator',
					subject_type: 'admin_user',
					subject_id: 'dev-admin',
					status: 'approved',
					method: 'passkey',
					transport_channel: 'webauthn',
					reason_code: 'technical_debug',
					notification_count: 1,
					decided_at: NOW_SECONDS - 7200,
					expires_at: NOW_SECONDS + 3600 * 2,
					created_at: NOW_SECONDS - 10800,
					updated_at: NOW_SECONDS - 7200
				}
			],
			grants: [
				{
					id: 'dev-grant-1',
					public_grant_id: 'grant-dev-approved',
					approval_request_id: 'dev-approval-request-2',
					tenant_id: TENANT_ID,
					status: 'active',
					target_audience: 'authrim-management',
					resource_class: 'session_summary',
					redaction_level: 'summary_only',
					scope_canonical: 'session_summary:cluster-a:summary_only',
					scope_json: {
						resource_ids: ['cluster-a']
					},
					requester_subject_type: 'admin_user',
					requester_subject_id: 'dev-admin',
					actor_subject_type: 'admin_user',
					actor_subject_id: 'dev-admin',
					issued_at: NOW_SECONDS - 7100,
					expires_at: NOW_SECONDS + 3600 * 2,
					created_at: NOW_SECONDS - 7100,
					updated_at: NOW_SECONDS - 7100
				}
			],
			resolved_policy: {
				preset: 'technical_debug_default',
				request_ttl_seconds: 14400
			}
		}
	],
	[
		'ar-dev-denied',
		{
			id: 'dev-approval-request-3',
			public_request_id: 'ar-dev-denied',
			tenant_id: TENANT_ID,
			investigation_id: 'INV-2026-0614-007',
			requester_subject_type: 'admin_user',
			requester_subject_id: 'dev-admin',
			target_subject_type: 'tenant_resource',
			target_subject_id: 'tenant:acme',
			request_surface: 'compliance',
			requested_action: 'raw_export',
			redaction_level: 'raw',
			status: 'denied',
			scope_json: {
				resource_class: 'tenant_export',
				resource_ids: ['tenant:acme'],
				detail_classes: ['pii', 'audit_detail']
			},
			scope_canonical: 'tenant_export:tenant:acme:raw',
			reason_code: 'compliance_review',
			reason_note: 'Denied in dev mock to exercise danger states',
			reuse_scope: 'request',
			policy_preset: 'compliance_review_default',
			partial_access_allowed: false,
			has_detail: true,
			expires_at: NOW_SECONDS - 3600,
			decided_at: NOW_SECONDS - 4200,
			created_at: NOW_SECONDS - 86400,
			updated_at: NOW_SECONDS - 4200,
			approvals: [
				{
					id: 'dev-approval-step-3',
					approval_request_id: 'dev-approval-request-3',
					step_key: 'compliance-owner',
					side: 'customer_data_owner',
					subject_type: 'customer_delegate',
					subject_id: 'delegate-12',
					status: 'denied',
					method: 'email_otp',
					transport_channel: 'email',
					reason_code: 'insufficient_scope',
					reason_note: 'Raw export was not justified.',
					notification_count: 2,
					decided_at: NOW_SECONDS - 4200,
					expires_at: NOW_SECONDS - 3600,
					created_at: NOW_SECONDS - 86400,
					updated_at: NOW_SECONDS - 4200
				}
			],
			grants: [],
			resolved_policy: {
				preset: 'compliance_review_default',
				request_ttl_seconds: 86400
			}
		}
	]
]);

const fixedCacheTTLConfig: DevCacheTTLConfig = {
	clientMetadata: 300,
	redirectUris: 300,
	grantTypes: 300,
	scopes: 300,
	jwks: 300,
	clientSecret: 60,
	tenant: 300,
	policy: 120
};

const maintenanceCacheTTLConfig: DevCacheTTLConfig = {
	clientMetadata: 30,
	redirectUris: 30,
	grantTypes: 30,
	scopes: 30,
	jwks: 30,
	clientSecret: 15,
	tenant: 30,
	policy: 15
};

function devPlatformCacheModeResponse() {
	return {
		mode: 'fixed',
		effective: 'fixed',
		ttl_config: fixedCacheTTLConfig
	};
}

function devClientCacheModeResponse(clientId: string) {
	return {
		client_id: clientId,
		mode: null,
		effective: devPlatformCacheModeResponse().effective,
		uses_platform_default: true
	};
}

function devDashboardStatsResponse() {
	const now = Date.now();
	return {
		stats: {
			activeUsers: 128,
			totalUsers: 642,
			registeredClients: clients.size,
			newUsersToday: 9,
			loginsToday: 74
		},
		recentActivity: [
			{
				type: 'login',
				userId: 'dev-user-alice',
				email: 'alice@example.edu',
				name: 'Alice Admin',
				timestamp: now - 8 * 60 * 1000
			},
			{
				type: 'user_registration',
				userId: 'dev-user-carol',
				email: 'carol@example.edu',
				name: 'Carol Research',
				timestamp: now - 48 * 60 * 1000
			},
			{
				type: 'client_registration',
				userId: 'admin-dev-admin',
				email: 'dev-admin@localhost',
				name: 'Dev OIDC Client',
				timestamp: now - 3 * 60 * 60 * 1000
			}
		]
	};
}

const roles = new Map<string, DevRole>([
	[
		'role-admin',
		{
			id: 'role-admin',
			tenant_id: TENANT_ID,
			name: 'admin',
			display_name: 'Administrator',
			description: 'Built-in role with broad tenant administration permissions.',
			is_system: false,
			permissions: [
				'admin:access',
				'users:read',
				'users:write',
				'clients:read',
				'clients:write',
				'roles:read',
				'roles:assign',
				'settings:read'
			],
			assignment_count: 2,
			created_at: Math.floor(NOW / 1000) - 86400 * 180,
			updated_at: Math.floor(NOW / 1000) - 86400 * 12
		}
	],
	[
		'role-viewer',
		{
			id: 'role-viewer',
			tenant_id: TENANT_ID,
			name: 'viewer',
			display_name: 'Viewer',
			description: 'Built-in read-only role for operational visibility.',
			is_system: false,
			permissions: ['admin:access', 'users:read', 'clients:read', 'audit:read', 'stats:read'],
			assignment_count: 4,
			created_at: Math.floor(NOW / 1000) - 86400 * 180,
			updated_at: Math.floor(NOW / 1000) - 86400 * 30
		}
	],
	[
		'role-research-support',
		{
			id: 'role-research-support',
			tenant_id: TENANT_ID,
			name: 'research_support',
			display_name: 'Research Support',
			description: 'Custom role for delegated support on research applications.',
			is_system: false,
			permissions: ['admin:access', 'users:read', 'clients:read', 'sessions:read', 'audit:read'],
			inherits_from: 'viewer',
			assignment_count: 1,
			created_at: Math.floor(NOW / 1000) - 86400 * 28,
			updated_at: Math.floor(NOW / 1000) - 86400 * 2
		}
	]
]);

const roleAssignments = new Map<string, DevRoleAssignedUser[]>([
	[
		'role-admin',
		[
			{
				assignment_id: 'assignment-admin-alice',
				user_id: 'dev-user-alice',
				user_email: 'alice@example.edu',
				user_name: 'Alice Admin',
				scope: 'global',
				scope_target: '*',
				granted_by: 'dev-admin',
				expires_at: null,
				assigned_at: Math.floor(NOW / 1000) - 86400 * 20
			},
			{
				assignment_id: 'assignment-admin-bob',
				user_id: 'dev-user-bob',
				user_email: 'bob@example.edu',
				user_name: 'Bob Operator',
				scope: 'org',
				scope_target: 'engineering',
				granted_by: 'dev-admin',
				expires_at: null,
				assigned_at: Math.floor(NOW / 1000) - 86400 * 8
			}
		]
	],
	[
		'role-research-support',
		[
			{
				assignment_id: 'assignment-research-carol',
				user_id: 'dev-user-carol',
				user_email: 'carol@example.edu',
				user_name: 'Carol Research',
				scope: 'resource',
				scope_target: 'client:dev-oidc-client',
				granted_by: 'dev-admin',
				expires_at: null,
				assigned_at: Math.floor(NOW / 1000) - 86400 * 3
			}
		]
	]
]);

const adminUsers = new Map<string, DevAdminUser>([
	[
		'admin-dev-admin',
		{
			id: 'admin-dev-admin',
			tenant_id: TENANT_ID,
			email: 'dev-admin@localhost',
			email_verified: true,
			name: 'Dev Admin',
			is_active: true,
			status: 'active',
			mfa_enabled: true,
			mfa_method: 'passkey',
			last_login_at: NOW - 3600 * 1000,
			last_login_ip: '127.0.0.1',
			failed_login_count: 0,
			created_by: null,
			created_at: NOW - 86400 * 1000 * 120,
			updated_at: NOW - 3600 * 1000
		}
	],
	[
		'admin-ops-suspended',
		{
			id: 'admin-ops-suspended',
			tenant_id: TENANT_ID,
			email: 'ops@example.test',
			email_verified: true,
			name: 'Ops Reviewer',
			is_active: false,
			status: 'suspended',
			mfa_enabled: false,
			mfa_method: null,
			last_login_at: NOW - 86400 * 1000 * 9,
			last_login_ip: '192.0.2.10',
			failed_login_count: 1,
			created_by: 'admin-dev-admin',
			created_at: NOW - 86400 * 1000 * 40,
			updated_at: NOW - 86400 * 1000 * 2
		}
	],
	[
		'admin-support-locked',
		{
			id: 'admin-support-locked',
			tenant_id: TENANT_ID,
			email: 'support@example.test',
			email_verified: false,
			name: 'Support Operator',
			is_active: false,
			status: 'locked',
			mfa_enabled: true,
			mfa_method: 'totp',
			last_login_at: NOW - 86400 * 1000 * 14,
			last_login_ip: '198.51.100.22',
			failed_login_count: 6,
			created_by: 'admin-dev-admin',
			created_at: NOW - 86400 * 1000 * 30,
			updated_at: NOW - 3600 * 1000 * 4
		}
	]
]);

const endUsers = new Map<string, DevEndUser>([
	[
		'dev-user-alice',
		{
			id: 'dev-user-alice',
			tenant_id: TENANT_ID,
			email: 'alice@example.test',
			name: 'Alice Hayashi',
			given_name: 'Alice',
			family_name: 'Hayashi',
			nickname: 'alice',
			preferred_username: 'alice',
			picture: null,
			phone_number: '+81-90-0000-0001',
			email_verified: true,
			phone_number_verified: true,
			user_type: 'human',
			is_active: true,
			pii_partition: 'default',
			pii_status: 'available',
			created_at: NOW - 86400 * 1000 * 90,
			updated_at: NOW - 86400 * 1000,
			last_login_at: NOW - 3600 * 1000 * 3,
			status: 'active',
			suspended_at: null,
			suspended_until: null,
			locked_at: null,
			locked_until: null,
			passkeys: [
				{
					id: 'passkey-dev-user-alice-1',
					device_name: 'MacBook Pro',
					created_at: NOW - 86400 * 1000 * 40,
					last_used_at: NOW - 3600 * 1000 * 3
				}
			]
		}
	],
	[
		'dev-user-bob',
		{
			id: 'dev-user-bob',
			tenant_id: TENANT_ID,
			email: 'bob@example.test',
			name: 'Bob Tanaka',
			given_name: 'Bob',
			family_name: 'Tanaka',
			nickname: null,
			preferred_username: 'bob.tanaka',
			picture: null,
			phone_number: null,
			email_verified: true,
			phone_number_verified: false,
			user_type: 'human',
			is_active: false,
			pii_partition: 'default',
			pii_status: 'available',
			created_at: NOW - 86400 * 1000 * 72,
			updated_at: NOW - 86400 * 1000 * 4,
			last_login_at: NOW - 86400 * 1000 * 12,
			status: 'suspended',
			suspended_at: NOW - 86400 * 1000 * 4,
			suspended_until: null,
			locked_at: null,
			locked_until: null,
			passkeys: []
		}
	],
	[
		'dev-user-carol',
		{
			id: 'dev-user-carol',
			tenant_id: TENANT_ID,
			email: 'carol@example.test',
			name: 'Carol Suzuki',
			given_name: 'Carol',
			family_name: 'Suzuki',
			nickname: 'carol',
			preferred_username: 'carol.s',
			picture: null,
			phone_number: '+81-90-0000-0003',
			email_verified: false,
			phone_number_verified: false,
			user_type: 'human',
			is_active: false,
			pii_partition: 'default',
			pii_status: 'available',
			created_at: NOW - 86400 * 1000 * 34,
			updated_at: NOW - 3600 * 1000 * 8,
			last_login_at: NOW - 86400 * 1000 * 18,
			status: 'locked',
			suspended_at: null,
			suspended_until: null,
			locked_at: NOW - 3600 * 1000 * 8,
			locked_until: null,
			passkeys: []
		}
	]
]);

const userSessions = new Map<string, DevSession>([
	[
		'sess-alice-mac',
		{
			id: 'sess-alice-mac',
			user_id: 'dev-user-alice',
			user_email: 'alice@example.test',
			user_name: 'Alice Hayashi',
			created_at: new Date(Date.now() - 86400 * 1000 * 12).toISOString(),
			last_accessed_at: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
			expires_at: new Date(Date.now() + 86400 * 1000 * 5).toISOString(),
			ip_address: '203.0.113.24',
			user_agent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
			is_active: true
		}
	],
	[
		'sess-alice-mobile',
		{
			id: 'sess-alice-mobile',
			user_id: 'dev-user-alice',
			user_email: 'alice@example.test',
			user_name: 'Alice Hayashi',
			created_at: new Date(Date.now() - 86400 * 1000 * 30).toISOString(),
			last_accessed_at: new Date(Date.now() - 3600 * 1000 * 8).toISOString(),
			expires_at: new Date(Date.now() + 86400 * 1000 * 2).toISOString(),
			ip_address: '198.51.100.11',
			user_agent:
				'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
			is_active: true
		}
	],
	[
		'sess-bob-expired',
		{
			id: 'sess-bob-expired',
			user_id: 'dev-user-bob',
			user_email: 'bob@example.test',
			user_name: 'Bob Tanaka',
			created_at: new Date(Date.now() - 86400 * 1000 * 44).toISOString(),
			last_accessed_at: new Date(Date.now() - 86400 * 1000 * 12).toISOString(),
			expires_at: new Date(Date.now() - 86400 * 1000 * 10).toISOString(),
			ip_address: '203.0.113.88',
			user_agent:
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
			is_active: false
		}
	]
]);

const adminUserRoleAssignments = new Map<string, DevAdminRoleAssignment[]>([
	[
		'admin-dev-admin',
		[
			{
				id: 'admin-role-assignment-dev-admin',
				assignment_id: 'admin-role-assignment-dev-admin',
				role_id: 'role-admin',
				name: 'admin',
				display_name: 'Administrator',
				scope_type: 'global',
				scope_id: null,
				assigned_at: NOW - 86400 * 1000 * 80,
				expires_at: null,
				assigned_by: null
			}
		]
	],
	[
		'admin-ops-suspended',
		[
			{
				id: 'admin-role-assignment-ops-viewer',
				assignment_id: 'admin-role-assignment-ops-viewer',
				role_id: 'role-viewer',
				name: 'viewer',
				display_name: 'Viewer',
				scope_type: 'tenant',
				scope_id: TENANT_ID,
				assigned_at: NOW - 86400 * 1000 * 30,
				expires_at: null,
				assigned_by: 'admin-dev-admin'
			}
		]
	]
]);

const adminAuditLogs = new Map<string, DevAdminAuditLogEntry>([
	[
		'admin-audit-client-created',
		{
			id: 'admin-audit-client-created',
			tenant_id: TENANT_ID,
			detail_artifact_id: null,
			admin_user_id: 'admin-dev-admin',
			admin_email: 'dev-admin@localhost',
			admin_user_name: 'Dev Admin',
			actor_type: 'admin_user',
			actor_id: 'admin-dev-admin',
			actor_display_name: 'Dev Admin',
			action: 'clients.create',
			resource_type: 'client',
			resource_id: 'dev-oidc-client',
			result: 'success',
			severity: 'info',
			ip_address: '127.0.0.1',
			user_agent: 'Authrim Admin UI dev mock',
			request_id: 'req-dev-client-created',
			before: null,
			after: { client_id: 'dev-oidc-client', client_name: 'Dev OIDC Client' },
			metadata: { source: 'dev-mock' },
			created_at: Date.now() - 3600 * 1000
		}
	],
	[
		'admin-audit-policy-denied',
		{
			id: 'admin-audit-policy-denied',
			tenant_id: TENANT_ID,
			detail_artifact_id: null,
			admin_user_id: 'admin-ops-suspended',
			admin_email: 'ops@example.test',
			admin_user_name: 'Ops Reviewer',
			actor_type: 'admin_user',
			actor_id: 'admin-ops-suspended',
			actor_display_name: 'Ops Reviewer',
			action: 'admin_policies.update',
			resource_type: 'admin_policy',
			resource_id: 'policy-deny-dangerous-delete',
			result: 'failure',
			severity: 'warn',
			ip_address: '192.0.2.10',
			user_agent: 'Authrim Admin UI dev mock',
			request_id: 'req-dev-policy-denied',
			before: { is_active: false },
			after: null,
			metadata: { reason: 'insufficient_approval', source: 'dev-mock' },
			created_at: Date.now() - 7200 * 1000
		}
	],
	[
		'admin-audit-system-sync',
		{
			id: 'admin-audit-system-sync',
			tenant_id: TENANT_ID,
			detail_artifact_id: null,
			admin_user_id: 'system',
			admin_email: null,
			admin_user_name: null,
			actor_type: 'system',
			actor_id: 'system',
			actor_display_name: 'System',
			action: 'tenant_vanity_domains.sync',
			resource_type: 'tenant_vanity_domain',
			resource_id: 'dev-domain-accounts',
			result: 'success',
			severity: 'info',
			ip_address: null,
			user_agent: null,
			request_id: 'req-dev-system-sync',
			before: null,
			after: { status: 'active' },
			metadata: { source: 'dev-mock' },
			created_at: Date.now() - 86400 * 1000
		}
	]
]);

const adminAttributes = new Map<string, DevAdminAttribute>([
	[
		'attr-admin-department',
		{
			id: 'attr-admin-department',
			tenant_id: TENANT_ID,
			name: 'admin_department',
			display_name: 'Department',
			description: 'Primary organizational unit used in admin access policies.',
			attribute_type: 'enum',
			allowed_values: ['security', 'platform', 'support', 'research'],
			min_value: null,
			max_value: null,
			regex_pattern: null,
			is_required: true,
			is_multi_valued: false,
			is_system: false,
			created_at: Math.floor(NOW / 1000) - 86400 * 42,
			updated_at: Math.floor(NOW / 1000) - 86400 * 4
		}
	],
	[
		'attr-clearance',
		{
			id: 'attr-clearance',
			tenant_id: TENANT_ID,
			name: 'clearance_level',
			display_name: 'Clearance Level',
			description: 'Numeric clearance tier for sensitive operator actions.',
			attribute_type: 'number',
			allowed_values: null,
			min_value: 1,
			max_value: 5,
			regex_pattern: null,
			is_required: false,
			is_multi_valued: false,
			is_system: false,
			created_at: Math.floor(NOW / 1000) - 86400 * 30,
			updated_at: Math.floor(NOW / 1000) - 86400
		}
	],
	[
		'attr-system-admin-scope',
		{
			id: 'attr-system-admin-scope',
			tenant_id: TENANT_ID,
			name: 'admin_scope',
			display_name: 'Admin Scope',
			description: 'System attribute that limits platform and tenant administration boundaries.',
			attribute_type: 'enum',
			allowed_values: ['platform', 'tenant', 'support'],
			min_value: null,
			max_value: null,
			regex_pattern: null,
			is_required: true,
			is_multi_valued: false,
			is_system: true,
			created_at: Math.floor(NOW / 1000) - 86400 * 180,
			updated_at: Math.floor(NOW / 1000) - 86400 * 18
		}
	]
]);

const adminRebacDefinitions = new Map<string, DevAdminRebacDefinition>([
	[
		'rebac-def-supervises',
		{
			id: 'rebac-def-supervises',
			tenant_id: TENANT_ID,
			relation_name: 'supervises',
			display_name: 'Supervises',
			description: 'Allows senior operators to approve actions for delegated teams.',
			priority: 90,
			is_system: false,
			created_at: Math.floor(NOW / 1000) - 86400 * 24,
			updated_at: Math.floor(NOW / 1000) - 86400 * 3
		}
	],
	[
		'rebac-def-supports',
		{
			id: 'rebac-def-supports',
			tenant_id: TENANT_ID,
			relation_name: 'supports',
			display_name: 'Supports',
			description: 'Delegates read-only operational support over a target resource.',
			priority: 50,
			is_system: false,
			created_at: Math.floor(NOW / 1000) - 86400 * 20,
			updated_at: Math.floor(NOW / 1000) - 86400 * 2
		}
	],
	[
		'rebac-def-owns',
		{
			id: 'rebac-def-owns',
			tenant_id: TENANT_ID,
			relation_name: 'owns',
			display_name: 'Owns',
			description: 'System relationship for ownership checks.',
			priority: 100,
			is_system: true,
			created_at: Math.floor(NOW / 1000) - 86400 * 180,
			updated_at: Math.floor(NOW / 1000) - 86400 * 18
		}
	]
]);

const adminRelationships = new Map<string, DevAdminRelationship>([
	[
		'rel-alice-supports-client',
		{
			id: 'rel-alice-supports-client',
			tenant_id: TENANT_ID,
			relationship_type: 'supports',
			from_type: 'admin_user',
			from_id: 'alice@example.edu',
			to_type: 'client',
			to_id: 'dev-oidc-client',
			permission_level: 'read_only',
			is_transitive: false,
			expires_at: null,
			is_bidirectional: false,
			metadata: { source: 'dev-mock' },
			created_by: 'dev-admin',
			created_at: Math.floor(NOW / 1000) - 86400 * 6,
			updated_at: Math.floor(NOW / 1000) - 86400 * 2
		}
	],
	[
		'rel-bob-supervises-support',
		{
			id: 'rel-bob-supervises-support',
			tenant_id: TENANT_ID,
			relationship_type: 'supervises',
			from_type: 'admin_user',
			from_id: 'bob@example.edu',
			to_type: 'team',
			to_id: 'support-ops',
			permission_level: 'limited',
			is_transitive: true,
			expires_at: null,
			is_bidirectional: false,
			metadata: { source: 'dev-mock' },
			created_by: 'dev-admin',
			created_at: Math.floor(NOW / 1000) - 86400 * 9,
			updated_at: Math.floor(NOW / 1000) - 86400
		}
	],
	[
		'rel-carol-owns-policy',
		{
			id: 'rel-carol-owns-policy',
			tenant_id: TENANT_ID,
			relationship_type: 'owns',
			from_type: 'admin_user',
			from_id: 'carol@example.edu',
			to_type: 'policy',
			to_id: 'policy-research-access',
			permission_level: 'full',
			is_transitive: false,
			expires_at: null,
			is_bidirectional: false,
			metadata: { source: 'dev-mock' },
			created_by: 'dev-admin',
			created_at: Math.floor(NOW / 1000) - 86400 * 14,
			updated_at: Math.floor(NOW / 1000) - 86400
		}
	]
]);

const adminPolicies = new Map<string, DevAdminPolicy>([
	[
		'policy-platform-admins',
		{
			id: 'policy-platform-admins',
			tenant_id: TENANT_ID,
			name: 'platform_admins_manage_tenants',
			display_name: 'Platform admins manage tenants',
			description: 'Allows platform administrators to manage tenant lifecycle and shared settings.',
			effect: 'allow',
			priority: 100,
			resource_pattern: 'admin:tenants:*',
			actions: ['read', 'write', 'delete'],
			conditions: { roles: ['platform_admin'], condition_type: 'all' },
			is_active: true,
			is_system: false,
			created_at: Math.floor(NOW / 1000) - 86400 * 50,
			updated_at: Math.floor(NOW / 1000) - 86400 * 4
		}
	],
	[
		'policy-support-readonly',
		{
			id: 'policy-support-readonly',
			tenant_id: TENANT_ID,
			name: 'support_readonly_clients',
			display_name: 'Support read-only client access',
			description: 'Grants delegated support operators read-only access to client configuration.',
			effect: 'allow',
			priority: 60,
			resource_pattern: 'admin:clients:*',
			actions: ['read'],
			conditions: { relationships: { supports: { permission_level: 'read_only' } } },
			is_active: true,
			is_system: false,
			created_at: Math.floor(NOW / 1000) - 86400 * 28,
			updated_at: Math.floor(NOW / 1000) - 86400 * 2
		}
	],
	[
		'policy-deny-dangerous-delete',
		{
			id: 'policy-deny-dangerous-delete',
			tenant_id: TENANT_ID,
			name: 'deny_unapproved_destructive_actions',
			display_name: 'Deny unapproved destructive actions',
			description:
				'Blocks destructive operations unless a higher-priority approval policy matches.',
			effect: 'deny',
			priority: 90,
			resource_pattern: 'admin:*',
			actions: ['delete'],
			conditions: { attributes: { approval_state: { not_equals: 'approved' } } },
			is_active: false,
			is_system: false,
			created_at: Math.floor(NOW / 1000) - 86400 * 18,
			updated_at: Math.floor(NOW / 1000) - 86400
		}
	],
	[
		'policy-system-baseline',
		{
			id: 'policy-system-baseline',
			tenant_id: TENANT_ID,
			name: 'system_admin_access_baseline',
			display_name: 'System admin access baseline',
			description: 'Built-in baseline policy required for admin console access checks.',
			effect: 'allow',
			priority: 1000,
			resource_pattern: 'admin:console:*',
			actions: ['read'],
			conditions: { roles: ['platform_admin', 'tenant_admin'], condition_type: 'any' },
			is_active: true,
			is_system: true,
			created_at: Math.floor(NOW / 1000) - 86400 * 180,
			updated_at: Math.floor(NOW / 1000) - 86400 * 18
		}
	]
]);

const policyRules = new Map<string, DevPolicyRule>([
	[
		'policy-rule-document-readers',
		{
			id: 'policy-rule-document-readers',
			name: 'document_readers',
			description: 'Allows users with reader roles to view tenant documents.',
			priority: 100,
			effect: 'allow',
			resource_types: ['document', 'report'],
			actions: ['read'],
			conditions: [{ type: 'has_any_role', params: { roles: ['reader', 'editor'] } }],
			enabled: true,
			created_by: 'dev-admin',
			created_at: Math.floor(NOW / 1000) - 86400 * 30,
			updated_by: 'dev-admin',
			updated_at: Math.floor(NOW / 1000) - 86400 * 4
		}
	],
	[
		'policy-rule-org-editors',
		{
			id: 'policy-rule-org-editors',
			name: 'organization_editors',
			description: 'Allows editors to update resources owned by their organization.',
			priority: 80,
			effect: 'allow',
			resource_types: ['document'],
			actions: ['update', 'comment'],
			conditions: [
				{ type: 'has_role', params: { role: 'editor', scope: 'organization' } },
				{ type: 'same_organization', params: {} }
			],
			enabled: true,
			created_by: 'dev-admin',
			created_at: Math.floor(NOW / 1000) - 86400 * 18,
			updated_by: 'dev-admin',
			updated_at: Math.floor(NOW / 1000) - 86400
		}
	],
	[
		'policy-rule-delete-deny',
		{
			id: 'policy-rule-delete-deny',
			name: 'deny_unowned_delete',
			description: 'Denies delete operations when the subject does not own the resource.',
			priority: 90,
			effect: 'deny',
			resource_types: ['document', 'dataset'],
			actions: ['delete'],
			conditions: [
				{ type: 'attribute_equals', params: { attribute: 'owner_verified', value: false } }
			],
			enabled: false,
			created_by: 'dev-admin',
			created_at: Math.floor(NOW / 1000) - 86400 * 12,
			updated_by: 'dev-admin',
			updated_at: Math.floor(NOW / 1000) - 3600
		}
	]
]);

const adminPasskeys = new Map<string, DevAdminPasskey>([
	[
		'dev-passkey-touch-id',
		{
			id: 'dev-passkey-touch-id',
			device_name: 'MacBook Pro Touch ID',
			created_at: NOW - 86400 * 1000 * 42,
			last_used_at: NOW - 3600 * 1000 * 2
		}
	],
	[
		'dev-passkey-security-key',
		{
			id: 'dev-passkey-security-key',
			device_name: 'YubiKey 5C NFC',
			created_at: NOW - 86400 * 1000 * 12,
			last_used_at: null
		}
	]
]);

const ipAllowlistEntries = new Map<string, DevIpAllowlistEntry>([
	[
		'dev-ip-localhost-v4',
		{
			id: 'dev-ip-localhost-v4',
			tenant_id: TENANT_ID,
			ip_range: '127.0.0.1/32',
			ip_version: 4,
			description: 'Local Admin UI dev server',
			enabled: true,
			created_by: 'dev-admin',
			created_at: NOW - 86400 * 1000 * 8,
			updated_at: NOW - 3600 * 1000
		}
	],
	[
		'dev-ip-docs-v6',
		{
			id: 'dev-ip-docs-v6',
			tenant_id: TENANT_ID,
			ip_range: '2001:db8:acad::/64',
			ip_version: 6,
			description: 'Disabled documentation network example',
			enabled: false,
			created_by: 'dev-admin',
			created_at: NOW - 86400 * 1000 * 12,
			updated_at: NOW - 86400 * 1000 * 2
		}
	]
]);

let signingKeys: DevSigningKey[] = [
	{
		kid: 'dev-signing-key-active-2026-06',
		algorithm: 'RS256',
		status: 'active',
		createdAt: new Date(NOW - 86400 * 1000 * 14).toISOString()
	},
	{
		kid: 'dev-signing-key-overlap-2026-05',
		algorithm: 'RS256',
		status: 'overlap',
		createdAt: new Date(NOW - 86400 * 1000 * 45).toISOString(),
		overlaps: true
	},
	{
		kid: 'dev-signing-key-revoked-2026-04',
		algorithm: 'RS256',
		status: 'revoked',
		createdAt: new Date(NOW - 86400 * 1000 * 88).toISOString(),
		revokedAt: new Date(NOW - 86400 * 1000 * 44).toISOString()
	}
];

const tenants = new Map<string, DevTenant>([
	[
		TENANT_ID,
		{
			id: TENANT_ID,
			tenant_code: 'dev',
			name: 'Dev Tenant',
			description: 'Local Admin UI mock tenant',
			lifecycle_state: 'active',
			is_default: true,
			created_at: NOW,
			updated_at: NOW
		}
	]
]);

const tenantInvitations = new Map<string, DevTenantInvitation>([
	[
		'tenant-invite-dev-admin',
		{
			id: 'tenant-invite-dev-admin',
			tenant_id: TENANT_ID,
			invited_email: 'ops@example.test',
			invited_by: 'admin-dev-admin',
			role_id: 'tenant_admin',
			org_id: null,
			max_uses: 1,
			use_count: 0,
			expires_at: Math.floor(Date.now() / 1000) + 86400 * 3,
			created_at: Math.floor((NOW - 3600 * 1000) / 1000),
			updated_at: Math.floor((NOW - 3600 * 1000) / 1000)
		}
	],
	[
		'tenant-invite-dev-open',
		{
			id: 'tenant-invite-dev-open',
			tenant_id: TENANT_ID,
			invited_email: null,
			invited_by: 'admin-dev-admin',
			role_id: null,
			org_id: 'dev-org',
			max_uses: 5,
			use_count: 2,
			expires_at: Math.floor(Date.now() / 1000) + 86400 * 7,
			created_at: Math.floor((NOW - 86400 * 1000) / 1000),
			updated_at: Math.floor((NOW - 86400 * 1000) / 1000)
		}
	]
]);

const tenantDomainMappings = new Map<string, DevTenantDomainMapping>([
	[
		'mapping-dev-example',
		{
			id: 'mapping-dev-example',
			tenant_id: TENANT_ID,
			hash_version: 1,
			priority: 100,
			is_active: true,
			verified: true,
			verification_expires_at: null,
			created_by: 'dev-admin',
			created_at: Math.floor(NOW / 1000) - 86400 * 18,
			updated_at: Math.floor(NOW / 1000) - 86400
		}
	],
	[
		'mapping-dev-pending',
		{
			id: 'mapping-dev-pending',
			tenant_id: 'research-dev',
			hash_version: 1,
			priority: 40,
			is_active: true,
			verified: false,
			verification_expires_at: Math.floor(Date.now() / 1000) + 86400 * 2,
			created_by: 'dev-admin',
			created_at: Math.floor(NOW / 1000) - 86400 * 2,
			updated_at: Math.floor(NOW / 1000) - 3600
		}
	]
]);

const devShardSettings: Record<string, number> = {
	'code-shards': 16,
	'revocation-shards': 16,
	'session-shards': 16,
	'challenge-shards': 16,
	'refresh-token-sharding': 16
};

const tenantVanityDomains = new Map<string, DevTenantVanityDomain>([
	[
		'vanity-dev-login',
		{
			id: 'vanity-dev-login',
			tenant_id: TENANT_ID,
			hostname: 'login.dev.example.test',
			is_active: true,
			is_primary: true,
			status: 'active',
			cloudflare_zone_id: null,
			cloudflare_custom_hostname_id: null,
			ssl_status: 'active',
			ownership_status: 'verified',
			validation_method: 'http',
			validation_records: [],
			last_sync_at: Math.floor(NOW / 1000) - 1800,
			created_by: 'dev-admin',
			created_at: Math.floor(NOW / 1000) - 86400 * 12,
			updated_at: Math.floor(NOW / 1000) - 1800
		}
	],
	[
		'vanity-dev-manual',
		{
			id: 'vanity-dev-manual',
			tenant_id: TENANT_ID,
			hostname: 'accounts.dev.example.test',
			is_active: false,
			is_primary: false,
			status: 'pending_manual',
			cloudflare_zone_id: null,
			cloudflare_custom_hostname_id: null,
			ssl_status: 'pending_validation',
			ownership_status: 'pending',
			validation_method: 'txt',
			validation_records: [{ type: 'TXT', name: '_authrim.accounts', value: 'dev-mock-token' }],
			last_sync_at: null,
			created_by: 'dev-admin',
			created_at: Math.floor(NOW / 1000) - 86400 * 2,
			updated_at: Math.floor(NOW / 1000) - 3600
		}
	]
]);

const flows = new Map<string, DevFlow>([
	[
		'flow-human-basic',
		{
			id: 'flow-human-basic',
			tenant_id: TENANT_ID,
			client_id: null,
			profile_id: 'human-basic',
			name: 'Human Basic Login',
			description: 'Dev mock server-driven login flow for basic end-user authentication.',
			graph_definition: {
				nodes: [
					{
						id: 'start',
						type: 'start',
						position: { x: 80, y: 120 },
						data: { label: 'Start' }
					},
					{
						id: 'identifier',
						type: 'identifier',
						position: { x: 280, y: 120 },
						data: { label: 'Identifier Input', config: { identifier_kind: 'email' } }
					},
					{
						id: 'login',
						type: 'login',
						position: { x: 520, y: 120 },
						data: { label: 'Login', config: { methods: ['passkey', 'otp_email'] } }
					},
					{
						id: 'tokens',
						type: 'issue_tokens',
						position: { x: 760, y: 120 },
						data: { label: 'Issue Tokens' }
					}
				],
				edges: [
					{ id: 'edge-start-identifier', source: 'start', target: 'identifier', type: 'success' },
					{ id: 'edge-identifier-login', source: 'identifier', target: 'login', type: 'success' },
					{ id: 'edge-login-tokens', source: 'login', target: 'tokens', type: 'success' }
				],
				metadata: { profile_id: 'human-basic', version: 'v1' }
			},
			compiled_plan: null,
			version: 'v1',
			is_active: true,
			is_builtin: false,
			created_by: 'dev-admin',
			created_at: Math.floor(NOW / 1000) - 86400 * 18,
			updated_by: 'dev-admin',
			updated_at: Math.floor(NOW / 1000) - 86400
		}
	],
	[
		'flow-agent-token',
		{
			id: 'flow-agent-token',
			tenant_id: TENANT_ID,
			client_id: 'dev-oidc-client',
			profile_id: 'ai-agent',
			name: 'AI Agent Token',
			description: 'Dev mock flow for machine-to-machine agent authorization.',
			graph_definition: {
				nodes: [
					{ id: 'start', type: 'start', position: { x: 80, y: 120 }, data: { label: 'Start' } },
					{
						id: 'policy',
						type: 'policy_check',
						position: { x: 300, y: 120 },
						data: { label: 'Policy Check' }
					},
					{
						id: 'tokens',
						type: 'issue_tokens',
						position: { x: 520, y: 120 },
						data: { label: 'Issue Tokens' }
					}
				],
				edges: [
					{ id: 'edge-start-policy', source: 'start', target: 'policy', type: 'success' },
					{ id: 'edge-policy-tokens', source: 'policy', target: 'tokens', type: 'success' }
				],
				metadata: { profile_id: 'ai-agent', version: 'v1' }
			},
			compiled_plan: null,
			version: 'v1',
			is_active: false,
			is_builtin: false,
			created_by: 'dev-admin',
			created_at: Math.floor(NOW / 1000) - 86400 * 10,
			updated_by: 'dev-admin',
			updated_at: Math.floor(NOW / 1000) - 3600
		}
	]
]);

const flowVersions = new Map<string, DevFlowVersion[]>([]);
const flowAssignments = new Map<string, DevFlowAssignment>();

function devFlowEditor(kind: 'login' | 'registration'): Record<string, unknown> {
	if (kind === 'registration') {
		return {
			nodes: [
				{
					id: 'request',
					type: 'entry',
					title: 'Registration Request',
					position: { x: 360, y: 0 },
					config: { ui_kind: 'start' }
				},
				{
					id: 'registration-method',
					type: 'registration',
					title: 'Registration Method',
					position: { x: 360, y: 144 },
					config: {
						ui_kind: 'registration',
						authentication_profile_ref: 'default',
						outputs: [
							{ id: 'mail_otp', label: 'Email OTP' },
							{ id: 'passkey', label: 'Passkey' },
							{ id: 'facebook', label: 'Facebook' }
						]
					}
				},
				{
					id: 'profile-input',
					type: 'profile_form',
					title: 'Profile input',
					position: { x: 360, y: 288 },
					config: { ui_kind: 'profile', profile_form_ref: 'basic_profile' }
				},
				{
					id: 'consent',
					type: 'consent',
					title: 'Registration consent',
					position: { x: 360, y: 432 },
					config: { ui_kind: 'consent', consent_policy_ref: 'registration_consent_policy' }
				},
				{
					id: 'account-create',
					type: 'account_action',
					title: 'Account creation',
					position: { x: 360, y: 576 },
					config: { ui_kind: 'account' }
				},
				{
					id: 'complete',
					type: 'complete',
					title: 'Complete',
					position: { x: 360, y: 720 },
					config: { ui_kind: 'end' }
				}
			],
			edges: [
				{
					id: 'request:next->registration-method',
					source: 'request',
					source_handle: 'next',
					target: 'registration-method'
				},
				{
					id: 'registration-method:mail_otp->profile-input',
					source: 'registration-method',
					source_handle: 'mail_otp',
					target: 'profile-input'
				},
				{
					id: 'registration-method:passkey->profile-input',
					source: 'registration-method',
					source_handle: 'passkey',
					target: 'profile-input'
				},
				{
					id: 'registration-method:facebook->profile-input',
					source: 'registration-method',
					source_handle: 'facebook',
					target: 'profile-input'
				},
				{
					id: 'profile-input:submitted->consent',
					source: 'profile-input',
					source_handle: 'submitted',
					target: 'consent'
				},
				{
					id: 'consent:accepted->account-create',
					source: 'consent',
					source_handle: 'accepted',
					target: 'account-create'
				},
				{
					id: 'account-create:completed->complete',
					source: 'account-create',
					source_handle: 'completed',
					target: 'complete'
				}
			],
			viewport: { x: 36, y: 36, zoom: 1 }
		};
	}
	return {
		nodes: [
			{
				id: 'request',
				type: 'entry',
				title: 'Login Request',
				position: { x: 360, y: 0 },
				config: { ui_kind: 'start' }
			},
			{
				id: 'session-check',
				type: 'session_check',
				title: 'Session Check',
				position: { x: 360, y: 144 },
				config: { ui_kind: 'decision' }
			},
			{
				id: 'authentication-method',
				type: 'authentication',
				title: 'Authentication Method',
				position: { x: 360, y: 288 },
				config: {
					ui_kind: 'authentication',
					authentication_profile_ref: 'default',
					outputs: [
						{ id: 'mail_otp', label: 'Email OTP' },
						{ id: 'passkey', label: 'Passkey' },
						{ id: 'facebook', label: 'Facebook' }
					]
				}
			},
			{
				id: 'consent',
				type: 'consent',
				title: 'Consent',
				position: { x: 360, y: 432 },
				config: { ui_kind: 'consent', consent_policy_ref: 'oidc_authorization_consent_policy' }
			},
			{
				id: 'complete',
				type: 'complete',
				title: 'Complete',
				position: { x: 360, y: 576 },
				config: { ui_kind: 'end' }
			}
		],
		edges: [
			{
				id: 'request:next->session-check',
				source: 'request',
				source_handle: 'next',
				target: 'session-check'
			},
			{
				id: 'session-check:authenticated->complete',
				source: 'session-check',
				source_handle: 'authenticated',
				target: 'complete'
			},
			{
				id: 'session-check:login_required->authentication-method',
				source: 'session-check',
				source_handle: 'login_required',
				target: 'authentication-method'
			},
			{
				id: 'session-check:reauth_required->authentication-method',
				source: 'session-check',
				source_handle: 'reauth_required',
				target: 'authentication-method'
			},
			{
				id: 'authentication-method:mail_otp->consent',
				source: 'authentication-method',
				source_handle: 'mail_otp',
				target: 'consent'
			},
			{
				id: 'authentication-method:passkey->consent',
				source: 'authentication-method',
				source_handle: 'passkey',
				target: 'consent'
			},
			{
				id: 'authentication-method:facebook->consent',
				source: 'authentication-method',
				source_handle: 'facebook',
				target: 'consent'
			},
			{
				id: 'consent:accepted->complete',
				source: 'consent',
				source_handle: 'accepted',
				target: 'complete'
			}
		],
		viewport: { x: 36, y: 36, zoom: 1 }
	};
}

function devFlowRuntime(
	flowId: string,
	kind: 'login' | 'registration',
	editor: Record<string, unknown>
): Record<string, unknown> {
	const nodes = Array.isArray(editor.nodes) ? editor.nodes : [];
	return {
		flow_id: flowId,
		flow_kind: kind,
		ui: {
			steps: nodes
				.filter(
					(node): node is Record<string, unknown> => Boolean(node) && typeof node === 'object'
				)
				.map((node) => ({
					id: `${String(node.id)}:step`,
					source_node_id: String(node.id),
					component: devRuntimeComponentForNode(String(node.type || 'entry')),
					render: node.type !== 'entry',
					config:
						node.config && typeof node.config === 'object' && !Array.isArray(node.config)
							? node.config
							: {}
				}))
		}
	};
}

function devRuntimeComponentForNode(type: string): string {
	switch (type) {
		case 'session_check':
			return 'session_check';
		case 'registration':
			return 'registration_method_selector';
		case 'authentication':
			return 'authentication_method_selector';
		case 'profile_form':
			return 'profile_form';
		case 'consent':
			return 'consent_policy';
		case 'account_action':
			return 'account_action';
		case 'complete':
			return 'completion';
		default:
			return 'interaction_context';
	}
}

function installDevFlow(id: string, kind: 'login' | 'registration', displayName: string) {
	const editor = devFlowEditor(kind);
	const runtime = devFlowRuntime(id, kind, editor);
	const publishedVersionId = `${id}-version-1`;
	flows.set(id, {
		id,
		tenant_id: TENANT_ID,
		client_id: null,
		profile_id: 'human-basic',
		name: displayName,
		display_name: displayName,
		description: `Dev mock ${displayName}.`,
		graph_definition: null,
		compiled_plan: runtime,
		version: '1.0.0',
		is_active: true,
		is_builtin: false,
		created_by: 'dev-admin',
		created_at: NOW_SECONDS - 86400 * 2,
		updated_by: 'dev-admin',
		updated_at: NOW_SECONDS - 3600,
		slug: id.replace(/^flow-/, ''),
		kind,
		status: 'published',
		draft_editor_json: editor,
		draft_runtime_base_json: runtime,
		published_version_id: publishedVersionId,
		deleted_at: null
	});
	flowVersions.set(id, [
		{
			id: publishedVersionId,
			tenant_id: TENANT_ID,
			flow_id: id,
			version_number: 1,
			schema_version: 'authrim.login_ui.contract.v1',
			runtime_snapshot: runtime,
			editor_snapshot: editor,
			validation_result: { valid: true, errors: [], warnings: [], issues: [] },
			published_by: 'dev-admin',
			published_at: NOW_SECONDS - 3600,
			created_at: NOW_SECONDS - 3600
		}
	]);
}

installDevFlow('flow-default-login', 'login', 'Default Login Flow');
installDevFlow('flow-default-registration', 'registration', 'Default Registration Flow');
flowAssignments.set(flowAssignmentKey('tenant', null, 'login'), {
	id: 'flow-assignment-tenant-login',
	tenant_id: TENANT_ID,
	target_type: 'tenant',
	target_id: null,
	flow_kind: 'login',
	flow_id: 'flow-default-login',
	enabled: true,
	created_at: NOW_SECONDS - 3600,
	updated_at: NOW_SECONDS - 3600
});
flowAssignments.set(flowAssignmentKey('tenant', null, 'registration'), {
	id: 'flow-assignment-tenant-registration',
	tenant_id: TENANT_ID,
	target_type: 'tenant',
	target_id: null,
	flow_kind: 'registration',
	flow_id: 'flow-default-registration',
	enabled: true,
	created_at: NOW_SECONDS - 3600,
	updated_at: NOW_SECONDS - 3600
});

const samlProviders = new Map<string, DevSamlProvider>([
	[
		'dev-saml-sp',
		{
			id: 'dev-saml-sp',
			name: 'Dev GakuNin SP',
			providerType: 'saml_sp',
			enabled: true,
			createdAt: new Date(NOW).toISOString(),
			updatedAt: new Date(NOW).toISOString(),
			config: {
				description: 'Local Admin UI mock SAML SP',
				providerName: 'Dev GakuNin SP',
				entityId: 'https://sp.example.edu/shibboleth',
				acsUrl: 'https://sp.example.edu/Shibboleth.sso/SAML2/POST',
				nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
				allowedBindings: ['post', 'redirect'],
				signAssertions: true,
				signResponses: true,
				samlProfile: 'gakunin',
				authnRequestSignaturePolicy: 'optional',
				logoutRequestSignaturePolicy: 'required',
				attributePresetId: 'gakunin-basic',
				identityMapping: {
					fieldMappingSetId: 'field-mapping-gakunin-basic',
					destinationNamespace: 'saml.attribute'
				}
			}
		}
	]
]);

const machinePrincipals = new Map<string, DevMachinePrincipal>([
	[
		'machine-automation-admin',
		{
			id: 'machine-automation-admin',
			clientId: 'automation-admin',
			displayName: 'Automation Admin',
			description: 'CI and scheduled admin automation principal for local Admin UI development.',
			principalType: 'automation',
			status: 'active',
			defaultAudience: 'authrim-admin',
			tokenTtlSeconds: 600,
			createdAt: NOW - 86400 * 1000 * 21,
			updatedAt: NOW - 3600 * 1000,
			disabledAt: null,
			permissions: ['admin:clients:read', 'admin:audit:read', 'admin:jobs:write'],
			tenantScopes: [{ scopeMode: 'allow', tenantId: TENANT_ID }],
			credentials: [
				{
					id: 'cred-automation-admin-2026-06',
					principalId: 'machine-automation-admin',
					kid: 'automation-admin-2026-06',
					publicJwkJson: JSON.stringify({
						kty: 'EC',
						crv: 'P-256',
						x: 'dev_mock_x',
						y: 'dev_mock_y'
					}),
					alg: 'ES256',
					displayName: 'June signing key',
					description: 'Active dev mock signing key.',
					status: 'active',
					notBefore: NOW - 86400 * 1000 * 7,
					expiresAt: NOW + 86400 * 1000 * 60,
					lastUsedAt: NOW - 5400 * 1000,
					lastUsedIp: '127.0.0.1',
					lastUsedUserAgent: 'authrim-dev-mock/1.0',
					createdAt: NOW - 86400 * 1000 * 7,
					updatedAt: NOW - 5400 * 1000,
					revokedAt: null,
					revokeReason: null
				}
			]
		}
	],
	[
		'machine-setup-tool',
		{
			id: 'machine-setup-tool',
			clientId: 'authrim-setup',
			displayName: 'Authrim Setup Tool',
			description: 'Read-only setup integration principal retained for compatibility checks.',
			principalType: 'setup_tool',
			status: 'disabled',
			defaultAudience: 'authrim-admin',
			tokenTtlSeconds: 300,
			createdAt: NOW - 86400 * 1000 * 90,
			updatedAt: NOW - 86400 * 1000 * 3,
			disabledAt: NOW - 86400 * 1000 * 3,
			permissions: ['admin:settings:read'],
			tenantScopes: [{ scopeMode: 'none', tenantId: null }],
			credentials: [
				{
					id: 'cred-setup-tool-old',
					principalId: 'machine-setup-tool',
					kid: 'setup-tool-old',
					publicJwkJson: JSON.stringify({ kty: 'RSA', n: 'dev_mock_n', e: 'AQAB' }),
					alg: 'RS256',
					displayName: 'Legacy setup key',
					description: 'Disabled dev mock key.',
					status: 'revoked',
					notBefore: NOW - 86400 * 1000 * 90,
					expiresAt: NOW - 86400 * 1000,
					lastUsedAt: NOW - 86400 * 1000 * 5,
					lastUsedIp: '127.0.0.1',
					lastUsedUserAgent: 'authrim-setup/dev',
					createdAt: NOW - 86400 * 1000 * 90,
					updatedAt: NOW - 86400 * 1000 * 3,
					revokedAt: NOW - 86400 * 1000 * 3,
					revokeReason: 'Dev mock rotation complete'
				}
			]
		}
	]
]);

const externalIdPProviders = new Map<string, DevExternalIdPProvider>([
	[
		'dev-google',
		{
			id: 'dev-google',
			slug: 'google',
			tenantId: TENANT_ID,
			name: 'Google Workspace',
			providerType: 'oidc',
			enabled: true,
			priority: 10,
			issuer: 'https://accounts.google.com',
			clientId: 'dev-google-client',
			hasSecret: true,
			authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenEndpoint: 'https://oauth2.googleapis.com/token',
			userinfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
			jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
			scopes: 'openid email profile',
			attributeMapping: {},
			autoLinkEmail: true,
			jitProvisioning: true,
			requireEmailVerified: true,
			alwaysFetchUserinfo: false,
			enableSso: true,
			iconName: 'google-logo',
			buttonColor: '#ffffff',
			buttonColorDark: '#202124',
			buttonText: 'Continue with Google',
			createdAt: NOW,
			updatedAt: NOW
		}
	],
	[
		'dev-github',
		{
			id: 'dev-github',
			slug: 'github',
			tenantId: TENANT_ID,
			name: 'GitHub',
			providerType: 'oauth2',
			enabled: true,
			priority: 20,
			clientId: 'dev-github-client',
			hasSecret: true,
			authorizationEndpoint: 'https://github.com/login/oauth/authorize',
			tokenEndpoint: 'https://github.com/login/oauth/access_token',
			userinfoEndpoint: 'https://api.github.com/user',
			scopes: 'read:user user:email',
			attributeMapping: {},
			autoLinkEmail: true,
			jitProvisioning: true,
			requireEmailVerified: false,
			alwaysFetchUserinfo: true,
			enableSso: true,
			iconName: 'github-logo',
			buttonColor: '#24292f',
			buttonColorDark: '#f6f8fa',
			buttonText: 'Continue with GitHub',
			createdAt: NOW,
			updatedAt: NOW
		}
	]
]);

const settings = new Map<string, DevSettings>([
	[
		`${TENANT_ID}:tenant`,
		{
			category: 'tenant',
			version: 'dev-1',
			values: { 'tenant.allowed_origins': 'http://localhost:5173,http://127.0.0.1:5173' },
			sources: { 'tenant.allowed_origins': 'kv' }
		}
	],
	[
		`${TENANT_ID}:client:dev-oidc-client`,
		{
			category: 'client',
			version: 'dev-1',
			values: {
				'client.pkce_required': true,
				'client.par_required': false,
				'client.dpop_required': false,
				'client.login_ui_url': '',
				'client.consent_required': true,
				'client.first_party': false,
				'client.app_login_enabled': false
			},
			sources: {
				'client.pkce_required': 'kv',
				'client.par_required': 'default',
				'client.dpop_required': 'default',
				'client.login_ui_url': 'default',
				'client.consent_required': 'kv',
				'client.first_party': 'default',
				'client.app_login_enabled': 'default'
			}
		}
	],
	[
		`${TENANT_ID}:consent`,
		{
			category: 'consent',
			version: 'dev-1',
			values: {
				'consent.show_scopes': true,
				'consent.show_client_info': true,
				'consent.remember_decision': true,
				'consent.remember_duration': 2592000,
				'consent.require_explicit': true,
				'consent.granular_scopes': true,
				'consent.require_on_scope_change': true,
				'consent.cache_ttl': 300,
				'consent.skip_for_first_party': false,
				'consent.versioning_enabled': true,
				'consent.expiration_enabled': false,
				'consent.default_expiration_days': 365,
				'consent.data_export_enabled': true,
				'consent.data_export_retention_days': 30,
				'consent.data_export_sync_threshold_kb': 256,
				'consent.record_retention': 2555,
				'consent.supported_display_types': 'page,modal',
				'consent.ui_locales': 'en,ja',
				'consent.rbac_org_selector': true,
				'consent.rbac_acting_as': true,
				'consent.rbac_show_roles': true
			},
			sources: {
				'consent.show_scopes': 'kv',
				'consent.show_client_info': 'kv',
				'consent.remember_decision': 'kv',
				'consent.remember_duration': 'default',
				'consent.require_explicit': 'kv',
				'consent.granular_scopes': 'kv',
				'consent.require_on_scope_change': 'default',
				'consent.cache_ttl': 'default',
				'consent.skip_for_first_party': 'default',
				'consent.versioning_enabled': 'kv',
				'consent.expiration_enabled': 'default',
				'consent.default_expiration_days': 'default',
				'consent.data_export_enabled': 'kv',
				'consent.data_export_retention_days': 'default',
				'consent.data_export_sync_threshold_kb': 'default',
				'consent.record_retention': 'default',
				'consent.supported_display_types': 'default',
				'consent.ui_locales': 'default',
				'consent.rbac_org_selector': 'kv',
				'consent.rbac_acting_as': 'kv',
				'consent.rbac_show_roles': 'default'
			}
		}
	],
	[
		`${TENANT_ID}:feature-flags`,
		{
			category: 'feature-flags',
			version: 'dev-1',
			values: { 'feature.enable_flow_engine': true, 'feature.enable_custom_rules': true },
			sources: { 'feature.enable_flow_engine': 'kv', 'feature.enable_custom_rules': 'kv' }
		}
	]
]);

const directoryConnectors = new Map<string, DevDirectoryConnectorConfig>([
	[
		TENANT_ID,
		{
			enabled: false,
			default_connector_id: 'campus',
			auto_provision: false,
			connectors: [
				{
					id: 'campus',
					transport: 'relay',
					endpoint_url: 'http://localhost:8080',
					auth_mode: 'hmac',
					connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
					key_id: 'kid-active',
					secret_ref: 'env:WORDWARDEN_SECRET',
					timeouts: { request_ms: 2500 },
					relay: {
						verify_timeout_ms: 5000,
						max_pending_requests: 16,
						challenge_ttl_ms: 30000,
						auth_failure_rate_limit_per_minute: 10,
						auth_failure_block_ms: 300000,
						secret_rotation_grace_ms: 300000
					},
					heartbeat: {
						key_id: 'hb-active',
						secret_ref: 'env:WORDWARDEN_HEARTBEAT_SECRET',
						previous_key_id: '',
						previous_secret_ref: '',
						interval_ms: 300000,
						stale_after_ms: 900000,
						retention_days: 14,
						version_mismatch_policy: 'warn',
						expected_version: '',
						minimum_version: '',
						unhealthy_threshold: 1,
						stale_detection_grace_ms: 0
					},
					attribute_names: ['mail', 'displayName', 'uid']
				}
			]
		}
	]
]);

const directoryAuthCampaigns = new Map<string, DevDirectoryAuthCampaign[]>([
	[
		TENANT_ID,
		[
			{
				id: 'damc_template',
				tenant_id: TENANT_ID,
				name: 'Default passwordless migration template',
				description: 'Disabled template for an explicit passwordless migration campaign.',
				status: 'disabled',
				mode: 'grace_then_require_passkey',
				passkey_prompt_mode: 'campaign_only',
				email_code_fallback_mode: 'tenant_default',
				grace_period_days: 30,
				transaction_ttl_seconds: 600,
				enforcement_start_mode: 'first_directory_login',
				target_policy: { type: 'template', assignments: [] },
				is_template: 1,
				created_by: 'dev-admin',
				created_at: NOW - 86400000,
				updated_at: NOW - 86400000
			}
		]
	]
]);

const directoryAuthTenantPolicies = new Map<string, DevDirectoryAuthTenantPolicy>([
	[
		TENANT_ID,
		{
			tenant_id: TENANT_ID,
			email_code_fallback_mode: 'migration_recovery',
			updated_by: 'dev-admin',
			created_at: NOW - 86400000,
			updated_at: NOW - 86400000
		}
	]
]);

const directoryAuthUserStates = new Map<string, DevDirectoryAuthUserState[]>([
	[
		TENANT_ID,
		[
			{
				id: 'damus_dev_blocked',
				tenant_id: TENANT_ID,
				campaign_id: 'damc_template',
				user_id: 'user-dev-1',
				connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
				directory_subject: 'uid=alice,ou=people,dc=example,dc=test',
				cohort_key: 'staff',
				state: 'blocked',
				first_directory_login_at: NOW - 86400000 * 4,
				prompted_at: NOW - 86400000 * 4,
				deferred_until: null,
				passkey_required_at: null,
				enrolled_at: null,
				blocked_reason: 'operator_review',
				recovery_reason: null,
				reset_count: 0,
				last_reset_at: null,
				last_reset_by: null,
				last_reset_reason: null,
				created_at: NOW - 86400000 * 4,
				updated_at: NOW - 86400000
			}
		]
	]
]);

const directoryAuthConfigHistory = new Map<string, DevDirectoryAuthConfigHistory[]>([
	[
		TENANT_ID,
		[
			{
				id: 'dach_dev_1',
				tenant_id: TENANT_ID,
				actor_id: 'dev-admin',
				category: 'policy',
				action: 'tenant_policy.updated',
				resource_type: 'directory_auth_tenant_policy',
				resource_id: TENANT_ID,
				before_redacted_json: '{}',
				after_redacted_json: '{"email_code_fallback_mode":"migration_recovery"}',
				before_redacted: {},
				after_redacted: { email_code_fallback_mode: 'migration_recovery' },
				created_at: NOW - 3600000
			}
		]
	]
]);

const directoryAuthRetentionPolicies = new Map<string, DevDirectoryAuthRetentionPolicy>([
	[
		TENANT_ID,
		{
			tenant_id: TENANT_ID,
			authrim_audit_retention_days: 365,
			wordwarden_local_retention_days: 14,
			artifact_delete_grace_hours: 72,
			updated_by: 'dev-admin',
			created_at: NOW - 86400000,
			updated_at: NOW - 86400000
		}
	]
]);

const directoryAuthEvidenceExports = new Map<
	string,
	Array<
		DevDirectoryAuthJob & {
			period_start_at: number;
			period_end_at: number;
			size_estimate_bytes: number | null;
			manifest_signature_key_id: string | null;
			manifest_signature_alg: string | null;
			signed_url_expires_at: number | null;
			download_after_delete: number;
			error_code: string | null;
		}
	>
>([[TENANT_ID, []]]);

const directoryAuthSupportBundles = new Map<
	string,
	Array<
		DevDirectoryAuthJob & {
			redaction_level: 'minimal' | 'standard' | 'detailed';
			scope_json: string;
			consent_summary_json: string;
		}
	>
>([[TENANT_ID, []]]);

const directoryAuthAdvisories = [
	{
		id: 'wwadv_dev',
		channel: 'stable',
		severity: 'medium',
		affected_versions_json: JSON.stringify(['<0.14.0']),
		fixed_version: '0.14.0',
		summary: 'Dev advisory example for Wordwarden update guidance.',
		published_at: NOW - 86400000 * 2,
		updated_at: NOW - 86400000,
		release_url: 'https://github.com/authrim/authrim-wordwarden/releases',
		created_at: NOW - 86400000 * 2
	}
];

const consentStatements = new Map<string, DevConsentStatement>([
	[
		'consent-privacy-policy',
		{
			id: 'consent-privacy-policy',
			tenant_id: TENANT_ID,
			slug: 'privacy-policy',
			category: 'privacy_policy',
			legal_basis: 'consent',
			processing_purpose: 'Explain collection and processing of profile and audit data.',
			record_retention_days: 2555,
			withdrawal_allowed: 1,
			withdrawal_impact: 'Withdrawing may restrict access to services that require profile data.',
			reconsent_on_version_change: 1,
			reconsent_interval_days: 365,
			display_order: 10,
			is_active: 1,
			created_at: NOW - 86400 * 1000 * 42,
			updated_at: NOW - 86400 * 1000 * 3
		}
	],
	[
		'consent-research-data-sharing',
		{
			id: 'consent-research-data-sharing',
			tenant_id: TENANT_ID,
			slug: 'research-data-sharing',
			category: 'data_sharing',
			legal_basis: 'consent',
			processing_purpose: 'Release selected claims to research applications with user approval.',
			record_retention_days: 730,
			withdrawal_allowed: 1,
			withdrawal_impact: 'Future research attribute releases will stop after withdrawal.',
			reconsent_on_version_change: 1,
			reconsent_interval_days: null,
			display_order: 20,
			is_active: 1,
			created_at: NOW - 86400 * 1000 * 18,
			updated_at: NOW - 86400 * 1000
		}
	],
	[
		'consent-marketing',
		{
			id: 'consent-marketing',
			tenant_id: TENANT_ID,
			slug: 'product-updates',
			category: 'marketing',
			legal_basis: 'legitimate_interest',
			processing_purpose: 'Optional product update notifications for administrators.',
			record_retention_days: 365,
			withdrawal_allowed: 1,
			withdrawal_impact: null,
			reconsent_on_version_change: 0,
			reconsent_interval_days: null,
			display_order: 30,
			is_active: 0,
			created_at: NOW - 86400 * 1000 * 8,
			updated_at: NOW - 86400 * 1000 * 2
		}
	]
]);

const consentStatementVersions = new Map<string, DevConsentStatementVersion[]>([
	[
		'consent-privacy-policy',
		[
			{
				id: 'version-privacy-20260601',
				tenant_id: TENANT_ID,
				statement_id: 'consent-privacy-policy',
				version: '20260601',
				content_type: 'url',
				effective_at: NOW - 86400 * 1000 * 5,
				effective_until: null,
				content_hash: '4f0f1f7b9fb2b7e73c55f98bce38ec0f',
				is_current: 1,
				status: 'active',
				created_at: NOW - 86400 * 1000 * 6,
				updated_at: NOW - 86400 * 1000 * 5
			},
			{
				id: 'version-privacy-20260701',
				tenant_id: TENANT_ID,
				statement_id: 'consent-privacy-policy',
				version: '20260701',
				content_type: 'inline',
				effective_at: NOW + 86400 * 1000 * 15,
				effective_until: null,
				content_hash: '37b7b89dfadc6d98a1dc3f473fe68f56',
				is_current: 0,
				status: 'draft',
				created_at: NOW - 86400 * 1000,
				updated_at: NOW - 86400 * 1000
			}
		]
	],
	[
		'consent-research-data-sharing',
		[
			{
				id: 'version-research-20260515',
				tenant_id: TENANT_ID,
				statement_id: 'consent-research-data-sharing',
				version: '20260515',
				content_type: 'url',
				effective_at: NOW - 86400 * 1000 * 20,
				content_hash: 'a0a98fd9e83273609cb106fd3b31e9a2',
				is_current: 1,
				status: 'active',
				created_at: NOW - 86400 * 1000 * 21,
				updated_at: NOW - 86400 * 1000 * 20
			}
		]
	]
]);

const consentStatementLocalizations = new Map<string, DevConsentStatementLocalization[]>([
	[
		'version-privacy-20260601',
		[
			{
				id: 'localization-privacy-20260601-en',
				tenant_id: TENANT_ID,
				version_id: 'version-privacy-20260601',
				language: 'en',
				title: 'Privacy Policy',
				description: 'How Authrim processes profile, consent, and audit data.',
				processing_purpose: 'Account security, consent evidence, and audit operation.',
				withdrawal_impact: 'Some account features may be unavailable after withdrawal.',
				document_url: 'https://example.com/privacy/en',
				created_at: NOW - 86400 * 1000 * 6,
				updated_at: NOW - 86400 * 1000 * 5
			},
			{
				id: 'localization-privacy-20260601-ja',
				tenant_id: TENANT_ID,
				version_id: 'version-privacy-20260601',
				language: 'ja',
				title: 'プライバシーポリシー',
				description: 'プロフィール、同意、監査データの処理について説明します。',
				processing_purpose: 'アカウント保護、同意証跡、監査運用のために利用します。',
				withdrawal_impact: '撤回すると一部のアカウント機能を利用できない場合があります。',
				document_url: 'https://example.com/privacy/ja',
				created_at: NOW - 86400 * 1000 * 6,
				updated_at: NOW - 86400 * 1000 * 5
			}
		]
	],
	[
		'version-privacy-20260701',
		[
			{
				id: 'localization-privacy-20260701-en',
				tenant_id: TENANT_ID,
				version_id: 'version-privacy-20260701',
				language: 'en',
				title: 'Privacy Policy Draft',
				description: 'Draft privacy policy with updated retention language.',
				processing_purpose: 'Draft processing purpose for Admin UI development.',
				withdrawal_impact: 'Draft withdrawal impact text.',
				inline_content: 'Draft privacy policy text for Admin UI development.',
				created_at: NOW - 86400 * 1000,
				updated_at: NOW - 86400 * 1000
			}
		]
	]
]);

const consentRequirements = new Map<string, DevTenantConsentRequirement>([
	[
		'consent-privacy-policy',
		{
			id: 'requirement-privacy-policy',
			tenant_id: TENANT_ID,
			statement_id: 'consent-privacy-policy',
			is_required: 1,
			min_version: '20260601',
			enforcement: 'block',
			show_deletion_link: 1,
			deletion_url: 'https://example.com/account/delete',
			display_order: 10,
			created_at: NOW - 86400 * 1000 * 5,
			updated_at: NOW - 86400 * 1000 * 3
		}
	],
	[
		'consent-research-data-sharing',
		{
			id: 'requirement-research-data-sharing',
			tenant_id: TENANT_ID,
			statement_id: 'consent-research-data-sharing',
			is_required: 0,
			min_version: '20260515',
			enforcement: 'allow_continue',
			show_deletion_link: 0,
			conditional_rules_json: '[{"claim":"affiliation","op":"eq","value":"researcher"}]',
			display_order: 20,
			created_at: NOW - 86400 * 1000 * 10,
			updated_at: NOW - 86400 * 1000
		}
	]
]);

const consentPolicies = new Map<string, DevConsentPolicy>([
	[
		'policy-default-account',
		{
			id: 'policy-default-account',
			tenant_id: TENANT_ID,
			name: 'default-account-consent',
			display_name: 'Default account consent',
			description: 'Account-level ToS and privacy consent evaluated during registration and login.',
			is_active: 1,
			created_at: NOW - 86400 * 1000 * 7,
			updated_at: NOW - 86400 * 1000
		}
	],
	[
		'policy-research-release',
		{
			id: 'policy-research-release',
			tenant_id: TENANT_ID,
			name: 'research-attribute-release',
			display_name: 'Research attribute release',
			description: 'OIDC/SAML release consent for research applications.',
			is_active: 1,
			created_at: NOW - 86400 * 1000 * 6,
			updated_at: NOW - 86400 * 1000
		}
	]
]);

const consentPolicyItems = new Map<string, DevConsentPolicyItem[]>([
	[
		'policy-default-account',
		[
			{
				id: 'policy-item-default-privacy',
				tenant_id: TENANT_ID,
				policy_id: 'policy-default-account',
				statement_id: 'consent-privacy-policy',
				requirement: 'required',
				version_mode: 'current',
				checkbox_mode: 'required',
				checkbox_default_checked: 0,
				binding_type: null,
				binding_value: null,
				evidence_profile: 'account_terms',
				language_fallback: 'tenant_default',
				display_order: 10,
				created_at: NOW - 86400 * 1000 * 7,
				updated_at: NOW - 86400 * 1000
			}
		]
	],
	[
		'policy-research-release',
		[
			{
				id: 'policy-item-research-release',
				tenant_id: TENANT_ID,
				policy_id: 'policy-research-release',
				statement_id: 'consent-research-data-sharing',
				requirement: 'required',
				version_mode: 'current',
				checkbox_mode: 'required',
				checkbox_default_checked: 0,
				binding_type: 'scope',
				binding_value: 'profile email',
				evidence_profile: 'attribute_release',
				language_fallback: 'tenant_default',
				display_order: 10,
				created_at: NOW - 86400 * 1000 * 6,
				updated_at: NOW - 86400 * 1000
			}
		]
	]
]);

const clientTrustPolicies = new Map<string, DevClientTrustPolicy>([
	[
		'oidc_client:dev-oidc-client',
		{
			id: 'trust-oidc-dev',
			tenant_id: TENANT_ID,
			name: 'dev-oidc-client-trust',
			display_name: 'Dev OIDC client trust',
			description: 'First-party development client. Authorization consent can be skipped.',
			target_type: 'oidc_client',
			target_id: 'dev-oidc-client',
			first_party: 1,
			trusted: 1,
			skip_authorization_consent: 1,
			is_active: 1,
			created_at: NOW - 86400 * 1000 * 6,
			updated_at: NOW - 86400 * 1000
		}
	],
	[
		'saml_sp:dev-saml-sp',
		{
			id: 'trust-saml-dev',
			tenant_id: TENANT_ID,
			name: 'dev-saml-sp-trust',
			display_name: 'Dev SAML SP trust',
			target_type: 'saml_sp',
			target_id: 'dev-saml-sp',
			first_party: 0,
			trusted: 0,
			skip_authorization_consent: 0,
			is_active: 1,
			created_at: NOW - 86400 * 1000 * 4,
			updated_at: NOW - 86400 * 1000
		}
	]
]);

const signInConfirmationPolicies = new Map<string, DevSignInConfirmationPolicy>([
	[
		'login',
		{
			id: 'signin-confirmation-login',
			tenant_id: TENANT_ID,
			name: 'login-sign-in-confirmation',
			display_name: 'Login sign-in confirmation',
			description: 'Transition confirmation for IdP-initiated or external SSO returns.',
			trigger_type: 'login',
			mode: 'disabled',
			remember_duration_days: 365,
			show_application_context: 1,
			show_tenant_context: 1,
			is_active: 1,
			created_at: NOW - 86400 * 1000 * 2,
			updated_at: NOW - 86400 * 1000
		}
	]
]);

const runtimeProfiles = new Map<string, Record<string, unknown>>([
	[
		'storage:builtin:shared-d1',
		{
			id: 'builtin:shared-d1',
			kind: 'storage',
			label: 'Shared D1',
			description: 'Default shared D1 storage profile for compact deployments.',
			builtin: true,
			version: 1,
			slices: {
				identity_core: { type: 'd1', bindingRef: 'DB' },
				identity_pii: { type: 'd1', bindingRef: 'DB' },
				custom_claims: { type: 'd1', bindingRef: 'DB' },
				consent: { type: 'd1', bindingRef: 'DB' },
				authorization: { type: 'd1', bindingRef: 'DB' }
			}
		}
	],
	[
		'storage:builtin:tenant-d1',
		{
			id: 'builtin:tenant-d1',
			kind: 'storage',
			label: 'Tenant D1',
			description: 'Tenant-isolated D1 storage for larger or regulated deployments.',
			builtin: true,
			version: 1,
			slices: {
				identity_core: { type: 'd1', bindingRef: 'TENANT_CORE_DB' },
				identity_pii: { type: 'd1', bindingRef: 'TENANT_PII_DB' },
				custom_claims: { type: 'd1', bindingRef: 'TENANT_PII_DB' },
				consent: { type: 'd1', bindingRef: 'TENANT_PII_DB' },
				authorization: { type: 'd1', bindingRef: 'TENANT_AUTHZ_DB' }
			}
		}
	],
	[
		'audit:builtin:audit-archive',
		{
			id: 'builtin:audit-archive',
			kind: 'audit',
			label: 'Audit Archive',
			description: 'Writes audit evidence to D1 and archives to R2.',
			builtin: true,
			version: 1,
			primary: { type: 'd1', bindingRef: 'DB' },
			archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
			sinks: [
				{
					type: 'http',
					url: 'https://example.com/audit',
					method: 'POST',
					format: 'json',
					headers: { 'X-Authrim-Sink': 'enabled' }
				}
			],
			retention: {
				eventLogRetentionDays: 180,
				piiLogRetentionDays: 365,
				archiveBeforeDelete: true
			},
			archiveFailureMode: 'gate_cleanup',
			sinkFailureMode: 'best_effort'
		}
	],
	[
		'audit:custom:audit-http-export',
		{
			id: 'custom:audit-http-export',
			kind: 'audit',
			label: 'HTTP Audit Export',
			description: 'Dev mock custom audit profile with an HTTP sink reference.',
			version: 2,
			primary: null,
			archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/custom/' },
			sinks: [{ type: 'http', url: 'https://example.com/audit', method: 'POST', format: 'json' }],
			retention: {
				eventLogRetentionDays: 90,
				piiLogRetentionDays: 365,
				archiveBeforeDelete: false
			},
			archiveFailureMode: 'gate_cleanup',
			sinkFailureMode: 'best_effort'
		}
	],
	[
		'residency:builtin:jp-primary',
		{
			id: 'builtin:jp-primary',
			kind: 'residency',
			label: 'Japan Primary',
			description: 'Primary Japan residency profile for Admin UI development.',
			builtin: true,
			version: 1,
			region: 'jp'
		}
	]
]);

let runtimeProfileDefaults = {
	storageProfileId: 'builtin:shared-d1',
	auditProfileId: 'builtin:audit-archive',
	residencyProfileId: 'builtin:jp-primary'
};

const storageDestinations = new Map<string, DevStorageDestination>([
	[
		'dev-r2-diagnostic-logs',
		{
			id: 'dev-r2-diagnostic-logs',
			scope_type: 'tenant',
			scope_id: TENANT_ID,
			name: 'diagnostic-r2',
			display_name: 'Diagnostic R2 Archive',
			description: 'Tenant-scoped R2 destination for Admin UI development.',
			provider: 'r2',
			config: {
				binding_ref: 'DIAGNOSTIC_LOGS',
				object_prefix: 'diagnostic-logs/',
				region: 'auto'
			},
			managed_by: 'admin',
			read_only: false,
			has_credential: false,
			credential_key_version: null,
			credential_updated_at: null,
			credential_updated_by: null,
			status: 'active',
			created_by: 'dev-admin',
			updated_by: 'dev-admin',
			created_at: NOW,
			updated_at: NOW
		}
	],
	[
		'dev-s3-compliance-archive',
		{
			id: 'dev-s3-compliance-archive',
			scope_type: 'platform',
			scope_id: 'platform',
			name: 'compliance-s3',
			display_name: 'Compliance S3 Archive',
			description: 'Platform S3 destination available to tenants in the dev mock.',
			provider: 'aws_s3',
			config: {
				bucket: 'authrim-dev-compliance',
				region: 'ap-northeast-1',
				prefix: 'authrim/'
			},
			managed_by: 'setup',
			read_only: true,
			has_credential: true,
			credential_key_version: 1,
			credential_updated_at: NOW,
			credential_updated_by: 'setup',
			status: 'active',
			created_by: 'setup',
			updated_by: 'setup',
			created_at: NOW,
			updated_at: NOW
		}
	]
]);

const storageDestinationUsages = new Map<string, DevStorageDestinationUsage[]>();

const devRetentionCategories = [
	{
		category: 'audit_logs',
		retention_days: 365,
		total_records: 12840,
		records_pending_deletion: 18,
		oldest_record_date: new Date(NOW - 86400000 * 420).toISOString(),
		next_cleanup_date: new Date(NOW + 86400000).toISOString(),
		last_cleanup_date: new Date(NOW - 86400000 * 6).toISOString(),
		records_deleted_last_30_days: 124
	},
	{
		category: 'session_data',
		retention_days: 90,
		total_records: 2410,
		records_pending_deletion: 7,
		oldest_record_date: new Date(NOW - 86400000 * 110).toISOString(),
		next_cleanup_date: new Date(NOW + 86400000 * 2).toISOString(),
		last_cleanup_date: new Date(NOW - 86400000 * 5).toISOString(),
		records_deleted_last_30_days: 88
	},
	{
		category: 'tombstones',
		retention_days: 730,
		total_records: 318,
		records_pending_deletion: 0,
		oldest_record_date: new Date(NOW - 86400000 * 260).toISOString(),
		next_cleanup_date: new Date(NOW + 86400000 * 7).toISOString(),
		last_cleanup_date: new Date(NOW - 86400000 * 14).toISOString(),
		records_deleted_last_30_days: 0
	}
];

const controlPlaneDestinations = new Map<string, DevControlPlaneDestination>([
	[
		'dev-destination-tenant-r2',
		{
			id: 'dev-destination-tenant-r2',
			scope_type: 'tenant',
			scope_id: TENANT_ID,
			destination_kind: 'object_storage',
			name: 'tenant-diagnostic-r2',
			display_name: 'Tenant Diagnostic R2',
			description: 'Tenant-scoped destination used by logging policy development screens.',
			provider: 'r2',
			provider_config: {
				binding_ref: 'DIAGNOSTIC_LOGS',
				object_prefix: 'diagnostic-logs/',
				region: 'auto'
			},
			allowed_tenant_ids: TENANT_ID,
			allowed_log_types: 'diagnostic,audit,access',
			allowed_planes: 'control,data',
			region: 'auto',
			critical_allowed: 1,
			default_fallback_eligible: 1,
			runtime_supported: true,
			runtime_status: 'supported',
			runtime_unsupported_reason: null,
			retention_days: 30,
			encryption_mode: 'platform_managed',
			lifecycle_status: 'active',
			health_status: 'healthy',
			rotation_status: 'active',
			credential_ref: 'env:DIAGNOSTIC_LOGS',
			credential_version: 1,
			next_credential_ref: null,
			next_credential_version: null,
			previous_credential_ref: null,
			previous_credential_retire_after: null,
			last_health_check_at: NOW,
			created_at: NOW,
			updated_at: NOW,
			deleted_at: null,
			version: 1,
			capabilities: [
				{ capability: 'write', source: 'dev-mock', enabled: 1, created_at: NOW, updated_at: NOW },
				{
					capability: 'health_check',
					source: 'dev-mock',
					enabled: 1,
					created_at: NOW,
					updated_at: NOW
				}
			]
		}
	],
	[
		'dev-destination-shared-s3',
		{
			id: 'dev-destination-shared-s3',
			scope_type: 'shared',
			scope_id: null,
			destination_kind: 'object_storage',
			name: 'shared-compliance-s3',
			display_name: 'Shared Compliance S3',
			description: 'Shared compliance archive destination available to tenant policies.',
			provider: 'aws_s3',
			provider_config: {
				bucket: 'authrim-dev-compliance',
				region: 'ap-northeast-1',
				prefix: 'compliance/'
			},
			allowed_tenant_ids: null,
			allowed_log_types: 'audit,compliance',
			allowed_planes: 'control',
			region: 'ap-northeast-1',
			critical_allowed: 1,
			default_fallback_eligible: 0,
			runtime_supported: true,
			runtime_status: 'supported',
			runtime_unsupported_reason: null,
			retention_days: 365,
			encryption_mode: 'external_managed',
			lifecycle_status: 'active',
			health_status: 'healthy',
			rotation_status: 'active',
			credential_ref: 'secret:shared-compliance-s3:v1',
			credential_version: 1,
			next_credential_ref: null,
			next_credential_version: null,
			previous_credential_ref: null,
			previous_credential_retire_after: null,
			last_health_check_at: NOW,
			created_at: NOW,
			updated_at: NOW,
			deleted_at: null,
			version: 1,
			capabilities: [
				{ capability: 'write', source: 'dev-mock', enabled: 1, created_at: NOW, updated_at: NOW },
				{ capability: 'fallback', source: 'dev-mock', enabled: 0, created_at: NOW, updated_at: NOW }
			]
		}
	]
]);

const defaultUiPaths = {
	login: '/login',
	consent: '/consent',
	reauth: '/reauth',
	error: '/error',
	device: '/device',
	deviceAuthorize: '/device/authorize',
	logoutComplete: '/logout/complete',
	loggedOut: '/logged-out',
	register: '/register'
};

let devUiConfig: { baseUrl: string | null; paths: typeof defaultUiPaths } = {
	baseUrl: 'http://127.0.0.1:5175',
	paths: { ...defaultUiPaths }
};

function uiConfigResponse(source: 'kv' | 'env' | 'none' = 'kv') {
	return {
		config: devUiConfig,
		source,
		defaults: defaultUiPaths,
		metadata: {
			login: { label: 'Login', description: 'Primary login route.' },
			consent: { label: 'Consent', description: 'Consent confirmation route.' },
			reauth: { label: 'Reauthentication', description: 'Step-up authentication route.' },
			error: { label: 'Error', description: 'Authentication error route.' },
			device: { label: 'Device', description: 'Device flow entry route.' },
			deviceAuthorize: {
				label: 'Device Authorization',
				description: 'Device authorization route.'
			},
			logoutComplete: { label: 'Logout Complete', description: 'Logout completion route.' },
			loggedOut: { label: 'Logged Out', description: 'Logged-out landing route.' },
			register: { label: 'Register', description: 'Registration entry route.' }
		}
	};
}

function settingMeta(
	key: string,
	type: 'number' | 'boolean' | 'string' | 'duration' | 'enum',
	defaultValue: unknown,
	label: string,
	description: string,
	extra: Record<string, unknown> = {}
) {
	return {
		key,
		type,
		default: defaultValue,
		label,
		description,
		visibility: 'admin',
		...extra
	};
}

function settingsMetaResponse(category: string) {
	if (category === 'login-ui') {
		return {
			category: 'login-ui',
			label: 'Login UI',
			description: 'Login UI customization settings',
			writable: true,
			settings: {}
		};
	}
	if (category === 'consent') {
		return {
			category: 'consent',
			label: 'Consent',
			description: 'Consent settings',
			writable: true,
			settings: {
				'consent.show_scopes': settingMeta(
					'consent.show_scopes',
					'boolean',
					true,
					'Show requested scopes',
					'Display requested scopes on the consent prompt.'
				),
				'consent.show_client_info': settingMeta(
					'consent.show_client_info',
					'boolean',
					true,
					'Show client information',
					'Display client metadata on the consent prompt.'
				),
				'consent.remember_decision': settingMeta(
					'consent.remember_decision',
					'boolean',
					true,
					'Remember decisions',
					'Allow consent decisions to be remembered.'
				),
				'consent.remember_duration': settingMeta(
					'consent.remember_duration',
					'duration',
					2592000,
					'Remember duration',
					'How long remembered consent decisions remain valid.',
					{ min: 3600, max: 31536000, unit: 'seconds' }
				),
				'consent.require_explicit': settingMeta(
					'consent.require_explicit',
					'boolean',
					true,
					'Require explicit consent',
					'Require an explicit user action before granting consent.'
				),
				'consent.granular_scopes': settingMeta(
					'consent.granular_scopes',
					'boolean',
					true,
					'Granular scopes',
					'Allow users to review individual requested scopes.'
				),
				'consent.require_on_scope_change': settingMeta(
					'consent.require_on_scope_change',
					'boolean',
					true,
					'Require on scope change',
					'Ask for consent again when requested scopes change.'
				),
				'consent.cache_ttl': settingMeta(
					'consent.cache_ttl',
					'duration',
					300,
					'Cache TTL',
					'Cache duration for consent policy lookups.',
					{ min: 0, max: 3600, unit: 'seconds' }
				),
				'consent.skip_for_first_party': settingMeta(
					'consent.skip_for_first_party',
					'boolean',
					false,
					'Skip for first-party clients',
					'Skip consent prompts for trusted first-party clients.'
				),
				'consent.versioning_enabled': settingMeta(
					'consent.versioning_enabled',
					'boolean',
					true,
					'Enable versioning',
					'Track consent policy versions.'
				),
				'consent.expiration_enabled': settingMeta(
					'consent.expiration_enabled',
					'boolean',
					false,
					'Enable expiration',
					'Expire consent records after a configured period.'
				),
				'consent.default_expiration_days': settingMeta(
					'consent.default_expiration_days',
					'number',
					365,
					'Default expiration',
					'Default consent expiration window.',
					{ min: 1, max: 3650, unit: 'days' }
				),
				'consent.data_export_enabled': settingMeta(
					'consent.data_export_enabled',
					'boolean',
					true,
					'Enable data export',
					'Allow consent data exports for privacy operations.'
				),
				'consent.data_export_retention_days': settingMeta(
					'consent.data_export_retention_days',
					'number',
					30,
					'Export retention',
					'How long generated consent exports are retained.',
					{ min: 1, max: 365, unit: 'days' }
				),
				'consent.data_export_sync_threshold_kb': settingMeta(
					'consent.data_export_sync_threshold_kb',
					'number',
					256,
					'Sync export threshold',
					'Maximum synchronous consent export size.',
					{ min: 64, max: 10240, unit: 'KB' }
				),
				'consent.record_retention': settingMeta(
					'consent.record_retention',
					'number',
					2555,
					'Record retention',
					'How long consent records are retained.',
					{ min: 30, max: 3650, unit: 'days' }
				),
				'consent.supported_display_types': settingMeta(
					'consent.supported_display_types',
					'string',
					'page,modal',
					'Supported display types',
					'Comma-separated display types available to consent UI.'
				),
				'consent.ui_locales': settingMeta(
					'consent.ui_locales',
					'string',
					'en,ja',
					'UI locales',
					'Comma-separated locale codes available to consent UI.'
				),
				'consent.rbac_org_selector': settingMeta(
					'consent.rbac_org_selector',
					'boolean',
					true,
					'Organization selector',
					'Show organization context selection during consent.'
				),
				'consent.rbac_acting_as': settingMeta(
					'consent.rbac_acting_as',
					'boolean',
					true,
					'Acting-as context',
					'Show acting-as context in RBAC-aware consent.'
				),
				'consent.rbac_show_roles': settingMeta(
					'consent.rbac_show_roles',
					'boolean',
					true,
					'Show roles',
					'Display role information in RBAC-aware consent.'
				)
			}
		};
	}
	if (category === 'client') {
		return {
			category: 'client',
			label: 'Client',
			description: 'Client settings',
			writable: true,
			settings: {
				'client.consent_required': settingMeta(
					'client.consent_required',
					'boolean',
					true,
					'Require consent',
					'Require consent for this client.'
				),
				'client.first_party': settingMeta(
					'client.first_party',
					'boolean',
					false,
					'First-party client',
					'Treat this client as a first-party application.'
				),
				'client.app_login_enabled': settingMeta(
					'client.app_login_enabled',
					'boolean',
					false,
					'App Login enabled',
					'Allow Login UI direct sign-in to start this client.'
				)
			}
		};
	}

	return {
		category,
		label: category,
		description: `${category} settings`,
		writable: true,
		settings: {}
	};
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function envFlag(platformEnv: EnvLike): boolean {
	const importMetaEnv = import.meta.env as Record<string, string | undefined>;
	const candidates = [
		platformEnv?.[DEV_ADMIN_MOCK_FLAG],
		importMetaEnv[DEV_ADMIN_MOCK_FLAG],
		typeof process !== 'undefined' ? process.env?.[DEV_ADMIN_MOCK_FLAG] : undefined
	];
	return candidates.some((candidate) => String(candidate || '').toLowerCase() === 'true');
}

export function isDevAdminMockEnabled(event: RequestEvent, platformEnv: EnvLike): boolean {
	return (
		Boolean(import.meta.env.DEV) &&
		!(typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') &&
		isLoopbackHost(event.url.hostname) &&
		envFlag(platformEnv)
	);
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			'X-Authrim-Dev-Mock': 'admin-ui',
			'X-Authrim-Dev-Mock-Sentinel': DEV_ADMIN_MOCK_SENTINEL
		}
	});
}

function xml(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			'Content-Type': 'application/samlmetadata+xml',
			'Cache-Control': 'no-store',
			'X-Authrim-Dev-Mock': 'admin-ui',
			'X-Authrim-Dev-Mock-Sentinel': DEV_ADMIN_MOCK_SENTINEL
		}
	});
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
	try {
		const value = await request.json();
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function nextVersion(current: string): string {
	const number = Number(current.replace(/^dev-/, ''));
	return `dev-${Number.isFinite(number) ? number + 1 : 1}`;
}

function settingKey(tenantId: string, category: string, clientId?: string): string {
	return clientId ? `${tenantId}:${category}:${clientId}` : `${tenantId}:${category}`;
}

function getTenantId(event: RequestEvent): string {
	return event.request.headers.get('x-tenant-id') || TENANT_ID;
}

function inferIpVersion(ipRange: string): 4 | 6 | null {
	if (!ipRange.trim()) return null;
	return ipRange.includes(':') ? 6 : 4;
}

function isDevIpAllowed(ip: string): boolean {
	const enabledEntries = [...ipAllowlistEntries.values()].filter((entry) => entry.enabled);
	if (enabledEntries.length === 0) return true;
	return enabledEntries.some((entry) => {
		const base = entry.ip_range.split('/')[0];
		return ip === base || (entry.ip_range === '127.0.0.1/32' && ip === '127.0.0.1');
	});
}

function activeSigningKey(): DevSigningKey | undefined {
	return signingKeys.find((key) => key.status === 'active') ?? signingKeys[0];
}

function signingKeysStatusPayload() {
	const activeKey = activeSigningKey();
	return {
		activeKeyId: activeKey?.kid ?? '',
		keys: signingKeys
	};
}

async function handleSigningKeys(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	if (segments[0] !== 'signing-keys') return null;

	if (event.request.method === 'GET' && segments[1] === 'status') {
		return json(signingKeysStatusPayload());
	}

	if (event.request.method === 'POST' && segments[1] === 'rotate') {
		const previousActive = activeSigningKey();
		const createdAt = new Date(Date.now()).toISOString();
		const newKey: DevSigningKey = {
			kid: `dev-signing-key-active-${Date.now()}`,
			algorithm: 'RS256',
			status: 'active',
			createdAt
		};
		signingKeys = [
			newKey,
			...signingKeys.map((key) =>
				key.kid === previousActive?.kid
					? { ...key, status: 'overlap' as const, overlaps: true }
					: key
			)
		];
		return json({
			success: true,
			message: 'Dev mock signing key rotation scheduled with overlap.',
			newKeyId: newKey.kid,
			revokedKeyId: previousActive?.kid
		});
	}

	if (event.request.method === 'POST' && segments[1] === 'emergency-rotate') {
		const body = await readJson(event.request);
		const reason = String(body.reason ?? '').trim();
		if (reason.length < 10) {
			return json(
				{ error: 'invalid_reason', message: 'Emergency rotation reason is required.' },
				400
			);
		}

		const previousActive = activeSigningKey();
		const now = new Date(Date.now()).toISOString();
		const newKey: DevSigningKey = {
			kid: `dev-signing-key-emergency-${Date.now()}`,
			algorithm: 'RS256',
			status: 'active',
			createdAt: now
		};
		signingKeys = [
			newKey,
			...signingKeys.map((key) =>
				key.kid === previousActive?.kid
					? { ...key, status: 'revoked' as const, revokedAt: now, overlaps: false }
					: key
			)
		];
		return json({
			success: true,
			message: 'Dev mock emergency signing key rotation completed.',
			newKeyId: newKey.kid,
			revokedKeyId: previousActive?.kid,
			warning: 'Existing tokens signed by the previous key are invalid in this mock state.'
		});
	}

	return null;
}

async function handleIpAllowlist(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	if (segments[0] !== 'ip-allowlist') return null;

	const method = event.request.method;
	const id = segments[1];

	if (segments.length === 1 && method === 'GET') {
		const includeDisabled = event.url.searchParams.get('include_disabled') === 'true';
		const items = [...ipAllowlistEntries.values()].filter(
			(entry) => includeDisabled || entry.enabled
		);
		return json({
			items,
			total: items.length,
			current_ip: '127.0.0.1',
			restriction_active: items.some((entry) => entry.enabled)
		});
	}

	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const ipRange = typeof input.ip_range === 'string' ? input.ip_range.trim() : '';
		if (!ipRange) return json({ error_description: 'ip_range is required' }, 400);
		const now = Date.now();
		const entry: DevIpAllowlistEntry = {
			id: `dev-ip-${now}`,
			tenant_id: TENANT_ID,
			ip_range: ipRange,
			ip_version: inferIpVersion(ipRange),
			description: typeof input.description === 'string' ? input.description : null,
			enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
			created_by: 'dev-admin',
			created_at: now,
			updated_at: now
		};
		ipAllowlistEntries.set(entry.id, entry);
		return json(entry);
	}

	if (id === 'check' && method === 'POST') {
		const input = await readJson(event.request);
		const ip = typeof input.ip === 'string' ? input.ip.trim() : '';
		const enabledCount = [...ipAllowlistEntries.values()].filter((entry) => entry.enabled).length;
		return json({
			ip,
			allowed: ip ? isDevIpAllowed(ip) : false,
			restriction_active: enabledCount > 0,
			entry_count: enabledCount
		});
	}

	if (!id) return null;

	const entry = ipAllowlistEntries.get(id);
	if (!entry) return json({ error_description: 'IP allowlist entry not found' }, 404);

	if (segments.length === 2 && method === 'GET') {
		return json(entry);
	}

	if (segments.length === 2 && method === 'PATCH') {
		const input = await readJson(event.request);
		const nextIpRange = typeof input.ip_range === 'string' ? input.ip_range.trim() : entry.ip_range;
		const updated: DevIpAllowlistEntry = {
			...entry,
			ip_range: nextIpRange,
			ip_version: inferIpVersion(nextIpRange),
			description: typeof input.description === 'string' ? input.description : entry.description,
			enabled: typeof input.enabled === 'boolean' ? input.enabled : entry.enabled,
			updated_at: Date.now()
		};
		ipAllowlistEntries.set(id, updated);
		return json(updated);
	}

	if (segments.length === 2 && method === 'DELETE') {
		ipAllowlistEntries.delete(id);
		return json({ success: true, message: 'IP allowlist entry deleted' });
	}

	if (
		segments.length === 3 &&
		method === 'POST' &&
		(segments[2] === 'enable' || segments[2] === 'disable')
	) {
		const enabled = segments[2] === 'enable';
		ipAllowlistEntries.set(id, { ...entry, enabled, updated_at: Date.now() });
		return json({
			success: true,
			message: `IP allowlist entry ${enabled ? 'enabled' : 'disabled'}`
		});
	}

	return null;
}

async function handleMyPasskeys(event: RequestEvent, segments: string[]): Promise<Response | null> {
	if (segments[0] !== 'me' || segments[1] !== 'passkeys') return null;

	const method = event.request.method;

	if (segments.length === 2 && method === 'GET') {
		const passkeys = [...adminPasskeys.values()];
		return json({ passkeys, total: passkeys.length });
	}

	if (segments[2] === 'options' && method === 'POST') {
		const input = await readJson(event.request);
		const rpId = typeof input.rp_id === 'string' ? input.rp_id : '127.0.0.1';
		const deviceName = typeof input.device_name === 'string' ? input.device_name : 'Dev PassKey';

		return json({
			challenge_id: `dev-passkey-challenge-${Date.now()}`,
			options: {
				challenge: 'ZGV2LXBhc3NrZXktY2hhbGxlbmdl',
				rp: { id: rpId, name: 'Authrim Admin' },
				user: {
					id: 'ZGV2LWFkbWlu',
					name: 'dev-admin@localhost',
					displayName: 'Dev Admin'
				},
				pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
				timeout: 60000,
				attestation: 'none',
				authenticatorSelection: {
					residentKey: 'preferred',
					userVerification: 'preferred'
				},
				excludeCredentials: [...adminPasskeys.values()].map((passkey) => ({
					id: passkey.id,
					type: 'public-key'
				})),
				extensions: { credProps: true },
				dev_mock_device_name: deviceName
			}
		});
	}

	if (segments[2] === 'complete' && method === 'POST') {
		const input = await readJson(event.request);
		const deviceName =
			typeof input.device_name === 'string' && input.device_name.trim()
				? input.device_name.trim()
				: 'Dev PassKey';
		const passkey: DevAdminPasskey = {
			id: `dev-passkey-${Date.now()}`,
			device_name: deviceName,
			created_at: Date.now(),
			last_used_at: null
		};
		adminPasskeys.set(passkey.id, passkey);
		return json({ success: true, passkey }, 201);
	}

	const passkeyId = decodeURIComponent(segments[2] || '');
	const passkey = adminPasskeys.get(passkeyId);
	if (!passkey) {
		return json({ error: 'not_found', error_description: 'Dev mock passkey not found' }, 404);
	}

	if (segments.length === 3 && method === 'PATCH') {
		const input = await readJson(event.request);
		const deviceName =
			typeof input.device_name === 'string' && input.device_name.trim()
				? input.device_name.trim()
				: passkey.device_name;
		const updated = { ...passkey, device_name: deviceName };
		adminPasskeys.set(passkeyId, updated);
		return json({ success: true, passkey: updated });
	}

	if (segments.length === 3 && method === 'DELETE') {
		if (adminPasskeys.size <= 1) {
			return json(
				{
					error: 'last_passkey',
					error_description: 'Cannot delete the last dev mock passkey'
				},
				400
			);
		}
		adminPasskeys.delete(passkeyId);
		return json({ success: true, message: 'Deleted dev mock passkey' });
	}

	return null;
}

function getSettings(tenantId: string, category: string, clientId?: string): DevSettings {
	const key = settingKey(tenantId, category, clientId);
	const existing = settings.get(key);
	if (existing) return existing;
	const created = {
		category,
		version: 'dev-1',
		values: {},
		sources: {}
	};
	settings.set(key, created);
	return created;
}

function runtimeProfileKey(kind: string, id: string): string {
	return `${kind}:${id}`;
}

function runtimeReferenceManagement() {
	return {
		mode: 'setup_only',
		future: 'admin_ui_planned',
		activationPolicy: 'save_ok_activate_ng',
		note: 'Dev mock exposes setup-owned runtime references for Admin UI preview.'
	};
}

function runtimeReferenceCatalog() {
	return {
		bindingRefs: {
			d1: ['DB', 'TENANT_CORE_DB', 'TENANT_PII_DB', 'TENANT_AUTHZ_DB'],
			r2: ['DIAGNOSTIC_LOGS'],
			hyperdrive: ['AUDIT_HYPERDRIVE_POSTGRES'],
			all: [
				'DB',
				'TENANT_CORE_DB',
				'TENANT_PII_DB',
				'TENANT_AUTHZ_DB',
				'DIAGNOSTIC_LOGS',
				'AUDIT_HYPERDRIVE_POSTGRES'
			]
		},
		connectionRefs: {
			all: ['AUDIT_HTTP_EXPORT', 'AUDIT_HYPERDRIVE_POSTGRES']
		}
	};
}

function runtimeActivationStatus(profile: Record<string, unknown>) {
	const id = String(profile.id || '');
	const blocked = id.includes('tenant-d1');
	const warning = id.includes('http-export');
	if (blocked) {
		return {
			state: 'blocked',
			activatable: false,
			severity: 'error',
			blockingReasons: ['Tenant D1 bindings are not configured in the dev mock runtime.'],
			warnings: []
		};
	}
	if (warning) {
		return {
			state: 'warning',
			activatable: true,
			severity: 'warning',
			blockingReasons: [],
			warnings: ['HTTP sink is configured as a reference-only dev mock target.']
		};
	}
	return {
		state: 'ready',
		activatable: true,
		severity: 'info',
		blockingReasons: [],
		warnings: []
	};
}

function runtimeReferenceStatus(profile: Record<string, unknown>) {
	const id = String(profile.id || '');
	if (id === 'custom:audit-http-export') {
		return [
			{
				path: 'sinks[0].url',
				type: 'http',
				resolution: 'reference_only',
				severity: 'warning',
				activation: 'warning_only',
				reference: 'AUDIT_HTTP_EXPORT',
				reason: 'HTTP delivery is represented as a dev mock reference.'
			}
		];
	}
	return [];
}

function runtimeStoragePolicy() {
	const slicePolicies = {
		identity_core: {
			slice: 'identity_core',
			boundaryClass: 'auth_core',
			tenantOverrideAllowed: false,
			d1Default: true,
			nonD1OptionRequired: false
		},
		identity_pii: {
			slice: 'identity_pii',
			boundaryClass: 'pii',
			tenantOverrideAllowed: true,
			d1Default: true,
			nonD1OptionRequired: false
		},
		custom_claims: {
			slice: 'custom_claims',
			boundaryClass: 'custom_extension',
			tenantOverrideAllowed: true,
			d1Default: true,
			nonD1OptionRequired: false
		},
		consent: {
			slice: 'consent',
			boundaryClass: 'pii',
			tenantOverrideAllowed: true,
			d1Default: true,
			nonD1OptionRequired: false
		},
		authorization: {
			slice: 'authorization',
			boundaryClass: 'authorization',
			tenantOverrideAllowed: false,
			d1Default: true,
			nonD1OptionRequired: false
		}
	};
	return {
		authCoreSlice: 'identity_core',
		authCoreSlices: ['identity_core'],
		slicePolicies,
		environmentDefaultStorageProfileId: runtimeProfileDefaults.storageProfileId,
		tenantDatabaseStatsStatus: {
			available: true,
			staleAfterHours: 24,
			cutoffIso: new Date(NOW - 86400000).toISOString(),
			summary: {
				active_tenant_core_databases: 4,
				stats_rows: 12,
				missing_stats_count: 1,
				stale_stats_count: 2,
				warning_count: 2,
				strong_warning_count: 1,
				stale_file_size_count: 1,
				unavailable_file_size_count: 0
			},
			attentionRequired: true
		},
		runtimeRegistrySecurityNotifications: {
			available: true,
			attentionRequired: false,
			summary: {
				pending_count: 1,
				failed_count: 0,
				dead_letter_count: 0,
				critical_count: 0,
				high_count: 1,
				latest_created_at: new Date(NOW - 3600000).toISOString()
			}
		},
		capabilityStatus: {
			'builtin:shared-d1': {
				profileId: 'builtin:shared-d1',
				deploymentProfile: 'shared-d1',
				mvpReady: true,
				unsupportedCount: 0,
				partialCount: 0,
				capabilities: []
			},
			'builtin:tenant-d1': {
				profileId: 'builtin:tenant-d1',
				deploymentProfile: 'tenant-d1',
				mvpReady: false,
				unsupportedCount: 1,
				partialCount: 1,
				capabilities: [
					{
						id: 'tenant-core-binding',
						label: 'Tenant core D1 binding',
						state: 'unsupported',
						criticality: 'security_critical',
						detail: 'TENANT_CORE_DB is not configured in dev mock.'
					},
					{
						id: 'tenant-stats',
						label: 'Tenant statistics',
						state: 'partial',
						criticality: 'admin_critical',
						detail: 'Stats are sample data only.'
					}
				]
			}
		},
		tenantOverrideEligibility: {
			'builtin:shared-d1': {
				authCoreSlice: 'identity_core',
				authCoreSlices: ['identity_core'],
				slicePolicies,
				environmentDefaultStorageProfileId: runtimeProfileDefaults.storageProfileId,
				tenantOverrideAllowed: true
			},
			'builtin:tenant-d1': {
				authCoreSlice: 'identity_core',
				authCoreSlices: ['identity_core'],
				slicePolicies,
				environmentDefaultStorageProfileId: runtimeProfileDefaults.storageProfileId,
				tenantOverrideAllowed: false,
				violationCode: 'auth_core_differs',
				reason: 'Auth core plane differs from the environment default.'
			}
		}
	};
}

function runtimeProfilesByKind(kind: string): Record<string, unknown>[] {
	return [...runtimeProfiles.values()].filter((profile) => profile.kind === kind);
}

function runtimeProfileListPayload(kind: string) {
	const profiles = runtimeProfilesByKind(kind);
	const activationById = Object.fromEntries(
		profiles.map((profile) => [String(profile.id), runtimeActivationStatus(profile)])
	);
	const referenceStatusById = Object.fromEntries(
		profiles.map((profile) => [String(profile.id), runtimeReferenceStatus(profile)])
	);
	return {
		profiles: { [kind]: profiles },
		reference_status: { [kind]: referenceStatusById },
		activation_status: { [kind]: activationById },
		reference_management: runtimeReferenceManagement(),
		reference_catalog: runtimeReferenceCatalog(),
		...(kind === 'storage' ? { storage_policy: runtimeStoragePolicy() } : {})
	};
}

function runtimeDefaultsPayload() {
	const storage = runtimeProfiles.get(
		runtimeProfileKey('storage', runtimeProfileDefaults.storageProfileId)
	);
	const audit = runtimeProfiles.get(
		runtimeProfileKey('audit', runtimeProfileDefaults.auditProfileId)
	);
	const residency = runtimeProfiles.get(
		runtimeProfileKey('residency', runtimeProfileDefaults.residencyProfileId)
	);
	return {
		defaults: runtimeProfileDefaults,
		effective: {
			storage: storage ?? null,
			audit: audit ?? null,
			residency: residency ?? null
		},
		activation_status: {
			storage: storage ? runtimeActivationStatus(storage) : runtimeActivationStatus({}),
			audit: audit ? runtimeActivationStatus(audit) : runtimeActivationStatus({}),
			residency: residency ? runtimeActivationStatus(residency) : runtimeActivationStatus({})
		},
		reference_management: runtimeReferenceManagement(),
		reference_catalog: runtimeReferenceCatalog()
	};
}

function listClients() {
	return {
		clients: [...clients.values()],
		pagination: {
			page: 1,
			limit: 50,
			total: clients.size,
			totalPages: 1,
			hasNext: false,
			hasPrev: false
		}
	};
}

function createClientId(name: unknown): string {
	const base = String(name || 'dev-client')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	const candidate = base || 'dev-client';
	if (!clients.has(candidate)) return candidate;
	return `${candidate}-${clients.size + 1}`;
}

function mergeClient(client: DevClient, patch: Record<string, unknown>): DevClient {
	return {
		...client,
		...patch,
		client_id: client.client_id,
		created_at: client.created_at,
		updated_at: Date.now()
	};
}

function createRoleId(name: unknown): string {
	const base = String(name || 'custom-role')
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	const candidate = `role-${base || 'custom-role'}`;
	if (!roles.has(candidate)) return candidate;
	return `${candidate}-${roles.size + 1}`;
}

function roleFromInput(input: Record<string, unknown>, existing?: DevRole): DevRole {
	const now = Math.floor(Date.now() / 1000);
	const permissions = Array.isArray(input.permissions)
		? input.permissions.map(String)
		: existing?.permissions || [];
	const name = existing?.name || String(input.name || 'custom_role');
	const role: DevRole = {
		id: existing?.id || createRoleId(name),
		tenant_id: existing?.tenant_id || TENANT_ID,
		name,
		display_name: existing?.display_name || name.replace(/[_-]+/g, ' '),
		description:
			typeof input.description === 'string'
				? input.description
				: existing?.description || undefined,
		is_system: existing?.is_system || false,
		permissions,
		inherits_from:
			typeof input.inherits_from === 'string'
				? input.inherits_from
				: existing?.inherits_from || undefined,
		assignment_count: existing?.assignment_count || 0,
		created_at: existing?.created_at || now,
		updated_at: now
	};
	return role;
}

async function handleRoles(event: RequestEvent, segments: string[]): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'roles') return null;

	if (segments.length === 1 && method === 'GET') {
		return json({ roles: [...roles.values()] });
	}

	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const role = roleFromInput(input);
		roles.set(role.id, role);
		roleAssignments.set(role.id, []);
		return json(role, 201);
	}

	const roleId = segments[1];
	const role = roles.get(roleId);
	if (!role) {
		return json({ error: 'not_found', error_description: 'Dev mock role not found' }, 404);
	}

	if (segments.length === 2 && method === 'GET') {
		return json({ role });
	}

	if (segments.length === 2 && method === 'PATCH') {
		const input = await readJson(event.request);
		const updated = roleFromInput(input, role);
		roles.set(roleId, updated);
		return json(updated);
	}

	if (segments.length === 2 && method === 'DELETE') {
		roles.delete(roleId);
		roleAssignments.delete(roleId);
		return json({ success: true });
	}

	if (segments[2] === 'assignments' && method === 'GET') {
		const page = Math.max(1, Number(event.url.searchParams.get('page') || '1'));
		const limit = Math.max(1, Number(event.url.searchParams.get('limit') || '20'));
		const assignments = roleAssignments.get(roleId) || [];
		const start = (page - 1) * limit;
		const paged = assignments.slice(start, start + limit);
		const totalPages = Math.max(1, Math.ceil(assignments.length / limit));
		return json({
			role_id: role.id,
			role_name: role.name,
			assignments: paged,
			pagination: {
				page,
				limit,
				total: assignments.length,
				totalPages,
				hasNext: page < totalPages,
				hasPrev: page > 1
			}
		});
	}

	return null;
}

function adminUserIdFromEmail(email: string): string {
	const base = email
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	const candidate = `admin-${base || 'user'}`;
	if (!adminUsers.has(candidate)) return candidate;
	return `${candidate}-${adminUsers.size + 1}`;
}

function adminUserDetail(user: DevAdminUser) {
	return {
		...user,
		roles: adminUserRoleAssignments.get(user.id) ?? [],
		passkey_count: user.mfa_method === 'passkey' || user.mfa_method === 'both' ? 1 : 0
	};
}

function createEndUserId(email: unknown): string {
	const base = String(email || 'user')
		.toLowerCase()
		.replace(/@.*$/, '')
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	const candidate = `dev-user-${base || 'user'}`;
	if (!endUsers.has(candidate)) return candidate;
	return `${candidate}-${endUsers.size + 1}`;
}

function endUserListResponse(event: RequestEvent) {
	const page = Math.max(1, Number(event.url.searchParams.get('page') || '1'));
	const limit = Math.max(1, Number(event.url.searchParams.get('limit') || '20'));
	const search = event.url.searchParams.get('search')?.toLowerCase().trim();
	const verified = event.url.searchParams.get('verified');
	const status = event.url.searchParams.get('status');
	const filtered = [...endUsers.values()].filter((user) => {
		if (
			search &&
			![
				user.id,
				user.email ?? '',
				user.name ?? '',
				user.given_name ?? '',
				user.family_name ?? '',
				user.preferred_username ?? ''
			]
				.join(' ')
				.toLowerCase()
				.includes(search)
		) {
			return false;
		}
		if (verified === 'true' && !user.email_verified) return false;
		if (verified === 'false' && user.email_verified) return false;
		if (status && user.status !== status) return false;
		return true;
	});
	const totalPages = Math.max(1, Math.ceil(filtered.length / limit));
	const start = (page - 1) * limit;
	return json({
		users: filtered.slice(start, start + limit),
		pagination: {
			page,
			limit,
			total: filtered.length,
			totalPages,
			hasNext: page < totalPages,
			hasPrev: page > 1
		}
	});
}

function sessionListResponse(event: RequestEvent) {
	const page = Math.max(1, Number(event.url.searchParams.get('page') || '1'));
	const limit = Math.max(1, Number(event.url.searchParams.get('limit') || '20'));
	const userId = event.url.searchParams.get('user_id')?.toLowerCase().trim();
	const status = event.url.searchParams.get('status');
	const filtered = [...userSessions.values()].filter((session) => {
		if (
			userId &&
			![session.user_id, session.user_email ?? '', session.user_name ?? '']
				.join(' ')
				.toLowerCase()
				.includes(userId)
		) {
			return false;
		}
		if (status === 'active' && !session.is_active) return false;
		if (status === 'expired' && session.is_active) return false;
		return true;
	});
	const totalPages = Math.max(1, Math.ceil(filtered.length / limit));
	const start = (page - 1) * limit;
	return json({
		sessions: filtered.slice(start, start + limit),
		pagination: {
			page,
			limit,
			total: filtered.length,
			totalPages,
			hasNext: page < totalPages,
			hasPrev: page > 1
		}
	});
}

async function handleSessions(event: RequestEvent, segments: string[]): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] === 'sessions') {
		if (segments.length === 1 && method === 'GET') return sessionListResponse(event);

		const sessionId = segments[1];
		if (!sessionId) return null;
		const session = userSessions.get(sessionId);
		if (!session) return json({ error_description: 'Session not found' }, 404);

		if (segments.length === 2 && method === 'GET') {
			return json({
				session: {
					id: session.id,
					userId: session.user_id,
					userEmail: session.user_email,
					userName: session.user_name,
					expiresAt: Math.floor(new Date(session.expires_at).getTime() / 1000),
					createdAt: Math.floor(new Date(session.created_at).getTime() / 1000),
					isActive: session.is_active,
					source: 'database'
				}
			});
		}

		if (segments.length === 2 && method === 'DELETE') {
			userSessions.set(sessionId, { ...session, is_active: false });
			return json({ success: true, message: 'Session revoked', sessionId });
		}
	}

	if (segments[0] === 'users' && segments[2] === 'sessions' && method === 'DELETE') {
		const userId = segments[1];
		let revokedCount = 0;
		for (const [sessionId, session] of userSessions) {
			if (session.user_id === userId && session.is_active) {
				userSessions.set(sessionId, { ...session, is_active: false });
				revokedCount += 1;
			}
		}
		return json({ success: true, message: 'User sessions revoked', revokedCount });
	}

	return null;
}

async function handleEndUsers(event: RequestEvent, segments: string[]): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'users') return null;

	if (segments.length === 1 && method === 'GET') {
		return endUserListResponse(event);
	}

	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const now = Date.now();
		const email = typeof input.email === 'string' && input.email.trim() ? input.email.trim() : null;
		const user: DevEndUser = {
			id: createEndUserId(email ?? input.name),
			tenant_id: TENANT_ID,
			email,
			name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : null,
			given_name:
				typeof input.given_name === 'string' && input.given_name.trim()
					? input.given_name.trim()
					: null,
			family_name:
				typeof input.family_name === 'string' && input.family_name.trim()
					? input.family_name.trim()
					: null,
			nickname: null,
			preferred_username: email?.split('@')[0] ?? null,
			picture: null,
			phone_number: null,
			email_verified: Boolean(input.email_verified),
			phone_number_verified: false,
			user_type: 'human',
			is_active: true,
			pii_partition: 'default',
			pii_status: 'available',
			created_at: now,
			updated_at: now,
			last_login_at: null,
			status: 'active',
			suspended_at: null,
			suspended_until: null,
			locked_at: null,
			locked_until: null,
			passkeys: []
		};
		endUsers.set(user.id, user);
		return json({ user }, 201);
	}

	const userId = segments[1];
	const user = endUsers.get(userId);
	if (!user) return json({ error_description: 'User not found' }, 404);

	if (segments.length === 2 && method === 'GET') {
		return json({
			user,
			passkeys: user.passkeys ?? [],
			customFields: [
				{
					field_name: 'employee_id',
					field_value: user.id === 'dev-user-alice' ? 'EMP-1001' : '',
					field_type: 'string'
				},
				{
					field_name: 'research_consent',
					field_value: user.id === 'dev-user-alice' ? 'true' : 'false',
					field_type: 'boolean'
				}
			],
			missing_required_fields: []
		});
	}

	if (segments.length === 2 && method === 'PUT') {
		const input = await readJson(event.request);
		const updated: DevEndUser = {
			...user,
			email:
				typeof input.email === 'string' && input.email.trim() ? input.email.trim() : user.email,
			name: typeof input.name === 'string' ? input.name.trim() || null : user.name,
			given_name:
				typeof input.given_name === 'string' ? input.given_name.trim() || null : user.given_name,
			family_name:
				typeof input.family_name === 'string' ? input.family_name.trim() || null : user.family_name,
			nickname: typeof input.nickname === 'string' ? input.nickname.trim() || null : user.nickname,
			preferred_username:
				typeof input.preferred_username === 'string'
					? input.preferred_username.trim() || null
					: user.preferred_username,
			phone_number:
				typeof input.phone_number === 'string'
					? input.phone_number.trim() || null
					: user.phone_number,
			email_verified:
				typeof input.email_verified === 'boolean' ? input.email_verified : user.email_verified,
			phone_number_verified:
				typeof input.phone_number_verified === 'boolean'
					? input.phone_number_verified
					: user.phone_number_verified,
			updated_at: Date.now()
		};
		endUsers.set(user.id, updated);
		return json({ user: updated });
	}

	if (segments.length === 2 && method === 'DELETE') {
		endUsers.delete(user.id);
		return new Response(null, { status: 204 });
	}

	if (segments.length === 3 && method === 'POST') {
		const now = Date.now();
		if (segments[2] === 'suspend') {
			const updated: DevEndUser = {
				...user,
				status: 'suspended',
				is_active: false,
				suspended_at: now,
				updated_at: now
			};
			endUsers.set(user.id, updated);
			return json({ user_id: user.id, status: updated.status, previous_status: user.status });
		}
		if (segments[2] === 'lock') {
			const updated: DevEndUser = {
				...user,
				status: 'locked',
				is_active: false,
				locked_at: now,
				updated_at: now
			};
			endUsers.set(user.id, updated);
			return json({ user_id: user.id, status: updated.status, previous_status: user.status });
		}
		if (segments[2] === 'activate') {
			const updated: DevEndUser = {
				...user,
				status: 'active',
				is_active: true,
				suspended_at: null,
				suspended_until: null,
				locked_at: null,
				locked_until: null,
				updated_at: now
			};
			endUsers.set(user.id, updated);
			return json({
				user_id: user.id,
				status: updated.status,
				previous_status: user.status,
				effective_at: new Date(now).toISOString()
			});
		}
	}

	return null;
}

function adminRoleListItem(role: DevRole) {
	return {
		id: role.id,
		tenant_id: role.tenant_id,
		name: role.name,
		display_name: role.display_name ?? null,
		description: role.description ?? null,
		permissions: role.permissions,
		hierarchy_level: role.name === 'admin' ? 100 : role.name === 'viewer' ? 10 : 50,
		role_type: role.is_system
			? 'system'
			: role.name === 'admin' || role.name === 'viewer'
				? 'builtin'
				: 'custom',
		is_system: role.is_system,
		inherits_from: role.inherits_from ?? null,
		created_at: role.created_at,
		updated_at: role.updated_at
	};
}

async function handleAdminUsers(event: RequestEvent, segments: string[]): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'admins') return null;

	if (segments.length === 1 && method === 'GET') {
		const page = Math.max(1, Number(event.url.searchParams.get('page') || '1'));
		const limit = Math.max(1, Number(event.url.searchParams.get('limit') || '20'));
		const email = event.url.searchParams.get('email')?.toLowerCase().trim();
		const status = event.url.searchParams.get('status');
		const mfaEnabled = event.url.searchParams.get('mfa_enabled');
		const filtered = [...adminUsers.values()].filter((user) => {
			if (email && !user.email.toLowerCase().includes(email)) return false;
			if (status && user.status !== status) return false;
			if (mfaEnabled === 'true' && !user.mfa_enabled) return false;
			if (mfaEnabled === 'false' && user.mfa_enabled) return false;
			return true;
		});
		const totalPages = Math.max(1, Math.ceil(filtered.length / limit));
		const start = (page - 1) * limit;
		return json({
			items: filtered.slice(start, start + limit),
			total: filtered.length,
			page,
			limit,
			totalPages
		});
	}

	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const email = typeof input.email === 'string' ? input.email.trim() : '';
		if (!email) return json({ error_description: 'email is required' }, 400);
		const now = Date.now();
		const user: DevAdminUser = {
			id: adminUserIdFromEmail(email),
			tenant_id: TENANT_ID,
			email,
			email_verified: false,
			name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : null,
			is_active: true,
			status: 'active',
			mfa_enabled: Boolean(input.mfa_enabled),
			mfa_method: input.mfa_enabled ? 'totp' : null,
			last_login_at: null,
			last_login_ip: null,
			failed_login_count: 0,
			created_by: 'admin-dev-admin',
			created_at: now,
			updated_at: now
		};
		adminUsers.set(user.id, user);
		adminUserRoleAssignments.set(user.id, []);
		return json(user, 201);
	}

	const userId = segments[1];
	const user = adminUsers.get(userId);
	if (!user) return json({ error_description: 'Admin user not found' }, 404);

	if (segments.length === 2 && method === 'GET') return json(adminUserDetail(user));

	if (segments.length === 2 && method === 'PATCH') {
		const input = await readJson(event.request);
		const status =
			input.status === 'active' || input.status === 'suspended' ? input.status : user.status;
		const updated: DevAdminUser = {
			...user,
			email:
				typeof input.email === 'string' && input.email.trim() ? input.email.trim() : user.email,
			name: typeof input.name === 'string' ? input.name.trim() || null : user.name,
			status,
			is_active: status === 'active',
			mfa_enabled: typeof input.mfa_enabled === 'boolean' ? input.mfa_enabled : user.mfa_enabled,
			updated_at: Date.now()
		};
		adminUsers.set(user.id, updated);
		return json(updated);
	}

	if (segments.length === 2 && method === 'DELETE') {
		adminUsers.delete(user.id);
		adminUserRoleAssignments.delete(user.id);
		return json({ success: true, message: 'Admin user deleted' });
	}

	if (segments.length === 3 && method === 'POST') {
		if (segments[2] === 'suspend') {
			const updated = {
				...user,
				status: 'suspended' as const,
				is_active: false,
				updated_at: Date.now()
			};
			adminUsers.set(user.id, updated);
			return json({ success: true, message: 'Admin user suspended' });
		}
		if (segments[2] === 'activate') {
			const updated = {
				...user,
				status: 'active' as const,
				is_active: true,
				updated_at: Date.now()
			};
			adminUsers.set(user.id, updated);
			return json({ success: true, message: 'Admin user activated' });
		}
		if (segments[2] === 'unlock') {
			const updated = {
				...user,
				status: 'active' as const,
				is_active: true,
				failed_login_count: 0,
				updated_at: Date.now()
			};
			adminUsers.set(user.id, updated);
			return json({ success: true, message: 'Admin user unlocked' });
		}
	}

	if (segments.length === 3 && segments[2] === 'roles' && method === 'POST') {
		const input = await readJson(event.request);
		const role = roles.get(String(input.role_id || ''));
		if (!role) return json({ error_description: 'Role not found' }, 404);
		const now = Date.now();
		const assignment: DevAdminRoleAssignment = {
			id: `admin-role-assignment-${user.id}-${role.id}-${now}`,
			assignment_id: `admin-role-assignment-${user.id}-${role.id}-${now}`,
			role_id: role.id,
			name: role.name,
			display_name: role.display_name ?? null,
			scope_type: input.scope_type === 'global' ? 'global' : 'tenant',
			scope_id: input.scope_type === 'global' ? null : String(input.scope_id || TENANT_ID),
			assigned_at: now,
			expires_at: typeof input.expires_at === 'number' ? input.expires_at : null,
			assigned_by: 'admin-dev-admin'
		};
		adminUserRoleAssignments.set(user.id, [
			...(adminUserRoleAssignments.get(user.id) ?? []),
			assignment
		]);
		return json({ id: assignment.id }, 201);
	}

	if (segments.length === 4 && segments[2] === 'role-assignments' && method === 'DELETE') {
		const assignmentId = segments[3];
		adminUserRoleAssignments.set(
			user.id,
			(adminUserRoleAssignments.get(user.id) ?? []).filter(
				(assignment) => assignment.assignment_id !== assignmentId
			)
		);
		return json({ success: true, message: 'Role assignment removed' });
	}

	return null;
}

async function handleAdminRoles(event: RequestEvent, segments: string[]): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'admin-roles') return null;

	if (segments.length === 1 && method === 'GET') {
		return json({ items: [...roles.values()].map(adminRoleListItem), total: roles.size });
	}

	if (segments.length === 2 && method === 'GET') {
		const role = roles.get(segments[1]);
		if (!role) return json({ error_description: 'Admin role not found' }, 404);
		const assignedUserIds = [...adminUserRoleAssignments.entries()]
			.filter(([, assignments]) => assignments.some((assignment) => assignment.role_id === role.id))
			.map(([userId]) => userId);
		return json({
			...adminRoleListItem(role),
			assigned_user_count: assignedUserIds.length,
			assigned_user_ids: assignedUserIds
		});
	}

	if (segments.length === 4 && segments[2] === 'assignments' && method === 'PATCH') {
		const roleId = segments[1];
		const assignmentId = segments[3];
		const input = await readJson(event.request);
		let updatedAssignment: DevAdminRoleAssignment | null = null;
		for (const [userId, assignments] of adminUserRoleAssignments.entries()) {
			const nextAssignments = assignments.map((assignment) => {
				if (assignment.role_id !== roleId || assignment.assignment_id !== assignmentId) {
					return assignment;
				}
				updatedAssignment = {
					...assignment,
					scope_type: input.scope_type === 'global' ? 'global' : 'tenant',
					scope_id: input.scope_type === 'global' ? null : String(input.scope_id || TENANT_ID),
					expires_at: typeof input.expires_at === 'number' ? input.expires_at : null
				};
				return updatedAssignment;
			});
			adminUserRoleAssignments.set(userId, nextAssignments);
		}
		if (!updatedAssignment) return json({ error_description: 'Assignment not found' }, 404);
		return json(updatedAssignment);
	}

	if (segments.length === 4 && segments[2] === 'assignments' && method === 'DELETE') {
		const roleId = segments[1];
		const assignmentId = segments[3];
		for (const [userId, assignments] of adminUserRoleAssignments.entries()) {
			adminUserRoleAssignments.set(
				userId,
				assignments.filter(
					(assignment) => assignment.role_id !== roleId || assignment.assignment_id !== assignmentId
				)
			);
		}
		return json({ success: true, message: 'Role assignment removed' });
	}

	return null;
}

function adminAuditListResponse(event: RequestEvent, items: DevAdminAuditLogEntry[]) {
	const page = Math.max(1, Number(event.url.searchParams.get('page') || '1'));
	const limit = Math.max(1, Number(event.url.searchParams.get('limit') || '20'));
	const start = (page - 1) * limit;
	const totalPages = Math.max(1, Math.ceil(items.length / limit));
	return {
		items: items.slice(start, start + limit),
		total: items.length,
		page,
		limit,
		totalPages
	};
}

function filterAdminAuditLogs(event: RequestEvent): DevAdminAuditLogEntry[] {
	const adminUserId = event.url.searchParams.get('admin_user_id')?.trim();
	const action = event.url.searchParams.get('action');
	const resourceType = event.url.searchParams.get('resource_type');
	const result = event.url.searchParams.get('result');
	const severity = event.url.searchParams.get('severity');
	const startDate = event.url.searchParams.get('start_date');
	const endDate = event.url.searchParams.get('end_date');
	const startMs = startDate ? Date.parse(startDate) : Number.NaN;
	const endMs = endDate ? Date.parse(endDate) : Number.NaN;
	return [...adminAuditLogs.values()]
		.filter((entry) => {
			if (
				adminUserId &&
				entry.admin_user_id !== adminUserId &&
				!entry.admin_email?.toLowerCase().includes(adminUserId.toLowerCase())
			) {
				return false;
			}
			if (action && entry.action !== action) return false;
			if (resourceType && entry.resource_type !== resourceType) return false;
			if (result && entry.result !== result) return false;
			if (severity && entry.severity !== severity) return false;
			if (Number.isFinite(startMs) && entry.created_at < startMs) return false;
			if (Number.isFinite(endMs) && entry.created_at > endMs) return false;
			return true;
		})
		.sort((a, b) => b.created_at - a.created_at);
}

function userAuditLogListResponse(event: RequestEvent) {
	const page = Math.max(1, Number(event.url.searchParams.get('page') || '1'));
	const limit = Math.max(1, Number(event.url.searchParams.get('limit') || '20'));
	const userId = event.url.searchParams.get('user_id')?.trim();
	const action = event.url.searchParams.get('action')?.trim();
	const resourceType = event.url.searchParams.get('resource_type')?.trim();
	const resourceId = event.url.searchParams.get('resource_id')?.trim();
	const entries = [...endUsers.values()].flatMap((user) => {
		const session = [...userSessions.values()].find((item) => item.user_id === user.id);
		return [
			{
				id: `audit-${user.id}-login`,
				userId: user.id,
				action: 'user.login',
				resourceType: 'session',
				resourceId: session?.id ?? null,
				ipAddress: session?.ip_address ?? '203.0.113.24',
				userAgent: session?.user_agent ?? null,
				metadata: { method: user.passkeys?.length ? 'passkey' : 'email_otp' },
				createdAt: new Date(user.last_login_at ?? Date.now() - 3600 * 1000).toISOString()
			},
			{
				id: `audit-${user.id}-session-created`,
				userId: user.id,
				action: 'session.created',
				resourceType: 'session',
				resourceId: session?.id ?? null,
				ipAddress: session?.ip_address ?? null,
				userAgent: session?.user_agent ?? null,
				metadata: { source: 'dev-mock' },
				createdAt: session?.created_at ?? new Date(user.created_at).toISOString()
			},
			{
				id: `audit-${user.id}-updated`,
				userId: user.id,
				action: 'user.updated',
				resourceType: 'user',
				resourceId: user.id,
				ipAddress: '127.0.0.1',
				userAgent: 'Authrim Admin UI dev mock',
				metadata: { fields: ['profile'] },
				createdAt: new Date(user.updated_at).toISOString()
			}
		];
	});
	const filtered = entries
		.filter((entry) => {
			if (userId && entry.userId !== userId) return false;
			if (action && entry.action !== action) return false;
			if (resourceType && entry.resourceType !== resourceType) return false;
			if (resourceId && entry.resourceId !== resourceId) return false;
			return true;
		})
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
	const totalPages = Math.max(1, Math.ceil(filtered.length / limit));
	const start = (page - 1) * limit;
	return json({
		entries: filtered.slice(start, start + limit),
		pagination: {
			page,
			limit,
			total: filtered.length,
			totalPages
		}
	});
}

async function handleUserAuditLogs(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'audit-logs') return null;
	if (segments.length === 1 && method === 'GET') return userAuditLogListResponse(event);
	const entryId = segments[1];
	if (!entryId || method !== 'GET') return null;
	const listResponse = userAuditLogListResponse(event);
	const payload = (await listResponse.json()) as { entries: unknown[] };
	const entry = payload.entries.find((item) => {
		return (
			typeof item === 'object' &&
			item !== null &&
			'id' in item &&
			(item as { id?: string }).id === entryId
		);
	});
	return entry ? json(entry) : json({ error_description: 'Audit log entry not found' }, 404);
}

function adminAuditStats(days: number) {
	const since = Date.now() - days * 86400 * 1000;
	const entries = [...adminAuditLogs.values()];
	const recentEntries = entries.filter((entry) => entry.created_at >= since);
	const result_breakdown = Object.fromEntries(
		['success', 'failure'].map((result) => [
			result,
			recentEntries.filter((entry) => entry.result === result).length
		])
	);
	const severity_breakdown = Object.fromEntries(
		['debug', 'info', 'warn', 'error', 'critical'].map((severity) => [
			severity,
			recentEntries.filter((entry) => entry.severity === severity).length
		])
	);
	const actionCounts = new Map<string, number>();
	const adminCounts = new Map<
		string,
		{ admin_user_id: string; admin_email: string; action_count: number }
	>();
	for (const entry of recentEntries) {
		actionCounts.set(entry.action, (actionCounts.get(entry.action) ?? 0) + 1);
		if (entry.admin_user_id && entry.admin_email) {
			const current = adminCounts.get(entry.admin_user_id) ?? {
				admin_user_id: entry.admin_user_id,
				admin_email: entry.admin_email,
				action_count: 0
			};
			current.action_count += 1;
			adminCounts.set(entry.admin_user_id, current);
		}
	}
	return {
		total_entries: entries.length,
		recent_entries: recentEntries.length,
		time_range_days: days,
		result_breakdown,
		severity_breakdown,
		top_actions: [...actionCounts.entries()]
			.map(([action, count]) => ({ action, count }))
			.sort((a, b) => b.count - a.count),
		most_active_admins: [...adminCounts.values()].sort((a, b) => b.action_count - a.action_count)
	};
}

async function handleAdminAuditLog(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'admin-audit-log') return null;

	if (segments[1] === 'actions' && segments[2] === 'list' && method === 'GET') {
		const items = [...new Set([...adminAuditLogs.values()].map((entry) => entry.action))].sort();
		return json({ items, total: items.length });
	}

	if (segments[1] === 'resource-types' && segments[2] === 'list' && method === 'GET') {
		const items = [
			...new Set(
				[...adminAuditLogs.values()]
					.map((entry) => entry.resource_type)
					.filter((value): value is string => Boolean(value))
			)
		].sort();
		return json({ items, total: items.length });
	}

	if (segments[1] === 'stats' && segments[2] === 'summary' && method === 'GET') {
		const days = Math.max(1, Number(event.url.searchParams.get('days') || '7'));
		return json(adminAuditStats(days));
	}

	if (segments[1] === 'user' && segments[2] && method === 'GET') {
		const items = filterAdminAuditLogs(event).filter(
			(entry) => entry.admin_user_id === segments[2]
		);
		return json(adminAuditListResponse(event, items));
	}

	if (segments.length === 1 && method === 'GET') {
		return json(adminAuditListResponse(event, filterAdminAuditLogs(event)));
	}

	if (segments.length === 2 && method === 'GET') {
		const entry = adminAuditLogs.get(segments[1]);
		if (!entry) return json({ error_description: 'Audit log entry not found' }, 404);
		const adminUser = entry.admin_user_id ? adminUsers.get(entry.admin_user_id) : undefined;
		return json({
			...entry,
			admin_user: adminUser
				? { id: adminUser.id, email: adminUser.email, name: adminUser.name }
				: null
		});
	}

	return null;
}

function pageItems<T>(event: RequestEvent, items: T[]) {
	const offset = Math.max(0, Number(event.url.searchParams.get('offset') || '0'));
	const limit = Math.max(
		1,
		Number(event.url.searchParams.get('limit') || String(items.length || 20))
	);
	return {
		items: items.slice(offset, offset + limit),
		total: items.length,
		limit,
		offset
	};
}

function createAdminAttributeId(name: unknown): string {
	const base = String(name || 'admin_attribute')
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	const candidate = `attr-${base || 'custom'}`;
	if (!adminAttributes.has(candidate)) return candidate;
	return `${candidate}-${adminAttributes.size + 1}`;
}

function adminAttributeFromInput(
	input: Record<string, unknown>,
	existing?: DevAdminAttribute
): DevAdminAttribute {
	const now = Math.floor(Date.now() / 1000);
	const name = existing?.name || String(input.name || 'admin_attribute');
	const attributeType =
		input.attribute_type === 'enum' ||
		input.attribute_type === 'number' ||
		input.attribute_type === 'boolean' ||
		input.attribute_type === 'date' ||
		input.attribute_type === 'array'
			? input.attribute_type
			: existing?.attribute_type || 'string';
	return {
		id: existing?.id || createAdminAttributeId(name),
		tenant_id: existing?.tenant_id || TENANT_ID,
		name,
		display_name:
			typeof input.display_name === 'string' ? input.display_name : existing?.display_name || null,
		description:
			typeof input.description === 'string' ? input.description : existing?.description || null,
		attribute_type: attributeType,
		allowed_values: Array.isArray(input.allowed_values)
			? input.allowed_values.map(String)
			: existing?.allowed_values || null,
		min_value: typeof input.min_value === 'number' ? input.min_value : existing?.min_value || null,
		max_value: typeof input.max_value === 'number' ? input.max_value : existing?.max_value || null,
		regex_pattern:
			typeof input.regex_pattern === 'string'
				? input.regex_pattern
				: existing?.regex_pattern || null,
		is_required:
			typeof input.is_required === 'boolean' ? input.is_required : (existing?.is_required ?? false),
		is_multi_valued:
			typeof input.is_multi_valued === 'boolean'
				? input.is_multi_valued
				: (existing?.is_multi_valued ?? false),
		is_system: existing?.is_system || false,
		created_at: existing?.created_at || now,
		updated_at: now
	};
}

async function handleAdminAttributes(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'admin-attributes') return null;

	if (segments.length === 1 && method === 'GET') {
		const includeSystem = event.url.searchParams.get('include_system') === 'true';
		const items = [...adminAttributes.values()].filter((attr) => includeSystem || !attr.is_system);
		return json(pageItems(event, items));
	}

	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const attribute = adminAttributeFromInput(input);
		adminAttributes.set(attribute.id, attribute);
		return json(attribute, 201);
	}

	const attribute = adminAttributes.get(segments[1]);
	if (!attribute) {
		return json({ error: 'not_found', message: 'Dev mock admin attribute not found' }, 404);
	}

	if (segments.length === 2 && method === 'GET') return json(attribute);

	if (segments.length === 2 && method === 'PATCH') {
		if (attribute.is_system) {
			return json({ error: 'system_attribute', message: 'System attributes are read-only' }, 409);
		}
		const input = await readJson(event.request);
		const updated = adminAttributeFromInput(input, attribute);
		adminAttributes.set(attribute.id, updated);
		return json(updated);
	}

	if (segments.length === 2 && method === 'DELETE') {
		if (attribute.is_system) {
			return json(
				{ error: 'system_attribute', message: 'System attributes cannot be deleted' },
				409
			);
		}
		adminAttributes.delete(attribute.id);
		return json({ success: true });
	}

	return null;
}

function createAdminRebacDefinitionId(name: unknown): string {
	const base = String(name || 'relationship')
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	const candidate = `rebac-def-${base || 'custom'}`;
	if (!adminRebacDefinitions.has(candidate)) return candidate;
	return `${candidate}-${adminRebacDefinitions.size + 1}`;
}

function adminRebacDefinitionFromInput(
	input: Record<string, unknown>,
	existing?: DevAdminRebacDefinition
): DevAdminRebacDefinition {
	const now = Math.floor(Date.now() / 1000);
	const relationName = existing?.relation_name || String(input.relation_name || 'relationship');
	return {
		id: existing?.id || createAdminRebacDefinitionId(relationName),
		tenant_id: existing?.tenant_id || TENANT_ID,
		relation_name: relationName,
		display_name:
			typeof input.display_name === 'string' ? input.display_name : existing?.display_name || null,
		description:
			typeof input.description === 'string' ? input.description : existing?.description || null,
		priority: typeof input.priority === 'number' ? input.priority : existing?.priority || 0,
		is_system: existing?.is_system || false,
		created_at: existing?.created_at || now,
		updated_at: now
	};
}

async function handleAdminRebacDefinitions(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'admin-rebac-definitions') return null;

	if (segments.length === 1 && method === 'GET') {
		const includeSystem = event.url.searchParams.get('include_system') !== 'false';
		const items = [...adminRebacDefinitions.values()].filter(
			(def) => includeSystem || !def.is_system
		);
		return json(pageItems(event, items));
	}

	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const definition = adminRebacDefinitionFromInput(input);
		adminRebacDefinitions.set(definition.id, definition);
		return json(definition, 201);
	}

	const definition = adminRebacDefinitions.get(segments[1]);
	if (!definition) {
		return json({ error: 'not_found', message: 'Dev mock ReBAC definition not found' }, 404);
	}

	if (segments.length === 2 && method === 'GET') return json(definition);

	if (segments.length === 2 && method === 'PATCH') {
		if (definition.is_system) {
			return json({ error: 'system_definition', message: 'System definitions are read-only' }, 409);
		}
		const input = await readJson(event.request);
		const updated = adminRebacDefinitionFromInput(input, definition);
		adminRebacDefinitions.set(definition.id, updated);
		return json(updated);
	}

	if (segments.length === 2 && method === 'DELETE') {
		if (definition.is_system) {
			return json(
				{ error: 'system_definition', message: 'System definitions cannot be deleted' },
				409
			);
		}
		adminRebacDefinitions.delete(definition.id);
		return json({ success: true });
	}

	return null;
}

function createAdminRelationshipId(type: unknown, fromId: unknown, toId: unknown): string {
	const base = `${String(type || 'rel')}-${String(fromId || 'from')}-${String(toId || 'to')}`
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 56);
	const candidate = `rel-${base || 'custom'}`;
	if (!adminRelationships.has(candidate)) return candidate;
	return `${candidate}-${adminRelationships.size + 1}`;
}

function adminRelationshipFromInput(input: Record<string, unknown>): DevAdminRelationship {
	const now = Math.floor(Date.now() / 1000);
	const relationshipType = String(input.relationship_type || 'supports');
	const fromId = String(input.from_id || 'dev-admin');
	const toId = String(input.to_id || 'dev-target');
	const permission =
		input.permission_level === 'full' ||
		input.permission_level === 'limited' ||
		input.permission_level === 'read_only'
			? input.permission_level
			: null;
	return {
		id: createAdminRelationshipId(relationshipType, fromId, toId),
		tenant_id: TENANT_ID,
		relationship_type: relationshipType,
		from_type: typeof input.from_type === 'string' ? input.from_type : null,
		from_id: fromId,
		to_type: typeof input.to_type === 'string' ? input.to_type : null,
		to_id: toId,
		permission_level: permission,
		is_transitive: typeof input.is_transitive === 'boolean' ? input.is_transitive : false,
		expires_at: typeof input.expires_at === 'number' ? input.expires_at : null,
		is_bidirectional: typeof input.is_bidirectional === 'boolean' ? input.is_bidirectional : false,
		metadata:
			input.metadata && typeof input.metadata === 'object'
				? (input.metadata as Record<string, unknown>)
				: null,
		created_by: 'dev-admin',
		created_at: now,
		updated_at: now
	};
}

async function handleAdminRelationships(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'admin-relationships') return null;

	if (segments.length === 1 && method === 'GET') {
		const type = event.url.searchParams.get('type');
		const items = [...adminRelationships.values()].filter(
			(rel) => !type || rel.relationship_type === type
		);
		return json(pageItems(event, items));
	}

	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const relationship = adminRelationshipFromInput(input);
		adminRelationships.set(relationship.id, relationship);
		return json(relationship, 201);
	}

	const relationship = adminRelationships.get(segments[1]);
	if (!relationship) {
		return json({ error: 'not_found', message: 'Dev mock admin relationship not found' }, 404);
	}

	if (segments.length === 2 && method === 'GET') return json(relationship);

	if (segments.length === 2 && method === 'DELETE') {
		adminRelationships.delete(relationship.id);
		return json({ success: true });
	}

	return null;
}

function createAdminPolicyId(name: unknown): string {
	const base = String(name || 'policy')
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 56);
	const candidate = `policy-${base || 'custom'}`;
	if (!adminPolicies.has(candidate)) return candidate;
	return `${candidate}-${adminPolicies.size + 1}`;
}

function stringList(value: unknown, fallback: string[]): string[] {
	return Array.isArray(value) ? value.map(String).filter(Boolean) : fallback;
}

function adminPolicyFromInput(
	input: Record<string, unknown>,
	existing?: DevAdminPolicy
): DevAdminPolicy {
	const now = Math.floor(Date.now() / 1000);
	const name = existing?.name || String(input.name || 'custom_policy');
	return {
		id: existing?.id || createAdminPolicyId(name),
		tenant_id: existing?.tenant_id || TENANT_ID,
		name,
		display_name:
			typeof input.display_name === 'string' ? input.display_name : existing?.display_name || null,
		description:
			typeof input.description === 'string' ? input.description : existing?.description || null,
		effect: input.effect === 'deny' ? 'deny' : existing?.effect || 'allow',
		priority: typeof input.priority === 'number' ? input.priority : existing?.priority || 0,
		resource_pattern:
			typeof input.resource_pattern === 'string'
				? input.resource_pattern
				: existing?.resource_pattern || 'admin:*',
		actions: stringList(input.actions, existing?.actions || ['*']),
		conditions:
			input.conditions && typeof input.conditions === 'object' && !Array.isArray(input.conditions)
				? (input.conditions as Record<string, unknown>)
				: existing?.conditions || { condition_type: 'all' },
		is_active:
			typeof input.is_active === 'boolean' ? input.is_active : (existing?.is_active ?? true),
		is_system: existing?.is_system || false,
		created_at: existing?.created_at || now,
		updated_at: now
	};
}

function resourceMatches(pattern: string, resource: string): boolean {
	if (pattern === '*') return true;
	if (pattern.endsWith('*')) return resource.startsWith(pattern.slice(0, -1));
	return pattern === resource;
}

async function handleAdminPolicies(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'admin-policies') return null;

	if (segments.length === 1 && method === 'GET') {
		const activeOnly = event.url.searchParams.get('active_only') === 'true';
		const resource = event.url.searchParams.get('resource');
		const items = [...adminPolicies.values()].filter((policy) => {
			if (activeOnly && !policy.is_active) return false;
			if (resource && !resourceMatches(policy.resource_pattern, resource)) return false;
			return true;
		});
		return json(pageItems(event, items));
	}

	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const policy = adminPolicyFromInput(input);
		adminPolicies.set(policy.id, policy);
		return json(policy, 201);
	}

	if (segments[1] === 'simulate' && segments.length === 2 && method === 'POST') {
		const input = await readJson(event.request);
		const resource = String(input.resource || '');
		const action = String(input.action || '');
		const evaluations = [...adminPolicies.values()]
			.filter((policy) => policy.is_active)
			.sort((a, b) => b.priority - a.priority)
			.map((policy) => {
				const matched =
					resourceMatches(policy.resource_pattern, resource) &&
					(policy.actions.includes('*') || policy.actions.includes(action));
				return {
					policy_id: policy.id,
					policy_name: policy.name,
					matched,
					effect: policy.effect,
					priority: policy.priority,
					condition_results: { dev_mock: true }
				};
			});
		const firstMatch = evaluations.find((evaluation) => evaluation.matched);
		return json({
			resource,
			action,
			decision: firstMatch?.effect || 'no_match',
			evaluations,
			total_policies_evaluated: evaluations.length
		});
	}

	const policy = adminPolicies.get(segments[1]);
	if (!policy) {
		return json({ error: 'not_found', message: 'Dev mock admin policy not found' }, 404);
	}

	if (segments.length === 2 && method === 'GET') return json(policy);

	if (segments.length === 2 && method === 'PATCH') {
		if (policy.is_system) {
			return json({ error: 'system_policy', message: 'System policies are read-only' }, 409);
		}
		const input = await readJson(event.request);
		const updated = adminPolicyFromInput(input, policy);
		adminPolicies.set(policy.id, updated);
		return json(updated);
	}

	if (segments.length === 2 && method === 'DELETE') {
		if (policy.is_system) {
			return json({ error: 'system_policy', message: 'System policies cannot be deleted' }, 409);
		}
		adminPolicies.delete(policy.id);
		return json({ success: true });
	}

	if (segments.length === 3 && method === 'POST' && segments[2] === 'activate') {
		const updated = { ...policy, is_active: true, updated_at: Math.floor(Date.now() / 1000) };
		adminPolicies.set(policy.id, updated);
		return json(updated);
	}

	if (segments.length === 3 && method === 'POST' && segments[2] === 'deactivate') {
		const updated = { ...policy, is_active: false, updated_at: Math.floor(Date.now() / 1000) };
		adminPolicies.set(policy.id, updated);
		return json(updated);
	}

	return null;
}

function createPolicyRuleId(name: unknown): string {
	const base = String(name || 'rule')
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 56);
	const candidate = `policy-rule-${base || 'custom'}`;
	if (!policyRules.has(candidate)) return candidate;
	return `${candidate}-${policyRules.size + 1}`;
}

function policyConditions(value: unknown, fallback: DevPolicyCondition[]): DevPolicyCondition[] {
	if (!Array.isArray(value)) return fallback;
	return value
		.filter((condition) => condition && typeof condition === 'object')
		.map((condition) => {
			const record = condition as Record<string, unknown>;
			return {
				type: String(record.type || 'has_role'),
				params:
					record.params && typeof record.params === 'object' && !Array.isArray(record.params)
						? (record.params as Record<string, unknown>)
						: {}
			};
		});
}

function policyRuleFromInput(
	input: Record<string, unknown>,
	existing?: DevPolicyRule
): DevPolicyRule {
	const now = Math.floor(Date.now() / 1000);
	const name = existing?.name || String(input.name || 'custom_rule');
	return {
		id: existing?.id || createPolicyRuleId(name),
		name,
		description:
			typeof input.description === 'string' ? input.description : existing?.description || '',
		priority: typeof input.priority === 'number' ? input.priority : existing?.priority || 100,
		effect: input.effect === 'deny' ? 'deny' : existing?.effect || 'allow',
		resource_types: stringList(input.resource_types, existing?.resource_types || []),
		actions: stringList(input.actions, existing?.actions || []),
		conditions: policyConditions(input.conditions, existing?.conditions || []),
		enabled: typeof input.enabled === 'boolean' ? input.enabled : (existing?.enabled ?? true),
		created_by: existing?.created_by || 'dev-admin',
		created_at: existing?.created_at || now,
		updated_by: 'dev-admin',
		updated_at: now
	};
}

function policyRuleMatches(rule: DevPolicyRule, resourceType: string, action: string): boolean {
	const resourceMatchesRule =
		rule.resource_types.length === 0 || rule.resource_types.includes(resourceType);
	const actionMatchesRule = rule.actions.length === 0 || rule.actions.includes(action);
	return rule.enabled && resourceMatchesRule && actionMatchesRule;
}

async function handlePolicyRules(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'policies') return null;

	if (segments[1] === 'condition-types' && segments.length === 2 && method === 'GET') {
		return json({
			categories: [
				{ id: 'rbac', label: 'RBAC', icon: 'user' },
				{ id: 'ownership', label: 'Ownership', icon: 'shield' },
				{ id: 'abac', label: 'ABAC', icon: 'tag' }
			],
			condition_types: [
				{
					type: 'has_role',
					category: 'rbac',
					label: 'Has role',
					description: 'Subject has the specified role.',
					params: [
						{ name: 'role', type: 'string', required: true, label: 'Role' },
						{ name: 'scope', type: 'string', required: false, label: 'Scope' }
					]
				},
				{
					type: 'has_any_role',
					category: 'rbac',
					label: 'Has any role',
					description: 'Subject has at least one listed role.',
					params: [{ name: 'roles', type: 'string[]', required: true, label: 'Roles' }]
				},
				{
					type: 'same_organization',
					category: 'ownership',
					label: 'Same organization',
					description: 'Subject and resource share an organization.',
					params: []
				},
				{
					type: 'attribute_equals',
					category: 'abac',
					label: 'Attribute equals',
					description: 'A subject or resource attribute equals the given value.',
					params: [
						{ name: 'attribute', type: 'string', required: true, label: 'Attribute' },
						{ name: 'value', type: 'string', required: true, label: 'Value' }
					]
				}
			]
		});
	}

	if (segments[1] === 'simulate' && segments.length === 2 && method === 'POST') {
		const input = await readJson(event.request);
		const context =
			input.context && typeof input.context === 'object'
				? (input.context as Record<string, unknown>)
				: {};
		const resource =
			context.resource && typeof context.resource === 'object'
				? (context.resource as Record<string, unknown>)
				: {};
		const action =
			context.action && typeof context.action === 'object'
				? (context.action as Record<string, unknown>)
				: {};
		const resourceType = String(resource.type || '');
		const actionName = String(action.name || '');
		const sortedRules = [...policyRules.values()].sort((a, b) => b.priority - a.priority);
		const matched = sortedRules.find((rule) => policyRuleMatches(rule, resourceType, actionName));
		return json({
			allowed: matched?.effect === 'allow',
			reason: matched
				? `Matched dev mock policy rule ${matched.name}`
				: 'No matching dev mock policy rule',
			decided_by: matched?.id,
			details: { dev_mock: true },
			evaluated_rules: sortedRules.filter((rule) => rule.enabled).length
		});
	}

	if (segments[1] === 'simulations' && segments.length === 2 && method === 'GET') {
		return json({
			simulations: [],
			pagination: { page: 1, limit: 20, total: 0, total_pages: 1 }
		});
	}

	if (segments.length === 1 && method === 'GET') {
		const page = Math.max(1, Number(event.url.searchParams.get('page') || '1'));
		const limit = Math.max(1, Number(event.url.searchParams.get('limit') || '20'));
		const enabled = event.url.searchParams.get('enabled');
		const search = (event.url.searchParams.get('search') || '').toLowerCase();
		const filtered = [...policyRules.values()].filter((rule) => {
			if (enabled === 'true' && !rule.enabled) return false;
			if (enabled === 'false' && rule.enabled) return false;
			if (search && !`${rule.name} ${rule.description || ''}`.toLowerCase().includes(search)) {
				return false;
			}
			return true;
		});
		const start = (page - 1) * limit;
		return json({
			rules: filtered.slice(start, start + limit),
			pagination: {
				page,
				limit,
				total: filtered.length,
				total_pages: Math.max(1, Math.ceil(filtered.length / limit))
			}
		});
	}

	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const rule = policyRuleFromInput(input);
		policyRules.set(rule.id, rule);
		return json({ success: true, rule_id: rule.id }, 201);
	}

	const rule = policyRules.get(segments[1]);
	if (!rule) {
		return json({ error: 'not_found', error_description: 'Dev mock policy rule not found' }, 404);
	}

	if (segments.length === 2 && method === 'GET') return json({ rule });

	if (segments.length === 2 && method === 'PUT') {
		const input = await readJson(event.request);
		const updated = policyRuleFromInput(input, rule);
		policyRules.set(rule.id, updated);
		return json({ success: true });
	}

	if (segments.length === 2 && method === 'DELETE') {
		policyRules.delete(rule.id);
		return json({ success: true });
	}

	return null;
}

function createFlowId(name: unknown): string {
	const base = String(name || 'flow')
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	const candidate = `flow-${base || 'custom'}`;
	if (!flows.has(candidate)) return candidate;
	return `${candidate}-${flows.size + 1}`;
}

function flowFromInput(input: Record<string, unknown>, existing?: DevFlow): DevFlow {
	const now = Math.floor(Date.now() / 1000);
	const name =
		typeof input.display_name === 'string'
			? input.display_name
			: typeof input.name === 'string'
				? input.name
				: existing?.display_name || existing?.name || 'Custom Flow';
	const kind =
		input.kind === 'registration' ||
		input.kind === 'approve' ||
		input.kind === 'account' ||
		(typeof input.kind === 'string' && input.kind.startsWith('custom:'))
			? (input.kind as DevFlow['kind'])
			: existing?.kind || 'login';
	const editor =
		input.editor && typeof input.editor === 'object' && !Array.isArray(input.editor)
			? (input.editor as Record<string, unknown>)
			: existing?.draft_editor_json ||
				devFlowEditor(kind === 'registration' ? 'registration' : 'login');
	const runtime =
		input.runtime && typeof input.runtime === 'object' && !Array.isArray(input.runtime)
			? (input.runtime as Record<string, unknown>)
			: existing?.draft_runtime_base_json ||
				devFlowRuntime(
					existing?.id || createFlowId(name),
					kind === 'registration' ? 'registration' : 'login',
					editor
				);
	const id = existing?.id || createFlowId(name);
	return {
		id,
		tenant_id: existing?.tenant_id || TENANT_ID,
		client_id:
			typeof input.client_id === 'string' || input.client_id === null
				? input.client_id
				: existing?.client_id || null,
		profile_id:
			input.profile_id === 'human-org' ||
			input.profile_id === 'ai-agent' ||
			input.profile_id === 'iot-device'
				? input.profile_id
				: existing?.profile_id || 'human-basic',
		name,
		description:
			typeof input.description === 'string' ? input.description : existing?.description || null,
		graph_definition: editor as DevFlow['graph_definition'],
		compiled_plan: runtime,
		version: typeof input.version === 'string' ? input.version : existing?.version || 'v1',
		is_active:
			input.status === 'disabled'
				? false
				: typeof input.is_active === 'boolean'
					? input.is_active
					: (existing?.is_active ?? true),
		is_builtin: existing?.is_builtin || false,
		created_by: existing?.created_by || 'dev-admin',
		created_at: existing?.created_at || now,
		updated_by: 'dev-admin',
		updated_at: now,
		slug: typeof input.slug === 'string' ? input.slug : existing?.slug || id.replace(/^flow-/, ''),
		display_name: name,
		kind,
		status:
			input.status === 'published' || input.status === 'disabled' || input.status === 'draft'
				? input.status
				: existing?.status || 'draft',
		draft_editor_json: editor,
		draft_runtime_base_json: { ...runtime, flow_id: id, flow_kind: kind },
		published_version_id: existing?.published_version_id || null,
		deleted_at: existing?.deleted_at || null
	};
}

function normalizeDevFlow(flow: DevFlow): DevFlow {
	if (flow.kind && flow.status && flow.draft_editor_json && flow.draft_runtime_base_json) {
		return flow;
	}
	const kind = flow.kind || (flow.id.includes('registration') ? 'registration' : 'login');
	const editor =
		flow.draft_editor_json ||
		(flow.graph_definition && typeof flow.graph_definition === 'object'
			? (flow.graph_definition as Record<string, unknown>)
			: devFlowEditor(kind === 'registration' ? 'registration' : 'login'));
	const runtime =
		flow.draft_runtime_base_json ||
		(flow.compiled_plan && typeof flow.compiled_plan === 'object'
			? flow.compiled_plan
			: devFlowRuntime(flow.id, kind === 'registration' ? 'registration' : 'login', editor));
	const status = flow.status || (flow.is_active ? 'published' : 'disabled');
	return {
		...flow,
		slug: flow.slug || flow.id.replace(/^flow-/, ''),
		display_name: flow.display_name || flow.name,
		kind,
		status,
		draft_editor_json: editor,
		draft_runtime_base_json: { ...runtime, flow_id: flow.id, flow_kind: kind },
		published_version_id:
			flow.published_version_id || (status === 'published' ? `${flow.id}-version-1` : null),
		deleted_at: flow.deleted_at ?? null
	};
}

function flowToAdminFlow(flow: DevFlow) {
	const normalized = normalizeDevFlow(flow);
	return {
		id: normalized.id,
		tenant_id: normalized.tenant_id,
		slug: normalized.slug || normalized.id,
		name: normalized.name,
		display_name: normalized.display_name || normalized.name,
		description: normalized.description,
		kind: normalized.kind || 'login',
		status: normalized.status || 'draft',
		editor: normalized.draft_editor_json ?? null,
		runtime: normalized.draft_runtime_base_json ?? null,
		published_version_id: normalized.published_version_id ?? null,
		is_active: normalized.is_active,
		is_builtin: normalized.is_builtin,
		created_by: normalized.created_by,
		created_at: normalized.created_at,
		updated_by: normalized.updated_by,
		updated_at: normalized.updated_at
	};
}

function flowValidationOk() {
	return { valid: true, errors: [], warnings: [], issues: [] };
}

function flowAssignmentKey(
	targetType: DevFlowAssignment['target_type'],
	targetId: string | null,
	flowKind: DevFlowAssignment['flow_kind']
): string {
	return `${targetType}:${targetId || 'default'}:${flowKind}`;
}

function flowAssignmentToResponse(assignment: DevFlowAssignment) {
	return { ...assignment };
}

function flowExportPackage(flow: DevFlow) {
	const normalized = normalizeDevFlow(flow);
	return {
		schema_version: 'authrim.login_ui.contract.v1',
		mode: 'export',
		runtime: normalized.draft_runtime_base_json || {
			flow_id: normalized.id,
			flow_kind: normalized.kind || 'login',
			ui: { steps: [] }
		},
		preview: {
			flow_id: normalized.id,
			slug: normalized.slug || normalized.id,
			display_name: normalized.display_name || normalized.name
		},
		editor:
			normalized.draft_editor_json ||
			devFlowEditor(normalized.kind === 'registration' ? 'registration' : 'login')
	};
}

async function handleFlowAssignments(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	if (segments[0] !== 'flow-assignments') return null;
	const method = event.request.method;

	if (segments.length === 1 && method === 'GET') {
		const flowId = event.url.searchParams.get('flow_id');
		const targetType = event.url.searchParams.get('target_type');
		const targetId = event.url.searchParams.get('target_id');
		const assignments = [...flowAssignments.values()].filter((assignment) => {
			if (flowId && assignment.flow_id !== flowId) return false;
			if (targetType && assignment.target_type !== targetType) return false;
			if (targetId && assignment.target_id !== targetId) return false;
			return true;
		});
		return json({ assignments: assignments.map(flowAssignmentToResponse) });
	}

	if (segments.length === 1 && method === 'PUT') {
		const input = await readJson(event.request);
		const flowId = String(input.flow_id || '');
		const flow = flows.get(flowId);
		if (!flow)
			return json({ error: 'not_found', error_description: 'Dev mock Flow not found' }, 404);
		const normalized = normalizeDevFlow(flow);
		const flowKind = String(
			input.flow_kind || normalized.kind || 'login'
		) as DevFlowAssignment['flow_kind'];
		const targetType = String(input.target_type || 'tenant') as DevFlowAssignment['target_type'];
		const targetId = targetType === 'tenant' ? null : String(input.target_id || '');
		if (targetType !== 'tenant' && !targetId) {
			return json({ error: 'invalid_request', error_description: 'target_id is required' }, 400);
		}
		if (input.enabled !== false && normalized.status !== 'published') {
			return json(
				{
					error: 'invalid_request',
					error_description: 'Only published Flows can be enabled for runtime assignment'
				},
				400
			);
		}
		const key = flowAssignmentKey(targetType, targetId, flowKind);
		const now = Math.floor(Date.now() / 1000);
		const existing = flowAssignments.get(key);
		flowAssignments.set(key, {
			id: existing?.id || `flow-assignment-${flowAssignments.size + 1}`,
			tenant_id: TENANT_ID,
			target_type: targetType,
			target_id: targetId,
			flow_kind: flowKind,
			flow_id: flowId,
			enabled: input.enabled !== false,
			created_at: existing?.created_at || now,
			updated_at: now
		});
		return json({ success: true });
	}

	if (segments.length === 1 && method === 'DELETE') {
		const input = await readJson(event.request);
		const flowKind = String(input.flow_kind || 'login') as DevFlowAssignment['flow_kind'];
		const targetType = String(input.target_type || 'tenant') as DevFlowAssignment['target_type'];
		const targetId = targetType === 'tenant' ? null : String(input.target_id || '');
		if (targetType !== 'tenant' && !targetId) {
			return json({ error: 'invalid_request', error_description: 'target_id is required' }, 400);
		}
		flowAssignments.delete(flowAssignmentKey(targetType, targetId, flowKind));
		return json({ success: true });
	}

	return null;
}

async function handleFlows(event: RequestEvent, segments: string[]): Promise<Response | null> {
	const method = event.request.method;
	const assignmentResponse = await handleFlowAssignments(event, segments);
	if (assignmentResponse) return assignmentResponse;
	if (segments[0] !== 'flows') return null;

	if (segments.length === 1 && method === 'GET') {
		const profile = event.url.searchParams.get('profile_id');
		const active = event.url.searchParams.get('is_active');
		const kind = event.url.searchParams.get('kind');
		const status = event.url.searchParams.get('status');
		const search = (event.url.searchParams.get('search') || '').toLowerCase();
		const page = Math.max(1, Number(event.url.searchParams.get('page') || '1'));
		const limit = Math.max(1, Number(event.url.searchParams.get('limit') || '20'));
		const filtered = [...flows.values()].map(normalizeDevFlow).filter((flow) => {
			if (flow.deleted_at) return false;
			if (profile && flow.profile_id !== profile) return false;
			if (active === 'true' && !flow.is_active) return false;
			if (active === 'false' && flow.is_active) return false;
			if (kind && flow.kind !== kind) return false;
			if (status && flow.status !== status) return false;
			if (
				search &&
				!`${flow.name} ${flow.display_name || ''} ${flow.description || ''} ${flow.slug || ''}`
					.toLowerCase()
					.includes(search)
			) {
				return false;
			}
			return true;
		});
		const start = (page - 1) * limit;
		return json({
			flows: filtered.slice(start, start + limit).map(flowToAdminFlow),
			pagination: {
				page,
				limit,
				total: filtered.length,
				total_pages: Math.max(1, Math.ceil(filtered.length / limit))
			}
		});
	}

	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const flow = flowFromInput(input);
		flows.set(flow.id, flow);
		return json({ flow: flowToAdminFlow(flow), validation: flowValidationOk() }, 201);
	}

	if (segments[1] === 'node-types' && method === 'GET') {
		return json({
			node_types: [
				{ type: 'entry', label: 'Entry', runtime_component: 'interaction_context' },
				{ type: 'session_check', label: 'Session Check', runtime_component: 'session_check' },
				{
					type: 'registration',
					label: 'Registration',
					runtime_component: 'registration_method_selector'
				},
				{
					type: 'authentication',
					label: 'Authentication',
					runtime_component: 'authentication_method_selector'
				},
				{ type: 'profile_form', label: 'Profile Form', runtime_component: 'profile_form' },
				{ type: 'consent', label: 'Consent', runtime_component: 'consent_policy' },
				{ type: 'account_action', label: 'Account Action', runtime_component: 'account_action' },
				{ type: 'complete', label: 'Complete', runtime_component: 'completion' },
				{ type: 'condition', label: 'Condition', runtime_component: 'condition' }
			]
		});
	}

	if (segments[1] === 'import' && method === 'POST') {
		const input = await readJson(event.request);
		const runtime =
			input.runtime && typeof input.runtime === 'object' && !Array.isArray(input.runtime)
				? (input.runtime as Record<string, unknown>)
				: { flow_kind: 'login', ui: { steps: [] } };
		const preview =
			input.preview && typeof input.preview === 'object' && !Array.isArray(input.preview)
				? (input.preview as Record<string, unknown>)
				: {};
		const flowKind = runtime.flow_kind === 'registration' ? 'registration' : 'login';
		const imported = flowFromInput({
			display_name:
				typeof preview.display_name === 'string' ? preview.display_name : 'Imported Flow',
			slug: typeof preview.slug === 'string' ? preview.slug : undefined,
			kind: flowKind,
			editor: input.editor,
			runtime
		});
		flows.set(imported.id, imported);
		return json({ flow_id: imported.id, validation: flowValidationOk() }, 201);
	}

	const flowId = segments[1];
	const flow = flows.get(flowId);
	if (!flow) {
		return json({ error: 'not_found', error_description: 'Dev mock flow not found' }, 404);
	}

	if (segments.length === 2 && method === 'GET') {
		const assignments = [...flowAssignments.values()].filter(
			(assignment) => assignment.flow_id === flowId
		);
		return json({
			flow: flowToAdminFlow(flow),
			assignments: assignments.map(flowAssignmentToResponse)
		});
	}

	if (segments.length === 2 && (method === 'PUT' || method === 'PATCH')) {
		const input = await readJson(event.request);
		const updated = flowFromInput(input, flow);
		flows.set(flowId, updated);
		return json({ flow: flowToAdminFlow(updated) });
	}

	if (segments.length === 2 && method === 'DELETE') {
		if (normalizeDevFlow(flow).status === 'published') {
			return json(
				{ error: 'conflict', error_description: 'Published Flows cannot be deleted' },
				409
			);
		}
		flows.delete(flowId);
		return json({ success: true });
	}

	if (segments[2] === 'copy' && method === 'POST') {
		const input = await readJson(event.request);
		const copied = flowFromInput({
			...flow,
			display_name: input.display_name || input.name || `${flow.name} Copy`,
			slug: input.slug
		});
		flows.set(copied.id, copied);
		return json({ success: true, flow_id: copied.id }, 201);
	}

	if (segments[2] === 'compile' && method === 'POST') {
		const compiled = {
			id: `${flow.id}-compiled`,
			version: flow.version,
			nodeCount: flow.graph_definition?.nodes.length || 0,
			compiledAt: new Date().toISOString()
		};
		flows.set(flowId, {
			...flow,
			compiled_plan: compiled,
			updated_at: Math.floor(Date.now() / 1000)
		});
		return json({ success: true, compiled_plan: compiled });
	}

	if (segments[2] === 'validate' && method === 'POST') {
		return json(flowValidationOk());
	}

	if (segments[2] === 'publish' && method === 'POST') {
		const normalized = normalizeDevFlow(flow);
		const now = Math.floor(Date.now() / 1000);
		const versions = flowVersions.get(flowId) || [];
		const versionNumber = versions.length + 1;
		const version: DevFlowVersion = {
			id: `${flowId}-version-${versionNumber}`,
			tenant_id: TENANT_ID,
			flow_id: flowId,
			version_number: versionNumber,
			schema_version: 'authrim.login_ui.contract.v1',
			runtime_snapshot: normalized.draft_runtime_base_json || {},
			editor_snapshot: normalized.draft_editor_json || null,
			validation_result: flowValidationOk(),
			published_by: 'dev-admin',
			published_at: now,
			created_at: now
		};
		flowVersions.set(flowId, [version, ...versions]);
		flows.set(flowId, {
			...normalized,
			status: 'published',
			is_active: true,
			published_version_id: version.id,
			updated_at: now
		});
		return json({
			version: {
				id: version.id,
				version_number: version.version_number,
				flow_id: version.flow_id,
				schema_version: version.schema_version,
				published_at: version.published_at
			},
			validation: flowValidationOk()
		});
	}

	if (segments[2] === 'versions' && method === 'GET') {
		return json({
			versions: (flowVersions.get(flowId) || []).map((version) => ({
				id: version.id,
				tenant_id: version.tenant_id,
				flow_id: version.flow_id,
				version_number: version.version_number,
				schema_version: version.schema_version,
				runtime_snapshot: version.runtime_snapshot,
				editor_snapshot: version.editor_snapshot,
				validation_result: version.validation_result,
				published_by: version.published_by,
				published_at: version.published_at,
				created_at: version.created_at
			}))
		});
	}

	if (segments[2] === 'export' && method === 'GET') {
		return json(flowExportPackage(flow));
	}

	return null;
}

function sampleProtocolSchemas() {
	return [
		{
			id: 'schema-oidc-core',
			tenantId: TENANT_ID,
			protocol: 'oidc',
			schemaKey: 'oidc-core',
			displayName: 'OIDC Core Claims',
			versionLabel: 'v1',
			schemaVersion: '1.0',
			lifecycleState: 'active',
			schema: {
				fields: [
					{ key: 'email', label: 'email', namespace: 'oidc.claim', valueType: 'string' },
					{ key: 'name', label: 'name', namespace: 'oidc.claim', valueType: 'string' }
				]
			}
		},
		{
			id: 'schema-saml-gakunin',
			tenantId: TENANT_ID,
			protocol: 'saml',
			schemaKey: 'saml-gakunin',
			displayName: 'SAML GakuNin Attributes',
			versionLabel: 'v1',
			schemaVersion: '1.0',
			lifecycleState: 'active',
			schema: {
				fields: [
					{
						key: 'urn:oid:0.9.2342.19200300.100.1.3',
						label: 'mail',
						namespace: 'saml.attribute',
						valueType: 'string'
					},
					{
						key: 'urn:oid:2.5.4.3',
						label: 'cn',
						namespace: 'saml.attribute',
						valueType: 'string'
					}
				]
			}
		}
	];
}

function sampleDestinationProfiles() {
	return [
		{
			id: 'destination-profile-oidc-core',
			tenantId: TENANT_ID,
			destinationType: 'oidc',
			profileKey: 'oidc-core',
			displayName: 'OIDC Core Claims',
			ownerScopeType: 'tenant',
			ownerScopeId: TENANT_ID,
			lifecycleState: 'active',
			activeVersionId: 'destination-profile-version-oidc-core',
			version: {
				id: 'destination-profile-version-oidc-core',
				versionLabel: 'v1',
				lifecycleState: 'active',
				schema: { fields: ['email', 'name'] }
			}
		},
		{
			id: 'destination-profile-saml-sp',
			tenantId: TENANT_ID,
			destinationType: 'saml',
			profileKey: 'saml-sp-gakunin',
			displayName: 'SAML SP GakuNin Attribute Release',
			ownerScopeType: 'tenant',
			ownerScopeId: TENANT_ID,
			lifecycleState: 'active',
			activeVersionId: 'destination-profile-version-saml-sp',
			version: {
				id: 'destination-profile-version-saml-sp',
				versionLabel: 'v1',
				lifecycleState: 'active',
				schema: { fields: ['urn:oid:0.9.2342.19200300.100.1.3', 'urn:oid:2.5.4.3'] }
			}
		}
	];
}

function handleIdentityMapping(event: RequestEvent, segments: string[]): Response | null {
	const method = event.request.method;
	if (segments[0] === 'field-mapping-sets' && method === 'GET' && segments.length === 1) {
		return json({ fieldMappingSets });
	}
	if (segments[0] === 'field-mapping-sets' && method === 'POST' && segments.length === 1) {
		return json({
			result: {
				id: `field-mapping-dev-${fieldMappingSets.length + 1}`,
				tenantId: TENANT_ID,
				fieldMappingKey: 'dev-created-field-mapping',
				displayName: 'Dev created field mapping set',
				lifecycleState: 'draft',
				createdAt: Date.now(),
				updatedAt: Date.now()
			}
		});
	}
	if (segments[0] === 'field-mapping-sets' && segments[2] === 'versions' && method === 'GET') {
		return json({
			fieldMappingVersions: fieldMappingVersions.filter(
				(version) => version.fieldMappingSetId === segments[1]
			)
		});
	}
	if (segments[0] === 'field-mapping-sets' && segments[2] === 'versions' && method === 'POST') {
		return json({
			result: {
				id: `field-mapping-version-dev-${Date.now()}`,
				tenantId: TENANT_ID,
				fieldMappingSetId: segments[1],
				lifecycleState: 'draft'
			}
		});
	}
	if (segments[0] === 'field-mapping-sets' && method === 'DELETE') {
		return json({ success: true });
	}
	if (segments[0] === 'field-mapping-sets' && method === 'POST') {
		return json({ success: true, snapshotId: 'snapshot-gakunin-basic-v1' });
	}
	if (segments[0] === 'catalogs') {
		return json({
			catalogs: [
				{
					id: 'catalog-core',
					tenantId: TENANT_ID,
					catalogKey: 'authrim-core',
					displayName: 'Authrim Core Profile',
					versionId: 'catalog-version-core-v1',
					versionLabel: 'v1',
					lifecycleState: 'active',
					bundleHash: 'dev',
					entries: catalogEntries
				}
			]
		});
	}
	if (segments[0] === 'protocol-schemas') return json({ protocolSchemas: sampleProtocolSchemas() });
	if (segments[0] === 'external-schemas') return json({ externalSchemas: [] });
	if (segments[0] === 'source-profiles') {
		if (segments[1] === 'csv' && segments[2] === 'parse') {
			return json({
				result: {
					parseDraftId: 'parse-draft-dev',
					tenantId: TENANT_ID,
					sourceType: 'csv',
					schemaHash: 'dev',
					schema: { sourceType: 'csv', columns: [] },
					parserOptions: {},
					warningSummary: {},
					expiresAt: Date.now() + 3600000
				}
			});
		}
		return json({
			sourceProfiles: [
				{
					id: 'source-profile-gakunin-saml',
					tenantId: TENANT_ID,
					sourceType: 'csv',
					profileKey: 'gakunin-saml',
					displayName: 'GakuNin SAML Source',
					lifecycleState: 'active',
					activeVersionId: 'source-profile-version-gakunin-saml',
					version: {
						id: 'source-profile-version-gakunin-saml',
						versionLabel: 'v1',
						lifecycleState: 'active',
						schema: { sourceType: 'csv', columns: [] }
					}
				}
			]
		});
	}
	if (segments[0] === 'destination-profiles') {
		return json({ destinationProfiles: sampleDestinationProfiles() });
	}
	if (segments[0] === 'attribute-groups') return json({ attributeGroups: [] });
	if (segments[0] === 'attribute-fields') return json({ attributeFields: [] });
	if (segments[0] === 'templates') return json({ templates: [] });
	if (segments[0] === 'federation-trust-sources') {
		if (segments.length > 2 && segments[2] === 'metadata-documents') {
			return json({ federationMetadataDocuments: [] });
		}
		return json({ federationTrustSources: [] });
	}
	if (segments[0] === 'review-tasks') return json({ reviewTasks: [] });
	if (segments[0] === 'schema-readiness') {
		return json({
			rows: [],
			summary: { total: 0, pass: 0, attention: 0, blocked: 0, deferred: 0 }
		});
	}
	return null;
}

async function handleCustomClaims(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	if (segments[0] !== 'custom-claims') return null;
	const method = event.request.method.toUpperCase();
	const tail = segments.slice(1);

	if (tail[0] === 'stats') {
		return json({
			total: customClaimSchemas.length,
			active_non_pii: customClaimSchemas.filter((schema) => schema.is_active && !schema.is_pii)
				.length,
			active_pii: customClaimSchemas.filter((schema) => schema.is_active && schema.is_pii).length,
			non_pii_users_with_data: 42,
			pii_users_with_data: 17,
			error_count: customClaimSchemas.filter((schema) => schema.operation_status === 'error').length
		});
	}

	if (tail[0] === 'presets') {
		if (tail[1] === 'apply') {
			return json({ created_field_keys: [], skipped_field_keys: [], errors: [] });
		}
		return json({
			presets: [
				{
					id: 'dev-standard-profile',
					label: 'Standard profile',
					description: 'Dev mock preset for common profile claims.',
					fields: [
						{
							field_key: 'department',
							display_label: 'Department',
							field_type: 'string',
							is_pii: false,
							description: 'Department name'
						}
					]
				}
			],
			existing_field_keys: customClaimSchemas.map((schema) => schema.field_key)
		});
	}

	if (tail[0] === 'reserved-names') {
		return json({ reserved_names: ['sub', 'iss', 'aud', 'exp', 'iat'] });
	}

	if (tail.length === 0) {
		if (method === 'POST') {
			const body = await readJson(event.request);
			const created = {
				...customClaimSchemas[0],
				id: `dev-claim-${Date.now()}`,
				field_key: String(body.field_key ?? 'new_claim'),
				display_label: String(body.display_label ?? 'New Claim'),
				is_system: false,
				created_at: Math.floor(Date.now() / 1000),
				updated_at: Math.floor(Date.now() / 1000)
			};
			return json({ schema: created }, 201);
		}
		return json({
			schemas: customClaimSchemas,
			pagination: {
				page: 1,
				limit: 20,
				total: customClaimSchemas.length,
				total_pages: 1
			}
		});
	}

	const schema = customClaimSchemas.find((candidate) => candidate.id === tail[0]);
	if (!schema) return json({ error: 'not_found' }, 404);

	if (tail[1] === 'rename') {
		const body = await readJson(event.request);
		return json({
			schema: {
				...schema,
				field_key: String(body.new_field_key ?? schema.field_key),
				updated_at: Math.floor(Date.now() / 1000)
			}
		});
	}
	if (tail[1] === 'retry') return json({ success: true, action: 'retry', schema });
	if (method === 'DELETE') return json({ success: true });
	if (method === 'PUT' || method === 'PATCH') {
		const body = await readJson(event.request);
		return json({ schema: { ...schema, ...body, updated_at: Math.floor(Date.now() / 1000) } });
	}

	return json({
		schema,
		user_count: schema.user_count,
		user_count_approximate: schema.user_count_approximate
	});
}

async function handleClients(event: RequestEvent, segments: string[]): Promise<Response | null> {
	const method = event.request.method;
	if (segments.length === 1 && method === 'GET') return json(listClients());
	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const id = createClientId(input.client_name);
		const client: DevClient = {
			client_id: id,
			client_name: String(input.client_name || id),
			description: typeof input.description === 'string' ? input.description : null,
			grant_types: Array.isArray(input.grant_types) ? input.grant_types.map(String) : [],
			response_types: Array.isArray(input.response_types)
				? input.response_types.map(String)
				: ['code'],
			redirect_uris: Array.isArray(input.redirect_uris) ? input.redirect_uris.map(String) : [],
			token_endpoint_auth_method: String(input.token_endpoint_auth_method || 'none'),
			scope: typeof input.scope === 'string' ? input.scope : 'openid profile email',
			identity_mapping:
				input.identity_mapping && typeof input.identity_mapping === 'object'
					? (input.identity_mapping as Record<string, unknown>)
					: null,
			created_at: Date.now(),
			updated_at: Date.now(),
			...input
		} as DevClient;
		clients.set(id, client);
		return json({ client }, 201);
	}

	const clientId = segments[1];
	const client = clients.get(clientId);
	if (!client)
		return json({ error: 'not_found', error_description: 'Dev mock client not found' }, 404);
	if (segments.length === 2 && method === 'GET') return json({ client });
	if (segments.length === 2 && method === 'PUT') {
		const input = await readJson(event.request);
		const updated = mergeClient(client, input);
		clients.set(clientId, updated);
		return json({ client: updated });
	}
	if (segments.length === 2 && method === 'DELETE') {
		clients.delete(clientId);
		return json({ success: true });
	}
	if (segments[2] === 'usage') {
		return json({
			tokens_issued_24h: 0,
			tokens_issued_7d: 0,
			tokens_issued_30d: 0,
			active_sessions: 0,
			last_token_issued_at: null
		});
	}
	if (segments[2] === 'regenerate-secret' && method === 'POST') {
		return json({ client_secret: 'dev_mock_secret' });
	}
	if (segments[2] === 'apply-preset' && method === 'POST') {
		return json(mergeClient(client, { updated_at: Date.now() }));
	}
	if (segments[2] === 'cache-mode') return json(devClientCacheModeResponse(clientId));
	if (segments[2] === 'consent-overrides') return json({ overrides: [] });
	return null;
}

function stringValue(input: unknown, fallback = ''): string {
	return typeof input === 'string' ? input : fallback;
}

function booleanValue(input: unknown, fallback: boolean): boolean {
	return typeof input === 'boolean' ? input : fallback;
}

function numberValue(input: unknown, fallback: number): number {
	return typeof input === 'number' && Number.isFinite(input) ? input : fallback;
}

function externalProviderFromInput(
	input: Record<string, unknown>,
	existing?: DevExternalIdPProvider
): DevExternalIdPProvider {
	const fallbackName = existing?.name || 'Dev External Provider';
	const slug = stringValue(
		input.slug,
		existing?.slug || fallbackName.toLowerCase().replace(/\s+/g, '-')
	);
	const id = existing?.id || `dev-${slug || externalIdPProviders.size + 1}`;
	const providerTypeInput = stringValue(input.provider_type, existing?.providerType || 'oidc');
	const now = Date.now();

	return {
		id,
		slug,
		tenantId: existing?.tenantId || TENANT_ID,
		name: stringValue(input.name, fallbackName),
		providerType: providerTypeInput === 'oauth2' ? 'oauth2' : 'oidc',
		enabled: booleanValue(input.enabled, existing?.enabled ?? true),
		priority: numberValue(input.priority, existing?.priority ?? 0),
		issuer: stringValue(input.issuer, existing?.issuer || '') || undefined,
		clientId: stringValue(input.client_id, existing?.clientId || 'dev-client'),
		hasSecret: Boolean(existing?.hasSecret || input.client_secret),
		authorizationEndpoint:
			stringValue(input.authorization_endpoint, existing?.authorizationEndpoint || '') || undefined,
		tokenEndpoint: stringValue(input.token_endpoint, existing?.tokenEndpoint || '') || undefined,
		userinfoEndpoint:
			stringValue(input.userinfo_endpoint, existing?.userinfoEndpoint || '') || undefined,
		jwksUri: stringValue(input.jwks_uri, existing?.jwksUri || '') || undefined,
		scopes: stringValue(input.scopes, existing?.scopes || 'openid email profile'),
		attributeMapping: existing?.attributeMapping || {},
		autoLinkEmail: booleanValue(input.auto_link_email, existing?.autoLinkEmail ?? true),
		jitProvisioning: booleanValue(input.jit_provisioning, existing?.jitProvisioning ?? true),
		requireEmailVerified: booleanValue(
			input.require_email_verified,
			existing?.requireEmailVerified ?? true
		),
		alwaysFetchUserinfo: booleanValue(
			input.always_fetch_userinfo,
			existing?.alwaysFetchUserinfo ?? false
		),
		enableSso: booleanValue(input.enable_sso, existing?.enableSso ?? true),
		iconUrl: stringValue(input.icon_url, existing?.iconUrl || '') || undefined,
		iconName: stringValue(input.icon_name, existing?.iconName || '') || undefined,
		buttonColor: stringValue(input.button_color, existing?.buttonColor || '') || undefined,
		buttonColorDark:
			stringValue(input.button_color_dark, existing?.buttonColorDark || '') || undefined,
		buttonText: stringValue(input.button_text, existing?.buttonText || '') || undefined,
		createdAt: existing?.createdAt || now,
		updatedAt: now
	};
}

async function handleExternalProviders(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'external-providers') return null;

	if (segments[1] === 'discover-oidc' && method === 'POST') {
		const input = await readJson(event.request);
		const issuer = stringValue(input.url, 'https://accounts.google.com').replace(
			/\/\.well-known\/openid-configuration$/,
			''
		);
		return json({
			issuer,
			authorization_endpoint: `${issuer}/oauth2/v2/auth`,
			token_endpoint: `${issuer}/oauth2/token`,
			userinfo_endpoint: `${issuer}/openid/userinfo`,
			jwks_uri: `${issuer}/oauth2/certs`,
			scopes_supported: ['openid', 'email', 'profile']
		});
	}

	if (segments.length === 1 && method === 'GET') {
		return json({ providers: [...externalIdPProviders.values()] });
	}
	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const provider = externalProviderFromInput(input);
		externalIdPProviders.set(provider.id, provider);
		return json(provider, 201);
	}

	const providerId = segments[1];
	const provider = externalIdPProviders.get(providerId);
	if (!provider) {
		return json(
			{ error: 'not_found', error_description: 'Dev mock external provider not found' },
			404
		);
	}
	if (segments.length === 2 && method === 'GET') return json(provider);
	if (segments.length === 2 && method === 'PUT') {
		const input = await readJson(event.request);
		const updated = externalProviderFromInput(input, provider);
		externalIdPProviders.set(providerId, updated);
		return json(updated);
	}
	if (segments.length === 2 && method === 'DELETE') {
		externalIdPProviders.delete(providerId);
		return json({ success: true });
	}
	return null;
}

function buildTenantInfo(origin: string) {
	const apiBase = `${origin}/api/admin`;
	return {
		tenant_id: TENANT_ID,
		tenant_name: 'Dev Tenant',
		issuer: origin,
		components: {
			login_ui: true,
			admin_ui: true,
			saml: true,
			async: true,
			vc: false
		},
		login_ui_url: `${origin}/login`,
		global_login_ui_url: `${origin}/login`,
		discover_url: `${origin}/discover`,
		admin_ui_url: `${origin}/admin`,
		api_url: apiBase,
		well_known: {
			openid_configuration: `${origin}/.well-known/openid-configuration`,
			oauth_authorization_server: `${origin}/.well-known/oauth-authorization-server`,
			jwks: `${origin}/.well-known/jwks.json`,
			webfinger: `${origin}/.well-known/webfinger`
		},
		oidc: {
			authorization: `${origin}/oauth/authorize`,
			token: `${origin}/oauth/token`,
			userinfo: `${origin}/oauth/userinfo`,
			introspection: `${origin}/oauth/introspect`,
			revocation: `${origin}/oauth/revoke`,
			end_session: `${origin}/oauth/logout`
		},
		oauth_extensions: {
			device_authorization: `${origin}/oauth/device_authorization`,
			pushed_authorization_request: `${origin}/oauth/par`,
			dynamic_client_registration: `${origin}/oauth/register`
		},
		saml: {
			sso: `${origin}/saml/sso`,
			idp_metadata: `${apiBase}/saml-metadata-documents/idp`,
			sp_metadata: `${apiBase}/saml-metadata-documents/sp`,
			metadata: `${apiBase}/saml-metadata-documents/sp`,
			acs: `${origin}/saml/acs`,
			slo: `${origin}/saml/slo`
		},
		vc: {
			credential_issuer_metadata: `${origin}/.well-known/openid-credential-issuer`,
			credential: `${origin}/credential`,
			batch_credential: `${origin}/credential/batch`,
			deferred_credential: `${origin}/credential/deferred`,
			vp_token_request: `${origin}/vp/token-request`
		},
		ciba: {
			backchannel_authentication: `${origin}/oauth/backchannel`
		},
		scim: {
			base: `${origin}/scim/v2`,
			users: `${origin}/scim/v2/Users`,
			groups: `${origin}/scim/v2/Groups`,
			service_provider_config: `${origin}/scim/v2/ServiceProviderConfig`
		},
		admin_api: {
			base: apiBase,
			users: `${apiBase}/users`,
			clients: `${apiBase}/clients`,
			sessions: `${apiBase}/sessions`,
			audit_logs: `${apiBase}/audit-logs`,
			settings: `${apiBase}/settings`,
			tenants: `${apiBase}/tenants`,
			custom_claims: `${apiBase}/custom-claims`,
			organizations: `${apiBase}/organizations`,
			roles: `${apiBase}/roles`,
			webhooks: `${apiBase}/webhooks`
		}
	};
}

function buildSamlMetadataDocument(origin: string, role: 'idp' | 'sp') {
	const entityId = `${origin}/saml/${role}`;
	const descriptor =
		role === 'idp'
			? `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
		<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${origin}/saml/sso"/>
		<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${origin}/saml/slo"/>
	</md:IDPSSODescriptor>`
			: `<md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
		<md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${origin}/saml/acs" index="0"/>
		<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${origin}/saml/slo"/>
	</md:SPSSODescriptor>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
	${descriptor}
</md:EntityDescriptor>`;
}

async function handleSamlProviders(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] === 'saml-metadata-documents') {
		const role = segments[1] === 'sp' ? 'sp' : 'idp';
		return xml(buildSamlMetadataDocument(event.url.origin, role));
	}
	if (segments[0] === 'saml-settings') {
		return json({
			tenantId: TENANT_ID,
			entityIdStyle: 'role_url',
			interactiveLoginUrlPolicy: 'tenant_host',
			certificateSubject: {
				countryName: 'JP',
				stateOrProvinceName: 'Tokyo',
				localityName: 'Shinagawa',
				organizationName: 'Authrim',
				organizationalUnitName: 'Security',
				commonName: 'localhost'
			},
			certificateSubjectAlternativeNames: {
				includeGeneratedDnsNames: true,
				dnsNames: ['localhost']
			},
			metadata: {
				signingMode: 'enabled',
				signingEnabled: true,
				validUntilEnabled: true,
				idpValidUntil: new Date(NOW + 86400000).toISOString(),
				spValidUntil: new Date(NOW + 86400000).toISOString(),
				validityDays: 7,
				cacheDuration: 'PT1H'
			},
			generated: {
				issuerUrl: 'http://localhost:8787',
				idpEntityId: 'http://localhost:8787/saml/idp/metadata',
				spEntityId: 'http://localhost:8787/saml/sp/metadata',
				idpMetadataUrl: 'http://localhost:8787/saml/idp/metadata',
				spMetadataUrl: 'http://localhost:8787/saml/sp/metadata'
			},
			localSigning: {
				certificateSubject: {
					countryName: 'JP',
					stateOrProvinceName: 'Tokyo',
					localityName: 'Shinagawa',
					organizationName: 'Authrim',
					organizationalUnitName: 'Security',
					commonName: 'localhost'
				},
				certificateSubjectAlternativeNames: {
					includeGeneratedDnsNames: true,
					dnsNames: ['localhost']
				},
				idpSigningKeyPolicy: {
					scope: 'tenant_role',
					metadataCertificatePublication: 'active_next_backup',
					active: {
						slot: 'active',
						kid: 'dev-saml-idp-active-2026-06',
						keyRef: 'secret:saml/idp/active',
						state: 'active',
						validFrom: NOW - 86400000 * 30,
						validTo: NOW + 86400000 * 330,
						publicKeyAlgorithm: 'RSA',
						publicKeySizeBits: 2048,
						subjectAlternativeNames: { dnsNames: ['localhost'] }
					},
					next: {
						slot: 'next',
						kid: 'dev-saml-idp-next-2026-09',
						keyRef: 'secret:saml/idp/next',
						state: 'prepared',
						metadataPublishFrom: NOW + 86400000 * 30,
						plannedActivationAt: NOW + 86400000 * 90,
						validFrom: NOW + 86400000 * 60,
						validTo: NOW + 86400000 * 420,
						publicKeyAlgorithm: 'RSA',
						publicKeySizeBits: 2048,
						subjectAlternativeNames: { dnsNames: ['localhost'] }
					},
					backup: {
						slot: 'backup',
						kid: 'dev-saml-idp-backup-2026-03',
						keyRef: 'secret:saml/idp/backup',
						state: 'retained',
						validFrom: NOW - 86400000 * 120,
						validTo: NOW + 86400000 * 240,
						publicKeyAlgorithm: 'RSA',
						publicKeySizeBits: 2048,
						subjectAlternativeNames: { dnsNames: ['localhost'] }
					}
				},
				spSigningKeyPolicy: {
					scope: 'tenant_role',
					metadataCertificatePublication: 'active_next',
					active: {
						slot: 'active',
						kid: 'dev-saml-sp-active-2026-06',
						keyRef: 'secret:saml/sp/active',
						state: 'active',
						validFrom: NOW - 86400000 * 20,
						validTo: NOW + 86400000 * 340,
						publicKeyAlgorithm: 'RSA',
						publicKeySizeBits: 2048,
						subjectAlternativeNames: { dnsNames: ['localhost'] }
					},
					next: {
						slot: 'next',
						kid: 'dev-saml-sp-next-2026-09',
						keyRef: 'secret:saml/sp/next',
						state: 'prepared',
						metadataPublishFrom: NOW + 86400000 * 30,
						plannedActivationAt: NOW + 86400000 * 90,
						validFrom: NOW + 86400000 * 70,
						validTo: NOW + 86400000 * 430,
						publicKeyAlgorithm: 'RSA',
						publicKeySizeBits: 2048,
						subjectAlternativeNames: { dnsNames: ['localhost'] }
					}
				}
			}
		});
	}
	if (segments[0] === 'saml-attribute-presets') {
		return json({
			presets: [
				{
					id: 'gakunin-basic',
					version: 'v1',
					profile: 'gakunin',
					label: 'GakuNin basic',
					description: 'Dev mock GakuNin attribute preset',
					stability: 'stable',
					applicationMode: 'replace',
					appliesTo: 'sp_attribute_release',
					attributeReleasePolicy: { attributes: [] }
				}
			]
		});
	}
	if (segments[0] === 'saml-metadata') {
		return json({ kind: 'single', providerType: 'saml_sp', config: {} });
	}
	if (segments[0] !== 'saml-providers') return null;
	if (segments.length === 1 && method === 'GET')
		return json({ providers: [...samlProviders.values()] });
	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const id = `dev-saml-${samlProviders.size + 1}`;
		const provider: DevSamlProvider = {
			id,
			name: String(input.name || id),
			providerType: input.providerType === 'saml_idp' ? 'saml_idp' : 'saml_sp',
			config:
				input.config && typeof input.config === 'object'
					? (input.config as Record<string, unknown>)
					: {},
			enabled: input.enabled !== false,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		};
		samlProviders.set(id, provider);
		return json(provider, 201);
	}

	const providerId = segments[1];
	const provider = samlProviders.get(providerId);
	if (!provider) {
		return json({ error: 'not_found', error_description: 'Dev mock SAML provider not found' }, 404);
	}
	if (segments.length === 2 && method === 'GET') return json(provider);
	if (segments.length === 2 && method === 'PUT') {
		const input = await readJson(event.request);
		const updated = {
			...provider,
			name: typeof input.name === 'string' ? input.name : provider.name,
			enabled: typeof input.enabled === 'boolean' ? input.enabled : provider.enabled,
			config:
				input.config && typeof input.config === 'object'
					? (input.config as Record<string, unknown>)
					: provider.config,
			updatedAt: new Date().toISOString()
		};
		samlProviders.set(providerId, updated);
		return json(updated);
	}
	if (segments.length === 2 && method === 'DELETE') {
		samlProviders.delete(providerId);
		return json({ success: true });
	}
	if (segments.length > 2 && method === 'POST') return json(provider);
	return null;
}

function normalizeDevDirectoryConnector(input: unknown, index: number): DevDirectoryConnector {
	const record = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
	const value = record as Record<string, unknown>;
	const timeoutRecord =
		value.timeouts && typeof value.timeouts === 'object' && !Array.isArray(value.timeouts)
			? (value.timeouts as Record<string, unknown>)
			: {};
	const requestMs = Number(timeoutRecord.request_ms);
	const relayRecord =
		value.relay && typeof value.relay === 'object' && !Array.isArray(value.relay)
			? (value.relay as Record<string, unknown>)
			: {};
	const heartbeatRecord =
		value.heartbeat && typeof value.heartbeat === 'object' && !Array.isArray(value.heartbeat)
			? (value.heartbeat as Record<string, unknown>)
			: {};
	return {
		id: stringValue(value.id, index === 0 ? 'campus' : `campus-${index + 1}`),
		transport: stringValue(value.transport, 'relay') === 'direct' ? 'direct' : 'relay',
		endpoint_url: stringValue(value.endpoint_url, 'http://localhost:8080'),
		auth_mode: 'hmac',
		connector_id: stringValue(value.connector_id, 'wwcon_8K4M2Q9F7D3H6P1X'),
		key_id: stringValue(value.key_id, 'kid-active'),
		secret_ref: stringValue(value.secret_ref, 'env:WORDWARDEN_SECRET'),
		timeouts: {
			request_ms: Number.isInteger(requestMs) ? requestMs : 2500
		},
		relay: {
			verify_timeout_ms: numberValue(relayRecord.verify_timeout_ms, 5000),
			max_pending_requests: numberValue(relayRecord.max_pending_requests, 16),
			challenge_ttl_ms: numberValue(relayRecord.challenge_ttl_ms, 30000),
			auth_failure_rate_limit_per_minute: numberValue(
				relayRecord.auth_failure_rate_limit_per_minute,
				10
			),
			auth_failure_block_ms: numberValue(relayRecord.auth_failure_block_ms, 300000),
			secret_rotation_grace_ms: numberValue(relayRecord.secret_rotation_grace_ms, 300000)
		},
		heartbeat: {
			key_id: stringValue(heartbeatRecord.key_id, ''),
			secret_ref: stringValue(heartbeatRecord.secret_ref, ''),
			previous_key_id: stringValue(heartbeatRecord.previous_key_id, ''),
			previous_secret_ref: stringValue(heartbeatRecord.previous_secret_ref, ''),
			interval_ms: numberValue(heartbeatRecord.interval_ms, 300000),
			stale_after_ms: numberValue(heartbeatRecord.stale_after_ms, 900000),
			retention_days: numberValue(heartbeatRecord.retention_days, 14),
			version_mismatch_policy:
				stringValue(heartbeatRecord.version_mismatch_policy, 'warn') === 'block' ? 'block' : 'warn',
			expected_version: stringValue(heartbeatRecord.expected_version, ''),
			minimum_version: stringValue(heartbeatRecord.minimum_version, ''),
			unhealthy_threshold: numberValue(heartbeatRecord.unhealthy_threshold, 1),
			stale_detection_grace_ms: numberValue(heartbeatRecord.stale_detection_grace_ms, 0)
		},
		attribute_names: Array.isArray(value.attribute_names)
			? [
					...new Set(
						value.attribute_names
							.map(String)
							.map((item) => item.trim())
							.filter(Boolean)
					)
				]
			: []
	};
}

function ensureDevDirectoryAuth(tenantId: string) {
	if (!directoryAuthCampaigns.has(tenantId)) {
		directoryAuthCampaigns.set(tenantId, [
			{
				id: 'damc_template',
				tenant_id: tenantId,
				name: 'Default passwordless migration template',
				description: 'Disabled template for an explicit passwordless migration campaign.',
				status: 'disabled',
				mode: 'grace_then_require_passkey',
				passkey_prompt_mode: 'campaign_only',
				email_code_fallback_mode: 'tenant_default',
				grace_period_days: 30,
				transaction_ttl_seconds: 600,
				enforcement_start_mode: 'first_directory_login',
				target_policy: { type: 'template', assignments: [] },
				is_template: 1,
				created_by: 'dev-admin',
				created_at: Date.now(),
				updated_at: Date.now()
			}
		]);
	}
	if (!directoryAuthTenantPolicies.has(tenantId)) {
		directoryAuthTenantPolicies.set(tenantId, {
			tenant_id: tenantId,
			email_code_fallback_mode: 'migration_recovery',
			updated_by: 'dev-admin',
			created_at: Date.now(),
			updated_at: Date.now()
		});
	}
	if (!directoryAuthUserStates.has(tenantId)) directoryAuthUserStates.set(tenantId, []);
	if (!directoryAuthConfigHistory.has(tenantId)) directoryAuthConfigHistory.set(tenantId, []);
	if (!directoryAuthRetentionPolicies.has(tenantId)) {
		directoryAuthRetentionPolicies.set(tenantId, {
			tenant_id: tenantId,
			authrim_audit_retention_days: 365,
			wordwarden_local_retention_days: 14,
			artifact_delete_grace_hours: 72,
			updated_by: 'dev-admin',
			created_at: Date.now(),
			updated_at: Date.now()
		});
	}
	if (!directoryAuthEvidenceExports.has(tenantId)) directoryAuthEvidenceExports.set(tenantId, []);
	if (!directoryAuthSupportBundles.has(tenantId)) directoryAuthSupportBundles.set(tenantId, []);
}

function devDirectoryAuthSummaryLinks(tenantId: string) {
	return [
		{
			label: 'Public compliance summary',
			href: '/docs/directory-authentication-public-summary'
		},
		{
			label: 'Migration summary',
			href: `/admin/directory-authentication/migration?tenant_id=${encodeURIComponent(tenantId)}`
		},
		{
			label: 'Fleet summary',
			href: `/admin/directory-authentication/fleet?tenant_id=${encodeURIComponent(tenantId)}`
		}
	];
}

function serializeDevDirectoryAuthCampaign(
	campaign: DevDirectoryAuthCampaign,
	policy: DevDirectoryAuthTenantPolicy
) {
	return {
		...campaign,
		effective_email_code_fallback_mode:
			campaign.email_code_fallback_mode === 'tenant_default'
				? policy.email_code_fallback_mode
				: campaign.email_code_fallback_mode
	};
}

async function handleDirectoryAuth(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'tenants' || segments[2] !== 'directory-auth') return null;

	const tenantId = segments[1] || getTenantId(event);
	ensureDevDirectoryAuth(tenantId);
	const campaigns = directoryAuthCampaigns.get(tenantId) ?? [];
	const userStates = directoryAuthUserStates.get(tenantId) ?? [];
	const tenantPolicy = directoryAuthTenantPolicies.get(tenantId)!;
	const retentionPolicy = directoryAuthRetentionPolicies.get(tenantId);
	const evidenceExports = directoryAuthEvidenceExports.get(tenantId) ?? [];
	const supportBundles = directoryAuthSupportBundles.get(tenantId) ?? [];
	const configHistory = directoryAuthConfigHistory.get(tenantId) ?? [];
	const section = segments[3];

	if (section === 'overview' && method === 'GET') {
		return json({
			tenantId,
			policy: tenantPolicy,
			migration: {
				campaigns: campaigns.map((campaign) =>
					serializeDevDirectoryAuthCampaign(campaign, tenantPolicy)
				),
				user_states: userStates
			},
			compliance: {
				retention_policy: retentionPolicy,
				evidence_exports: evidenceExports,
				support_bundles: supportBundles,
				config_history: configHistory,
				public_summary_links: devDirectoryAuthSummaryLinks(tenantId)
			},
			managed_connector: {
				advisories: directoryAuthAdvisories,
				heartbeat_fields: [
					'connector_id',
					'version',
					'platform',
					'release_channel',
					'health_status',
					'redacted_error_code',
					'last_seen_at'
				]
			}
		});
	}

	if (section === 'policy') {
		if (method === 'GET') return json({ tenantId, policy: tenantPolicy });
		if (method === 'PUT') {
			const input = await readJson(event.request);
			const nextPolicy: DevDirectoryAuthTenantPolicy = {
				...tenantPolicy,
				email_code_fallback_mode:
					stringValue(input.email_code_fallback_mode, 'migration_recovery') === 'disabled'
						? 'disabled'
						: stringValue(input.email_code_fallback_mode, 'migration_recovery') === 'login_method'
							? 'login_method'
							: stringValue(input.email_code_fallback_mode, 'migration_recovery') ===
								  'admin_invitation_only'
								? 'admin_invitation_only'
								: stringValue(input.email_code_fallback_mode, 'migration_recovery') ===
									  'directory_unavailable_recovery'
									? 'directory_unavailable_recovery'
									: 'migration_recovery',
				updated_by: 'dev-admin',
				updated_at: Date.now()
			};
			directoryAuthTenantPolicies.set(tenantId, nextPolicy);
			return json({ tenantId, policy: nextPolicy });
		}
	}

	if (section === 'migration' && segments[4] === 'campaigns') {
		if (segments.length === 5 && method === 'GET') {
			return json({
				tenantId,
				items: campaigns.map((campaign) =>
					serializeDevDirectoryAuthCampaign(campaign, tenantPolicy)
				)
			});
		}
		if (segments.length === 5 && method === 'POST') {
			const input = await readJson(event.request);
			const now = Date.now();
			const campaign: DevDirectoryAuthCampaign = {
				id: `damc_dev_${campaigns.length + 1}`,
				tenant_id: tenantId,
				name: stringValue(input.name, `Migration campaign ${campaigns.length + 1}`),
				description: typeof input.description === 'string' ? input.description : null,
				status: 'disabled',
				mode:
					stringValue(input.mode, 'grace_then_require_passkey') ===
					'require_passkey_after_directory'
						? 'require_passkey_after_directory'
						: stringValue(input.mode, 'grace_then_require_passkey') === 'prompt_passkey'
							? 'prompt_passkey'
							: stringValue(input.mode, 'grace_then_require_passkey') === 'directory_login_allowed'
								? 'directory_login_allowed'
								: 'grace_then_require_passkey',
				passkey_prompt_mode: 'campaign_only',
				email_code_fallback_mode:
					stringValue(input.email_code_fallback_mode, 'tenant_default') === 'disabled'
						? 'disabled'
						: stringValue(input.email_code_fallback_mode, 'tenant_default') === 'login_method'
							? 'login_method'
							: stringValue(input.email_code_fallback_mode, 'tenant_default') ===
								  'admin_invitation_only'
								? 'admin_invitation_only'
								: stringValue(input.email_code_fallback_mode, 'tenant_default') ===
									  'directory_unavailable_recovery'
									? 'directory_unavailable_recovery'
									: stringValue(input.email_code_fallback_mode, 'tenant_default') ===
										  'migration_recovery'
										? 'migration_recovery'
										: 'tenant_default',
				grace_period_days: numberValue(input.grace_period_days, 30),
				transaction_ttl_seconds: numberValue(input.transaction_ttl_seconds, 600),
				enforcement_start_mode: 'first_directory_login',
				target_policy:
					input.target_policy && typeof input.target_policy === 'object'
						? (input.target_policy as Record<string, unknown>)
						: {},
				is_template: 0,
				created_by: 'dev-admin',
				created_at: now,
				updated_at: now
			};
			campaigns.unshift(campaign);
			directoryAuthCampaigns.set(tenantId, campaigns);
			return json(
				{ tenantId, item: serializeDevDirectoryAuthCampaign(campaign, tenantPolicy) },
				201
			);
		}
		if (segments.length === 6 && method === 'PATCH') {
			const input = await readJson(event.request);
			const campaign = campaigns.find((item) => item.id === segments[5]);
			if (!campaign) return json({ error: 'directory_auth_campaign_not_found' }, 404);
			campaign.status =
				stringValue(input.status, campaign.status) === 'active'
					? 'active'
					: stringValue(input.status, campaign.status) === 'paused'
						? 'paused'
						: stringValue(input.status, campaign.status) === 'draft'
							? 'draft'
							: stringValue(input.status, campaign.status) === 'archived'
								? 'archived'
								: 'disabled';
			campaign.mode = stringValue(input.mode, campaign.mode) as DevDirectoryAuthCampaign['mode'];
			campaign.passkey_prompt_mode = stringValue(
				input.passkey_prompt_mode,
				campaign.passkey_prompt_mode
			) as DevDirectoryAuthCampaign['passkey_prompt_mode'];
			campaign.email_code_fallback_mode = stringValue(
				input.email_code_fallback_mode,
				campaign.email_code_fallback_mode
			) as DevDirectoryAuthCampaign['email_code_fallback_mode'];
			campaign.grace_period_days = numberValue(input.grace_period_days, campaign.grace_period_days);
			campaign.transaction_ttl_seconds = numberValue(
				input.transaction_ttl_seconds,
				campaign.transaction_ttl_seconds
			);
			if (input.target_policy && typeof input.target_policy === 'object') {
				campaign.target_policy = input.target_policy as Record<string, unknown>;
			}
			campaign.updated_at = Date.now();
			return json({ tenantId, item: serializeDevDirectoryAuthCampaign(campaign, tenantPolicy) });
		}
	}

	if (section === 'migration' && segments[4] === 'user-states') {
		if (segments.length === 5 && method === 'GET') {
			const url = new URL(event.request.url);
			const state = url.searchParams.get('state');
			const campaignId = url.searchParams.get('campaign_id');
			const userId = url.searchParams.get('user_id');
			const items = userStates.filter((item) => {
				if (state && item.state !== state) return false;
				if (campaignId && item.campaign_id !== campaignId) return false;
				if (userId && item.user_id !== userId) return false;
				return true;
			});
			return json({ tenantId, items });
		}
		if (segments.length === 7 && segments[6] === 'reset' && method === 'POST') {
			const input = await readJson(event.request);
			const state = userStates.find((item) => item.id === segments[5]);
			if (!state) return json({ error: 'directory_auth_migration_state_not_found' }, 404);
			const now = Date.now();
			state.state = 'eligible';
			state.blocked_reason = null;
			state.recovery_reason = null;
			state.deferred_until = null;
			state.reset_count += 1;
			state.last_reset_at = now;
			state.last_reset_by = 'dev-admin';
			state.last_reset_reason = stringValue(input.reason, 'admin_reset');
			state.updated_at = now;
			return json({ tenantId, item: state });
		}
	}

	if (section === 'compliance' && segments[4] === 'retention') {
		if (method === 'GET') return json({ tenantId, policy: retentionPolicy });
		if (method === 'PUT') {
			const input = await readJson(event.request);
			const policy = {
				tenant_id: tenantId,
				authrim_audit_retention_days: numberValue(input.authrim_audit_retention_days, 365),
				wordwarden_local_retention_days: numberValue(input.wordwarden_local_retention_days, 14),
				artifact_delete_grace_hours: numberValue(input.artifact_delete_grace_hours, 72),
				updated_by: 'dev-admin',
				created_at: retentionPolicy?.created_at ?? Date.now(),
				updated_at: Date.now()
			};
			directoryAuthRetentionPolicies.set(tenantId, policy);
			return json({ tenantId, policy });
		}
	}

	if (section === 'compliance' && segments[4] === 'config-history' && method === 'GET') {
		return json({
			tenantId,
			items: configHistory,
			public_summary_links: devDirectoryAuthSummaryLinks(tenantId)
		});
	}

	if (section === 'compliance' && segments[4] === 'evidence-exports') {
		if (segments.length === 7 && segments[6] === 'download' && method === 'GET') {
			const item = evidenceExports.find((exportJob) => exportJob.id === segments[5]);
			if (!item || item.status !== 'ready') {
				return json({ error: 'directory_auth_evidence_export_not_found' }, 404);
			}
			return json({
				type: 'directory_auth_evidence_export',
				version: 1,
				tenant_id: tenantId,
				export_id: item.id,
				generated_at: Date.now(),
				sections: {
					migration_campaigns: campaigns,
					migration_user_states: userStates,
					retention_policy: retentionPolicy
				}
			});
		}
		if (method === 'GET') return json({ tenantId, items: evidenceExports });
		if (method === 'POST') {
			const input = await readJson(event.request);
			const now = Date.now();
			const item = {
				id: `daex_dev_${evidenceExports.length + 1}`,
				tenant_id: tenantId,
				status: 'ready' as const,
				requested_by: 'dev-admin',
				period_start_at: numberValue(input.period_start_at, now - 86400000),
				period_end_at: numberValue(input.period_end_at, now),
				size_estimate_bytes: 512,
				artifact_key: `directory-auth/evidence/${tenantId}/daex_dev_${evidenceExports.length + 1}.json`,
				artifact_sha256: 'a'.repeat(64),
				artifact_download_url: `/api/admin/tenants/${encodeURIComponent(
					tenantId
				)}/directory-auth/compliance/evidence-exports/daex_dev_${evidenceExports.length + 1}/download`,
				manifest_signature_key_id: null,
				manifest_signature_alg: null,
				signed_url_expires_at: null,
				retention_expires_at: now + 86400000 * 7,
				download_after_delete: input.download_after_delete === true ? 1 : 0,
				error_code: null,
				created_at: now,
				updated_at: now,
				completed_at: now,
				deleted_at: null
			};
			evidenceExports.unshift(item);
			directoryAuthEvidenceExports.set(tenantId, evidenceExports);
			return json({ tenantId, item }, 201);
		}
	}

	if (section === 'maintenance' && segments[4] === 'cleanup' && method === 'POST') {
		const now = Date.now();
		const expiredExports = evidenceExports.filter(
			(item) => item.status === 'ready' && item.retention_expires_at <= now
		);
		const expiredBundles = supportBundles.filter(
			(item) => item.status === 'ready' && item.retention_expires_at <= now
		);
		for (const item of expiredExports) {
			item.status = 'expired';
			item.updated_at = now;
		}
		for (const item of expiredBundles) {
			item.status = 'expired';
			item.updated_at = now;
		}
		return json({
			tenantId,
			result: {
				migration_transactions_expired: 0,
				evidence_exports_expired: expiredExports.length,
				evidence_exports_deleted: 0,
				support_bundles_expired: expiredBundles.length,
				support_bundles_deleted: 0
			}
		});
	}

	if (section === 'support' && segments[4] === 'bundles') {
		if (segments.length === 7 && segments[6] === 'download' && method === 'GET') {
			const item = supportBundles.find((bundle) => bundle.id === segments[5]);
			if (!item || item.status !== 'ready') {
				return json({ error: 'directory_auth_support_bundle_not_found' }, 404);
			}
			return json({
				type: 'directory_auth_support_bundle',
				version: 1,
				tenant_id: tenantId,
				bundle_id: item.id,
				redaction_level: item.redaction_level,
				generated_at: Date.now(),
				sections: {
					retention_policy: retentionPolicy,
					evidence_export_metadata: evidenceExports.map(
						({
							artifact_key: _artifactKey,
							artifact_download_url: _artifactDownloadUrl,
							manifest_signature_key_id: _manifestSignatureKeyId,
							manifest_signature_alg: _manifestSignatureAlg,
							signed_url_expires_at: _signedUrlExpiresAt,
							...metadata
						}) => metadata
					),
					support_bundle_metadata: supportBundles.map(
						({
							artifact_key: _artifactKey,
							artifact_download_url: _artifactDownloadUrl,
							...metadata
						}) => metadata
					)
				}
			});
		}
		if (method === 'GET') return json({ tenantId, items: supportBundles });
		if (method === 'POST') {
			const input = await readJson(event.request);
			const scope =
				input.scope && typeof input.scope === 'object' && !Array.isArray(input.scope)
					? (input.scope as Record<string, unknown>)
					: {};
			const scopeKeys = Object.keys(scope);
			const allowedScopeKeys = new Set([
				'connector_ids',
				'include_recent_episodes',
				'include_advisories'
			]);
			if (
				scopeKeys.some((key) => !allowedScopeKeys.has(key)) ||
				(scope.connector_ids !== undefined &&
					(!Array.isArray(scope.connector_ids) ||
						scope.connector_ids.length > 20 ||
						scope.connector_ids.some(
							(value) =>
								typeof value !== 'string' ||
								value.length < 1 ||
								value.length > 128 ||
								!/^[A-Za-z0-9._:-]+$/.test(value)
						))) ||
				(scope.include_recent_episodes !== undefined &&
					typeof scope.include_recent_episodes !== 'boolean') ||
				(scope.include_advisories !== undefined && typeof scope.include_advisories !== 'boolean')
			) {
				return json({ error: 'invalid_directory_auth_support_bundle_scope' }, 400);
			}
			const consent =
				input.consent_summary &&
				typeof input.consent_summary === 'object' &&
				!Array.isArray(input.consent_summary)
					? (input.consent_summary as Record<string, unknown>)
					: {};
			const consentKeys = Object.keys(consent);
			if (
				consent.operator_confirmed !== true ||
				consentKeys.some(
					(key) => key !== 'operator_confirmed' && key !== 'detailed_warning_acknowledged'
				) ||
				(consent.detailed_warning_acknowledged !== undefined &&
					typeof consent.detailed_warning_acknowledged !== 'boolean')
			) {
				return json({ error: 'invalid_directory_auth_support_bundle_consent' }, 400);
			}
			const redactionLevel: 'minimal' | 'standard' | 'detailed' =
				input.redaction_level === 'detailed' || input.redaction_level === 'minimal'
					? input.redaction_level
					: 'standard';
			if (redactionLevel === 'detailed' && consent.detailed_warning_acknowledged !== true) {
				return json({ error: 'invalid_directory_auth_support_bundle_consent' }, 400);
			}
			const now = Date.now();
			const item = {
				id: `dasb_dev_${supportBundles.length + 1}`,
				tenant_id: tenantId,
				requested_by: 'dev-admin',
				redaction_level: redactionLevel,
				status: 'ready' as const,
				scope_json: JSON.stringify(scope),
				consent_summary_json: JSON.stringify(consent),
				artifact_key: `directory-auth/support-bundles/${tenantId}/dasb_dev_${supportBundles.length + 1}.json`,
				artifact_sha256: 'b'.repeat(64),
				artifact_download_url: `/api/admin/tenants/${encodeURIComponent(
					tenantId
				)}/directory-auth/support/bundles/dasb_dev_${supportBundles.length + 1}/download`,
				retention_expires_at: now + 86400000 * 7,
				created_at: now,
				updated_at: now,
				completed_at: now,
				deleted_at: null
			};
			supportBundles.unshift(item);
			directoryAuthSupportBundles.set(tenantId, supportBundles);
			return json({ tenantId, item }, 201);
		}
	}

	if (section === 'managed' && segments[4] === 'advisories' && method === 'GET') {
		return json({ tenantId, channel: 'stable', items: directoryAuthAdvisories });
	}

	if (section === 'managed' && segments[4] === 'connectors' && method === 'GET') {
		return json({ tenantId, items: [], recent_episodes: [] });
	}

	return null;
}

async function handleDirectoryConnectors(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'tenants' || segments[2] !== 'directory-connectors') return null;

	const tenantId = segments[1] || getTenantId(event);
	const config = directoryConnectors.get(tenantId) ?? {
		enabled: false,
		default_connector_id: 'campus',
		auto_provision: false,
		connectors: []
	};

	if (segments.length === 3 && method === 'GET') {
		return json({ tenantId, ...config });
	}

	if (segments.length === 3 && method === 'PUT') {
		const input = await readJson(event.request);
		const nextConnectors = Array.isArray(input.connectors)
			? input.connectors.map((connector, index) => normalizeDevDirectoryConnector(connector, index))
			: [];
		const nextConfig = {
			enabled: Boolean(input.enabled),
			default_connector_id:
				typeof input.default_connector_id === 'string' && input.default_connector_id.trim()
					? input.default_connector_id.trim()
					: 'campus',
			auto_provision: Boolean(input.auto_provision),
			connectors: nextConnectors
		};
		directoryConnectors.set(tenantId, nextConfig);
		return json({ tenantId, ...nextConfig });
	}

	if (segments[3] === 'fleet' && segments.length === 4 && method === 'GET') {
		const now = Date.now();
		const connector = config.connectors[0];
		const connectorId = connector?.connector_id ?? 'wwcon_8K4M2Q9F7D3H6P1X';
		return json({
			tenantId,
			items: [
				{
					id: 'dcinst_dev',
					tenant_id: tenantId,
					connector_id: connectorId,
					instance_id: 'wwi_devlocal12345678901234',
					display_name: 'dev-wordwarden',
					transport: connector?.transport ?? 'relay',
					version: '0.13.0-dev',
					release_channel: 'stable',
					started_at: new Date(now - 3600000).toISOString(),
					first_seen_at: now - 3600000,
					last_seen_at: now - 30000,
					status: 'connected',
					health_status: 'healthy',
					health_summary: { ldap: 'ok' },
					config_fingerprint: `sha256:${'a'.repeat(64)}`,
					config_categories: ['ldap', 'heartbeat'],
					drift_severity: 'none',
					deactivated_at: null,
					deactivated_by: null,
					deactivation_reason: null,
					updated_at: now - 30000
				}
			],
			episodes: [
				{
					id: 'dcepi_dev',
					tenant_id: tenantId,
					connector_id: connectorId,
					instance_id: 'wwi_devlocal12345678901234',
					status: 'connected',
					started_at: now - 3600000,
					ended_at: null,
					last_seen_at: now - 30000,
					reason: null,
					acknowledged_at: null,
					acknowledged_by: null,
					created_at: now - 3600000,
					updated_at: now - 30000
				}
			]
		});
	}

	if (segments[3] === 'fleet' && segments.length === 5 && method === 'POST') {
		const input = await readJson(event.request);
		return json({
			ok: true,
			instance_id: segments[4],
			connector_id:
				typeof input.connector_id === 'string' ? input.connector_id : 'wwcon_8K4M2Q9F7D3H6P1X',
			action: typeof input.action === 'string' ? input.action : 'acknowledge'
		});
	}

	if (segments.length === 5 && segments[4] === 'health' && method === 'POST') {
		const connectorId = segments[3];
		const connector = config.connectors.find((item) => item.id === connectorId);
		if (!connector) return json({ error: 'directory_connector_not_found' }, 404);
		return json({
			ok: true,
			connector_id: connector.id,
			status: 200,
			body: {
				ok: true,
				mode: 'dev-admin-mock'
			}
		});
	}

	return null;
}

async function handleCompliance(event: RequestEvent, segments: string[]): Promise<Response | null> {
	const method = event.request.method;
	const nowIso = new Date(NOW).toISOString();

	if (segments[0] === 'compliance') {
		if (segments[1] === 'status' && method === 'GET') {
			return json({
				tenant_id: TENANT_ID,
				overall_status: 'partial',
				frameworks: [
					{
						framework: 'gdpr',
						status: 'partial',
						compliant_checks: 3,
						warning_checks: 1,
						non_compliant_checks: 0,
						total_checks: 6,
						last_assessment: nowIso
					},
					{
						framework: 'soc2',
						status: 'compliant',
						compliant_checks: 4,
						warning_checks: 0,
						non_compliant_checks: 0,
						total_checks: 4,
						last_assessment: nowIso
					},
					{
						framework: 'iso27001',
						status: 'not_applicable',
						compliant_checks: 0,
						warning_checks: 0,
						non_compliant_checks: 0,
						total_checks: 5,
						last_assessment: null
					}
				],
				recent_checks: [
					{
						id: 'dev-check-retention',
						name: 'Data retention policy',
						description: 'Retention policy is configured for key data categories.',
						framework: 'gdpr',
						status: 'compliant',
						last_checked: nowIso,
						details: 'Default retention and cleanup schedule are enabled.'
					},
					{
						id: 'dev-check-mfa',
						name: 'MFA coverage',
						description: 'Administrative MFA coverage is monitored.',
						framework: 'soc2',
						status: 'partial',
						last_checked: nowIso,
						details: 'Dev mock coverage is below the target threshold.'
					}
				],
				data_retention: {
					policy_enabled: true,
					retention_days: 365,
					last_cleanup: new Date(NOW - 86400000 * 6).toISOString(),
					pending_deletions: 25,
					gdpr_compliant: true
				},
				audit_log: {
					enabled: true,
					retention_days: 365,
					total_entries: 12840,
					entries_last_30_days: 930
				},
				mfa_status: {
					enabled: true,
					users_with_mfa: 18,
					users_without_mfa: 2,
					mfa_coverage_percent: 90
				},
				encryption: {
					data_at_rest: true,
					data_in_transit: true,
					key_rotation_enabled: true,
					last_key_rotation: new Date(NOW - 86400000 * 21).toISOString()
				},
				access_control: {
					rbac_enabled: true,
					active_roles: 8,
					users_with_roles: 20,
					orphaned_permissions: 0,
					last_review: new Date(NOW - 86400000 * 12).toISOString()
				},
				last_updated: nowIso
			});
		}

		if (segments[1] === 'access-reviews') {
			if (method === 'POST') {
				const input = await readJson(event.request);
				return json(
					{
						review_id: `dev-review-${Date.now()}`,
						tenant_id: TENANT_ID,
						name: typeof input.name === 'string' ? input.name : 'Dev access review',
						scope: typeof input.scope === 'string' ? input.scope : 'all_users',
						scope_value: typeof input.scope_target === 'string' ? input.scope_target : null,
						status: 'in_progress',
						reviewer_id: 'dev-admin',
						progress: { total_items: 20, reviewed_items: 0 },
						started_at: nowIso,
						due_date: typeof input.due_date === 'string' ? input.due_date : null
					},
					201
				);
			}
			return json({
				data: [
					{
						review_id: 'dev-review-quarterly',
						tenant_id: TENANT_ID,
						name: 'Quarterly privileged access review',
						scope: 'all_users',
						scope_value: null,
						status: 'in_progress',
						reviewer_id: 'dev-admin',
						progress: {
							total_items: 20,
							reviewed_items: 12,
							approved_items: 11,
							revoked_items: 1,
							completion_percent: 60
						},
						started_at: new Date(NOW - 86400000 * 4).toISOString(),
						due_date: new Date(NOW + 86400000 * 10).toISOString()
					}
				],
				pagination: { has_more: false }
			});
		}

		if (segments[1] === 'reports' && method === 'GET') {
			return json({
				data: [
					{
						report_id: 'dev-report-gdpr',
						tenant_id: TENANT_ID,
						type: 'gdpr',
						name: 'GDPR readiness summary',
						status: 'completed',
						requested_by: 'dev-admin',
						parameters: { include_evidence: true },
						result_url: null,
						created_at: new Date(NOW - 86400000 * 3).toISOString(),
						completed_at: new Date(NOW - 86400000 * 3 + 120000).toISOString(),
						expires_at: new Date(NOW + 86400000 * 27).toISOString()
					}
				],
				pagination: { has_more: false }
			});
		}
	}

	if (segments[0] === 'data-retention') {
		if (segments[1] === 'status' && method === 'GET') {
			return json({
				tenant_id: TENANT_ID,
				policy: {
					enabled: true,
					default_retention_days: 365,
					cleanup_schedule: 'daily',
					last_cleanup_run: new Date(NOW - 86400000 * 6).toISOString(),
					next_cleanup_run: new Date(NOW + 86400000).toISOString()
				},
				categories: devRetentionCategories,
				summary: {
					total_records: devRetentionCategories.reduce(
						(sum, category) => sum + category.total_records,
						0
					),
					records_pending_deletion: devRetentionCategories.reduce(
						(sum, category) => sum + category.records_pending_deletion,
						0
					),
					records_deleted_last_30_days: devRetentionCategories.reduce(
						(sum, category) => sum + category.records_deleted_last_30_days,
						0
					),
					storage_savings_estimate_mb: 128
				},
				gdpr_compliance: {
					right_to_erasure_supported: true,
					anonymization_supported: true,
					tombstone_retention_days: 730,
					pending_erasure_requests: 2
				},
				last_updated: nowIso
			});
		}

		if (segments[1] === 'categories') {
			if (segments.length === 2 && method === 'GET') {
				return json({
					categories: devRetentionCategories.map((category) => ({
						category: category.category,
						retention_days: category.retention_days,
						updated_at: nowIso
					}))
				});
			}

			if (segments[2] && method === 'PUT') {
				const input = await readJson(event.request);
				const retentionDays = typeof input.retention_days === 'number' ? input.retention_days : 365;
				return json({
					category: segments[2],
					retention_days: retentionDays,
					updated_at: nowIso
				});
			}
		}

		if (segments[1] === 'cleanup' && method === 'POST') {
			return json({
				id: `dev-cleanup-${Date.now()}`,
				status: 'completed',
				records_deleted: { audit_logs: 18, session_data: 7 },
				started_at: nowIso,
				completed_at: new Date(NOW + 1500).toISOString(),
				error_message: null
			});
		}

		if (segments[1] === 'cleanup' && segments[2] && method === 'GET') {
			return json({
				id: segments[2],
				status: 'completed',
				records_deleted: { audit_logs: 18, session_data: 7 },
				started_at: nowIso,
				completed_at: new Date(NOW + 1500).toISOString(),
				error_message: null
			});
		}
	}

	return null;
}

async function handleControlPlaneDestinations(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	if (segments[0] !== 'destinations') return null;

	const method = event.request.method;
	const now = Date.now();
	const items = [...controlPlaneDestinations.values()];

	if (segments[1] === 'provider-preview' && method === 'POST') {
		const input = await readJson(event.request);
		const provider =
			typeof input.provider === 'string' && input.provider.trim() ? input.provider.trim() : 'r2';
		return json({
			item: {
				provider,
				destination_kind: 'object_storage',
				provider_config:
					input.provider_config && typeof input.provider_config === 'object'
						? input.provider_config
						: {},
				schema: {
					required_fields: provider === 'aws_s3' ? ['bucket', 'region'] : ['binding_ref'],
					optional_fields: ['prefix', 'retention_days'],
					default_capabilities: ['write', 'health_check']
				},
				capabilities: Array.isArray(input.capabilities) ? input.capabilities : ['write'],
				validation: { valid: true, errors: [] },
				security: {
					inline_secret_detected: false,
					inline_secret_path: null,
					credential_ref_required: provider === 'aws_s3'
				}
			}
		});
	}

	if (segments.length === 1 && method === 'GET') {
		const scopeType = event.url.searchParams.get('scope_type');
		const filtered = scopeType ? items.filter((item) => item.scope_type === scopeType) : items;
		return json({ items: filtered, total: filtered.length });
	}

	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const scopeType =
			input.scope_type === 'platform' || input.scope_type === 'shared'
				? input.scope_type
				: 'tenant';
		const provider =
			typeof input.provider === 'string' && input.provider.trim() ? input.provider.trim() : 'r2';
		const name =
			typeof input.name === 'string' && input.name.trim()
				? input.name.trim()
				: `destination-${controlPlaneDestinations.size + 1}`;
		const destination: DevControlPlaneDestination = {
			id: `dev-destination-${controlPlaneDestinations.size + 1}`,
			scope_type: scopeType,
			scope_id: scopeType === 'tenant' ? getTenantId(event) : null,
			destination_kind: 'object_storage',
			name,
			display_name:
				typeof input.display_name === 'string' && input.display_name.trim()
					? input.display_name.trim()
					: name,
			description: typeof input.description === 'string' ? input.description : null,
			provider: provider as DevControlPlaneDestination['provider'],
			provider_config:
				input.provider_config && typeof input.provider_config === 'object'
					? (input.provider_config as Record<string, unknown>)
					: {},
			allowed_tenant_ids: Array.isArray(input.allowed_tenant_ids)
				? input.allowed_tenant_ids.join(',')
				: null,
			allowed_log_types: Array.isArray(input.allowed_log_types)
				? input.allowed_log_types.join(',')
				: null,
			allowed_planes: Array.isArray(input.allowed_planes) ? input.allowed_planes.join(',') : null,
			region: typeof input.region === 'string' ? input.region : null,
			critical_allowed: input.critical_allowed === false ? 0 : 1,
			default_fallback_eligible: input.default_fallback_eligible === true ? 1 : 0,
			runtime_supported: true,
			runtime_status: 'supported',
			runtime_unsupported_reason: null,
			retention_days: typeof input.retention_days === 'number' ? input.retention_days : null,
			encryption_mode: typeof input.encryption_mode === 'string' ? input.encryption_mode : 'none',
			lifecycle_status: 'active',
			health_status: 'unknown',
			rotation_status: 'none',
			credential_ref: null,
			credential_version: 0,
			next_credential_ref: null,
			next_credential_version: null,
			previous_credential_ref: null,
			previous_credential_retire_after: null,
			last_health_check_at: null,
			created_at: now,
			updated_at: now,
			deleted_at: null,
			version: 1,
			capabilities: Array.isArray(input.capabilities)
				? input.capabilities.map((capability) => ({
						capability: String(capability),
						source: 'dev-mock',
						enabled: 1,
						created_at: now,
						updated_at: now
					}))
				: []
		};
		controlPlaneDestinations.set(destination.id, destination);
		return json({ item: destination }, 201);
	}

	const destinationId = segments[1];
	const destination = controlPlaneDestinations.get(destinationId);
	if (!destination) {
		return json({ error: 'not_found', error_description: 'Dev mock destination not found' }, 404);
	}

	if (segments.length === 2 && method === 'GET') return json({ item: destination });

	if (segments.length === 2 && method === 'PATCH') {
		const input = await readJson(event.request);
		const updated: DevControlPlaneDestination = {
			...destination,
			display_name:
				typeof input.display_name === 'string' && input.display_name.trim()
					? input.display_name.trim()
					: destination.display_name,
			description:
				typeof input.description === 'string' || input.description === null
					? (input.description as string | null)
					: destination.description,
			provider_config:
				input.provider_config && typeof input.provider_config === 'object'
					? (input.provider_config as Record<string, unknown>)
					: destination.provider_config,
			version: destination.version + 1,
			updated_at: now
		};
		controlPlaneDestinations.set(destinationId, updated);
		return json({
			item: { id: updated.id, version: updated.version, updated_at: updated.updated_at }
		});
	}

	if (segments.length === 2 && method === 'DELETE') {
		const updated: DevControlPlaneDestination = {
			...destination,
			lifecycle_status: 'deleted',
			deleted_at: now,
			version: destination.version + 1,
			updated_at: now
		};
		controlPlaneDestinations.set(destinationId, updated);
		return json({
			item: {
				id: updated.id,
				lifecycle_status: updated.lifecycle_status,
				deleted_at: updated.deleted_at,
				version: updated.version
			}
		});
	}

	if (segments[2] === 'health-check' && method === 'POST') {
		const updated: DevControlPlaneDestination = {
			...destination,
			health_status: 'healthy',
			last_health_check_at: now,
			updated_at: now
		};
		controlPlaneDestinations.set(destinationId, updated);
		return json({
			item: {
				destination_id: destinationId,
				checked_at: now,
				check_type: 'quick',
				previous_health_status: destination.health_status,
				next_health_status: 'healthy',
				result: 'success',
				error_class: null,
				latency_ms: 12,
				metadata: { dev_mock: true }
			}
		});
	}

	if (segments[2] === 'diff-preview' && method === 'POST') {
		return json({
			item: {
				destination_id: destinationId,
				current_version: destination.version,
				expected_version: null,
				changed: true,
				diff: [],
				dangerous_classification: 'none',
				dangerous_reasons: [],
				affected_assignments: {},
				confirmation: null,
				previewed_at: now
			}
		});
	}

	if ((segments[2] === 'disable' || segments[2] === 'enable') && method === 'POST') {
		const lifecycleStatus = segments[2] === 'disable' ? 'disabled' : 'active';
		const updated: DevControlPlaneDestination = {
			...destination,
			lifecycle_status: lifecycleStatus,
			version: destination.version + 1,
			updated_at: now
		};
		controlPlaneDestinations.set(destinationId, updated);
		return json({
			item: {
				id: updated.id,
				lifecycle_status: updated.lifecycle_status,
				version: updated.version,
				updated_at: updated.updated_at
			}
		});
	}

	if (segments[2] === 'credentials' && method === 'POST') {
		const action = segments[3];
		const nextVersion = destination.credential_version + 1;
		const preparedRef =
			action === 'prepare'
				? `secret:${destination.name}:v${nextVersion}`
				: destination.next_credential_ref;
		const preparedVersion =
			action === 'prepare' ? nextVersion : destination.next_credential_version;
		const activatedRef =
			action === 'activate'
				? (destination.next_credential_ref ?? `secret:${destination.name}:v${nextVersion}`)
				: destination.credential_ref;
		const activatedVersion =
			action === 'activate'
				? (destination.next_credential_version ?? nextVersion)
				: destination.credential_version;
		const updated: DevControlPlaneDestination = {
			...destination,
			rotation_status: action === 'activate' ? 'active' : action || 'prepared',
			credential_ref: activatedRef,
			credential_version: activatedVersion,
			next_credential_ref: action === 'activate' ? null : preparedRef,
			next_credential_version: action === 'activate' ? null : preparedVersion,
			previous_credential_ref:
				action === 'retire-previous' ? null : destination.previous_credential_ref,
			previous_credential_retire_after:
				action === 'retire-previous' ? null : destination.previous_credential_retire_after,
			version: destination.version + 1,
			updated_at: now
		};
		controlPlaneDestinations.set(destinationId, updated);
		return json({
			item: {
				id: updated.id,
				credential_ref: updated.credential_ref,
				credential_version: updated.credential_version,
				next_credential_ref: updated.next_credential_ref,
				next_credential_version: updated.next_credential_version,
				previous_credential_ref: updated.previous_credential_ref,
				previous_credential_retire_after: updated.previous_credential_retire_after,
				rotation_status: updated.rotation_status,
				version: updated.version,
				updated_at: updated.updated_at
			}
		});
	}

	return null;
}

async function handleStorageDestinations(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	if (segments[0] !== 'storage-destinations') return null;

	const method = event.request.method;
	const tenantId = getTenantId(event);
	const now = Date.now();
	const items = [...storageDestinations.values()];

	if (segments[1] === 'usable' && method === 'GET') {
		const activeItems = items.filter((item) => item.status === 'active');
		return json({ items: activeItems, total: activeItems.length });
	}

	if (segments.length === 1 && method === 'GET') {
		const scopeType = event.url.searchParams.get('scope_type');
		const filtered =
			scopeType === 'tenant' || scopeType === 'platform'
				? items.filter((item) => item.scope_type === scopeType)
				: items;
		return json({ items: filtered, total: filtered.length });
	}

	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const provider =
			input.provider === 'aws_s3' || input.provider === 'custom' || input.provider === 'r2'
				? input.provider
				: 'r2';
		const scopeType =
			input.scope_type === 'platform' || event.url.searchParams.get('scope_type') === 'platform'
				? 'platform'
				: 'tenant';
		const name =
			typeof input.name === 'string' && input.name.trim()
				? input.name.trim()
				: `destination-${storageDestinations.size + 1}`;
		const destination: DevStorageDestination = {
			id: `dev-storage-${storageDestinations.size + 1}`,
			scope_type: scopeType,
			scope_id: scopeType === 'platform' ? 'platform' : tenantId,
			name,
			display_name:
				typeof input.display_name === 'string' && input.display_name.trim()
					? input.display_name.trim()
					: name,
			description: typeof input.description === 'string' ? input.description : null,
			provider,
			config:
				input.config && typeof input.config === 'object'
					? (input.config as Record<string, unknown>)
					: {},
			managed_by: 'admin',
			read_only: false,
			has_credential: Boolean(input.credential),
			credential_key_version: input.credential ? 1 : null,
			credential_updated_at: input.credential ? now : null,
			credential_updated_by: input.credential ? 'dev-admin' : null,
			status: input.status === 'disabled' ? 'disabled' : 'active',
			created_by: 'dev-admin',
			updated_by: 'dev-admin',
			created_at: now,
			updated_at: now
		};
		storageDestinations.set(destination.id, destination);
		return json({ item: destination, audit_id: 'dev-audit-storage-destination-create' }, 201);
	}

	const destinationId = segments[1];
	const destination = storageDestinations.get(destinationId);
	if (!destination) {
		return json(
			{
				error: 'not_found',
				error_description: 'Dev mock storage destination not found'
			},
			404
		);
	}

	if (segments.length === 2 && method === 'GET') {
		return json({ item: destination });
	}

	if (segments.length === 2 && method === 'PATCH') {
		const input = await readJson(event.request);
		const updated: DevStorageDestination = {
			...destination,
			display_name:
				typeof input.display_name === 'string' && input.display_name.trim()
					? input.display_name.trim()
					: destination.display_name,
			description:
				typeof input.description === 'string' || input.description === null
					? (input.description as string | null)
					: destination.description,
			config:
				input.config && typeof input.config === 'object'
					? (input.config as Record<string, unknown>)
					: destination.config,
			status:
				input.status === 'disabled' || input.status === 'active'
					? input.status
					: destination.status,
			updated_by: 'dev-admin',
			updated_at: now
		};
		storageDestinations.set(destinationId, updated);
		return json({ item: updated, audit_id: 'dev-audit-storage-destination-update' });
	}

	if (segments.length === 2 && method === 'DELETE') {
		storageDestinations.delete(destinationId);
		return json({
			result: { success: true },
			audit_id: 'dev-audit-storage-destination-delete'
		});
	}

	if (segments[2] === 'credentials' && method === 'PUT') {
		const updated: DevStorageDestination = {
			...destination,
			has_credential: true,
			credential_key_version: (destination.credential_key_version ?? 0) + 1,
			credential_updated_at: now,
			credential_updated_by: 'dev-admin',
			updated_by: 'dev-admin',
			updated_at: now
		};
		storageDestinations.set(destinationId, updated);
		return json({ item: updated, audit_id: 'dev-audit-storage-destination-credential' });
	}

	if (segments[2] === 'usage' && method === 'GET') {
		const usages = storageDestinationUsages.get(destinationId) ?? [];
		return json({ items: usages, total: usages.length });
	}

	if (segments[2] === 'usage' && method === 'POST') {
		const input = await readJson(event.request);
		const usage: DevStorageDestinationUsage = {
			id: `dev-storage-usage-${now}`,
			destination_id: destinationId,
			feature: typeof input.feature === 'string' ? input.feature : 'diagnostic_logging',
			resource_type: typeof input.resource_type === 'string' ? input.resource_type : 'tenant',
			resource_id: typeof input.resource_id === 'string' ? input.resource_id : tenantId,
			tenant_id: tenantId,
			metadata:
				input.metadata && typeof input.metadata === 'object'
					? (input.metadata as Record<string, unknown>)
					: {},
			created_by: 'dev-admin',
			created_at: now,
			updated_at: now
		};
		const usages = storageDestinationUsages.get(destinationId) ?? [];
		storageDestinationUsages.set(destinationId, [...usages, usage]);
		return json({ item: usage, audit_id: 'dev-audit-storage-destination-usage' }, 201);
	}

	if (segments[2] === 'test' && method === 'POST') {
		return json({
			result: {
				status: 'ok',
				message: `Dev mock connection succeeded for ${destination.display_name}`
			},
			audit_id: 'dev-audit-storage-destination-test'
		});
	}

	return null;
}

function parseDevMachineTenantScopes(input: unknown): DevMachineTenantScope[] {
	if (!Array.isArray(input) || input.length === 0) return [{ scopeMode: 'none', tenantId: null }];
	return input.map((entry) => {
		if (!entry || typeof entry !== 'object') return { scopeMode: 'none', tenantId: null };
		const record = entry as Record<string, unknown>;
		const rawMode = record.scope_mode ?? record.scopeMode;
		const scopeMode = rawMode === 'all' || rawMode === 'allow' ? rawMode : 'none';
		return {
			scopeMode,
			tenantId:
				scopeMode === 'allow' && typeof record.tenant_id === 'string'
					? record.tenant_id
					: scopeMode === 'allow' && typeof record.tenantId === 'string'
						? record.tenantId
						: null
		};
	});
}

function parseDevStringArray(input: unknown, fallback: string[]): string[] {
	if (!Array.isArray(input)) return fallback;
	const values = input.filter(
		(value): value is string => typeof value === 'string' && Boolean(value)
	);
	return values.length > 0 ? values : fallback;
}

function devMachinePrincipalFromInput(
	input: Record<string, unknown>,
	now: number
): DevMachinePrincipal {
	const id =
		typeof input.client_id === 'string' && input.client_id.trim()
			? `machine-${input.client_id.trim()}`
			: `machine-${machinePrincipals.size + 1}`;
	const clientId =
		typeof input.client_id === 'string' && input.client_id.trim()
			? input.client_id.trim()
			: `machine-client-${machinePrincipals.size + 1}`;
	const principalType =
		input.principal_type === 'setup_tool' ||
		input.principal_type === 'admin_ui_bff' ||
		input.principal_type === 'automation' ||
		input.principal_type === 'ci' ||
		input.principal_type === 'mcp_server' ||
		input.principal_type === 'ai_agent' ||
		input.principal_type === 'internal_service' ||
		input.principal_type === 'integration'
			? input.principal_type
			: 'automation';
	const tokenTtl =
		typeof input.token_ttl_seconds === 'number' && Number.isFinite(input.token_ttl_seconds)
			? input.token_ttl_seconds
			: 600;

	return {
		id,
		clientId,
		displayName:
			typeof input.display_name === 'string' && input.display_name.trim()
				? input.display_name.trim()
				: clientId,
		description: typeof input.description === 'string' ? input.description : null,
		principalType,
		status: 'active',
		defaultAudience: 'authrim-admin',
		tokenTtlSeconds: tokenTtl,
		createdAt: now,
		updatedAt: now,
		disabledAt: null,
		permissions: parseDevStringArray(input.permissions, ['admin:clients:read']),
		tenantScopes: parseDevMachineTenantScopes(input.tenant_scopes),
		credentials: []
	};
}

async function handleMachineAccess(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	if (segments[0] !== 'machine-access' || segments[1] !== 'principals') return null;

	const method = event.request.method;
	const now = Date.now();

	if (segments.length === 2 && method === 'GET') {
		const status = event.url.searchParams.get('status');
		const items = [...machinePrincipals.values()].filter(
			(principal) => !status || principal.status === status
		);
		return json({ items, page: 1, limit: Number(event.url.searchParams.get('limit') ?? 100) });
	}

	if (segments.length === 2 && method === 'POST') {
		const input = await readJson(event.request);
		const principal = devMachinePrincipalFromInput(input, now);
		machinePrincipals.set(principal.id, principal);
		return json({ principal }, 201);
	}

	const principalId = segments[2];
	const principal = machinePrincipals.get(principalId);
	if (!principal) {
		return json(
			{ error: 'not_found', error_description: 'Dev mock machine principal not found' },
			404
		);
	}

	if (segments.length === 3 && method === 'GET') return json({ principal });

	if (segments.length === 3 && method === 'PATCH') {
		const input = await readJson(event.request);
		const updated: DevMachinePrincipal = {
			...principal,
			displayName:
				typeof input.display_name === 'string' && input.display_name.trim()
					? input.display_name.trim()
					: principal.displayName,
			description:
				typeof input.description === 'string' || input.description === null
					? (input.description as string | null)
					: principal.description,
			tokenTtlSeconds:
				typeof input.token_ttl_seconds === 'number' && Number.isFinite(input.token_ttl_seconds)
					? input.token_ttl_seconds
					: principal.tokenTtlSeconds,
			permissions: parseDevStringArray(input.permissions, principal.permissions),
			tenantScopes: input.tenant_scopes
				? parseDevMachineTenantScopes(input.tenant_scopes)
				: principal.tenantScopes,
			updatedAt: now
		};
		machinePrincipals.set(principalId, updated);
		return json({ principal: updated });
	}

	if (segments[3] === 'disable' && method === 'POST') {
		const updated: DevMachinePrincipal = {
			...principal,
			status: 'disabled',
			disabledAt: now,
			updatedAt: now
		};
		machinePrincipals.set(principalId, updated);
		return json({ principal: updated });
	}

	if (segments[3] === 'enable' && method === 'POST') {
		const updated: DevMachinePrincipal = {
			...principal,
			status: 'active',
			disabledAt: null,
			updatedAt: now
		};
		machinePrincipals.set(principalId, updated);
		return json({ principal: updated });
	}

	if (segments[3] === 'credentials' && segments.length === 4 && method === 'POST') {
		const input = await readJson(event.request);
		const kid =
			typeof input.kid === 'string' && input.kid.trim()
				? input.kid.trim()
				: `${principal.clientId}-${principal.credentials.length + 1}`;
		const credential: DevMachineCredential = {
			id: `cred-${kid}`,
			principalId,
			kid,
			publicJwkJson:
				input.public_jwk && typeof input.public_jwk === 'object'
					? JSON.stringify(input.public_jwk)
					: '{}',
			alg: input.alg === 'PS256' || input.alg === 'RS256' ? input.alg : 'ES256',
			displayName:
				typeof input.display_name === 'string' && input.display_name.trim()
					? input.display_name.trim()
					: kid,
			description: typeof input.description === 'string' ? input.description : null,
			status: 'active',
			notBefore: typeof input.not_before === 'number' ? input.not_before : null,
			expiresAt: typeof input.expires_at === 'number' ? input.expires_at : null,
			lastUsedAt: null,
			lastUsedIp: null,
			lastUsedUserAgent: null,
			createdAt: now,
			updatedAt: now,
			revokedAt: null,
			revokeReason: null
		};
		const updated: DevMachinePrincipal = {
			...principal,
			credentials: [...principal.credentials, credential],
			updatedAt: now
		};
		machinePrincipals.set(principalId, updated);
		return json({ credential }, 201);
	}

	if (segments[3] === 'credentials' && segments.length >= 6) {
		const credentialId = segments[4];
		const credential = principal.credentials.find((item) => item.id === credentialId);
		if (!credential) {
			return json({ error: 'not_found', error_description: 'Dev mock credential not found' }, 404);
		}

		if (segments[5] === 'rotate' && method === 'POST') {
			const input = await readJson(event.request);
			const nextKid =
				typeof input.kid === 'string' && input.kid.trim()
					? input.kid.trim()
					: `${credential.kid}-next`;
			const rotated: DevMachineCredential = {
				...credential,
				status: 'rotating',
				updatedAt: now
			};
			const nextCredential: DevMachineCredential = {
				...credential,
				id: `cred-${nextKid}`,
				kid: nextKid,
				displayName:
					typeof input.display_name === 'string' && input.display_name.trim()
						? input.display_name.trim()
						: `${credential.displayName} rotation`,
				alg: input.alg === 'PS256' || input.alg === 'RS256' ? input.alg : 'ES256',
				publicJwkJson:
					input.public_jwk && typeof input.public_jwk === 'object'
						? JSON.stringify(input.public_jwk)
						: credential.publicJwkJson,
				status: 'active',
				createdAt: now,
				updatedAt: now,
				revokedAt: null,
				revokeReason: null
			};
			const updated: DevMachinePrincipal = {
				...principal,
				credentials: principal.credentials
					.map((item) => (item.id === credentialId ? rotated : item))
					.concat(nextCredential),
				updatedAt: now
			};
			machinePrincipals.set(principalId, updated);
			return json({ credential: nextCredential });
		}

		if (segments[5] === 'emergency-revoke' && method === 'POST') {
			const input = await readJson(event.request);
			const revoked: DevMachineCredential = {
				...credential,
				status: 'revoked',
				revokedAt: now,
				revokeReason: typeof input.reason === 'string' ? input.reason : 'Dev mock revoke',
				updatedAt: now
			};
			const updated: DevMachinePrincipal = {
				...principal,
				credentials: principal.credentials.map((item) =>
					item.id === credentialId ? revoked : item
				),
				updatedAt: now
			};
			machinePrincipals.set(principalId, updated);
			return json({ credential: revoked });
		}
	}

	return null;
}

async function handleApprovals(event: RequestEvent, segments: string[]): Promise<Response | null> {
	if (segments[0] !== 'approvals') return null;
	const method = event.request.method;

	if (segments.length === 1 && method === 'GET') {
		const status = event.url.searchParams.get('status');
		const investigationId = event.url.searchParams.get('investigation_id')?.toLowerCase();
		const limitParam = Number(event.url.searchParams.get('limit') ?? '100');
		const limit = Number.isFinite(limitParam) ? Math.max(1, Math.floor(limitParam)) : 100;
		const items = Array.from(devApprovalRequests.values())
			.filter((item) => !status || item.status === status)
			.filter(
				(item) => !investigationId || item.investigation_id.toLowerCase().includes(investigationId)
			)
			.sort((a, b) => b.created_at - a.created_at)
			.slice(0, limit);

		return json({ items, total: items.length });
	}

	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const requestId = `ar-dev-created-${Date.now()}`;
		const createdAt = Math.floor(Date.now() / 1000);
		const policyPreset =
			typeof input.policy_preset === 'string' ? input.policy_preset : 'support_case_default';
		const request: DevApprovalRequest = {
			id: `dev-approval-${createdAt}`,
			public_request_id: requestId,
			tenant_id: TENANT_ID,
			investigation_id:
				typeof input.investigation_id === 'string' && input.investigation_id.trim()
					? input.investigation_id
					: `INV-DEV-${createdAt}`,
			requester_subject_type:
				typeof input.requester_subject_type === 'string'
					? input.requester_subject_type
					: 'admin_user',
			requester_subject_id:
				typeof input.requester_subject_id === 'string' ? input.requester_subject_id : 'dev-admin',
			target_subject_type:
				typeof input.target_subject_type === 'string' ? input.target_subject_type : 'user',
			target_subject_id:
				typeof input.target_subject_id === 'string' ? input.target_subject_id : 'dev-user',
			request_surface:
				typeof input.request_surface === 'string' ? input.request_surface : 'admin_audit',
			requested_action:
				typeof input.requested_action === 'string' ? input.requested_action : 'detail_read',
			redaction_level:
				input.redaction_level === 'summary_only' ||
				input.redaction_level === 'masked' ||
				input.redaction_level === 'raw'
					? input.redaction_level
					: 'masked',
			status: 'pending',
			scope_json: {
				resource_class:
					typeof input.resource_class === 'string' ? input.resource_class : 'admin_audit_detail',
				resource_ids: Array.isArray(input.resource_ids) ? input.resource_ids : [],
				detail_classes: Array.isArray(input.detail_classes) ? input.detail_classes : []
			},
			scope_canonical: 'dev-created-request',
			reason_code: typeof input.reason_code === 'string' ? input.reason_code : 'support_case',
			reason_note: typeof input.reason_note === 'string' ? input.reason_note : null,
			reuse_scope: input.reuse_scope === 'case' ? 'case' : 'request',
			policy_preset: policyPreset,
			partial_access_allowed: input.partial_access_allowed === true,
			has_detail: true,
			expires_at: createdAt + 21600,
			decided_at: null,
			created_at: createdAt,
			updated_at: createdAt,
			approvals: [
				{
					id: `dev-approval-step-${createdAt}`,
					approval_request_id: `dev-approval-${createdAt}`,
					step_key: 'operator-1',
					side: 'admin_operator',
					subject_type: 'admin_user',
					subject_id: 'dev-admin',
					status: 'pending',
					method: 'portal_confirm',
					transport_channel: 'admin_ui',
					last_notification_action: 'initial',
					last_notified_at: createdAt,
					notification_count: 1,
					expires_at: createdAt + 21600,
					created_at: createdAt,
					updated_at: createdAt
				}
			],
			grants: [],
			resolved_policy: {
				preset: policyPreset,
				request_ttl_seconds: 21600
			}
		};
		devApprovalRequests.set(requestId, request);
		return json(request, 201);
	}

	if (segments.length === 2 && segments[1] === 'preview' && method === 'POST') {
		const input = await readJson(event.request);
		const expiresAt = Math.floor(Date.now() / 1000) + 21600;
		const policyPreset =
			typeof input.policy_preset === 'string' ? input.policy_preset : 'support_case_default';
		return json({
			request: {
				investigation_id:
					typeof input.investigation_id === 'string' && input.investigation_id.trim()
						? input.investigation_id
						: `INV-DEV-${expiresAt}`,
				tenant_id: TENANT_ID,
				requester_subject_type: 'admin_user',
				requester_subject_id: 'dev-admin',
				target_subject_type:
					typeof input.target_subject_type === 'string' ? input.target_subject_type : 'user',
				target_subject_id:
					typeof input.target_subject_id === 'string' ? input.target_subject_id : 'dev-user',
				request_surface:
					typeof input.request_surface === 'string' ? input.request_surface : 'admin_audit',
				requested_action:
					typeof input.requested_action === 'string' ? input.requested_action : 'detail_read',
				redaction_level: input.redaction_level ?? 'masked',
				reason_code: typeof input.reason_code === 'string' ? input.reason_code : 'support_case',
				reason_note: typeof input.reason_note === 'string' ? input.reason_note : null,
				reference: null,
				ticket_reference: null,
				policy_preset: policyPreset,
				reuse_scope: input.reuse_scope === 'case' ? 'case' : 'request',
				partial_access_allowed: input.partial_access_allowed === true,
				expires_at: expiresAt,
				scope_json: {
					resource_class:
						typeof input.resource_class === 'string' ? input.resource_class : 'admin_audit_detail',
					resource_ids: Array.isArray(input.resource_ids) ? input.resource_ids : []
				},
				scope_canonical: 'dev-preview-request',
				resolved_policy: {
					preset: policyPreset,
					request_ttl_seconds: 21600,
					notification_cooldown_seconds: { remind: 900, resend: 1800 }
				}
			},
			steps: [
				{
					step_key: 'operator-1',
					side: 'admin_operator',
					subject_type: 'admin_user',
					subject_id: 'dev-admin',
					expires_at: expiresAt,
					method: 'portal_confirm',
					transport_channel: 'admin_ui',
					acceptable_methods: ['portal_confirm', 'passkey'],
					selection_source: 'policy_default',
					guidance_title: 'Dev mock approval',
					guidance_body: 'Use the dev mock portal confirmation to complete this step.'
				}
			]
		});
	}

	const requestId = segments[1];
	if (!requestId) return null;
	const request = devApprovalRequests.get(requestId);
	if (!request) {
		return json({ error: 'not_found', error_description: 'Approval request not found' }, 404);
	}

	if (segments.length === 2 && method === 'GET') return json(request);

	if (segments.length === 3 && segments[2] === 'evidence' && method === 'GET') {
		return json({
			version: 1,
			request: {
				public_request_id: request.public_request_id,
				investigation_id: request.investigation_id,
				request_surface: request.request_surface,
				requested_action: request.requested_action,
				target_subject_type: request.target_subject_type,
				target_subject_id: request.target_subject_id,
				redaction_level: request.redaction_level,
				status: request.status,
				reason_code: request.reason_code,
				reason_note: request.reason_note ?? null,
				reference: request.reference ?? null,
				ticket_reference: request.ticket_reference ?? null,
				policy_preset: request.policy_preset,
				reuse_scope: request.reuse_scope,
				partial_access_allowed: request.partial_access_allowed,
				scope_json: request.scope_json,
				requested_at: request.created_at,
				expires_at: request.expires_at,
				decided_at: request.decided_at ?? null
			},
			events: [
				{
					id: `dev-event-${request.public_request_id}-created`,
					kind: 'request_created',
					at: request.created_at,
					actor_subject_type: request.requester_subject_type,
					actor_subject_id: request.requester_subject_id,
					request_status: request.status,
					reason_code: request.reason_code,
					reason_note: request.reason_note ?? null
				},
				...request.approvals.map((approval) => ({
					id: `dev-event-${approval.id}`,
					kind:
						approval.status === 'pending' ? 'step_initial' : (`step_${approval.status}` as const),
					at: approval.decided_at ?? approval.last_notified_at ?? approval.created_at,
					request_status: request.status,
					approval_step: {
						id: approval.id,
						step_key: approval.step_key,
						side: approval.side,
						subject_type: approval.subject_type,
						subject_id: approval.subject_id ?? null,
						relation_type: approval.relation_type ?? null,
						relation_source: approval.relation_source ?? null,
						status: approval.status
					},
					method: approval.method ?? null,
					transport_channel: approval.transport_channel ?? null,
					reason_code: approval.reason_code ?? null,
					reason_note: approval.reason_note ?? null,
					notification_action: approval.last_notification_action ?? null,
					notification_count: approval.notification_count
				}))
			]
		});
	}

	if (segments.length === 3 && segments[2] === 'receipts' && method === 'GET') {
		const approvedSteps = request.approvals.filter((approval) => approval.status === 'approved');
		return json({
			request_id: request.public_request_id,
			investigation_id: request.investigation_id,
			items: approvedSteps.map((approval) => ({
				event_id: `dev-event-${approval.id}`,
				event_at: approval.decided_at ?? approval.updated_at,
				receipt_id: `receipt-${approval.id}`,
				path: `/api/admin/approvals/${request.public_request_id}/receipts/${approval.id}`,
				portal_path: `/admin/approvals/${request.public_request_id}`,
				decision: approval.status,
				request_status: request.status,
				expires_at: request.expires_at,
				grant_ids: request.grants.map((grant) => grant.public_grant_id),
				receipt: {
					receipt_id: `receipt-${approval.id}`,
					artifact_id: `artifact-${approval.id}`,
					request_id: request.public_request_id,
					approval_id: approval.id,
					step_key: approval.step_key,
					investigation_id: request.investigation_id,
					request_surface: request.request_surface,
					requested_action: request.requested_action,
					method: approval.method ?? 'portal_confirm',
					transport_channel: approval.transport_channel ?? null,
					decision: approval.status,
					request_status: request.status,
					grant_ids: request.grants.map((grant) => grant.public_grant_id),
					completed_at: approval.decided_at ?? approval.updated_at,
					expires_at: request.expires_at
				}
			}))
		});
	}

	if (
		segments.length === 5 &&
		segments[2] === 'steps' &&
		segments[4] === 'guide' &&
		method === 'GET'
	) {
		const approval = request.approvals.find((item) => item.id === segments[3]);
		if (!approval) {
			return json({ error: 'not_found', error_description: 'Approval step not found' }, 404);
		}
		return json({
			request_id: request.public_request_id,
			approval_id: approval.id,
			step_key: approval.step_key,
			status: approval.status,
			expires_at: approval.expires_at,
			selection_source: 'policy_default',
			resolution_error: null,
			guide: {
				mode: 'artifact_only',
				method: approval.method ?? 'portal_confirm',
				transport_channel: approval.transport_channel ?? null,
				acceptable_methods: ['portal_confirm', 'passkey'],
				guidance_title: 'Dev mock approval step',
				guidance_body: 'This dev mock step is available for Admin UI theme verification.',
				fallback_note: null
			}
		});
	}

	return null;
}

function devRegionShardConfig(
	totalShards: number,
	distribution: Record<string, unknown>,
	updatedAt: number
) {
	let cursor = 0;
	const entries = Object.entries(distribution)
		.map(([region, value]) => ({
			region,
			percent: typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
		}))
		.filter((item) => item.percent > 0);
	const totalPercent = entries.reduce((sum, item) => sum + item.percent, 0) || 100;
	const currentRegions: Record<
		string,
		{ startShard: number; endShard: number; shardCount: number }
	> = {};

	entries.forEach((item, index) => {
		const remaining = totalShards - cursor;
		const shardCount =
			index === entries.length - 1
				? remaining
				: Math.max(1, Math.round((totalShards * item.percent) / totalPercent));
		const boundedShardCount = Math.max(1, Math.min(remaining, shardCount));
		currentRegions[item.region] = {
			startShard: cursor,
			endShard: cursor + boundedShardCount - 1,
			shardCount: boundedShardCount
		};
		cursor += boundedShardCount;
	});

	return {
		currentGeneration: 1,
		currentTotalShards: totalShards,
		currentRegions,
		previousGenerations: [],
		maxPreviousGenerations: 2,
		updatedAt,
		updatedBy: 'dev-admin',
		version: 1,
		groups: {
			default: {
				totalShards,
				members: Object.keys(currentRegions),
				description: 'Dev mock global region shard group'
			}
		},
		validation: {
			valid: true,
			errors: [],
			warnings: []
		}
	};
}

async function handleSettings(event: RequestEvent, segments: string[]): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] === 'settings') {
		if (
			segments[1] === 'code-shards' ||
			segments[1] === 'revocation-shards' ||
			segments[1] === 'session-shards' ||
			segments[1] === 'challenge-shards'
		) {
			if (method === 'PUT') {
				const input = await readJson(event.request);
				const shards =
					typeof input.shards === 'number' && Number.isFinite(input.shards)
						? Math.max(1, Math.floor(input.shards))
						: devShardSettings[segments[1]];
				devShardSettings[segments[1]] = shards;
				return json({
					success: true,
					shards,
					note: 'Dev mock shard setting updated'
				});
			}
			return json({
				current: devShardSettings[segments[1]],
				source: 'kv',
				kv_value: devShardSettings[segments[1]],
				env_value: null,
				default_value: 4
			});
		}
		if (segments[1] === 'refresh-token-sharding') {
			if (method === 'PUT') {
				const input = await readJson(event.request);
				const shardCount =
					typeof input.shardCount === 'number' && Number.isFinite(input.shardCount)
						? Math.max(1, Math.floor(input.shardCount))
						: devShardSettings['refresh-token-sharding'];
				devShardSettings['refresh-token-sharding'] = shardCount;
				return json({
					success: true,
					shardCount,
					note: 'Dev mock refresh token sharding updated'
				});
			}
			const now = Math.floor(Date.now() / 1000);
			return json({
				clientId: 'global',
				config: {
					currentGeneration: 1,
					currentShardCount: devShardSettings['refresh-token-sharding'],
					previousGenerations: [],
					updatedAt: now,
					updatedBy: 'dev-admin'
				}
			});
		}
		if (segments[1] === 'region-shards') {
			const now = Math.floor(Date.now() / 1000);
			if (method === 'PUT') {
				const input = await readJson(event.request);
				const totalShards =
					typeof input.totalShards === 'number' && Number.isFinite(input.totalShards)
						? Math.max(1, Math.floor(input.totalShards))
						: 16;
				const distribution =
					input.distribution && typeof input.distribution === 'object'
						? (input.distribution as Record<string, unknown>)
						: { apac: 25, enam: 25, weur: 25, wnam: 25 };
				return json(devRegionShardConfig(totalShards, distribution, now));
			}
			return json(devRegionShardConfig(16, { apac: 25, enam: 25, weur: 25, wnam: 25 }, now - 3600));
		}
		if (segments[1] === 'meta' && segments[2]) {
			return json(settingsMetaResponse(segments[2]));
		}
		if (segments[1] === 'ui-config') {
			if (method === 'PUT') {
				const input = await readJson(event.request);
				const baseUrl =
					typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl.trim() : null;
				const inputPaths =
					input.paths && typeof input.paths === 'object'
						? (input.paths as Record<string, unknown>)
						: {};
				devUiConfig = {
					baseUrl,
					paths: {
						...devUiConfig.paths,
						...Object.fromEntries(
							Object.entries(inputPaths)
								.filter(([, value]) => typeof value === 'string')
								.map(([key, value]) => [key, String(value)])
						)
					}
				};
				return json({ config: devUiConfig });
			}
			return json(uiConfigResponse());
		}
		if (segments[1] === 'cache-mode' && segments[2] === 'info') {
			return json({
				modes: {
					maintenance: {
						description: 'Short TTLs for configuration rollout and emergency operations.',
						ttl_config: maintenanceCacheTTLConfig,
						use_cases: ['Configuration rollout', 'Incident response']
					},
					fixed: {
						description: 'Stable TTLs for normal production operation.',
						ttl_config: fixedCacheTTLConfig,
						use_cases: ['Normal operation', 'Reduced backend load']
					}
				},
				default_mode: 'fixed',
				hierarchy: {
					description: 'Client cache mode can inherit the platform default.',
					order: ['client', 'platform', 'default']
				},
				kv_key_version: 'dev-mock',
				note: 'Admin UI dev mock response'
			});
		}
		if (segments[1] === 'cache-mode') {
			if (method === 'POST') {
				const input = await readJson(event.request);
				const mode = input.mode === 'maintenance' ? 'maintenance' : 'fixed';
				return json({
					success: true,
					mode,
					effective: mode,
					ttl_config: mode === 'maintenance' ? maintenanceCacheTTLConfig : fixedCacheTTLConfig,
					message: 'Dev mock cache mode updated'
				});
			}
			return json(devPlatformCacheModeResponse());
		}
		if (segments[1] === 'meta') {
			return json({
				categories: [
					{ category: 'tenant', label: 'Tenant', description: 'Tenant settings', settingsCount: 1 },
					{
						category: 'login-ui',
						label: 'Login UI',
						description: 'Login UI customization settings',
						settingsCount: 0
					}
				]
			});
		}
		return null;
	}

	if (segments[0] === 'platform' && segments[1] === 'settings') {
		return json(getSettings(TENANT_ID, segments[2] || 'platform'));
	}

	if (segments[0] !== 'tenants') return null;
	if (segments.length === 1 && method === 'GET') {
		const items = [...tenants.values()];
		return json({
			tenants: items,
			total: items.length,
			tenant_d1_pool: { enabled: false },
			single_tenant_mode: false,
			single_tenant_reason: null
		});
	}

	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const id = typeof input.id === 'string' ? input.id.trim() : '';
		const name = typeof input.name === 'string' ? input.name.trim() : '';
		const tenantCode =
			typeof input.tenant_code === 'string' && input.tenant_code.trim()
				? input.tenant_code.trim()
				: id;
		if (!id || !name) {
			return json({ error_description: 'id and name are required' }, 400);
		}
		if (tenants.has(id)) {
			return json({ error_description: 'Tenant already exists' }, 409);
		}
		const now = Date.now();
		const tenant: DevTenant = {
			id,
			tenant_code: tenantCode,
			name,
			description:
				typeof input.description === 'string' && input.description.trim()
					? input.description.trim()
					: null,
			lifecycle_state: 'active',
			is_default: tenants.size === 0,
			created_at: now,
			updated_at: now
		};
		tenants.set(id, tenant);
		return json(tenant, 201);
	}

	if (segments.length === 3 && segments[2] === 'invitations' && method === 'GET') {
		const tenantId = segments[1];
		const now = Math.floor(Date.now() / 1000);
		const includeExpired = event.url.searchParams.get('include_expired') === 'true';
		const items = [...tenantInvitations.values()].filter(
			(invitation) =>
				invitation.tenant_id === tenantId && (includeExpired || invitation.expires_at >= now)
		);
		return json({ items, total: items.length });
	}

	if (segments.length === 3 && segments[2] === 'invitations' && method === 'POST') {
		const tenantId = segments[1];
		if (!tenants.has(tenantId)) return json({ error_description: 'Tenant not found' }, 404);
		const input = await readJson(event.request);
		const now = Math.floor(Date.now() / 1000);
		const expiresInHours =
			typeof input.expires_in_hours === 'number' && Number.isFinite(input.expires_in_hours)
				? Math.max(1, Math.floor(input.expires_in_hours))
				: 72;
		const id = `tenant-invite-dev-${Date.now()}`;
		const invitation: DevTenantInvitation = {
			id,
			tenant_id: tenantId,
			invited_email:
				typeof input.invited_email === 'string' && input.invited_email.trim()
					? input.invited_email.trim()
					: null,
			invited_by: 'admin-dev-admin',
			role_id:
				typeof input.role_id === 'string' && input.role_id.trim() ? input.role_id.trim() : null,
			org_id: typeof input.org_id === 'string' && input.org_id.trim() ? input.org_id.trim() : null,
			max_uses:
				typeof input.max_uses === 'number' && Number.isFinite(input.max_uses)
					? Math.floor(input.max_uses)
					: 1,
			use_count: 0,
			expires_at: now + expiresInHours * 3600,
			created_at: now,
			updated_at: now
		};
		tenantInvitations.set(id, invitation);
		return json(
			{
				id,
				token: `dev-token-${id}`,
				invite_url: `${event.url.origin}/login/invitations/dev-token-${id}`,
				expires_at: invitation.expires_at,
				email_sent: !!invitation.invited_email
			},
			201
		);
	}

	if (segments.length === 4 && segments[2] === 'invitations' && method === 'DELETE') {
		const invitation = tenantInvitations.get(segments[3]);
		if (!invitation || invitation.tenant_id !== segments[1]) {
			return json({ error_description: 'Invitation not found' }, 404);
		}
		tenantInvitations.delete(segments[3]);
		return json({ success: true });
	}

	if (segments.length === 2 && method === 'GET') {
		const tenant = tenants.get(segments[1]);
		if (!tenant) return json({ error_description: 'Tenant not found' }, 404);
		return json(tenant);
	}

	if (segments[2] === 'info') return json(buildTenantInfo(event.url.origin));
	if (segments[2] === 'clients') return json(listClients());
	if (segments[2] === 'settings') {
		const tenantId = segments[1] || getTenantId(event);
		const category = segments[3] || 'tenant';
		const current = getSettings(tenantId, category);
		if (method === 'GET') return json(current);
		if (method === 'PATCH') {
			const input = await readJson(event.request);
			const set =
				input.set && typeof input.set === 'object' && !Array.isArray(input.set)
					? (input.set as Record<string, unknown>)
					: {};
			const clear = Array.isArray(input.clear) ? input.clear.map(String) : [];
			for (const [key, value] of Object.entries(set)) {
				if (value !== undefined) {
					current.values[key] = value;
					current.sources[key] = 'kv';
				}
			}
			for (const key of clear) {
				delete current.values[key];
				delete current.sources[key];
			}
			current.version = nextVersion(current.version);
			return json({
				applied: Object.keys(set),
				cleared: clear,
				disabled: [],
				rejected: {},
				version: current.version
			});
		}
	}
	return null;
}

async function handleScopedClientSettings(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'clients' || segments[2] !== 'settings') return null;
	const clientId = segments[1];
	const category = segments[3] || 'client';
	const current = getSettings(getTenantId(event), category, clientId);
	if (method === 'GET') return json(current);
	if (method === 'PATCH') {
		const input = await readJson(event.request);
		const set =
			input.set && typeof input.set === 'object' && !Array.isArray(input.set)
				? (input.set as Record<string, unknown>)
				: {};
		for (const [key, value] of Object.entries(set)) {
			if (value !== undefined) {
				current.values[key] = value;
				current.sources[key] = 'kv';
			}
		}
		current.version = nextVersion(current.version);
		return json({
			applied: Object.keys(set),
			cleared: [],
			disabled: [],
			rejected: {},
			version: current.version
		});
	}
	return null;
}

function consentStatementVersionsFor(statementId: string): DevConsentStatementVersion[] {
	return consentStatementVersions.get(statementId) ?? [];
}

function consentLocalizationsFor(versionId: string): DevConsentStatementLocalization[] {
	return consentStatementLocalizations.get(versionId) ?? [];
}

function consentPolicyItemsFor(
	policyId: string
): Array<DevConsentPolicyItem & Record<string, unknown>> {
	return (consentPolicyItems.get(policyId) ?? [])
		.map((item) => {
			const statement = consentStatements.get(item.statement_id);
			return {
				...item,
				statement_slug: statement?.slug,
				statement_category: statement?.category
			};
		})
		.sort((a, b) => a.display_order - b.display_order);
}

function normalizedPolicyTarget(type: string, targetId: unknown): string {
	return type === 'tenant_default' ? '' : typeof targetId === 'string' ? targetId.trim() : '';
}

async function handleConsentPolicies(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method.toUpperCase();
	const now = Date.now();

	if (segments[0] === 'client-trust-policies') {
		if (method === 'GET') return json({ policies: [...clientTrustPolicies.values()] });
		if (method === 'PUT') {
			const input = await readJson(event.request);
			const targetType = typeof input.target_type === 'string' ? input.target_type.trim() : '';
			const targetId = normalizedPolicyTarget(targetType, input.target_id);
			if (!targetType) {
				return json(
					{ error: 'invalid_request', error_description: 'target_type is required' },
					400
				);
			}
			const key = `${targetType}:${targetId}`;
			const existing = clientTrustPolicies.get(key);
			const name =
				typeof input.name === 'string' && input.name.trim()
					? input.name.trim()
					: `${targetType}-${targetId || 'default'}-trust`;
			clientTrustPolicies.set(key, {
				id: existing?.id ?? `trust-${targetType}-${targetId || 'default'}`,
				tenant_id: TENANT_ID,
				name,
				display_name:
					typeof input.display_name === 'string' && input.display_name.trim()
						? input.display_name.trim()
						: name,
				description:
					typeof input.description === 'string' ? input.description : existing?.description,
				target_type: targetType as DevClientTrustPolicy['target_type'],
				target_id: targetId,
				first_party: input.first_party ? 1 : 0,
				trusted: input.trusted ? 1 : 0,
				skip_authorization_consent: input.skip_authorization_consent ? 1 : 0,
				is_active: input.is_active === false ? 0 : 1,
				created_at: existing?.created_at ?? now,
				updated_at: now
			});
			return json({ policies: [...clientTrustPolicies.values()] });
		}
		return null;
	}

	if (segments[0] === 'sign-in-confirmation-policies') {
		if (method === 'GET') return json({ policies: [...signInConfirmationPolicies.values()] });
		if (method === 'PUT') {
			const input = await readJson(event.request);
			const existing = signInConfirmationPolicies.get('login');
			const mode =
				input.mode === 'first_time' || input.mode === 'every_time' ? input.mode : 'disabled';
			signInConfirmationPolicies.set('login', {
				id: existing?.id ?? 'signin-confirmation-login',
				tenant_id: TENANT_ID,
				name:
					typeof input.name === 'string' && input.name.trim()
						? input.name.trim()
						: 'login-sign-in-confirmation',
				display_name:
					typeof input.display_name === 'string' && input.display_name.trim()
						? input.display_name.trim()
						: 'Login sign-in confirmation',
				description:
					typeof input.description === 'string' ? input.description : existing?.description,
				trigger_type: 'login',
				mode,
				remember_duration_days:
					typeof input.remember_duration_days === 'number' ? input.remember_duration_days : 365,
				show_application_context: input.show_application_context === false ? 0 : 1,
				show_tenant_context: input.show_tenant_context === false ? 0 : 1,
				is_active: input.is_active === false ? 0 : 1,
				created_at: existing?.created_at ?? now,
				updated_at: now
			});
			return json({ policies: [...signInConfirmationPolicies.values()] });
		}
		return null;
	}

	if (segments[0] !== 'consent-policies') return null;
	const policyId = segments[1];
	const policy = policyId ? consentPolicies.get(policyId) : undefined;

	if (!policyId && method === 'GET') {
		return json({
			policies: [...consentPolicies.values()].map((item) => ({
				...item,
				item_count: consentPolicyItems.get(item.id)?.length ?? 0
			}))
		});
	}

	if (!policyId && method === 'POST') {
		const input = await readJson(event.request);
		const name =
			typeof input.name === 'string' && input.name.trim() ? input.name.trim() : `policy-${now}`;
		const id = `policy-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
		const policy: DevConsentPolicy = {
			id,
			tenant_id: TENANT_ID,
			name,
			display_name:
				typeof input.display_name === 'string' && input.display_name.trim()
					? input.display_name.trim()
					: name,
			description: typeof input.description === 'string' ? input.description : null,
			is_active: input.is_active === false ? 0 : 1,
			created_at: now,
			updated_at: now
		};
		consentPolicies.set(id, policy);
		consentPolicyItems.set(id, []);
		return json({ policy }, 201);
	}

	if (!policyId || !policy) {
		return json({ error: 'not_found', error_description: 'Consent policy not found' }, 404);
	}

	if (segments.length === 2 && method === 'GET') {
		return json({ policy, items: consentPolicyItemsFor(policyId) });
	}

	if (segments.length === 2 && method === 'PUT') {
		const input = await readJson(event.request);
		const updated: DevConsentPolicy = {
			...policy,
			name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : policy.name,
			display_name:
				typeof input.display_name === 'string' && input.display_name.trim()
					? input.display_name.trim()
					: policy.display_name,
			description: typeof input.description === 'string' ? input.description : policy.description,
			is_active: input.is_active === false ? 0 : input.is_active === true ? 1 : policy.is_active,
			updated_at: now
		};
		consentPolicies.set(policyId, updated);
		return json({ policy: updated, items: consentPolicyItemsFor(policyId) });
	}

	if (segments.length === 2 && method === 'DELETE') {
		consentPolicies.delete(policyId);
		consentPolicyItems.delete(policyId);
		return json({ success: true });
	}

	if (segments[2] === 'items' && method === 'PUT') {
		const input = await readJson(event.request);
		const items = Array.isArray(input.items) ? input.items : [];
		consentPolicyItems.set(
			policyId,
			items.map((item, index) => ({
				id: `policy-item-${policyId}-${item.statement_id ?? index}`,
				tenant_id: TENANT_ID,
				policy_id: policyId,
				statement_id: String(item.statement_id ?? ''),
				requirement: (item.requirement || 'required') as DevConsentPolicyItem['requirement'],
				version_mode: (item.version_mode || 'current') as DevConsentPolicyItem['version_mode'],
				version_id: typeof item.version_id === 'string' ? item.version_id : null,
				min_version: typeof item.min_version === 'string' ? item.min_version : null,
				checkbox_mode: (item.checkbox_mode || 'required') as DevConsentPolicyItem['checkbox_mode'],
				checkbox_default_checked: item.checkbox_default_checked ? 1 : 0,
				binding_type:
					typeof item.binding_type === 'string' && item.binding_type
						? (item.binding_type as DevConsentPolicyItem['binding_type'])
						: null,
				binding_value: typeof item.binding_value === 'string' ? item.binding_value : null,
				evidence_profile: typeof item.evidence_profile === 'string' ? item.evidence_profile : null,
				language_fallback:
					typeof item.language_fallback === 'string' ? item.language_fallback : null,
				display_order: typeof item.display_order === 'number' ? item.display_order : index,
				created_at: now,
				updated_at: now
			}))
		);
		return json({ items: consentPolicyItemsFor(policyId) });
	}

	return null;
}

async function handleConsentStatements(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	const now = Date.now();

	if (segments[0] === 'consent-requirements') {
		const statementId = segments[1];
		if (!statementId && method === 'GET') {
			return json({ requirements: [...consentRequirements.values()] });
		}
		if (!statementId) return null;

		if (method === 'PUT') {
			const input = await readJson(event.request);
			const existing = consentRequirements.get(statementId);
			const requirement: DevTenantConsentRequirement = {
				id: existing?.id ?? `requirement-${statementId}`,
				tenant_id: TENANT_ID,
				statement_id: statementId,
				is_required:
					typeof input.is_required === 'number' ? input.is_required : (existing?.is_required ?? 1),
				min_version:
					typeof input.min_version === 'string' && input.min_version.trim()
						? input.min_version.trim()
						: existing?.min_version,
				enforcement:
					typeof input.enforcement === 'string' && input.enforcement.trim()
						? input.enforcement.trim()
						: (existing?.enforcement ?? 'block'),
				show_deletion_link:
					typeof input.show_deletion_link === 'number'
						? input.show_deletion_link
						: (existing?.show_deletion_link ?? 0),
				deletion_url:
					typeof input.deletion_url === 'string' && input.deletion_url.trim()
						? input.deletion_url.trim()
						: existing?.deletion_url,
				conditional_rules_json:
					typeof input.conditional_rules_json === 'string' && input.conditional_rules_json.trim()
						? input.conditional_rules_json.trim()
						: existing?.conditional_rules_json,
				display_order:
					typeof input.display_order === 'number'
						? input.display_order
						: (existing?.display_order ?? 0),
				created_at: existing?.created_at ?? now,
				updated_at: now
			};
			consentRequirements.set(statementId, requirement);
			return json({ requirement });
		}

		if (method === 'DELETE') {
			consentRequirements.delete(statementId);
			return new Response(null, { status: 204 });
		}

		return null;
	}

	if (segments[0] !== 'consent-statements') return null;
	const statementId = segments[1];
	const statement = statementId ? consentStatements.get(statementId) : undefined;

	if (!statementId && method === 'GET') {
		return json({ statements: [...consentStatements.values()] });
	}

	if (!statementId && method === 'POST') {
		const input = await readJson(event.request);
		const slug =
			typeof input.slug === 'string' && input.slug.trim() ? input.slug.trim() : `statement-${now}`;
		const id = `consent-${slug.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
		const statement: DevConsentStatement = {
			id,
			tenant_id: TENANT_ID,
			slug,
			category:
				typeof input.category === 'string' && input.category.trim()
					? input.category.trim()
					: 'custom',
			legal_basis:
				typeof input.legal_basis === 'string' && input.legal_basis.trim()
					? input.legal_basis.trim()
					: 'consent',
			processing_purpose:
				typeof input.processing_purpose === 'string' ? input.processing_purpose : undefined,
			record_retention_days:
				typeof input.record_retention_days === 'number' ? input.record_retention_days : null,
			withdrawal_allowed: input.withdrawal_allowed === false ? 0 : 1,
			withdrawal_impact:
				typeof input.withdrawal_impact === 'string' ? input.withdrawal_impact : null,
			reconsent_on_version_change: input.reconsent_on_version_change === false ? 0 : 1,
			reconsent_interval_days:
				typeof input.reconsent_interval_days === 'number' ? input.reconsent_interval_days : null,
			display_order: typeof input.display_order === 'number' ? input.display_order : 0,
			is_active: 1,
			created_at: now,
			updated_at: now
		};
		consentStatements.set(id, statement);
		return json({ statement }, 201);
	}

	if (!statementId || !statement) {
		return json({ error: 'not_found', error_description: 'Consent statement not found' }, 404);
	}

	if (segments.length === 2 && method === 'GET') {
		return json({ statement });
	}

	if (segments.length === 2 && method === 'PUT') {
		const input = await readJson(event.request);
		const updated: DevConsentStatement = {
			...statement,
			slug:
				typeof input.slug === 'string' && input.slug.trim() ? input.slug.trim() : statement.slug,
			category:
				typeof input.category === 'string' && input.category.trim()
					? input.category.trim()
					: statement.category,
			legal_basis:
				typeof input.legal_basis === 'string' && input.legal_basis.trim()
					? input.legal_basis.trim()
					: statement.legal_basis,
			processing_purpose:
				typeof input.processing_purpose === 'string'
					? input.processing_purpose
					: statement.processing_purpose,
			record_retention_days:
				input.record_retention_days === null || typeof input.record_retention_days === 'number'
					? input.record_retention_days
					: statement.record_retention_days,
			withdrawal_allowed:
				typeof input.withdrawal_allowed === 'boolean'
					? input.withdrawal_allowed
						? 1
						: 0
					: statement.withdrawal_allowed,
			withdrawal_impact:
				input.withdrawal_impact === null || typeof input.withdrawal_impact === 'string'
					? input.withdrawal_impact
					: statement.withdrawal_impact,
			reconsent_on_version_change:
				typeof input.reconsent_on_version_change === 'boolean'
					? input.reconsent_on_version_change
						? 1
						: 0
					: statement.reconsent_on_version_change,
			reconsent_interval_days:
				input.reconsent_interval_days === null || typeof input.reconsent_interval_days === 'number'
					? input.reconsent_interval_days
					: statement.reconsent_interval_days,
			display_order:
				typeof input.display_order === 'number' ? input.display_order : statement.display_order,
			is_active: typeof input.is_active === 'number' ? input.is_active : statement.is_active,
			updated_at: now
		};
		consentStatements.set(statementId, updated);
		return json({ statement: updated });
	}

	if (segments.length === 2 && method === 'DELETE') {
		consentStatements.delete(statementId);
		consentStatementVersions.delete(statementId);
		consentRequirements.delete(statementId);
		return new Response(null, { status: 204 });
	}

	if (segments[2] !== 'versions') return null;
	const versionId = segments[3];
	const versions = consentStatementVersionsFor(statementId);
	const version = versionId ? versions.find((item) => item.id === versionId) : undefined;

	if (!versionId && method === 'GET') {
		return json({ versions });
	}

	if (!versionId && method === 'POST') {
		const input = await readJson(event.request);
		const version: DevConsentStatementVersion = {
			id: `version-${statementId}-${now}`,
			tenant_id: TENANT_ID,
			statement_id: statementId,
			version:
				typeof input.version === 'string' && input.version.trim()
					? input.version.trim()
					: new Date(now).toISOString().slice(0, 10).replaceAll('-', ''),
			content_type:
				typeof input.content_type === 'string' && input.content_type.trim()
					? input.content_type.trim()
					: 'url',
			effective_at: typeof input.effective_at === 'number' ? input.effective_at : now,
			effective_until: typeof input.effective_until === 'number' ? input.effective_until : null,
			content_hash: `devhash${now}`,
			is_current: 0,
			status: 'draft',
			created_at: now,
			updated_at: now
		};
		consentStatementVersions.set(statementId, [...versions, version]);
		return json({ version }, 201);
	}

	if (!versionId || !version) {
		return json({ error: 'not_found', error_description: 'Consent version not found' }, 404);
	}

	if (segments.length === 4 && method === 'GET') {
		return json({ version });
	}

	if (segments.length === 4 && method === 'PUT') {
		const input = await readJson(event.request);
		const updated: DevConsentStatementVersion = {
			...version,
			version:
				typeof input.version === 'string' && input.version.trim()
					? input.version.trim()
					: version.version,
			content_type:
				typeof input.content_type === 'string' && input.content_type.trim()
					? input.content_type.trim()
					: version.content_type,
			effective_at:
				typeof input.effective_at === 'number' ? input.effective_at : version.effective_at,
			effective_until:
				input.effective_until === null || typeof input.effective_until === 'number'
					? input.effective_until
					: version.effective_until,
			updated_at: now
		};
		consentStatementVersions.set(
			statementId,
			versions.map((item) => (item.id === versionId ? updated : item))
		);
		return json({ version: updated });
	}

	if (segments.length === 5 && segments[4] === 'activate' && method === 'POST') {
		const updatedVersions = versions.map((item) => ({
			...item,
			is_current: item.id === versionId ? 1 : 0,
			status:
				item.id === versionId ? 'active' : item.status === 'active' ? 'archived' : item.status,
			updated_at: item.id === versionId ? now : item.updated_at
		}));
		consentStatementVersions.set(statementId, updatedVersions);
		return json({ version: updatedVersions.find((item) => item.id === versionId) ?? version });
	}

	if (segments.length === 4 && method === 'DELETE') {
		consentStatementVersions.set(
			statementId,
			versions.filter((item) => item.id !== versionId)
		);
		consentStatementLocalizations.delete(versionId);
		return new Response(null, { status: 204 });
	}

	if (segments[4] !== 'localizations') return null;
	const language = segments[5];
	const localizations = consentLocalizationsFor(versionId);

	if (!language && method === 'GET') {
		return json({ localizations });
	}

	if (language && method === 'PUT') {
		const input = await readJson(event.request);
		const existing = localizations.find((item) => item.language === language);
		const localization: DevConsentStatementLocalization = {
			id: existing?.id ?? `localization-${versionId}-${language}`,
			tenant_id: TENANT_ID,
			version_id: versionId,
			language,
			title:
				typeof input.title === 'string' && input.title.trim()
					? input.title.trim()
					: (existing?.title ?? language),
			description:
				typeof input.description === 'string' ? input.description : (existing?.description ?? ''),
			processing_purpose:
				typeof input.processing_purpose === 'string'
					? input.processing_purpose
					: existing?.processing_purpose,
			withdrawal_impact:
				typeof input.withdrawal_impact === 'string'
					? input.withdrawal_impact
					: existing?.withdrawal_impact,
			document_url:
				typeof input.document_url === 'string' && input.document_url.trim()
					? input.document_url.trim()
					: existing?.document_url,
			inline_content:
				typeof input.inline_content === 'string' && input.inline_content.trim()
					? input.inline_content
					: existing?.inline_content,
			created_at: existing?.created_at ?? now,
			updated_at: now
		};
		consentStatementLocalizations.set(versionId, [
			...localizations.filter((item) => item.language !== language),
			localization
		]);
		return json({ localization });
	}

	if (language && method === 'DELETE') {
		consentStatementLocalizations.set(
			versionId,
			localizations.filter((item) => item.language !== language)
		);
		return new Response(null, { status: 204 });
	}

	return null;
}

async function handleLoggingPolicies(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	if (segments[0] !== 'logging-policies') return null;
	const method = event.request.method;
	if (method !== 'GET') return null;
	const now = Date.now();
	const tenantId = event.url.searchParams.get('tenant_id') || getTenantId(event);

	if (segments[1] === 'message-jobs') {
		return json({
			items: [
				{
					id: 'dev-message-job-critical-retry',
					kind: 'retry_delivery',
					status: 'retrying',
					lane: 'critical',
					criticality: 'critical',
					priority: 90,
					tenant_key: 'dev-tenant',
					topology_type: 'single_tenant',
					scope_type: 'tenant',
					scope_id: tenantId,
					scope_key: tenantId,
					source_type: 'delivery_event',
					source_id: 'dev-delivery-event-1',
					root_job_id: null,
					parent_job_id: null,
					depth: 0,
					payload_object_ref: 'r2://authrim-dev/logging/jobs/dev-message-job-critical-retry.json',
					payload_sha256: 'devsha256criticalretry',
					payload_type: 'logging.delivery.retry',
					payload_schema_version: 1,
					redacted_summary: { destination: 'critical-http-sink' },
					validation_summary: { valid: true },
					idempotency_key: 'dev-message-job-critical-retry',
					dedupe_until: now + 3600 * 1000,
					not_before: now - 300000,
					attempt_count: 2,
					max_attempts: 5,
					attempt_policy: { maxAttempts: 5, leaseTimeoutMs: 60000, backoffMs: 300000 },
					has_claim_token: false,
					claimed_at: null,
					claimed_until: null,
					requested_by: 'dev-admin',
					reason: 'retry failed critical delivery',
					error_class: 'upstream_timeout',
					last_error: 'HTTP sink timeout',
					blocked_reason: null,
					cancel_requested_at: null,
					cancelled_by: null,
					created_at: now - 1800000,
					updated_at: now - 300000,
					started_at: now - 1500000,
					completed_at: null,
					expires_at: now + 86400 * 1000
				}
			],
			total: 1
		});
	}

	if (segments.length === 1) {
		return json({
			item: {
				tenant_id: tenantId,
				version: 7,
				assignments: [
					{
						id: 'dev-logging-assignment-audit-archive',
						tenant_id: tenantId,
						log_type: 'audit',
						plane: 'archive',
						destination_id: 'dev-r2-diagnostic-logs',
						destination_name: 'Diagnostic R2 Archive',
						destination_provider: 'r2',
						enabled: 1,
						managed_by: 'admin',
						created_at: now - 86400 * 1000 * 18,
						updated_at: now - 86400 * 1000
					},
					{
						id: 'dev-logging-assignment-security-primary',
						tenant_id: tenantId,
						log_type: 'security',
						plane: 'primary',
						destination_id: 'DB',
						destination_name: 'Shared D1',
						destination_provider: 'd1',
						enabled: 1,
						managed_by: 'setup',
						created_at: now - 86400 * 1000 * 30,
						updated_at: now - 86400 * 1000 * 2
					},
					{
						id: 'dev-logging-assignment-webhook-sink',
						tenant_id: tenantId,
						log_type: 'webhook',
						plane: 'external_sink',
						destination_id: 'dev-http-sink',
						destination_name: 'HTTP Audit Sink',
						destination_provider: 'http',
						enabled: 0,
						managed_by: 'admin',
						created_at: now - 86400 * 1000 * 10,
						updated_at: now - 86400 * 1000 * 3
					}
				],
				fallbacks: [
					{
						id: 'dev-logging-fallback-audit',
						scope_type: 'tenant',
						scope_id: tenantId,
						log_type: 'audit',
						plane: 'archive',
						fallback_destination_id: 'dev-r2-diagnostic-logs',
						failure_mode: 'retry_then_dlq',
						created_at: now - 86400 * 1000 * 12,
						updated_at: now - 86400 * 1000
					},
					{
						id: 'dev-logging-fallback-security',
						scope_type: 'platform',
						scope_id: 'global',
						log_type: 'security',
						plane: 'external_sink',
						fallback_destination_id: null,
						failure_mode: 'drop_non_critical',
						created_at: now - 86400 * 1000 * 8,
						updated_at: now - 86400 * 1000 * 4
					}
				],
				snapshots: [
					{
						id: 'dev-logging-snapshot-7',
						scope_type: 'tenant',
						scope_id: tenantId,
						version: 7,
						status: 'published',
						policy_hash: 'dev-policy-hash-7',
						object_ref: 'r2://diagnostic-logs/logging-policy/dev-tenant/v7.json',
						created_at: now - 86400 * 1000 * 2,
						published_at: now - 86400 * 1000
					},
					{
						id: 'dev-logging-snapshot-6',
						scope_type: 'tenant',
						scope_id: tenantId,
						version: 6,
						status: 'archived',
						policy_hash: 'dev-policy-hash-6',
						object_ref: 'r2://diagnostic-logs/logging-policy/dev-tenant/v6.json',
						created_at: now - 86400 * 1000 * 12,
						published_at: now - 86400 * 1000 * 11
					}
				]
			}
		});
	}

	if (segments[1] === 'delivery-summary') {
		return json({
			item: {
				window_start_at: Number(event.url.searchParams.get('time_start')) || now - 86400 * 1000,
				window_end_at: now,
				items: [
					{
						lane: 'standard',
						status: 'delivered',
						log_type: 'audit',
						plane: 'archive',
						batch_count: 18,
						record_count: 1240,
						byte_count: 184320,
						attempt_count_sum: 18,
						first_seen_at: now - 86400 * 1000,
						last_seen_at: now - 600000
					},
					{
						lane: 'critical',
						status: 'queued',
						log_type: 'security',
						plane: 'external_sink',
						batch_count: 2,
						record_count: 28,
						byte_count: 8192,
						attempt_count_sum: 2,
						first_seen_at: now - 3600000,
						last_seen_at: now - 300000
					},
					{
						lane: 'standard',
						status: 'failed',
						log_type: 'webhook',
						plane: 'external_sink',
						batch_count: 1,
						record_count: 7,
						byte_count: 2048,
						attempt_count_sum: 3,
						first_seen_at: now - 7200000,
						last_seen_at: now - 1800000
					}
				]
			}
		});
	}

	if (segments[1] === 'notifications') {
		return json({
			items: [
				{
					id: 'dev-logging-notification-dlq',
					tenant_id: tenantId,
					category: 'logging_delivery',
					event_type: 'dlq_threshold',
					severity: 'warn',
					status: 'open',
					deduplication_key: 'dev-tenant:dlq',
					payload_json: JSON.stringify({ dlq_count: 7, lane: 'standard' }),
					attempts: 1,
					last_error: null,
					next_attempt_at: null,
					created_at: new Date(now - 1800000).toISOString(),
					updated_at: new Date(now - 1800000).toISOString(),
					delivered_at: null
				}
			],
			total: 1
		});
	}

	return null;
}

async function handleAdminLogging(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	if (segments[0] !== 'admin-logging') return null;

	const method = event.request.method;
	const now = Date.now();
	const tenantId = getTenantId(event);
	const coverageSummary = {
		covered: 18,
		gap_detected: 2,
		acknowledged: 1,
		ignored: 0,
		last_checked_at: now - 900000
	};
	const criticalSummary = {
		critical_destination_count: 2,
		failing_destination_count: 1,
		critical_assignment_count: 4,
		unprotected_assignment_count: 1
	};
	const sensitiveSummary = {
		chunked: true,
		encrypted: true,
		assignment_count: 5,
		policy_count: 3,
		indexed_object_class_count: 4,
		stale_key_count: 1
	};
	const coverageItems = [
		{
			operation_id: 'admin.clients.create',
			surface: 'clients',
			resource_type: 'oauth_client',
			required_audit: 'admin_audit',
			criticality: 'critical',
			status: 'covered',
			notes: 'create and rotate operations emit admin audit events'
		},
		{
			operation_id: 'admin.logging.destination.update',
			surface: 'logging',
			resource_type: 'logging_destination',
			required_audit: 'admin_audit',
			criticality: 'critical',
			status: 'gap_detected',
			notes: 'health-check retry path needs explicit audit evidence'
		},
		{
			operation_id: 'admin.tenant.discovery.preview',
			surface: 'tenant-discovery',
			resource_type: 'tenant_rule',
			required_audit: 'admin_audit',
			criticality: 'normal',
			status: 'acknowledged',
			notes: 'preview-only path accepted as low risk'
		}
	];
	const criticalPolicy = {
		summary: criticalSummary,
		destinations: [
			{
				id: 'dev-critical-http-sink',
				name: 'critical-http-sink',
				display_name: 'Critical HTTP Sink',
				provider: 'http',
				lifecycle_status: 'active',
				health_status: 'healthy',
				critical_allowed: 1,
				default_fallback_eligible: 1,
				last_health_check_at: now - 600000,
				version: 4
			},
			{
				id: 'dev-critical-r2-archive',
				name: 'critical-r2-archive',
				display_name: 'Critical R2 Archive',
				provider: 'r2',
				lifecycle_status: 'active',
				health_status: 'degraded',
				critical_allowed: 1,
				default_fallback_eligible: 1,
				last_health_check_at: now - 1200000,
				version: 7
			}
		],
		policies: [],
		assignments: []
	};
	const sensitivePolicy = {
		summary: sensitiveSummary,
		policies: [],
		assignments: [],
		index_summary: [
			{ object_class: 'approval_grant', total: 42, last_created_at: now - 420000 },
			{ object_class: 'session_risk', total: 19, last_created_at: now - 2400000 },
			{ object_class: 'webauthn_attestation', total: 7, last_created_at: now - 3600000 }
		],
		key_versions: [
			{ status: 'active', total: 3 },
			{ status: 'stale', total: 1 }
		]
	};
	const keyRegistryItems = [
		{
			id: 'dev-key-registry-audit-sensitive',
			tenant_key: 'dev-tenant',
			surface: 'admin',
			log_type: 'audit',
			plane: 'sensitive_detail',
			active_version: 3,
			registry_status: 'active',
			last_rotated_at: now - 86400 * 1000 * 12,
			registry_created_at: now - 86400 * 1000 * 90,
			registry_updated_at: now - 86400 * 1000,
			version: 2,
			backend_ref: 'dev-kms://audit-sensitive/v3',
			version_status: 'active',
			usage_count: 84,
			stale_count: 6,
			version_created_at: now - 86400 * 1000 * 12,
			retired_at: null
		}
	];
	const rewrapJobs = [
		{
			id: 'dev-rewrap-job-1',
			key_registry_id: 'dev-key-registry-audit-sensitive',
			from_version: 2,
			to_version: 3,
			priority: 80,
			status: 'queued',
			created_at: now - 1800000,
			started_at: null,
			completed_at: null,
			object_catalog_id: 'dev-sensitive-object-21',
			object_key: 'sensitive/dev-tenant/audit/21.jsonl',
			tenant_key: 'dev-tenant',
			log_type: 'audit',
			plane: 'sensitive_detail',
			reason: 'stale key version',
			error: null,
			metadata: {}
		}
	];
	const repairFindings = [
		{
			type: 'expired_pending_object',
			action: 'mark_orphan_candidate',
			safety: 'safe_auto',
			objectCatalogId: 'dev-object-catalog-9',
			tenantKey: 'dev-tenant',
			logType: 'audit',
			plane: 'archive',
			shard: '2026-06',
			reason: 'pending object exceeded the repair grace period'
		}
	];
	const catalogRepairJobs = [
		{
			id: 'dev-catalog-repair-job-1',
			job_kind: 'scan',
			status: 'completed',
			tenant_key: 'dev-tenant',
			log_type: 'audit',
			plane: 'archive',
			progress_current: 12,
			progress_total: 12,
			preview_artifact_ref: 'r2://authrim-dev/repair/preview-1.json',
			result: { finding_count: 1 },
			error_class: null,
			last_error: null,
			created_at: now - 7200000,
			updated_at: now - 6900000,
			completed_at: now - 6900000
		}
	];

	if (segments.length === 1 && method === 'GET') {
		return json({
			item: {
				tenant_id: tenantId,
				window_start_at: Number(event.url.searchParams.get('from')) || now - 24 * 3600 * 1000,
				coverage: coverageSummary,
				critical_protection: criticalSummary,
				sensitive_detail: sensitiveSummary,
				audit: {
					total: 1284,
					failures: 3,
					critical: 27
				},
				archive: [
					{ log_type: 'audit', plane: 'archive', status: 'sealed', chunks: 18, records: 1284 },
					{ log_type: 'security', plane: 'archive', status: 'open', chunks: 3, records: 188 }
				],
				delivery: [
					{ lane: 'standard', status: 'delivered', total: 119 },
					{ lane: 'critical', status: 'retrying', total: 2 }
				],
				recent_changes: [
					{
						audit_id: 'dev-audit-change-1',
						actor_id: 'dev-admin',
						action: 'logging.destination.update',
						resource_type: 'logging_destination',
						resource_id: 'dev-critical-http-sink',
						severity: 'critical',
						created_at: now - 900000
					},
					{
						audit_id: 'dev-audit-change-2',
						actor_id: 'dev-admin',
						action: 'client.secret.rotate',
						resource_type: 'client',
						resource_id: 'dev-oidc-client',
						severity: 'high',
						created_at: now - 3600000
					}
				]
			}
		});
	}

	if (segments[1] === 'coverage') {
		if (segments[2] === 'check' && method === 'POST') {
			return json({
				result: {
					checked_at: now,
					updated_count: 1,
					summary: coverageSummary
				},
				audit_id: 'dev-audit-coverage-check'
			});
		}
		if (method === 'GET') return json({ items: coverageItems, total: coverageItems.length });
	}

	if (segments[1] === 'critical-policy' && method === 'GET') {
		return json({ item: criticalPolicy });
	}

	if (segments[1] === 'sensitive-detail-policy' && method === 'GET') {
		return json({ item: sensitivePolicy });
	}

	if (segments[1] === 'sensitive-detail' && segments[2] === 'probe' && method === 'POST') {
		const input = await readJson(event.request);
		return json({
			item: {
				catalog_id: String(input.catalog_id || 'dev-sensitive-catalog-1'),
				public_artifact_id: 'dev-public-artifact-1',
				tenant_id: String(input.tenant_id || tenantId),
				object_class: String(input.object_class || 'approval_grant'),
				bucket_binding: 'AUTHRIM_LOG_SENSITIVE_DETAIL',
				object_key: 'sensitive/dev-tenant/approval-grant/dev.jsonl',
				content_encoding: 'identity',
				line_number: 12,
				byte_offset: 4096,
				byte_length: 884,
				key_version: 3,
				checksum_sha256: 'devsha256sensitiveprobe',
				created_at: now - 420000,
				adapter_binding: 'R2',
				read_status: 'readable',
				payload_shape: 'redacted-json'
			},
			audit_id: 'dev-audit-sensitive-probe'
		});
	}

	if (segments[1] === 'key-registry') {
		if (segments[3] === 'impact' && method === 'GET') {
			return json({
				item: {
					registry: keyRegistryItems[0],
					versions: [
						{ version: 2, status: 'stale' },
						{ version: 3, status: 'active' }
					],
					rewrap_jobs: rewrapJobs,
					checked_at: now
				}
			});
		}
		if (method === 'GET') return json({ items: keyRegistryItems, total: keyRegistryItems.length });
	}

	if (segments[1] === 'rewrap-jobs') {
		if (method === 'GET') return json({ items: rewrapJobs, total: rewrapJobs.length });
		if (method === 'POST') {
			return json({
				result: {
					key_registry_id: 'dev-key-registry-audit-sensitive',
					candidate_count: 6,
					created_count: 1,
					skipped_count: 5,
					created: rewrapJobs,
					skipped: []
				},
				audit_id: 'dev-audit-rewrap-create'
			});
		}
	}

	if (segments[1] === 'catalog-repairs') {
		if (segments[2] === 'apply-safe' && method === 'POST') {
			return json({
				result: {
					checked_at: now,
					finding_count: repairFindings.length,
					applied_count: 1,
					skipped_count: 0,
					applied: repairFindings,
					skipped: []
				},
				audit_id: 'dev-audit-catalog-repair'
			});
		}
		if (method === 'GET') return json({ items: repairFindings, total: repairFindings.length });
	}

	if (segments[1] === 'catalog-repair-jobs') {
		if (method === 'GET')
			return json({ items: catalogRepairJobs, total: catalogRepairJobs.length });
		if (segments[2] === 'scan' && method === 'POST') {
			return json({ result: catalogRepairJobs[0], job_id: catalogRepairJobs[0].id });
		}
		if (segments[2] === 'apply-safe' && method === 'POST') {
			return json({ result: catalogRepairJobs[0], audit_id: 'dev-audit-catalog-repair-job' });
		}
	}

	return null;
}

async function handleRuntimeProfiles(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	if (segments[0] !== 'runtime-profiles') return null;
	const method = event.request.method;

	if (segments[1] === 'defaults') {
		if (method === 'PUT') {
			const input = await readJson(event.request);
			runtimeProfileDefaults = {
				storageProfileId:
					typeof input.storageProfileId === 'string'
						? input.storageProfileId
						: runtimeProfileDefaults.storageProfileId,
				auditProfileId:
					typeof input.auditProfileId === 'string'
						? input.auditProfileId
						: runtimeProfileDefaults.auditProfileId,
				residencyProfileId:
					typeof input.residencyProfileId === 'string'
						? input.residencyProfileId
						: runtimeProfileDefaults.residencyProfileId
			};
			return json(runtimeDefaultsPayload());
		}
		return json(runtimeDefaultsPayload());
	}

	if (segments.length === 1 && method === 'GET') {
		const kind = event.url.searchParams.get('kind') || 'audit';
		return json(runtimeProfileListPayload(kind));
	}

	const kind = segments[1];
	const id = decodeURIComponent(segments[2] || '');
	if (!kind || !id) return null;

	const key = runtimeProfileKey(kind, id);
	if (method === 'GET') {
		const profile = runtimeProfiles.get(key);
		if (!profile) return json({ error: 'not_found', error_description: 'Profile not found' }, 404);
		return json({
			profile,
			reference_status: runtimeReferenceStatus(profile),
			activation_status: runtimeActivationStatus(profile),
			reference_management: runtimeReferenceManagement(),
			reference_catalog: runtimeReferenceCatalog(),
			...(kind === 'storage' ? { storage_policy: runtimeStoragePolicy() } : {})
		});
	}

	if (method === 'PUT') {
		const input = await readJson(event.request);
		const existing = runtimeProfiles.get(key);
		const profile = {
			...input,
			id,
			kind,
			label:
				typeof input.label === 'string' && input.label.trim()
					? input.label.trim()
					: existing?.label || id,
			version: Number(existing?.version || 0) + 1
		};
		runtimeProfiles.set(key, profile);
		return json({
			created: !existing,
			profile,
			reference_status: runtimeReferenceStatus(profile),
			activation_status: runtimeActivationStatus(profile),
			reference_management: runtimeReferenceManagement(),
			reference_catalog: runtimeReferenceCatalog()
		});
	}

	if (method === 'DELETE') {
		const profile = runtimeProfiles.get(key);
		if (profile?.builtin) {
			return json(
				{ error: 'builtin_profile', error_description: 'Builtin profile cannot be deleted' },
				409
			);
		}
		runtimeProfiles.delete(key);
		return json({ deleted: true });
	}

	return null;
}

async function handleTenantDomainMappings(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'platform' || segments[1] !== 'tenant-domain-mappings') return null;

	const mappingId = segments[2];
	const action = segments[2];
	const now = Math.floor(Date.now() / 1000);

	if (!mappingId && method === 'GET') {
		return json({ mappings: [...tenantDomainMappings.values()] });
	}

	if (!mappingId && method === 'POST') {
		const input = await readJson(event.request);
		const domain = typeof input.domain === 'string' ? input.domain.trim().toLowerCase() : '';
		const tenantId = typeof input.tenant_id === 'string' ? input.tenant_id.trim() : '';
		if (!domain || !tenantId) {
			return json({ error_description: 'domain and tenant_id are required' }, 400);
		}
		const id = `mapping-${domain.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`;
		const mapping: DevTenantDomainMapping = {
			id,
			tenant_id: tenantId,
			hash_version: 1,
			priority:
				typeof input.priority === 'number' && Number.isFinite(input.priority)
					? Math.floor(input.priority)
					: 0,
			is_active: true,
			verified: false,
			verification_expires_at: now + 86400 * 3,
			created_by: 'dev-admin',
			created_at: now,
			updated_at: now
		};
		tenantDomainMappings.set(id, mapping);
		return json({ mapping }, 201);
	}

	if (action === 'verify' && method === 'POST') {
		const input = await readJson(event.request);
		const id = typeof input.id === 'string' ? input.id : '';
		const domain = typeof input.domain === 'string' ? input.domain.trim().toLowerCase() : '';
		if (!id || !domain) return json({ error_description: 'id and domain are required' }, 400);
		if (!tenantDomainMappings.has(id)) {
			return json({ error_description: 'Domain mapping not found' }, 404);
		}
		return json({
			dns_record_type: 'TXT',
			dns_record_name: `_authrim-domain.${domain}`,
			dns_record_value: `authrim-domain-verification=${id}-dev-token`
		});
	}

	if (action === 'verify' && segments[3] === 'confirm' && method === 'POST') {
		const input = await readJson(event.request);
		const id = typeof input.id === 'string' ? input.id : '';
		const mapping = tenantDomainMappings.get(id);
		if (!mapping) return json({ error_description: 'Domain mapping not found' }, 404);
		const updated = {
			...mapping,
			verified: true,
			verification_expires_at: null,
			updated_at: now
		};
		tenantDomainMappings.set(id, updated);
		return json({ mapping: updated });
	}

	if (mappingId && method === 'DELETE') {
		if (!tenantDomainMappings.has(mappingId)) {
			return json({ error_description: 'Domain mapping not found' }, 404);
		}
		tenantDomainMappings.delete(mappingId);
		return json({ success: true });
	}

	return null;
}

async function handleTenantVanityDomains(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	const platformScoped = segments[0] === 'platform' && segments[1] === 'tenant-vanity-domains';
	const tenantScoped = segments[0] === 'tenant-vanity-domains';
	if (!platformScoped && !tenantScoped) return null;

	const baseIndex = platformScoped ? 1 : 0;
	const domainId = segments[baseIndex + 1];
	const action = segments[baseIndex + 2];
	const tenantFilter = event.url.searchParams.get('tenant_id') || undefined;
	const requestedTenantId = tenantFilter || getTenantId(event);

	if (!domainId && method === 'GET') {
		const domains = [...tenantVanityDomains.values()].filter(
			(domain) => platformScoped || domain.tenant_id === requestedTenantId
		);
		const filteredDomains = tenantFilter
			? domains.filter((domain) => domain.tenant_id === tenantFilter)
			: domains;
		return json({ domains: filteredDomains, cloudflare_configured: false });
	}

	if (!domainId && method === 'POST') {
		const input = await readJson(event.request);
		const hostname = typeof input.hostname === 'string' ? input.hostname.trim() : '';
		if (!hostname) return json({ error_description: 'hostname is required' }, 400);
		const now = Math.floor(Date.now() / 1000);
		const id = `vanity-${hostname.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
		const domain: DevTenantVanityDomain = {
			id,
			tenant_id: requestedTenantId,
			hostname,
			is_active: false,
			is_primary: input.is_primary === true,
			status: 'pending_manual',
			cloudflare_zone_id: null,
			cloudflare_custom_hostname_id: null,
			ssl_status: 'pending_validation',
			ownership_status: 'pending',
			validation_method: 'txt',
			validation_records: [{ type: 'TXT', name: `_authrim.${hostname}`, value: 'dev-mock-token' }],
			last_sync_at: null,
			created_by: 'dev-admin',
			created_at: now,
			updated_at: now
		};
		tenantVanityDomains.set(id, domain);
		return json({
			domain,
			cloudflare_configured: false,
			manual_setup_required: true,
			cloudflare_error: null
		});
	}

	const domain = tenantVanityDomains.get(domainId);
	if (!domain) return json({ error_description: 'Vanity domain not found' }, 404);

	if (!action && method === 'DELETE') {
		tenantVanityDomains.delete(domainId);
		return json({ success: true });
	}

	if (method === 'POST' && action === 'sync') {
		const updated = {
			...domain,
			last_sync_at: Math.floor(Date.now() / 1000),
			updated_at: Math.floor(Date.now() / 1000)
		};
		tenantVanityDomains.set(domainId, updated);
		return json({ domain: updated, cloudflare_configured: false });
	}

	if (method === 'POST' && action === 'verify') {
		const updated = {
			...domain,
			is_active: true,
			status: 'active' as const,
			ssl_status: 'active',
			ownership_status: 'verified',
			last_sync_at: Math.floor(Date.now() / 1000),
			updated_at: Math.floor(Date.now() / 1000)
		};
		tenantVanityDomains.set(domainId, updated);
		return json({ domain: updated, cloudflare_configured: false });
	}

	if (method === 'POST' && action === 'primary') {
		const updated = { ...domain, is_primary: true, updated_at: Math.floor(Date.now() / 1000) };
		for (const [id, existing] of tenantVanityDomains) {
			if (existing.tenant_id === domain.tenant_id) {
				tenantVanityDomains.set(id, { ...existing, is_primary: id === domainId });
			}
		}
		tenantVanityDomains.set(domainId, updated);
		return json(updated);
	}

	return null;
}

export async function handleDevAdminMock(
	event: RequestEvent,
	platformEnv: EnvLike
): Promise<Response | null> {
	if (!isDevAdminMockEnabled(event, platformEnv)) return null;
	if (event.url.pathname !== '/api/admin' && !event.url.pathname.startsWith('/api/admin/')) {
		return null;
	}

	const segments = event.url.pathname
		.replace(/^\/api\/admin\/?/, '')
		.split('/')
		.filter(Boolean)
		.map(decodeURIComponent);

	if (segments.length === 0) return json({ ok: true, mode: 'dev-admin-mock' });
	if (segments[0] === 'me' && segments[1] === 'session') {
		return json({
			active: true,
			user_id: 'dev-admin',
			tenant_id: TENANT_ID,
			email: 'dev-admin@localhost',
			name: 'Dev Admin',
			roles: ['platform_admin', 'tenant_admin', 'admin'],
			permissions: ['*'],
			admin_scope: 'platform',
			is_platform_admin: true,
			expires_at: Math.floor(Date.now() / 1000) + 86400,
			created_at: Math.floor(NOW / 1000),
			last_login_at: Math.floor(NOW / 1000)
		});
	}
	const myPasskeysResponse = await handleMyPasskeys(event, segments);
	if (myPasskeysResponse) return myPasskeysResponse;
	const ipAllowlistResponse = await handleIpAllowlist(event, segments);
	if (ipAllowlistResponse) return ipAllowlistResponse;
	const signingKeysResponse = await handleSigningKeys(event, segments);
	if (signingKeysResponse) return signingKeysResponse;
	if (segments[0] === 'logout') return json({ success: true });
	if (segments[0] === 'client-profile-presets') {
		return json({
			presets: [
				{
					id: 'authrim-websdk',
					name: 'Authrim WebSDK',
					description: 'Dev mock preset',
					clientType: 'public'
				}
			]
		});
	}
	if (segments[0] === 'admin-access-control' && segments[1] === 'stats') {
		return json({
			rbac: { total_roles: roles.size, total_assignments: 3 },
			abac: { total_attributes: 8, active_attributes: 6 },
			rebac: { total_definitions: 4, total_tuples: 18 },
			policies: { total_policies: 7, active_policies: 5 }
		});
	}
	const consentPoliciesResponse = await handleConsentPolicies(event, segments);
	if (consentPoliciesResponse) return consentPoliciesResponse;
	const consentStatementsResponse = await handleConsentStatements(event, segments);
	if (consentStatementsResponse) return consentStatementsResponse;
	const adminLoggingResponse = await handleAdminLogging(event, segments);
	if (adminLoggingResponse) return adminLoggingResponse;
	const loggingPoliciesResponse = await handleLoggingPolicies(event, segments);
	if (loggingPoliciesResponse) return loggingPoliciesResponse;
	const tenantDomainMappingsResponse = await handleTenantDomainMappings(event, segments);
	if (tenantDomainMappingsResponse) return tenantDomainMappingsResponse;
	const tenantVanityDomainsResponse = await handleTenantVanityDomains(event, segments);
	if (tenantVanityDomainsResponse) return tenantVanityDomainsResponse;
	if (segments[0] === 'field-mapping') return handleIdentityMapping(event, segments.slice(1));
	if (
		segments[0] === 'saml-providers' ||
		segments[0] === 'saml-settings' ||
		segments[0].startsWith('saml-')
	) {
		const response = await handleSamlProviders(event, segments);
		if (response) return response;
	}
	const scopedClientSettings = await handleScopedClientSettings(event, segments);
	if (scopedClientSettings) return scopedClientSettings;
	const runtimeProfilesResponse = await handleRuntimeProfiles(event, segments);
	if (runtimeProfilesResponse) return runtimeProfilesResponse;
	const customClaimsResponse = await handleCustomClaims(event, segments);
	if (customClaimsResponse) return customClaimsResponse;
	const externalProvidersResponse = await handleExternalProviders(event, segments);
	if (externalProvidersResponse) return externalProvidersResponse;
	const directoryAuthResponse = await handleDirectoryAuth(event, segments);
	if (directoryAuthResponse) return directoryAuthResponse;
	const directoryConnectorsResponse = await handleDirectoryConnectors(event, segments);
	if (directoryConnectorsResponse) return directoryConnectorsResponse;
	const sessionsResponse = await handleSessions(event, segments);
	if (sessionsResponse) return sessionsResponse;
	const endUsersResponse = await handleEndUsers(event, segments);
	if (endUsersResponse) return endUsersResponse;
	const adminUsersResponse = await handleAdminUsers(event, segments);
	if (adminUsersResponse) return adminUsersResponse;
	const adminRolesResponse = await handleAdminRoles(event, segments);
	if (adminRolesResponse) return adminRolesResponse;
	const userAuditLogsResponse = await handleUserAuditLogs(event, segments);
	if (userAuditLogsResponse) return userAuditLogsResponse;
	const adminAuditLogResponse = await handleAdminAuditLog(event, segments);
	if (adminAuditLogResponse) return adminAuditLogResponse;
	const adminAttributesResponse = await handleAdminAttributes(event, segments);
	if (adminAttributesResponse) return adminAttributesResponse;
	const adminRebacDefinitionsResponse = await handleAdminRebacDefinitions(event, segments);
	if (adminRebacDefinitionsResponse) return adminRebacDefinitionsResponse;
	const adminRelationshipsResponse = await handleAdminRelationships(event, segments);
	if (adminRelationshipsResponse) return adminRelationshipsResponse;
	const policyRulesResponse = await handlePolicyRules(event, segments);
	if (policyRulesResponse) return policyRulesResponse;
	const adminPoliciesResponse = await handleAdminPolicies(event, segments);
	if (adminPoliciesResponse) return adminPoliciesResponse;
	const complianceResponse = await handleCompliance(event, segments);
	if (complianceResponse) return complianceResponse;
	const machineAccessResponse = await handleMachineAccess(event, segments);
	if (machineAccessResponse) return machineAccessResponse;
	const controlPlaneDestinationsResponse = await handleControlPlaneDestinations(event, segments);
	if (controlPlaneDestinationsResponse) return controlPlaneDestinationsResponse;
	const storageDestinationsResponse = await handleStorageDestinations(event, segments);
	if (storageDestinationsResponse) return storageDestinationsResponse;
	const approvalsResponse = await handleApprovals(event, segments);
	if (approvalsResponse) return approvalsResponse;
	const rolesResponse = await handleRoles(event, segments);
	if (rolesResponse) return rolesResponse;
	const flowsResponse = await handleFlows(event, segments);
	if (flowsResponse) return flowsResponse;
	if (segments[0] === 'clients') {
		const response = await handleClients(event, segments);
		if (response) return response;
	}
	const settingsResponse = await handleSettings(event, segments);
	if (settingsResponse) return settingsResponse;
	if (segments[0] === 'logging-policies' && segments[1] === 'notifications') {
		return json({ items: [], total: 0 });
	}
	if (segments[0] === 'notifications') return json({ items: [], total: 0 });
	if (segments[0] === 'stats') return json(devDashboardStatsResponse());

	return json(
		{
			error: 'dev_mock_not_implemented',
			error_description: `Admin UI dev mock has no handler for ${event.url.pathname}`
		},
		404
	);
}
