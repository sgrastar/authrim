<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		description?: string;
		eyebrow?: string;
		titleAccessory?: Snippet;
		actions?: Snippet;
	}

	let { title, description, eyebrow, titleAccessory, actions }: Props = $props();
</script>

<header class="admin-page__header">
	<div class="admin-page__heading">
		{#if eyebrow}
			<p class="admin-page__eyebrow">{eyebrow}</p>
		{/if}
		<div class="admin-page__title-row">
			<h1 class="admin-page__title">{title}</h1>
			{#if titleAccessory}
				{@render titleAccessory()}
			{/if}
		</div>
		{#if description}
			<p class="admin-page__description">{description}</p>
		{/if}
	</div>

	{#if actions}
		<div class="admin-page__actions">
			{@render actions()}
		</div>
	{/if}
</header>

<style>
	.admin-page__header {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 24px;
		margin-bottom: var(--page-header-margin, 24px);
	}

	.admin-page__heading {
		min-width: 0;
	}

	.admin-page__eyebrow {
		margin: 0 0 6px;
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--page-eyebrow-size, 0.68rem);
		font-weight: 700;
		letter-spacing: var(--page-eyebrow-letter-spacing, 0);
		color: var(--color-warning);
	}

	.admin-page__title-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.admin-page__title {
		margin: 0;
		font-family: var(--font-display);
		font-size: var(--page-title-size, 1.75rem);
		font-weight: var(--page-title-weight, 700);
		line-height: 1.25;
		color: var(--color-text);
		letter-spacing: var(--page-title-letter-spacing, 0);
	}

	.admin-page__description {
		margin: 6px 0 0;
		max-width: 760px;
		color: var(--color-text-muted);
		font-size: var(--page-description-size, 0.9rem);
		line-height: 1.7;
	}

	.admin-page__actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		min-width: 0;
		max-width: 100%;
	}

	@media (max-width: 720px) {
		.admin-page__header {
			align-items: flex-start;
			flex-direction: column;
		}

		.admin-page__actions {
			width: 100%;
		}
	}
</style>
