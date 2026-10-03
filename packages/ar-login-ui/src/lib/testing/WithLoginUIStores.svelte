<script lang="ts">
	/**
	 * For SSR tests: renders a component with the Login UI stores in context, as the route layout
	 * (or `LoginUIFrame` in Storybook) provides them. `setup` can configure the stores first.
	 */
	import { untrack, type Component } from 'svelte';
	import { initializeLoginUIStores, type LoginUIStores } from '$lib/stores/login-ui-context';

	let {
		component: Inner,
		props,
		setup
	}: {
		// Any component under test; its props are checked by the test's own types.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		component: Component<any>;
		props: Record<string, unknown>;
		setup?: (stores: LoginUIStores) => void;
	} = $props();

	const stores = initializeLoginUIStores();
	untrack(() => setup?.(stores));
</script>

<Inner {...props} />
