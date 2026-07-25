<script lang="ts">
	import { Button, Card } from '$lib/components';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { LL } from '$i18n/i18n-svelte';

	const { brandingStore } = useLoginUIStores();

	function handleBackToLogin() {
		window.location.href = '/login';
	}
</script>

<svelte:head>
	<title>{$LL.logout_completeTitle()} - {brandingStore.brandName || $LL.app_title()}</title>
	<meta name="description" content={$LL.logout_completeDescription()} />
</svelte:head>

<div class="auth-page">
	<LanguageSwitcher />

	<div class="auth-container">
		<div class="auth-header">
			<h1 class="auth-header__title">
				{brandingStore.brandName || $LL.app_title()}
			</h1>
			<p class="auth-header__subtitle">
				{$LL.app_subtitle()}
			</p>
		</div>

		<Card class="text-center">
			<div class="auth-icon-badge">
				<div class="auth-icon-badge__circle">
					<div class="i-heroicons-check h-9 w-9 auth-icon-badge__icon"></div>
				</div>
			</div>

			<h2 class="auth-section-title text-center">
				{$LL.logout_completeTitle()}
			</h2>
			<p class="auth-section-subtitle text-center mb-6">
				{$LL.logout_completeDescription()}
			</p>

			<Button variant="primary" class="w-full" onclick={handleBackToLogin}>
				<div class="i-heroicons-arrow-left h-5 w-5"></div>
				{$LL.common_backToLogin()}
			</Button>
		</Card>
	</div>

	<footer class="auth-footer">
		<p>{$LL.footer_stack()}</p>
	</footer>
</div>
