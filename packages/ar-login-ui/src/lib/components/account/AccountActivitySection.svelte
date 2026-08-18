<script lang="ts">
	import { Card } from '$lib/components';
	import AccountSectionSkeleton from './AccountSectionSkeleton.svelte';
	import type { AccountOperation } from '$lib/api/account';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import { formatTimestamp } from '$lib/utils/date';

	let {
		operations = [],
		loading = false,
		title = ''
	} = $props<{
		operations?: AccountOperation[];
		loading?: boolean;
		title?: string;
	}>();

	function formatAction(action: string): string {
		const ja = getLocale() === 'ja';
		switch (action) {
			case 'account.profile.name_updated':
				return $LL.account_operationNameUpdated();
			case 'account.email.added':
				return ja ? 'メールアドレスを追加' : 'Email added';
			case 'account.email.changed':
				return ja ? 'メールアドレスを変更' : 'Email changed';
			case 'account.email.reauthenticated':
				return ja ? 'メールで再認証' : 'Re-authenticated by email';
			case 'account.device.updated':
				return ja ? '端末名を変更' : 'Device renamed';
			case 'account.device.unlinked':
				return ja ? '端末を解除' : 'Device unlinked';
			case 'account.passkey.created':
				return $LL.account_operationPasskeyCreated();
			case 'account.passkey.updated':
				return $LL.account_operationPasskeyUpdated();
			case 'account.passkey.deleted':
				return $LL.account_operationPasskeyDeleted();
			case 'account.passkey.reauthenticated':
				return ja ? 'Passkeyで再認証' : 'Re-authenticated by Passkey';
			case 'account.totp.enrollment_started':
				return ja ? '認証アプリの設定を開始' : 'Authenticator setup started';
			case 'account.totp.activated':
				return ja ? '認証アプリを有効化' : 'Authenticator activated';
			case 'account.totp.updated':
				return ja ? '認証アプリ名を変更' : 'Authenticator renamed';
			case 'account.totp.removed':
				return ja ? '認証アプリを削除' : 'Authenticator removed';
			case 'account.totp.backup_codes_regenerated':
				return ja ? 'バックアップコードを再生成' : 'Backup codes regenerated';
			case 'account.totp.reauthenticated':
				return ja ? '認証アプリで再認証' : 'Re-authenticated by authenticator';
			case 'account.session.revoked':
				return $LL.account_operationSessionRevoked();
			default:
				return action;
		}
	}
</script>

<Card>
	<section class="activity-panel" aria-busy={loading}>
		<h2>{title || $LL.account_activityTitle()}</h2>
		{#if loading}
			<AccountSectionSkeleton variant="activity" rows={3} />
		{:else if operations.length === 0}
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
