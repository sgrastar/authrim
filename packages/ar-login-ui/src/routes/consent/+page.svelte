<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { Button, Card, Spinner } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { brandingStore } from '$lib/stores/branding.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { API_BASE_URL, consentAPI, type ConsentSubmission } from '$lib/api/client';
	import { isValidRedirectUrl, isValidImageUrl, isValidLinkUrl } from '$lib/utils/url-validation';

	// ---------------------------------------------------------------------------
	// Types
	// ---------------------------------------------------------------------------
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

	interface ConsentScreenItem {
		statement_id: string;
		slug: string;
		category: string;
		legal_basis: string;
		title: string;
		description: string;
		document_url?: string;
		inline_content?: string;
		version: string;
		version_id: string;
		is_required: boolean;
		enforcement: string;
		current_status?: string;
		current_version?: string;
		needs_version_upgrade: boolean;
		show_deletion_link: boolean;
		deletion_url?: string;
		display_order: number;
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
		consent_items?: ConsentScreenItem[];
		consent_management_enabled?: boolean;
		consent_language?: string;
	}

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let loading = $state(true);
	let allowLoading = $state(false);
	let denyLoading = $state(false);
	let consentData = $state<ConsentScreenData | null>(null);
	let error = $state('');
	let selectedOrgId = $state<string | null>(null);
	let consentItemDecisions = $state<Record<string, 'granted' | 'denied'>>({});

	const challengeId = $derived($page.url.searchParams.get('challenge_id'));

	const selectedOrg = $derived(
		consentData?.organizations.find((o) => o.id === selectedOrgId) || consentData?.primary_org
	);

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------
	onMount(async () => {
		if (!challengeId) {
			error = 'Missing challenge_id parameter';
			loading = false;
			return;
		}
		await loadConsentData();
	});

	// ---------------------------------------------------------------------------
	// Data
	// ---------------------------------------------------------------------------
	async function loadConsentData() {
		if (!challengeId) return;

		try {
			const { data, error: apiError } = await consentAPI.getData(challengeId);
			if (apiError) {
				throw new Error(apiError.error_description || 'Failed to load consent data');
			}

			consentData = data as ConsentScreenData;
			if (consentData) {
				selectedOrgId = consentData.target_org_id || consentData.primary_org?.id || null;
				// Initialize consent item decisions
				if (consentData.consent_items) {
					const decisions: Record<string, 'granted' | 'denied'> = {};
					for (const item of consentData.consent_items) {
						// Required items default to granted, optional to denied
						decisions[item.statement_id] = item.is_required ? 'granted' : 'denied';
					}
					consentItemDecisions = decisions;
				}
			}
			loading = false;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load consent data';
			loading = false;
		}
	}

	// ---------------------------------------------------------------------------
	// Handlers
	// ---------------------------------------------------------------------------
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
		if (!consentData || allowLoading || denyLoading) return;
		allowLoading = true;

		try {
			const submitPayload: ConsentSubmission = {
				challenge_id: consentData.challenge_id,
				approved: true,
				selected_org_id: selectedOrgId || undefined,
				acting_as_user_id: consentData.acting_as?.id
			};
			// Include consent item decisions if consent management is enabled
			if (consentData.consent_management_enabled && Object.keys(consentItemDecisions).length > 0) {
				submitPayload.consent_item_decisions = consentItemDecisions;
			}
			const { data, error: apiError } = await consentAPI.submit(submitPayload);

			if (apiError) {
				throw new Error(apiError.error_description || 'Failed to approve consent');
			}
			if (data?.redirect_url) {
				if (isValidRedirectUrl(data.redirect_url)) {
					window.location.href = data.redirect_url;
				} else {
					error = 'Invalid redirect URL received from server';
				}
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to approve consent';
		} finally {
			allowLoading = false;
		}
	}

	async function handleDeny() {
		if (!consentData || allowLoading || denyLoading) return;
		denyLoading = true;

		try {
			const { data, error: apiError } = await consentAPI.submit({
				challenge_id: consentData.challenge_id,
				approved: false
			});

			if (apiError) {
				throw new Error(apiError.error_description || 'Failed to deny consent');
			}
			if (data?.redirect_url) {
				if (isValidRedirectUrl(data.redirect_url)) {
					window.location.href = data.redirect_url;
				} else {
					error = 'Invalid redirect URL received from server';
				}
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to deny consent';
		} finally {
			denyLoading = false;
		}
	}

	function handleSwitchAccount() {
		// Only preserve challenge_id to prevent parameter injection
		const cid = new URLSearchParams(window.location.search).get('challenge_id');
		const returnPath = cid ? `/consent?challenge_id=${encodeURIComponent(cid)}` : '/consent';
		const returnUrl = new URL(returnPath, window.location.origin).toString();
		window.location.href = `${API_BASE_URL}/logout?redirect_uri=${encodeURIComponent(returnUrl)}`;
	}

	function handleOrgChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		selectedOrgId = target.value || null;
	}

	function getActingAsDisplayName(actingAs: ConsentActingAsInfo): string {
		return actingAs.name || actingAs.email;
	}
</script>

<svelte:head>
	<title
		>{$LL.consent_title({ clientName: consentData?.client.client_name || '' })} - {brandingStore.brandName ||
			$LL.app_title()}</title
	>
</svelte:head>

<div class="auth-page">
	<LanguageSwitcher />

	<div class="auth-container auth-container--wide">
		{#if loading}
			<!-- Loading State -->
			<Card class="text-center py-12">
				<Spinner size="xl" color="primary" class="mb-4" />
				<p style="color: var(--text-secondary);">{$LL.common_loading()}</p>
			</Card>
		{:else if consentData}
			<!-- Consent Screen -->
			<Card>
				<!-- Client Logo and Name -->
				<div class="text-center mb-6">
					{#if consentData.client.logo_uri && isValidImageUrl(consentData.client.logo_uri)}
						<img
							src={consentData.client.logo_uri}
							alt={consentData.client.client_name}
							class="h-16 w-16 mx-auto mb-4 rounded-lg"
						/>
					{:else}
						<div class="auth-icon-badge" style="margin-bottom: 16px;">
							<div class="auth-icon-badge__circle" style="width: 64px; height: 64px;">
								<div class="i-heroicons-building-office h-8 w-8 auth-icon-badge__icon"></div>
							</div>
						</div>
					{/if}

					<h2 class="auth-section-title" style="text-align: center;">
						{$LL.consent_title({ clientName: consentData.client.client_name })}
					</h2>

					<p class="auth-section-subtitle" style="text-align: center;">
						{$LL.consent_subtitle()}
					</p>

					{#if consentData.client.is_trusted}
						<div class="mt-2">
							<span class="auth-badge--trusted">
								<span class="i-heroicons-shield-check h-3 w-3"></span>
								{$LL.consent_trustedClient()}
							</span>
						</div>
					{/if}

					{#if consentData.client.client_uri && isValidLinkUrl(consentData.client.client_uri)}
						<a
							href={consentData.client.client_uri}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center gap-1 text-sm mt-2"
							style="color: var(--primary);"
						>
							{consentData.client.client_uri}
							<span class="i-heroicons-arrow-top-right-on-square h-3 w-3"></span>
						</a>
					{/if}
				</div>

				<!-- Acting-As Warning Banner -->
				{#if consentData.acting_as && consentData.features.acting_as_enabled}
					<div class="auth-warning-banner mb-6">
						<div class="flex items-start gap-3">
							<div
								class="i-heroicons-exclamation-triangle h-5 w-5 flex-shrink-0 mt-0.5"
								style="color: var(--warning);"
							></div>
							<div>
								<h3 class="auth-warning-banner__title">
									{$LL.consent_delegatedAccess()}
								</h3>
								<p class="auth-warning-banner__text">
									{$LL.consent_actingOnBehalfOf({
										name: getActingAsDisplayName(consentData.acting_as)
									})}
								</p>
								<p class="auth-warning-banner__text" style="margin-top: 8px; font-size: 0.75rem;">
									{$LL.consent_delegatedAccessWarning({
										name: getActingAsDisplayName(consentData.acting_as)
									})}
								</p>
							</div>
						</div>
					</div>
				{/if}

				<div style="border-top: 1px solid var(--border); padding-top: 24px; margin-bottom: 24px;">
					<!-- Organization Selector -->
					{#if consentData.features.org_selector_enabled && consentData.organizations.length > 1}
						<div class="mb-6">
							<label
								for="org-select"
								class="block text-sm font-medium mb-2"
								style="color: var(--text-secondary);"
							>
								{$LL.consent_organizationSelect()}
							</label>
							<select
								id="org-select"
								class="auth-lang-select"
								style="width: 100%; padding: 10px 12px; font-size: 0.875rem;"
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

					<!-- Current Organization Display -->
					{#if !consentData.features.org_selector_enabled && selectedOrg}
						<div class="auth-info-box mb-6">
							<p class="auth-info-box__label">
								{$LL.consent_currentOrganization()}
							</p>
							<p class="auth-info-box__value">
								{selectedOrg.name}
								{#if selectedOrg.is_primary}
									<span style="margin-left: 8px; font-size: 0.75rem; color: var(--primary);">
										({$LL.consent_primaryOrg()})
									</span>
								{/if}
							</p>
						</div>
					{/if}

					<!-- Roles Display -->
					{#if consentData.features.show_roles && consentData.roles.length > 0}
						<div class="mb-6">
							<p class="text-xs mb-2" style="color: var(--text-muted);">
								{$LL.consent_yourRoles()}
							</p>
							<div class="flex flex-wrap gap-2">
								{#each consentData.roles as role (role)}
									<span
										class="px-2 py-1 rounded-full text-xs"
										style="background: var(--primary-light); color: var(--primary);"
									>
										{role}
									</span>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Consent Items (Required) -->
					{#if consentData.consent_management_enabled && consentData.consent_items?.some((i) => i.is_required)}
						<div class="mb-6">
							<h3 class="text-sm font-medium mb-3" style="color: var(--text-primary);">
								{$LL.consent_items_required_title()}
							</h3>
							{#each consentData.consent_items.filter((i) => i.is_required) as item (item.statement_id)}
								<div
									class="flex items-start gap-3 p-3 rounded-lg mb-2"
									style="background: var(--surface-secondary);"
								>
									<input
										type="checkbox"
										checked={consentItemDecisions[item.statement_id] === 'granted'}
										disabled={item.enforcement === 'block'}
										onchange={() => {
											consentItemDecisions[item.statement_id] =
												consentItemDecisions[item.statement_id] === 'granted'
													? 'denied'
													: 'granted';
										}}
										class="mt-1 flex-shrink-0"
									/>
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2 flex-wrap">
											<span class="text-sm font-medium" style="color: var(--text-primary);">
												{item.title}
											</span>
											<span
												class="px-1.5 py-0.5 rounded text-xs"
												style="background: var(--danger-light, #fef2f2); color: var(--danger);"
											>
												{$LL.consent_item_required_badge()}
											</span>
											{#if item.needs_version_upgrade && item.current_version}
												<span
													class="px-1.5 py-0.5 rounded text-xs"
													style="background: var(--warning-light, #fffbeb); color: var(--warning);"
												>
													{$LL.consent_item_version_updated({
														oldVersion: item.current_version,
														newVersion: item.version
													})}
												</span>
											{/if}
										</div>
										<p class="text-xs mt-1" style="color: var(--text-secondary);">
											{item.description}
										</p>
										{#if item.document_url}
											<a
												href={item.document_url}
												target="_blank"
												rel="noopener noreferrer"
												class="inline-flex items-center gap-1 text-xs mt-1"
												style="color: var(--primary);"
											>
												{$LL.consent_item_view_document()}
												<span class="i-heroicons-arrow-top-right-on-square h-3 w-3"></span>
											</a>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}

					<!-- Consent Items (Optional) -->
					{#if consentData.consent_management_enabled && consentData.consent_items?.some((i) => !i.is_required)}
						<div class="mb-6">
							<h3 class="text-sm font-medium mb-3" style="color: var(--text-primary);">
								{$LL.consent_items_optional_title()}
							</h3>
							{#each consentData.consent_items.filter((i) => !i.is_required) as item (item.statement_id)}
								<div
									class="flex items-start gap-3 p-3 rounded-lg mb-2"
									style="background: var(--surface-secondary);"
								>
									<input
										type="checkbox"
										checked={consentItemDecisions[item.statement_id] === 'granted'}
										onchange={() => {
											consentItemDecisions[item.statement_id] =
												consentItemDecisions[item.statement_id] === 'granted'
													? 'denied'
													: 'granted';
										}}
										class="mt-1 flex-shrink-0"
									/>
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2 flex-wrap">
											<span class="text-sm font-medium" style="color: var(--text-primary);">
												{item.title}
											</span>
											<span
												class="px-1.5 py-0.5 rounded text-xs"
												style="background: var(--primary-light, #eff6ff); color: var(--primary);"
											>
												{$LL.consent_item_optional_badge()}
											</span>
											{#if item.needs_version_upgrade && item.current_version}
												<span
													class="px-1.5 py-0.5 rounded text-xs"
													style="background: var(--warning-light, #fffbeb); color: var(--warning);"
												>
													{$LL.consent_item_version_updated({
														oldVersion: item.current_version,
														newVersion: item.version
													})}
												</span>
											{/if}
										</div>
										<p class="text-xs mt-1" style="color: var(--text-secondary);">
											{item.description}
										</p>
										{#if item.document_url}
											<a
												href={item.document_url}
												target="_blank"
												rel="noopener noreferrer"
												class="inline-flex items-center gap-1 text-xs mt-1"
												style="color: var(--primary);"
											>
												{$LL.consent_item_view_document()}
												<span class="i-heroicons-arrow-top-right-on-square h-3 w-3"></span>
											</a>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}

										<!-- Scopes -->
					<h3 class="text-sm font-medium mb-4" style="color: var(--text-primary);">
						{$LL.consent_scopesTitle()}
					</h3>

					<ul class="auth-scopes-list mb-6">
						{#each consentData.scopes as scope (scope.name)}
							<li>
								<div class="i-heroicons-check-circle h-5 w-5 auth-scopes-list__icon"></div>
								<span>{getScopeLabel(scope.name)}</span>
							</li>
						{/each}
					</ul>

					<!-- User Info -->
					<div class="auth-info-box">
						<p class="auth-info-box__label mb-2">
							{$LL.consent_userInfo()}
						</p>

						<div class="auth-user-info">
							{#if consentData.user.picture && isValidImageUrl(consentData.user.picture)}
								<img
									src={consentData.user.picture}
									alt={consentData.user.name || consentData.user.email}
									class="auth-user-info__avatar"
								/>
							{:else}
								<div class="auth-user-info__avatar-placeholder">
									<div class="i-heroicons-user h-5 w-5" style="color: var(--primary);"></div>
								</div>
							{/if}

							<div>
								{#if consentData.user.name}
									<p class="auth-user-info__name">{consentData.user.name}</p>
								{/if}
								<p class="auth-user-info__email">{consentData.user.email}</p>
							</div>
						</div>

						<button
							type="button"
							onclick={handleSwitchAccount}
							class="text-xs mt-2"
							style="color: var(--primary); background: none; border: none; cursor: pointer; padding: 0;"
						>
							{$LL.consent_notYou()}
						</button>
					</div>
				</div>

				<!-- Action Buttons -->
				<div class="auth-actions">
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

				<!-- Block Message and Deletion Link -->
				{#if consentData.consent_management_enabled}
					{@const blockItems = consentData.consent_items?.filter(
						(i) =>
							i.is_required &&
							i.enforcement === 'block' &&
							consentItemDecisions[i.statement_id] !== 'granted'
					)}
					{#if blockItems && blockItems.length > 0}
						<div
							class="mt-4 p-3 rounded-lg text-sm"
							style="background: var(--warning-light, #fffbeb); color: var(--warning-dark, #92400e);"
						>
							<p>{$LL.consent_block_message()}</p>
						</div>
					{/if}
					{@const deletionItem = consentData.consent_items?.find(
						(i) => i.show_deletion_link && i.deletion_url
					)}
					{#if deletionItem}
						<div class="mt-3 text-center">
							<a
								href={deletionItem.deletion_url}
								target="_blank"
								rel="noopener noreferrer"
								class="text-xs"
								style="color: var(--danger);"
							>
								{$LL.consent_delete_account_link()}
							</a>
						</div>
					{/if}
				{/if}

				<!-- Privacy Policy and ToS Links -->
				{#if consentData.client.policy_uri || consentData.client.tos_uri}
					<div
						class="flex items-center justify-center gap-4 mt-4 text-xs"
						style="color: var(--text-muted);"
					>
						{#if consentData.client.policy_uri && isValidLinkUrl(consentData.client.policy_uri)}
							<a
								href={consentData.client.policy_uri}
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1"
								style="color: var(--text-muted);"
							>
								{$LL.consent_privacyPolicy()}
								<span class="i-heroicons-arrow-top-right-on-square h-3 w-3"></span>
							</a>
						{/if}
						{#if consentData.client.tos_uri && isValidLinkUrl(consentData.client.tos_uri)}
							<a
								href={consentData.client.tos_uri}
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1"
								style="color: var(--text-muted);"
							>
								{$LL.consent_termsOfService()}
								<span class="i-heroicons-arrow-top-right-on-square h-3 w-3"></span>
							</a>
						{/if}
					</div>
				{/if}
			</Card>
		{:else}
			<!-- Error State -->
			<Card class="text-center py-12">
				<div
					class="i-heroicons-exclamation-circle h-12 w-12 mx-auto mb-4"
					style="color: var(--danger);"
				></div>
				<p style="color: var(--danger);">{error || 'Failed to load consent data'}</p>
			</Card>
		{/if}
	</div>

	<!-- Footer -->
	<footer class="auth-footer">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>
