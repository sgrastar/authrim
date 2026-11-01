<script lang="ts">
	import AccountPage from '$lib/components/AccountPage.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<AccountPage
	initialCapabilities={data.accountPageInitial.capabilities}
	initialCapabilitiesResolved={data.accountPageInitial.capabilitiesResolved}
	initialPlacementConditions={data.accountPageInitial.placementConditions}
	initialAuthenticationMethods={data.authenticationMethods ?? null}
/>
