<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title?: string;
		description?: string;
		children: Snippet;
		actions?: Snippet;
	}

	let { title, description, children, actions }: Props = $props();
</script>

<section class="admin-section">
	{#if title || description || actions}
		<header class="admin-section__header">
			<div>
				{#if title}
					<h2 class="admin-section__title">{title}</h2>
				{/if}
				{#if description}
					<p class="admin-section__description">{description}</p>
				{/if}
			</div>
			{#if actions}
				<div class="admin-section__actions">
					{@render actions()}
				</div>
			{/if}
		</header>
	{/if}

	{@render children()}
</section>

<style>
	.admin-section {
		margin-block: var(--section-margin-block, 22px);
	}

	.admin-section__header {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 18px;
		margin-bottom: var(--section-header-margin-bottom, 14px);
		padding-top: var(--section-title-padding-top, 0);
		border-top: var(--section-title-border-top, 0);
		border-bottom: var(--section-title-border-bottom, 0);
	}

	.admin-section__title {
		margin: 0;
		color: var(--section-title-color, var(--color-text));
		font-family: var(--section-title-font, var(--font-display));
		font-size: var(--section-title-size, 1rem);
		font-weight: var(--section-title-weight, 700);
		line-height: 1.35;
		letter-spacing: var(--section-title-letter-spacing, 0);
	}

	.admin-section__description {
		margin: 4px 0 0;
		color: var(--color-text-muted);
		font-size: 0.85rem;
	}

	.admin-section__actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}
</style>
