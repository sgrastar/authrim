<script lang="ts">
	import { getContext, type Snippet } from 'svelte';
	import Icon from '../icons/Icon.svelte';
	import type { IconName } from '../icons/icons';
	import { ITEM_GRID } from './item-grid';

	/**
	 * One item of a short collection shown as cards (passkeys, plugins, connected devices):
	 * icon, name and marks on top, its actions at the end (icon buttons, or a Toggle when
	 * switching it on or off applies at once), a sentence on what it is, a few facts, and a
	 * footer for its state and one follow-up action. For long or sortable collections use
	 * DataTable instead.
	 */
	interface Props {
		title: string;
		icon?: IconName;
		/**
		 * A picture instead of the icon: a product logo (social sign-in, plugins). Shown on a
		 * neutral tile, never cropped. It sits next to the name, so it is decorative by default;
		 * give `imageAlt` only if it says something the name does not.
		 */
		image?: string;
		imageAlt?: string;
		/** Heading level of the title; h3 inside a titled Card. */
		level?: 3 | 4;
		/** Marks next to the title (badges). */
		meta?: Snippet;
		/** Actions for this item (icon buttons, or a Toggle for on/off that applies at once). */
		actions?: Snippet;
		/** One or two sentences on what the item is. */
		description?: string;
		/** Facts about the item: a small DetailList or a row of badges. */
		children?: Snippet;
		/** Under a rule at the bottom: the item's state on the start side, one action at the end. */
		footer?: Snippet;
	}

	let {
		title,
		icon,
		image,
		imageAlt = '',
		level = 3,
		meta,
		actions,
		description,
		children,
		footer
	}: Props = $props();

	const inGrid = getContext<boolean | undefined>(ITEM_GRID) === true;
</script>

<svelte:element this={inGrid ? 'li' : 'article'} class="item-card">
	<div class="item-card__head">
		{#if image}
			<span class="item-card__icon item-card__icon--image">
				<img src={image} alt={imageAlt} loading="lazy" decoding="async" />
			</span>
		{:else if icon}
			<span class="item-card__icon"><Icon name={icon} /></span>
		{/if}
		<div class="item-card__titles">
			<svelte:element this={`h${level}`} class="item-card__title">{title}</svelte:element>
			{#if meta}<div class="item-card__meta">{@render meta()}</div>{/if}
		</div>
		{#if actions}<div class="item-card__actions">{@render actions()}</div>{/if}
	</div>
	{#if description}<p class="item-card__desc">{description}</p>{/if}
	{#if children}<div class="item-card__body">{@render children()}</div>{/if}
	{#if footer}<div class="item-card__foot">{@render footer()}</div>{/if}
</svelte:element>

<style>
	.item-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
		padding: var(--tile-pad);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
	}

	.item-card__head {
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}

	.item-card__icon {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-control);
		background: var(--bg-subtle);
		color: var(--text-secondary);
		--icon-size: var(--icon-lg);
	}

	/* Logos keep their own colours: a light neutral tile in every theme, the logo contained. */
	.item-card__icon--image {
		overflow: hidden;
		padding: 5px;
		border: 1px solid var(--border-subtle);
		background: var(--logo-tile);
	}

	.item-card__icon--image img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.item-card__titles {
		display: grid;
		flex: 1;
		gap: 6px;
		min-width: 0;
		padding-top: 5px;
	}

	.item-card__title {
		margin: 0;
		font-size: var(--fs-heading);
		font-weight: var(--fw-semibold);
		line-height: var(--lh-tight);
		overflow-wrap: anywhere;
	}

	.item-card__meta {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
	}

	.item-card__actions {
		display: flex;
		flex-shrink: 0;
		gap: 2px;
		margin: -2px -4px 0 0;
	}

	.item-card__desc {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-body);
		line-height: var(--lh-body);
	}

	/* Pinned to the bottom so footers line up across a row of cards. */
	.item-card__foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 12px;
		margin-top: auto;
		padding-top: 10px;
		border-top: 1px solid var(--border-subtle);
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	:global([dir='rtl']) .item-card__actions {
		margin: -2px 0 0 -4px;
	}
</style>
