<script lang="ts">
	import { onMount } from 'svelte';
		import {
			adminLoginMethodsAPI,
			type LoginMethodExternalProvider,
			type LoginMethodProviderType
		} from '$lib/api/admin-login-methods';
	import type { CategorySettings } from '$lib/api/admin-settings';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	const EMPTY_FORM: LoginMethodExternalProvider = {
		id: '',
		name: '',
		type: 'vc',
		startMode: 'direct',
		startUrl: '',
		enabled: true,
		slug: '',
		iconUrl: '',
		buttonColor: '',
		buttonText: ''
	};

	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let successMessage = $state('');
	let settings = $state<CategorySettings | null>(null);
	let providers = $state<LoginMethodExternalProvider[]>([]);
	let initialProvidersJson = $state('[]');
	let form = $state<LoginMethodExternalProvider>({ ...EMPTY_FORM });
	let editingIndex = $state<number | null>(null);
	let formError = $state('');

	const currentTenantId = $derived(settingsContext.tenantId || 'default');
	const canEdit = $derived(settingsContext.canEditAtCurrentScope());
	const hasChanges = $derived(JSON.stringify(providers) !== initialProvidersJson);

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
		formError = '';
		try {
			const response = await adminLoginMethodsAPI.get(currentTenantId);
			settings = response.settings;
			providers = response.providers;
			initialProvidersJson = JSON.stringify(response.providers);
			resetForm();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load login method settings';
		} finally {
			loading = false;
		}
	}

	function resetForm() {
		form = { ...EMPTY_FORM };
		editingIndex = null;
		formError = '';
	}

	function editProvider(index: number) {
		const provider = providers[index];
		if (!provider) return;
		form = { ...EMPTY_FORM, ...provider };
		editingIndex = index;
		formError = '';
	}

	function removeProvider(index: number) {
		providers = providers.filter((_, i) => i !== index);
		if (editingIndex === index) resetForm();
	}

	function duplicateProvider(index: number) {
		const provider = providers[index];
		if (!provider) return;
		const copy = {
			...provider,
			id: `${provider.id}-copy`,
			name: `${provider.name} Copy`
		};
		providers = [...providers.slice(0, index + 1), copy, ...providers.slice(index + 1)];
	}

	function setProviderType(type: LoginMethodProviderType) {
		form.type = type;
		if (type === 'saml') {
			form.startMode = 'saml_sp';
		} else if (type === 'oidc' || type === 'oauth2') {
			form.startMode = 'oauth_redirect';
		} else {
			form.startMode = 'direct';
		}
	}

	function validateProvider(provider: LoginMethodExternalProvider): string {
		if (!provider.id.trim()) return 'Provider ID is required.';
		if (!/^[a-zA-Z0-9:_-]+$/.test(provider.id.trim())) {
			return 'Provider ID can contain letters, numbers, colon, hyphen, and underscore.';
		}
		if (!provider.name.trim()) return 'Provider name is required.';
		if (!provider.startUrl.trim()) return 'Start URL is required.';
		if (provider.startUrl.startsWith('//')) return 'Start URL must not be protocol-relative.';
		try {
			const parsed = new URL(provider.startUrl, 'https://authrim.local');
			if (parsed.origin === 'https://authrim.local' && !provider.startUrl.startsWith('/')) {
				return 'Relative Start URL must start with /.';
			}
			if (parsed.origin !== 'https://authrim.local' && parsed.protocol !== 'https:') {
				return 'Absolute Start URL must use HTTPS.';
			}
		} catch {
			return 'Start URL is invalid.';
		}

		const duplicateIndex = providers.findIndex(
			(existing, index) => existing.id.trim() === provider.id.trim() && index !== editingIndex
		);
		if (duplicateIndex >= 0) return 'Provider ID must be unique.';
		return '';
	}

	function upsertProvider() {
		const normalized: LoginMethodExternalProvider = {
			...form,
			id: form.id.trim(),
			name: form.name.trim(),
			startUrl: form.startUrl.trim(),
			slug: form.slug?.trim() || undefined,
			iconUrl: form.iconUrl?.trim() || undefined,
			buttonColor: form.buttonColor?.trim() || undefined,
			buttonText: form.buttonText?.trim() || undefined
		};
		const validationError = validateProvider(normalized);
		if (validationError) {
			formError = validationError;
			return;
		}

		if (editingIndex === null) {
			providers = [...providers, normalized];
		} else {
			providers = providers.map((provider, index) => (index === editingIndex ? normalized : provider));
		}
		resetForm();
	}

	async function saveProviders() {
		if (!settings) return;
		error = '';
		successMessage = '';
		saving = true;
		try {
			const result = await adminLoginMethodsAPI.updateProviders(settings, providers, currentTenantId);
			settings = { ...settings, version: result.version };
			initialProvidersJson = JSON.stringify(providers);
			successMessage = 'Login method settings saved.';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save login method settings';
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>Login Methods - Authrim Admin</title>
</svelte:head>

<div class="page-shell">
	<header class="page-header">
		<div>
			<h1>Login Methods</h1>
			<p>Custom external login providers for tenant <code>{currentTenantId}</code></p>
		</div>
		<div class="actions">
			<button class="btn secondary" disabled={!hasChanges || saving} onclick={loadData}>Discard</button>
			<button class="btn primary" disabled={!canEdit || !hasChanges || saving} onclick={saveProviders}>
				{saving ? 'Saving...' : 'Save'}
			</button>
		</div>
	</header>

	{#if loading}
		<div class="state">Loading...</div>
	{:else}
		{#if error}
			<div class="alert error">{error}</div>
		{/if}
		{#if successMessage}
			<div class="alert success">{successMessage}</div>
		{/if}

		<section class="section">
			<div class="section-header">
				<h2>Configured Providers</h2>
				<span class="count">{providers.length}</span>
			</div>

			{#if providers.length === 0}
				<div class="empty">No custom providers configured.</div>
			{:else}
				<div class="provider-list">
					{#each providers as provider, index (provider.id)}
						<div class="provider-row">
							<div class="provider-main">
								<div class="provider-title">
									<span>{provider.name}</span>
									{#if !provider.enabled}
										<span class="badge muted">Disabled</span>
									{/if}
									<span class="badge">{provider.type}</span>
									<span class="badge">{provider.startMode}</span>
								</div>
								<div class="provider-meta">
									<code>{provider.id}</code>
									<span>{provider.startUrl}</span>
								</div>
							</div>
							<div class="row-actions">
								<button class="icon-btn" disabled={!canEdit} title="Edit" onclick={() => editProvider(index)}>
									<span class="i-ph-pencil-simple"></span>
								</button>
								<button
									class="icon-btn"
									disabled={!canEdit}
									title="Duplicate"
									onclick={() => duplicateProvider(index)}
								>
									<span class="i-ph-copy"></span>
								</button>
								<button class="icon-btn danger" disabled={!canEdit} title="Remove" onclick={() => removeProvider(index)}>
									<span class="i-ph-trash"></span>
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<section class="section">
			<div class="section-header">
				<h2>{editingIndex === null ? 'Add Provider' : 'Edit Provider'}</h2>
				{#if editingIndex !== null}
					<button class="btn secondary small" onclick={resetForm}>Cancel</button>
				{/if}
			</div>

			{#if formError}
				<div class="alert error">{formError}</div>
			{/if}

			<div class="form-grid">
				<label>
					<span>Provider ID</span>
					<input bind:value={form.id} disabled={!canEdit} placeholder="wallet-vp" />
				</label>
				<label>
					<span>Name</span>
					<input bind:value={form.name} disabled={!canEdit} placeholder="Wallet Presentation" />
				</label>
				<label>
					<span>Type</span>
					<select
						value={form.type}
						disabled={!canEdit}
						onchange={(event) => setProviderType(event.currentTarget.value as LoginMethodProviderType)}
					>
						<option value="vc">VC</option>
						<option value="custom">Custom</option>
						<option value="saml">SAML</option>
						<option value="oidc">OIDC</option>
						<option value="oauth2">OAuth2</option>
					</select>
				</label>
				<label>
					<span>Start Mode</span>
					<select bind:value={form.startMode} disabled={!canEdit}>
						<option value="direct">Direct</option>
						<option value="saml_sp">SAML SP</option>
						<option value="oauth_redirect">OAuth Redirect</option>
					</select>
				</label>
				<label class="wide">
					<span>Start URL</span>
					<input bind:value={form.startUrl} disabled={!canEdit} placeholder="/vp/login" />
				</label>
				<label>
					<span>Slug</span>
					<input bind:value={form.slug} disabled={!canEdit} placeholder="wallet" />
				</label>
				<label>
					<span>Button Text</span>
					<input bind:value={form.buttonText} disabled={!canEdit} placeholder="Continue with wallet" />
				</label>
				<label>
					<span>Icon URL</span>
					<input bind:value={form.iconUrl} disabled={!canEdit} placeholder="https://example.com/icon.png" />
				</label>
				<label>
					<span>Button Color</span>
					<input bind:value={form.buttonColor} disabled={!canEdit} placeholder="#2563eb" />
				</label>
				<label class="checkbox-label">
					<input type="checkbox" bind:checked={form.enabled} disabled={!canEdit} />
					<span>Enabled</span>
				</label>
			</div>

			<div class="form-actions">
				<button class="btn primary" disabled={!canEdit} onclick={upsertProvider}>
					{editingIndex === null ? 'Add Provider' : 'Update Provider'}
				</button>
			</div>
		</section>
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
	.provider-meta,
	.empty,
	.state {
		color: var(--color-text-muted, #6b7280);
	}

	.actions,
	.row-actions,
	.form-actions,
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

	.provider-list {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 8px;
		overflow: hidden;
	}

	.provider-row {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 16px;
		border-bottom: 1px solid var(--color-border, #e5e7eb);
	}

	.provider-row:last-child {
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
		font-weight: 600;
	}

	.provider-meta {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		font-size: 13px;
		word-break: break-all;
	}

	.form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text, #111827);
	}

	label.wide {
		grid-column: 1 / -1;
	}

	.checkbox-label {
		flex-direction: row;
		align-items: center;
		align-self: end;
		min-height: 40px;
	}

	input,
	select {
		width: 100%;
		min-height: 40px;
		border: 1px solid var(--color-border, #d1d5db);
		border-radius: 6px;
		padding: 8px 10px;
		background: var(--color-surface, #fff);
		color: var(--color-text, #111827);
	}

	input[type='checkbox'] {
		width: 18px;
		min-height: 18px;
	}

	.btn,
	.icon-btn {
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

	.btn.small {
		min-height: 32px;
	}

	.btn.primary {
		background: #111827;
		border-color: #111827;
		color: #fff;
	}

	.btn.secondary {
		background: transparent;
	}

	.icon-btn {
		width: 34px;
		height: 34px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.icon-btn.danger {
		color: #b91c1c;
	}

	button:disabled,
	input:disabled,
	select:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.badge,
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

	.badge.muted {
		background: #f3f4f6;
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
		.page-header,
		.provider-row {
			flex-direction: column;
		}

		.form-grid {
			grid-template-columns: 1fr;
		}

		.actions,
		.row-actions {
			justify-content: flex-start;
		}
	}
</style>
