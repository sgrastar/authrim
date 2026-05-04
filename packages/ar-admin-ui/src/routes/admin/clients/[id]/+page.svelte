<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import {
		adminClientsAPI,
		type Client,
		type ClientUsage,
		type UpdateClientInput
	} from '$lib/api/admin-clients';
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

	const clientId = $derived($page.params.id ?? '');

	let client = $state<Client | null>(null);
	let usage = $state<ClientUsage | null>(null);
	let clientSettings = $state<CategorySettings | null>(null);
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
	type TabId = 'general' | 'tokens' | 'security' | 'scopes' | 'session' | 'metadata' | 'advanced';
	let activeTab = $state<TabId>('general');

	const TAB_DEFINITIONS: ReadonlyArray<{ id: TabId; label: string }> = [
		{ id: 'general', label: 'General' },
		{ id: 'tokens', label: 'Tokens' },
		{ id: 'security', label: 'Security' },
		{ id: 'scopes', label: 'Scopes & Permissions' },
		{ id: 'session', label: 'Session & Logout' },
		{ id: 'metadata', label: 'Client Metadata' },
		{ id: 'advanced', label: 'Advanced' }
	];

	// Admin visibility toggle
	let showAdminSettings = $state(false);

	// Track unsaved changes
	let initialEditForm = $state<UpdateClientInput | null>(null);
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
			response_types: toStringArray(input.response_types)
		};
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
			arraysEqual(a.redirect_uris, b.redirect_uris) &&
			arraysEqual(a.grant_types, b.grant_types) &&
			arraysEqual(a.response_types, b.response_types) &&
			(a.token_endpoint_auth_method ?? '') === (b.token_endpoint_auth_method ?? '') &&
			(a.scope ?? '') === (b.scope ?? '') &&
			Boolean(a.require_pkce) === Boolean(b.require_pkce)
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
			!initialSettingsEditForm ||
			!initialDownstreamGrantEditForm
		)
			return false;
		return (
			!clientFormEquals(editForm, initialEditForm) ||
			!downstreamGrantFormEquals(downstreamGrantEditForm, initialDownstreamGrantEditForm) ||
			!settingsFormEquals(settingsEditForm, initialSettingsEditForm)
		);
	});

	/**
	 * Handle tab change with unsaved changes warning
	 */
	function handleTabChange(newTab: TabId) {
		if (hasUnsavedChanges) {
			const confirmChange = confirm(
				'未保存の変更があります。タブを切り替えると変更が失われますが、よろしいですか?'
			);
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

	/**
	 * Check if an origin is in the CORS allowlist (with wildcard support)
	 */
	function isOriginInCors(redirectUri: string): boolean {
		const origin = extractOrigin(redirectUri);
		if (!origin) return false;

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
		if (!origin || !tenantSettings) return;

		addingToCors = redirectUri;
		try {
			// Get current allowed_origins
			const current = (tenantSettings.values['tenant.allowed_origins'] as string) || '';
			const origins = current
				? current
						.split(',')
						.map((o) => o.trim())
						.filter((o) => o.length > 0)
				: [];

			// Add if not already present
			if (!origins.includes(origin)) {
				origins.push(origin);
				await adminSettingsAPI.updateSettings('tenant', {
					ifMatch: tenantSettings.version,
					set: { 'tenant.allowed_origins': origins.join(',') }
				});
				// Reload tenant settings
				tenantSettings = await adminSettingsAPI.getSettings('tenant');
			}
		} catch (err) {
			console.error('Failed to add to CORS:', err);
			error = err instanceof Error ? err.message : 'Failed to add to CORS';
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
			client = normalizeClientArrays(await adminClientsAPI.get(clientId));
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
			error = 'Failed to load client';
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
			redirect_uris: toStringArray(client.redirect_uris),
			grant_types: toStringArray(client.grant_types),
			response_types: toStringArray(client.response_types),
			token_endpoint_auth_method: client.token_endpoint_auth_method,
			scope: client.scope,
			require_pkce: client.require_pkce ?? false
		};
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
				(clientSettings.values['client.id_token_signing_alg'] as string) ?? 'RS256',
			id_token_encrypted_response_alg:
				(clientSettings.values['client.id_token_encrypted_response_alg'] as string) ?? '',
			id_token_encrypted_response_enc:
				(clientSettings.values['client.id_token_encrypted_response_enc'] as string) ?? 'A256GCM',
			userinfo_signed_response_alg:
				(clientSettings.values['client.userinfo_signed_response_alg'] as string) ?? 'none',
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
		initialDownstreamGrantEditForm = { ...downstreamGrantEditForm };
		initialSettingsEditForm = { ...settingsEditForm };
		isEditing = true;
		setTimeout(() => {
			document.getElementById('client-name-input')?.focus();
		}, 0);
	}

	function cancelEditing() {
		isEditing = false;
		editForm = {};
		downstreamGrantEditForm = createDefaultClientDownstreamGrantForm();
		settingsEditForm = {};
		initialEditForm = null;
		initialDownstreamGrantEditForm = null;
		initialSettingsEditForm = null;
		saveError = '';
	}

	async function saveChanges() {
		saving = true;
		saveError = '';

		try {
			// Save to Client API
			client = normalizeClientArrays(
				await adminClientsAPI.update(clientId, {
					...editForm,
					...toClientDownstreamGrantUpdateInput(downstreamGrantEditForm),
					login_ui_url: settingsEditForm.login_ui_url?.trim()
						? settingsEditForm.login_ui_url.trim()
						: null
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
						saveError = `Warning: Some settings could not be saved: ${rejectedKeys}`;
					}

						// Reload client settings to get the new version
						clientSettings = syncClientSettingsWithClient(
							await scopedSettingsAPI.getClientSettings(clientId, 'client'),
							client
						);
					} catch (err) {
						if (err instanceof SettingsConflictError) {
							saveError = `設定が他のユーザーによって更新されました。現在の設定を確認して再度お試しください。(Current version: ${err.currentVersion})`;
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
			initialDownstreamGrantEditForm = null;
			initialSettingsEditForm = null;
		} catch (err) {
			console.error('Failed to update client:', err);
			saveError = err instanceof Error ? err.message : 'Failed to update client';
		} finally {
			saving = false;
		}
	}

	async function handleDelete() {
		if (!client || deleteConfirmName !== client.client_name) return;

		deleting = true;
		try {
			// TODO: Phase 4（監査ログ）実装時に論理削除への変更を検討
			// 現在は物理削除のため、削除されたclient_idで発行されたトークンの追跡が困難
			await adminClientsAPI.delete(clientId);
			goto('/admin/clients');
		} catch (err) {
			console.error('Failed to delete client:', err);
			error = err instanceof Error ? err.message : 'Failed to delete client';
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
			error = err instanceof Error ? err.message : 'Failed to regenerate secret';
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
		return new Date(timestamp).toLocaleString();
	}

	function formatNumber(num: number | null | undefined): string {
		if (num == null) return '0';
		return num.toLocaleString();
	}
</script>

<svelte:head>
	<title>{client?.client_name || 'Client'} - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<a href="/admin/clients" class="back-link">← Back to Clients</a>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading client...</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if client}
		<!-- Header -->
		<div class="page-header-with-status">
			<div class="page-header-info">
				<h1>{client.client_name}</h1>
				<p class="mono">{client.client_id}</p>
			</div>
			<div class="action-buttons">
				<div class="admin-toggle-inline">
					<ToggleSwitch
						bind:checked={showAdminSettings}
						label="Show Advanced Settings"
						description="Display advanced configuration options for administrators"
					/>
				</div>
				{#if !isEditing}
					<button class="btn btn-secondary" onclick={startEditing}>Edit</button>
				{/if}
			</div>
		</div>

		<!-- Tabs -->
		<div class="client-tabs" role="tablist">
			{#each TAB_DEFINITIONS as tab (tab.id)}
				<button
					onclick={() => handleTabChange(tab.id)}
					role="tab"
					aria-selected={activeTab === tab.id}
					aria-controls="{tab.id}-panel"
					class="client-tab"
					class:active={activeTab === tab.id}
				>
					{tab.label}
				</button>
			{/each}
		</div>

		<!-- Client Details -->
		<div class="panel">
			{#if saveError}
				<div class="alert alert-error">{saveError}</div>
			{/if}

			{#if activeTab === 'general'}
				<!-- Usage Statistics -->
				{#if usage}
					<section class="section-spacing">
						<h2 class="section-title-border">Usage Statistics</h2>
						<div class="stats-grid">
							<div class="stat-card">
								<div class="stat-value">{formatNumber(usage.tokens_issued_24h)}</div>
								<div class="stat-label">Tokens (24h)</div>
							</div>
							<div class="stat-card">
								<div class="stat-value">{formatNumber(usage.tokens_issued_7d)}</div>
								<div class="stat-label">Tokens (7d)</div>
							</div>
							<div class="stat-card">
								<div class="stat-value">{formatNumber(usage.tokens_issued_30d)}</div>
								<div class="stat-label">Tokens (30d)</div>
							</div>
							<div class="stat-card">
								<div class="stat-value">{formatNumber(usage.active_sessions)}</div>
								<div class="stat-label">Active Sessions</div>
							</div>
						</div>
						{#if usage.last_token_issued_at}
							<p class="stat-note">Last token issued: {formatDate(usage.last_token_issued_at)}</p>
						{/if}
					</section>
				{/if}

				<!-- Basic Info -->
				<section class="section-spacing">
					<h2 class="section-title-border">Basic Information</h2>

					<!-- Client ID -->
					<div class="form-group">
						<!-- svelte-ignore a11y_label_has_associated_control -->
						<label class="form-label">Client ID</label>
						<div class="input-copy-group">
							<input type="text" value={client.client_id} readonly class="input-readonly" />
							<button
								class="btn-copy"
								class:copied={copiedField === 'client_id'}
								onclick={() => copyToClipboard(client!.client_id, 'client_id')}
							>
								{copiedField === 'client_id' ? '✓ Copied' : 'Copy'}
							</button>
						</div>
					</div>

					<!-- Client Name -->
					<div class="form-group">
						<!-- svelte-ignore a11y_label_has_associated_control -->
						<label class="form-label">Client Name</label>
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

					<!-- Client Secret -->
					<div class="form-group">
						<!-- svelte-ignore a11y_label_has_associated_control -->
						<label class="form-label">Client Secret</label>
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
								Regenerate
							</button>
						</div>
						<p class="form-hint">Secret is only fully visible when created or regenerated</p>
					</div>
				</section>

				<!-- OAuth Settings -->
				<section class="section-spacing">
					<h2 class="section-title-border">OAuth Settings</h2>

					<div class="form-grid">
						<!-- Grant Types -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Grant Types</label>
							{#if isEditing}
								<div class="checkbox-list">
									{#each [{ value: 'authorization_code', label: 'Authorization Code' }, { value: 'refresh_token', label: 'Refresh Token' }, { value: 'client_credentials', label: 'Client Credentials' }, { value: 'implicit', label: 'Implicit (Legacy)' }, { value: 'urn:ietf:params:oauth:grant-type:device_code', label: 'Device Code' }] as grantType (grantType.value)}
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
											{grantType.label}
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
							<label class="form-label">Response Types</label>
							{#if isEditing}
								<div class="checkbox-list">
									{#each [{ value: 'code', label: 'code' }, { value: 'token', label: 'token (Implicit)' }, { value: 'id_token', label: 'id_token' }, { value: 'id_token token', label: 'id_token token' }, { value: 'code id_token', label: 'code id_token' }] as responseType (responseType.value)}
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
											{responseType.label}
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
							<label class="form-label">Token Endpoint Auth Method</label>
							{#if isEditing}
								<select class="form-select" bind:value={editForm.token_endpoint_auth_method}>
									<option value="none">none (Public Client)</option>
									<option value="client_secret_basic">client_secret_basic</option>
									<option value="client_secret_post">client_secret_post</option>
									<option value="private_key_jwt">private_key_jwt</option>
								</select>
							{:else}
								<p class="display-text">{client.token_endpoint_auth_method || 'none'}</p>
							{/if}
						</div>

						<!-- PKCE Required -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.pkce_required}
									label="PKCE Required"
									description="Require PKCE for authorization requests"
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">PKCE Required</label>
								<p class="display-text">
									{clientSettings?.values['client.pkce_required'] ? 'Yes' : 'No'}
								</p>
							{/if}
						</div>

						<!-- PAR Required -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.par_required}
									label="PAR Required"
									description="Require Pushed Authorization Requests"
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">PAR Required</label>
								<p class="display-text">
									{clientSettings?.values['client.par_required'] ? 'Yes' : 'No'}
								</p>
							{/if}
						</div>

						<!-- DPoP Required -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.dpop_required}
									label="DPoP Required"
									description="Require DPoP for this client"
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">DPoP Required</label>
								<p class="display-text">
									{clientSettings?.values['client.dpop_required'] ? 'Yes' : 'No'}
								</p>
							{/if}
						</div>

						<!-- DPoP Mode -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">DPoP Mode</label>
							{#if isEditing}
								<select class="form-select" bind:value={settingsEditForm.dpop_mode}>
									<option value="disabled">Disabled</option>
									<option value="critical_only">Critical Only (Token/Revoke/Introspect)</option>
									<option value="all">All Endpoints</option>
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
					<h2 class="section-title-border">Scopes</h2>

					<div class="form-grid">
						<!-- Allowed Scopes -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Allowed Scopes</label>
							{#if isEditing}
								<input
									type="text"
									class="form-input"
									bind:value={downstreamGrantEditForm.allowed_scopes}
									placeholder="openid profile email (space-separated)"
								/>
								<p class="form-hint">
									Scopes allowed for token exchange and protected resource access (empty = all)
								</p>
							{:else}
								<p class="display-text">
									{client?.allowed_scopes?.join(' ') || 'All scopes allowed'}
								</p>
							{/if}
						</div>

						<!-- Default Scope -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Default Scope</label>
							{#if isEditing}
								<input
									type="text"
									class="form-input"
									bind:value={downstreamGrantEditForm.default_scope}
									placeholder="openid profile"
								/>
								<p class="form-hint">Default scopes if none requested</p>
							{:else}
								<p class="display-text">
									{client?.default_scope || 'None'}
								</p>
							{/if}
						</div>
					</div>
				</section>

				<!-- Redirect URIs -->
				<section class="section-spacing">
					<h2 class="section-title-border">Redirect URIs</h2>
					{#if isEditing}
						<div style="display: flex; flex-direction: column; gap: 8px;">
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
										Remove
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
								+ Add Redirect URI
							</button>
						</div>
					{:else if client.redirect_uris.length > 0}
						<ul class="uri-list">
							{#each client.redirect_uris as uri (uri)}
								<li class="uri-item uri-item-with-cors">
									<span class="uri-text">{uri}</span>
									{#if tenantSettings}
										{#if isOriginInCors(uri)}
											<span class="badge badge-success">CORS OK</span>
										{:else}
											<button
												class="btn btn-secondary btn-sm"
												onclick={() => addToCors(uri)}
												disabled={addingToCors === uri}
											>
												{addingToCors === uri ? 'Adding...' : 'Add to CORS'}
											</button>
										{/if}
									{/if}
								</li>
							{/each}
						</ul>
						{#if tenantSettings && client.redirect_uris.some((uri) => !isOriginInCors(uri))}
							<p class="form-hint cors-hint">
								Some redirect URIs are not in the CORS allowlist. Direct Auth API calls from these
								origins may fail.
							</p>
						{/if}
					{:else}
						<p class="display-text muted">No redirect URIs configured</p>
					{/if}
				</section>

				<!-- Timestamps -->
				<section>
					<h2 class="section-title-border">Timestamps</h2>
					<div class="info-grid">
						<div class="info-item">
							<dt>Created</dt>
							<dd class="info-value">{formatDate(client.created_at)}</dd>
						</div>
						<div class="info-item">
							<dt>Updated</dt>
							<dd class="info-value">{formatDate(client.updated_at)}</dd>
						</div>
					</div>
				</section>

				<!-- Edit Actions -->
				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>Cancel</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? 'Saving...' : 'Save Changes'}
						</button>
					</div>
				{/if}

				<!-- Delete Client Section -->
				<section class="section-spacing danger-section">
					<h2 class="section-title-border danger-title">Danger Zone</h2>
					<div class="danger-zone">
						<div class="danger-zone-content">
							<h3 class="danger-zone-title">Delete this client</h3>
							<p class="danger-zone-description">
								Permanently delete this client. This action cannot be undone. All tokens issued to
								this client will be invalidated immediately.
							</p>
						</div>
						<button class="btn btn-danger" onclick={() => (showDeleteModal = true)}>
							Delete Client
						</button>
					</div>
				</section>
			{:else if activeTab === 'tokens'}
				<!-- Tokens Tab -->
				<section class="section-spacing">
					<h2 class="section-title-border">Token Lifetimes</h2>

					<div class="form-grid">
						<!-- Access Token TTL -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Access Token TTL (seconds)</label>
							{#if isEditing}
								<input
									type="number"
									class="form-input"
									bind:value={settingsEditForm.access_token_ttl}
									min="60"
									step="60"
								/>
								<p class="form-hint">Client-specific access token lifetime</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.access_token_ttl'] || 3600} seconds
								</p>
								<p class="form-hint">Client-specific access token lifetime</p>
							{/if}
						</div>

						<!-- Refresh Token TTL -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Refresh Token TTL (seconds)</label>
							{#if isEditing}
								<input
									type="number"
									class="form-input"
									bind:value={settingsEditForm.refresh_token_ttl}
									min="3600"
									step="3600"
								/>
								<p class="form-hint">Client-specific refresh token lifetime (default: 90 days)</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.refresh_token_ttl'] || 7776000} seconds
								</p>
								<p class="form-hint">Client-specific refresh token lifetime (default: 90 days)</p>
							{/if}
						</div>

						<!-- ID Token TTL -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">ID Token TTL (seconds)</label>
							{#if isEditing}
								<input
									type="number"
									class="form-input"
									bind:value={settingsEditForm.id_token_ttl}
									min="60"
									step="60"
								/>
								<p class="form-hint">Client-specific ID token lifetime</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.id_token_ttl'] || 3600} seconds
								</p>
								<p class="form-hint">Client-specific ID token lifetime</p>
							{/if}
						</div>
					</div>
				</section>

				<section class="section-spacing">
					<h2 class="section-title-border">Token Behavior</h2>

					<div class="form-grid">
						<!-- Refresh Token Rotation -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.refresh_token_rotation}
									label="Refresh Token Rotation"
									description="Issue new refresh token on use (security best practice)"
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Refresh Token Rotation</label>
								<p class="display-text">
									{clientSettings?.values['client.refresh_token_rotation'] ? 'Enabled' : 'Disabled'}
								</p>
								<p class="form-hint">Issue new refresh token on use (security best practice)</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- Reuse Refresh Token -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.reuse_refresh_token}
										label="Reuse Refresh Token"
										description="Allow refresh token reuse within grace period"
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">Reuse Refresh Token</label>
									<p class="display-text">
										{clientSettings?.values['client.reuse_refresh_token'] ? 'Enabled' : 'Disabled'}
									</p>
									<p class="form-hint">Allow refresh token reuse within grace period</p>
								{/if}
							</div>
						{/if}

						<!-- DPoP Bound Access Tokens -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.dpop_bound_access_tokens}
									label="DPoP Bound Access Tokens"
									description="Bind access tokens to DPoP proof"
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">DPoP Bound Access Tokens</label>
								<p class="display-text">
									{clientSettings?.values['client.dpop_bound_access_tokens']
										? 'Enabled'
										: 'Disabled'}
								</p>
								<p class="form-hint">Bind access tokens to DPoP proof</p>
							{/if}
						</div>

						<!-- Token Exchange Allowed -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={downstreamGrantEditForm.token_exchange_allowed}
									label="Token Exchange Allowed"
									description="Allow token exchange (RFC 8693) for this client"
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Token Exchange Allowed</label>
								<p class="display-text">
									{client?.token_exchange_allowed ? 'Yes' : 'No'}
								</p>
								<p class="form-hint">Allow token exchange (RFC 8693) for this client</p>
							{/if}
						</div>

						<!-- Delegation Mode -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Delegation Mode</label>
							{#if isEditing}
								<select class="form-select" bind:value={downstreamGrantEditForm.delegation_mode}>
									<option value="none">None</option>
									<option value="delegation">Delegation</option>
									<option value="impersonation">Impersonation</option>
								</select>
								<p class="form-hint">Token exchange delegation mode</p>
							{:else}
								<p class="display-text">
									{client?.delegation_mode || 'delegation'}
								</p>
								<p class="form-hint">Token exchange delegation mode</p>
							{/if}
						</div>
					</div>
				</section>

				<!-- Edit Actions for Tokens Tab -->
				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>Cancel</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? 'Saving...' : 'Save Changes'}
						</button>
					</div>
				{/if}
			{:else if activeTab === 'security'}
				<!-- Security Tab -->
				<section class="section-spacing">
					<h2 class="section-title-border">Security Settings</h2>

					<div class="form-grid">
						<!-- Consent Required -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.consent_required}
									label="Consent Required"
									description="Require user consent for this client"
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Consent Required</label>
								<p class="display-text">
									{clientSettings?.values['client.consent_required'] ? 'Yes' : 'No'}
								</p>
								<p class="form-hint">Require user consent for this client</p>
							{/if}
						</div>

						<!-- SSO Enabled -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.sso_enabled}
									label="SSO Enabled"
									description="Enable Single Sign-On (session sharing). When disabled, users must re-authenticate for this client even with an existing session."
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">SSO Enabled</label>
								<p class="display-text">
									{clientSettings?.values['client.sso_enabled'] ? 'Yes' : 'No'}
								</p>
								<p class="form-hint">Enable Single Sign-On (session sharing)</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- First Party App -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.first_party}
										label="First Party App"
										description="Mark this client as a first-party application"
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">First Party App</label>
									<p class="display-text">
										{clientSettings?.values['client.first_party'] ? 'Yes' : 'No'}
									</p>
									<p class="form-hint">Mark this client as a first-party application</p>
								{/if}
							</div>

							<!-- Strict Redirect Matching -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.strict_redirect_matching}
										label="Strict Redirect Matching"
										description="Require exact redirect URI matching"
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">Strict Redirect Matching</label>
									<p class="display-text">
										{clientSettings?.values['client.strict_redirect_matching']
											? 'Enabled'
											: 'Disabled'}
									</p>
									<p class="form-hint">Require exact redirect URI matching</p>
								{/if}
							</div>

							<!-- Allow Localhost Redirect -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.allow_localhost_redirect}
										label="Allow Localhost Redirect"
										description="Allow localhost redirect URIs (development)"
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">Allow Localhost Redirect</label>
									<p class="display-text">
										{clientSettings?.values['client.allow_localhost_redirect'] ? 'Yes' : 'No'}
									</p>
									<p class="form-hint">Allow localhost redirect URIs (development)</p>
								{/if}
							</div>

							<!-- Default Max Age -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Default Max Age (seconds)</label>
								{#if isEditing}
									<input
										type="number"
										class="form-input"
										bind:value={settingsEditForm.default_max_age}
										min="0"
										step="60"
									/>
									<p class="form-hint">Default max authentication age (0 = no limit)</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.default_max_age'] || 0} seconds
									</p>
									<p class="form-hint">Default max authentication age (0 = no limit)</p>
								{/if}
							</div>

							<!-- Default ACR Values -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Default ACR Values</label>
								{#if isEditing}
									<input
										type="text"
										class="form-input"
										bind:value={settingsEditForm.default_acr_values}
										placeholder="acr1 acr2"
									/>
									<p class="form-hint">Default authentication context class reference values</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.default_acr_values'] || 'None'}
									</p>
									<p class="form-hint">Default authentication context class reference values</p>
								{/if}
							</div>

							<!-- Require Auth Time -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.require_auth_time}
										label="Require Auth Time"
										description="Require auth_time claim in ID token"
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">Require Auth Time</label>
									<p class="display-text">
										{clientSettings?.values['client.require_auth_time'] ? 'Yes' : 'No'}
									</p>
									<p class="form-hint">Require auth_time claim in ID token</p>
								{/if}
							</div>

							<!-- Subject Type -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Subject Type</label>
								{#if isEditing}
									<select class="form-select" bind:value={settingsEditForm.subject_type}>
										<option value="public">Public</option>
										<option value="pairwise">Pairwise</option>
									</select>
									<p class="form-hint">Subject identifier type for this client</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.subject_type'] || 'public'}
									</p>
									<p class="form-hint">Subject identifier type for this client</p>
								{/if}
							</div>
						{/if}
					</div>
				</section>

				<!-- Edit Actions for Security Tab -->
				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>Cancel</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? 'Saving...' : 'Save Changes'}
						</button>
					</div>
				{/if}
			{:else if activeTab === 'scopes'}
				<!-- Scopes & Permissions Tab -->
				<section class="section-spacing">
					<h2 class="section-title-border">Scope Settings</h2>

					<div class="form-grid">
						<!-- Default Audience -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Default Audience</label>
							{#if isEditing}
								<input
									type="text"
									class="form-input"
									bind:value={downstreamGrantEditForm.default_audience}
									placeholder="https://api.example.com"
								/>
								<p class="form-hint">Default audience for exchanged downstream access tokens</p>
							{:else}
								<p class="display-text">
									{client?.default_audience || 'None'}
								</p>
								<p class="form-hint">Default audience for exchanged downstream access tokens</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- Allowed Scopes Restriction Enabled -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.allowed_scopes_restriction_enabled}
										label="Scope Restriction Enabled"
										description="Enable allowed_scopes restriction"
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">Scope Restriction Enabled</label>
									<p class="display-text">
										{clientSettings?.values['client.allowed_scopes_restriction_enabled']
											? 'Enabled'
											: 'Disabled'}
									</p>
									<p class="form-hint">Enable allowed_scopes restriction</p>
								{/if}
							</div>
						{/if}

						<!-- Client Credentials Allowed -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={downstreamGrantEditForm.client_credentials_allowed}
									label="Client Credentials Allowed"
									description="Allow client credentials grant for machine-to-machine"
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Client Credentials Allowed</label>
								<p class="display-text">
									{client?.client_credentials_allowed ? 'Yes' : 'No'}
								</p>
								<p class="form-hint">Allow client credentials grant for machine-to-machine</p>
							{/if}
						</div>
					</div>
				</section>

				<section class="section-spacing">
					<h2 class="section-title-border">Downstream Grant Restrictions</h2>

					<div class="form-grid">
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Allowed Subject Token Clients</label>
							{#if isEditing}
								<textarea
									class="form-input textarea-input"
									rows="5"
									bind:value={downstreamGrantEditForm.allowed_subject_token_clients}
									placeholder="svc-client-a&#10;svc-client-b"
								></textarea>
								<p class="form-hint">
									One client ID per line. Leave blank to allow any subject-token client.
								</p>
							{:else}
								<p class="display-text preformatted-text">
									{formatClientListForTextarea(client?.allowed_subject_token_clients) ||
										'Any subject-token client'}
								</p>
								<p class="form-hint">
									Restricts which service clients may present downstream subject tokens.
								</p>
							{/if}
						</div>

						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Allowed Token Exchange Resources</label>
							{#if isEditing}
								<textarea
									class="form-input textarea-input"
									rows="5"
									bind:value={downstreamGrantEditForm.allowed_token_exchange_resources}
									placeholder="svc://op-userinfo/customer-profile&#10;svc://op-userinfo/customer-export"
								></textarea>
								<p class="form-hint">
									One audience/resource per line. Leave blank to allow any downstream resource.
								</p>
							{:else}
								<p class="display-text preformatted-text">
									{formatClientListForTextarea(client?.allowed_token_exchange_resources) ||
										'Any downstream resource'}
								</p>
								<p class="form-hint">
									Restricts which protected resources this client can exchange into.
								</p>
							{/if}
						</div>
					</div>
				</section>

				<section class="section-spacing">
					<h2 class="section-title-border">Grant Types</h2>

					<div class="form-grid">
						<!-- Allow Authorization Code -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.allow_authorization_code}
									label="Allow Authorization Code"
									description="Enable authorization code grant"
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Allow Authorization Code</label>
								<p class="display-text">
									{clientSettings?.values['client.allow_authorization_code']
										? 'Enabled'
										: 'Disabled'}
								</p>
								<p class="form-hint">Enable authorization code grant</p>
							{/if}
						</div>

						<!-- Allow Client Credentials -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.allow_client_credentials}
									label="Allow Client Credentials"
									description="Enable client credentials grant"
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Allow Client Credentials</label>
								<p class="display-text">
									{clientSettings?.values['client.allow_client_credentials']
										? 'Enabled'
										: 'Disabled'}
								</p>
								<p class="form-hint">Enable client credentials grant</p>
							{/if}
						</div>

						<!-- Allow Refresh Token -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.allow_refresh_token}
									label="Allow Refresh Token"
									description="Enable refresh token grant"
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Allow Refresh Token</label>
								<p class="display-text">
									{clientSettings?.values['client.allow_refresh_token'] ? 'Enabled' : 'Disabled'}
								</p>
								<p class="form-hint">Enable refresh token grant</p>
							{/if}
						</div>

						<!-- Allow Device Code -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.allow_device_code}
									label="Allow Device Code"
									description="Enable device authorization grant"
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Allow Device Code</label>
								<p class="display-text">
									{clientSettings?.values['client.allow_device_code'] ? 'Enabled' : 'Disabled'}
								</p>
								<p class="form-hint">Enable device authorization grant</p>
							{/if}
						</div>

						<!-- Allow CIBA -->
						<div class="form-group">
							{#if isEditing}
								<ToggleSwitch
									bind:checked={settingsEditForm.allow_ciba}
									label="Allow CIBA"
									description="Enable CIBA (backchannel authentication)"
								/>
							{:else}
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Allow CIBA</label>
								<p class="display-text">
									{clientSettings?.values['client.allow_ciba'] ? 'Enabled' : 'Disabled'}
								</p>
								<p class="form-hint">Enable CIBA (backchannel authentication)</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- Allow Code Response -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.allow_code_response}
										label="Allow Code Response"
										description="Enable code response type"
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">Allow Code Response</label>
									<p class="display-text">
										{clientSettings?.values['client.allow_code_response'] ? 'Enabled' : 'Disabled'}
									</p>
									<p class="form-hint">Enable code response type</p>
								{/if}
							</div>

							<!-- Allow Token Response -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.allow_token_response}
										label="Allow Token Response"
										description="Enable token response type (implicit flow)"
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">Allow Token Response</label>
									<p class="display-text">
										{clientSettings?.values['client.allow_token_response'] ? 'Enabled' : 'Disabled'}
									</p>
									<p class="form-hint">Enable token response type (implicit flow)</p>
								{/if}
							</div>

							<!-- Allow ID Token Response -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.allow_id_token_response}
										label="Allow ID Token Response"
										description="Enable id_token response type (implicit flow)"
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">Allow ID Token Response</label>
									<p class="display-text">
										{clientSettings?.values['client.allow_id_token_response']
											? 'Enabled'
											: 'Disabled'}
									</p>
									<p class="form-hint">Enable id_token response type (implicit flow)</p>
								{/if}
							</div>
						{/if}
					</div>
				</section>

				<!-- Edit Actions for Scopes Tab -->
				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>Cancel</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? 'Saving...' : 'Save Changes'}
						</button>
					</div>
				{/if}
			{:else if activeTab === 'session'}
				<!-- Session & Logout Tab -->
				<section class="section-spacing">
					<h2 class="section-title-border">Frontchannel Logout</h2>

					<div class="form-grid">
						<!-- Frontchannel Logout URI -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Frontchannel Logout URI</label>
							{#if isEditing}
								<input
									type="url"
									class="form-input"
									bind:value={settingsEditForm.frontchannel_logout_uri}
									placeholder="https://example.com/frontchannel_logout"
								/>
								<p class="form-hint">URI for frontchannel logout notifications</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.frontchannel_logout_uri'] || 'Not configured'}
								</p>
								<p class="form-hint">URI for frontchannel logout notifications</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- Frontchannel Logout Session Required -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.frontchannel_logout_session_required}
										label="Frontchannel Logout Session Required"
										description="Require session ID in frontchannel logout"
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">Frontchannel Logout Session Required</label>
									<p class="display-text">
										{clientSettings?.values['client.frontchannel_logout_session_required']
											? 'Yes'
											: 'No'}
									</p>
									<p class="form-hint">Require session ID in frontchannel logout</p>
								{/if}
							</div>
						{/if}
					</div>
				</section>

				<section class="section-spacing">
					<h2 class="section-title-border">Backchannel Logout</h2>

					<div class="form-grid">
						<!-- Backchannel Logout URI -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Backchannel Logout URI</label>
							{#if isEditing}
								<input
									type="url"
									class="form-input"
									bind:value={settingsEditForm.backchannel_logout_uri}
									placeholder="https://example.com/backchannel_logout"
								/>
								<p class="form-hint">URI for backchannel logout notifications</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.backchannel_logout_uri'] || 'Not configured'}
								</p>
								<p class="form-hint">URI for backchannel logout notifications</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- Backchannel Logout Session Required -->
							<div class="form-group">
								{#if isEditing}
									<ToggleSwitch
										bind:checked={settingsEditForm.backchannel_logout_session_required}
										label="Backchannel Logout Session Required"
										description="Require session ID in backchannel logout token"
									/>
								{:else}
									<!-- svelte-ignore a11y_label_has_associated_control -->
									<label class="form-label">Backchannel Logout Session Required</label>
									<p class="display-text">
										{clientSettings?.values['client.backchannel_logout_session_required']
											? 'Yes'
											: 'No'}
									</p>
									<p class="form-hint">Require session ID in backchannel logout token</p>
								{/if}
							</div>
						{/if}
					</div>
				</section>

				<!-- Edit Actions for Session Tab -->
				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>Cancel</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? 'Saving...' : 'Save Changes'}
						</button>
					</div>
				{/if}
			{:else if activeTab === 'metadata'}
				<!-- Client Metadata Tab -->
				<section class="section-spacing">
					<h2 class="section-title-border">Client Metadata</h2>

					<div class="form-grid">
						<!-- Logo URI -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Logo URI</label>
							{#if isEditing}
								<input
									type="url"
									class="form-input"
									bind:value={settingsEditForm.logo_uri}
									placeholder="https://example.com/logo.png"
								/>
								<p class="form-hint">URI for client logo image</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.logo_uri'] || 'Not configured'}
								</p>
								<p class="form-hint">URI for client logo image</p>
							{/if}
						</div>

						<!-- Contacts -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Contacts</label>
							{#if isEditing}
								<input
									type="text"
									class="form-input"
									bind:value={settingsEditForm.contacts}
									placeholder="admin@example.com, support@example.com"
								/>
								<p class="form-hint">Contact email addresses (comma-separated)</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.contacts'] || 'None'}
								</p>
								<p class="form-hint">Contact email addresses (comma-separated)</p>
							{/if}
						</div>

						<!-- Terms of Service URI -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Terms of Service URI</label>
							{#if isEditing}
								<input
									type="url"
									class="form-input"
									bind:value={settingsEditForm.tos_uri}
									placeholder="https://example.com/tos"
								/>
								<p class="form-hint">URI for terms of service</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.tos_uri'] || 'Not configured'}
								</p>
								<p class="form-hint">URI for terms of service</p>
							{/if}
						</div>

						<!-- Privacy Policy URI -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Privacy Policy URI</label>
							{#if isEditing}
								<input
									type="url"
									class="form-input"
									bind:value={settingsEditForm.policy_uri}
									placeholder="https://example.com/privacy"
								/>
								<p class="form-hint">URI for privacy policy</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.policy_uri'] || 'Not configured'}
								</p>
								<p class="form-hint">URI for privacy policy</p>
							{/if}
						</div>

						<!-- Client URI -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Client URI</label>
							{#if isEditing}
								<input
									type="url"
									class="form-input"
									bind:value={settingsEditForm.client_uri}
									placeholder="https://example.com"
								/>
								<p class="form-hint">URI for client homepage</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.client_uri'] || 'Not configured'}
								</p>
								<p class="form-hint">URI for client homepage</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- Initiate Login URI -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Initiate Login URI</label>
								{#if isEditing}
									<input
										type="url"
										class="form-input"
										bind:value={settingsEditForm.initiate_login_uri}
										placeholder="https://example.com/initiate_login"
									/>
									<p class="form-hint">URI to initiate login from RP</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.initiate_login_uri'] || 'Not configured'}
									</p>
									<p class="form-hint">URI to initiate login from RP</p>
								{/if}
							</div>
						{/if}

						<!-- Login UI URL -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Login UI URL</label>
							{#if isEditing}
								<input
									type="url"
									class="form-input"
									bind:value={settingsEditForm.login_ui_url}
									placeholder="https://login.your-domain.com"
								/>
								<p class="form-hint">
									Client-specific login UI base URL (overrides global UI_URL). Must use HTTPS except
									localhost.
								</p>
							{:else}
									<p class="display-text">
										{client?.login_ui_url || 'Not configured'}
									</p>
								<p class="form-hint">
									Client-specific login UI base URL (overrides global UI_URL)
								</p>
							{/if}
						</div>

						<!-- Application Type -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">Application Type</label>
							{#if isEditing}
								<select class="form-select" bind:value={settingsEditForm.application_type}>
									<option value="web">Web</option>
									<option value="native">Native</option>
									<option value="spa">SPA</option>
								</select>
								<p class="form-hint">Type of client application (web, native, spa)</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.application_type'] || 'web'}
								</p>
								<p class="form-hint">Type of client application (web, native, spa)</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- Sector Identifier URI -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Sector Identifier URI</label>
								{#if isEditing}
									<input
										type="url"
										class="form-input"
										bind:value={settingsEditForm.sector_identifier_uri}
										placeholder="https://example.com/sector_identifier"
									/>
									<p class="form-hint">URI for pairwise subject identifier calculation</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.sector_identifier_uri'] || 'Not configured'}
									</p>
									<p class="form-hint">URI for pairwise subject identifier calculation</p>
								{/if}
							</div>
						{/if}
					</div>
				</section>

				<!-- Edit Actions for Metadata Tab -->
				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>Cancel</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? 'Saving...' : 'Save Changes'}
						</button>
					</div>
				{/if}
			{:else if activeTab === 'advanced'}
				<!-- Advanced Tab -->
				<section class="section-spacing">
					<h2 class="section-title-border">ID Token Algorithms</h2>

					<div class="form-grid">
						<!-- ID Token Signing Algorithm -->
						<div class="form-group">
							<!-- svelte-ignore a11y_label_has_associated_control -->
							<label class="form-label">ID Token Signing Algorithm</label>
							{#if isEditing}
								<select class="form-select" bind:value={settingsEditForm.id_token_signing_alg}>
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
								<p class="form-hint">Algorithm for signing ID tokens</p>
							{:else}
								<p class="display-text">
									{clientSettings?.values['client.id_token_signing_alg'] || 'RS256'}
								</p>
								<p class="form-hint">Algorithm for signing ID tokens</p>
							{/if}
						</div>

						{#if showAdminSettings}
							<!-- ID Token Encryption Algorithm -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">ID Token Encryption Algorithm</label>
								{#if isEditing}
									<input
										type="text"
										class="form-input"
										bind:value={settingsEditForm.id_token_encrypted_response_alg}
										placeholder="RSA-OAEP, RSA-OAEP-256, etc. (empty = no encryption)"
									/>
									<p class="form-hint">
										Key encryption algorithm for encrypted ID tokens (empty = no encryption)
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.id_token_encrypted_response_alg'] || 'None'}
									</p>
									<p class="form-hint">
										Key encryption algorithm for encrypted ID tokens (empty = no encryption)
									</p>
								{/if}
							</div>

							<!-- ID Token Encryption Encoding -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">ID Token Encryption Encoding</label>
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
									<p class="form-hint">Content encryption algorithm for encrypted ID tokens</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.id_token_encrypted_response_enc'] || 'A256GCM'}
									</p>
									<p class="form-hint">Content encryption algorithm for encrypted ID tokens</p>
								{/if}
							</div>
						{/if}
					</div>
				</section>

				{#if showAdminSettings}
					<section class="section-spacing">
						<h2 class="section-title-border">UserInfo Algorithms</h2>

						<div class="form-grid">
							<!-- UserInfo Signed Response Algorithm -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">UserInfo Signed Response Algorithm</label>
								{#if isEditing}
									<select
										class="form-select"
										bind:value={settingsEditForm.userinfo_signed_response_alg}
									>
										<option value="none">None</option>
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
									<p class="form-hint">Algorithm for signed UserInfo responses</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.userinfo_signed_response_alg'] || 'none'}
									</p>
									<p class="form-hint">Algorithm for signed UserInfo responses</p>
								{/if}
							</div>

							<!-- UserInfo Encryption Algorithm -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">UserInfo Encryption Algorithm</label>
								{#if isEditing}
									<input
										type="text"
										class="form-input"
										bind:value={settingsEditForm.userinfo_encrypted_response_alg}
										placeholder="RSA-OAEP, RSA-OAEP-256, etc. (empty = no encryption)"
									/>
									<p class="form-hint">
										Key encryption algorithm for encrypted UserInfo (empty = no encryption)
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.userinfo_encrypted_response_alg'] || 'None'}
									</p>
									<p class="form-hint">
										Key encryption algorithm for encrypted UserInfo (empty = no encryption)
									</p>
								{/if}
							</div>

							<!-- UserInfo Encryption Encoding -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">UserInfo Encryption Encoding</label>
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
									<p class="form-hint">Content encryption algorithm for encrypted UserInfo</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.userinfo_encrypted_response_enc'] || 'A256GCM'}
									</p>
									<p class="form-hint">Content encryption algorithm for encrypted UserInfo</p>
								{/if}
							</div>
						</div>
					</section>

					<section class="section-spacing">
						<h2 class="section-title-border">Request Object Algorithms</h2>

						<div class="form-grid">
							<!-- Request Object Signing Algorithm -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Request Object Signing Algorithm</label>
								{#if isEditing}
									<input
										type="text"
										class="form-input"
										bind:value={settingsEditForm.request_object_signing_alg}
										placeholder="RS256, ES256, etc. (empty = not required)"
									/>
									<p class="form-hint">Required signing algorithm for request objects (JAR)</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.request_object_signing_alg'] || 'None'}
									</p>
									<p class="form-hint">Required signing algorithm for request objects (JAR)</p>
								{/if}
							</div>

							<!-- Request Object Encryption Algorithm -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Request Object Encryption Algorithm</label>
								{#if isEditing}
									<input
										type="text"
										class="form-input"
										bind:value={settingsEditForm.request_object_encryption_alg}
										placeholder="RSA-OAEP, RSA-OAEP-256, etc. (empty = no encryption)"
									/>
									<p class="form-hint">Key encryption algorithm for encrypted request objects</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.request_object_encryption_alg'] || 'None'}
									</p>
									<p class="form-hint">Key encryption algorithm for encrypted request objects</p>
								{/if}
							</div>

							<!-- Request Object Encryption Encoding -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Request Object Encryption Encoding</label>
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
										Content encryption algorithm for encrypted request objects
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.request_object_encryption_enc'] || 'A256GCM'}
									</p>
									<p class="form-hint">
										Content encryption algorithm for encrypted request objects
									</p>
								{/if}
							</div>

							<!-- Request URIs -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Request URIs</label>
								{#if isEditing}
									<input
										type="text"
										class="form-input"
										bind:value={settingsEditForm.request_uris}
										placeholder="https://example.com/request1, https://example.com/request2"
									/>
									<p class="form-hint">Allowed request_uri values (comma-separated)</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.request_uris'] || 'None'}
									</p>
									<p class="form-hint">Allowed request_uri values (comma-separated)</p>
								{/if}
							</div>
						</div>
					</section>

					<section class="section-spacing">
						<h2 class="section-title-border">JWT & Authentication Algorithms</h2>

						<div class="form-grid">
							<!-- JWT Bearer Signing Algorithm -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">JWT Bearer Signing Algorithm</label>
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
									<p class="form-hint">Signing algorithm for JWT Bearer assertions</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.jwt_bearer_signing_alg'] || 'RS256'}
									</p>
									<p class="form-hint">Signing algorithm for JWT Bearer assertions</p>
								{/if}
							</div>

							<!-- Token Endpoint Auth Signing Algorithm -->
							<div class="form-group">
								<!-- svelte-ignore a11y_label_has_associated_control -->
								<label class="form-label">Token Endpoint Auth Signing Algorithm</label>
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
										Signing algorithm for private_key_jwt/client_secret_jwt authentication
									</p>
								{:else}
									<p class="display-text">
										{clientSettings?.values['client.token_endpoint_auth_signing_alg'] || 'RS256'}
									</p>
									<p class="form-hint">
										Signing algorithm for private_key_jwt/client_secret_jwt authentication
									</p>
								{/if}
							</div>
						</div>
					</section>
				{/if}

				<!-- Edit Actions for Advanced Tab -->
				{#if isEditing}
					<div class="edit-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>Cancel</button>
						<button
							class="btn btn-primary"
							onclick={saveChanges}
							disabled={saving || !hasUnsavedChanges}
						>
							{saving ? 'Saving...' : 'Save Changes'}
						</button>
					</div>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<!-- Delete Confirmation Modal -->
<Modal
	open={showDeleteModal && !!client}
	onClose={() => {
		showDeleteModal = false;
		deleteConfirmName = '';
	}}
	title="Delete Client"
	size="md"
>
	{#snippet header()}
		<h3 class="modal-title" style="color: var(--danger);">Delete Client</h3>
	{/snippet}
	<div class="danger-box">
		<p class="danger-box-title">This action CANNOT be undone.</p>
		<ul>
			<li>All tokens issued to this client will be invalidated immediately</li>
			<li>Historical audit data for this client will become orphaned</li>
		</ul>
	</div>

	<p class="modal-description">
		Type <strong>{client?.client_name ?? ''}</strong> to confirm:
	</p>
	<input
		type="text"
		class="confirm-input"
		bind:value={deleteConfirmName}
		placeholder="Enter client name"
	/>
	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={() => {
				showDeleteModal = false;
				deleteConfirmName = '';
			}}
		>
			Cancel
		</button>
		<button
			class="btn btn-danger"
			onclick={handleDelete}
			disabled={deleting || deleteConfirmName !== client?.client_name}
		>
			{deleting ? 'Deleting...' : 'Delete Client'}
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
	title={newSecret ? 'Secret Regenerated' : 'Regenerate Client Secret'}
	size="md"
>
	{#snippet header()}
		{#if newSecret}
			<h3 class="modal-title" style="color: var(--success);">Secret Regenerated</h3>
		{:else}
			<h3 class="modal-title" style="color: var(--warning);">Regenerate Client Secret</h3>
		{/if}
	{/snippet}
	{#if newSecret}
		<!-- Success: Show new secret -->
		<div class="warning-box">
			<p><strong>Save this secret now!</strong> It will not be shown again.</p>
		</div>

		<div class="form-group">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label class="form-label">New Client Secret</label>
			<div class="input-copy-group">
				<input type="text" value={newSecret} readonly class="input-readonly" />
				<button
					class="btn-copy"
					class:copied={copiedField === 'new_secret'}
					onclick={() => copyToClipboard(newSecret!, 'new_secret')}
				>
					{copiedField === 'new_secret' ? '✓ Copied' : 'Copy'}
				</button>
			</div>
		</div>
	{:else}
		<!-- Confirmation -->
		<div class="warning-box">
			<p>
				This will <strong>invalidate</strong> the current client secret. All applications using the old
				secret will stop working immediately.
			</p>
		</div>

		<p class="modal-description">
			The new secret will only be shown once. Make sure to update your applications after
			regenerating.
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
				Done
			</button>
		{:else}
			<button class="btn btn-secondary" onclick={() => (showRegenerateModal = false)}>
				Cancel
			</button>
			<button class="btn btn-warning" onclick={handleRegenerateSecret} disabled={regenerating}>
				{regenerating ? 'Regenerating...' : 'Regenerate Secret'}
			</button>
		{/if}
	{/snippet}
</Modal>

<style>
	/* Tabs */
	.client-tabs {
		display: flex;
		gap: 8px;
		padding: 0.5rem;
		background:
			radial-gradient(
				circle at 14% 18%,
				color-mix(in srgb, var(--primary, #2c2724) 10%, transparent),
				transparent 40%
			),
			var(--bg-card, #fefdfa);
		border: 1px solid var(--border, #e5e7eb);
		border-radius: 12px;
		margin-bottom: 1.5rem;
		overflow-x: auto;
		scrollbar-width: none;
		-ms-overflow-style: none;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.04);
	}

	.client-tabs::-webkit-scrollbar {
		display: none;
	}

	.client-tab {
		padding: 0.65rem 1.25rem;
		background: var(--bg-card, #ffffff);
		border: 1px solid var(--border, #e5e7eb);
		border-radius: 10px;
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--text-secondary, #475569);
		cursor: pointer;
		transition:
			transform 0.12s ease,
			box-shadow 0.12s ease,
			color 0.12s ease,
			border-color 0.12s ease,
			background-color 0.12s ease;
		white-space: nowrap;
		flex-shrink: 0;
		box-shadow: 0 4px 10px rgba(0, 0, 0, 0.04);
	}

	.client-tab:hover {
		color: var(--text-primary, #0f172a);
		border-color: color-mix(in srgb, var(--primary, #2c2724) 35%, var(--border, #e5e7eb));
		transform: translateY(-1px);
		box-shadow: 0 8px 18px color-mix(in srgb, var(--primary, #2c2724) 18%, rgba(0, 0, 0, 0.12));
	}

	.client-tab.active {
		color: var(--primary, #2c2724);
		background: color-mix(in srgb, var(--primary, #2c2724) 18%, var(--bg-card, #ffffff));
		border-color: color-mix(in srgb, var(--primary, #2c2724) 38%, var(--border, #e5e7eb));
		box-shadow: 0 10px 22px color-mix(in srgb, var(--primary, #2c2724) 22%, rgba(0, 0, 0, 0.22));
	}

	.client-tab:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--primary, #2c2724) 55%, transparent);
		outline-offset: 3px;
	}

	/* Admin Toggle */
	.admin-toggle-inline {
		display: flex;
		align-items: center;
		margin-left: 1rem;
		margin-right: 100px;
		z-index: 1;
		position: relative;
	}

	/* Danger Zone */
	.danger-section {
		margin-top: 3rem;
		padding-top: 2rem;
		border-top: 2px solid var(--border, #e5e7eb);
	}

	.danger-title {
		color: var(--danger, #dc2626);
	}

	.danger-zone {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1.5rem;
		padding: 1.5rem;
		background-color: color-mix(in srgb, var(--danger, #dc2626) 5%, var(--bg-card, #ffffff));
		border: 1px solid color-mix(in srgb, var(--danger, #dc2626) 30%, var(--border, #e5e7eb));
		border-radius: 8px;
	}

	.danger-zone-content {
		flex: 1;
	}

	.danger-zone-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--danger, #dc2626);
		margin: 0 0 0.5rem 0;
	}

	.danger-zone-description {
		font-size: 0.875rem;
		color: var(--text-secondary, #64748b);
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
		background-color: var(--success, #10b981);
		color: white;
		padding: 2px 8px;
		border-radius: 4px;
		font-size: 0.75rem;
		font-weight: 500;
		white-space: nowrap;
	}

	.cors-hint {
		margin-top: 8px;
		color: var(--warning, #f59e0b);
	}

	.textarea-input {
		min-height: 112px;
		resize: vertical;
	}

	.preformatted-text {
		white-space: pre-wrap;
		word-break: break-word;
	}

	/* Dark mode support */
	:global(.dark) .client-tabs {
		background:
			radial-gradient(
				circle at 12% 18%,
				color-mix(in srgb, var(--primary, #c8b8a8) 14%, transparent),
				transparent 42%
			),
			var(--bg-card, #2d2824);
		border-color: var(--border, #334155);
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
	}

	:global(.dark) .client-tab {
		background: color-mix(in srgb, var(--bg-card, #2d2824) 85%, var(--primary, #c8b8a8) 15%);
		border-color: color-mix(in srgb, var(--border, #334155) 70%, var(--primary, #c8b8a8) 20%);
		color: var(--text-secondary, #cbd5e1);
		box-shadow: 0 6px 16px rgba(0, 0, 0, 0.45);
	}

	:global(.dark) .client-tab:hover {
		color: var(--text-primary, #f5f3f0);
		border-color: color-mix(in srgb, var(--primary, #c8b8a8) 35%, var(--border, #334155));
		box-shadow: 0 10px 22px color-mix(in srgb, var(--primary, #c8b8a8) 20%, rgba(0, 0, 0, 0.25));
	}

	:global(.dark) .client-tab.active {
		color: var(--primary, #c8b8a8);
		background: color-mix(in srgb, var(--primary, #c8b8a8) 22%, var(--bg-card, #2d2824));
		border-color: color-mix(in srgb, var(--primary, #c8b8a8) 40%, var(--border, #334155));
		box-shadow: 0 12px 28px color-mix(in srgb, var(--primary, #c8b8a8) 28%, rgba(0, 0, 0, 0.4));
	}

	:global(.dark) .danger-zone {
		background-color: color-mix(in srgb, var(--danger, #ef4444) 10%, var(--bg-card, #2d2824));
		border-color: color-mix(in srgb, var(--danger, #ef4444) 40%, var(--border, #374151));
	}

	:global(.dark) .danger-zone-description {
		color: var(--text-secondary, #94a3b8);
	}
</style>
