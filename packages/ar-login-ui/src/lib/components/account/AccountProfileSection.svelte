<script lang="ts">
	import { Button, Card, Input } from '$lib/components';
	import AccountSectionSkeleton from './AccountSectionSkeleton.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import type { AccountProfile } from '$lib/api/account';

	let {
		profile,
		loading = false,
		saving = false,
		error = '',
		saved = false,
		emailChangeStage = 'idle',
		emailChangeLoading = false,
		emailChangeError = '',
		title = '',
		onSave,
		onStartEmailChange,
		onCompleteEmailChange,
		onCancelEmailChange
	} = $props<{
		profile: AccountProfile | null;
		loading?: boolean;
		saving?: boolean;
		error?: string;
		saved?: boolean;
		emailChangeStage?: 'idle' | 'editing' | 'challenge' | 'processing' | 'completed';
		emailChangeLoading?: boolean;
		emailChangeError?: string;
		title?: string;
		onSave: (name: string) => void;
		onStartEmailChange: (email: string) => void;
		onCompleteEmailChange: (code: string) => void;
		onCancelEmailChange: () => void;
	}>();
	let name = $derived(profile?.name ?? '');
	let newEmail = $state('');
	let verificationCode = $state('');
	let editingEmail = $state(false);
	let changingEmail = $derived(editingEmail || emailChangeStage !== 'idle');

	function submit() {
		onSave(name);
	}

	function beginEmailEdit() {
		newEmail = '';
		verificationCode = '';
		editingEmail = true;
	}

	function cancelEmailEdit() {
		editingEmail = false;
		newEmail = '';
		verificationCode = '';
		onCancelEmailChange();
	}
</script>

<Card>
	<div class="account-panel" aria-busy={loading}>
		<div class="panel-heading">
			<h2>{title || $LL.account_profileTitle()}</h2>
		</div>
		{#if loading}
			<AccountSectionSkeleton variant="profile" />
		{:else}
			<dl class="profile-list">
				<div>
					<dt>{$LL.account_name()}</dt>
					<dd>{profile?.name ?? '-'}</dd>
				</div>
				<div>
					<dt>{$LL.account_email()}</dt>
					<dd class="email-value">
						<span>
							{profile?.email ?? '-'}
							{#if profile?.email_verified}
								<span class="verified">{$LL.account_verified()}</span>
							{/if}
						</span>
						{#if !changingEmail}
							<Button
								variant="ghost"
								size="sm"
								icon
								title={$LL.account_manage()}
								aria-label={$LL.account_manage()}
								disabled={!profile}
								onclick={beginEmailEdit}
							>
								<i class="i-heroicons-pencil-square" aria-hidden="true"></i>
							</Button>
						{/if}
					</dd>
				</div>
			</dl>

			{#if changingEmail}
				<div class="email-change" aria-live="polite">
					{#if emailChangeStage === 'challenge'}
						<p class="panel-status">
							{$LL.account_reauthEmailCodeSent({ email: newEmail })}
						</p>
						<Input
							label={$LL.account_reauthEmailCodePlaceholder()}
							bind:value={verificationCode}
							inputmode="numeric"
							autocomplete="one-time-code"
							pattern="[0-9]{6}"
							maxlength={6}
							disabled={emailChangeLoading}
						/>
						<div class="email-change-actions">
							<Button
								variant="primary"
								loading={emailChangeLoading}
								disabled={!/^\d{6}$/u.test(verificationCode)}
								onclick={() => onCompleteEmailChange(verificationCode)}
							>
								{$LL.account_reauthVerifyEmailCode()}
							</Button>
							<Button variant="secondary" disabled={emailChangeLoading} onclick={cancelEmailEdit}>
								{$LL.dialog_cancel()}
							</Button>
						</div>
					{:else if emailChangeStage === 'processing'}
						<p class="panel-status">{$LL.common_loading()}</p>
					{:else if emailChangeStage === 'completed'}
						<p class="panel-success">{$LL.common_complete()}</p>
						<Button variant="secondary" onclick={cancelEmailEdit}>{$LL.dialog_close()}</Button>
					{:else}
						<Input
							label={$LL.common_email()}
							type="email"
							bind:value={newEmail}
							autocomplete="email"
							maxlength={320}
							disabled={emailChangeLoading}
						/>
						<div class="email-change-actions">
							<Button
								variant="primary"
								loading={emailChangeLoading}
								disabled={!newEmail.trim()}
								onclick={() => onStartEmailChange(newEmail)}
							>
								{$LL.common_continue()}
							</Button>
							<Button variant="secondary" disabled={emailChangeLoading} onclick={cancelEmailEdit}>
								{$LL.dialog_cancel()}
							</Button>
						</div>
					{/if}
					{#if emailChangeError}
						<p class="panel-error">{emailChangeError}</p>
					{/if}
				</div>
			{/if}

			<form
				class="name-form"
				onsubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<Input label={$LL.account_editName()} bind:value={name} disabled={saving} maxlength={100} />
				{#if error}
					<p class="panel-error">{error}</p>
				{:else if saved}
					<p class="panel-success">{$LL.account_saved()}</p>
				{/if}
				<Button variant="primary" type="submit" loading={saving} disabled={!profile}>
					{$LL.account_save()}
				</Button>
			</form>
		{/if}
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

	.profile-list {
		display: grid;
		gap: 12px;
		margin: 0;
	}

	.profile-list div {
		display: grid;
		gap: 4px;
	}

	.email-value {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	dt {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	dd {
		margin: 0;
		font-size: 0.9375rem;
		overflow-wrap: anywhere;
	}

	.verified {
		display: inline-flex;
		margin-inline-start: 8px;
		font-size: 0.75rem;
		color: var(--success);
	}

	.name-form,
	.email-change {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.email-change {
		padding-block: 4px;
	}

	.email-change :global(.form-group),
	.name-form :global(.form-group) {
		margin-bottom: 0;
	}

	.email-change-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.panel-error,
	.panel-success,
	.panel-status {
		margin: 0;
		font-size: 0.8125rem;
	}

	.panel-error {
		color: var(--danger);
	}

	.panel-success {
		color: var(--success);
	}

	.panel-status {
		color: var(--text-muted);
	}
</style>
