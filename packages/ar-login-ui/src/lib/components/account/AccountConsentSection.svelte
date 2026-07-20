<script lang="ts">
	import { Card } from '$lib/components';
	import type { AccountConsent } from '$lib/api/account';
	import { formatTimestamp } from '$lib/utils/date';
	import { LL, getLocale } from '$i18n/i18n-svelte';

	let {
		consents = [],
		error = '',
		withdrawingId = '',
		onWithdraw
	} = $props<{
		consents?: AccountConsent[];
		error?: string;
		withdrawingId?: string;
		onWithdraw?: (consent: AccountConsent) => void | Promise<void>;
	}>();
	const documentAcceptances = $derived(
		consents.filter((consent: AccountConsent) => consent.recordType === 'document_acceptance')
	);
	const releaseGrants = $derived(
		consents.filter((consent: AccountConsent) => consent.recordType === 'release_grant')
	);

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
		return getLocale() === 'ja' ? '選択' : 'Decision';
	}

	function formatSelectedValue(value: string): string {
		const ja = getLocale() === 'ja';
		switch (value) {
			case 'once':
				return ja ? '今回のみ' : 'This time only';
			case 'always':
				return ja ? '今後も許可' : 'Always allow';
			case 'none':
				return ja ? '許可しない' : 'Do not allow';
			default:
				return value;
		}
	}

	function text(ja: string, en: string): string {
		return getLocale() === 'ja' ? ja : en;
	}

	function formatRelease(consent: AccountConsent): string {
		if (consent.kind === 'oauth_client') return formatScopes(consent);
		const values = [
			...(consent.releasedScopes ?? []),
			...(consent.releasedClaims ?? []),
			...(consent.releasedAttributes ?? [])
		];
		return values.length ? values.join(', ') : '-';
	}
</script>

<Card>
	<section class="consent-panel">
		<div class="panel-heading">
			<h2>{$LL.account_consentTitle()}</h2>
			<span class="count-badge">{consents.length}</span>
		</div>
		<p class="panel-description">{$LL.account_consentDescription()}</p>

		{#if error}
			<p class="panel-error">{error}</p>
		{:else if consents.length === 0}
			<p class="empty-text">{$LL.account_consentEmpty()}</p>
		{:else}
			{#if documentAcceptances.length > 0}
				<section class="consent-group" aria-labelledby="document-acceptances-title">
					<h3 id="document-acceptances-title">
						{text('文書への同意', 'Document acceptances')}
					</h3>
					<p class="group-description">
						{text(
							'同じ文書とバージョンへの同意は、これを利用するすべてのサービスで共通です。取り下げると、それらすべてに影響します。',
							'Acceptance of the same document version is shared by every service that uses it. Withdrawing it affects all of those services.'
						)}
					</p>
					<ul class="consent-list">
						{#each documentAcceptances as consent (consent.id)}
							{@render consentItem(consent)}
						{/each}
					</ul>
				</section>
			{/if}
			{#if releaseGrants.length > 0}
				<section class="consent-group" aria-labelledby="release-grants-title">
					<h3 id="release-grants-title">{text('サービスへの情報提供', 'Release grants')}</h3>
					<p class="group-description">
						{text(
							'サービスごとに許可したスコープ、クレーム、属性です。',
							'Scopes, claims, and attributes allowed for each service.'
						)}
					</p>
					<ul class="consent-list">
						{#each releaseGrants as consent (consent.id)}
							{@render consentItem(consent)}
						{/each}
					</ul>
				</section>
			{/if}
		{/if}
	</section>
</Card>

{#snippet consentItem(consent: AccountConsent)}
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
					{consent.kind === 'statement' ? consent.title : (consent.clientName ?? consent.clientId)}
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
				{#if consent.recordType === 'release_grant'}
					<div>
						<dt>{text('提供項目', 'Released items')}</dt>
						<dd>{formatRelease(consent)}</dd>
					</div>
					{#if consent.targetId}
						<div>
							<dt>{text('提供先', 'Target')}</dt>
							<dd>{consent.targetId}</dd>
						</div>
					{/if}
				{/if}
				{#if consent.selectedValue}
					<div>
						<dt>{selectedValueLabel()}</dt>
						<dd>{formatSelectedValue(consent.selectedValue)}</dd>
					</div>
				{/if}
			{:else}
				<div>
					<dt>
						{consent.recordType === 'release_grant'
							? text('提供項目', 'Released items')
							: $LL.account_consentScopes()}
					</dt>
					<dd>{formatRelease(consent)}</dd>
				</div>
			{/if}
			<div>
				<dt>{$LL.account_consentGrantedAt()}</dt>
				<dd>
					{consent.grantedAt ? formatTimestamp(consent.grantedAt) : '-'}
				</dd>
			</div>
			<div>
				<dt>{$LL.account_consentExpiresAt()}</dt>
				<dd>
					{consent.expiresAt ? formatTimestamp(consent.expiresAt) : $LL.account_consentNoExpiry()}
				</dd>
			</div>
			{#if consent.kind === 'oauth_client'}
				<div>
					<dt>{$LL.account_consentPolicyVersions()}</dt>
					<dd>{formatPolicyVersions(consent)}</dd>
				</div>
			{/if}
		</dl>
		{#if onWithdraw && (consent.kind === 'oauth_client' || (consent.gateKind && consent.status === 'granted'))}
			<button
				type="button"
				class="withdraw-button"
				disabled={withdrawingId === consent.id}
				onclick={() => onWithdraw?.(consent)}
			>
				{withdrawingId === consent.id
					? text('取り下げ中…', 'Withdrawing…')
					: text('同意を取り下げる', 'Withdraw consent')}
			</button>
		{/if}
	</li>
{/snippet}

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

	.consent-group {
		display: grid;
		gap: 8px;
	}

	.consent-group + .consent-group {
		margin-top: 8px;
	}

	.consent-group h3,
	.group-description {
		margin: 0;
	}

	.consent-group h3 {
		font-size: 0.875rem;
	}

	.group-description {
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.consent-list li {
		display: grid;
		gap: 10px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}

	.withdraw-button {
		justify-self: start;
		border: 1px solid var(--danger);
		border-radius: 8px;
		background: transparent;
		color: var(--danger);
		padding: 7px 10px;
		font: inherit;
		font-size: 0.75rem;
		font-weight: 700;
		cursor: pointer;
	}

	.withdraw-button:disabled {
		cursor: wait;
		opacity: 0.6;
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
