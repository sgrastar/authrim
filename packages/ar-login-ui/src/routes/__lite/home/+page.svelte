<script lang="ts">
	import LiteShell from '#lib/lite/LiteShell.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<LiteShell title={data.title} brandName={data.brandName} logo={data.logo}>
	<h1>{data.brandName}</h1>
	<p>
		{data.signedIn}
		{#if data.email}<strong>{data.email}</strong>{/if}
	</p>
	{#if data.accountHref}<p><a href={data.accountHref}>{data.accountLabel}</a></p>{/if}
</LiteShell>
