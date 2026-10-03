<script lang="ts">
	import { onMount } from 'svelte';
	import HomeView from '$lib/views/HomeView.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { fetchAuthenticationMethods } from '$lib/api/authentication-methods';
	import { auth, isAuthenticated } from '$lib/stores/auth';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';

	const { brandingStore } = useLoginUIStores();

	let mounted = $state(false);
	let accountPageEnabled = $state(false);
	let accountPagePath = $state('/account');

	onMount(async () => {
		auth.refresh();

		const [methodsResult] = await Promise.all([
			fetchAuthenticationMethods(),
			auth.refreshFromSession()
		]);
		const selfService = methodsResult.data?.ui.selfService;
		const configuredAccountPath = selfService?.accountPagePath;
		accountPageEnabled = selfService?.accountPageEnabled === true;
		if (accountPageEnabled && configuredAccountPath?.startsWith('/')) {
			accountPagePath = configuredAccountPath;
		}

		// Stagger entrance animation
		requestAnimationFrame(() => {
			mounted = true;
		});
	});
</script>

<svelte:head>
	<title>{brandingStore.brandName || $LL.app_title()} - {$LL.landing_providerBadge()}</title>
	<meta name="description" content={$LL.landing_metaDescription()} />
</svelte:head>

<HomeView
	brandName={brandingStore.brandName}
	isAuthenticated={$isAuthenticated}
	{accountPageEnabled}
	{accountPagePath}
	{mounted}
/>
