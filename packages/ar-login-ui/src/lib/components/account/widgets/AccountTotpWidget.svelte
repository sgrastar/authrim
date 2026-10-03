<script lang="ts">
	/**
	 * Authenticator apps (TOTP): add one, finish an enrollment, regenerate backup codes and delete
	 * a registered app with a code as proof.
	 *
	 * Inside a parent panel (heading level 3) the widget draws nothing when there is nothing to
	 * manage: no credentials, no enrollment and management turned off.
	 */
	import { Button, Input } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import type { AccountTotpCredential } from '$lib/api/account';
	import AccountSectionSkeleton from '../AccountSectionSkeleton.svelte';
	import AccountTotpCredentialList from './AccountTotpCredentialList.svelte';
	import AccountTotpEnrollment from './AccountTotpEnrollment.svelte';
	import AccountTotpRegenerate from './AccountTotpRegenerate.svelte';
	import AccountWidgetPanel from './AccountWidgetPanel.svelte';
	import type { AccountTotpEnrollment as Enrollment, AccountWidgetCommonProps } from './types';

	let {
		credentials = [],
		backupCodes = { total: 0, remaining: 0 },
		enrollment = null,
		managementEnabled = false,
		actionLoading = '',
		title = '',
		headingLevel = 2,
		loading = false,
		refreshing = false,
		error = '',
		reauthNeeded = false,
		onRefresh,
		onReauthenticate,
		onStartEnrollment,
		onActivateEnrollment,
		onDeleteCredential,
		onRegenerateBackupCodes,
		onClearEnrollment
	}: AccountWidgetCommonProps & {
		credentials?: AccountTotpCredential[];
		backupCodes?: { total: number; remaining: number };
		enrollment?: Enrollment | null;
		/** The tenant lets people add authenticator apps (login or account linking enabled). */
		managementEnabled?: boolean;
		/**
		 * `totp:add`, `totp:activate:<credentialId>`, `totp:backup-codes` or `totp:<id>` while that
		 * action runs.
		 */
		actionLoading?: string;
		onStartEnrollment: (label: string) => void;
		onActivateEnrollment: (code: string) => void;
		onDeleteCredential: (id: string, code: string) => void;
		onRegenerateBackupCodes: (code: string) => void;
		onClearEnrollment: () => void;
	} = $props();

	let newLabel = $state('');

	const hasActiveCredential = $derived(
		credentials.some((credential) => credential.status === 'active')
	);
	const available = $derived(
		loading || managementEnabled || credentials.length > 0 || Boolean(enrollment)
	);
	const subHeadingLevel = $derived(headingLevel === 2 ? 3 : 4);

	function startEnrollment(event: SubmitEvent) {
		event.preventDefault();
		onStartEnrollment(newLabel);
		newLabel = '';
	}
</script>

{#if available || headingLevel === 2}
	<AccountWidgetPanel
		title={title || $LL.account_totp()}
		{headingLevel}
		busy={loading}
		{refreshing}
		{error}
		{reauthNeeded}
		{onRefresh}
		{onReauthenticate}
	>
		{#if loading}
			<AccountSectionSkeleton variant="form-list" rows={1} showAction />
		{:else if available}
			{#if managementEnabled}
				<form class="add-form" onsubmit={startEnrollment}>
					<Input
						label={$LL.account_totpName()}
						bind:value={newLabel}
						disabled={actionLoading === 'totp:add'}
						maxlength={100}
					/>
					<Button variant="primary" type="submit" loading={actionLoading === 'totp:add'}>
						{$LL.account_addTotp()}
					</Button>
				</form>
			{/if}

			{#if enrollment}
				<AccountTotpEnrollment
					{enrollment}
					headingLevel={subHeadingLevel}
					{actionLoading}
					onActivate={onActivateEnrollment}
					onClear={onClearEnrollment}
				/>
			{/if}

			{#if hasActiveCredential}
				<AccountTotpRegenerate
					{backupCodes}
					{actionLoading}
					onRegenerate={onRegenerateBackupCodes}
				/>
			{/if}

			{#if credentials.length === 0}
				<p class="empty-text">{$LL.account_empty()}</p>
			{:else}
				<AccountTotpCredentialList {credentials} {actionLoading} onDelete={onDeleteCredential} />
			{/if}
		{/if}
	</AccountWidgetPanel>
{/if}

<style>
	.add-form {
		display: grid;
		gap: 8px;
	}

	.empty-text {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}
</style>
