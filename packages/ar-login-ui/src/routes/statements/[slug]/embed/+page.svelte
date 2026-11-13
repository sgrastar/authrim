<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const statement = $derived(data.statement);
</script>

<svelte:head>
	<title>{statement.title}</title>
	<!-- The text's links open outside the frame. -->
	<base target="_blank" />
</svelte:head>

{#if statement.kind === 'missing'}
	<p class="statement-embed">{statement.message ?? statement.title}</p>
{:else if statement.html}
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized (runtime-consent-html) -->
	<div class="statement-embed" lang={statement.language}>{@html statement.html}</div>
{:else if statement.external}
	<p class="statement-embed">
		<a href={statement.external.href} rel="noopener noreferrer">{statement.external.label}</a>
	</p>
{/if}

<style>
	:global(html) {
		color-scheme: light dark;
	}

	:global(body) {
		margin: 0;
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			sans-serif;
		font-size: 0.875rem;
		line-height: 1.7;
		color: CanvasText;
		background: Canvas;
	}

	.statement-embed {
		margin: 0;
		padding: 0.75rem 0.875rem;
		overflow-wrap: anywhere;
	}

	.statement-embed :global(p) {
		margin: 0 0 0.75em;
	}

	.statement-embed :global(p:last-child) {
		margin-bottom: 0;
	}

	.statement-embed :global(a) {
		color: LinkText;
	}
</style>
