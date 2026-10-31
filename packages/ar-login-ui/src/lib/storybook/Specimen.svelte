<script lang="ts">
	/**
	 * One catalog entry: what it is, the class or component behind it, where it appears and when,
	 * and the live element. Captions use the page's own muted colour so they follow the theme.
	 */
	import type { Snippet } from 'svelte';

	type Props = {
		name: string;
		/** CSS class or component the element is built from. */
		source: string;
		/** Routes or components that show it, and the condition when there is one. */
		where?: string;
		children: Snippet;
		/** Give the specimen a column the width of a login card. */
		card?: boolean;
	};

	let { name, source, where = '', children, card = false }: Props = $props();
</script>

<section class="sb-specimen">
	<header>
		<p class="sb-specimen__name">{name}</p>
		<code>{source}</code>
		{#if where}<p>{where}</p>{/if}
	</header>
	<div class="sb-specimen__body" class:sb-specimen__body--card={card}>
		{@render children()}
	</div>
</section>

<style>
	.sb-specimen {
		display: grid;
		grid-template-columns: minmax(180px, 280px) minmax(0, 1fr);
		gap: 20px;
		padding: 16px 0;
		border-top: 1px solid var(--border);
	}

	.sb-specimen:first-child {
		border-top: none;
	}

	.sb-specimen__name {
		margin: 0 0 4px;
		font: 600 0.875rem/1.3 var(--font-body);
		color: var(--text-primary);
	}

	code {
		display: block;
		font: 0.75rem/1.4 var(--font-mono);
		color: var(--text-secondary);
		word-break: break-word;
	}

	p {
		margin: 6px 0 0;
		font: 0.75rem/1.4 var(--font-body);
		color: var(--text-muted);
	}

	.sb-specimen__body {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 12px;
		min-width: 0;
	}

	.sb-specimen__body--card {
		flex-direction: column;
		align-items: stretch;
		max-width: 400px;
	}

	@media (max-width: 720px) {
		.sb-specimen {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
