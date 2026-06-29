<script lang="ts">
	import { Button, Card, Input } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import type { AccountDevice, AccountPasskey, AccountSession } from '$lib/api/account';
	import { formatTimestamp } from '$lib/utils/date';

	let {
		devices = [],
		sessions = [],
		passkeys = [],
		loading = false,
		actionLoading = '',
		error = '',
		reauthNeeded = false,
		passkeySupported = false,
		onRefresh,
		onRevokeSession,
		onAddPasskey,
		onDeletePasskey,
		onReauth
	} = $props<{
		devices?: AccountDevice[];
		sessions?: AccountSession[];
		passkeys?: AccountPasskey[];
		loading?: boolean;
		actionLoading?: string;
		error?: string;
		reauthNeeded?: boolean;
		passkeySupported?: boolean;
		onRefresh: () => void;
		onRevokeSession: (id: string) => void;
		onAddPasskey: (deviceName: string) => void;
		onDeletePasskey: (id: string) => void;
		onReauth: () => void;
	}>();

	let newPasskeyName = $state('');

	function addPasskey() {
		onAddPasskey(newPasskeyName);
		newPasskeyName = '';
	}
</script>

<Card>
	<div class="account-panel">
		<div class="panel-heading">
			<h2>{$LL.account_securityTitle()}</h2>
			<Button variant="ghost" size="sm" {loading} onclick={onRefresh}>
				{$LL.account_refresh()}
			</Button>
		</div>

		{#if error}
			<p class="panel-error">{error}</p>
			{#if reauthNeeded}
				<Button variant="secondary" size="sm" onclick={onReauth}>{$LL.account_reauth()}</Button>
			{/if}
		{/if}

		<section class="security-block">
			<h3>{$LL.account_devices()}</h3>
			{#if devices.length === 0}
				<p class="empty-text">{$LL.account_empty()}</p>
			{:else}
				<ul class="item-list">
					{#each devices as device (device.id)}
						<li>
							<div>
								<strong>
									{device.display_name || device.fallback_display_name || device.id}
									{#if device.current}
										<span class="inline-tag">{$LL.account_currentDevice()}</span>
									{/if}
								</strong>
								<span>{device.platform} / {formatTimestamp(device.last_seen_at_unix)}</span>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="security-block">
			<h3>{$LL.account_sessions()}</h3>
			{#if sessions.length === 0}
				<p class="empty-text">{$LL.account_empty()}</p>
			{:else}
				<ul class="item-list">
					{#each sessions as session (session.id)}
						<li>
							<div>
								<strong>{session.current ? $LL.account_currentSession() : session.id}</strong>
								<span>{formatTimestamp(session.created_at)}</span>
							</div>
							<Button
								variant={session.current ? 'danger' : 'secondary'}
								size="sm"
								loading={actionLoading === `session:${session.id}`}
								onclick={() => onRevokeSession(session.id)}
							>
								{session.current ? $LL.header_logout() : $LL.account_logoutSession()}
							</Button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="security-block">
			<h3>{$LL.account_passkeys()}</h3>
			<form
				class="add-passkey"
				onsubmit={(event) => {
					event.preventDefault();
					addPasskey();
				}}
			>
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
				<p class="empty-text">{$LL.account_empty()}</p>
			{:else}
				<ul class="item-list">
					{#each passkeys as passkey (passkey.id)}
						<li>
							<div>
								<strong>{passkey.device_name ?? passkey.id}</strong>
								{#if passkey.provider?.name || passkey.aaguid}
									<span class="passkey-provider">
										{#if passkey.provider?.icon_light}
											<img src={passkey.provider.icon_light} alt="" loading="lazy" />
										{/if}
										{passkey.provider?.name ?? passkey.aaguid}
									</span>
								{/if}
								<span>{formatTimestamp(passkey.last_used_at ?? passkey.created_at)}</span>
							</div>
							<Button
								variant="danger"
								size="sm"
								loading={actionLoading === `passkey:${passkey.id}`}
								onclick={() => onDeletePasskey(passkey.id)}
							>
								{$LL.account_delete()}
							</Button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="security-block planned">
			<h3>{$LL.account_socialAccounts()}</h3>
			<p class="muted">{$LL.account_planned()}</p>
		</section>
	</div>
</Card>

<style>
	.account-panel {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.panel-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	h2 {
		margin: 0;
		font-size: 1rem;
	}

	h3 {
		margin: 0 0 10px;
		font-size: 0.9375rem;
	}

	.security-block {
		display: grid;
		gap: 10px;
		padding-top: 4px;
	}

	.add-passkey {
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

	.item-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 0;
		border-top: 1px solid var(--border);
	}

	.item-list strong,
	.item-list span {
		display: block;
		overflow-wrap: anywhere;
	}

	.item-list strong {
		font-size: 0.875rem;
	}

	.item-list span,
	.muted,
	.empty-text {
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.passkey-provider {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 3px;
	}

	.passkey-provider img {
		width: 18px;
		height: 18px;
		border-radius: 4px;
		object-fit: contain;
	}

	.panel-error {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--danger);
	}

	.inline-tag {
		display: inline-flex;
		margin-left: 8px;
		font-size: 0.75rem;
		color: var(--success);
	}

	.planned {
		opacity: 0.75;
	}
</style>
