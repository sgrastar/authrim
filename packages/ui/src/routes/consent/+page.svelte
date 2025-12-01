<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { Button, Card, Spinner } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { LL } from '$i18n/i18n-svelte';

	// Type definitions matching backend ConsentScreenData
	interface ConsentScopeInfo {
		name: string;
		title: string;
		description: string;
		required: boolean;
	}

	interface ConsentClientInfo {
		client_id: string;
		client_name: string;
		logo_uri?: string;
		client_uri?: string;
		policy_uri?: string;
		tos_uri?: string;
		is_trusted?: boolean;
	}

	interface ConsentUserInfo {
		id: string;
		email: string;
		name?: string;
		picture?: string;
	}

	interface ConsentOrgInfo {
		id: string;
		name: string;
		type: string;
		is_primary: boolean;
		plan?: string;
	}

	interface ConsentActingAsInfo {
		id: string;
		name?: string;
		email: string;
		relationship_type: string;
		permission_level: string;
	}

	interface ConsentFeatureFlags {
		org_selector_enabled: boolean;
		acting_as_enabled: boolean;
		show_roles: boolean;
	}

	interface ConsentScreenData {
		challenge_id: string;
		client: ConsentClientInfo;
		scopes: ConsentScopeInfo[];
		user: ConsentUserInfo;
		organizations: ConsentOrgInfo[];
		primary_org: ConsentOrgInfo | null;
		roles: string[];
		acting_as: ConsentActingAsInfo | null;
		target_org_id: string | null;
		features: ConsentFeatureFlags;
	}

	let loading = $state(true);
	let allowLoading = $state(false);
	let denyLoading = $state(false);
	let consentData = $state<ConsentScreenData | null>(null);
	let error = $state('');
	let selectedOrgId = $state<string | null>(null);

	// Get challenge_id from URL query params
	const challengeId = $derived($page.url.searchParams.get('challenge_id'));

	onMount(async () => {
		if (!challengeId) {
			error = 'Missing challenge_id parameter';
			loading = false;
			return;
		}
		await loadConsentData();
	});

	async function loadConsentData() {
		if (!challengeId) return;

		try {
			// Determine API base URL (use OP API if configured, otherwise same origin)
			const apiBaseUrl = import.meta.env.VITE_OP_API_URL || '';
			const response = await fetch(`${apiBaseUrl}/auth/consent?challenge_id=${challengeId}`, {
				method: 'GET',
				headers: {
					Accept: 'application/json'
				},
				credentials: 'include'
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				throw new Error(errorData.error_description || 'Failed to load consent data');
			}

			consentData = await response.json();

			// Initialize selected org from response
			if (consentData) {
				selectedOrgId = consentData.target_org_id || consentData.primary_org?.id || null;
			}

			loading = false;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load consent data';
			loading = false;
		}
	}

	function getScopeLabel(scope: string): string {
		const scopeLabels: Record<string, string> = {
			openid: $LL.consent_scope_openid(),
			profile: $LL.consent_scope_profile(),
			email: $LL.consent_scope_email(),
			phone: $LL.consent_scope_phone(),
			address: $LL.consent_scope_address(),
			offline_access: $LL.consent_scope_offline_access()
		};

		return scopeLabels[scope] || scope;
	}

	async function handleAllow() {
		if (!consentData) return;

		allowLoading = true;

		try {
			const apiBaseUrl = import.meta.env.VITE_OP_API_URL || '';
			const response = await fetch(`${apiBaseUrl}/auth/consent`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				credentials: 'include',
				body: JSON.stringify({
					challenge_id: consentData.challenge_id,
					approved: true,
					selected_org_id: selectedOrgId,
					acting_as_user_id: consentData.acting_as?.id
				})
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				throw new Error(errorData.error_description || 'Failed to approve consent');
			}

			const result = await response.json();

			// Redirect to the URL provided by the backend
			if (result.redirect_url) {
				window.location.href = result.redirect_url;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to approve consent';
		} finally {
			allowLoading = false;
		}
	}

	async function handleDeny() {
		if (!consentData) return;

		denyLoading = true;

		try {
			const apiBaseUrl = import.meta.env.VITE_OP_API_URL || '';
			const response = await fetch(`${apiBaseUrl}/auth/consent`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				credentials: 'include',
				body: JSON.stringify({
					challenge_id: consentData.challenge_id,
					approved: false
				})
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				throw new Error(errorData.error_description || 'Failed to deny consent');
			}

			const result = await response.json();

			// Redirect to the URL provided by the backend
			if (result.redirect_url) {
				window.location.href = result.redirect_url;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to deny consent';
		} finally {
			denyLoading = false;
		}
	}

	function handleSwitchAccount() {
		// Redirect to logout and then login
		window.location.href = '/logout?redirect_uri=' + encodeURIComponent(window.location.href);
	}

	function handleOrgChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		selectedOrgId = target.value || null;
	}

	// Helper to get the display name for acting-as user
	function getActingAsDisplayName(actingAs: ConsentActingAsInfo): string {
		return actingAs.name || actingAs.email;
	}

	// Get the currently selected org info
	const selectedOrg = $derived(
		consentData?.organizations.find((o) => o.id === selectedOrgId) || consentData?.primary_org
	);
</script>

<svelte:head>
	<title>{$LL.consent_title({ clientName: consentData?.client.client_name || '' })} - {$LL.app_title()}</title>
</svelte:head>

<div class="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col items-center justify-center px-4 py-12">
	<!-- Language Switcher (Top Right) -->
	<div class="absolute top-4 right-4">
		<LanguageSwitcher />
	</div>

	<!-- Main Card -->
	<div class="w-full max-w-2xl">
		{#if loading}
			<!-- Loading State -->
			<Card class="text-center py-12">
				<Spinner size="xl" color="primary" class="mb-4" />
				<p class="text-gray-600 dark:text-gray-400">{$LL.common_loading()}</p>
			</Card>
		{:else if consentData}
			<!-- Consent Screen -->
			<Card>
				<!-- Client Logo and Name -->
				<div class="text-center mb-6">
					{#if consentData.client.logo_uri}
						<img
							src={consentData.client.logo_uri}
							alt={consentData.client.client_name}
							class="h-16 w-16 mx-auto mb-4 rounded-lg"
						/>
					{:else}
						<div class="h-16 w-16 mx-auto mb-4 rounded-lg bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
							<div class="i-heroicons-building-office h-8 w-8 text-primary-600 dark:text-primary-400"></div>
						</div>
					{/if}

					<h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
						{$LL.consent_title({ clientName: consentData.client.client_name })}
					</h2>

					<p class="text-gray-600 dark:text-gray-400 text-sm">
						{$LL.consent_subtitle()}
					</p>

					{#if consentData.client.is_trusted}
						<div class="inline-flex items-center gap-1 mt-2 px-2 py-1 bg-success-100 dark:bg-success-900/30 text-success-700 dark:text-success-300 rounded-full text-xs">
							<div class="i-heroicons-shield-check h-3 w-3"></div>
							{$LL.consent_trustedClient()}
						</div>
					{/if}

					{#if consentData.client.client_uri}
						<a
							href={consentData.client.client_uri}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center gap-1 text-sm text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300 mt-2"
						>
							{consentData.client.client_uri}
							<div class="i-heroicons-arrow-top-right-on-square h-3 w-3"></div>
						</a>
					{/if}
				</div>

				<!-- Acting-As Warning Banner -->
				{#if consentData.acting_as && consentData.features.acting_as_enabled}
					<div class="mb-6 p-4 bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800 rounded-lg">
						<div class="flex items-start gap-3">
							<div class="i-heroicons-exclamation-triangle h-5 w-5 text-warning-600 dark:text-warning-400 flex-shrink-0 mt-0.5"></div>
							<div>
								<h3 class="text-sm font-medium text-warning-800 dark:text-warning-200">
									{$LL.consent_delegatedAccess()}
								</h3>
								<p class="text-sm text-warning-700 dark:text-warning-300 mt-1">
									{$LL.consent_actingOnBehalfOf({ name: getActingAsDisplayName(consentData.acting_as) })}
								</p>
								<p class="text-xs text-warning-600 dark:text-warning-400 mt-2">
									{$LL.consent_delegatedAccessWarning({ name: getActingAsDisplayName(consentData.acting_as) })}
								</p>
							</div>
						</div>
					</div>
				{/if}

				<div class="border-t border-gray-200 dark:border-gray-700 pt-6 mb-6">
					<!-- Organization Selector (if multiple orgs and feature enabled) -->
					{#if consentData.features.org_selector_enabled && consentData.organizations.length > 1}
						<div class="mb-6">
							<label for="org-select" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
								{$LL.consent_organizationSelect()}
							</label>
							<select
								id="org-select"
								class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
								value={selectedOrgId || ''}
								onchange={handleOrgChange}
							>
								{#each consentData.organizations as org (org.id)}
									<option value={org.id}>
										{org.name}
										{#if org.is_primary}
											({$LL.consent_primaryOrg()})
										{/if}
									</option>
								{/each}
							</select>
						</div>
					{/if}

					<!-- Current Organization Display (when selector is not shown but has org) -->
					{#if !consentData.features.org_selector_enabled && selectedOrg}
						<div class="mb-6 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
							<p class="text-xs text-gray-500 dark:text-gray-400 mb-1">
								{$LL.consent_currentOrganization()}
							</p>
							<p class="text-sm font-medium text-gray-900 dark:text-white">
								{selectedOrg.name}
								{#if selectedOrg.is_primary}
									<span class="ml-2 text-xs text-primary-600 dark:text-primary-400">
										({$LL.consent_primaryOrg()})
									</span>
								{/if}
							</p>
						</div>
					{/if}

					<!-- Roles Display (if enabled and has roles) -->
					{#if consentData.features.show_roles && consentData.roles.length > 0}
						<div class="mb-6">
							<p class="text-xs text-gray-500 dark:text-gray-400 mb-2">
								{$LL.consent_yourRoles()}
							</p>
							<div class="flex flex-wrap gap-2">
								{#each consentData.roles as role (role)}
									<span class="px-2 py-1 bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 rounded-full text-xs">
										{role}
									</span>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Scopes -->
					<h3 class="text-sm font-medium text-gray-900 dark:text-white mb-4">
						{$LL.consent_scopesTitle()}
					</h3>

					<ul class="space-y-3 mb-6">
						{#each consentData.scopes as scope (scope.name)}
							<li class="flex items-start gap-3">
								<div class="i-heroicons-check-circle h-5 w-5 text-success-600 dark:text-success-400 flex-shrink-0 mt-0.5"></div>
								<span class="text-gray-700 dark:text-gray-300 text-sm">
									{getScopeLabel(scope.name)}
								</span>
							</li>
						{/each}
					</ul>

					<!-- User Info -->
					<div class="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
						<p class="text-xs text-gray-500 dark:text-gray-400 mb-2">
							{$LL.consent_userInfo()}
						</p>

						<div class="flex items-center gap-3">
							{#if consentData.user.picture}
								<img
									src={consentData.user.picture}
									alt={consentData.user.name || consentData.user.email}
									class="h-10 w-10 rounded-full"
								/>
							{:else}
								<div class="h-10 w-10 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
									<div class="i-heroicons-user h-5 w-5 text-primary-600 dark:text-primary-400"></div>
								</div>
							{/if}

							<div>
								{#if consentData.user.name}
									<p class="text-sm font-medium text-gray-900 dark:text-white">
										{consentData.user.name}
									</p>
								{/if}
								<p class="text-sm text-gray-600 dark:text-gray-400">
									{consentData.user.email}
								</p>
							</div>
						</div>

						<button
							type="button"
							onclick={handleSwitchAccount}
							class="text-xs text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300 mt-2"
						>
							{$LL.consent_notYou()}
						</button>
					</div>
				</div>

				<!-- Action Buttons -->
				<div class="flex gap-3">
					<Button
						variant="secondary"
						class="flex-1"
						loading={denyLoading}
						disabled={allowLoading}
						onclick={handleDeny}
					>
						{$LL.consent_denyButton()}
					</Button>

					<Button
						variant="primary"
						class="flex-1"
						loading={allowLoading}
						disabled={denyLoading}
						onclick={handleAllow}
					>
						{$LL.consent_allowButton()}
					</Button>
				</div>

				<!-- Privacy Policy and ToS Links -->
				{#if consentData.client.policy_uri || consentData.client.tos_uri}
					<div class="flex items-center justify-center gap-4 mt-4 text-xs text-gray-500 dark:text-gray-400">
						{#if consentData.client.policy_uri}
							<a
								href={consentData.client.policy_uri}
								target="_blank"
								rel="noopener noreferrer"
								class="hover:text-primary-600 dark:hover:text-primary-400 inline-flex items-center gap-1"
							>
								{$LL.consent_privacyPolicy()}
								<div class="i-heroicons-arrow-top-right-on-square h-3 w-3"></div>
							</a>
						{/if}
						{#if consentData.client.tos_uri}
							<a
								href={consentData.client.tos_uri}
								target="_blank"
								rel="noopener noreferrer"
								class="hover:text-primary-600 dark:hover:text-primary-400 inline-flex items-center gap-1"
							>
								{$LL.consent_termsOfService()}
								<div class="i-heroicons-arrow-top-right-on-square h-3 w-3"></div>
							</a>
						{/if}
					</div>
				{/if}
			</Card>
		{:else}
			<!-- Error State -->
			<Card class="text-center py-12">
				<div class="i-heroicons-exclamation-circle h-12 w-12 mx-auto mb-4 text-error-500"></div>
				<p class="text-error-600 dark:text-error-400">{error || 'Failed to load consent data'}</p>
			</Card>
		{/if}
	</div>

	<!-- Footer -->
	<footer class="mt-12 text-center text-xs text-gray-500 dark:text-gray-500">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>
