<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '../icons/Icon.svelte';
	import type { IconName } from '../icons/icons';

	interface Props {
		tone?: 'info' | 'warning' | 'danger';
		title?: string;
		icon?: IconName;
		/** Announce to assistive tech when it appears (errors after an action). */
		live?: boolean;
		children: Snippet;
	}

	let { tone = 'info', title, icon, live = false, children }: Props = $props();
	const defaultIcon: Record<string, IconName> = {
		info: 'info',
		warning: 'warning',
		danger: 'warning'
	};
</script>

<div class="callout callout--{tone}" role={live ? 'alert' : undefined}>
	<Icon name={icon ?? defaultIcon[tone]} />
	<div class="callout__body">
		{#if title}<p class="callout__title">{title}</p>{/if}
		<div>{@render children()}</div>
	</div>
</div>

<style>
	.callout {
		display: flex;
		gap: 12px;
		padding: var(--note-pad-y) var(--note-pad-x);
		border: 1px solid color-mix(in srgb, var(--info) 24%, transparent);
		border-radius: var(--radius-control);
		background: var(--info-bg);
		color: var(--info-text);
		font-size: var(--fs-body);
		--icon-size: var(--icon-lg);
	}

	.callout > :global(svg) {
		margin-top: 1px;
	}

	.callout--warning {
		border-color: color-mix(in srgb, var(--warning) 24%, transparent);
		background: var(--warning-bg);
		color: var(--warning-text);
	}

	.callout--danger {
		border-color: color-mix(in srgb, var(--danger) 24%, transparent);
		background: var(--danger-bg);
		color: var(--danger);
	}

	.callout__body {
		min-width: 0;
	}

	.callout__title {
		margin: 0 0 2px;
		font-weight: var(--fw-semibold);
	}
</style>
