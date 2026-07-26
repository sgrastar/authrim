<script lang="ts">
	import { Button, Card, Input } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import type { AccountProfile } from '$lib/api/account';

	let {
		profile,
		saving = false,
		error = '',
		saved = false,
		title = '',
		onSave
	} = $props<{
		profile: AccountProfile | null;
		saving?: boolean;
		error?: string;
		saved?: boolean;
		title?: string;
		onSave: (name: string) => void;
	}>();
	let name = $derived(profile?.name ?? '');

	function submit() {
		onSave(name);
	}
</script>

<Card>
	<form
		class="account-panel"
		onsubmit={(event) => {
			event.preventDefault();
			submit();
		}}
	>
		<div class="panel-heading">
			<h2>{title || $LL.account_profileTitle()}</h2>
		</div>
		<dl class="profile-list">
			<div>
				<dt>{$LL.account_name()}</dt>
				<dd>{profile?.name ?? '-'}</dd>
			</div>
			<div>
				<dt>{$LL.account_email()}</dt>
				<dd>
					{profile?.email ?? '-'}
					{#if profile?.email_verified}
						<span class="verified">{$LL.account_verified()}</span>
					{/if}
				</dd>
			</div>
		</dl>

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

	.panel-error,
	.panel-success {
		margin: 0;
		font-size: 0.8125rem;
	}

	.panel-error {
		color: var(--danger);
	}

	.panel-success {
		color: var(--success);
	}
</style>
