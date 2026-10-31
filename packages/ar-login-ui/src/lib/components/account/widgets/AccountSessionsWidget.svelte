<script lang="ts">
	/**
	 * Browsers and devices signed in to the account, each with a log-out action. The session ID is
	 * never shown; the country is always named in English (edge geolocation, not UI copy).
	 */
	import { Button } from '$lib/components';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import type { AccountSession } from '$lib/api/account';
	import { formatTimestamp } from '$lib/utils/date';
	import AccountSectionSkeleton from '../AccountSectionSkeleton.svelte';
	import AccountWidgetPanel from './AccountWidgetPanel.svelte';
	import type { AccountWidgetCommonProps } from './types';

	let {
		sessions = [],
		actionLoading = '',
		title = '',
		headingLevel = 2,
		loading = false,
		refreshing = false,
		error = '',
		reauthNeeded = false,
		onRefresh,
		onReauthenticate,
		onRevokeSession
	}: AccountWidgetCommonProps & {
		sessions?: AccountSession[];
		/** `session:<id>` while that session is being revoked. */
		actionLoading?: string;
		onRevokeSession: (id: string) => void;
	} = $props();

	const uid = $props.id();

	function sessionTitle(session: AccountSession): string {
		return [session.browser, session.os].filter(Boolean).join(' / ') || $LL.account_unknownDevice();
	}

	function formatCountry(countryCode: string | null): string | null {
		if (!countryCode) return null;
		try {
			return new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) ?? countryCode;
		} catch {
			return countryCode;
		}
	}
</script>

<AccountWidgetPanel
	title={title || $LL.account_sessions()}
	{headingLevel}
	busy={loading}
	{refreshing}
	{error}
	{reauthNeeded}
	{onRefresh}
	{onReauthenticate}
>
	<p class="description">{$LL.account_sessionsDescription()}</p>
	{#if loading}
		<AccountSectionSkeleton variant="list" rows={1} showAction />
	{:else if sessions.length === 0}
		<p class="empty-text">{$LL.account_empty()}</p>
	{:else}
		<ul class="item-list">
			{#each sessions as session, index (session.id)}
				{@const country = formatCountry(session.country_code)}
				{@const signedInAt = formatTimestamp(session.created_at, getLocale())}
				<li class="session-row">
					<strong class="session-title" id={`${uid}-session-${index}`}>
						{sessionTitle(session)}
						{#if session.current}
							<span class="inline-tag">{$LL.account_currentSession()}</span>
						{/if}
					</strong>
					<p class="session-meta">
						{#if country}
							<span class="meta-item">
								<span class="sr-only">{$LL.account_sessionLocation({ country })}</span>
								<span aria-hidden="true">{country}</span>
							</span>
						{/if}
						<span class="meta-item">
							<span class="sr-only">{$LL.account_signedInAt({ time: signedInAt })}</span>
							<span aria-hidden="true">{signedInAt}</span>
						</span>
					</p>
					<Button
						variant={session.current ? 'danger' : 'secondary'}
						size="sm"
						loading={actionLoading === `session:${session.id}`}
						aria-describedby={`${uid}-session-${index}`}
						onclick={() => onRevokeSession(session.id)}
					>
						{session.current ? $LL.header_logout() : $LL.account_logoutSession()}
					</Button>
				</li>
			{/each}
		</ul>
	{/if}
</AccountWidgetPanel>

<style>
	.item-list {
		display: grid;
		gap: 8px;
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.session-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		column-gap: 12px;
		padding: 10px 0;
		border-top: 1px solid var(--border);
	}

	.session-row > :global(button) {
		grid-column: 2;
		grid-row: 1;
	}

	.session-title {
		display: flex;
		align-items: center;
		flex-wrap: nowrap;
		gap: 6px;
		min-width: 0;
		font-size: 0.875rem;
		overflow-wrap: anywhere;
	}

	.session-meta {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 2px 8px;
		margin: 2px 0 0;
		font-size: 0.8125rem;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.meta-item + .meta-item::before {
		content: '·';
		/* Decorative: no alt text where the alt syntax is supported. */
		content: '·' / '';
		margin-inline-end: 8px;
	}

	.description,
	.empty-text {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.inline-tag {
		display: inline-flex;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
		white-space: nowrap;
	}
</style>
