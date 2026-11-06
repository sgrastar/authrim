<script lang="ts">
	import LiteShell from '#lib/lite/LiteShell.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<LiteShell title={data.title} brandName={data.brandName} logo={data.logo}>
	<h1>{data.title}</h1>
	<p>{data.message}</p>
	{#if data.code}
		<p class="muted">{data.codeLabel}: <span class="code">{data.code}</span></p>
	{/if}
	<p><a href="/login">{data.back}</a></p>
</LiteShell>
