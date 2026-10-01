<script lang="ts">
	import '$lib/ui/styles.css';
	import { onMount, untrack } from 'svelte';
	import { i18n } from '$lib/i18n/i18n.svelte';
	import { theme } from '$lib/ui/theme/theme.svelte';
	import Toaster from '$lib/ui/toast/Toaster.svelte';

	let { data, children } = $props();

	// Set before the first render so server and client agree on the language. SSR renders
	// synchronously, so the module-level locale cannot leak between concurrent requests.
	i18n.set(untrack(() => data.locale));
	onMount(() => theme.start());
</script>

{@render children()}
<Toaster />
