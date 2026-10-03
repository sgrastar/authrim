<script lang="ts">
	/**
	 * External accounts linked to this one (provider, address, when linked and last used), with
	 * unlinking behind an inline confirmation, and one button per provider that can still be linked.
	 * Linking leaves the page for the provider and comes back with `notice`.
	 */
	import { Button } from '$lib/components';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import type { AccountLinkedIdentity } from '$lib/api/account';
	import type { ExternalProvider } from '$lib/api/authentication-methods';
	import { getExternalProviderIconClass } from '$lib/login-provider-icons';
	import { formatTimestamp } from '$lib/utils/date';
	import { isValidImageUrl } from '$lib/utils/url-validation';
	import AccountSectionSkeleton from '../AccountSectionSkeleton.svelte';
	import AccountWidgetPanel from './AccountWidgetPanel.svelte';
	import type { AccountWidgetCommonProps } from './types';

	let {
		identities = [],
		providers = [],
		actionLoading = '',
		notice = null,
		title = '',
		headingLevel = 2,
		loading = false,
		refreshing = false,
		error = '',
		reauthNeeded = false,
		onRefresh,
		onReauthenticate,
		onLink,
		onUnlink
	}: AccountWidgetCommonProps & {
		identities?: AccountLinkedIdentity[];
		/** The tenant's external providers (authentication-methods); those not linked can be. */
		providers?: ExternalProvider[];
		/** `social:link:<provider id>` while leaving for a provider, `social:unlink:<id>` while unlinking. */
		actionLoading?: string;
		/** The outcome of the last link or unlink. */
		notice?: { kind: 'success' | 'error'; message: string } | null;
		/** Omit (with onUnlink) to list the linked accounts without actions. */
		onLink?: (providerId: string) => void;
		onUnlink?: (identityId: string) => void;
	} = $props();

	const uid = $props.id();
	let confirming = $state<string | null>(null);

	/** The authentication-methods API names a provider by its slug, else its id. */
	function isLinked(provider: ExternalProvider): boolean {
		return identities.some(
			(identity) => (identity.providerSlug ?? identity.providerId) === provider.id
		);
	}

	const linkable = $derived(
		providers.filter(
			(provider) =>
				// Linking runs the OAuth / OIDC redirect; SAML providers cannot be linked here.
				provider.startMode === 'oauth_redirect' &&
				provider.enabled !== false &&
				provider.loginEnabled !== false &&
				!isLinked(provider)
		)
	);
	const busy = $derived(actionLoading.startsWith('social:'));

	function iconClass(provider: ExternalProvider): string {
		return getExternalProviderIconClass(provider);
	}
</script>

<AccountWidgetPanel
	title={title || $LL.account_socialAccounts()}
	{headingLevel}
	busy={loading}
	{refreshing}
	{error}
	{reauthNeeded}
	{onRefresh}
	{onReauthenticate}
>
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
		<AccountSectionSkeleton variant="list" rows={1} showAction showIcon />
	{:else}
		{#if identities.length === 0}
			<p class="muted">{$LL.account_socialEmpty()}</p>
		{:else}
			<ul class="item-list">
				{#each identities as identity, index (identity.id)}
					{@const nameId = `${uid}-identity-${index}`}
					<li class="identity-row">
						<div class="identity-summary">
							<strong id={nameId}>{identity.providerName}</strong>
							{#if identity.providerEmail}
								<span class="identity-email">{identity.providerEmail}</span>
							{/if}
							<span class="identity-meta">
								{$LL.account_socialLinkedAt({
									date: formatTimestamp(identity.linkedAt, getLocale())
								})}
								{#if identity.lastLoginAt}
									<span aria-hidden="true"> · </span>
									{$LL.account_socialLastUsed({
										date: formatTimestamp(identity.lastLoginAt, getLocale())
									})}
								{/if}
							</span>
						</div>
						{#if confirming === identity.id}
							<div class="confirm" role="group" aria-labelledby={`${nameId}-confirm`}>
								<p id={`${nameId}-confirm`}>
									{$LL.account_socialUnlinkConfirm({ provider: identity.providerName })}
								</p>
								<div class="confirm-actions">
									<Button
										variant="danger"
										size="sm"
										loading={actionLoading === `social:unlink:${identity.id}`}
										disabled={busy && actionLoading !== `social:unlink:${identity.id}`}
										onclick={() => onUnlink?.(identity.id)}
									>
										{$LL.account_socialUnlinkConfirmAction({ provider: identity.providerName })}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										disabled={actionLoading === `social:unlink:${identity.id}`}
										onclick={() => (confirming = null)}
									>
										{$LL.dialog_cancel()}
									</Button>
								</div>
							</div>
						{:else if onUnlink}
							<Button
								variant="secondary"
								size="sm"
								aria-describedby={nameId}
								disabled={busy}
								onclick={() => (confirming = identity.id)}
							>
								{$LL.account_socialUnlink()}
							</Button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if onLink}
			<svelte:element this={`h${headingLevel + 1}`} class="link-heading">
				{$LL.account_socialLinkHeading()}
			</svelte:element>
			{#if linkable.length === 0}
				<p class="muted">{$LL.account_socialNoProviders()}</p>
			{:else}
				<div class="provider-list">
					{#each linkable as provider (provider.id)}
						<Button
							variant="secondary"
							loading={actionLoading === `social:link:${provider.id}`}
							disabled={busy}
							onclick={() => onLink?.(provider.id)}
						>
							{#if provider.iconUrl && isValidImageUrl(provider.iconUrl)}
								<img class="provider-icon" src={provider.iconUrl} alt="" loading="lazy" />
							{:else if iconClass(provider)}
								<span class="{iconClass(provider)} provider-icon" aria-hidden="true"></span>
							{/if}
							{$LL.account_socialLinkWith({ provider: provider.name })}
						</Button>
					{/each}
				</div>
			{/if}
		{/if}
	{/if}
</AccountWidgetPanel>

<style>
	.muted {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--text-secondary);
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

	.item-list {
		display: grid;
		gap: 8px;
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.identity-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		padding: 10px 0;
		border-top: 1px solid var(--border);
	}

	.identity-summary {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.identity-email,
	.identity-meta {
		font-size: 0.8125rem;
		color: var(--text-secondary);
		overflow-wrap: anywhere;
	}

	.confirm {
		grid-column: 1 / -1;
		display: grid;
		gap: 8px;
	}

	.confirm p {
		margin: 0;
		font-size: 0.875rem;
		color: var(--text-primary);
	}

	.confirm-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.link-heading {
		margin: 8px 0 0;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.provider-list {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.provider-icon {
		width: 20px;
		height: 20px;
		flex: 0 0 20px;
		object-fit: contain;
	}
</style>
