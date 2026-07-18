<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { getLocale, LL } from '$i18n/i18n-svelte';
	import {
		adminClientsAPI,
		type AttributeReleaseConsentPolicy,
		type ClaimReleasePolicy,
		type ClaimsParameterPolicy,
		type Client,
		type ClientUsage,
		type UpdateClientInput
	} from '$lib/api/admin-clients';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingFieldMappingSetSummary
	} from '$lib/api/admin-identity-mapping';
	import {
		buildClientDownstreamGrantFormFromClient,
		createDefaultClientDownstreamGrantForm,
		downstreamGrantFormEquals,
		formatClientListForTextarea,
		toClientDownstreamGrantUpdateInput,
		type ClientDownstreamGrantForm
	} from '$lib/admin/client-downstream-grant';
	import {
		adminSettingsAPI,
		scopedSettingsAPI,
		type CategorySettings,
		SettingsConflictError
	} from '$lib/api/admin-settings';
	import { Modal, ToggleSwitch } from '$lib/components';
	import AdminDetailHeader from '$lib/components/admin/AdminDetailHeader.svelte';
	import ConsentPolicyTargetSettings from '$lib/components/admin/ConsentPolicyTargetSettings.svelte';
	import FlowAssignmentSettings from '$lib/components/admin/FlowAssignmentSettings.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
	import AdminTabs, { type AdminTabItem } from '$lib/components/admin/AdminTabs.svelte';
	import { onMount } from 'svelte';

	const clientId = $derived($page.params.id ?? '');

	let client = $state<Client | null>(null);
	let usage = $state<ClientUsage | null>(null);
	let clientSettings = $state<CategorySettings | null>(null);
	let fieldMappingSets = $state<IdentityMappingFieldMappingSetSummary[]>([]);
	let loading = $state(true);
	let error = $state('');

	// Edit mode
	let isEditing = $state(false);
	let editForm = $state<UpdateClientInput>({});
	let downstreamGrantEditForm = $state<ClientDownstreamGrantForm>(
		createDefaultClientDownstreamGrantForm()
	);
	let settingsEditForm = $state<{
		// General tab
		pkce_required?: boolean;
		par_required?: boolean;
		dpop_required?: boolean;
		dpop_mode?: 'disabled' | 'critical_only' | 'all';
		allowed_scopes?: string;
		default_scope?: string;
		// Tokens tab
		access_token_ttl?: number;
		refresh_token_ttl?: number;
		id_token_ttl?: number;
		refresh_token_rotation?: boolean;
		reuse_refresh_token?: boolean;
		dpop_bound_access_tokens?: boolean;
		token_exchange_allowed?: boolean;
		delegation_mode?: string;
		// Security tab
		consent_required?: boolean;
		first_party?: boolean;
		app_login_enabled?: boolean;
		sso_enabled?: boolean;
		strict_redirect_matching?: boolean;
		allow_localhost_redirect?: boolean;
		default_max_age?: number;
		default_acr_values?: string;
		require_auth_time?: boolean;
		subject_type?: string;
		// Scopes tab
		default_audience?: string;
		allowed_scopes_restriction_enabled?: boolean;
		client_credentials_allowed?: boolean;
		allow_authorization_code?: boolean;
		allow_client_credentials?: boolean;
		allow_refresh_token?: boolean;
		allow_device_code?: boolean;
		allow_ciba?: boolean;
		allow_code_response?: boolean;
		allow_token_response?: boolean;
		allow_id_token_response?: boolean;
		// Session tab
		frontchannel_logout_uri?: string;
		frontchannel_logout_session_required?: boolean;
		backchannel_logout_uri?: string;
		backchannel_logout_session_required?: boolean;
		// Metadata tab
		logo_uri?: string;
		contacts?: string;
		tos_uri?: string;
		policy_uri?: string;
		client_uri?: string;
		initiate_login_uri?: string;
		login_ui_url?: string;
		application_type?: string;
		sector_identifier_uri?: string;
		// Advanced tab
		id_token_signing_alg?: string;
		id_token_encrypted_response_alg?: string;
		id_token_encrypted_response_enc?: string;
		userinfo_signed_response_alg?: string;
		userinfo_encrypted_response_alg?: string;
		userinfo_encrypted_response_enc?: string;
		request_object_signing_alg?: string;
		request_object_encryption_alg?: string;
		request_object_encryption_enc?: string;
		request_uris?: string;
		jwt_bearer_signing_alg?: string;
		token_endpoint_auth_signing_alg?: string;
	}>({});
	let saving = $state(false);
	let saveError = $state('');

	// Delete modal
	let showDeleteModal = $state(false);
	let deleteConfirmName = $state('');
	let deleting = $state(false);

	// Regenerate secret modal
	let showRegenerateModal = $state(false);
	let regenerating = $state(false);
	let newSecret = $state<string | null>(null);

	// Copy feedback
	let copiedField = $state<string | null>(null);

	// Tabs
	type TabId =
		| 'general'
		| 'tokens'
		| 'security'
		| 'scopes'
		| 'claims'
		| 'session'
		| 'metadata'
		| 'advanced';
	let activeTab = $state<TabId>('general');

	const TAB_DEFINITIONS: ReadonlyArray<{ id: TabId; label: string }> = [
		{ id: 'general', label: 'General' },
		{ id: 'tokens', label: 'Tokens' },
		{ id: 'security', label: 'Security' },
		{ id: 'scopes', label: 'Scopes & Permissions' },
		{ id: 'claims', label: 'Claims & ASC' },
		{ id: 'session', label: 'Session & Logout' },
		{ id: 'metadata', label: 'Client Metadata' },
		{ id: 'advanced', label: 'Advanced' }
	];
	const clientTabItems = $derived<AdminTabItem[]>(
		TAB_DEFINITIONS.map((tab) => ({
			id: tab.id,
			label: tabLabel(tab.id),
			panelId: `${tab.id}-panel`
		}))
	);

	const CLAIM_RELEASE_POLICIES = new Set<ClaimReleasePolicy>([
		'scope_required',
		'claims_allowed',
		'forbidden'
	]);
	const ASC_TRANSFORMED_CLAIMS = [
		{ id: 'age_over_13', label: 'Age over 13' },
		{ id: 'age_over_18', label: 'Age over 18' },
		{ id: 'age_over_20', label: 'Age over 20' },
		{ id: 'email_domain', label: 'Email domain' },
		{ id: 'phone_country_code', label: 'Phone country code' },
		{ id: 'address_country', label: 'Address country' }
	] as const;

	// Admin visibility toggle
	let showAdminSettings = $state(false);

	// Track unsaved changes
	let initialEditForm = $state<UpdateClientInput | null>(null);
	let claimsParameterPolicyText = $state('');
	let initialClaimsParameterPolicyText = $state<string | null>(null);
	let initialDownstreamGrantEditForm = $state<ClientDownstreamGrantForm | null>(null);
	let initialSettingsEditForm = $state<{
		// General tab
		pkce_required?: boolean;
		par_required?: boolean;
		dpop_required?: boolean;
		dpop_mode?: 'disabled' | 'critical_only' | 'all';
		allowed_scopes?: string;
		default_scope?: string;
		// Tokens tab
		access_token_ttl?: number;
		refresh_token_ttl?: number;
		id_token_ttl?: number;
		refresh_token_rotation?: boolean;
		reuse_refresh_token?: boolean;
		dpop_bound_access_tokens?: boolean;
		token_exchange_allowed?: boolean;
		delegation_mode?: string;
		// Security tab
		consent_required?: boolean;
		first_party?: boolean;
		app_login_enabled?: boolean;
		sso_enabled?: boolean;
		strict_redirect_matching?: boolean;
		allow_localhost_redirect?: boolean;
		default_max_age?: number;
		default_acr_values?: string;
		require_auth_time?: boolean;
		subject_type?: string;
		// Scopes tab
		default_audience?: string;
		allowed_scopes_restriction_enabled?: boolean;
		client_credentials_allowed?: boolean;
		allow_authorization_code?: boolean;
		allow_client_credentials?: boolean;
		allow_refresh_token?: boolean;
		allow_device_code?: boolean;
		allow_ciba?: boolean;
		allow_code_response?: boolean;
		allow_token_response?: boolean;
		allow_id_token_response?: boolean;
		// Session tab
		frontchannel_logout_uri?: string;
		frontchannel_logout_session_required?: boolean;
		backchannel_logout_uri?: string;
		backchannel_logout_session_required?: boolean;
		// Metadata tab
		logo_uri?: string;
		contacts?: string;
		tos_uri?: string;
		policy_uri?: string;
		client_uri?: string;
		initiate_login_uri?: string;
		login_ui_url?: string;
		application_type?: string;
		sector_identifier_uri?: string;
		// Advanced tab
		id_token_signing_alg?: string;
		id_token_encrypted_response_alg?: string;
		id_token_encrypted_response_enc?: string;
		userinfo_signed_response_alg?: string;
		userinfo_encrypted_response_alg?: string;
		userinfo_encrypted_response_enc?: string;
		request_object_signing_alg?: string;
		request_object_encryption_alg?: string;
		request_object_encryption_enc?: string;
		request_uris?: string;
		jwt_bearer_signing_alg?: string;
		token_endpoint_auth_signing_alg?: string;
	} | null>(null);

	function toStringArray(value: unknown): string[] {
		let current: unknown = value;

		for (let i = 0; i < 3; i++) {
			if (typeof current !== 'string') break;
			const trimmed = current.trim();
			if (!trimmed) return [];
			if (
				!(
					(trimmed.startsWith('[') && trimmed.endsWith(']')) ||
					(trimmed.startsWith('"') && trimmed.endsWith('"'))
				)
			)
				break;

			try {
				current = JSON.parse(trimmed);
			} catch {
				break;
			}
		}

		if (Array.isArray(current)) {
			if (current.every((item) => typeof item === 'string' && item.length === 1)) {
				return toStringArray(current.join(''));
			}

			return current
				.filter((item): item is string => typeof item === 'string')
				.map((item) => item.trim())
				.filter((item) => item.length > 0);
		}

		if (typeof current === 'string') {
			const trimmed = current.trim();
			if (!trimmed) return [];
			if (trimmed.includes(',')) {
				return trimmed
					.split(',')
					.map((item) => item.trim())
					.filter((item) => item.length > 0);
			}
			return [trimmed];
		}

		return [];
	}

	function normalizeClientArrays(input: Client): Client {
		return {
			...input,
			redirect_uris: toStringArray(input.redirect_uris),
			grant_types: toStringArray(input.grant_types),
			response_types: toStringArray(input.response_types),
			asc_allowed_transformed_claims: input.asc_allowed_transformed_claims
				? toStringArray(input.asc_allowed_transformed_claims)
				: input.asc_allowed_transformed_claims
		};
	}

	function parseClaimsParameterPolicy(text: string): ClaimsParameterPolicy | null {
		const policy: ClaimsParameterPolicy = {};
		for (const [index, rawLine] of text.split('\n').entries()) {
			const line = rawLine.trim();
			if (!line) continue;
			const separatorIndex = line.indexOf(':');
			if (separatorIndex <= 0) {
				throw new Error($LL.admin_clients_new_claim_policy_line_format({ line: index + 1 }));
			}
			const claim = line.slice(0, separatorIndex).trim();
			const policyValue = line.slice(separatorIndex + 1).trim() as ClaimReleasePolicy;
			if (!claim) {
				throw new Error($LL.admin_clients_new_claim_policy_empty_claim({ line: index + 1 }));
			}
			if (!CLAIM_RELEASE_POLICIES.has(policyValue)) {
				throw new Error($LL.admin_clients_new_claim_policy_invalid({ line: index + 1 }));
			}
			policy[claim] = policyValue;
		}
		return Object.keys(policy).length > 0 ? policy : null;
	}

	function formatClaimsParameterPolicy(policy?: ClaimsParameterPolicy | null): string {
		if (!policy) return '';
		return Object.entries(policy)
			.map(([claim, policyValue]) => `${claim}: ${policyValue}`)
			.join('\n');
	}

	function identityMappingFieldMappingLabel(fieldMappingSetId?: string | null): string {
		if (!fieldMappingSetId) return $LL.admin_client_detail_identity_mapping_policy_default();
		const fieldMappingSet = fieldMappingSets.find((item) => item.id === fieldMappingSetId);
		return fieldMappingSet
			? `${fieldMappingSet.displayName} (${fieldMappingSet.lifecycleState})`
			: fieldMappingSetId;
	}

	function attributeReleaseConsentValue(policy?: AttributeReleaseConsentPolicy | null): string {
		return policy?.enabled ? policy.mode : 'disabled';
	}

	function setAttributeReleaseConsent(value: string) {
		editForm.attribute_release_consent =
			value === 'disabled'
				? null
				: {
						enabled: true,
						mode: value === 'every_time' || value === 'until_attributes_change' ? value : 'once'
					};
	}

	function attributeReleaseConsentLabel(policy?: AttributeReleaseConsentPolicy | null): string {
		switch (attributeReleaseConsentValue(policy)) {
			case 'once':
				return $LL.admin_client_detail_attribute_release_consent_once();
			case 'every_time':
				return $LL.admin_client_detail_attribute_release_consent_every_time();
			case 'until_attributes_change':
				return $LL.admin_client_detail_attribute_release_consent_until_attributes_change();
			default:
				return $LL.admin_client_detail_attribute_release_consent_disabled();
		}
	}

	function setIdentityMappingFieldMappingSet(fieldMappingSetId: string) {
		editForm.identity_mapping = fieldMappingSetId
			? {
					...(editForm.identity_mapping ?? {}),
					fieldMappingSetId,
					destinationNamespace: editForm.identity_mapping?.destinationNamespace ?? 'oidc.claim'
				}
			: null;
	}

	function formatEnabled(value?: boolean): string {
		return value === false ? $LL.admin_saml_disabled() : $LL.admin_saml_enabled();
	}

	function getEffectiveAscAllowedTransformedClaims(currentClient: Client | null): string[] {
		return (
			currentClient?.asc_allowed_transformed_claims ??
			ASC_TRANSFORMED_CLAIMS.map((claim) => claim.id)
		);
	}

	function transformedClaimLabel(claimId: string): string {
		switch (claimId) {
			case 'age_over_13':
				return $LL.admin_clients_new_claim_age_over_13();
			case 'age_over_18':
				return $LL.admin_clients_new_claim_age_over_18();
			case 'age_over_20':
				return $LL.admin_clients_new_claim_age_over_20();
			case 'email_domain':
				return $LL.admin_clients_new_claim_email_domain();
			case 'phone_country_code':
				return $LL.admin_clients_new_claim_phone_country_code();
			case 'address_country':
				return $LL.admin_clients_new_claim_address_country();
			default:
				return claimId;
		}
	}

	function subjectTypeLabel(subjectType: string): string {
		switch (subjectType) {
			case 'pairwise':
				return $LL.admin_client_detail_subject_pairwise();
			case 'public':
			default:
				return $LL.admin_client_detail_subject_public();
		}
	}

	function applicationTypeLabel(applicationType: string): string {
		switch (applicationType) {
			case 'native':
				return $LL.admin_client_detail_application_native();
			case 'spa':
				return $LL.admin_client_detail_application_spa();
			case 'web':
			default:
				return $LL.admin_client_detail_application_web();
		}
	}

	function syncClientSettingsWithClient(
		settings: CategorySettings | null,
		currentClient: Client | null
	): CategorySettings | null {
		if (!settings) return settings;
		return {
			...settings,
			values: {
				...settings.values,
				'client.login_ui_url': currentClient?.login_ui_url ?? ''
			}
		};
	}

	function arraysEqual(a?: string[], b?: string[]) {
		const left = a ?? [];
		const right = b ?? [];
		if (left.length !== right.length) return false;
		return left.every((value, index) => value === right[index]);
	}

	function clientFormEquals(a: UpdateClientInput | null, b: UpdateClientInput | null): boolean {
		if (!a || !b) return false;
		return (
			(a.client_name ?? '') === (b.client_name ?? '') &&
			(a.description ?? '') === (b.description ?? '') &&
			arraysEqual(a.redirect_uris, b.redirect_uris) &&
			arraysEqual(a.grant_types, b.grant_types) &&
			arraysEqual(a.response_types, b.response_types) &&
			(a.token_endpoint_auth_method ?? '') === (b.token_endpoint_auth_method ?? '') &&
			(a.browser_public_client_mode ?? '') === (b.browser_public_client_mode ?? '') &&
			(a.browser_refresh_token_policy ?? 'disabled') ===
				(b.browser_refresh_token_policy ?? 'disabled') &&
			(a.scope ?? '') === (b.scope ?? '') &&
			Boolean(a.require_pkce) === Boolean(b.require_pkce) &&
			Boolean(a.allow_claims_without_scope) === Boolean(b.allow_claims_without_scope) &&
			(a.identity_mapping?.fieldMappingSetId ?? '') ===
				(b.identity_mapping?.fieldMappingSetId ?? '') &&
			attributeReleaseConsentValue(a.attribute_release_consent) ===
				attributeReleaseConsentValue(b.attribute_release_consent) &&
			(a.asc_enabled ?? true) === (b.asc_enabled ?? true) &&
			(a.asc_protected_request_required ?? true) === (b.asc_protected_request_required ?? true) &&
			(a.asc_sao_enabled ?? true) === (b.asc_sao_enabled ?? true) &&
			(a.asc_transformed_claims_enabled ?? true) === (b.asc_transformed_claims_enabled ?? true) &&
			arraysEqual(
				a.asc_allowed_transformed_claims ?? undefined,
				b.asc_allowed_transformed_claims ?? undefined
			)
		);
	}

	function settingsFormEquals(
		a: {
			pkce_required?: boolean;
			par_required?: boolean;
			dpop_required?: boolean;
			dpop_mode?: 'disabled' | 'critical_only' | 'all';
			allowed_scopes?: string;
			default_scope?: string;
			access_token_ttl?: number;
			refresh_token_ttl?: number;
			id_token_ttl?: number;
			refresh_token_rotation?: boolean;
			reuse_refresh_token?: boolean;
			dpop_bound_access_tokens?: boolean;
			token_exchange_allowed?: boolean;
			delegation_mode?: string;
			consent_required?: boolean;
			first_party?: boolean;
			sso_enabled?: boolean;
			strict_redirect_matching?: boolean;
			allow_localhost_redirect?: boolean;
			default_max_age?: number;
			default_acr_values?: string;
			require_auth_time?: boolean;
			subject_type?: string;
			default_audience?: string;
			allowed_scopes_restriction_enabled?: boolean;
			client_credentials_allowed?: boolean;
			allow_authorization_code?: boolean;
			allow_client_credentials?: boolean;
			allow_refresh_token?: boolean;
			allow_device_code?: boolean;
			allow_ciba?: boolean;
			allow_code_response?: boolean;
			allow_token_response?: boolean;
			allow_id_token_response?: boolean;
			frontchannel_logout_uri?: string;
			frontchannel_logout_session_required?: boolean;
			backchannel_logout_uri?: string;
			backchannel_logout_session_required?: boolean;
			logo_uri?: string;
			contacts?: string;
			tos_uri?: string;
			policy_uri?: string;
			client_uri?: string;
			initiate_login_uri?: string;
			login_ui_url?: string;
			application_type?: string;
			sector_identifier_uri?: string;
			id_token_signing_alg?: string;
			id_token_encrypted_response_alg?: string;
			id_token_encrypted_response_enc?: string;
			userinfo_signed_response_alg?: string;
			userinfo_encrypted_response_alg?: string;
			userinfo_encrypted_response_enc?: string;
			request_object_signing_alg?: string;
			request_object_encryption_alg?: string;
			request_object_encryption_enc?: string;
			request_uris?: string;
			jwt_bearer_signing_alg?: string;
			token_endpoint_auth_signing_alg?: string;
		} | null,
		b: {
			pkce_required?: boolean;
			par_required?: boolean;
			dpop_required?: boolean;
			dpop_mode?: 'disabled' | 'critical_only' | 'all';
			allowed_scopes?: string;
			default_scope?: string;
			access_token_ttl?: number;
			refresh_token_ttl?: number;
			id_token_ttl?: number;
			refresh_token_rotation?: boolean;
			reuse_refresh_token?: boolean;
			dpop_bound_access_tokens?: boolean;
			token_exchange_allowed?: boolean;
			delegation_mode?: string;
			consent_required?: boolean;
			first_party?: boolean;
			sso_enabled?: boolean;
			strict_redirect_matching?: boolean;
			allow_localhost_redirect?: boolean;
			default_max_age?: number;
			default_acr_values?: string;
			require_auth_time?: boolean;
			subject_type?: string;
			default_audience?: string;
			allowed_scopes_restriction_enabled?: boolean;
			client_credentials_allowed?: boolean;
			allow_authorization_code?: boolean;
			allow_client_credentials?: boolean;
			allow_refresh_token?: boolean;
			allow_device_code?: boolean;
			allow_ciba?: boolean;
			allow_code_response?: boolean;
			allow_token_response?: boolean;
			allow_id_token_response?: boolean;
			frontchannel_logout_uri?: string;
			frontchannel_logout_session_required?: boolean;
			backchannel_logout_uri?: string;
			backchannel_logout_session_required?: boolean;
			logo_uri?: string;
			contacts?: string;
			tos_uri?: string;
			policy_uri?: string;
			client_uri?: string;
			initiate_login_uri?: string;
			login_ui_url?: string;
			application_type?: string;
			sector_identifier_uri?: string;
			id_token_signing_alg?: string;
			id_token_encrypted_response_alg?: string;
			id_token_encrypted_response_enc?: string;
			userinfo_signed_response_alg?: string;
			userinfo_encrypted_response_alg?: string;
			userinfo_encrypted_response_enc?: string;
			request_object_signing_alg?: string;
			request_object_encryption_alg?: string;
			request_object_encryption_enc?: string;
			request_uris?: string;
			jwt_bearer_signing_alg?: string;
			token_endpoint_auth_signing_alg?: string;
		} | null
	): boolean {
		if (!a || !b) return false;
		return (
			// General tab
			Boolean(a.pkce_required) === Boolean(b.pkce_required) &&
			Boolean(a.par_required) === Boolean(b.par_required) &&
			Boolean(a.dpop_required) === Boolean(b.dpop_required) &&
			(a.dpop_mode ?? 'disabled') === (b.dpop_mode ?? 'disabled') &&
			(a.allowed_scopes ?? '') === (b.allowed_scopes ?? '') &&
			(a.default_scope ?? '') === (b.default_scope ?? '') &&
			// Tokens tab
			(a.access_token_ttl ?? 3600) === (b.access_token_ttl ?? 3600) &&
			(a.refresh_token_ttl ?? 7776000) === (b.refresh_token_ttl ?? 7776000) &&
			(a.id_token_ttl ?? 3600) === (b.id_token_ttl ?? 3600) &&
			Boolean(a.refresh_token_rotation) === Boolean(b.refresh_token_rotation) &&
			Boolean(a.reuse_refresh_token) === Boolean(b.reuse_refresh_token) &&
			Boolean(a.dpop_bound_access_tokens) === Boolean(b.dpop_bound_access_tokens) &&
			Boolean(a.token_exchange_allowed) === Boolean(b.token_exchange_allowed) &&
			(a.delegation_mode ?? 'delegation') === (b.delegation_mode ?? 'delegation') &&
			// Security tab
			Boolean(a.consent_required) === Boolean(b.consent_required) &&
			Boolean(a.first_party) === Boolean(b.first_party) &&
			Boolean(a.sso_enabled) === Boolean(b.sso_enabled) &&
			Boolean(a.strict_redirect_matching) === Boolean(b.strict_redirect_matching) &&
			Boolean(a.allow_localhost_redirect) === Boolean(b.allow_localhost_redirect) &&
			(a.default_max_age ?? 0) === (b.default_max_age ?? 0) &&
			(a.default_acr_values ?? '') === (b.default_acr_values ?? '') &&
			Boolean(a.require_auth_time) === Boolean(b.require_auth_time) &&
			(a.subject_type ?? 'public') === (b.subject_type ?? 'public') &&
			// Scopes tab
			(a.default_audience ?? '') === (b.default_audience ?? '') &&
			Boolean(a.allowed_scopes_restriction_enabled) ===
				Boolean(b.allowed_scopes_restriction_enabled) &&
			Boolean(a.client_credentials_allowed) === Boolean(b.client_credentials_allowed) &&
			Boolean(a.allow_authorization_code) === Boolean(b.allow_authorization_code) &&
			Boolean(a.allow_client_credentials) === Boolean(b.allow_client_credentials) &&
			Boolean(a.allow_refresh_token) === Boolean(b.allow_refresh_token) &&
			Boolean(a.allow_device_code) === Boolean(b.allow_device_code) &&
			Boolean(a.allow_ciba) === Boolean(b.allow_ciba) &&
			Boolean(a.allow_code_response) === Boolean(b.allow_code_response) &&
			Boolean(a.allow_token_response) === Boolean(b.allow_token_response) &&
			Boolean(a.allow_id_token_response) === Boolean(b.allow_id_token_response) &&
			// Session tab
			(a.frontchannel_logout_uri ?? '') === (b.frontchannel_logout_uri ?? '') &&
			Boolean(a.frontchannel_logout_session_required) ===
				Boolean(b.frontchannel_logout_session_required) &&
			(a.backchannel_logout_uri ?? '') === (b.backchannel_logout_uri ?? '') &&
			Boolean(a.backchannel_logout_session_required) ===
				Boolean(b.backchannel_logout_session_required) &&
			// Metadata tab
			(a.logo_uri ?? '') === (b.logo_uri ?? '') &&
			(a.contacts ?? '') === (b.contacts ?? '') &&
			(a.tos_uri ?? '') === (b.tos_uri ?? '') &&
			(a.policy_uri ?? '') === (b.policy_uri ?? '') &&
			(a.client_uri ?? '') === (b.client_uri ?? '') &&
			(a.initiate_login_uri ?? '') === (b.initiate_login_uri ?? '') &&
			(a.login_ui_url ?? '') === (b.login_ui_url ?? '') &&
			(a.application_type ?? 'web') === (b.application_type ?? 'web') &&
			(a.sector_identifier_uri ?? '') === (b.sector_identifier_uri ?? '') &&
			// Advanced tab
			(a.id_token_signing_alg ?? 'RS256') === (b.id_token_signing_alg ?? 'RS256') &&
			(a.id_token_encrypted_response_alg ?? '') === (b.id_token_encrypted_response_alg ?? '') &&
			(a.id_token_encrypted_response_enc ?? 'A256GCM') ===
				(b.id_token_encrypted_response_enc ?? 'A256GCM') &&
			(a.userinfo_signed_response_alg ?? 'none') === (b.userinfo_signed_response_alg ?? 'none') &&
			(a.userinfo_encrypted_response_alg ?? '') === (b.userinfo_encrypted_response_alg ?? '') &&
			(a.userinfo_encrypted_response_enc ?? 'A256GCM') ===
				(b.userinfo_encrypted_response_enc ?? 'A256GCM') &&
			(a.request_object_signing_alg ?? '') === (b.request_object_signing_alg ?? '') &&
			(a.request_object_encryption_alg ?? '') === (b.request_object_encryption_alg ?? '') &&
			(a.request_object_encryption_enc ?? 'A256GCM') ===
				(b.request_object_encryption_enc ?? 'A256GCM') &&
			(a.request_uris ?? '') === (b.request_uris ?? '') &&
			(a.jwt_bearer_signing_alg ?? 'RS256') === (b.jwt_bearer_signing_alg ?? 'RS256') &&
			(a.token_endpoint_auth_signing_alg ?? 'RS256') ===
				(b.token_endpoint_auth_signing_alg ?? 'RS256')
		);
	}

	let hasUnsavedChanges = $derived.by(() => {
		if (
			!isEditing ||
			!initialEditForm ||
			initialClaimsParameterPolicyText === null ||
			!initialSettingsEditForm ||
			!initialDownstreamGrantEditForm
		)
			return false;
		return (
			!clientFormEquals(editForm, initialEditForm) ||
			claimsParameterPolicyText !== initialClaimsParameterPolicyText ||
			!downstreamGrantFormEquals(downstreamGrantEditForm, initialDownstreamGrantEditForm) ||
			!settingsFormEquals(settingsEditForm, initialSettingsEditForm)
		);
	});

	/**
	 * Handle tab change with unsaved changes warning
	 */
	function handleTabChange(newTab: TabId) {
		if (hasUnsavedChanges) {
			const confirmChange = confirm($LL.admin_client_detail_unsaved_tab_confirm());
			if (!confirmChange) {
				return;
			}
			// Reset edit state
			cancelEditing();
		} else if (isEditing) {
			// No modifications made; just exit edit mode cleanly
			cancelEditing();
		}
		activeTab = newTab;
		saveError = '';
	}

	// CORS settings
	let tenantSettings = $state<CategorySettings | null>(null);
	let allowedOrigins = $derived.by(() => {
		const originsStr = tenantSettings?.values['tenant.allowed_origins'] as string | undefined;
		if (!originsStr) return [] as string[];
		return originsStr
			.split(',')
			.map((o) => o.trim())
			.filter((o) => o.length > 0);
	});
	let addingToCors = $state<string | null>(null);

	/**
	 * Extract origin from a URL (e.g., "https://example.com/callback" -> "https://example.com")
	 */
	function extractOrigin(url: string): string {
		try {
			const parsed = new URL(url);
			return parsed.origin;
		} catch {
			return '';
		}
	}

	function buildWebOriginRegistry(uris: string[], existing = client?.web_origin_registry) {
		const byOrigin: Record<string, NonNullable<Client['web_origin_registry']>['origins'][number]> =
			{};
		for (const entry of existing?.origins ?? []) {
			byOrigin[entry.origin] = entry;
		}
		for (const uri of uris) {
			const origin = extractOrigin(uri);
			if (!origin || byOrigin[origin]) continue;
			byOrigin[origin] = {
				origin,
				cors: { allowed: true },
				handoff_allowed: true,
				iframe_allowed: false
			};
		}
		return { origins: Object.values(byOrigin) };
	}

	/**
	 * Check if an origin is in the CORS allowlist (with wildcard support)
	 */
	function isOriginInCors(redirectUri: string): boolean {
		const origin = extractOrigin(redirectUri);
		if (!origin) return false;

		const registryOrigins = client?.web_origin_registry?.origins ?? [];
		if (registryOrigins.some((entry) => entry.origin === origin && entry.cors?.allowed !== false)) {
			return true;
		}

		for (const pattern of allowedOrigins) {
			const normalizedPattern = pattern.trim();
			const normalizedOrigin = origin.replace(/\/$/, '');

			// Exact match
			if (normalizedOrigin === normalizedPattern.replace(/\/$/, '')) {
				return true;
			}

			// Wildcard match (e.g., https://*.pages.dev)
			if (normalizedPattern.includes('*')) {
				const escaped = normalizedPattern
					.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
					.replace(/\*/g, '[a-z0-9]([a-z0-9-]*[a-z0-9])?');
				const regex = new RegExp(`^${escaped}$`, 'i');
				if (regex.test(normalizedOrigin)) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Add an origin to the CORS allowlist
	 */
	async function addToCors(redirectUri: string) {
		const origin = extractOrigin(redirectUri);
		if (!origin || !client) return;

		addingToCors = redirectUri;
		try {
			const existingOrigins = client.web_origin_registry?.origins ?? [];
			const origins = existingOrigins.some((entry) => entry.origin === origin)
				? existingOrigins
				: [
						...existingOrigins,
						{
							origin,
							cors: { allowed: true },
							handoff_allowed: true,
							iframe_allowed: false
						}
					];
			client = normalizeClientArrays(
				await adminClientsAPI.update(clientId, {
					web_origin_registry: { origins }
				})
			);
			return;
		} catch (err) {
			console.error('Failed to add to web origin registry:', err);
			error =
				err instanceof Error ? err.message : $LL.admin_client_detail_error_update_origin_registry();
		} finally {
			addingToCors = null;
		}
	}

	async function loadTenantSettings() {
		try {
			tenantSettings = await adminSettingsAPI.getSettings('tenant');
		} catch (err) {
			// Tenant settings may not be available, initialize with empty values
			// This allows CORS addition to work even when settings haven't been created yet
			console.warn('Failed to load tenant settings for CORS check:', err);
			tenantSettings = {
				category: 'tenant',
				version: '',
				values: {},
				sources: {}
			};
		}
	}

	async function loadClient() {
		loading = true;
		error = '';

		try {
			const [loadedClient, loadedFieldMappingSets] = await Promise.all([
				adminClientsAPI.get(clientId),
				adminIdentityMappingAPI
					.listFieldMappingSets()
					.then((result) => result.fieldMappingSets)
					.catch(() => [] as IdentityMappingFieldMappingSetSummary[])
			]);
			client = normalizeClientArrays(loadedClient);
			fieldMappingSets = loadedFieldMappingSets;
			// Load usage statistics (only on detail page per review feedback)
			try {
				usage = await adminClientsAPI.getUsage(clientId);
			} catch {
				// Usage API may not be implemented yet
				usage = null;
			}
			// Load client settings
			try {
				clientSettings = syncClientSettingsWithClient(
					await scopedSettingsAPI.getClientSettings(clientId, 'client'),
					client
				);
			} catch (err) {
				console.warn('Failed to load client settings:', err);
				// Initialize with empty values if settings don't exist yet
				clientSettings = syncClientSettingsWithClient(
					{
						category: 'client',
						version: '',
						values: {},
						sources: {}
					},
					client
				);
			}
		} catch (err) {
			console.error('Failed to load client:', err);
			error = $LL.admin_client_detail_error_load();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadClient();
		loadTenantSettings();
	});

	function startEditing() {
		if (!client || !clientSettings) return;
		editForm = {
			client_name: client.client_name,
			description: client.description ?? null,
			redirect_uris: toStringArray(client.redirect_uris),
			grant_types: toStringArray(client.grant_types),
			response_types: toStringArray(client.response_types),
			token_endpoint_auth_method: client.token_endpoint_auth_method,
			browser_public_client_mode: client.browser_public_client_mode ?? null,
			browser_refresh_token_policy: client.browser_refresh_token_policy ?? 'disabled',
			scope: client.scope,
			require_pkce: client.require_pkce ?? false,
			allow_claims_without_scope: client.allow_claims_without_scope ?? false,
			asc_enabled: client.asc_enabled ?? true,
			asc_protected_request_required: client.asc_protected_request_required ?? true,
			asc_sao_enabled: client.asc_sao_enabled ?? true,
			asc_transformed_claims_enabled: client.asc_transformed_claims_enabled ?? true,
			identity_mapping: client.identity_mapping?.fieldMappingSetId
				? {
						...(client.identity_mapping ?? {}),
						destinationNamespace: client.identity_mapping.destinationNamespace ?? 'oidc.claim'
					}
				: null,
			attribute_release_consent: client.attribute_release_consent ?? null,
			asc_allowed_transformed_claims: getEffectiveAscAllowedTransformedClaims(client)
		};
		claimsParameterPolicyText = formatClaimsParameterPolicy(client.claims_parameter_policy);
		downstreamGrantEditForm = buildClientDownstreamGrantFormFromClient(client);
		// Initialize all Settings API fields
		settingsEditForm = {
			// General tab
			pkce_required: (clientSettings.values['client.pkce_required'] as boolean) ?? false,
			par_required: (clientSettings.values['client.par_required'] as boolean) ?? false,
			dpop_required: (clientSettings.values['client.dpop_required'] as boolean) ?? false,
			dpop_mode:
				(clientSettings.values['client.dpop_mode'] as 'disabled' | 'critical_only' | 'all') ??
				'disabled',
			allowed_scopes: (clientSettings.values['client.allowed_scopes'] as string) ?? '',
			default_scope: (clientSettings.values['client.default_scope'] as string) ?? '',
			// Tokens tab
			access_token_ttl: (clientSettings.values['client.access_token_ttl'] as number) ?? 3600,
			refresh_token_ttl: (clientSettings.values['client.refresh_token_ttl'] as number) ?? 7776000,
			id_token_ttl: (clientSettings.values['client.id_token_ttl'] as number) ?? 3600,
			refresh_token_rotation:
				(clientSettings.values['client.refresh_token_rotation'] as boolean) ?? false,
			reuse_refresh_token:
				(clientSettings.values['client.reuse_refresh_token'] as boolean) ?? false,
			dpop_bound_access_tokens:
				(clientSettings.values['client.dpop_bound_access_tokens'] as boolean) ?? false,
			token_exchange_allowed:
				(clientSettings.values['client.token_exchange_allowed'] as boolean) ?? false,
			delegation_mode: (clientSettings.values['client.delegation_mode'] as string) ?? 'delegation',
			// Security tab
			consent_required: (clientSettings.values['client.consent_required'] as boolean) ?? false,
			first_party: (clientSettings.values['client.first_party'] as boolean) ?? false,
			app_login_enabled: (clientSettings.values['client.app_login_enabled'] as boolean) ?? false,
			sso_enabled: (clientSettings.values['client.sso_enabled'] as boolean) ?? false,
			strict_redirect_matching:
				(clientSettings.values['client.strict_redirect_matching'] as boolean) ?? false,
			allow_localhost_redirect:
				(clientSettings.values['client.allow_localhost_redirect'] as boolean) ?? false,
			default_max_age: (clientSettings.values['client.default_max_age'] as number) ?? 0,
			default_acr_values: (clientSettings.values['client.default_acr_values'] as string) ?? '',
			require_auth_time: (clientSettings.values['client.require_auth_time'] as boolean) ?? false,
			subject_type: (clientSettings.values['client.subject_type'] as string) ?? 'public',
			// Scopes tab
			default_audience: (clientSettings.values['client.default_audience'] as string) ?? '',
			allowed_scopes_restriction_enabled:
				(clientSettings.values['client.allowed_scopes_restriction_enabled'] as boolean) ?? false,
			client_credentials_allowed:
				(clientSettings.values['client.client_credentials_allowed'] as boolean) ?? false,
			allow_authorization_code:
				(clientSettings.values['client.allow_authorization_code'] as boolean) ?? false,
			allow_client_credentials:
				(clientSettings.values['client.allow_client_credentials'] as boolean) ?? false,
			allow_refresh_token:
				(clientSettings.values['client.allow_refresh_token'] as boolean) ?? false,
			allow_device_code: (clientSettings.values['client.allow_device_code'] as boolean) ?? false,
			allow_ciba: (clientSettings.values['client.allow_ciba'] as boolean) ?? false,
			allow_code_response:
				(clientSettings.values['client.allow_code_response'] as boolean) ?? false,
			allow_token_response:
				(clientSettings.values['client.allow_token_response'] as boolean) ?? false,
			allow_id_token_response:
				(clientSettings.values['client.allow_id_token_response'] as boolean) ?? false,
			// Session tab
			frontchannel_logout_uri:
				(clientSettings.values['client.frontchannel_logout_uri'] as string) ?? '',
			frontchannel_logout_session_required:
				(clientSettings.values['client.frontchannel_logout_session_required'] as boolean) ?? false,
			backchannel_logout_uri:
				(clientSettings.values['client.backchannel_logout_uri'] as string) ?? '',
			backchannel_logout_session_required:
				(clientSettings.values['client.backchannel_logout_session_required'] as boolean) ?? false,
			// Metadata tab
			logo_uri: (clientSettings.values['client.logo_uri'] as string) ?? '',
			contacts: (clientSettings.values['client.contacts'] as string) ?? '',
			tos_uri: (clientSettings.values['client.tos_uri'] as string) ?? '',
			policy_uri: (clientSettings.values['client.policy_uri'] as string) ?? '',
			client_uri: (clientSettings.values['client.client_uri'] as string) ?? '',
			initiate_login_uri: (clientSettings.values['client.initiate_login_uri'] as string) ?? '',
			login_ui_url:
				client.login_ui_url ?? (clientSettings.values['client.login_ui_url'] as string) ?? '',
			application_type: (clientSettings.values['client.application_type'] as string) ?? 'web',
			sector_identifier_uri:
				(clientSettings.values['client.sector_identifier_uri'] as string) ?? '',
			// Advanced tab
			id_token_signing_alg:
				client.id_token_signed_response_alg ??
				(clientSettings.values['client.id_token_signing_alg'] as string) ??
				'RS256',
			id_token_encrypted_response_alg:
				(clientSettings.values['client.id_token_encrypted_response_alg'] as string) ?? '',
			id_token_encrypted_response_enc:
				(clientSettings.values['client.id_token_encrypted_response_enc'] as string) ?? 'A256GCM',
			userinfo_signed_response_alg:
				client.userinfo_signed_response_alg ??
				(clientSettings.values['client.userinfo_signed_response_alg'] as string) ??
				'none',
			userinfo_encrypted_response_alg:
				(clientSettings.values['client.userinfo_encrypted_response_alg'] as string) ?? '',
			userinfo_encrypted_response_enc:
				(clientSettings.values['client.userinfo_encrypted_response_enc'] as string) ?? 'A256GCM',
			request_object_signing_alg:
				(clientSettings.values['client.request_object_signing_alg'] as string) ?? '',
			request_object_encryption_alg:
				(clientSettings.values['client.request_object_encryption_alg'] as string) ?? '',
			request_object_encryption_enc:
				(clientSettings.values['client.request_object_encryption_enc'] as string) ?? 'A256GCM',
			request_uris: (clientSettings.values['client.request_uris'] as string) ?? '',
			jwt_bearer_signing_alg:
				(clientSettings.values['client.jwt_bearer_signing_alg'] as string) ?? 'RS256',
			token_endpoint_auth_signing_alg:
				(clientSettings.values['client.token_endpoint_auth_signing_alg'] as string) ?? 'RS256'
		};
		initialEditForm = { ...editForm };
		initialClaimsParameterPolicyText = claimsParameterPolicyText;
		initialDownstreamGrantEditForm = { ...downstreamGrantEditForm };
		initialSettingsEditForm = { ...settingsEditForm };
		isEditing = true;
		setTimeout(() => {
			document.getElementById('client-name-input')?.focus();
		}, 0);
	}

	function isSystemClient(currentClient: Client): boolean {
		return (
			currentClient.client_name === 'Login UI' ||
			currentClient.client_name === 'Downstream Grant Introspection'
		);
	}

	function clientInitials(currentClient: Client): string {
		const words = currentClient.client_name.trim().split(/\s+/).filter(Boolean);
		if (words.length >= 2) {
			return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase();
		}
		return currentClient.client_name.slice(0, 2).toUpperCase();
	}

	function clientKindLabel(currentClient: Client): string {
		return currentClient.token_endpoint_auth_method === 'none' ? 'public' : 'confidential';
	}

	function cancelEditing() {
		isEditing = false;
		editForm = {};
		claimsParameterPolicyText = '';
		downstreamGrantEditForm = createDefaultClientDownstreamGrantForm();
		settingsEditForm = {};
		initialEditForm = null;
		initialClaimsParameterPolicyText = null;
		initialDownstreamGrantEditForm = null;
		initialSettingsEditForm = null;
		saveError = '';
	}

	async function saveChanges() {
		saving = true;
		saveError = '';

		try {
			const claimsParameterPolicy = parseClaimsParameterPolicy(claimsParameterPolicyText);
			// Save to Client API
			client = normalizeClientArrays(
				await adminClientsAPI.update(clientId, {
					...editForm,
					claims_parameter_policy: claimsParameterPolicy,
					web_origin_registry: buildWebOriginRegistry(editForm.redirect_uris ?? []),
					...toClientDownstreamGrantUpdateInput(downstreamGrantEditForm),
					login_ui_url: settingsEditForm.login_ui_url?.trim()
						? settingsEditForm.login_ui_url.trim()
						: null,
					id_token_signed_response_alg: settingsEditForm.id_token_signing_alg as
						| 'RS256'
						| 'ES256',
					userinfo_signed_response_alg: settingsEditForm.userinfo_signed_response_alg as
						| 'none'
						| 'RS256'
						| 'ES256'
				})
			);

			// Save to Settings API (all tab fields)
			if (clientSettings && Object.keys(settingsEditForm).length > 0) {
				try {
					const result = await scopedSettingsAPI.updateClientSettings(clientId, 'client', {
						ifMatch: clientSettings.version,
						set: {
							// General tab
							'client.pkce_required': settingsEditForm.pkce_required,
							'client.par_required': settingsEditForm.par_required,
							'client.dpop_required': settingsEditForm.dpop_required,
							'client.dpop_mode': settingsEditForm.dpop_mode,
							// Tokens tab
							'client.access_token_ttl': settingsEditForm.access_token_ttl,
							'client.refresh_token_ttl': settingsEditForm.refresh_token_ttl,
							'client.id_token_ttl': settingsEditForm.id_token_ttl,
							'client.refresh_token_rotation': settingsEditForm.refresh_token_rotation,
							'client.reuse_refresh_token': settingsEditForm.reuse_refresh_token,
							'client.dpop_bound_access_tokens': settingsEditForm.dpop_bound_access_tokens,
							// Security tab
							'client.consent_required': settingsEditForm.consent_required,
							'client.first_party': settingsEditForm.first_party,
							'client.app_login_enabled': settingsEditForm.app_login_enabled,
							'client.sso_enabled': settingsEditForm.sso_enabled,
							'client.strict_redirect_matching': settingsEditForm.strict_redirect_matching,
							'client.allow_localhost_redirect': settingsEditForm.allow_localhost_redirect,
							'client.default_max_age': settingsEditForm.default_max_age,
							'client.default_acr_values': settingsEditForm.default_acr_values,
							'client.require_auth_time': settingsEditForm.require_auth_time,
							'client.subject_type': settingsEditForm.subject_type,
							// Scopes tab
							'client.allowed_scopes_restriction_enabled':
								settingsEditForm.allowed_scopes_restriction_enabled,
							'client.allow_authorization_code': settingsEditForm.allow_authorization_code,
							'client.allow_client_credentials': settingsEditForm.allow_client_credentials,
							'client.allow_refresh_token': settingsEditForm.allow_refresh_token,
							'client.allow_device_code': settingsEditForm.allow_device_code,
							'client.allow_ciba': settingsEditForm.allow_ciba,
							'client.allow_code_response': settingsEditForm.allow_code_response,
							'client.allow_token_response': settingsEditForm.allow_token_response,
							'client.allow_id_token_response': settingsEditForm.allow_id_token_response,
							// Session tab
							'client.frontchannel_logout_uri': settingsEditForm.frontchannel_logout_uri,
							'client.frontchannel_logout_session_required':
								settingsEditForm.frontchannel_logout_session_required,
							'client.backchannel_logout_uri': settingsEditForm.backchannel_logout_uri,
							'client.backchannel_logout_session_required':
								settingsEditForm.backchannel_logout_session_required,
							// Metadata tab
							'client.logo_uri': settingsEditForm.logo_uri,
							'client.contacts': settingsEditForm.contacts,
							'client.tos_uri': settingsEditForm.tos_uri,
							'client.policy_uri': settingsEditForm.policy_uri,
							'client.client_uri': settingsEditForm.client_uri,
							'client.initiate_login_uri': settingsEditForm.initiate_login_uri,
							'client.login_ui_url': settingsEditForm.login_ui_url,
							'client.application_type': settingsEditForm.application_type,
							'client.sector_identifier_uri': settingsEditForm.sector_identifier_uri,
							// Advanced tab
							'client.id_token_signing_alg': settingsEditForm.id_token_signing_alg,
							'client.id_token_encrypted_response_alg':
								settingsEditForm.id_token_encrypted_response_alg,
							'client.id_token_encrypted_response_enc':
								settingsEditForm.id_token_encrypted_response_enc,
							'client.userinfo_signed_response_alg': settingsEditForm.userinfo_signed_response_alg,
							'client.userinfo_encrypted_response_alg':
								settingsEditForm.userinfo_encrypted_response_alg,
							'client.userinfo_encrypted_response_enc':
								settingsEditForm.userinfo_encrypted_response_enc,
							'client.request_object_signing_alg': settingsEditForm.request_object_signing_alg,
							'client.request_object_encryption_alg':
								settingsEditForm.request_object_encryption_alg,
							'client.request_object_encryption_enc':
								settingsEditForm.request_object_encryption_enc,
							'client.request_uris': settingsEditForm.request_uris,
							'client.jwt_bearer_signing_alg': settingsEditForm.jwt_bearer_signing_alg,
							'client.token_endpoint_auth_signing_alg':
								settingsEditForm.token_endpoint_auth_signing_alg
						}
					});

					// Check for rejected settings
					if (result.rejected && Object.keys(result.rejected).length > 0) {
						const rejectedKeys = Object.keys(result.rejected).join(', ');
						console.warn('Some settings were rejected:', result.rejected);
						saveError = $LL.admin_client_detail_error_rejected_settings({ keys: rejectedKeys });
					}

					// Reload client settings to get the new version
					clientSettings = syncClientSettingsWithClient(
						await scopedSettingsAPI.getClientSettings(clientId, 'client'),
						client
					);
				} catch (err) {
					if (err instanceof SettingsConflictError) {
						saveError = $LL.admin_client_detail_error_settings_conflict({
							version: err.currentVersion
						});
						// Reload settings to show current state
						try {
							clientSettings = syncClientSettingsWithClient(
								await scopedSettingsAPI.getClientSettings(clientId, 'client'),
								client
							);
						} catch (reloadErr) {
							console.error('Failed to reload settings after conflict:', reloadErr);
						}
						return;
					}
					throw err;
				}
			}

			isEditing = false;
			initialEditForm = null;
			initialClaimsParameterPolicyText = null;
			initialDownstreamGrantEditForm = null;
			initialSettingsEditForm = null;
		} catch (err) {
			console.error('Failed to update client:', err);
			saveError = err instanceof Error ? err.message : $LL.admin_client_detail_error_update();
		} finally {
			saving = false;
		}
	}

	async function handleDelete() {
		if (!client || deleteConfirmName !== client.client_name) return;

		deleting = true;
		try {
			// TODO: Consider switching to soft deletion when Phase 4 audit logs are implemented
			// Currently uses physical deletion, which makes tokens issued for deleted client_id values difficult to trace
			await adminClientsAPI.delete(clientId);
			goto('/admin/clients');
		} catch (err) {
			console.error('Failed to delete client:', err);
			error = err instanceof Error ? err.message : $LL.admin_client_detail_error_delete();
		} finally {
			deleting = false;
			showDeleteModal = false;
		}
	}

	async function handleRegenerateSecret() {
		regenerating = true;
		try {
			const result = await adminClientsAPI.regenerateSecret(clientId);
			newSecret = result.client_secret;
		} catch (err) {
			console.error('Failed to regenerate secret:', err);
			error = err instanceof Error ? err.message : $LL.admin_client_detail_error_regenerate();
			showRegenerateModal = false;
		} finally {
			regenerating = false;
		}
	}

	function copyToClipboard(text: string, field: string) {
		navigator.clipboard.writeText(text);
		copiedField = field;
		setTimeout(() => {
			copiedField = null;
		}, 2000);
	}

	function formatDate(timestamp: number | null): string {
		if (!timestamp) return '-';
		return new Date(timestamp).toLocaleString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	function formatNumber(num: number | null | undefined): string {
		if (num == null) return '0';
		return num.toLocaleString();
	}

	function tabLabel(tabId: TabId): string {
		switch (tabId) {
			case 'general':
				return $LL.admin_client_detail_tab_general();
			case 'tokens':
				return $LL.admin_client_detail_tab_tokens();
			case 'security':
				return $LL.admin_client_detail_tab_security();
			case 'scopes':
				return $LL.admin_client_detail_tab_scopes();
			case 'claims':
				return $LL.admin_client_detail_tab_claims();
			case 'session':
				return $LL.admin_client_detail_tab_session();
			case 'metadata':
				return $LL.admin_client_detail_tab_metadata();
			case 'advanced':
				return $LL.admin_client_detail_tab_advanced();
		}
	}

	function grantTypeLabel(grantType: string): string {
		switch (grantType) {
			case 'authorization_code':
				return $LL.admin_clients_new_grant_type_authorization_code();
			case 'refresh_token':
				return $LL.admin_clients_new_grant_type_refresh_token();
			case 'client_credentials':
				return $LL.admin_clients_new_grant_type_client_credentials();
			case 'urn:ietf:params:oauth:grant-type:device_code':
				return $LL.admin_clients_new_grant_type_device_code();
			case 'implicit':
				return 'Implicit (Legacy)';
			default:
				return grantType;
		}
	}

	function responseTypeLabel(responseType: string): string {
		switch (responseType) {
			case 'code':
				return 'code';
			case 'token':
				return $LL.admin_clients_new_response_token_implicit();
			default:
				return responseType;
		}
	}

	function toggleEditAscAllowedTransformedClaim(claimId: string) {
		const current = editForm.asc_allowed_transformed_claims ?? [];
		if (current.includes(claimId)) {
			editForm.asc_allowed_transformed_claims = current.filter((claim) => claim !== claimId);
		} else {
			editForm.asc_allowed_transformed_claims = [...current, claimId];
		}
	}
</script>

<svelte:head>
	<title>{client?.client_name || $LL.admin_client_detail_page_title_fallback()} - Authrim</title>
</svelte:head>

<AdminPageShell>
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_client_detail_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if client}
		{#snippet detailBadges()}
			<span class="detail-tag detail-tag--ok">{formatEnabled(true)}</span>
			<span class="detail-tag">{clientKindLabel(client!)}</span>
			{#if isSystemClient(client!)}
				<span class="detail-tag detail-tag--system">{$LL.admin_client_detail_system()}</span>
			{/if}
		{/snippet}

		{#snippet actions()}
			<div class="client-header-actions">
				<div class="admin-toggle-inline">
					<ToggleSwitch
						bind:checked={showAdminSettings}
						label={$LL.admin_client_detail_show_advanced()}
						description={$LL.admin_client_detail_show_advanced_desc()}
					/>
				</div>
				{#if !isEditing}
					<button class="btn btn-secondary" onclick={startEditing}>
						{$LL.admin_client_detail_edit()}
					</button>
				{/if}
			</div>
		{/snippet}

		<AdminDetailHeader
			title={client.client_name}
			description={client.description ?? undefined}
			initials={clientInitials(client)}
			meta={`client_id: ${client.client_id}`}
			metaActionLabel={copiedField === 'client_id'
				? $LL.admin_client_detail_copied()
				: $LL.admin_client_detail_copy()}
			onMetaAction={() => copyToClipboard(client!.client_id, 'client_id')}
			badges={detailBadges}
			{actions}
		/>

		<AdminTabs
			items={clientTabItems}
			active={activeTab}
			onChange={(tabId) => handleTabChange(tabId as TabId)}
			ariaLabel={$LL.admin_client_detail_title()}
		/>

		<AdminSection>
			{#if saveError}
				<div class="alert alert-error">{saveError}</div>
			{/if}

			{#if activeTab === 'general'}
				<!-- Usage Statistics -->
				{#if usage}
					<section class="section-spacing">
						<h2 class="section-title-border">{$LL.admin_client_detail_usage_statistics()}</h2>
						<div class="stats-grid">
							<div class="stat-card">
								<div class="stat-value">{formatNumber(usage.tokens_issued_24h)}</div>
								<div class="stat-label">{$LL.admin_client_detail_tokens_24h()}</div>
							</div>
							<div class="stat-card">
								<div class="stat-value">{formatNumber(usage.tokens_issued_7d)}</div>
								<div class="stat-label">{$LL.admin_client_detail_tokens_7d()}</div>
							</div>
							<div class="stat-card">
								<div class="stat-value">{formatNumber(usage.tokens_issued_30d)}</div>
								<div class="stat-label">{$LL.admin_client_detail_tokens_30d()}</div>
							</div>
							<div class="stat-card">
								<div class="stat-value">{formatNumber(usage.active_sessions)}</div>
								<div class="stat-label">{$LL.admin_client_detail_active_sessions()}</div>
							</div>
						</div>
						{#if usage.last_token_issued_at}
							<p class="stat-note">
								{$LL.admin_client_detail_last_token_issued({
									date: formatDate(usage.last_token_issued_at)
								})}
							</p>
						{/if}
					</section>
				{/if}

				<!-- Basic Info -->
				<section class="section-spacing">
					<h2 class="section-title-border">{$LL.admin_client_detail_basicInfo()}</h2>

					<!-- Client ID -->
					<div class="form-group">
						<!-- svelte-ignore a11y_label_has_associated_control -->
						<label class="form-label">{$LL.admin_clients_clientId()}</label>
						<div class="input-copy-group">
							<input type="text" value={client.client_id} readonly class="input-readonly" />
							<button
								class="btn-copy"
								class:copied={copiedField === 'client_id'}
								onclick={() => copyToClipboard(client!.client_id, 'client_id')}
							>
								{copiedField === 'client_id'
									? `✓ ${$LL.admin_client_detail_copied()}`
									: $LL.admin_client_detail_copy()}
							</button>
						</div>
					</div>

					<!-- Client Name -->
					<div class="form-group">
						<!-- svelte-ignore a11y_label_has_associated_control -->
						<label class="form-label">{$LL.admin_clients_clientName()}</label>
						{#if isEditing}
							<input
								id="client-name-input"
								type="text"
								class="form-input"
								bind:value={editForm.client_name}
							/>
						{:else}
							<p class="display-text">{client.client_name}</p>
						{/if}
					</div>

					<!-- Description -->
					<div class="form-group">
						<!-- svelte-ignore a11y_label_has_associated_control -->
						<label class="form-label">{$LL.admin_clients_new_description()}</label>
						{#if isEditing}
							<textarea
								id="client-description-input"
								class="form-input textarea-input"
								value={editForm.description ?? ''}
								placeholder={$LL.admin_clients_new_description_placeholder()}
								oninput={(event) => {
									const value = event.currentTarget.value.trim();
									editForm.description = value.length > 0 ? value : null;
								}}
							></textarea>
							<p class="form-hint">{$LL.admin_clients_new_description_hint()}</p>
						{:else}
							<p class="display-text">
								{client.description || $LL.admin_client_detail_no_description()}
							</p>
						{/if}
					</div>

					<!-- Client Secret -->
					<div class="form-group">
						<!-- svelte-ignore a11y_label_has_associated_control -->
						<label class="form-label">{$LL.admin_clients_new_client_secret()}</label>
						<div class="input-copy-group">
							<input
								type="text"
								value={client.client_secret
									? `••••••••${client.client_secret.slice(-4)}`
									: '••••••••••••'}
								readonly
								class="input-readonly"
							/>
							<button class="btn btn-warning btn-sm" onclick={() => (showRegenerateModal = true)}>
								{$LL.admin_client_detail_regenerateSecret()}
							</button>
						</div>
						<p class="form-hint">{$LL.admin_client_detail_client_secret_hint()}</p>
					</div>
				</section>

				<!-- OAuth Settings -->
				<section class="section-spacing">
					<h2 class="section-title-border">{$LL.admin_client_detail_oauth_settings()}</h2>

					<div class="form-grid">
						<!-- Grant Types -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_grantTypes()}</label>
							{#if isEditing}
								<div class="checkbox-list">
									{#each [{ value: 'authorization_code' }, { value: 'refresh_token' }, { value: 'client_credentials' }, { value: 'implicit' }, { value: 'urn:ietf:params:oauth:grant-type:device_code' }] as grantType (grantType.value)}
										<label class="checkbox-list-item">
											<input
												type="checkbox"
												checked={editForm.grant_types?.includes(grantType.value)}
												onchange={(e) => {
													const target = e.target as HTMLInputElement;
													if (target.checked) {
														editForm.grant_types = [
															...(editForm.grant_types || []),
															grantType.value
														];
													} else {
														editForm.grant_types = (editForm.grant_types || []).filter(
															(g) => g !== grantType.value
														);
													}
												}}
											/>
											{grantTypeLabel(grantType.value)}
										</label>
									{/each}
								</div>
							{:else}
								<p class="display-text">{client.grant_types.join(', ') || '-'}</p>
							{/if}
						</div>

						<!-- Response Types -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_clients_new_response_types()}</label>
							{#if isEditing}
								<div class="checkbox-list">
									{#each [{ value: 'code' }, { value: 'token' }, { value: 'id_token' }, { value: 'id_token token' }, { value: 'code id_token' }] as responseType (responseType.value)}
										<label class="checkbox-list-item">
											<input
												type="checkbox"
												checked={editForm.response_types?.includes(responseType.value)}
												onchange={(e) => {
													const target = e.target as HTMLInputElement;
													if (target.checked) {
														editForm.response_types = [
															...(editForm.response_types || []),
															responseType.value
														];
													} else {
														editForm.response_types = (editForm.response_types || []).filter(
															(r) => r !== responseType.value
														);
													}
												}}
											/>
											{responseTypeLabel(responseType.value)}
										</label>
									{/each}
								</div>
							{:else}
								<p class="display-text">{client.response_types.join(', ') || '-'}</p>
							{/if}
						</div>

						<!-- Token Endpoint Auth Method -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label"
								>{$LL.admin_client_detail_token_endpoint_auth_method()}</label
							>
							{#if isEditing}
								<select class="form-select" bind:value={editForm.token_endpoint_auth_method}>
									<option value="none">none ({$LL.admin_client_detail_public_client()})</option>
									<option value="client_secret_basic">client_secret_basic</option>
									<option value="client_secret_post">client_secret_post</option>
									<option value="private_key_jwt">private_key_jwt</option>
								</select>
							{:else}
								<p class="display-text">{client.token_endpoint_auth_method || 'none'}</p>
							{/if}
						</div>

						<!-- Browser Public Client Mode -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_clients_new_browser_public_mode()}</label>
							{#if isEditing}
								<select
									class="form-select"
									value={editForm.browser_public_client_mode ?? ''}
									onchange={(e) => {
										const value = e.currentTarget.value as '' | 'strict' | 'cookie_fallback';
										editForm.browser_public_client_mode = value || null;
									}}
								>
									<option value="">{$LL.admin_clients_new_server_default()}</option>
									<option value="strict">{$LL.admin_clients_new_strict_dpop()}</option>
									<option value="cookie_fallback">
										{$LL.admin_clients_new_cookie_fallback()}
									</option>
								</select>
							{:else}
								<p class="display-text">
									{client.browser_public_client_mode || $LL.admin_clients_new_server_default()}
								</p>
							{/if}
							<p class="form-hint">
								{$LL.admin_client_detail_browser_public_hint()}
							</p>
						</div>

						<!-- Browser Refresh Token Policy -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_clients_new_browser_refresh_policy()}</label>
							{#if isEditing}
								<select class="form-select" bind:value={editForm.browser_refresh_token_policy}>
									<option value="disabled">{$LL.admin_clients_new_disabled()}</option>
									<option value="dpop_bound">
										{$LL.admin_clients_new_dpop_refresh_tokens()}
									</option>
								</select>
							{:else}
								<p class="display-text">
									{client.browser_refresh_token_policy || $LL.admin_clients_new_disabled()}
								</p>
							{/if}
							<p class="form-hint">
								{$LL.admin_client_detail_browser_refresh_hint()}
							</p>
						</div>

						<!-- PKCE Required -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.pkce_required}
									label={$LL.admin_client_detail_pkce_required()}
									description={$LL.admin_client_detail_pkce_required_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_pkce_required()}</label>
								<p class="display-text">
									{formatEnabled(clientSettings?.values['client.pkce_required'] as boolean)}
								</p>
							{/if}
						</div>

						<!-- PAR Required -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.par_required}
									label={$LL.admin_client_detail_par_required()}
									description={$LL.admin_client_detail_par_required_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_par_required()}</label>
								<p class="display-text">
									{formatEnabled(clientSettings?.values['client.par_required'] as boolean)}
								</p>
							{/if}
						</div>

						<!-- DPoP Required -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.dpop_required}
									label={$LL.admin_client_detail_dpop_required()}
									description={$LL.admin_client_detail_dpop_required_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_dpop_required()}</label>
								<p class="display-text">
									{formatEnabled(clientSettings?.values['client.dpop_required'] as boolean)}
								</p>
							{/if}
						</div>

						<!-- DPoP Mode -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_dpop_mode()}</label>
							{#if isEditing}
								<select class="form-select" bind:value={settingsEditForm.dpop_mode}>
									<option value="disabled">{$LL.admin_clients_new_disabled()}</option>
									<option value="critical_only">
										{$LL.admin_client_detail_dpop_critical_only()}
									</option>
									<option value="all">{$LL.admin_client_detail_dpop_all_endpoints()}</option>
								</select>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.dpop_mode'] || 'disabled'}
								</p>
							{/if}
						</div>
					</div>
				</section>

				<!-- Scopes Section -->
				<section class="section-spacing">
					<h2 class="section-title-border">{$LL.admin_client_detail_scopes_section()}</h2>

					<div class="form-grid">
						<!-- Allowed Scopes -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_clients_new_allowed_scopes()}</label>
							{#if isEditing}
								<input
									type="text"
									class="form-input"
									bind:value={downstreamGrantEditForm.allowed_scopes}
									placeholder="openid profile email (space-separated)"
								/>
								<p class="form-hint">
									{$LL.admin_client_detail_allowed_scopes_hint()}
								</p>
							{:else}
								<p class="display-text">
									{client?.allowed_scopes?.join(' ') || $LL.admin_clients_new_allowed_scopes_hint()}
								</p>
							{/if}
						</div>

						<!-- Default Scope -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_clients_new_default_scope()}</label>
							{#if isEditing}
								<input
									type="text"
									class="form-input"
									bind:value={downstreamGrantEditForm.default_scope}
									placeholder="openid profile"
								/>
								<p class="form-hint">{$LL.admin_client_detail_default_scope_hint()}</p>
							{:else}
								<p class="display-text">
									{client?.default_scope || $LL.admin_clients_new_delegation_none()}
								</p>
							{/if}
						</div>
					</div>
				</section>

				<!-- Redirect URIs -->
				<section class="section-spacing">
					<h2 class="section-title-border">{$LL.admin_client_detail_redirectUris()}</h2>
					{#if isEditing}
						<div class="redirect-uri-editor">
							{#each editForm.redirect_uris || [] as uri, index (index)}
								<div class="input-copy-group">
									<input
										type="url"
										class="form-input"
										value={uri}
										oninput={(e) => {
											const target = e.target as HTMLInputElement;
											const newUris = [...(editForm.redirect_uris || [])];
											newUris[index] = target.value;
											editForm.redirect_uris = newUris;
										}}
										placeholder="https://example.com/callback"
									/>
									<button
										type="button"
										class="btn btn-danger btn-sm"
										onclick={() => {
											editForm.redirect_uris = (editForm.redirect_uris || []).filter(
												(_, i) => i !== index
											);
										}}
									>
										{$LL.admin_saml_detail_delete()}
									</button>
								</div>
							{/each}
							<button
								type="button"
								class="btn-add"
								onclick={() => {
									editForm.redirect_uris = [...(editForm.redirect_uris || []), ''];
								}}
							>
								+ {$LL.admin_clients_new_add_redirect_uri()}
							</button>
						</div>
					{:else if client.redirect_uris.length > 0}
						<ul class="uri-list">
							{#each client.redirect_uris as uri (uri)}
								<li class="uri-item uri-item-with-cors">
									<span class="uri-text">{uri}</span>
									{#if tenantSettings}
										{#if isOriginInCors(uri)}
											<span class="badge badge-success">{$LL.admin_clients_new_origin_ok()}</span>
										{:else}
											<button
												class="btn btn-secondary btn-sm"
												onclick={() => addToCors(uri)}
												disabled={addingToCors === uri}
											>
												{addingToCors === uri
													? $LL.admin_clients_new_adding()
													: $LL.admin_clients_new_add_origin()}
											</button>
										{/if}
									{/if}
								</li>
							{/each}
						</ul>
						{#if tenantSettings && client.redirect_uris.some((uri) => !isOriginInCors(uri))}
							<p class="form-hint cors-hint">
								{$LL.admin_clients_new_cors_hint()}
							</p>
						{/if}
					{:else}
						<p class="display-text muted">{$LL.admin_client_detail_no_redirect_uris()}</p>
					{/if}
				</section>

				<!-- Timestamps -->
				<section>
					<h2 class="section-title-border">{$LL.admin_client_detail_timestamps()}</h2>
					<div class="info-grid">
						<div class="info-item">
							<dt>{$LL.admin_client_detail_created()}</dt>
							<dd class="info-value">{formatDate(client.created_at)}</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_client_detail_updated()}</dt>
							<dd class="info-value">{formatDate(client.updated_at)}</dd>
						</div>
					</div>
				</section>

				<!-- Edit Actions -->
				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>
							{$LL.admin_client_detail_cancel()}
						</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? $LL.admin_client_detail_saving() : $LL.admin_client_detail_save_changes()}
						</button>
					</div>
				{/if}

				<!-- Delete Client Section -->
				<section class="section-spacing danger-section">
					<h2 class="section-title-border danger-title">{$LL.admin_client_detail_danger_zone()}</h2>
					<div class="danger-zone">
						<div class="danger-zone-content">
							<h3 class="danger-zone-title">{$LL.admin_client_detail_delete_this_client()}</h3>
							<p class="danger-zone-description">
								{$LL.admin_client_detail_delete_desc()}
							</p>
						</div>
						<button class="btn btn-danger" onclick={() => (showDeleteModal = true)}>
							{$LL.admin_client_detail_deleteClient()}
						</button>
					</div>
				</section>
			{:else if activeTab === 'tokens'}
				<!-- Tokens Tab -->
				<section class="section-spacing">
					<h2 class="section-title-border">{$LL.admin_client_detail_token_lifetimes()}</h2>

					<div class="form-grid">
						<!-- Access Token TTL -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_access_token_ttl()}</label>
							{#if isEditing}
								<input
									type="number"
									class="form-input"
									bind:value={settingsEditForm.access_token_ttl}
									min="60"
									step="60"
								/>
								<p class="form-hint">{$LL.admin_client_detail_access_token_ttl_hint()}</p>
							{:else}
								<p class="display-text">
									{$LL.admin_client_detail_seconds({
										seconds: Number(clientSettings?.values['client.access_token_ttl'] || 3600)
									})}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_access_token_ttl_hint()}</p>
							{/if}
						</div>

						<!-- Refresh Token TTL -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_refresh_token_ttl()}</label>
							{#if isEditing}
								<input
									type="number"
									class="form-input"
									bind:value={settingsEditForm.refresh_token_ttl}
									min="3600"
									step="3600"
								/>
								<p class="form-hint">{$LL.admin_client_detail_refresh_token_ttl_hint()}</p>
							{:else}
								<p class="display-text">
									{$LL.admin_client_detail_seconds({
										seconds: Number(clientSettings?.values['client.refresh_token_ttl'] || 7776000)
									})}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_refresh_token_ttl_hint()}</p>
							{/if}
						</div>

						<!-- ID Token TTL -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_id_token_ttl()}</label>
							{#if isEditing}
								<input
									type="number"
									class="form-input"
									bind:value={settingsEditForm.id_token_ttl}
									min="60"
									step="60"
								/>
								<p class="form-hint">{$LL.admin_client_detail_id_token_ttl_hint()}</p>
							{:else}
								<p class="display-text">
									{$LL.admin_client_detail_seconds({
										seconds: Number(clientSettings?.values['client.id_token_ttl'] || 3600)
									})}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_id_token_ttl_hint()}</p>
							{/if}
						</div>
					</div>
				</section>

				<section class="section-spacing">
					<h2 class="section-title-border">{$LL.admin_client_detail_token_behavior()}</h2>

					<div class="form-grid">
						<!-- Refresh Token Rotation -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.refresh_token_rotation}
									label={$LL.admin_client_detail_refresh_token_rotation()}
									description={$LL.admin_client_detail_refresh_token_rotation_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_refresh_token_rotation()}</label>
								<p class="display-text">
									{formatEnabled(
										clientSettings?.values['client.refresh_token_rotation'] as boolean
									)}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_refresh_token_rotation_desc()}</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- Reuse Refresh Token -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.reuse_refresh_token}
										label={$LL.admin_client_detail_reuse_refresh_token()}
										description={$LL.admin_client_detail_reuse_refresh_token_desc()}
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">{$LL.admin_client_detail_reuse_refresh_token()}</label>
									<p class="display-text">
										{formatEnabled(clientSettings?.values['client.reuse_refresh_token'] as boolean)}
									</p>
									<p class="form-hint">{$LL.admin_client_detail_reuse_refresh_token_desc()}</p>
								{/if}
							</div>
						{/if}

						<!-- DPoP Bound Access Tokens -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.dpop_bound_access_tokens}
									label={$LL.admin_client_detail_dpop_bound_access_tokens()}
									description={$LL.admin_client_detail_dpop_bound_access_tokens_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label"
									>{$LL.admin_client_detail_dpop_bound_access_tokens()}</label
								>
								<p class="display-text">
									{formatEnabled(
										clientSettings?.values['client.dpop_bound_access_tokens'] as boolean
									)}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_dpop_bound_access_tokens_desc()}</p>
							{/if}
						</div>

						<!-- Token Exchange Allowed -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={downstreamGrantEditForm.token_exchange_allowed}
									label={$LL.admin_client_detail_token_exchange_allowed()}
									description={$LL.admin_client_detail_token_exchange_allowed_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_token_exchange_allowed()}</label>
								<p class="display-text">
									{formatEnabled(client?.token_exchange_allowed)}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_token_exchange_allowed_desc()}</p>
							{/if}
						</div>

						<!-- Delegation Mode -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_clients_new_delegation_mode()}</label>
							{#if isEditing}
								<select class="form-select" bind:value={downstreamGrantEditForm.delegation_mode}>
									<option value="none">{$LL.admin_clients_new_delegation_none()}</option>
									<option value="delegation">{$LL.admin_clients_new_delegation()}</option>
									<option value="impersonation">{$LL.admin_clients_new_impersonation()}</option>
								</select>
								<p class="form-hint">
									{$LL.admin_client_detail_token_exchange_delegation_mode()}
								</p>
							{:else}
								<p class="display-text">
									{client?.delegation_mode || 'delegation'}
								</p>
								<p class="form-hint">
									{$LL.admin_client_detail_token_exchange_delegation_mode()}
								</p>
							{/if}
						</div>
					</div>
				</section>

				<!-- Edit Actions for Tokens Tab -->
				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>
							{$LL.admin_client_detail_cancel()}
						</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? $LL.admin_client_detail_saving() : $LL.admin_client_detail_save_changes()}
						</button>
					</div>
				{/if}
			{:else if activeTab === 'security'}
				<!-- Security Tab -->
				<section class="section-spacing">
					<h2 class="section-title-border">{$LL.admin_client_detail_security_settings()}</h2>

					<div class="form-grid">
						<!-- Consent Required -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.consent_required}
									label={$LL.admin_client_detail_consent_required()}
									description={$LL.admin_client_detail_consent_required_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_consent_required()}</label>
								<p class="display-text">
									{formatEnabled(clientSettings?.values['client.consent_required'] as boolean)}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_consent_required_desc()}</p>
							{/if}
						</div>

						<!-- SSO Enabled -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.sso_enabled}
									label={$LL.admin_client_detail_sso_enabled()}
									description={$LL.admin_client_detail_sso_enabled_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_sso_enabled()}</label>
								<p class="display-text">
									{formatEnabled(clientSettings?.values['client.sso_enabled'] as boolean)}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_sso_enabled_hint()}</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- First Party App -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.first_party}
										label={$LL.admin_client_detail_first_party_app()}
										description={$LL.admin_client_detail_first_party_app_desc()}
										onchange={(newValue) => {
											if (!newValue) {
												settingsEditForm.app_login_enabled = false;
											}
										}}
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">{$LL.admin_client_detail_first_party_app()}</label>
									<p class="display-text">
										{formatEnabled(clientSettings?.values['client.first_party'] as boolean)}
									</p>
									<p class="form-hint">{$LL.admin_client_detail_first_party_app_desc()}</p>
								{/if}
							</div>

							<!-- App Login Enabled -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.app_login_enabled}
										label={$LL.admin_client_detail_app_login_enabled()}
										description={$LL.admin_client_detail_app_login_enabled_desc()}
										disabled={!settingsEditForm.first_party}
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">{$LL.admin_client_detail_app_login_enabled()}</label>
									<p class="display-text">
										{formatEnabled(clientSettings?.values['client.app_login_enabled'] as boolean)}
									</p>
									<p class="form-hint">{$LL.admin_client_detail_app_login_enabled_desc()}</p>
								{/if}
							</div>

							<!-- Strict Redirect Matching -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.strict_redirect_matching}
										label={$LL.admin_client_detail_strict_redirect_matching()}
										description={$LL.admin_client_detail_strict_redirect_matching_desc()}
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label"
										>{$LL.admin_client_detail_strict_redirect_matching()}</label
									>
									<p class="display-text">
										{formatEnabled(
											clientSettings?.values['client.strict_redirect_matching'] as boolean
										)}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_strict_redirect_matching_desc()}
									</p>
								{/if}
							</div>

							<!-- Allow Localhost Redirect -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.allow_localhost_redirect}
										label={$LL.admin_client_detail_allow_localhost_redirect()}
										description={$LL.admin_client_detail_allow_localhost_redirect_desc()}
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label"
										>{$LL.admin_client_detail_allow_localhost_redirect()}</label
									>
									<p class="display-text">
										{formatEnabled(
											clientSettings?.values['client.allow_localhost_redirect'] as boolean
										)}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_allow_localhost_redirect_desc()}
									</p>
								{/if}
							</div>

							<!-- Default Max Age -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_default_max_age()}</label>
								{#if isEditing}
									<input
										type="number"
										class="form-input"
										bind:value={settingsEditForm.default_max_age}
										min="0"
										step="60"
									/>
									<p class="form-hint">{$LL.admin_client_detail_default_max_age_hint()}</p>
								{:else}
									<p class="display-text">
										{$LL.admin_client_detail_seconds({
											seconds: Number(clientSettings?.values['client.default_max_age'] || 0)
										})}
									</p>
									<p class="form-hint">{$LL.admin_client_detail_default_max_age_hint()}</p>
								{/if}
							</div>

							<!-- Default ACR Values -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_default_acr_values()}</label>
								{#if isEditing}
									<input
										type="text"
										class="form-input"
										bind:value={settingsEditForm.default_acr_values}
										placeholder="acr1 acr2"
									/>
									<p class="form-hint">
										{$LL.admin_client_detail_default_acr_values_hint()}
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.default_acr_values'] ||
											$LL.admin_clients_new_delegation_none()}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_default_acr_values_hint()}
									</p>
								{/if}
							</div>

							<!-- Require Auth Time -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.require_auth_time}
										label={$LL.admin_client_detail_require_auth_time()}
										description={$LL.admin_client_detail_require_auth_time_desc()}
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">{$LL.admin_client_detail_require_auth_time()}</label>
									<p class="display-text">
										{formatEnabled(clientSettings?.values['client.require_auth_time'] as boolean)}
									</p>
									<p class="form-hint">{$LL.admin_client_detail_require_auth_time_desc()}</p>
								{/if}
							</div>

							<!-- Subject Type -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_subject_type()}</label>
								{#if isEditing}
									<select class="form-select" bind:value={settingsEditForm.subject_type}>
										<option value="public">{$LL.admin_client_detail_subject_public()}</option>
										<option value="pairwise">{$LL.admin_client_detail_subject_pairwise()}</option>
									</select>
									<p class="form-hint">{$LL.admin_client_detail_subject_type_hint()}</p>
								{:else}
									<p class="display-text">
										{subjectTypeLabel(
											String(clientSettings?.values['client.subject_type'] || 'public')
										)}
									</p>
									<p class="form-hint">{$LL.admin_client_detail_subject_type_hint()}</p>
								{/if}
							</div>
						{/if}
					</div>
				</section>

				<section class="section-spacing">
					<FlowAssignmentSettings targetType="oidc_client" targetId={clientId} />
				</section>

				<section class="section-spacing">
					<ConsentPolicyTargetSettings
						targetType="oidc_client"
						targetId={clientId}
						title="OIDC consent policy"
					/>
				</section>

				<!-- Edit Actions for Security Tab -->
				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>
							{$LL.admin_client_detail_cancel()}
						</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? $LL.admin_client_detail_saving() : $LL.admin_client_detail_save_changes()}
						</button>
					</div>
				{/if}
			{:else if activeTab === 'scopes'}
				<!-- Scopes & Permissions Tab -->
				<section class="section-spacing">
					<h2 class="section-title-border">{$LL.admin_client_detail_scope_settings()}</h2>

					<div class="form-grid">
						<!-- Default Audience -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_clients_new_default_audience()}</label>
							{#if isEditing}
								<input
									type="text"
									class="form-input"
									bind:value={downstreamGrantEditForm.default_audience}
									placeholder="https://api.example.com"
								/>
								<p class="form-hint">{$LL.admin_client_detail_default_audience_hint()}</p>
							{:else}
								<p class="display-text">
									{client?.default_audience || $LL.admin_clients_new_delegation_none()}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_default_audience_hint()}</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- Allowed Scopes Restriction Enabled -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.allowed_scopes_restriction_enabled}
										label={$LL.admin_client_detail_scope_restriction_enabled()}
										description={$LL.admin_client_detail_scope_restriction_enabled_desc()}
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label"
										>{$LL.admin_client_detail_scope_restriction_enabled()}</label
									>
									<p class="display-text">
										{formatEnabled(
											clientSettings?.values['client.allowed_scopes_restriction_enabled'] as boolean
										)}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_scope_restriction_enabled_desc()}
									</p>
								{/if}
							</div>
						{/if}

						<!-- Client Credentials Allowed -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={downstreamGrantEditForm.client_credentials_allowed}
									label={$LL.admin_client_detail_client_credentials_allowed()}
									description={$LL.admin_client_detail_client_credentials_allowed_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label"
									>{$LL.admin_client_detail_client_credentials_allowed()}</label
								>
								<p class="display-text">
									{formatEnabled(client?.client_credentials_allowed)}
								</p>
								<p class="form-hint">
									{$LL.admin_client_detail_client_credentials_allowed_desc()}
								</p>
							{/if}
						</div>
					</div>
				</section>

				<section class="section-spacing">
					<h2 class="section-title-border">{$LL.admin_client_detail_downstream_restrictions()}</h2>

					<div class="form-grid">
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label"
								>{$LL.admin_clients_new_allowed_subject_token_clients()}</label
							>
							{#if isEditing}
								<textarea
									class="form-input textarea-input"
									rows="5"
									bind:value={downstreamGrantEditForm.allowed_subject_token_clients}
									placeholder="svc-client-a&#10;svc-client-b"
								></textarea>
								<p class="form-hint">
									{$LL.admin_client_detail_subject_token_clients_hint()}
								</p>
							{:else}
								<p class="display-text preformatted-text">
									{formatClientListForTextarea(client?.allowed_subject_token_clients) ||
										$LL.admin_client_detail_any_subject_token_client()}
								</p>
								<p class="form-hint">
									{$LL.admin_client_detail_subject_token_clients_display_hint()}
								</p>
							{/if}
						</div>

						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label"
								>{$LL.admin_clients_new_allowed_token_exchange_resources()}</label
							>
							{#if isEditing}
								<textarea
									class="form-input textarea-input"
									rows="5"
									bind:value={downstreamGrantEditForm.allowed_token_exchange_resources}
									placeholder="svc://op-userinfo/customer-profile&#10;svc://op-userinfo/customer-export"
								></textarea>
								<p class="form-hint">
									{$LL.admin_client_detail_token_exchange_resources_hint()}
								</p>
							{:else}
								<p class="display-text preformatted-text">
									{formatClientListForTextarea(client?.allowed_token_exchange_resources) ||
										$LL.admin_client_detail_any_downstream_resource()}
								</p>
								<p class="form-hint">
									{$LL.admin_client_detail_token_exchange_resources_display_hint()}
								</p>
							{/if}
						</div>
					</div>
				</section>

				<section class="section-spacing">
					<h2 class="section-title-border">{$LL.admin_clients_new_grant_types_label()}</h2>

					<div class="form-grid">
						<!-- Allow Authorization Code -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.allow_authorization_code}
									label={$LL.admin_client_detail_allow_authorization_code()}
									description={$LL.admin_client_detail_allow_authorization_code_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label"
									>{$LL.admin_client_detail_allow_authorization_code()}</label
								>
								<p class="display-text">
									{formatEnabled(
										clientSettings?.values['client.allow_authorization_code'] as boolean
									)}
								</p>
								<p class="form-hint">
									{$LL.admin_client_detail_allow_authorization_code_desc()}
								</p>
							{/if}
						</div>

						<!-- Allow Client Credentials -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.allow_client_credentials}
									label={$LL.admin_client_detail_allow_client_credentials()}
									description={$LL.admin_client_detail_allow_client_credentials_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label"
									>{$LL.admin_client_detail_allow_client_credentials()}</label
								>
								<p class="display-text">
									{formatEnabled(
										clientSettings?.values['client.allow_client_credentials'] as boolean
									)}
								</p>
								<p class="form-hint">
									{$LL.admin_client_detail_allow_client_credentials_desc()}
								</p>
							{/if}
						</div>

						<!-- Allow Refresh Token -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.allow_refresh_token}
									label={$LL.admin_client_detail_allow_refresh_token()}
									description={$LL.admin_client_detail_allow_refresh_token_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_allow_refresh_token()}</label>
								<p class="display-text">
									{formatEnabled(clientSettings?.values['client.allow_refresh_token'] as boolean)}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_allow_refresh_token_desc()}</p>
							{/if}
						</div>

						<!-- Allow Device Code -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.allow_device_code}
									label={$LL.admin_client_detail_allow_device_code()}
									description={$LL.admin_client_detail_allow_device_code_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_allow_device_code()}</label>
								<p class="display-text">
									{formatEnabled(clientSettings?.values['client.allow_device_code'] as boolean)}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_allow_device_code_desc()}</p>
							{/if}
						</div>

						<!-- Allow CIBA -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.allow_ciba}
									label={$LL.admin_client_detail_allow_ciba()}
									description={$LL.admin_client_detail_allow_ciba_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_allow_ciba()}</label>
								<p class="display-text">
									{formatEnabled(clientSettings?.values['client.allow_ciba'] as boolean)}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_allow_ciba_desc()}</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- Allow Code Response -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.allow_code_response}
										label={$LL.admin_client_detail_allow_code_response()}
										description={$LL.admin_client_detail_allow_code_response_desc()}
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">{$LL.admin_client_detail_allow_code_response()}</label>
									<p class="display-text">
										{formatEnabled(clientSettings?.values['client.allow_code_response'] as boolean)}
									</p>
									<p class="form-hint">{$LL.admin_client_detail_allow_code_response_desc()}</p>
								{/if}
							</div>

							<!-- Allow Token Response -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.allow_token_response}
										label={$LL.admin_client_detail_allow_token_response()}
										description={$LL.admin_client_detail_allow_token_response_desc()}
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">{$LL.admin_client_detail_allow_token_response()}</label>
									<p class="display-text">
										{formatEnabled(
											clientSettings?.values['client.allow_token_response'] as boolean
										)}
									</p>
									<p class="form-hint">{$LL.admin_client_detail_allow_token_response_desc()}</p>
								{/if}
							</div>

							<!-- Allow ID Token Response -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.allow_id_token_response}
										label={$LL.admin_client_detail_allow_id_token_response()}
										description={$LL.admin_client_detail_allow_id_token_response_desc()}
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label"
										>{$LL.admin_client_detail_allow_id_token_response()}</label
									>
									<p class="display-text">
										{formatEnabled(
											clientSettings?.values['client.allow_id_token_response'] as boolean
										)}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_allow_id_token_response_desc()}
									</p>
								{/if}
							</div>
						{/if}
					</div>
				</section>

				<!-- Edit Actions for Scopes Tab -->
				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>
							{$LL.admin_client_detail_cancel()}
						</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? $LL.admin_client_detail_saving() : $LL.admin_client_detail_save_changes()}
						</button>
					</div>
				{/if}
			{:else if activeTab === 'claims'}
				<section class="section-spacing">
					<h2 class="section-title-border">
						{$LL.admin_client_detail_identity_mapping_section()}
					</h2>

					<div class="form-grid">
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_identity_mapping_policy()}</label>
							{#if isEditing}
								<select
									class="form-select"
									value={editForm.identity_mapping?.fieldMappingSetId ?? ''}
									onchange={(event) => setIdentityMappingFieldMappingSet(event.currentTarget.value)}
								>
									<option value=""
										>{$LL.admin_client_detail_identity_mapping_policy_default()}</option
									>
									{#each fieldMappingSets as fieldMappingSet (fieldMappingSet.id)}
										<option value={fieldMappingSet.id}>
											{fieldMappingSet.displayName} ({fieldMappingSet.lifecycleState})
										</option>
									{/each}
								</select>
								<p class="form-hint">
									{$LL.admin_client_detail_identity_mapping_policy_hint()}
								</p>
							{:else}
								<p class="display-text">
									{identityMappingFieldMappingLabel(client.identity_mapping?.fieldMappingSetId)}
								</p>
								<p class="form-hint">
									{$LL.admin_client_detail_identity_mapping_policy_display_hint()}
								</p>
							{/if}
						</div>

						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_attribute_release_consent()}</label
							>
							{#if isEditing}
								<select
									class="form-select"
									value={attributeReleaseConsentValue(editForm.attribute_release_consent)}
									onchange={(event) => setAttributeReleaseConsent(event.currentTarget.value)}
								>
									<option value="disabled"
										>{$LL.admin_client_detail_attribute_release_consent_disabled()}</option
									>
									<option value="once"
										>{$LL.admin_client_detail_attribute_release_consent_once()}</option
									>
									<option value="every_time"
										>{$LL.admin_client_detail_attribute_release_consent_every_time()}</option
									>
									<option value="until_attributes_change"
										>{$LL.admin_client_detail_attribute_release_consent_until_attributes_change()}</option
									>
								</select>
								<p class="form-hint">
									{$LL.admin_client_detail_attribute_release_consent_hint()}
								</p>
							{:else}
								<p class="display-text">
									{attributeReleaseConsentLabel(client.attribute_release_consent)}
								</p>
								<p class="form-hint">
									{$LL.admin_client_detail_attribute_release_consent_display_hint()}
								</p>
							{/if}
						</div>
					</div>
				</section>

				<section class="section-spacing">
					<h2 class="section-title-border">{$LL.admin_client_detail_claims_parameter()}</h2>

					<div class="form-grid">
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={editForm.allow_claims_without_scope}
									label={$LL.admin_clients_new_allow_claims_without_scope()}
									description={$LL.admin_clients_new_allow_claims_without_scope_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label"
									>{$LL.admin_clients_new_allow_claims_without_scope()}</label
								>
								<p class="display-text">
									{formatEnabled(client.allow_claims_without_scope)}
								</p>
							{/if}
						</div>

						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_clients_new_claims_policy()}</label>
							{#if isEditing}
								<textarea
									class="form-input textarea-input"
									rows="6"
									bind:value={claimsParameterPolicyText}
									placeholder="email: claims_allowed&#10;birthdate: claims_allowed"
								></textarea>
								<p class="form-hint">
									{$LL.admin_clients_new_claims_policy_hint()}
								</p>
							{:else}
								<p class="display-text preformatted-text">
									{formatClaimsParameterPolicy(client.claims_parameter_policy) ||
										$LL.admin_client_detail_scope_required()}
								</p>
							{/if}
						</div>
					</div>
				</section>

				<section class="section-spacing">
					<h2 class="section-title-border">{$LL.admin_client_detail_advanced_syntax_claims()}</h2>

					<div class="form-grid">
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={editForm.asc_enabled}
									label={$LL.admin_clients_new_enable_asc()}
									description={$LL.admin_clients_new_enable_asc_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_asc()}</label>
								<p class="display-text">{formatEnabled(client.asc_enabled)}</p>
							{/if}
						</div>

						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={editForm.asc_protected_request_required}
									label={$LL.admin_clients_new_require_protected_asc()}
									description={$LL.admin_clients_new_require_protected_asc_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label"
									>{$LL.admin_client_detail_protected_request_required()}</label
								>
								<p class="display-text">{formatEnabled(client.asc_protected_request_required)}</p>
							{/if}
						</div>

						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={editForm.asc_sao_enabled}
									label={$LL.admin_clients_new_enable_sao()}
									description={$LL.admin_clients_new_enable_sao_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_selective_abort_omit()}</label>
								<p class="display-text">{formatEnabled(client.asc_sao_enabled)}</p>
							{/if}
						</div>

						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={editForm.asc_transformed_claims_enabled}
									label={$LL.admin_clients_new_enable_transformed_claims()}
									description={$LL.admin_clients_new_enable_transformed_claims_desc()}
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_transformed_claims()}</label>
								<p class="display-text">{formatEnabled(client.asc_transformed_claims_enabled)}</p>
							{/if}
						</div>
					</div>

					<div class="form-group">
						<!-- svelte-ignore a11y_label_has_associated_control -->
						<label class="form-label">{$LL.admin_clients_new_allowed_transformed_claims()}</label>
						{#if isEditing}
							<div class="checkbox-list">
								{#each ASC_TRANSFORMED_CLAIMS as transformedClaim (transformedClaim.id)}
									<label class="checkbox-list-item">
										<input
											type="checkbox"
											checked={editForm.asc_allowed_transformed_claims?.includes(
												transformedClaim.id
											)}
											onchange={() => toggleEditAscAllowedTransformedClaim(transformedClaim.id)}
										/>
										{transformedClaimLabel(transformedClaim.id)}
									</label>
								{/each}
							</div>
						{:else}
							<p class="display-text">
								{getEffectiveAscAllowedTransformedClaims(client)
									.map(transformedClaimLabel)
									.join(', ')}
							</p>
						{/if}
					</div>
				</section>

				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>
							{$LL.admin_client_detail_cancel()}
						</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? $LL.admin_client_detail_saving() : $LL.admin_client_detail_save_changes()}
						</button>
					</div>
				{/if}
			{:else if activeTab === 'session'}
				<!-- Session & Logout Tab -->
				<section class="section-spacing">
					<h2 class="section-title-border">
						{$LL.admin_client_detail_session_frontchannel_logout()}
					</h2>

					<div class="form-grid">
						<!-- Frontchannel Logout URI -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_frontchannel_logout_uri()}</label>
							{#if isEditing}
								<input
									type="url"
									class="form-input"
									bind:value={settingsEditForm.frontchannel_logout_uri}
									placeholder="https://example.com/frontchannel_logout"
								/>
								<p class="form-hint">{$LL.admin_client_detail_frontchannel_logout_uri_hint()}</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.frontchannel_logout_uri'] ||
										$LL.admin_client_detail_not_configured()}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_frontchannel_logout_uri_hint()}</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- Frontchannel Logout Session Required -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.frontchannel_logout_session_required}
										label={$LL.admin_client_detail_frontchannel_logout_session_required()}
										description={$LL.admin_client_detail_frontchannel_logout_session_required_desc()}
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label"
										>{$LL.admin_client_detail_frontchannel_logout_session_required()}</label
									>
									<p class="display-text">
										{formatEnabled(
											clientSettings?.values[
												'client.frontchannel_logout_session_required'
											] as boolean
										)}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_frontchannel_logout_session_required_desc()}
									</p>
								{/if}
							</div>
						{/if}
					</div>
				</section>

				<section class="section-spacing">
					<h2 class="section-title-border">
						{$LL.admin_client_detail_session_backchannel_logout()}
					</h2>

					<div class="form-grid">
						<!-- Backchannel Logout URI -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_backchannel_logout_uri()}</label>
							{#if isEditing}
								<input
									type="url"
									class="form-input"
									bind:value={settingsEditForm.backchannel_logout_uri}
									placeholder="https://example.com/backchannel_logout"
								/>
								<p class="form-hint">{$LL.admin_client_detail_backchannel_logout_uri_hint()}</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.backchannel_logout_uri'] ||
										$LL.admin_client_detail_not_configured()}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_backchannel_logout_uri_hint()}</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- Backchannel Logout Session Required -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.backchannel_logout_session_required}
										label={$LL.admin_client_detail_backchannel_logout_session_required()}
										description={$LL.admin_client_detail_backchannel_logout_session_required_desc()}
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label"
										>{$LL.admin_client_detail_backchannel_logout_session_required()}</label
									>
									<p class="display-text">
										{formatEnabled(
											clientSettings?.values[
												'client.backchannel_logout_session_required'
											] as boolean
										)}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_backchannel_logout_session_required_desc()}
									</p>
								{/if}
							</div>
						{/if}
					</div>
				</section>

				<!-- Edit Actions for Session Tab -->
				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>
							{$LL.admin_client_detail_cancel()}
						</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? $LL.admin_client_detail_saving() : $LL.admin_client_detail_save_changes()}
						</button>
					</div>
				{/if}
			{:else if activeTab === 'metadata'}
				<!-- Client Metadata Tab -->
				<section class="section-spacing">
					<h2 class="section-title-border">{$LL.admin_client_detail_client_metadata()}</h2>

					<div class="form-grid">
						<!-- Logo URI -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_logo_uri()}</label>
							{#if isEditing}
								<input
									type="url"
									class="form-input"
									bind:value={settingsEditForm.logo_uri}
									placeholder="https://example.com/logo.png"
								/>
								<p class="form-hint">{$LL.admin_client_detail_logo_uri_hint()}</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.logo_uri'] ||
										$LL.admin_client_detail_not_configured()}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_logo_uri_hint()}</p>
							{/if}
						</div>

						<!-- Contacts -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_contacts()}</label>
							{#if isEditing}
								<input
									type="text"
									class="form-input"
									bind:value={settingsEditForm.contacts}
									placeholder="admin@example.com, support@example.com"
								/>
								<p class="form-hint">{$LL.admin_client_detail_contacts_hint()}</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.contacts'] ||
										$LL.admin_clients_new_delegation_none()}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_contacts_hint()}</p>
							{/if}
						</div>

						<!-- Terms of Service URI -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_tos_uri()}</label>
							{#if isEditing}
								<input
									type="url"
									class="form-input"
									bind:value={settingsEditForm.tos_uri}
									placeholder="https://example.com/tos"
								/>
								<p class="form-hint">{$LL.admin_client_detail_tos_uri_hint()}</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.tos_uri'] ||
										$LL.admin_client_detail_not_configured()}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_tos_uri_hint()}</p>
							{/if}
						</div>

						<!-- Privacy Policy URI -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_privacy_policy_uri()}</label>
							{#if isEditing}
								<input
									type="url"
									class="form-input"
									bind:value={settingsEditForm.policy_uri}
									placeholder="https://example.com/privacy"
								/>
								<p class="form-hint">{$LL.admin_client_detail_privacy_policy_uri_hint()}</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.policy_uri'] ||
										$LL.admin_client_detail_not_configured()}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_privacy_policy_uri_hint()}</p>
							{/if}
						</div>

						<!-- Client URI -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_client_uri()}</label>
							{#if isEditing}
								<input
									type="url"
									class="form-input"
									bind:value={settingsEditForm.client_uri}
									placeholder="https://example.com"
								/>
								<p class="form-hint">{$LL.admin_client_detail_client_uri_hint()}</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.client_uri'] ||
										$LL.admin_client_detail_not_configured()}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_client_uri_hint()}</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- Initiate Login URI -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_initiate_login_uri()}</label>
								{#if isEditing}
									<input
										type="url"
										class="form-input"
										bind:value={settingsEditForm.initiate_login_uri}
										placeholder="https://example.com/initiate_login"
									/>
									<p class="form-hint">{$LL.admin_client_detail_initiate_login_uri_hint()}</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.initiate_login_uri'] ||
											$LL.admin_client_detail_not_configured()}
									</p>
									<p class="form-hint">{$LL.admin_client_detail_initiate_login_uri_hint()}</p>
								{/if}
							</div>
						{/if}

						<!-- Login UI URL -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_login_ui_url()}</label>
							{#if isEditing}
								<input
									type="url"
									class="form-input"
									bind:value={settingsEditForm.login_ui_url}
									placeholder="https://login.your-domain.com"
								/>
								<p class="form-hint">
									{$LL.admin_client_detail_login_ui_url_edit_hint()}
								</p>
							{:else}
								<p class="display-text">
									{client?.login_ui_url || $LL.admin_client_detail_not_configured()}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_login_ui_url_hint()}</p>
							{/if}
						</div>

						<!-- Application Type -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_application_type()}</label>
							{#if isEditing}
								<select class="form-select" bind:value={settingsEditForm.application_type}>
									<option value="web">{$LL.admin_client_detail_application_web()}</option>
									<option value="native">{$LL.admin_client_detail_application_native()}</option>
									<option value="spa">{$LL.admin_client_detail_application_spa()}</option>
								</select>
								<p class="form-hint">{$LL.admin_client_detail_application_type_hint()}</p>
							{:else}
								<p class="display-text">
									{applicationTypeLabel(
										String(clientSettings?.values['client.application_type'] || 'web')
									)}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_application_type_hint()}</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- Sector Identifier URI -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_sector_identifier_uri()}</label>
								{#if isEditing}
									<input
										type="url"
										class="form-input"
										bind:value={settingsEditForm.sector_identifier_uri}
										placeholder="https://example.com/sector_identifier"
									/>
									<p class="form-hint">
										{$LL.admin_client_detail_sector_identifier_uri_hint()}
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.sector_identifier_uri'] ||
											$LL.admin_client_detail_not_configured()}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_sector_identifier_uri_hint()}
									</p>
								{/if}
							</div>
						{/if}
					</div>
				</section>

				<!-- Edit Actions for Metadata Tab -->
				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>
							{$LL.admin_client_detail_cancel()}
						</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? $LL.admin_client_detail_saving() : $LL.admin_client_detail_save_changes()}
						</button>
					</div>
				{/if}
			{:else if activeTab === 'advanced'}
				<!-- Advanced Tab -->
				<section class="section-spacing">
					<h2 class="section-title-border">{$LL.admin_client_detail_id_token_algorithms()}</h2>

					<div class="form-grid">
						<!-- ID Token Signing Algorithm -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">{$LL.admin_client_detail_id_token_signing_alg()}</label>
							{#if isEditing}
								<select class="form-select" bind:value={settingsEditForm.id_token_signing_alg}>
									<option value="RS256">RS256</option>
									<option value="ES256">ES256</option>
								</select>
								<p class="form-hint">{$LL.admin_client_detail_id_token_signing_alg_hint()}</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.id_token_signing_alg'] || 'RS256'}
								</p>
								<p class="form-hint">{$LL.admin_client_detail_id_token_signing_alg_hint()}</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- ID Token Encryption Algorithm -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_id_token_encryption_alg()}</label
								>
								{#if isEditing}
									<input
										type="text"
										class="form-input"
										bind:value={settingsEditForm.id_token_encrypted_response_alg}
										placeholder="RSA-OAEP, RSA-OAEP-256, etc. (empty = no encryption)"
									/>
									<p class="form-hint">
										{$LL.admin_client_detail_id_token_encryption_alg_hint()}
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.id_token_encrypted_response_alg'] ||
											$LL.admin_clients_new_delegation_none()}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_id_token_encryption_alg_hint()}
									</p>
								{/if}
							</div>

							<!-- ID Token Encryption Encoding -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_id_token_encryption_enc()}</label
								>
								{#if isEditing}
									<select
										class="form-select"
										bind:value={settingsEditForm.id_token_encrypted_response_enc}
									>
										<option value="A128GCM">A128GCM</option>
										<option value="A192GCM">A192GCM</option>
										<option value="A256GCM">A256GCM</option>
										<option value="A128CBC-HS256">A128CBC-HS256</option>
										<option value="A192CBC-HS384">A192CBC-HS384</option>
										<option value="A256CBC-HS512">A256CBC-HS512</option>
									</select>
									<p class="form-hint">
										{$LL.admin_client_detail_id_token_encryption_enc_hint()}
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.id_token_encrypted_response_enc'] || 'A256GCM'}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_id_token_encryption_enc_hint()}
									</p>
								{/if}
							</div>
						{/if}
					</div>
				</section>

				{#if showAdminSettings}
					<section class="section-spacing">
						<h2 class="section-title-border">{$LL.admin_client_detail_userinfo_algorithms()}</h2>

						<div class="form-grid">
							<!-- UserInfo Signed Response Algorithm -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_userinfo_signed_alg()}</label>
								{#if isEditing}
									<select
										class="form-select"
										bind:value={settingsEditForm.userinfo_signed_response_alg}
									>
										<option value="none">{$LL.admin_clients_new_delegation_none()}</option>
										<option value="RS256">RS256</option>
										<option value="ES256">ES256</option>
									</select>
									<p class="form-hint">{$LL.admin_client_detail_userinfo_signed_alg_hint()}</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.userinfo_signed_response_alg'] || 'none'}
									</p>
									<p class="form-hint">{$LL.admin_client_detail_userinfo_signed_alg_hint()}</p>
								{/if}
							</div>

							<!-- UserInfo Encryption Algorithm -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_userinfo_encryption_alg()}</label
								>
								{#if isEditing}
									<input
										type="text"
										class="form-input"
										bind:value={settingsEditForm.userinfo_encrypted_response_alg}
										placeholder="RSA-OAEP, RSA-OAEP-256, etc. (empty = no encryption)"
									/>
									<p class="form-hint">
										{$LL.admin_client_detail_userinfo_encryption_alg_hint()}
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.userinfo_encrypted_response_alg'] ||
											$LL.admin_clients_new_delegation_none()}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_userinfo_encryption_alg_hint()}
									</p>
								{/if}
							</div>

							<!-- UserInfo Encryption Encoding -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_userinfo_encryption_enc()}</label
								>
								{#if isEditing}
									<select
										class="form-select"
										bind:value={settingsEditForm.userinfo_encrypted_response_enc}
									>
										<option value="A128GCM">A128GCM</option>
										<option value="A192GCM">A192GCM</option>
										<option value="A256GCM">A256GCM</option>
										<option value="A128CBC-HS256">A128CBC-HS256</option>
										<option value="A192CBC-HS384">A192CBC-HS384</option>
										<option value="A256CBC-HS512">A256CBC-HS512</option>
									</select>
									<p class="form-hint">
										{$LL.admin_client_detail_userinfo_encryption_enc_hint()}
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.userinfo_encrypted_response_enc'] || 'A256GCM'}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_userinfo_encryption_enc_hint()}
									</p>
								{/if}
							</div>
						</div>
					</section>

					<section class="section-spacing">
						<h2 class="section-title-border">
							{$LL.admin_client_detail_request_object_algorithms()}
						</h2>

						<div class="form-grid">
							<!-- Request Object Signing Algorithm -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label"
									>{$LL.admin_client_detail_request_object_signing_alg()}</label
								>
								{#if isEditing}
									<input
										type="text"
										class="form-input"
										bind:value={settingsEditForm.request_object_signing_alg}
										placeholder="RS256, ES256, etc. (empty = not required)"
									/>
									<p class="form-hint">
										{$LL.admin_client_detail_request_object_signing_alg_hint()}
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.request_object_signing_alg'] ||
											$LL.admin_clients_new_delegation_none()}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_request_object_signing_alg_hint()}
									</p>
								{/if}
							</div>

							<!-- Request Object Encryption Algorithm -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label"
									>{$LL.admin_client_detail_request_object_encryption_alg()}</label
								>
								{#if isEditing}
									<input
										type="text"
										class="form-input"
										bind:value={settingsEditForm.request_object_encryption_alg}
										placeholder="RSA-OAEP, RSA-OAEP-256, etc. (empty = no encryption)"
									/>
									<p class="form-hint">
										{$LL.admin_client_detail_request_object_encryption_alg_hint()}
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.request_object_encryption_alg'] ||
											$LL.admin_clients_new_delegation_none()}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_request_object_encryption_alg_hint()}
									</p>
								{/if}
							</div>

							<!-- Request Object Encryption Encoding -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label"
									>{$LL.admin_client_detail_request_object_encryption_enc()}</label
								>
								{#if isEditing}
									<select
										class="form-select"
										bind:value={settingsEditForm.request_object_encryption_enc}
									>
										<option value="A128GCM">A128GCM</option>
										<option value="A192GCM">A192GCM</option>
										<option value="A256GCM">A256GCM</option>
										<option value="A128CBC-HS256">A128CBC-HS256</option>
										<option value="A192CBC-HS384">A192CBC-HS384</option>
										<option value="A256CBC-HS512">A256CBC-HS512</option>
									</select>
									<p class="form-hint">
										{$LL.admin_client_detail_request_object_encryption_enc_hint()}
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.request_object_encryption_enc'] || 'A256GCM'}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_request_object_encryption_enc_hint()}
									</p>
								{/if}
							</div>

							<!-- Request URIs -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_request_uris()}</label>
								{#if isEditing}
									<input
										type="text"
										class="form-input"
										bind:value={settingsEditForm.request_uris}
										placeholder="https://example.com/request1, https://example.com/request2"
									/>
									<p class="form-hint">{$LL.admin_client_detail_request_uris_hint()}</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.request_uris'] ||
											$LL.admin_clients_new_delegation_none()}
									</p>
									<p class="form-hint">{$LL.admin_client_detail_request_uris_hint()}</p>
								{/if}
							</div>
						</div>
					</section>

					<section class="section-spacing">
						<h2 class="section-title-border">{$LL.admin_client_detail_jwt_auth_algorithms()}</h2>

						<div class="form-grid">
							<!-- JWT Bearer Signing Algorithm -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">{$LL.admin_client_detail_jwt_bearer_signing_alg()}</label>
								{#if isEditing}
									<select class="form-select" bind:value={settingsEditForm.jwt_bearer_signing_alg}>
										<option value="RS256">RS256</option>
										<option value="RS384">RS384</option>
										<option value="RS512">RS512</option>
										<option value="ES256">ES256</option>
										<option value="ES384">ES384</option>
										<option value="ES512">ES512</option>
										<option value="PS256">PS256</option>
										<option value="PS384">PS384</option>
										<option value="PS512">PS512</option>
									</select>
									<p class="form-hint">
										{$LL.admin_client_detail_jwt_bearer_signing_alg_hint()}
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.jwt_bearer_signing_alg'] || 'RS256'}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_jwt_bearer_signing_alg_hint()}
									</p>
								{/if}
							</div>

							<!-- Token Endpoint Auth Signing Algorithm -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label"
									>{$LL.admin_client_detail_token_endpoint_auth_signing_alg()}</label
								>
								{#if isEditing}
									<select
										class="form-select"
										bind:value={settingsEditForm.token_endpoint_auth_signing_alg}
									>
										<option value="RS256">RS256</option>
										<option value="RS384">RS384</option>
										<option value="RS512">RS512</option>
										<option value="ES256">ES256</option>
										<option value="ES384">ES384</option>
										<option value="ES512">ES512</option>
										<option value="PS256">PS256</option>
										<option value="PS384">PS384</option>
										<option value="PS512">PS512</option>
									</select>
									<p class="form-hint">
										{$LL.admin_client_detail_token_endpoint_auth_signing_alg_hint()}
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.token_endpoint_auth_signing_alg'] || 'RS256'}
									</p>
									<p class="form-hint">
										{$LL.admin_client_detail_token_endpoint_auth_signing_alg_hint()}
									</p>
								{/if}
							</div>
						</div>
					</section>
				{/if}

				<!-- Edit Actions for Advanced Tab -->
				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>
							{$LL.admin_client_detail_cancel()}
						</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? $LL.admin_client_detail_saving() : $LL.admin_client_detail_save_changes()}
						</button>
					</div>
				{/if}
			{/if}
		</AdminSection>
	{/if}
</AdminPageShell>

<!-- Delete Confirmation Modal -->
<Modal
	open={showDeleteModal && !!client}
	onClose={() => {
		showDeleteModal = false;
		deleteConfirmName = '';
	}}
	title={$LL.admin_client_detail_delete_modal_title()}
	size="md"
>
	{#snippet header()}
		<h3 class="modal-title modal-title-danger">
			{$LL.admin_client_detail_delete_modal_title()}
		</h3>
	{/snippet}
	<div class="danger-box">
		<p class="danger-box-title">{$LL.admin_client_detail_delete_modal_cannot_undo()}</p>
		<ul>
			<li>{$LL.admin_client_detail_delete_modal_tokens()}</li>
			<li>{$LL.admin_client_detail_delete_modal_audit()}</li>
		</ul>
	</div>

	<p class="modal-description">
		{$LL.admin_client_detail_delete_modal_confirm({ name: client?.client_name ?? '' })}
	</p>
	<input
		type="text"
		class="confirm-input"
		bind:value={deleteConfirmName}
		placeholder={$LL.admin_client_detail_delete_modal_placeholder()}
	/>
	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={() => {
				showDeleteModal = false;
				deleteConfirmName = '';
			}}
		>
			{$LL.admin_client_detail_cancel()}
		</button>
		<button
			class="btn btn-danger"
			onclick={handleDelete}
			disabled={deleting || deleteConfirmName !== client?.client_name}
		>
			{deleting ? $LL.admin_client_detail_deleting() : $LL.admin_client_detail_delete_modal_title()}
		</button>
	{/snippet}
</Modal>

<!-- Regenerate Secret Modal -->
<Modal
	open={showRegenerateModal}
	onClose={() => {
		showRegenerateModal = false;
		newSecret = null;
	}}
	title={newSecret
		? $LL.admin_client_detail_secret_regenerated()
		: $LL.admin_client_detail_regenerate_secret_title()}
	size="md"
>
	{#snippet header()}
		{#if newSecret}
			<h3 class="modal-title modal-title-success">
				{$LL.admin_client_detail_secret_regenerated()}
			</h3>
		{:else}
			<h3 class="modal-title modal-title-warning">
				{$LL.admin_client_detail_regenerate_secret_title()}
			</h3>
		{/if}
	{/snippet}
	{#if newSecret}
		<!-- Success: Show new secret -->
		<div class="warning-box">
			<p>
				<strong>{$LL.admin_clients_new_secret_warning()}</strong>
				{$LL.admin_clients_new_secret_warning_desc()}
			</p>
		</div>

		<div class="form-group">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label class="form-label">{$LL.admin_client_detail_new_client_secret()}</label>
			<div class="input-copy-group">
				<input type="text" value={newSecret} readonly class="input-readonly" />
				<button
					class="btn-copy"
					class:copied={copiedField === 'new_secret'}
					onclick={() => copyToClipboard(newSecret!, 'new_secret')}
				>
					{copiedField === 'new_secret'
						? $LL.admin_client_detail_copied()
						: $LL.admin_client_detail_copy()}
				</button>
			</div>
		</div>
	{:else}
		<!-- Confirmation -->
		<div class="warning-box">
			<p>{$LL.admin_client_detail_secret_regenerate_warning()}</p>
		</div>

		<p class="modal-description">
			{$LL.admin_client_detail_secret_regenerate_desc()}
		</p>
	{/if}
	{#snippet footer()}
		{#if newSecret}
			<button
				class="btn btn-primary"
				onclick={() => {
					showRegenerateModal = false;
					newSecret = null;
				}}
			>
				{$LL.admin_client_detail_done()}
			</button>
		{:else}
			<button class="btn btn-secondary" onclick={() => (showRegenerateModal = false)}>
				{$LL.admin_client_detail_cancel()}
			</button>
			<button class="btn btn-warning" onclick={handleRegenerateSecret} disabled={regenerating}>
				{regenerating
					? $LL.admin_client_detail_regenerating()
					: $LL.admin_client_detail_regenerate_secret_title()}
			</button>
		{/if}
	{/snippet}
</Modal>

<style>
	.detail-tag {
		display: inline-flex;
		align-items: center;
		padding: var(--detail-tag-padding, 0.12rem 0.5rem);
		border: 1px solid var(--detail-tag-border, var(--color-border));
		border-radius: var(--detail-tag-radius, var(--radius-xs));
		background: var(--detail-tag-bg, var(--color-surface-muted));
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--detail-tag-font-size, 0.68rem);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: var(--detail-tag-letter-spacing, 0.08em);
		line-height: 1.45;
	}

	.detail-tag--ok {
		border-color: var(--color-success);
		background: color-mix(in srgb, var(--color-success) 9%, transparent);
		color: var(--color-success);
	}

	.detail-tag--system {
		border-color: var(--color-warning);
		background: color-mix(in srgb, var(--color-warning) 9%, transparent);
		color: var(--color-warning);
	}

	.client-header-actions {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.admin-toggle-inline {
		display: flex;
		align-items: center;
		z-index: 1;
		position: relative;
	}

	.redirect-uri-editor {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.modal-title-danger {
		color: var(--color-danger);
	}

	.modal-title-success {
		color: var(--color-success);
	}

	.modal-title-warning {
		color: var(--color-warning);
	}

	/* Danger Zone */
	.danger-section {
		margin-top: 3rem;
		padding-top: 2rem;
		border-top: 2px solid var(--color-border);
	}

	.danger-title {
		color: var(--color-danger);
	}

	.danger-zone {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1.5rem;
		padding: var(--danger-zone-padding, 1.5rem);
		background-color: var(
			--danger-zone-bg,
			color-mix(in srgb, var(--color-danger) 8%, var(--color-surface))
		);
		border: var(
			--danger-zone-border,
			1px solid color-mix(in srgb, var(--color-danger) 30%, var(--color-border))
		);
		border-radius: var(--danger-zone-radius, var(--radius-panel));
	}

	.danger-zone-content {
		flex: 1;
	}

	.danger-zone-title {
		font-size: var(--danger-zone-title-size, 1rem);
		font-weight: var(--danger-zone-title-weight, 600);
		color: var(--color-danger);
		margin: 0 0 0.5rem 0;
	}

	.danger-zone-description {
		font-size: var(--danger-zone-description-size, 0.875rem);
		color: var(--color-text-muted);
		margin: 0;
		line-height: 1.5;
	}

	/* URI Items */
	.uri-item-with-cors {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.uri-text {
		flex: 1;
		word-break: break-all;
	}

	.badge-success {
		background-color: color-mix(in srgb, var(--color-success) 16%, transparent);
		color: var(--color-success);
		padding: var(--badge-padding, 2px 8px);
		border-radius: var(--status-badge-radius, var(--radius-control));
		font-size: var(--badge-font-size, 0.75rem);
		font-weight: 500;
		white-space: nowrap;
	}

	.cors-hint {
		margin-top: 8px;
		color: var(--color-warning);
	}

	.textarea-input {
		min-height: 112px;
		resize: vertical;
	}

	.preformatted-text {
		white-space: pre-wrap;
		word-break: break-word;
	}

	@media (max-width: 640px) {
		.client-header-actions {
			justify-content: flex-start;
			width: 100%;
		}

		.input-copy-group {
			flex-wrap: wrap;
		}

		.input-copy-group .form-input,
		.input-copy-group .input-readonly {
			min-width: 0;
		}
	}
</style>
