<script lang="ts">
	/**
	 * Registered passkeys by authenticator provider (name, light/dark icon, registration date) and
	 * a form to register another. The technical device label and credential ID are not shown.
	 */
	import { Button, Input } from '$lib/components';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import type { AccountPasskey } from '$lib/api/account';
	import { formatTimestamp } from '$lib/utils/date';
	import AccountSectionSkeleton from '../AccountSectionSkeleton.svelte';
	import AccountWidgetPanel from './AccountWidgetPanel.svelte';
	import type { AccountWidgetCommonProps } from './types';

	let {
		passkeys = [],
		passkeySupported = false,
		actionLoading = '',
		title = '',
		headingLevel = 2,
		loading = false,
		refreshing = false,
		error = '',
		reauthNeeded = false,
		onRefresh,
		onReauthenticate,
		onAddPasskey,
		onDeletePasskey
	}: AccountWidgetCommonProps & {
		passkeys?: AccountPasskey[];
		/** The browser can register a passkey; the form is disabled otherwise. */
		passkeySupported?: boolean;
		/** `passkey:add` while registering, `passkey:<id>` while deleting that one. */
		actionLoading?: string;
		onAddPasskey: (deviceName: string) => void;
		onDeletePasskey: (id: string) => void;
	} = $props();

	const uid = $props.id();
	let newPasskeyName = $state('');

	function addPasskey(event: SubmitEvent) {
		event.preventDefault();
		onAddPasskey(newPasskeyName);
		newPasskeyName = '';
	}

	function hasIcon(passkey: AccountPasskey): boolean {
		return Boolean(passkey.provider?.icon_light || passkey.provider?.icon_dark);
	}
</script>

<AccountWidgetPanel
	title={title || $LL.account_passkeys()}
	{headingLevel}
	busy={loading}
	{refreshing}
	{error}
	{reauthNeeded}
	{onRefresh}
	{onReauthenticate}
>
	{#if loading}
		<AccountSectionSkeleton variant="form-list" rows={1} showAction showIcon />
	{:else}
		<form class="add-form" onsubmit={addPasskey}>
			<Input
				label={$LL.account_passkeyName()}
				bind:value={newPasskeyName}
				disabled={!passkeySupported || actionLoading === 'passkey:add'}
				maxlength={100}
			/>
			<Button
				variant="primary"
				type="submit"
				loading={actionLoading === 'passkey:add'}
				disabled={!passkeySupported}
			>
				{$LL.account_addPasskey()}
			</Button>
		</form>
		{#if !passkeySupported}
			<p class="muted">{$LL.account_passkeyUnsupported()}</p>
		{/if}

		{#if passkeys.length === 0}
			<p class="muted">{$LL.account_empty()}</p>
		{:else}
			<ul class="item-list">
				{#each passkeys as passkey, index (passkey.id)}
					<li class="passkey-row">
						<div class="passkey-summary" class:has-provider-icon={hasIcon(passkey)}>
							{#if hasIcon(passkey)}
								<span class="provider-icon" aria-hidden="true">
									<img
										class="passkey-provider-icon__light"
										src={passkey.provider?.icon_light ?? passkey.provider?.icon_dark ?? ''}
										alt=""
										loading="lazy"
									/>
									<img
										class="passkey-provider-icon__dark"
										src={passkey.provider?.icon_dark ?? passkey.provider?.icon_light ?? ''}
										alt=""
										loading="lazy"
									/>
								</span>
							{/if}
							<strong class="provider-name" id={`${uid}-passkey-${index}`}
								>{passkey.provider?.name ?? $LL.account_passkeys()}</strong
							>
							<span class="created-at">{formatTimestamp(passkey.created_at, getLocale())}</span>
						</div>
						<Button
							variant="danger"
							size="sm"
							loading={actionLoading === `passkey:${passkey.id}`}
							aria-describedby={`${uid}-passkey-${index}`}
							onclick={() => onDeletePasskey(passkey.id)}
						>
							{$LL.account_delete()}
						</Button>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</AccountWidgetPanel>

<style>
	.add-form {
		display: grid;
		gap: 8px;
	}

	.item-list {
		display: grid;
		gap: 8px;
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.passkey-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		padding: 10px 0;
		border-top: 1px solid var(--border);
	}

	/* The icon spans both detail rows and matches the action button's height. */
	.passkey-summary {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: auto auto;
		column-gap: 10px;
		row-gap: 2px;
		align-items: center;
		min-width: 0;
	}

	.passkey-summary.has-provider-icon {
		grid-template-columns: 36px minmax(0, 1fr);
	}

	.provider-icon {
		grid-column: 1;
		grid-row: 1 / span 2;
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
	}

	.provider-icon img {
		grid-area: 1 / 1;
		width: 34px;
		height: 34px;
		border-radius: var(--radius-sm);
		object-fit: contain;
	}

	.passkey-provider-icon__dark {
		display: none;
	}

	:global([data-theme='dark']) .passkey-provider-icon__light {
		display: none;
	}

	:global([data-theme='dark']) .passkey-provider-icon__dark {
		display: block;
	}

	.provider-name,
	.created-at {
		grid-column: 1;
		overflow-wrap: anywhere;
	}

	.has-provider-icon .provider-name,
	.has-provider-icon .created-at {
		grid-column: 2;
	}

	.provider-name {
		font-size: 0.875rem;
	}

	.created-at,
	.muted {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}
</style>
