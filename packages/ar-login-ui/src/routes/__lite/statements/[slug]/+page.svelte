<script lang="ts">
	import LiteShell from '#lib/lite/LiteShell.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const statement = $derived(data.statement);
</script>

<LiteShell title={statement.title} brandName={data.brandName} logo={data.logo}>
	{#if statement.kind === 'missing'}
		<h1>{statement.title}</h1>
		{#if statement.message}<p role="alert">{statement.message}</p>{/if}
	{:else}
		<article lang={statement.language}>
			<h1>{statement.title}</h1>
			<p>
				{statement.versionLabel}{#if statement.isCurrent}
					({statement.currentLabel}){/if}
			</p>
			{#if statement.older}
				<p>{statement.older.message} <a href={statement.older.href}>{statement.older.label}</a></p>
			{/if}
			{#if statement.description}<p>{statement.description}</p>{/if}
			{#if statement.html}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized (runtime-consent-html) -->
				<div class="statement-page-body">{@html statement.html}</div>
			{:else if statement.external}
				<p>{statement.external.message}</p>
				<p>
					<a href={statement.external.href} target="_blank" rel="noopener noreferrer"
						>{statement.external.label}</a
					>
				</p>
			{/if}
			{#if statement.versions}
				<h2>{statement.versions.title}</h2>
				<ul>
					{#each statement.versions.items as item (item.label)}
						<li>
							{#if item.href}<a href={item.href}>{item.label}</a>{:else}<span aria-current="page"
									>{item.label}</span
								>{/if}{#if item.current}
								({statement.currentLabel}){/if}
						</li>
					{/each}
				</ul>
			{/if}
		</article>
	{/if}
</LiteShell>
