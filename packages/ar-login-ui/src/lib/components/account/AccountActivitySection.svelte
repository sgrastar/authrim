<script lang="ts">
	import { Card } from '$lib/components';
	import type { AccountOperation } from '$lib/api/account';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import { formatTimestamp } from '$lib/utils/date';

	let { operations = [], title = '' } = $props<{
		operations?: AccountOperation[];
		title?: string;
	}>();

	function formatAction(action: string): string {
		switch (action) {
			case 'account.profile.name_updated':
				return $LL.account_operationNameUpdated();
			case 'account.passkey.created':
				return $LL.account_operationPasskeyCreated();
			case 'account.passkey.updated':
				return $LL.account_operationPasskeyUpdated();
			case 'account.passkey.deleted':
				return $LL.account_operationPasskeyDeleted();
			case 'account.session.revoked':
				return $LL.account_operationSessionRevoked();
			default:
				return action;
		}
	}
</script>

<Card>
	<section class="activity-panel">
		<h2>{title || $LL.account_activityTitle()}</h2>
		{#if operations.length === 0}
			<p class="empty-text">{$LL.account_empty()}</p>
		{:else}
			<ul>
				{#each operations as operation (operation.id)}
					<li>
						<span>{formatTimestamp(operation.created_at, getLocale())}</span>
						<strong>{formatAction(operation.action)}</strong>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</Card>

<style>
	.activity-panel {
		display: grid;
		gap: 12px;
	}

	h2 {
		margin: 0;
		font-size: 1rem;
	}

	ul {
		display: grid;
		gap: 8px;
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li {
		display: grid;
		gap: 4px;
		padding-top: 8px;
		border-top: 1px solid var(--border);
	}

	span,
	.empty-text {
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	strong {
		font-size: 0.875rem;
		overflow-wrap: anywhere;
	}
</style>
