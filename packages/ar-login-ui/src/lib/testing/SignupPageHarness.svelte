<script lang="ts">
	// The signup route as the layout mounts it: with the Login UI stores in context.
	import type { ComponentProps } from 'svelte';
	import SignupPage from '../../routes/signup/+page.svelte';
	import { initializeLoginUIStores } from '$lib/stores/login-ui-context';

	let { data }: { data: unknown } = $props();
	initializeLoginUIStores();
</script>

<SignupPage data={data as ComponentProps<typeof SignupPage>['data']} />
