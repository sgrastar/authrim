<script lang="ts">
	import LiteAccountPage from '#lib/lite/LiteAccountPage.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<LiteAccountPage {data} {form} />
