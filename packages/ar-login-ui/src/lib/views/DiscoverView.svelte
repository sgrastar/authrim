<script module lang="ts">
	/** A tenant the person may sign in to. */
	export interface DiscoveryCandidate {
		tenant_id: string;
		tenant_code: string;
		display_name: string;
		logo_url?: string | null;
		login_url: string;
		source: string;
	}

	/** Values a discovery form carries over (invitation, return target, login hint, email code). */
	export interface DiscoveryHiddenFields {
		inviteToken?: string | null;
		expectedTenantId?: string | null;
		returnTo?: string | null;
		loginHint?: string;
		emailChallengeId?: string;
	}
</script>

<script lang="ts">
	/**
	 * The tenant discovery page, as the person sees it: how to find their organisation (email,
	 * tenant code, slug or a list), the tenants found, and the last one used. The route owns the
	 * configuration and the form results; this view draws them. Forms post natively to
	 * `/discover?/resolve`; tenants not on the common entry host are links to their login page.
	 */
	import { Alert, Button, Card } from '$lib/components';
	import { getDefaultDiscoveryMode } from '$lib/discovery-ui';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import { isValidImageUrl, isValidLinkUrl } from '$lib/utils/url-validation';

	type Props = {
		kickerText: string;
		titleText: string;
		subtitleText: string;
		/** The common entry host is only for tenant links (no discovery here). */
		tenantOnly?: boolean;
		manualOnly?: boolean;
		errorMessage?: string;
		showTenantChooser: boolean;
		interactiveMethods: string[];
		wayfOnly?: boolean;
		wayfCandidates?: DiscoveryCandidate[];
		rememberedCandidate?: DiscoveryCandidate | null;
		candidates?: DiscoveryCandidate[];
		/** On the common entry host a chosen tenant is posted back; elsewhere it is a link. */
		postSelections: boolean;
		hidden: DiscoveryHiddenFields;
		selectedMode: string;
		value: string;
		submitting?: boolean;
		onSubmit: () => void;
	};

	let {
		kickerText,
		titleText,
		subtitleText,
		tenantOnly = false,
		manualOnly = false,
		errorMessage = '',
		showTenantChooser,
		interactiveMethods,
		wayfOnly = false,
		wayfCandidates = [],
		rememberedCandidate = null,
		candidates = [],
		postSelections,
		hidden,
		selectedMode = $bindable(),
		value = $bindable(),
		submitting = false,
		onSubmit
	}: Props = $props();

	function modeLabel(mode: string): string {
		switch (mode) {
			case 'email':
				return $LL.discover_method_email();
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

	function loginPath(url: string): string {
		if (!isValidLinkUrl(url)) return '';
		return new URL(url).host;
	}

	function candidateHref(candidate: DiscoveryCandidate): string | null {
		if (!isValidLinkUrl(candidate.login_url)) return null;
		const target = new URL(candidate.login_url);
		target.searchParams.set('lang', getLocale());
		return target.toString();
	}
</script>

{#snippet carried(withEmailChallenge: boolean)}
	{#if hidden.inviteToken}
		<input type="hidden" name="invite_token" value={hidden.inviteToken} />
	{/if}
	{#if hidden.expectedTenantId}
		<input type="hidden" name="expected_tenant_id" value={hidden.expectedTenantId} />
	{/if}
	{#if hidden.returnTo}
		<input type="hidden" name="return_to" value={hidden.returnTo} />
	{/if}
	{#if hidden.loginHint}
		<input type="hidden" name="login_hint" value={hidden.loginHint} />
	{/if}
	{#if withEmailChallenge && hidden.emailChallengeId}
		<input type="hidden" name="email_challenge_id" value={hidden.emailChallengeId} />
	{/if}
{/snippet}

{#snippet branding(candidate: DiscoveryCandidate)}
	<div class="tenant-branding">
		{#if candidate.logo_url && isValidImageUrl(candidate.logo_url)}
			<img src={candidate.logo_url} alt={candidate.display_name} />
		{/if}
		<div>
			<strong>{candidate.display_name}</strong>
			<p>{candidate.tenant_code}</p>
		</div>
	</div>
	<span class="tenant-option__host">{loginPath(candidate.login_url)}</span>
{/snippet}

{#snippet tenant(candidate: DiscoveryCandidate)}
	{#if postSelections}
		<form method="POST" action="/discover?/resolve" class="tenant-option-form" onsubmit={onSubmit}>
			{@render carried(false)}
			<input type="hidden" name="mode" value="tenant_code" />
			<input type="hidden" name="value" value={candidate.tenant_code} />
			<button type="submit" class="tenant-option tenant-option-button" disabled={submitting}>
				{@render branding(candidate)}
			</button>
		</form>
	{:else}
		{@const href = candidateHref(candidate)}
		{#if href}
			<a class="tenant-option" {href} data-sveltekit-reload>
				{@render branding(candidate)}
			</a>
		{/if}
	{/if}
{/snippet}

<Card>
	<div class="auth-discover">
		<div class="auth-discover__header">
			<p class="auth-discover__kicker">{kickerText}</p>
			<h2 class="auth-section-title">{titleText}</h2>
			<p class="auth-section-subtitle">{subtitleText}</p>
		</div>

		{#if tenantOnly}
			<Alert variant="info">{$LL.discover_notice_disabled()}</Alert>
		{/if}

		{#if manualOnly}
			<Alert variant="info">{$LL.discover_notice_manualOnly()}</Alert>
		{/if}

		{#if errorMessage}
			<Alert variant="error">{errorMessage}</Alert>
		{/if}

		{#if showTenantChooser && rememberedCandidate && !wayfOnly}
			<div class="auth-discover__list">
				<p class="auth-discover__label">{$LL.discover_recentTenant()}</p>
				{@render tenant(rememberedCandidate)}
			</div>
		{/if}

		{#if showTenantChooser}
			<form
				method="POST"
				action="/discover?/resolve"
				class="auth-discover__form"
				onsubmit={onSubmit}
			>
				{@render carried(true)}

				{#if interactiveMethods.length > 1}
					<div class="form-group">
						<label class="auth-discover__label" for="mode">{$LL.discover_methodLabel()}</label>
						<select id="mode" name="mode" class="form-select" bind:value={selectedMode}>
							{#if interactiveMethods.includes('email_exact')}
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
						<label class="auth-discover__label" for="value">
							{wayfOnly ? $LL.discover_selectTenant() : modeLabel(selectedMode)}
						</label>
						<select id="value" name="value" class="form-select" bind:value required>
							<option value="" disabled>{$LL.discover_selectTenant()}</option>
							{#each wayfCandidates as candidate (candidate.tenant_id)}
								<option value={candidate.tenant_id}>{candidate.display_name}</option>
							{/each}
						</select>
					</div>
				{:else}
					<div class="form-group">
						<label class="auth-discover__label" for="value">{modeLabel(selectedMode)}</label>
						<input
							id="value"
							name="value"
							class="form-input"
							type={selectedMode === 'email' ? 'email' : 'text'}
							bind:value
							placeholder={placeholderFor(selectedMode)}
							readonly={selectedMode === 'email' && Boolean(hidden.emailChallengeId)}
							required
						/>
					</div>
					{#if selectedMode === 'email' && hidden.emailChallengeId}
						<div class="form-group">
							<label class="auth-discover__label" for="email-code"
								>{$LL.emailCode_codeLabel()}</label
							>
							<input
								id="email-code"
								name="email_code"
								class="form-input"
								type="text"
								inputmode="numeric"
								autocomplete="one-time-code"
								pattern="[0-9]{6}"
								maxlength="6"
								required
							/>
						</div>
					{/if}
				{/if}

				<Button
					type="submit"
					variant="primary"
					class="w-full"
					loading={submitting}
					disabled={selectedMode === 'wayf' && wayfCandidates.length === 0}
				>
					{$LL.common_continue()}
				</Button>
			</form>
		{/if}

		{#if showTenantChooser && candidates.length > 0}
			<div class="auth-discover__list">
				<h3 class="auth-discover__label">{$LL.discover_selectTenant()}</h3>
				{#each candidates as candidate (candidate.tenant_id)}
					{@render tenant(candidate)}
				{/each}
			</div>
		{/if}
	</div>
</Card>
