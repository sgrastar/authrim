<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Icon from '#lib/ui/icons/Icon.svelte';
	import LauncherIcon from './LauncherIcon.svelte';
	import { tileTextColor } from './launcher-model';

	/**
	 * One launcher as a user sees it on the account page: its icon, name, description and
	 * category, how it opens (in a new tab or in place), the legacy mark of IdP-initiated SAML
	 * and the favourite star. A picture of the tile, not a link: nothing here can be pressed.
	 */
	interface Props {
		name: string;
		description?: string;
		category?: string;
		iconType: 'phosphor' | 'image';
		iconValue: string;
		iconColor: string;
		background: string;
		/** The whole tile's own colour; none keeps the theme's card colour. */
		tileBackground?: string | null;
		openInNewTab: boolean;
		allowFavorite: boolean;
		legacy?: boolean;
	}

	let {
		name,
		description = '',
		category = '',
		iconType,
		iconValue,
		iconColor,
		background,
		tileBackground = null,
		openInNewTab,
		allowFavorite,
		legacy = false
	}: Props = $props();
</script>

<div
	class="launcher-tile"
	class:launcher-tile--colored={!!tileBackground}
	style:--tile-bg={tileBackground || undefined}
	style:--tile-fg={tileBackground ? tileTextColor(tileBackground) : undefined}
>
	<div class="launcher-tile__top">
		<LauncherIcon {iconType} value={iconValue} {background} color={iconColor} />
		{#if allowFavorite}
			<span class="launcher-tile__star" title={t('ln.preview.favorite')}>
				<Icon name="star" label={t('ln.preview.favorite')} />
			</span>
		{/if}
	</div>
	<span class="launcher-tile__name">{name || t('ln.preview.unnamed')}</span>
	{#if description}<span class="launcher-tile__description">{description}</span>{/if}
	<span class="launcher-tile__meta">
		{#if category}<span class="launcher-tile__category">{category}</span>{/if}
		{#if legacy}<span class="launcher-tile__legacy">{t('ln.preview.legacy')}</span>{/if}
		<span class="launcher-tile__opens">
			<Icon
				name={openInNewTab ? 'external' : 'caretRight'}
				label={openInNewTab ? t('ln.preview.newTab') : t('ln.preview.sameTab')}
			/>
		</span>
	</span>
</div>

<style>
	.launcher-tile {
		display: grid;
		gap: 6px;
		align-content: start;
		min-inline-size: 0;
		block-size: 100%;
		padding: var(--tile-pad);
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
	}

	/* A tile in the admin's own colour, as the account page draws it: its text in black or white,
	   whichever reads on it. */
	.launcher-tile--colored {
		border-color: var(--tile-bg);
		background: var(--tile-bg);
		color: var(--tile-fg);
	}

	.launcher-tile--colored .launcher-tile__description,
	.launcher-tile--colored .launcher-tile__meta,
	.launcher-tile--colored .launcher-tile__star {
		/* The same black or white: a lighter mix would fall below 4.5:1 on mid-tone tiles. */
		color: var(--tile-fg);
	}

	.launcher-tile__top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
		margin-block-end: 4px;
	}

	.launcher-tile__star {
		display: inline-flex;
		color: var(--text-muted);
		font-size: var(--icon-sm);
	}

	.launcher-tile__name {
		overflow: hidden;
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
		line-height: var(--lh-tight);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.launcher-tile__description {
		display: -webkit-box;
		overflow: hidden;
		color: var(--text-secondary);
		font-size: var(--fs-caption);
		line-height: var(--lh-snug);
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}

	.launcher-tile__meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	.launcher-tile__category {
		min-inline-size: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.launcher-tile__legacy {
		padding: 0 6px;
		border-radius: var(--radius-control);
		background: var(--warning-bg);
		color: var(--warning-text);
	}

	.launcher-tile__opens {
		display: inline-flex;
		margin-inline-start: auto;
		font-size: var(--icon-sm);
	}
</style>
