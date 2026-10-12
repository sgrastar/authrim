<script lang="ts">
	// The login route as the layout mounts it: with the Login UI stores in context.
	import type { ComponentProps } from 'svelte';
	import LoginPage from '../../routes/login/+page.svelte';
	import { initializeLoginUIStores } from '$lib/stores/login-ui-context';

	let { data }: { data: unknown } = $props();
	initializeLoginUIStores();
</script>

<LoginPage data={data as ComponentProps<typeof LoginPage>['data']} />
