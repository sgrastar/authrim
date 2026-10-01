<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '../icons/Icon.svelte';
	import type { IconName } from '../icons/icons';

	/**
	 * One setting: what it is on the start side, its control on the end side.
	 * The control decides the save model — Toggle for immediate effect, Checkbox/inputs for
	 * values confirmed with a SaveBar.
	 * Rows bring their own padding and dividers, so they go in a `flush` Card. `bare` drops
	 * both, for a single row inside something that is already padded (the setup card).
	 */
	interface Props {
		title: string;
		description?: string;
		icon?: IconName;
		/** Extra marks next to the title (badges). */
		meta?: Snippet;
		/** The control. */
		children?: Snippet;
		/** No padding or divider of its own. */
		bare?: boolean;
	}

	let { title, description, icon, meta, children, bare = false }: Props = $props();
</script>

<div class="setting-row" class:setting-row--bare={bare}>
	{#if icon}<span class="setting-row__icon"><Icon name={icon} /></span>{/if}
	<div class="setting-row__body">
		<div class="setting-row__title">
			{title}{#if meta}{@render meta()}{/if}
		</div>
		{#if description}<p class="setting-row__desc">{description}</p>{/if}
	</div>
	{#if children}<div class="setting-row__control">{@render children()}</div>{/if}
</div>

<style>
	.setting-row {
		display: flex;
		align-items: flex-start;
		gap: 14px;
		padding: var(--box-head-pad-y) var(--box-pad);
		border-bottom: 1px solid var(--border-subtle);
	}

	.setting-row:last-child {
		border-bottom: 0;
	}

	.setting-row--bare {
		padding: 0;
		border-bottom: 0;
	}

	.setting-row__icon {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		width: 34px;
		height: 34px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		background: var(--bg-subtle);
		color: var(--text-secondary);
		--icon-size: var(--icon-lg);
	}

	.setting-row__body {
		min-width: 0;
		flex: 1;
	}

	.setting-row__title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-size: var(--fs-control);
		font-weight: var(--fw-semibold);
	}

	.setting-row__desc {
		margin: 3px 0 0;
		font-size: var(--fs-label);
		color: var(--text-secondary);
	}

	.setting-row__control {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 10px;
	}

	@media (max-width: 640px) {
		.setting-row {
			flex-wrap: wrap;
		}

		.setting-row__control {
			width: 100%;
		}
	}
</style>
