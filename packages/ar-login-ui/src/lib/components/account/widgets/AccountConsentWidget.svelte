<script lang="ts">
	/**
	 * What the account has agreed to: OAuth clients with their scopes, and consent statements
	 * (terms, policies) with their version and choice. Each can be withdrawn behind an inline
	 * confirmation (statements only when they allow it); omit `onWithdraw` for a read-only list.
	 */
	import AccountSectionSkeleton from '../AccountSectionSkeleton.svelte';
	import { Button } from '#lib/components/index.js';
	import type { AccountConsent } from '#lib/api/account.js';
	import { formatTimestamp } from '#lib/utils/date.js';
	import { accountReleaseRows } from '#lib/consent-release.js';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import AccountWidgetPanel from './AccountWidgetPanel.svelte';
	import type { AccountWidgetHeadingLevel } from './types';

	let {
		consents = [],
		loading = false,
		error = '',
		title = '',
		headingLevel = 2,
		actionLoading = '',
		notice = null,
		onWithdraw
	}: {
		consents?: AccountConsent[];
		/** First load: a skeleton instead of the (possibly empty) list. */
		loading?: boolean;
		/** Loading failed: an alert instead of the list. */
		error?: string;
		title?: string;
		headingLevel?: AccountWidgetHeadingLevel;
		/** `consent:<id>` while that consent is being withdrawn. */
		actionLoading?: string;
		/** The outcome of the last withdrawal. */
		notice?: { kind: 'success' | 'error'; message: string } | null;
		onWithdraw?: (consent: AccountConsent) => void;
	} = $props();

	const uid = $props.id();
	let confirming = $state<string | null>(null);
	const busy = $derived(actionLoading.startsWith('consent:'));

	// An outcome closes the confirmation (the list is refreshed after it).
	$effect(() => {
		if (notice) confirming = null;
	});

	function consentName(consent: AccountConsent): string {
		return consent.kind === 'statement'
			? consent.title
			: consent.kind === 'saml_sp'
				? (consent.spName ?? consent.spEntityId)
				: (consent.clientName ?? consent.clientId);
	}

	function canWithdraw(consent: AccountConsent): boolean {
		return Boolean(onWithdraw) && (consent.kind !== 'statement' || consent.withdrawable === true);
	}

	function confirmText(consent: AccountConsent): string {
		const name = consentName(consent);
		return consent.kind === 'statement'
			? $LL.account_consentWithdrawConfirmStatement({ name })
			: consent.kind === 'saml_sp'
				? $LL.account_consentWithdrawConfirmSamlSp({ name })
				: $LL.account_consentWithdrawConfirmService({ name });
	}

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

<AccountWidgetPanel
	title={title || $LL.account_consentTitle()}
	{headingLevel}
	busy={loading}
	{error}
>
	{#snippet headingAside()}
		{#if !loading && !error}<span class="count-badge">{consents.length}</span>{/if}
	{/snippet}
	<p class="panel-description">{$LL.account_consentDescription()}</p>
	{#if notice}
		<p
			class="notice"
			class:notice--error={notice.kind === 'error'}
			role={notice.kind === 'error' ? 'alert' : 'status'}
		>
			{notice.message}
		</p>
	{/if}

	{#if loading}
		<AccountSectionSkeleton variant="list" />
	{:else if error}
		<!-- The panel frame shows the error in place of the list. -->
	{:else if consents.length === 0}
		<p class="empty-text">{$LL.account_consentEmpty()}</p>
	{:else}
		<ul class="consent-list">
			{#each consents as consent (consent.id)}
				{@const nameId = `${uid}-consent-${consent.id}`}
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
							<strong id={nameId}>{consentName(consent)}</strong>
							<span>
								{consent.kind === 'statement'
									? (consent.category ?? consent.statementId)
									: consent.kind === 'saml_sp'
										? consent.spEntityId
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
							{#if consent.kind === 'oauth_client'}
								<div>
									<dt>{$LL.account_consentScopes()}</dt>
									<dd>{formatScopes(consent)}</dd>
								</div>
							{/if}
							{#each accountReleaseRows($LL, consent.informationRelease) as row (row.label)}
								<div>
									<dt>{row.label}</dt>
									<dd>{row.value}</dd>
								</div>
							{/each}
						{/if}
						<div>
							<dt>{$LL.account_consentGrantedAt()}</dt>
							<dd>
								{consent.kind === 'saml_sp'
									? formatTimestamp(consent.decidedAt, getLocale())
									: consent.grantedAt
										? formatTimestamp(consent.grantedAt, getLocale())
										: '-'}
							</dd>
						</div>
						{#if consent.kind !== 'saml_sp'}
							<div>
								<dt>{$LL.account_consentExpiresAt()}</dt>
								<dd>
									{consent.expiresAt
										? formatTimestamp(consent.expiresAt, getLocale())
										: $LL.account_consentNoExpiry()}
								</dd>
							</div>
						{/if}
						{#if consent.kind === 'oauth_client'}
							<div>
								<dt>{$LL.account_consentPolicyVersions()}</dt>
								<dd>{formatPolicyVersions(consent)}</dd>
							</div>
						{/if}
					</dl>
					{#if canWithdraw(consent)}
						{#if confirming === consent.id}
							<div class="confirm" role="group" aria-labelledby={`${nameId}-confirm`}>
								<p id={`${nameId}-confirm`}>{confirmText(consent)}</p>
								<div class="confirm-actions">
									<Button
										variant="danger"
										size="sm"
										loading={actionLoading === `consent:${consent.id}`}
										disabled={busy && actionLoading !== `consent:${consent.id}`}
										aria-label={$LL.account_consentWithdrawFor({ name: consentName(consent) })}
										onclick={() => onWithdraw?.(consent)}
									>
										{$LL.account_consentWithdraw()}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										disabled={actionLoading === `consent:${consent.id}`}
										onclick={() => (confirming = null)}
									>
										{$LL.dialog_cancel()}
									</Button>
								</div>
							</div>
						{:else}
							<div class="withdraw">
								<Button
									variant="secondary"
									size="sm"
									disabled={busy}
									aria-label={$LL.account_consentWithdrawFor({ name: consentName(consent) })}
									onclick={() => (confirming = consent.id)}
								>
									{$LL.account_consentWithdraw()}
								</Button>
							</div>
						{/if}
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</AccountWidgetPanel>

<style>
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
	.empty-text {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.notice {
		margin: 0;
		padding: 10px 12px;
		border-radius: var(--radius-sm);
		background: var(--bg-subtle);
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.notice--error {
		background: var(--danger-light);
		color: var(--danger-fg);
	}

	.withdraw,
	.confirm-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.confirm {
		display: grid;
		gap: 8px;
	}

	.confirm p {
		margin: 0;
		font-size: 0.875rem;
		color: var(--text-primary);
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
		background: var(--bg-subtle);
		color: var(--text-secondary);
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
