<script lang="ts">
	import type { ProfileLayer } from '#lib/api/profile-layer.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import { layerBadges } from './profile-layer-model';

	interface Props {
		layer: ProfileLayer | null;
		size?: 'md' | 'sm';
	}
	let { layer, size = 'sm' }: Props = $props();
	const badges = $derived(layerBadges(layer));
</script>

{#if badges.length}
	<span class="layer-badges">
		{#each badges as badge (badge.label)}
			<Badge tone={badge.tone} {size}>{t(badge.label)}</Badge>
		{/each}
	</span>
{/if}

<style>
	.layer-badges {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 4px;
	}
</style>
