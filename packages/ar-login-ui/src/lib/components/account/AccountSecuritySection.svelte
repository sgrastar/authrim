<script lang="ts">
	import { Button, Card } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
</script>

<Card>
	<div class="account-panel">
		<div class="panel-heading">
			<h2>{$LL.account_securityTitle()}</h2>
		</div>
		<div class="action-list">
			<Button variant="secondary" disabled>{$LL.account_passkeys()}</Button>
			<Button variant="secondary" disabled>{$LL.account_socialAccounts()}</Button>
		</div>
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

	.action-list {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
