<script lang="ts">
	import { guide } from './guide.svelte';
	import GuideSteps from './GuideSteps.svelte';

	/** The list of steps of whatever guide is running; nothing while none is. */
	const item = $derived(guide.activeItem);
</script>

{#if item}
	<GuideSteps {item} index={guide.activeIndex} onstop={() => guide.stop()} />
{/if}
