<script lang="ts">
	import type { ProfileLayer } from '#lib/api/profile-layer.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import { layerNote } from './profile-layer-model';

	interface Props {
		layer: ProfileLayer | null;
		/** The admin may change the tenant's settings (going back is one). */
		canWrite: boolean;
		busy?: boolean;
		/** "Use the platform's values": removes the tenant's copy (always allowed). */
		onrevert: () => void;
	}
	let { layer, canWrite, busy = false, onrevert }: Props = $props();
	const note = $derived(layerNote(layer));
</script>

{#if note}
	<Callout tone={note.tone}>
		{#each note.lines as line (line)}<p class="layer-notice__line">{t(line)}</p>{/each}
		{#if note.canRevert && canWrite}
			<div class="layer-notice__action">
				<Button size="sm" icon="reset" disabled={busy} onclick={onrevert}>{t('pl.revert')}</Button>
			</div>
		{/if}
	</Callout>
{/if}

<style>
	.layer-notice__line {
		margin: 0;
	}
	.layer-notice__line + .layer-notice__line {
		margin-top: 6px;
	}
	.layer-notice__action {
		margin-top: 10px;
	}
</style>
