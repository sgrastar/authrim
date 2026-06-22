<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Spinner } from '$lib/components';
	import AccountProfileSection from '$lib/components/account/AccountProfileSection.svelte';
	import AccountSecuritySection from '$lib/components/account/AccountSecuritySection.svelte';
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
				<AccountProfileSection user={$auth.user} />
				<AccountSecuritySection />
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

	h1 {
		margin: 0;
	}

	h1 {
		font-size: 1.75rem;
	}

	.account-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 16px;
	}
</style>
