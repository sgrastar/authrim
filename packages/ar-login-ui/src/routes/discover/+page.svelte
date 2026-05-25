<script lang="ts">
	import { getDefaultDiscoveryMode, getInteractiveDiscoveryMethods } from '$lib/discovery-ui';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { themeStore } from '$lib/stores/theme.svelte';
	import { isValidImageUrl } from '$lib/utils/url-validation';
	import { LL } from '$i18n/i18n-svelte';
	import { onMount } from 'svelte';

	interface DiscoveryCandidate {
		tenant_id: string;
		tenant_code: string;
		display_name: string;
		logo_url?: string | null;
		login_url: string;
		source: string;
	}

	interface PageData {
		config: {
			config: {
				mode: 'tenant_only' | 'discovery_optional' | 'discovery_required';
				discovery_methods: string[];
				email_resolution_policy: 'exact_email_then_domain' | 'exact_email_only' | 'disabled';
				selection_policy: 'auto_if_single' | 'always_select' | 'select_if_multiple' | 'manual_only';
				allow_manual_tenant_entry: boolean;
				require_common_discovery_before_login: boolean;
				redirect_tenant_discover_to_common_entry: boolean;
			};
			ui: {
				theme: string;
				variant: string;
				brand_name: string;
				logo_url: string | null;
				page_title: string;
				kicker_text: string;
				title_text: string;
				subtitle_text: string;
			};
			is_common_entry_host: boolean;
			single_tenant_mode: boolean;
			wayf_candidates?: DiscoveryCandidate[];
		};
		rememberedCandidate: DiscoveryCandidate | null;
		inviteToken?: string | null;
		inviteErrorCode?: string | null;
		expectedTenantId?: string | null;
		returnTo?: string | null;
		loginHint?: string | null;
	}

	interface ActionData {
		mode?: string;
		value?: string;
		loginHint?: string;
		errorCode?: string;
		candidates?: DiscoveryCandidate[];
		result?: 'multiple' | 'manual_required' | 'not_found';
	}

	let { data, form }: { data: PageData; form?: ActionData } = $props();

	const methods = $derived(data.config.config.discovery_methods);
	const interactiveMethods = $derived(
		getInteractiveDiscoveryMethods(methods, data.config.config.selection_policy)
	);
	const wayfCandidates = $derived(data.config.wayf_candidates || []);
	const wayfOnly = $derived(interactiveMethods.length === 1 && interactiveMethods[0] === 'wayf');
	const ui = $derived(data.config.ui);
	const rememberedCandidate = $derived(data.rememberedCandidate);
	const submittedMode = $derived(form?.mode);
	const submittedValue = $derived(form?.value || '');
	const showTenantChooser = $derived(
		!(data.config.is_common_entry_host && data.config.config.mode === 'tenant_only')
	);

	let selectedMode = $derived(submittedMode || getDefaultDiscoveryMode(interactiveMethods));
	let value = $derived(submittedValue);

	const candidates = $derived(form?.candidates || []);
	const loginHint = $derived(form?.loginHint || data.loginHint || '');
	const errorCode = $derived(form?.errorCode || data.inviteErrorCode || '');
	const errorMessage = $derived(errorCode ? getErrorMessage(errorCode) : '');
	const pageTitle = $derived(ui.page_title || $LL.discover_pageTitle());
	const kickerText = $derived(ui.kicker_text || $LL.discover_kicker());
	const titleText = $derived(ui.title_text || $LL.discover_title());
	const subtitleText = $derived(ui.subtitle_text || $LL.discover_subtitle());
	const brandName = $derived(ui.brand_name || $LL.app_title());

	let discoverySubmitting = $state(false);

	onMount(() => {
		themeStore.setTenantDefaults(ui.theme, ui.variant);
	});

	function modeLabel(mode: string): string {
		switch (mode) {
			case 'email':
				return $LL.discover_method_email();
			case 'tenant_code':
				return $LL.discover_method_tenantCode();
			case 'tenant_slug':
				return $LL.discover_method_tenantSlug();
			case 'wayf':
				return $LL.discover_selectTenant();
			default:
				return $LL.discover_method_tenantCode();
		}
	}

	function placeholderFor(mode: string): string {
		switch (mode) {
			case 'email':
				return $LL.discover_placeholder_email();
			case 'tenant_code':
				return $LL.discover_placeholder_tenantCode();
			case 'tenant_slug':
				return $LL.discover_placeholder_tenantSlug();
			default:
				return '';
		}
	}

	function getErrorMessage(code: string): string {
		switch (code) {
			case 'email_not_found':
				return $LL.discover_error_emailNotFound();
			case 'email_domain_not_found':
				return $LL.discover_error_emailDomainNotFound();
			case 'tenant_code_not_found':
				return $LL.discover_error_tenantCodeNotFound();
			case 'tenant_slug_not_found':
				return $LL.discover_error_tenantSlugNotFound();
			case 'invitation_not_found':
				return $LL.discover_error_invitationNotFound();
			case 'app_hint_not_found':
				return $LL.discover_error_appHintNotFound();
			case 'value_required':
				return $LL.discover_error_valueRequired();
			case 'manual_required':
				return $LL.discover_error_manualRequired();
			case 'invitation_unresolved':
				return $LL.discover_error_invitationUnresolved();
			case 'resolve_failed':
				return $LL.discover_error_resolveFailed();
			default:
				return $LL.discover_error_notFound();
		}
	}

	function loginPath(url: string): string {
		return new URL(url).host;
	}

	function rememberedCandidateHref(candidate: DiscoveryCandidate): string {
		return candidate.login_url;
	}

	function shouldPostCandidateSelection(): boolean {
		return data.config.is_common_entry_host;
	}

	function shouldPostRememberedCandidate(): boolean {
		return data.config.is_common_entry_host;
	}

	function handleDiscoverySubmit() {
		discoverySubmitting = true;
	}
</script>

<svelte:head>
	<title>{pageTitle}</title>
</svelte:head>

<div class="discover-page">
	<div class="discover-card">
		<LanguageSwitcher />

		<div class="discover-brand">
			{#if ui.logo_url && isValidImageUrl(ui.logo_url)}
				<img src={ui.logo_url} alt={brandName} class="discover-brand-logo" />
			{/if}
			<span class="discover-brand-name">{brandName}</span>
		</div>

		<div class="discover-header">
			<p class="discover-kicker">{kickerText}</p>
			<h1>{titleText}</h1>
			<p>{subtitleText}</p>
		</div>

		{#if data.config.config.mode === 'tenant_only'}
			<div class="notice">
				{$LL.discover_notice_disabled()}
			</div>
		{/if}

		{#if data.config.config.selection_policy === 'manual_only'}
			<div class="notice">
				{$LL.discover_notice_manualOnly()}
			</div>
		{/if}

		{#if errorMessage}
			<div class="alert alert-error">{errorMessage}</div>
		{/if}

		{#if showTenantChooser && rememberedCandidate && !wayfOnly}
			<div class="recent-tenant">
				<p class="recent-label">{$LL.discover_recentTenant()}</p>
				{#if shouldPostRememberedCandidate()}
					<form
						method="POST"
						action="/discover?/resolve"
						class="tenant-option-form"
						onsubmit={handleDiscoverySubmit}
					>
						{#if data.inviteToken}
							<input type="hidden" name="invite_token" value={data.inviteToken} />
						{/if}
						{#if data.expectedTenantId}
							<input type="hidden" name="expected_tenant_id" value={data.expectedTenantId} />
						{/if}
						{#if data.returnTo}
							<input type="hidden" name="return_to" value={data.returnTo} />
						{/if}
						{#if loginHint}
							<input type="hidden" name="login_hint" value={loginHint} />
						{/if}
						<input type="hidden" name="mode" value="tenant_code" />
						<input type="hidden" name="value" value={rememberedCandidate.tenant_code} />
						<button
							type="submit"
							class="tenant-option tenant-option-button"
							disabled={discoverySubmitting}
						>
							<div class="tenant-branding">
								{#if rememberedCandidate.logo_url}
									<img src={rememberedCandidate.logo_url} alt={rememberedCandidate.display_name} />
								{/if}
								<div>
									<strong>{rememberedCandidate.display_name}</strong>
									<p>{rememberedCandidate.tenant_code}</p>
								</div>
							</div>
							<span>{loginPath(rememberedCandidate.login_url)}</span>
						</button>
					</form>
				{:else}
					<a class="tenant-option" href={rememberedCandidateHref(rememberedCandidate)}>
						<div class="tenant-branding">
							{#if rememberedCandidate.logo_url}
								<img src={rememberedCandidate.logo_url} alt={rememberedCandidate.display_name} />
							{/if}
							<div>
								<strong>{rememberedCandidate.display_name}</strong>
								<p>{rememberedCandidate.tenant_code}</p>
							</div>
						</div>
						<span>{loginPath(rememberedCandidate.login_url)}</span>
					</a>
				{/if}
			</div>
		{/if}

		{#if showTenantChooser}
			<form
				method="POST"
				action="/discover?/resolve"
				class="discover-form"
				onsubmit={handleDiscoverySubmit}
			>
				{#if data.inviteToken}
					<input type="hidden" name="invite_token" value={data.inviteToken} />
				{/if}
				{#if data.expectedTenantId}
					<input type="hidden" name="expected_tenant_id" value={data.expectedTenantId} />
				{/if}
				{#if data.returnTo}
					<input type="hidden" name="return_to" value={data.returnTo} />
				{/if}
				{#if loginHint}
					<input type="hidden" name="login_hint" value={loginHint} />
				{/if}

				{#if interactiveMethods.length > 1}
					<div class="form-group">
						<label for="mode">{$LL.discover_methodLabel()}</label>
						<select id="mode" name="mode" bind:value={selectedMode}>
							{#if interactiveMethods.includes('email_domain')}
								<option value="email">{$LL.discover_method_email()}</option>
							{/if}
							{#if interactiveMethods.includes('tenant_code')}
								<option value="tenant_code">{$LL.discover_method_tenantCode()}</option>
							{/if}
							{#if interactiveMethods.includes('tenant_slug')}
								<option value="tenant_slug">{$LL.discover_method_tenantSlug()}</option>
							{/if}
							{#if interactiveMethods.includes('wayf')}
								<option value="wayf">WAYF</option>
							{/if}
						</select>
					</div>
				{:else}
					<input type="hidden" name="mode" value={getDefaultDiscoveryMode(interactiveMethods)} />
				{/if}

				{#if selectedMode === 'wayf'}
					<div class="form-group">
						<label for="value">{wayfOnly ? $LL.discover_selectTenant() : modeLabel(selectedMode)}</label>
						<select id="value" name="value" bind:value required>
							<option value="" disabled>{$LL.discover_selectTenant()}</option>
							{#each wayfCandidates as candidate (candidate.tenant_id)}
								<option value={candidate.tenant_id}>{candidate.display_name}</option>
							{/each}
						</select>
					</div>
				{:else}
					<div class="form-group">
						<label for="value">{modeLabel(selectedMode)}</label>
						<input
							id="value"
							name="value"
							type={selectedMode === 'email' ? 'email' : 'text'}
							bind:value
							placeholder={placeholderFor(selectedMode)}
							required
						/>
					</div>
				{/if}

				<button
					type="submit"
					class="primary-button"
					disabled={discoverySubmitting || (selectedMode === 'wayf' && wayfCandidates.length === 0)}
				>
					{#if discoverySubmitting}
						<span class="button-spinner" aria-hidden="true"></span>
					{/if}
					{$LL.common_continue()}
				</button>
			</form>
		{/if}

		{#if showTenantChooser && candidates.length > 0}
			<div class="candidate-list">
				<h2>{$LL.discover_selectTenant()}</h2>
				{#each candidates as candidate (candidate.tenant_id)}
					{#if shouldPostCandidateSelection()}
						<form
							method="POST"
							action="/discover?/resolve"
							class="tenant-option-form"
							onsubmit={handleDiscoverySubmit}
						>
							{#if data.inviteToken}
								<input type="hidden" name="invite_token" value={data.inviteToken} />
							{/if}
							{#if data.expectedTenantId}
								<input type="hidden" name="expected_tenant_id" value={data.expectedTenantId} />
							{/if}
							{#if data.returnTo}
								<input type="hidden" name="return_to" value={data.returnTo} />
							{/if}
							{#if loginHint}
								<input type="hidden" name="login_hint" value={loginHint} />
							{/if}
							<input type="hidden" name="mode" value="tenant_code" />
							<input type="hidden" name="value" value={candidate.tenant_code} />
							<button
								type="submit"
								class="tenant-option tenant-option-button"
								disabled={discoverySubmitting}
							>
								<div class="tenant-branding">
									{#if candidate.logo_url}
										<img src={candidate.logo_url} alt={candidate.display_name} />
									{/if}
									<div>
										<strong>{candidate.display_name}</strong>
										<p>{candidate.tenant_code}</p>
									</div>
								</div>
								<span>{loginPath(candidate.login_url)}</span>
							</button>
						</form>
					{:else}
						<a class="tenant-option" href={candidate.login_url}>
							<div class="tenant-branding">
								{#if candidate.logo_url}
									<img src={candidate.logo_url} alt={candidate.display_name} />
								{/if}
								<div>
									<strong>{candidate.display_name}</strong>
									<p>{candidate.tenant_code}</p>
								</div>
							</div>
							<span>{loginPath(candidate.login_url)}</span>
						</a>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.discover-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem 1rem;
		background:
			radial-gradient(circle at top left, rgba(14, 165, 233, 0.14), transparent 28%),
			radial-gradient(circle at bottom right, rgba(245, 158, 11, 0.12), transparent 24%),
			var(--bg-page);
	}

	.discover-card {
		width: min(100%, 680px);
		position: relative;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 24px;
		padding: 4.5rem 2rem 2rem;
		box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.discover-card :global(.auth-topbar) {
		top: 1.25rem;
		right: 1.25rem;
	}

	.discover-brand {
		display: flex;
		align-items: center;
		gap: 0.85rem;
	}

	.discover-brand-logo {
		width: 48px;
		height: 48px;
		object-fit: cover;
		border-radius: 14px;
		border: 1px solid var(--border);
		background: var(--bg-input, var(--bg-page));
	}

	.discover-brand-name {
		font-family: var(--font-display);
		font-size: 1rem;
		font-weight: 700;
		color: var(--text-primary);
	}

	.discover-header h1 {
		margin: 0.25rem 0 0.5rem;
		font-size: clamp(1.8rem, 4vw, 2.4rem);
		color: var(--text-primary);
	}

	.discover-header p,
	.recent-label,
	.tenant-option p {
		color: var(--text-secondary);
		margin: 0;
	}

	.discover-kicker {
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--primary);
		margin: 0;
	}

	.notice,
	.alert-error {
		padding: 0.9rem 1rem;
		border-radius: 14px;
	}

	.notice {
		background: var(--bg-subtle);
		color: var(--text-secondary);
	}

	.alert-error {
		background: var(--danger-light);
		color: var(--danger);
		border: 1px solid rgba(239, 68, 68, 0.24);
	}

	.discover-form {
		display: grid;
		gap: 1rem;
	}

	.form-group {
		display: grid;
		gap: 0.4rem;
	}

	label {
		font-weight: 600;
		color: var(--text-primary);
	}

	input,
	select {
		width: 100%;
		padding: 0.85rem 0.95rem;
		border-radius: 14px;
		border: 1px solid var(--border);
		background: var(--bg-input, var(--bg-page));
		color: var(--text-primary);
	}

	input::placeholder {
		color: var(--text-muted);
	}

	input:focus,
	select:focus {
		outline: none;
		border-color: var(--border-focus);
		box-shadow: 0 0 0 4px var(--primary-light);
	}

	.primary-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.95rem 1.1rem;
		border: none;
		border-radius: 14px;
		background: var(--gradient-primary);
		color: white;
		font-weight: 700;
		cursor: pointer;
	}

	.primary-button:disabled,
	.tenant-option-button:disabled {
		cursor: wait;
		opacity: 0.72;
	}

	.button-spinner {
		width: 1rem;
		height: 1rem;
		border-radius: 50%;
		border: 2px solid rgba(255, 255, 255, 0.45);
		border-top-color: white;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.recent-tenant,
	.candidate-list {
		display: grid;
		gap: 0.75rem;
	}

	.tenant-option {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: 16px;
		text-decoration: none;
		color: inherit;
		background: var(--bg-input, var(--bg-page));
		transition:
			border-color var(--transition-fast),
			transform var(--transition-fast),
			background var(--transition-fast);
	}

	.tenant-option-form {
		margin: 0;
	}

	.tenant-option-button {
		width: 100%;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.tenant-option:hover:not(:disabled) {
		border-color: rgba(14, 116, 144, 0.5);
		transform: translateY(-1px);
	}

	.tenant-branding {
		display: flex;
		align-items: center;
		gap: 0.85rem;
	}

	.tenant-branding img {
		width: 40px;
		height: 40px;
		object-fit: cover;
		border-radius: 12px;
		border: 1px solid var(--border);
	}

	@media (max-width: 640px) {
		.discover-card {
			padding: 4rem 1.25rem 1.25rem;
		}

		.tenant-option {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
