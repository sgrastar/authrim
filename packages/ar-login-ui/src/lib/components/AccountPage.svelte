<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Card, Spinner } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { auth } from '$lib/stores/auth';
	import { LL } from '$i18n/i18n-svelte';

	let loading = $state(true);
	let logoutLoading = $state(false);

	onMount(async () => {
		await auth.refreshFromSession();
		if (!auth.checkAuth()) {
			const returnTo = `${window.location.pathname}${window.location.search}`;
			window.location.href = `/login?return_to=${encodeURIComponent(returnTo)}`;
			return;
		}
		loading = false;
	});

	async function handleLogout() {
		if (logoutLoading) return;
		logoutLoading = true;
		try {
			await auth.logout();
			window.location.href = '/';
		} catch {
			logoutLoading = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.account_pageTitle()}</title>
</svelte:head>

<div class="account-shell">
	<div class="account-language">
		<LanguageSwitcher />
	</div>

	{#if loading}
		<div class="account-loading">
			<Spinner size="lg" />
		</div>
	{:else}
		<div class="account-layout">
			<header class="account-header">
				<div>
					<p class="account-kicker">Authrim</p>
					<h1>{$LL.account_title()}</h1>
				</div>
				<Button variant="secondary" loading={logoutLoading} onclick={handleLogout}>
					{$LL.header_logout()}
				</Button>
			</header>

			<section class="account-grid">
				<Card>
					<div class="account-panel">
						<div class="panel-heading">
							<h2>{$LL.account_profileTitle()}</h2>
						</div>
						<dl class="profile-list">
							<div>
								<dt>{$LL.account_name()}</dt>
								<dd>{$auth.user?.name ?? '-'}</dd>
							</div>
							<div>
								<dt>{$LL.account_email()}</dt>
								<dd>{$auth.user?.email ?? '-'}</dd>
							</div>
						</dl>
						<Button variant="secondary" disabled>{$LL.account_manage()}</Button>
					</div>
				</Card>

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
			</section>
		</div>
	{/if}
</div>

<style>
	.account-shell {
		min-height: 100vh;
		background: var(--bg-primary);
		color: var(--text-primary);
		padding: 24px;
	}

	.account-language {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 24px;
	}

	.account-loading {
		min-height: 60vh;
		display: grid;
		place-items: center;
	}

	.account-layout {
		width: min(960px, 100%);
		margin: 0 auto;
	}

	.account-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 24px;
	}

	.account-kicker {
		margin: 0 0 4px;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	h1,
	h2 {
		margin: 0;
	}

	h1 {
		font-size: 1.75rem;
	}

	h2 {
		font-size: 1rem;
	}

	.account-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 16px;
	}

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

	.action-list {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
