<script lang="ts">
	import { Card } from '$lib/components';
	import AccountSectionSkeleton from './AccountSectionSkeleton.svelte';
	import type { AccountConsent } from '$lib/api/account';
	import { formatTimestamp } from '$lib/utils/date';
	import { LL, getLocale } from '$i18n/i18n-svelte';

	let {
		consents = [],
		loading = false,
		error = '',
		title = ''
	} = $props<{
		consents?: AccountConsent[];
		loading?: boolean;
		error?: string;
		title?: string;
	}>();

	function formatScopes(consent: AccountConsent): string {
		if (consent.kind !== 'oauth_client') {
			return '-';
		}
		const scopes = consent.selectedScopes?.length ? consent.selectedScopes : consent.scopes;
		return scopes.length ? scopes.join(', ') : '-';
	}

	function formatPolicyVersions(consent: AccountConsent): string {
		if (consent.kind !== 'oauth_client') {
			return '-';
		}
		const versions: string[] = [];
		if (consent.policyVersions?.privacyPolicyVersion) {
			versions.push(
				`${$LL.account_consentPrivacyPolicy()}: ${consent.policyVersions.privacyPolicyVersion}`
			);
		}
		if (consent.policyVersions?.tosVersion) {
			versions.push(`${$LL.account_consentTerms()}: ${consent.policyVersions.tosVersion}`);
		}
		if (consent.policyVersions?.consentVersion) {
			versions.push(`${$LL.account_consentVersion()}: ${consent.policyVersions.consentVersion}`);
		}
		return versions.length ? versions.join(' / ') : '-';
	}

	function formatStatus(status: string): string {
		switch (status) {
			case 'granted':
				return $LL.account_consentStatusGranted();
			case 'withdrawn':
				return $LL.account_consentStatusWithdrawn();
			case 'denied':
				return $LL.account_consentStatusDenied();
			default:
				return status;
		}
	}

	function selectedValueLabel(): string {
		return $LL.account_consentSelectedValue();
	}

	function formatSelectedValue(value: string): string {
		switch (value) {
			case 'once':
				return $LL.account_consentSelectedOnce();
			case 'always':
				return $LL.account_consentSelectedAlways();
			case 'none':
				return $LL.account_consentSelectedNone();
			default:
				return value;
		}
	}
</script>

<Card>
	<section class="consent-panel" aria-busy={loading}>
		<div class="panel-heading">
			<h2>{title || $LL.account_consentTitle()}</h2>
			{#if !loading}<span class="count-badge">{consents.length}</span>{/if}
		</div>
		<p class="panel-description">{$LL.account_consentDescription()}</p>

		{#if loading}
			<AccountSectionSkeleton variant="list" />
		{:else if error}
			<p class="panel-error">{error}</p>
		{:else if consents.length === 0}
			<p class="empty-text">{$LL.account_consentEmpty()}</p>
		{:else}
			<ul class="consent-list">
				{#each consents as consent (consent.id)}
					<li>
						<div class="consent-app" class:statement-consent={consent.kind === 'statement'}>
							{#if consent.kind === 'oauth_client' && consent.clientLogoUri}
								<img src={consent.clientLogoUri} alt="" loading="lazy" />
							{:else}
								<span class="consent-icon" aria-hidden="true">
									{consent.kind === 'statement' ? 'C' : 'A'}
								</span>
							{/if}
							<div>
								<strong>
									{consent.kind === 'statement'
										? consent.title
										: (consent.clientName ?? consent.clientId)}
								</strong>
								<span>
									{consent.kind === 'statement'
										? (consent.category ?? consent.statementId)
										: consent.clientId}
								</span>
							</div>
						</div>
						<dl>
							{#if consent.kind === 'statement'}
								<div>
									<dt>{$LL.account_consentStatus()}</dt>
									<dd>{formatStatus(consent.status)}</dd>
								</div>
								<div>
									<dt>{$LL.account_consentVersionLabel()}</dt>
									<dd>{consent.version}</dd>
								</div>
								<div>
									<dt>{$LL.account_consentStatementId()}</dt>
									<dd>{consent.statementId}</dd>
								</div>
								{#if consent.selectedValue}
									<div>
										<dt>{selectedValueLabel()}</dt>
										<dd>{formatSelectedValue(consent.selectedValue)}</dd>
									</div>
								{/if}
							{:else}
								<div>
									<dt>{$LL.account_consentScopes()}</dt>
									<dd>{formatScopes(consent)}</dd>
								</div>
							{/if}
							<div>
								<dt>{$LL.account_consentGrantedAt()}</dt>
								<dd>
									{consent.grantedAt ? formatTimestamp(consent.grantedAt, getLocale()) : '-'}
								</dd>
							</div>
							<div>
								<dt>{$LL.account_consentExpiresAt()}</dt>
								<dd>
									{consent.expiresAt
										? formatTimestamp(consent.expiresAt, getLocale())
										: $LL.account_consentNoExpiry()}
								</dd>
							</div>
							{#if consent.kind === 'oauth_client'}
								<div>
									<dt>{$LL.account_consentPolicyVersions()}</dt>
									<dd>{formatPolicyVersions(consent)}</dd>
								</div>
							{/if}
						</dl>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</Card>

<style>
	.consent-panel {
		display: grid;
		gap: 12px;
	}

	.panel-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	h2 {
		margin: 0;
		font-size: 1rem;
	}

	.count-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 28px;
		height: 28px;
		padding: 0 10px;
		border-radius: var(--radius-full);
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: 0.8125rem;
		font-weight: 700;
	}

	.panel-description,
	.empty-text,
	.panel-error {
		margin: 0;
		font-size: 0.8125rem;
	}

	.panel-description,
	.empty-text {
		color: var(--text-muted);
	}

	.panel-error {
		color: var(--danger);
	}

	.consent-list {
		display: grid;
		gap: 12px;
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.consent-list li {
		display: grid;
		gap: 10px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}

	.consent-app {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.consent-app img {
		width: 36px;
		height: 36px;
		border-radius: 8px;
		object-fit: contain;
		border: 1px solid var(--border);
		background: var(--bg-input);
	}

	.consent-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 36px;
		height: 36px;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--success-light);
		color: var(--success);
		font-size: 0.9375rem;
		font-weight: 700;
	}

	.consent-app strong,
	.consent-app span,
	dd {
		overflow-wrap: anywhere;
	}

	.consent-app strong,
	.consent-app span {
		display: block;
	}

	.consent-app strong {
		font-size: 0.9375rem;
	}

	.consent-app span,
	dt {
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	dl {
		display: grid;
		gap: 8px;
		margin: 0;
	}

	dl div {
		display: grid;
		gap: 2px;
	}

	dd {
		margin: 0;
		font-size: 0.875rem;
		color: var(--text-secondary);
	}
</style>
