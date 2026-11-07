<script lang="ts">
	import LiteShell from '#lib/lite/LiteShell.svelte';
	import LiteRelay from '#lib/lite/LiteRelay.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	{#if data.page === 'wait'}
		<!-- The account is still being made: the page asks again by itself (no script). -->
		<meta http-equiv="refresh" content={String(data.refreshSeconds)} />
	{/if}
</svelte:head>

<LiteShell title={data.title} brandName={data.brandName} logo={data.logo}>
	{#if data.page === 'relay'}
		<LiteRelay target={data.relay} continueLabel={data.continueLabel} />
	{:else if data.page === 'wait'}
		<h1>{data.title}</h1>
		<p role="status">{data.message}</p>
	{:else}
		<h1>{data.title}</h1>
		<p role="alert">{data.message}</p>
		{#if data.restart}
			<!-- The sign-in page's request, started again (its Flow waits for this sign-in). -->
			<form method="post" action={data.restart.action}>
				<input type="hidden" name="txn" value={data.restart.txnId} />
				<input type="hidden" name="csrf" value={data.restart.csrfToken} />
				<button type="submit">{data.back}</button>
			</form>
		{:else}
			<p><a href={data.backHref}>{data.back}</a></p>
		{/if}
	{/if}
</LiteShell>
