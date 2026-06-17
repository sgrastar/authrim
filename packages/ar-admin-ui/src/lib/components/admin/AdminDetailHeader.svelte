<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		description?: string;
		initials?: string;
		meta?: string;
		metaActionLabel?: string;
		onMetaAction?: () => void;
		badges?: Snippet;
		actions?: Snippet;
	}

	let {
		title,
		description,
		initials,
		meta,
		metaActionLabel,
		onMetaAction,
		badges,
		actions
	}: Props = $props();
</script>

<header class="admin-detail-head">
	{#if initials}
		<div class="admin-detail-head__icon" aria-hidden="true">{initials}</div>
	{/if}

	<div class="admin-detail-head__main">
		<div class="admin-detail-head__title-row">
			<h1>{title}</h1>
			{#if badges}
				<div class="admin-detail-head__badges">
					{@render badges()}
				</div>
			{/if}
		</div>

		{#if meta}
			<div class="admin-detail-head__meta">
				<span>{meta}</span>
				{#if metaActionLabel && onMetaAction}
					<button type="button" onclick={onMetaAction}>{metaActionLabel}</button>
				{/if}
			</div>
		{/if}

		{#if description}
			<p>{description}</p>
		{/if}
	</div>

	{#if actions}
		<div class="admin-detail-head__actions">
			{@render actions()}
		</div>
	{/if}
</header>

<style>
	.admin-detail-head {
		display: flex;
		align-items: flex-start;
		gap: var(--detail-header-gap, 18px);
		margin-bottom: var(--detail-header-margin, 22px);
		min-width: 0;
	}

	.admin-detail-head__icon {
		display: grid;
		place-items: center;
		flex: none;
		width: var(--detail-icon-size, 56px);
		height: var(--detail-icon-size, 56px);
		margin-top: var(--detail-icon-margin-top, 2px);
		border: var(--detail-icon-border, 2px solid var(--color-border-strong));
		border-radius: var(--detail-icon-radius, var(--radius-control));
		background: var(--detail-icon-bg, var(--color-surface-muted));
		color: var(--detail-icon-color, var(--color-text));
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--detail-icon-font-size, 1rem);
		font-weight: 800;
		letter-spacing: 0.02em;
	}

	.admin-detail-head__main {
		min-width: 0;
		flex: 1;
	}

	.admin-detail-head__title-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.admin-detail-head h1 {
		margin: 0;
		font-family: var(--font-display);
		font-size: var(--detail-title-size, var(--page-title-size, 1.65rem));
		font-weight: var(--detail-title-weight, var(--page-title-weight, 700));
		line-height: 1.28;
		letter-spacing: var(--page-title-letter-spacing, 0);
		color: var(--color-text);
	}

	.admin-detail-head__badges {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}

	.admin-detail-head__meta {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin-top: 4px;
		min-width: 0;
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--detail-meta-size, 0.78rem);
		color: var(--color-text-subtle);
		word-break: break-all;
	}

	.admin-detail-head__meta button {
		flex: none;
		border: none;
		background: transparent;
		color: var(--detail-meta-action-color, var(--color-accent));
		font: inherit;
		font-weight: 700;
		letter-spacing: var(--detail-meta-action-letter-spacing, inherit);
		text-transform: var(--detail-meta-action-text-transform, none);
		cursor: pointer;
	}

	.admin-detail-head p {
		margin: 6px 0 0;
		color: var(--color-text-muted);
		font-size: var(--detail-description-size, 0.88rem);
		line-height: 1.65;
	}

	.admin-detail-head__actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 10px;
		flex-wrap: wrap;
		padding-top: var(--detail-actions-padding-top, 8px);
	}

	@media (max-width: 760px) {
		.admin-detail-head {
			flex-wrap: wrap;
		}

		.admin-detail-head__actions {
			justify-content: flex-start;
			width: 100%;
			padding-top: 0;
		}
	}
</style>
