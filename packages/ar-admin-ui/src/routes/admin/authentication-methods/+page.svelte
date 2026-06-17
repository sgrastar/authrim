<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminAuthenticationMethodsAPI,
		type AuthenticationMethodBuiltInSettings,
		type AuthenticationMethodExternalProvider,
		type AuthenticationMethodExternalProviderUsage
	} from '$lib/api/admin-authentication-methods';
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

	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let successMessage = $state('');
	let settings = $state<CategorySettings | null>(null);
	let builtIn = $state<AuthenticationMethodBuiltInSettings>({ ...DEFAULT_BUILT_IN });
	let initialBuiltInJson = $state(JSON.stringify(DEFAULT_BUILT_IN));
	let providers = $state<AuthenticationMethodExternalProvider[]>([]);
	let externalProviderUsages = $state<AuthenticationMethodExternalProviderUsage[]>([]);
	let initialExternalProviderUsagesJson = $state('[]');

	const currentTenantId = $derived(settingsContext.tenantId);
	const canEdit = $derived(settingsContext.canEditAtCurrentScope());
	const hasChanges = $derived(
		JSON.stringify(builtIn) !== initialBuiltInJson ||
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
			providers = response.providers;
			externalProviderUsages = response.externalProviderUsages;
			initialExternalProviderUsagesJson = JSON.stringify(response.externalProviderUsages);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_authentication_methods_error_load();
		} finally {
			loading = false;
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
				providers,
				externalProviderUsages,
				currentTenantId
			);
			settings = { ...settings, version: result.version };
			initialBuiltInJson = JSON.stringify(builtIn);
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
				<div class="provider-usage-list">
					{#each externalProviderUsages as provider (provider.id)}
						<div class="provider-usage-row">
							<div class="provider-main">
								<div class="provider-title">
									<span>{provider.name}</span>
									{#if !provider.enabled}
										<span class="badge muted">{$LL.admin_authentication_methods_disabled()}</span>
									{/if}
									<span class="badge">{provider.type}</span>
								</div>
								<div class="provider-meta">
									<code class="provider-id">{provider.providerId}</code>
								</div>
							</div>
							<div class="usage-controls">
								<label>
									<span>{$LL.admin_authentication_methods_signup_enabled()}</span>
									<ToggleSwitch
										checked={provider.signupEnabled}
										disabled={!canEdit || !provider.enabled}
										size="sm"
										onchange={(checked) =>
											updateExternalProviderUsage(provider.id, 'signupEnabled', checked)}
									/>
								</label>
								<label>
									<span>{$LL.admin_authentication_methods_login_enabled()}</span>
									<ToggleSwitch
										checked={provider.loginEnabled}
										disabled={!canEdit || !provider.enabled}
										size="sm"
										onchange={(checked) =>
											updateExternalProviderUsage(provider.id, 'loginEnabled', checked)}
									/>
								</label>
								<label>
									<span>{$LL.admin_authentication_methods_reauth_enabled()}</span>
									<ToggleSwitch
										checked={provider.reauthEnabled}
										disabled={!canEdit || !provider.enabled}
										size="sm"
										onchange={(checked) =>
											updateExternalProviderUsage(provider.id, 'reauthEnabled', checked)}
									/>
								</label>
								<label>
									<span>{$LL.admin_authentication_methods_account_link_enabled()}</span>
									<ToggleSwitch
										checked={provider.accountLinkEnabled}
										disabled={!canEdit || !provider.enabled || !provider.autoLinkEmail}
										size="sm"
										onchange={(checked) =>
											updateExternalProviderUsage(provider.id, 'accountLinkEnabled', checked)}
									/>
								</label>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.empty,
	.state,
	.provider-meta {
		color: var(--color-text-muted);
	}

	.method-matrix {
		display: grid;
		grid-template-columns: minmax(220px, 1.4fr) repeat(4, minmax(120px, 0.7fr));
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		overflow: hidden;
	}

	.method-matrix > div {
		padding: 14px 16px;
		border-bottom: 1px solid var(--color-border);
	}

	.method-matrix > div:nth-last-child(-n + 5) {
		border-bottom: 0;
	}

	.method-matrix-column {
		font-size: 0.72rem;
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

	.method-title span {
		font-size: 0.84rem;
		color: var(--color-text-muted);
	}

	.method-cell {
		display: flex;
		align-items: center;
	}

	.provider-usage-list {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		overflow: hidden;
	}

	.provider-usage-row {
		display: grid;
		grid-template-columns: minmax(220px, 1fr) minmax(420px, 1.6fr);
		gap: 18px;
		padding: 16px;
		border-bottom: 1px solid var(--color-border);
	}

	.provider-usage-row:last-child {
		border-bottom: 0;
	}

	.provider-main {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.provider-title {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		font-weight: 700;
		color: var(--color-text);
	}

	.provider-id {
		color: var(--color-text);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 0.78rem;
	}

	.usage-controls {
		display: grid;
		grid-template-columns: repeat(4, minmax(110px, 1fr));
		gap: 12px;
	}

	.usage-controls label {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		font-size: 0.82rem;
		font-weight: 700;
		color: var(--color-text-muted);
	}

	.badge,
	.count {
		display: inline-flex;
		align-items: center;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		padding: 2px 8px;
		font-size: 12px;
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
		padding: 18px;
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface-muted);
	}

	@media (max-width: 980px) {
		.method-matrix {
			grid-template-columns: minmax(180px, 1fr) repeat(4, minmax(86px, 0.6fr));
		}

		.provider-usage-row {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 720px) {
		.method-matrix,
		.usage-controls {
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
