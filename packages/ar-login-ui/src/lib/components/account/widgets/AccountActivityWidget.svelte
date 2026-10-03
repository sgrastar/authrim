<script lang="ts">
	/** Recent changes made to the account, newest first, each with its time. */
	import AccountSectionSkeleton from '../AccountSectionSkeleton.svelte';
	import type { AccountOperation } from '$lib/api/account';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import type { TranslationFunctions } from '$i18n/i18n-types';
	import { formatTimestamp, normalizeTimestampToMillis } from '$lib/utils/date';
	import AccountWidgetPanel from './AccountWidgetPanel.svelte';
	import type { AccountWidgetHeadingLevel } from './types';

	let {
		operations = [],
		loading = false,
		title = '',
		headingLevel = 2
	}: {
		operations?: AccountOperation[];
		/** First load: a skeleton instead of the (possibly empty) list. */
		loading?: boolean;
		title?: string;
		headingLevel?: AccountWidgetHeadingLevel;
	} = $props();

	/** The audit action names the account page describes; others are shown as recorded. */
	const ACTION_LABELS: Record<string, (ll: TranslationFunctions) => string> = {
		'account.guest.created': (ll) => ll.account_operationGuestCreated(),
		'account.guest.upgrade_failed': (ll) => ll.account_operationGuestUpgradeFailed(),
		'account.guest.upgrade_started': (ll) => ll.account_operationGuestUpgradeStarted(),
		'account.guest.upgraded': (ll) => ll.account_operationGuestUpgraded(),
		'account.profile.name_updated': (ll) => ll.account_operationNameUpdated(),
		'account.email.added': (ll) => ll.account_operationEmailAdded(),
		'account.email.changed': (ll) => ll.account_operationEmailChanged(),
		'account.email.reauthenticated': (ll) => ll.account_operationEmailReauthenticated(),
		'account.device.updated': (ll) => ll.account_operationDeviceUpdated(),
		'account.device.unlinked': (ll) => ll.account_operationDeviceUnlinked(),
		'account.passkey.created': (ll) => ll.account_operationPasskeyCreated(),
		'account.passkey.updated': (ll) => ll.account_operationPasskeyUpdated(),
		'account.passkey.deleted': (ll) => ll.account_operationPasskeyDeleted(),
		'account.passkey.reauthenticated': (ll) => ll.account_operationPasskeyReauthenticated(),
		'account.totp.enrollment_started': (ll) => ll.account_operationTotpEnrollmentStarted(),
		'account.totp.activated': (ll) => ll.account_operationTotpActivated(),
		'account.totp.updated': (ll) => ll.account_operationTotpUpdated(),
		'account.totp.removed': (ll) => ll.account_operationTotpRemoved(),
		'account.totp.backup_codes_regenerated': (ll) =>
			ll.account_operationTotpBackupCodesRegenerated(),
		'account.totp.reauthenticated': (ll) => ll.account_operationTotpReauthenticated(),
		'account.session.revoked': (ll) => ll.account_operationSessionRevoked()
	};

	function formatAction(action: string): string {
		return Object.hasOwn(ACTION_LABELS, action) ? ACTION_LABELS[action]($LL) : action;
	}

	function isoTime(value: number): string | undefined {
		const millis = normalizeTimestampToMillis(value);
		return millis === null ? undefined : new Date(millis).toISOString();
	}
</script>

<AccountWidgetPanel title={title || $LL.account_activityTitle()} {headingLevel} busy={loading}>
	{#if loading}
		<AccountSectionSkeleton variant="activity" rows={3} />
	{:else if operations.length === 0}
		<p class="empty-text">{$LL.account_empty()}</p>
	{:else}
		<ul>
			{#each operations as operation (operation.id)}
				<li>
					<time datetime={isoTime(operation.created_at)}>
						{formatTimestamp(operation.created_at, getLocale())}
					</time>
					<strong>{formatAction(operation.action)}</strong>
				</li>
			{/each}
		</ul>
	{/if}
</AccountWidgetPanel>

<style>
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

	time,
	.empty-text {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	strong {
		font-size: 0.875rem;
		overflow-wrap: anywhere;
	}
</style>
