<script lang="ts">
	import Icon from '#lib/ui/icons/Icon.svelte';
	import { LAUNCHER_ICON_PATHS, hasLauncherIcon } from './launcher-icons';

	/**
	 * A launcher's icon as the account page shows it: a rounded square in the launcher's own
	 * background colour holding its Phosphor icon in its icon colour, or its picture filling the
	 * square. The colours are the admin's (stored with the launcher), not the theme's. An icon
	 * the console cannot draw, or a picture that does not load, shows the generic app icon.
	 */
	interface Props {
		iconType: 'phosphor' | 'image';
		/** The Phosphor name, or the picture's address. */
		value: string;
		background: string;
		color: string;
		size?: 'sm' | 'md' | 'lg';
	}

	let { iconType, value, background, color, size = 'md' }: Props = $props();

	let failed = $state<string | null>(null);
	const image = $derived(iconType === 'image' && value !== '' && failed !== value);
</script>

<span
	class="launcher-icon launcher-icon--{size}"
	class:launcher-icon--image={image}
	style:--launcher-bg={background}
	style:--launcher-color={color}
	aria-hidden="true"
>
	{#if image}
		<img
			src={value}
			alt=""
			loading="lazy"
			referrerpolicy="no-referrer"
			onerror={() => (failed = value)}
		/>
	{:else if iconType === 'phosphor' && hasLauncherIcon(value)}
		<svg viewBox="0 0 256 256" fill="currentColor" focusable="false">
			<!-- Paths come from the static Phosphor table, never from what an admin typed. -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html LAUNCHER_ICON_PATHS[value]}
		</svg>
	{:else}
		<Icon name="app" />
	{/if}
</span>

<style>
	.launcher-icon {
		display: inline-grid;
		flex-shrink: 0;
		place-items: center;
		overflow: hidden;
		inline-size: var(--launcher-icon-box);
		block-size: var(--launcher-icon-box);
		border-radius: var(--radius-md);
		background: var(--launcher-bg);
		color: var(--launcher-color);
		font-size: var(--launcher-icon-glyph);
	}

	.launcher-icon--sm {
		--launcher-icon-box: var(--control-h-sm);
		--launcher-icon-glyph: var(--icon-md);
	}

	.launcher-icon--md {
		--launcher-icon-box: var(--control-h-lg);
		--launcher-icon-glyph: var(--icon-xl);
	}

	.launcher-icon--lg {
		--launcher-icon-box: calc(var(--control-h-lg) * 1.5);
		--launcher-icon-glyph: calc(var(--icon-xl) * 1.5);
	}

	.launcher-icon--image {
		background: var(--bg-subtle);
	}

	svg,
	.launcher-icon :global(.icon) {
		inline-size: 1em;
		block-size: 1em;
	}

	img {
		inline-size: 100%;
		block-size: 100%;
		object-fit: cover;
	}
</style>
