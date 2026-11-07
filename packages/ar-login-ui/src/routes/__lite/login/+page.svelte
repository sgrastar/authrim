<script lang="ts">
	import LiteStepPage from '#lib/lite/LiteStepPage.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<LiteStepPage {data} {form} />
