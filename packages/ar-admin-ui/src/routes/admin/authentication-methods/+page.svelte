<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminAuthenticationMethodsAPI,
		type AuthenticationMethodBuiltInSettings,
		type AuthenticationMethodExternalProviderUsage
	} from '$lib/api/admin-authentication-methods';
	import { ToggleSwitch } from '$lib/components';
	import type { CategorySettings } from '$lib/api/admin-settings';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';

	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let successMessage = $state('');
	let settings = $state<CategorySettings | null>(null);
	let builtIn = $state<AuthenticationMethodBuiltInSettings>({
		passkeyLoginEnabled: true,
		passkeySignupEnabled: true,
		passkeyReauthEnabled: true,
		passkeyAccountLinkEnabled: true,
		emailOtpLoginEnabled: true,
		emailOtpSignupEnabled: true,
		emailOtpReauthEnabled: true,
		emailOtpAccountLinkEnabled: true
	});
	let initialBuiltInJson = $state(
		'{"passkeyLoginEnabled":true,"passkeySignupEnabled":true,"passkeyReauthEnabled":true,"passkeyAccountLinkEnabled":true,"emailOtpLoginEnabled":true,"emailOtpSignupEnabled":true,"emailOtpReauthEnabled":true,"emailOtpAccountLinkEnabled":true}'
	);
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
			externalProviderUsages = response.externalProviderUsages;
			initialExternalProviderUsagesJson = JSON.stringify(response.externalProviderUsages);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_authentication_methods_error_load();
		} finally {
			loading = false;
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

	async function saveProviders() {
		if (!settings) return;
		error = '';
		successMessage = '';
		saving = true;
		try {
			const result = await adminAuthenticationMethodsAPI.update(
				settings,
				builtIn,
				[],
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
</script>

<svelte:head>
	<title>{$LL.admin_authentication_methods_page_title()}</title>
</svelte:head>

<div class="page-shell">
	<header class="page-header">
		<div>
			<h1>{$LL.admin_authentication_methods_title()}</h1>
			<p>{$LL.admin_authentication_methods_description({ tenantId: currentTenantId })}</p>
		</div>
	</header>

	{#if loading}
		<div class="state">{$LL.admin_authentication_methods_loading()}</div>
	{:else}
		{#if error}
			<div class="alert error">{error}</div>
		{/if}
		{#if successMessage}
			<div class="alert success">{successMessage}</div>
		{/if}

		<section class="section">
			<div class="section-header">
				<div>
					<h2>{$LL.admin_authentication_methods_builtin_title()}</h2>
				</div>
			</div>

			<div class="method-matrix">
				<div class="method-matrix-header"></div>
				<div class="method-matrix-column">{$LL.admin_authentication_methods_signup_enabled()}</div>
				<div class="method-matrix-column">{$LL.admin_authentication_methods_login_enabled()}</div>
				<div class="method-matrix-column">{$LL.admin_authentication_methods_reauth_enabled()}</div>
				<div class="method-matrix-column">
					{$LL.admin_authentication_methods_account_link_enabled()}
				</div>

				<div class="method-title">{$LL.admin_authentication_methods_passkey()}</div>
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

				<div class="method-title">{$LL.admin_authentication_methods_email_otp()}</div>
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
		</section>

		<section class="section">
			<div class="section-header">
				<h2>{$LL.admin_authentication_methods_configured()}</h2>
				<span class="count">{externalProviderUsages.length}</span>
			</div>

			{#if externalProviderUsages.length === 0}
				<div class="empty">{$LL.admin_authentication_methods_empty()}</div>
			{:else}
				<div class="method-matrix external-method-matrix">
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
							<span>{provider.name}</span>
							<span class="provider-meta-inline">
								<code>{provider.id}</code>
								<span>{provider.type}</span>
								<span>{$LL.admin_external_idp_priority()}: {provider.priority}</span>
							</span>
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
		</section>

		<div class="page-save-actions">
			<button class="btn secondary" disabled={!hasChanges || saving} onclick={loadData}
				>{$LL.admin_authentication_methods_discard()}</button
			>
			<button
				class="btn primary"
				disabled={!canEdit || !hasChanges || saving}
				onclick={saveProviders}
			>
				{saving
					? $LL.admin_authentication_methods_saving()
					: $LL.admin_authentication_methods_save()}
			</button>
		</div>
	{/if}
</div>

<style>
	.page-shell {
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.page-header {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		align-items: flex-start;
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	h1 {
		font-size: 28px;
		font-weight: 700;
		color: var(--color-text, #111827);
	}

	h2 {
		font-size: 16px;
		font-weight: 650;
		color: var(--color-text, #111827);
	}

	p,
	.empty,
	.state {
		color: var(--color-text-muted, #6b7280);
	}

	.page-save-actions,
	.section-header {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.section-header {
		justify-content: space-between;
	}

	.section {
		background: var(--color-surface, #fff);
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 8px;
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.method-matrix {
		display: grid;
		grid-template-columns: minmax(120px, 1fr) repeat(4, minmax(120px, 160px));
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 8px;
		overflow: hidden;
	}

	.method-matrix-header,
	.method-matrix-column,
	.method-title,
	.method-cell {
		display: flex;
		align-items: center;
		min-height: 48px;
		padding: 10px 14px;
		border-right: 1px solid var(--color-border, #e5e7eb);
		border-bottom: 1px solid var(--color-border, #e5e7eb);
	}

	.method-matrix-column {
		justify-content: center;
		font-size: 12px;
		font-weight: 700;
		color: var(--color-text-muted, #6b7280);
		text-align: center;
	}

	.method-title {
		font-weight: 650;
	}

	.method-cell {
		justify-content: center;
	}

	.method-matrix > :nth-child(5n) {
		border-right: 0;
	}

	.method-matrix > :nth-last-child(-n + 5) {
		border-bottom: 0;
	}

	.page-save-actions {
		justify-content: flex-end;
	}

	.provider-method-title {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}

	.provider-meta-inline {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		font-size: 13px;
		font-weight: 500;
		color: var(--color-text-muted, #6b7280);
	}

	.btn {
		border: 1px solid var(--color-border, #d1d5db);
		border-radius: 6px;
		background: var(--color-surface, #fff);
		color: var(--color-text, #111827);
		cursor: pointer;
	}

	.btn {
		min-height: 40px;
		padding: 0 14px;
		font-weight: 600;
	}

	.btn.primary {
		background: #111827;
		border-color: #111827;
		color: #fff;
	}

	.btn.secondary {
		background: transparent;
	}

	button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.count {
		display: inline-flex;
		align-items: center;
		border: 1px solid var(--color-border, #d1d5db);
		border-radius: 999px;
		padding: 2px 8px;
		font-size: 12px;
		font-weight: 600;
		color: var(--color-text-muted, #6b7280);
	}

	.alert {
		border-radius: 6px;
		padding: 10px 12px;
		font-size: 14px;
	}

	.alert.error {
		background: #fef2f2;
		color: #991b1b;
		border: 1px solid #fecaca;
	}

	.alert.success {
		background: #f0fdf4;
		color: #166534;
		border: 1px solid #bbf7d0;
	}

	.empty,
	.state {
		padding: 18px;
		border: 1px dashed var(--color-border, #d1d5db);
		border-radius: 8px;
	}

	@media (max-width: 760px) {
		.page-header {
			flex-direction: column;
		}

		.page-save-actions {
			justify-content: flex-start;
		}

		.method-matrix {
			grid-template-columns: minmax(104px, 1fr) repeat(4, minmax(84px, 1fr));
			overflow-x: auto;
		}

		.method-matrix-header,
		.method-matrix-column,
		.method-title,
		.method-cell {
			padding: 10px;
		}
	}
</style>
