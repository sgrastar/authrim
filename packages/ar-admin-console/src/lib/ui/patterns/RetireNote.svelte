<script lang="ts">
	import Card from './Card.svelte';

	/**
	 * Shown on an area scheduled for removal: what must be resolved before it can go.
	 * Keeping the area visible until then prevents the outstanding work from being forgotten.
	 */
	interface Props {
		title: string;
		description: string;
		items: ReadonlyArray<{ title: string; detail: string }>;
		footnote?: string;
	}

	let { title, description, items, footnote }: Props = $props();
</script>

<Card {title} {description} tone="warning">
	<ul class="retire">
		{#each items as item (item.title)}
			<li><strong>{item.title}</strong><span>{item.detail}</span></li>
		{/each}
	</ul>
	{#if footnote}<p class="retire__foot">{footnote}</p>{/if}
</Card>

<style>
	.retire {
		display: grid;
		gap: 12px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	li {
		display: grid;
		gap: 3px;
		font-size: var(--fs-label);
		line-height: var(--lh-relaxed);
		color: var(--text-secondary);
	}

	strong {
		font-size: var(--fs-body);
		color: var(--text-primary);
	}

	.retire__foot {
		margin: 14px 0 0;
		font-size: var(--fs-caption);
		color: var(--text-muted);
	}
</style>
