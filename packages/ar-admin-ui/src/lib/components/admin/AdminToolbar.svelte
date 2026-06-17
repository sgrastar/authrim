<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
</script>

<div class="admin-toolbar">
	{@render children()}
</div>

<style>
	.admin-toolbar {
		display: flex;
		align-items: flex-end;
		gap: var(--toolbar-gap, 22px);
		flex-wrap: wrap;
		padding: var(--toolbar-padding, 14px 0);
		margin-bottom: var(--toolbar-margin-bottom, 18px);
		background: var(--toolbar-bg, transparent);
		border-top: var(--toolbar-border-top, 1px solid var(--color-border-strong));
		border-bottom: var(--toolbar-border-bottom, 1px solid var(--color-border));
		border-radius: var(--toolbar-radius, 0);
		box-shadow: var(--toolbar-shadow, none);
	}

	.admin-toolbar :global(.admin-field) {
		display: grid;
		gap: 5px;
		min-width: 0;
	}

	.admin-toolbar :global(.admin-field--search) {
		flex: 1 1 280px;
	}

	.admin-toolbar :global(.admin-field--compact) {
		flex: 0 0 auto;
		min-width: 140px;
	}

	.admin-toolbar :global(.admin-field__label) {
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--field-label-size, 0.68rem);
		font-weight: 700;
		letter-spacing: var(--field-label-letter-spacing, 0.16em);
		text-transform: uppercase;
		color: var(--color-text-subtle);
	}

	.admin-toolbar :global(.admin-input),
	.admin-toolbar :global(.admin-select) {
		width: 100%;
		min-height: var(--control-height, 38px);
		padding: var(--toolbar-control-padding, var(--control-padding, 8px 12px));
		border: var(--toolbar-control-border, 1px solid var(--color-border));
		border-bottom: var(
			--toolbar-control-border-bottom,
			var(--toolbar-control-border, 1px solid var(--color-border))
		);
		border-radius: var(--toolbar-control-radius, var(--radius-control));
		background: var(--toolbar-control-bg, var(--control-bg, var(--color-surface)));
		color: var(--color-text);
		font: inherit;
		outline: none;
	}

	.admin-toolbar :global(.admin-input:focus),
	.admin-toolbar :global(.admin-select:focus) {
		border-color: var(--toolbar-control-focus-border, var(--color-accent));
		border-bottom-color: var(--toolbar-control-focus-border, var(--color-accent));
		box-shadow: var(--toolbar-control-focus-shadow, 0 0 0 3px var(--color-accent-muted));
	}

	@media (max-width: 720px) {
		.admin-toolbar {
			align-items: stretch;
		}

		.admin-toolbar :global(.admin-field),
		.admin-toolbar :global(.admin-field--compact) {
			flex: 1 1 100%;
		}
	}
</style>
