<script lang="ts">
	import { onMount } from 'svelte';
	import {
		scopedSettingsAPI,
		SettingsConflictError,
		type CategorySettings
	} from '$lib/api/admin-settings';
	import { ToggleSwitch } from '$lib/components';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { tenantStore } from '$lib/stores/tenants.svelte';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import {
		buildDiscoveryMethodsValue,
		getMethodToggles,
		resolveEmailResolutionPolicy,
		type EmailResolutionPolicy
	} from '$lib/admin/tenant-discovery-settings';

	interface LoginEntryForm {
		mode: 'tenant_only' | 'discovery_optional' | 'discovery_required';
		emailResolutionPolicy: EmailResolutionPolicy;
		tenantCodeEnabled: boolean;
		tenantSlugEnabled: boolean;
		selectionPolicy: 'auto_if_single' | 'always_select' | 'select_if_multiple' | 'manual_only';
		allowManualTenantEntry: boolean;
		rememberLastTenant: boolean;
		redirectDefaultLoginToDiscovery: boolean;
	}

	interface DiscoveryUiForm {
		inheritFromLoginUi: boolean;
		theme: '' | 'light' | 'dark';
		variant: '' | 'beige' | 'blue-gray' | 'green' | 'brown' | 'navy' | 'slate';
		brandName: string;
		logoUrl: string;
		pageTitle: string;
		kickerText: string;
		titleText: string;
		subtitleText: string;
	}

	const LOGIN_ENTRY_CATEGORY = 'login-entry';
	const DISCOVERY_UI_CATEGORY = 'tenant-discovery-ui';

	let loading = $state(true);
	let pageError = $state('');

	let loginEntrySettings = $state<CategorySettings | null>(null);
	let commonEntrySettings = $state<CategorySettings | null>(null);
	let tenantUiSettings = $state<CategorySettings | null>(null);

	let behaviorForm = $state<LoginEntryForm | null>(null);
	let commonEntryForm = $state<DiscoveryUiForm | null>(null);
	let tenantUiForm = $state<DiscoveryUiForm | null>(null);

	let initialBehaviorValues = $state<Record<string, unknown> | null>(null);
	let initialCommonEntryValues = $state<Record<string, unknown> | null>(null);
	let initialTenantUiValues = $state<Record<string, unknown> | null>(null);

	let behaviorSaving = $state(false);
	let commonEntrySaving = $state(false);
	let tenantUiSaving = $state(false);

	let behaviorError = $state('');
	let commonEntryError = $state('');
	let tenantUiError = $state('');

	let behaviorSuccess = $state('');
	let commonEntrySuccess = $state('');
	let tenantUiSuccess = $state('');

	const currentTenantId = $derived(settingsContext.tenantId);
	const currentTenantName = $derived(
		settingsContext.availableTenants.find((tenant) => tenant.id === currentTenantId)?.name || currentTenantId
	);
	const singleTenantMode = $derived(tenantStore.singleTenantMode);
	const canEditTenant = $derived(settingsContext.getPermissionForScope('tenant', adminAuth.user?.roles ?? []) === 'edit');
	const canEditPlatform = $derived(
		settingsContext.getPermissionForScope('platform', adminAuth.user?.roles ?? []) === 'edit'
	);

	const hasBehaviorChanges = $derived(
		initialBehaviorValues ? JSON.stringify(buildBehaviorValues(behaviorForm)) !== JSON.stringify(initialBehaviorValues) : false
	);
	const hasCommonEntryChanges = $derived(
		initialCommonEntryValues
			? JSON.stringify(buildDiscoveryUiValues(commonEntryForm)) !== JSON.stringify(initialCommonEntryValues)
			: false
	);
	const hasTenantUiChanges = $derived(
		initialTenantUiValues
			? JSON.stringify(buildDiscoveryUiValues(tenantUiForm)) !== JSON.stringify(initialTenantUiValues)
			: false
	);

	let previousTenantId = $state('');

	onMount(async () => {
		await settingsContext.initialize();
		if (!tenantStore.loaded) {
			await tenantStore.load();
		}
		await loadPageData();
	});

	$effect(() => {
		if (!currentTenantId || loading) return;
		if (previousTenantId === currentTenantId) return;
		previousTenantId = currentTenantId;
		if (loginEntrySettings || tenantUiSettings) {
			loadPageData();
		}
	});

	function readString(values: Record<string, unknown>, key: string): string {
		const value = values[key];
		return typeof value === 'string' ? value : '';
	}

	function readBoolean(values: Record<string, unknown>, key: string): boolean {
		return values[key] === true;
	}

	function createBehaviorForm(settings: CategorySettings): LoginEntryForm {
		const toggles = getMethodToggles(settings.values['login-entry.discovery_methods']);
		return {
			mode:
				(settings.values['login-entry.mode'] as LoginEntryForm['mode']) ?? 'discovery_optional',
			emailResolutionPolicy: resolveEmailResolutionPolicy(
				settings.values['login-entry.discovery_methods'],
				settings.values['login-entry.email_resolution_policy']
			),
			tenantCodeEnabled: toggles.tenantCodeEnabled,
			tenantSlugEnabled: toggles.tenantSlugEnabled,
			selectionPolicy:
				(settings.values['login-entry.selection_policy'] as LoginEntryForm['selectionPolicy']) ??
				'select_if_multiple',
			allowManualTenantEntry: readBoolean(
				settings.values,
				'login-entry.allow_manual_tenant_entry'
			),
			rememberLastTenant: readBoolean(settings.values, 'login-entry.remember_last_tenant'),
			redirectDefaultLoginToDiscovery: readBoolean(
				settings.values,
				'login-entry.redirect_default_login_to_discovery'
			)
		};
	}

	function createDiscoveryUiForm(settings: CategorySettings): DiscoveryUiForm {
		return {
			inheritFromLoginUi: readBoolean(settings.values, 'tenant-discovery-ui.inherit_from_login_ui'),
			theme: (readString(settings.values, 'tenant-discovery-ui.theme') as DiscoveryUiForm['theme']) || '',
			variant:
				(readString(settings.values, 'tenant-discovery-ui.variant') as DiscoveryUiForm['variant']) || '',
			brandName: readString(settings.values, 'tenant-discovery-ui.brand_name'),
			logoUrl: readString(settings.values, 'tenant-discovery-ui.logo_url'),
			pageTitle: readString(settings.values, 'tenant-discovery-ui.page_title'),
			kickerText: readString(settings.values, 'tenant-discovery-ui.kicker_text'),
			titleText: readString(settings.values, 'tenant-discovery-ui.title_text'),
			subtitleText: readString(settings.values, 'tenant-discovery-ui.subtitle_text')
		};
	}

	function buildBehaviorValues(form: LoginEntryForm | null): Record<string, unknown> {
		if (!form) return {};
		return {
			'login-entry.mode': form.mode,
			'login-entry.discovery_methods': buildDiscoveryMethodsValue({
				emailResolutionPolicy: form.emailResolutionPolicy,
				tenantCodeEnabled: form.tenantCodeEnabled,
				tenantSlugEnabled: form.tenantSlugEnabled
			}),
			'login-entry.email_resolution_policy': form.emailResolutionPolicy,
			'login-entry.selection_policy': form.selectionPolicy,
			'login-entry.allow_manual_tenant_entry': form.allowManualTenantEntry,
			'login-entry.remember_last_tenant': form.rememberLastTenant,
			'login-entry.redirect_default_login_to_discovery': form.redirectDefaultLoginToDiscovery
		};
	}

	function buildDiscoveryUiValues(form: DiscoveryUiForm | null): Record<string, unknown> {
		if (!form) return {};
		return {
			'tenant-discovery-ui.inherit_from_login_ui': form.inheritFromLoginUi,
			'tenant-discovery-ui.theme': form.theme,
			'tenant-discovery-ui.variant': form.variant,
			'tenant-discovery-ui.brand_name': form.brandName.trim(),
			'tenant-discovery-ui.logo_url': form.logoUrl.trim(),
			'tenant-discovery-ui.page_title': form.pageTitle.trim(),
			'tenant-discovery-ui.kicker_text': form.kickerText.trim(),
			'tenant-discovery-ui.title_text': form.titleText.trim(),
			'tenant-discovery-ui.subtitle_text': form.subtitleText.trim()
		};
	}

	function diffValues(
		current: Record<string, unknown>,
		initial: Record<string, unknown>
	): Record<string, unknown> {
		const diff: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(current)) {
			if (JSON.stringify(value) !== JSON.stringify(initial[key])) {
				diff[key] = value;
			}
		}
		return diff;
	}

	async function loadPageData() {
		loading = true;
		pageError = '';
		behaviorError = '';
		commonEntryError = '';
		tenantUiError = '';

		try {
			const tenantId = settingsContext.resolveTenantId(currentTenantId);
			const [loginEntryResult, tenantUiResult] = await Promise.all([
				scopedSettingsAPI.getSettingsForScope(LOGIN_ENTRY_CATEGORY, { level: 'tenant', tenantId }),
				scopedSettingsAPI.getSettingsForScope(DISCOVERY_UI_CATEGORY, { level: 'tenant', tenantId })
			]);

			loginEntrySettings = loginEntryResult;
			tenantUiSettings = tenantUiResult;
			behaviorForm = createBehaviorForm(loginEntryResult);
			tenantUiForm = createDiscoveryUiForm(tenantUiResult);
			initialBehaviorValues = buildBehaviorValues(behaviorForm);
			initialTenantUiValues = buildDiscoveryUiValues(tenantUiForm);

			if (!singleTenantMode) {
				try {
					const platformResult = await scopedSettingsAPI.getSettingsForScope(DISCOVERY_UI_CATEGORY, {
						level: 'platform'
					});
					commonEntrySettings = platformResult;
					commonEntryForm = createDiscoveryUiForm(platformResult);
					initialCommonEntryValues = buildDiscoveryUiValues(commonEntryForm);
					commonEntryError = '';
				} catch (err) {
					commonEntrySettings = null;
					commonEntryForm = null;
					initialCommonEntryValues = null;
					commonEntryError =
						err instanceof Error ? err.message : 'Failed to load common entry screen settings';
				}
			} else {
				commonEntrySettings = null;
				commonEntryForm = null;
				initialCommonEntryValues = null;
			}
		} catch (err) {
			pageError = err instanceof Error ? err.message : 'Failed to load tenant discovery settings';
		} finally {
			loading = false;
		}
	}

	function clearMessage(section: 'behavior' | 'common' | 'tenant') {
		if (section === 'behavior') {
			behaviorSuccess = '';
			return;
		}
		if (section === 'common') {
			commonEntrySuccess = '';
			return;
		}
		tenantUiSuccess = '';
	}

	async function saveBehavior() {
		if (!loginEntrySettings || !behaviorForm) return;
		const set = diffValues(buildBehaviorValues(behaviorForm), initialBehaviorValues ?? {});
		if (Object.keys(set).length === 0) return;

		behaviorSaving = true;
		behaviorError = '';
		clearMessage('behavior');

		try {
			await scopedSettingsAPI.updateSettingsForScope(
				LOGIN_ENTRY_CATEGORY,
				{ level: 'tenant', tenantId: settingsContext.resolveTenantId(currentTenantId) },
				{ ifMatch: loginEntrySettings.version, set }
			);
			behaviorSuccess = 'Discovery behavior saved';
			await loadPageData();
		} catch (err) {
			behaviorError =
				err instanceof SettingsConflictError
					? 'Settings were modified by another user. Reload and try again.'
					: err instanceof Error
						? err.message
						: 'Failed to save discovery behavior';
		} finally {
			behaviorSaving = false;
		}
	}

	async function saveCommonEntryUi() {
		if (!commonEntrySettings || !commonEntryForm) return;
		const set = diffValues(buildDiscoveryUiValues(commonEntryForm), initialCommonEntryValues ?? {});
		if (Object.keys(set).length === 0) return;

		commonEntrySaving = true;
		commonEntryError = '';
		clearMessage('common');

		try {
			await scopedSettingsAPI.updateSettingsForScope(
				DISCOVERY_UI_CATEGORY,
				{ level: 'platform' },
				{ ifMatch: commonEntrySettings.version, set }
			);
			commonEntrySuccess = 'Common entry screen saved';
			await loadPageData();
		} catch (err) {
			commonEntryError =
				err instanceof SettingsConflictError
					? 'Settings were modified by another user. Reload and try again.'
					: err instanceof Error
						? err.message
						: 'Failed to save common entry screen';
		} finally {
			commonEntrySaving = false;
		}
	}

	async function saveTenantUi() {
		if (!tenantUiSettings || !tenantUiForm) return;
		const set = diffValues(buildDiscoveryUiValues(tenantUiForm), initialTenantUiValues ?? {});
		if (Object.keys(set).length === 0) return;

		tenantUiSaving = true;
		tenantUiError = '';
		clearMessage('tenant');

		try {
			await scopedSettingsAPI.updateSettingsForScope(
				DISCOVERY_UI_CATEGORY,
				{ level: 'tenant', tenantId: settingsContext.resolveTenantId(currentTenantId) },
				{ ifMatch: tenantUiSettings.version, set }
			);
			tenantUiSuccess = 'Tenant discovery screen saved';
			await loadPageData();
		} catch (err) {
			tenantUiError =
				err instanceof SettingsConflictError
					? 'Settings were modified by another user. Reload and try again.'
					: err instanceof Error
						? err.message
						: 'Failed to save tenant discovery screen';
		} finally {
			tenantUiSaving = false;
		}
	}
</script>

<svelte:head>
	<title>Tenant Discovery - Admin</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">Tenant Discovery</h1>
			<p class="page-description">
				Configure tenant resolution behavior and customize the discovery screen.
			</p>
		</div>
	</div>

	{#if loading}
		<section class="panel">
			<p>Loading tenant discovery settings...</p>
		</section>
	{:else if pageError}
		<section class="panel">
			<div class="alert alert-error">{pageError}</div>
		</section>
	{:else}
		<section class="panel">
			<div class="section-header">
				<div>
					<h2>Discovery Behavior</h2>
					<p>Controls how this tenant is resolved before login.</p>
				</div>
				<a class="subtle-link" href={`/admin/tenants/${currentTenantId}`}>Open Tenant Details</a>
			</div>

			{#if behaviorError}
				<div class="alert alert-error">{behaviorError}</div>
			{/if}
			{#if behaviorSuccess}
				<div class="alert alert-success">{behaviorSuccess}</div>
			{/if}

			{#if behaviorForm}
				<div class="form-grid">
					<div class="form-group">
						<label for="mode">Entry Mode</label>
						<select id="mode" bind:value={behaviorForm.mode} disabled={!canEditTenant || behaviorSaving}>
							<option value="tenant_only">tenant_only</option>
							<option value="discovery_optional">discovery_optional</option>
							<option value="discovery_required">discovery_required</option>
						</select>
					</div>

					<div class="form-group">
						<label for="email-policy">Email Resolution</label>
						<select
							id="email-policy"
							bind:value={behaviorForm.emailResolutionPolicy}
							disabled={!canEditTenant || behaviorSaving}
						>
							<option value="exact_email_then_domain">Check exact email, then domain fallback</option>
							<option value="exact_email_only">Check exact email only</option>
							<option value="disabled">Do not use email or domain discovery</option>
						</select>
					</div>

					<div class="form-group">
						<label for="selection-policy">Selection Policy</label>
						<select
							id="selection-policy"
							bind:value={behaviorForm.selectionPolicy}
							disabled={!canEditTenant || behaviorSaving}
						>
							<option value="auto_if_single">auto_if_single</option>
							<option value="always_select">always_select</option>
							<option value="select_if_multiple">select_if_multiple</option>
							<option value="manual_only">manual_only</option>
						</select>
					</div>
				</div>

				<div class="methods-card">
					<h3>Enabled Manual Discovery Methods</h3>
					<div class="toggle-row">
						<div>
							<strong>Tenant code</strong>
							<p>Allow users to identify the tenant by tenant code.</p>
						</div>
						<ToggleSwitch
							id="tenant-code-enabled"
							checked={behaviorForm.tenantCodeEnabled}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.tenantCodeEnabled = value;
							}}
						/>
					</div>
					<div class="toggle-row">
						<div>
							<strong>Tenant slug</strong>
							<p>Allow users to identify the tenant by tenant slug.</p>
						</div>
						<ToggleSwitch
							id="tenant-slug-enabled"
							checked={behaviorForm.tenantSlugEnabled}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.tenantSlugEnabled = value;
							}}
						/>
					</div>
				</div>

				<div class="toggle-list">
					<div class="toggle-row">
						<div>
							<strong>Allow manual tenant entry</strong>
							<p>Show manual entry fallback when automatic discovery cannot resolve a tenant.</p>
						</div>
						<ToggleSwitch
							id="allow-manual-entry"
							checked={behaviorForm.allowManualTenantEntry}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.allowManualTenantEntry = value;
							}}
						/>
					</div>
					<div class="toggle-row">
						<div>
							<strong>Remember last tenant</strong>
							<p>Remember the tenant that was resolved most recently for this browser.</p>
						</div>
						<ToggleSwitch
							id="remember-last-tenant"
							checked={behaviorForm.rememberLastTenant}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.rememberLastTenant = value;
							}}
						/>
					</div>
					<div class="toggle-row">
						<div>
							<strong>Redirect default login to discovery</strong>
							<p>Redirect common-entry `/login` requests to `/discover` when appropriate.</p>
						</div>
						<ToggleSwitch
							id="redirect-default-login"
							checked={behaviorForm.redirectDefaultLoginToDiscovery}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.redirectDefaultLoginToDiscovery = value;
							}}
						/>
					</div>
				</div>

				<div class="actions">
					<button class="btn btn-primary" onclick={saveBehavior} disabled={!canEditTenant || !hasBehaviorChanges || behaviorSaving}>
						{#if behaviorSaving}Saving...{:else}Save Discovery Behavior{/if}
					</button>
				</div>
			{/if}
		</section>

		{#if !singleTenantMode}
			<section class="panel">
				<div class="section-header">
					<div>
						<h2>Common Entry Screen</h2>
						<p>Shared discovery screen shown on the common multi-tenant host before a tenant is resolved.</p>
					</div>
				</div>

				{#if commonEntryError}
					<div class="alert alert-error">{commonEntryError}</div>
				{/if}
				{#if commonEntrySuccess}
					<div class="alert alert-success">{commonEntrySuccess}</div>
				{/if}

				{#if commonEntryForm}
					<div class="form-grid two-column">
						<div class="form-group">
							<label for="common-inherit">Inherit from Login UI</label>
							<ToggleSwitch
								id="common-inherit"
								checked={commonEntryForm.inheritFromLoginUi}
								disabled={!canEditPlatform || commonEntrySaving}
								onchange={(value) => {
									if (commonEntryForm) commonEntryForm.inheritFromLoginUi = value;
								}}
							/>
						</div>
						<div class="form-group">
							<label for="common-theme">Theme</label>
							<select id="common-theme" bind:value={commonEntryForm.theme} disabled={!canEditPlatform || commonEntrySaving}>
								<option value="">Inherit / default</option>
								<option value="light">light</option>
								<option value="dark">dark</option>
							</select>
						</div>
						<div class="form-group">
							<label for="common-variant">Variant</label>
							<select id="common-variant" bind:value={commonEntryForm.variant} disabled={!canEditPlatform || commonEntrySaving}>
								<option value="">Inherit / default</option>
								<option value="beige">beige</option>
								<option value="blue-gray">blue-gray</option>
								<option value="green">green</option>
								<option value="brown">brown</option>
								<option value="navy">navy</option>
								<option value="slate">slate</option>
							</select>
						</div>
						<div class="form-group">
							<label for="common-brand-name">Brand Name</label>
							<input id="common-brand-name" type="text" bind:value={commonEntryForm.brandName} disabled={!canEditPlatform || commonEntrySaving} />
						</div>
						<div class="form-group full-width">
							<label for="common-logo-url">Logo URL</label>
							<input id="common-logo-url" type="url" bind:value={commonEntryForm.logoUrl} disabled={!canEditPlatform || commonEntrySaving} />
						</div>
						<div class="form-group full-width">
							<label for="common-page-title">Page Title</label>
							<input id="common-page-title" type="text" bind:value={commonEntryForm.pageTitle} disabled={!canEditPlatform || commonEntrySaving} />
						</div>
						<div class="form-group full-width">
							<label for="common-kicker">Kicker Text</label>
							<input id="common-kicker" type="text" bind:value={commonEntryForm.kickerText} disabled={!canEditPlatform || commonEntrySaving} />
						</div>
						<div class="form-group full-width">
							<label for="common-title">Title Text</label>
							<input id="common-title" type="text" bind:value={commonEntryForm.titleText} disabled={!canEditPlatform || commonEntrySaving} />
						</div>
						<div class="form-group full-width">
							<label for="common-subtitle">Subtitle Text</label>
							<textarea id="common-subtitle" rows="3" bind:value={commonEntryForm.subtitleText} disabled={!canEditPlatform || commonEntrySaving}></textarea>
						</div>
					</div>
					<div class="actions">
						<button class="btn btn-primary" onclick={saveCommonEntryUi} disabled={!canEditPlatform || !hasCommonEntryChanges || commonEntrySaving}>
							{#if commonEntrySaving}Saving...{:else}Save Common Entry Screen{/if}
						</button>
					</div>
				{/if}
			</section>
		{/if}

		<section class="panel">
			<div class="section-header">
				<div>
					<h2>Tenant Override Screen</h2>
					<p>Discovery screen overrides for <strong>{currentTenantName}</strong>.</p>
				</div>
			</div>

			{#if tenantUiError}
				<div class="alert alert-error">{tenantUiError}</div>
			{/if}
			{#if tenantUiSuccess}
				<div class="alert alert-success">{tenantUiSuccess}</div>
			{/if}

			{#if tenantUiForm}
				<div class="form-grid two-column">
					<div class="form-group">
						<label for="tenant-inherit">Inherit from Login UI</label>
						<ToggleSwitch
							id="tenant-inherit"
							checked={tenantUiForm.inheritFromLoginUi}
							disabled={!canEditTenant || tenantUiSaving}
							onchange={(value) => {
								if (tenantUiForm) tenantUiForm.inheritFromLoginUi = value;
							}}
						/>
					</div>
					<div class="form-group">
						<label for="tenant-theme">Theme</label>
						<select id="tenant-theme" bind:value={tenantUiForm.theme} disabled={!canEditTenant || tenantUiSaving}>
							<option value="">Inherit / default</option>
							<option value="light">light</option>
							<option value="dark">dark</option>
						</select>
					</div>
					<div class="form-group">
						<label for="tenant-variant">Variant</label>
						<select id="tenant-variant" bind:value={tenantUiForm.variant} disabled={!canEditTenant || tenantUiSaving}>
							<option value="">Inherit / default</option>
							<option value="beige">beige</option>
							<option value="blue-gray">blue-gray</option>
							<option value="green">green</option>
							<option value="brown">brown</option>
							<option value="navy">navy</option>
							<option value="slate">slate</option>
						</select>
					</div>
					<div class="form-group">
						<label for="tenant-brand-name">Brand Name</label>
						<input id="tenant-brand-name" type="text" bind:value={tenantUiForm.brandName} disabled={!canEditTenant || tenantUiSaving} />
					</div>
					<div class="form-group full-width">
						<label for="tenant-logo-url">Logo URL</label>
						<input id="tenant-logo-url" type="url" bind:value={tenantUiForm.logoUrl} disabled={!canEditTenant || tenantUiSaving} />
					</div>
					<div class="form-group full-width">
						<label for="tenant-page-title">Page Title</label>
						<input id="tenant-page-title" type="text" bind:value={tenantUiForm.pageTitle} disabled={!canEditTenant || tenantUiSaving} />
					</div>
					<div class="form-group full-width">
						<label for="tenant-kicker">Kicker Text</label>
						<input id="tenant-kicker" type="text" bind:value={tenantUiForm.kickerText} disabled={!canEditTenant || tenantUiSaving} />
					</div>
					<div class="form-group full-width">
						<label for="tenant-title">Title Text</label>
						<input id="tenant-title" type="text" bind:value={tenantUiForm.titleText} disabled={!canEditTenant || tenantUiSaving} />
					</div>
					<div class="form-group full-width">
						<label for="tenant-subtitle">Subtitle Text</label>
						<textarea id="tenant-subtitle" rows="3" bind:value={tenantUiForm.subtitleText} disabled={!canEditTenant || tenantUiSaving}></textarea>
					</div>
				</div>
				<div class="actions">
					<button class="btn btn-primary" onclick={saveTenantUi} disabled={!canEditTenant || !hasTenantUiChanges || tenantUiSaving}>
						{#if tenantUiSaving}Saving...{:else}Save Tenant Override{/if}
					</button>
				</div>
			{/if}
		</section>
	{/if}
</div>

<style>
	.section-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.section-header h2,
	.methods-card h3 {
		margin: 0;
	}

	.section-header p,
	.methods-card p {
		margin: 0.25rem 0 0;
		color: var(--text-secondary);
	}

	.subtle-link {
		font-size: 0.875rem;
	}

	.form-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 1rem;
	}

	.two-column {
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
	}

	.form-group {
		display: grid;
		gap: 0.4rem;
	}

	.form-group.full-width {
		grid-column: 1 / -1;
	}

	label {
		font-weight: 600;
	}

	input,
	select,
	textarea {
		width: 100%;
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 0.8rem 0.9rem;
		background: var(--bg-card);
		color: var(--text-primary);
	}

	.methods-card,
	.toggle-list {
		display: grid;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.methods-card {
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: 16px;
		background: var(--bg-glass);
	}

	.toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.9rem 0;
		border-bottom: 1px solid var(--border);
	}

	.toggle-row:last-child {
		border-bottom: none;
	}

	.toggle-row p {
		font-size: 0.9rem;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 1rem;
	}

	.alert {
		margin-bottom: 1rem;
		padding: 0.9rem 1rem;
		border-radius: 12px;
	}

	.alert-error {
		background: rgba(239, 68, 68, 0.1);
		color: #b91c1c;
	}

	.alert-success {
		background: rgba(16, 185, 129, 0.12);
		color: #047857;
	}

	@media (max-width: 700px) {
		.section-header,
		.toggle-row {
			flex-direction: column;
			align-items: flex-start;
		}

		.actions {
			justify-content: stretch;
		}

		.actions .btn {
			width: 100%;
		}
	}
</style>
