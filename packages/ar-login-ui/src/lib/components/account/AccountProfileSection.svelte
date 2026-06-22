<script lang="ts">
	import { Button, Card } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

	type AccountUser = {
		name?: string | null;
		email?: string | null;
	};

	let { user } = $props<{ user: AccountUser | null | undefined }>();
</script>

<Card>
	<div class="account-panel">
		<div class="panel-heading">
			<h2>{$LL.account_profileTitle()}</h2>
		</div>
		<dl class="profile-list">
			<div>
				<dt>{$LL.account_name()}</dt>
				<dd>{user?.name ?? '-'}</dd>
			</div>
			<div>
				<dt>{$LL.account_email()}</dt>
				<dd>{user?.email ?? '-'}</dd>
			</div>
		</dl>
		<Button variant="secondary" disabled>{$LL.account_manage()}</Button>
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

	dt {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	dd {
		margin: 0;
		font-size: 0.9375rem;
		overflow-wrap: anywhere;
	}
</style>
