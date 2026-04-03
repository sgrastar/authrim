<script lang="ts">
	import { getDefaultDiscoveryMode, getInteractiveDiscoveryMethods } from '$lib/discovery-ui';
	import { LL } from '$i18n/i18n-svelte';

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
				selection_policy: 'auto_if_single' | 'always_select' | 'select_if_multiple' | 'manual_only';
				allow_manual_tenant_entry: boolean;
				host_policy: 'common_entry_only' | 'all_hosts';
			};
			is_common_entry_host: boolean;
			single_tenant_mode: boolean;
		};
		rememberedCandidate: DiscoveryCandidate | null;
		inviteToken?: string | null;
		inviteErrorCode?: string | null;
	}

	interface ActionData {
		mode?: string;
		value?: string;
		errorCode?: string;
		candidates?: DiscoveryCandidate[];
		result?: 'multiple' | 'manual_required' | 'not_found';
	}

	let { data, form }: { data: PageData; form?: ActionData } = $props();

	const methods = $derived(data.config.config.discovery_methods);
	const interactiveMethods = $derived(
		getInteractiveDiscoveryMethods(methods, data.config.config.selection_policy)
	);
	const rememberedCandidate = $derived(data.rememberedCandidate);
	const submittedMode = $derived(form?.mode);
	const submittedValue = $derived(form?.value || '');

	let selectedMode = $derived(submittedMode || getDefaultDiscoveryMode(interactiveMethods));
	let value = $derived(submittedValue);

	const candidates = $derived(form?.candidates || []);
	const errorCode = $derived(form?.errorCode || data.inviteErrorCode || '');
	const errorMessage = $derived(errorCode ? getErrorMessage(errorCode) : '');

	function modeLabel(mode: string): string {
		switch (mode) {
			case 'email':
				return $LL.discover_method_email();
			case 'tenant_code':
				return $LL.discover_method_tenantCode();
			case 'tenant_slug':
				return $LL.discover_method_tenantSlug();
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
</script>

<svelte:head>
	<title>{$LL.discover_pageTitle()}</title>
</svelte:head>

<div class="discover-page">
	<div class="discover-card">
		<div class="discover-header">
			<p class="discover-kicker">{$LL.discover_kicker()}</p>
			<h1>{$LL.discover_title()}</h1>
			<p>{$LL.discover_subtitle()}</p>
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

		{#if rememberedCandidate}
			<div class="recent-tenant">
				<p class="recent-label">{$LL.discover_recentTenant()}</p>
				<a class="tenant-option" href={rememberedCandidate.login_url}>
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
			</div>
		{/if}

		<form method="POST" action="?/resolve" class="discover-form">
			{#if data.inviteToken}
				<input type="hidden" name="invite_token" value={data.inviteToken} />
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
					</select>
				</div>
			{:else}
				<input
					type="hidden"
					name="mode"
					value={getDefaultDiscoveryMode(interactiveMethods)}
				/>
			{/if}

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

			<button type="submit" class="primary-button">{$LL.common_continue()}</button>
		</form>

		{#if candidates.length > 0}
			<div class="candidate-list">
				<h2>{$LL.discover_selectTenant()}</h2>
					{#each candidates as candidate (candidate.tenant_id)}
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
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 24px;
		padding: 2rem;
		box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.discover-header h1 {
		margin: 0.25rem 0 0.5rem;
		font-size: clamp(1.8rem, 4vw, 2.4rem);
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
		background: rgba(220, 38, 38, 0.1);
		color: #b91c1c;
		border: 1px solid rgba(220, 38, 38, 0.15);
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

	.primary-button {
		padding: 0.95rem 1.1rem;
		border: none;
		border-radius: 14px;
		background: linear-gradient(135deg, #0f766e, #0369a1);
		color: white;
		font-weight: 700;
		cursor: pointer;
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
		background: rgba(255, 255, 255, 0.02);
	}

	.tenant-option:hover {
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
			padding: 1.25rem;
		}

		.tenant-option {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
