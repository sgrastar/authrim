<script lang="ts">
	import { DIRECTIONAL_ICONS, ICON_PATHS, type IconName } from './icons';

	interface Props {
		name: IconName;
		/** Accessible name. Omit for decorative icons next to visible text. */
		label?: string;
		size?: number;
	}

	let { name, label, size }: Props = $props();
</script>

<svg
	class="icon"
	class:icon--directional={DIRECTIONAL_ICONS.has(name)}
	viewBox="0 0 256 256"
	fill="currentColor"
	style:--icon-size={size ? `${size}px` : undefined}
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	focusable="false"
>
	<!-- Paths come from the static Phosphor table in icons.ts, never from user input. -->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	{@html ICON_PATHS[name]}
</svg>

<style>
	.icon {
		flex-shrink: 0;
		/* Without explicit size an icon follows the font size instead of growing to 300x150. */
		width: var(--icon-size, 1em);
		height: var(--icon-size, 1em);
	}

	/* Icons that point along the reading direction (external link, import, export, sign out)
	   mirror in right-to-left layouts. Up/down carets do not. */
	:global([dir='rtl']) .icon--directional {
		transform: scaleX(-1);
	}
</style>
