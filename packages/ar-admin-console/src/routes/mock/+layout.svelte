<script lang="ts">
	// Dev server only. In a production build `import.meta.env.DEV` is false, so this import is
	// removed and the mock app (with its sample data) never reaches the bundle.
	const app = import.meta.env.DEV ? import('$lib/mock/MockApp.svelte') : undefined;
</script>

{#if app}
	{#await app then module}
		{@const MockApp = module.default}
		<MockApp />
	{/await}
{/if}
