<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '../icons/Icon.svelte';
	import type { IconName } from '../icons/icons';

	interface Props {
		icon?: IconName;
		title: string;
		description?: string;
		/** The one next step (create, invite, connect). */
		action?: Snippet;
	}

	let { icon = 'stack', title, description, action }: Props = $props();
</script>

<div class="empty">
	<span class="empty__icon"><Icon name={icon} /></span>
	<p class="empty__title">{title}</p>
	{#if description}<p class="empty__desc">{description}</p>{/if}
	{#if action}<div class="empty__action">{@render action()}</div>{/if}
</div>

<style>
	.empty {
		display: grid;
		justify-items: center;
		gap: 6px;
		padding: 40px 20px;
		text-align: center;
	}

	.empty__icon {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		margin-bottom: 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-subtle);
		color: var(--text-secondary);
		--icon-size: var(--icon-xl);
	}

	.empty__title {
		margin: 0;
		font-size: var(--fs-heading);
		font-weight: var(--fw-semibold);
	}

	.empty__desc {
		max-width: 46ch;
		margin: 0;
		font-size: var(--fs-body);
		color: var(--text-secondary);
	}

	.empty__action {
		margin-top: 10px;
	}
</style>
