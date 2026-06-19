<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminAuthenticationMethodsAPI,
		type AuthenticationMethodBuiltInSettings,
		type AuthenticationMethodHumanVerificationSettings,
		type AuthenticationMethodExternalProvider,
		type AuthenticationMethodExternalProviderUsage
	} from '$lib/api/admin-authentication-methods';
	import {
		adminPluginsAPI,
		type PluginWithStatus
	} from '$lib/api/admin-plugins';
	import type { CategorySettings } from '$lib/api/admin-settings';
	import { ToggleSwitch } from '$lib/components';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';

	const DEFAULT_BUILT_IN: AuthenticationMethodBuiltInSettings = {
		passkeyLoginEnabled: true,
		passkeySignupEnabled: true,
		passkeyReauthEnabled: true,
		passkeyAccountLinkEnabled: true,
		emailOtpLoginEnabled: true,
		emailOtpSignupEnabled: true,
		emailOtpReauthEnabled: true,
		emailOtpAccountLinkEnabled: true
	};
	const DEFAULT_HUMAN_VERIFICATION: AuthenticationMethodHumanVerificationSettings = {
		provider: 'human-verification-cloudflare-turnstile',
		loginEnabled: false,
		signupEnabled: false,
		reauthEnabled: false
	};
	const HUMAN_VERIFICATION_PROVIDERS = [
		{
			id: 'human-verification-cloudflare-turnstile',
			name: 'Cloudflare Turnstile',
			description: $LL.admin_authentication_methods_turnstile_description()
		},
		{
			id: 'human-verification-hcaptcha',
			name: 'hCaptcha',
			description: $LL.admin_authentication_methods_hcaptcha_description()
		},
		{
			id: 'human-verification-google-recaptcha',
			name: 'Google reCAPTCHA',
			description: $LL.admin_authentication_methods_recaptcha_description()
		}
	] as const;

	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let successMessage = $state('');
	let settings = $state<CategorySettings | null>(null);
	let builtIn = $state<AuthenticationMethodBuiltInSettings>({ ...DEFAULT_BUILT_IN });
	let initialBuiltInJson = $state(JSON.stringify(DEFAULT_BUILT_IN));
	let humanVerification = $state<AuthenticationMethodHumanVerificationSettings>({
		...DEFAULT_HUMAN_VERIFICATION
	});
	let initialHumanVerificationJson = $state(JSON.stringify(DEFAULT_HUMAN_VERIFICATION));
	let providers = $state<AuthenticationMethodExternalProvider[]>([]);
	let externalProviderUsages = $state<AuthenticationMethodExternalProviderUsage[]>([]);
	let initialExternalProviderUsagesJson = $state('[]');
	let humanVerificationPluginStatuses = $state<Record<string, PluginWithStatus>>({});

	const currentTenantId = $derived(settingsContext.tenantId);
	const canEdit = $derived(settingsContext.canEditAtCurrentScope());
	const hasChanges = $derived(
		JSON.stringify(builtIn) !== initialBuiltInJson ||
			JSON.stringify(humanVerification) !== initialHumanVerificationJson ||
			JSON.stringify(externalProviderUsages) !== initialExternalProviderUsagesJson
	);

	onMount(async () => {
		await settingsContext.initialize();
		await loadData();
	});

	let previousTenantId = $state('');
	$effect(() => {
		if (!currentTenantId || loading) return;
		if (previousTenantId === currentTenantId) return;
		previousTenantId = currentTenantId;
		if (settings) {
			loadData();
		}
	});

	async function loadData() {
		loading = true;
		error = '';
		successMessage = '';
		try {
			const response = await adminAuthenticationMethodsAPI.get(currentTenantId);
			settings = response.settings;
			builtIn = response.builtIn;
			initialBuiltInJson = JSON.stringify(response.builtIn);
			humanVerification = response.humanVerification;
			initialHumanVerificationJson = JSON.stringify(response.humanVerification);
			providers = response.providers;
			externalProviderUsages = response.externalProviderUsages;
			initialExternalProviderUsagesJson = JSON.stringify(response.externalProviderUsages);
			humanVerificationPluginStatuses = await loadHumanVerificationPluginStatuses();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_authentication_methods_error_load();
		} finally {
			loading = false;
		}
	}

	async function loadHumanVerificationPluginStatuses(): Promise<Record<string, PluginWithStatus>> {
		try {
			const response = await adminPluginsAPI.list({
				category: 'security',
				tenantId: currentTenantId
			});
			const entries = response.plugins
				.filter((plugin) =>
					HUMAN_VERIFICATION_PROVIDERS.some((provider) => provider.id === plugin.id)
				)
				.map((plugin) => [plugin.id, plugin] as const);
			return Object.fromEntries(entries);
		} catch {
			return {};
		}
	}

	async function saveProviders() {
		if (!settings) return;
		error = '';
		successMessage = '';
		saving = true;
		try {
			const result = await adminAuthenticationMethodsAPI.update(
				settings,
				builtIn,
				humanVerification,
				providers,
				externalProviderUsages,
				currentTenantId
			);
			settings = { ...settings, version: result.version };
			initialBuiltInJson = JSON.stringify(builtIn);
			initialHumanVerificationJson = JSON.stringify(humanVerification);
			initialExternalProviderUsagesJson = JSON.stringify(externalProviderUsages);
			successMessage = $LL.admin_authentication_methods_saved();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_authentication_methods_error_save();
		} finally {
			saving = false;
		}
	}

	function updateExternalProviderUsage(
		providerId: string,
		key: keyof Pick<
			AuthenticationMethodExternalProviderUsage,
			'loginEnabled' | 'signupEnabled' | 'reauthEnabled' | 'accountLinkEnabled'
		>,
		value: boolean
	) {
		externalProviderUsages = externalProviderUsages.map((provider) => {
			if (provider.id !== providerId) return provider;
			if (key === 'accountLinkEnabled' && !provider.autoLinkEmail) {
				return { ...provider, accountLinkEnabled: false };
			}
			return { ...provider, [key]: value };
		});
	}

	const selectedHumanVerificationProvider = $derived(
		HUMAN_VERIFICATION_PROVIDERS.find((provider) => provider.id === humanVerification.provider) ??
			HUMAN_VERIFICATION_PROVIDERS[0]
	);
	const selectedHumanVerificationPluginStatus = $derived(
		humanVerificationPluginStatuses[humanVerification.provider] ?? null
	);
	const selectedHumanVerificationPluginWarning = $derived.by(() => {
		const status = selectedHumanVerificationPluginStatus;
		if (!status) {
			return $LL.admin_authentication_methods_provider_status_unknown();
		}
		if (!status.enabled) {
			return $LL.admin_authentication_methods_provider_disabled({
				provider: selectedHumanVerificationProvider.name
			});
		}
		if (!status.configured) {
			const required = status.missingRequiredFields.join(', ');
			return required
				? $LL.admin_authentication_methods_provider_missing_config_with_fields({
						provider: selectedHumanVerificationProvider.name,
						fields: required
					})
				: $LL.admin_authentication_methods_provider_missing_config({
						provider: selectedHumanVerificationProvider.name
					});
		}
		return '';
	});
</script>

<svelte:head>
	<title>{$LL.admin_authentication_methods_page_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_authentication_methods_title()}
		description={$LL.admin_authentication_methods_description({ tenantId: currentTenantId })}
	>
		{#snippet actions()}
			<span class="cache-notice">{$LL.admin_authentication_methods_cache_notice()}</span>
			<button class="btn btn-secondary" disabled={!hasChanges || saving} onclick={loadData}>
				{$LL.admin_authentication_methods_discard()}
			</button>
			<button
				class="btn btn-primary"
				disabled={!canEdit || !hasChanges || saving}
				onclick={saveProviders}
			>
				{saving
					? $LL.admin_authentication_methods_saving()
					: $LL.admin_authentication_methods_save()}
			</button>
		{/snippet}
	</AdminPageHeader>

	{#if loading}
		<AdminSection>
			<div class="state">{$LL.admin_authentication_methods_loading()}</div>
		</AdminSection>
	{:else}
		{#if error}
			<div class="alert alert-error">{error}</div>
		{/if}
		{#if successMessage}
			<div class="alert alert-success">{successMessage}</div>
		{/if}

		<AdminSection
			title={$LL.admin_authentication_methods_builtin_title()}
			description={$LL.admin_authentication_methods_builtin_description()}
		>
			<div class="method-matrix">
				<div class="method-matrix-header"></div>
				<div class="method-matrix-column">{$LL.admin_authentication_methods_signup_enabled()}</div>
				<div class="method-matrix-column">{$LL.admin_authentication_methods_login_enabled()}</div>
				<div class="method-matrix-column">{$LL.admin_authentication_methods_reauth_enabled()}</div>
				<div class="method-matrix-column">
					{$LL.admin_authentication_methods_account_link_enabled()}
				</div>

				<div class="method-title">
					<strong>{$LL.admin_authentication_methods_passkey()}</strong>
					<span>{$LL.admin_authentication_methods_passkey_description()}</span>
				</div>
				<div class="method-cell">
					<ToggleSwitch bind:checked={builtIn.passkeySignupEnabled} disabled={!canEdit} size="sm" />
				</div>
				<div class="method-cell">
					<ToggleSwitch bind:checked={builtIn.passkeyLoginEnabled} disabled={!canEdit} size="sm" />
				</div>
				<div class="method-cell">
					<ToggleSwitch bind:checked={builtIn.passkeyReauthEnabled} disabled={!canEdit} size="sm" />
				</div>
				<div class="method-cell">
					<ToggleSwitch
						bind:checked={builtIn.passkeyAccountLinkEnabled}
						disabled={!canEdit}
						size="sm"
					/>
				</div>

				<div class="method-title">
					<strong>{$LL.admin_authentication_methods_email_otp()}</strong>
					<span>{$LL.admin_authentication_methods_email_otp_description()}</span>
				</div>
				<div class="method-cell">
					<ToggleSwitch
						bind:checked={builtIn.emailOtpSignupEnabled}
						disabled={!canEdit}
						size="sm"
					/>
				</div>
				<div class="method-cell">
					<ToggleSwitch bind:checked={builtIn.emailOtpLoginEnabled} disabled={!canEdit} size="sm" />
				</div>
				<div class="method-cell">
					<ToggleSwitch
						bind:checked={builtIn.emailOtpReauthEnabled}
						disabled={!canEdit}
						size="sm"
					/>
				</div>
				<div class="method-cell">
					<ToggleSwitch
						bind:checked={builtIn.emailOtpAccountLinkEnabled}
						disabled={!canEdit}
						size="sm"
					/>
				</div>
			</div>
		</AdminSection>

		<AdminSection title={$LL.admin_authentication_methods_configured()}>
			{#snippet actions()}
				<span class="count">{externalProviderUsages.length}</span>
			{/snippet}

			{#if externalProviderUsages.length === 0}
				<div class="empty">{$LL.admin_authentication_methods_empty()}</div>
			{:else}
				<div class="method-matrix provider-usage-matrix">
					<div class="method-matrix-header"></div>
					<div class="method-matrix-column">
						{$LL.admin_authentication_methods_signup_enabled()}
					</div>
					<div class="method-matrix-column">{$LL.admin_authentication_methods_login_enabled()}</div>
					<div class="method-matrix-column">
						{$LL.admin_authentication_methods_reauth_enabled()}
					</div>
					<div class="method-matrix-column">
						{$LL.admin_authentication_methods_account_link_enabled()}
					</div>
					{#each externalProviderUsages as provider (provider.id)}
						<div class="method-title provider-method-title">
							<div class="provider-title">
								<span>{provider.name}</span>
								{#if !provider.enabled}
									<span class="badge muted">{$LL.admin_authentication_methods_disabled()}</span>
								{/if}
								<span class="badge">{provider.type}</span>
							</div>
							<code class="provider-id">{provider.providerId}</code>
						</div>
						<div class="method-cell">
							<ToggleSwitch
								checked={provider.signupEnabled}
								disabled={!canEdit || !provider.enabled}
								size="sm"
								onchange={(checked) =>
									updateExternalProviderUsage(provider.id, 'signupEnabled', checked)}
							/>
						</div>
						<div class="method-cell">
							<ToggleSwitch
								checked={provider.loginEnabled}
								disabled={!canEdit || !provider.enabled}
								size="sm"
								onchange={(checked) =>
									updateExternalProviderUsage(provider.id, 'loginEnabled', checked)}
							/>
						</div>
						<div class="method-cell">
							<ToggleSwitch
								checked={provider.reauthEnabled}
								disabled={!canEdit || !provider.enabled}
								size="sm"
								onchange={(checked) =>
									updateExternalProviderUsage(provider.id, 'reauthEnabled', checked)}
							/>
						</div>
						<div class="method-cell">
							<ToggleSwitch
								checked={provider.accountLinkEnabled}
								disabled={!canEdit || !provider.enabled || !provider.autoLinkEmail}
								size="sm"
								onchange={(checked) =>
									updateExternalProviderUsage(provider.id, 'accountLinkEnabled', checked)}
							/>
						</div>
					{/each}
				</div>
			{/if}
		</AdminSection>

		<AdminSection
			title={$LL.admin_authentication_methods_human_verification_title()}
			description={$LL.admin_authentication_methods_human_verification_description()}
		>
			<div class="method-matrix human-verification-matrix">
				<div class="method-matrix-header"></div>
				<div class="method-matrix-column">{$LL.admin_authentication_methods_signup_enabled()}</div>
				<div class="method-matrix-column">{$LL.admin_authentication_methods_login_enabled()}</div>
				<div class="method-matrix-column">{$LL.admin_authentication_methods_reauth_enabled()}</div>
				<div class="method-matrix-column" aria-hidden="true"></div>

				<div class="method-title">
					<div class="provider-title">
						<span>{selectedHumanVerificationProvider.name}</span>
						<span class="badge">{$LL.admin_authentication_methods_plugin_managed()}</span>
					</div>
					<label class="provider-select-label" for="human-verification-provider">Provider</label>
					<select
						id="human-verification-provider"
						class="provider-select"
						bind:value={humanVerification.provider}
						disabled={!canEdit}
					>
						{#each HUMAN_VERIFICATION_PROVIDERS as provider (provider.id)}
							<option value={provider.id}>{provider.name}</option>
						{/each}
					</select>
					<span>{selectedHumanVerificationProvider.description}</span>
					{#if selectedHumanVerificationPluginWarning}
						<div class="provider-warning">
							{selectedHumanVerificationPluginWarning}
						</div>
					{/if}
					<a
						href={`/admin/plugins?plugin=${encodeURIComponent(humanVerification.provider)}`}
						class="inline-link plugin-config-link"
					>
						{$LL.admin_authentication_methods_configure_plugin()}
					</a>
				</div>
				<div class="method-cell">
					<ToggleSwitch
						bind:checked={humanVerification.signupEnabled}
						disabled={!canEdit}
						size="sm"
					/>
				</div>
				<div class="method-cell">
					<ToggleSwitch
						bind:checked={humanVerification.loginEnabled}
						disabled={!canEdit}
						size="sm"
					/>
				</div>
				<div class="method-cell">
					<ToggleSwitch
						bind:checked={humanVerification.reauthEnabled}
						disabled={!canEdit}
						size="sm"
					/>
				</div>
				<div class="method-cell" aria-hidden="true"></div>
			</div>
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	:global(.admin-section) {
		--section-margin-block: 10px;
		--section-header-margin-bottom: 5px;
	}

	:global(.admin-section__description) {
		margin-top: 2px;
		font-size: 0.8rem;
		line-height: 1.4;
	}

	:global(.admin-page__header) {
		--page-header-margin: 14px;
		--page-title-size: 1.55rem;
		--page-description-size: 0.84rem;
	}

	:global(.admin-page__description) {
		margin-top: 3px;
		line-height: 1.4;
	}

	.empty,
	.state {
		color: var(--color-text-muted);
	}

	.method-matrix {
		display: grid;
		grid-template-columns: minmax(260px, 50%) repeat(4, minmax(96px, 1fr));
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		overflow: hidden;
	}

	.method-matrix > div {
		padding: 7px 16px;
		border-bottom: 1px solid var(--color-border);
	}

	.method-matrix > div:nth-last-child(-n + 5) {
		border-bottom: 0;
	}

	.method-matrix-column {
		font-size: 0.68rem;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.method-title {
		display: flex;
		flex-direction: column;
		gap: 4px;
		color: var(--color-text);
	}

	.method-title > span {
		font-size: 0.8rem;
		color: var(--color-text-muted);
	}

	.method-cell {
		display: flex;
		align-items: center;
	}

	.cache-notice {
		color: var(--color-text-muted);
		font-size: 0.78rem;
		line-height: 1.35;
		white-space: nowrap;
	}

	.inline-link {
		color: var(--color-primary);
		font-weight: 700;
		text-decoration: none;
	}

	.plugin-config-link {
		width: fit-content;
		font-size: 0.8rem;
		line-height: 1.35;
	}

	.provider-warning {
		border: 1px solid color-mix(in srgb, var(--color-warning) 34%, var(--color-border));
		border-radius: 6px;
		background: color-mix(in srgb, var(--color-warning) 10%, transparent);
		color: var(--color-warning);
		font-size: 0.78rem;
		font-weight: 650;
		line-height: 1.4;
		padding: 7px 9px;
	}

	.provider-title {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		font-weight: 700;
		color: var(--color-text);
		font-size: 0.9rem;
	}

	.provider-select-label {
		color: var(--color-text-muted);
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.provider-select {
		width: min(100%, 280px);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-surface);
		color: var(--color-text);
		font: inherit;
		font-size: 0.82rem;
		padding: 7px 9px;
	}

	.provider-id {
		color: var(--color-text);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 0.78rem;
	}

	.badge,
	.count {
		display: inline-flex;
		align-items: center;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		padding: 2px 8px;
		font-size: 11px;
		font-weight: 700;
		color: var(--color-text-muted);
		background: var(--color-surface-muted);
	}

	.badge.muted {
		border-color: color-mix(in srgb, var(--color-warning) 34%, var(--color-border));
		background: color-mix(in srgb, var(--color-warning) 10%, transparent);
		color: var(--color-warning);
	}

	.alert {
		border-radius: var(--radius-control);
		padding: 10px 12px;
		font-size: 14px;
	}

	.alert-error {
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
		border: 1px solid color-mix(in srgb, var(--color-danger) 32%, var(--color-border));
	}

	.alert-success {
		background: color-mix(in srgb, var(--color-success) 10%, transparent);
		color: var(--color-success);
		border: 1px solid color-mix(in srgb, var(--color-success) 32%, var(--color-border));
	}

	.empty,
	.state {
		padding: 14px 16px;
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface-muted);
	}

	@media (max-width: 980px) {
		.method-matrix {
			grid-template-columns: minmax(180px, 44%) repeat(4, minmax(82px, 1fr));
		}
	}

	@media (max-width: 720px) {
		.method-matrix {
			grid-template-columns: 1fr;
		}

		.method-matrix-header,
		.method-matrix-column {
			display: none;
		}

		.method-matrix > div {
			border-bottom: 1px solid var(--color-border);
		}

		.method-cell {
			justify-content: space-between;
		}
	}
</style>
